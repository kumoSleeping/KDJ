//! Android MediaSession adapter.
//!
//! Mirrors `desktop_media.rs`: coordinator snapshots go to Kotlin via
//! `applyPlaybackSnapshot`; headset / notification remote keys come back through
//! JNI (`NativeAudioBridge`) into `submit_platform` or the shared
//! `desktop-media-control` next/prev event.

use std::sync::{Arc, Mutex, OnceLock};

use jni::objects::{JClass, JString};
use jni::sys::jdouble;
use jni::JNIEnv;
use kdj_playback::{PlaybackCommand, PlaybackCoordinator, PlaybackPhase, PlaybackSnapshot};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_native_audio::{ApplyPlaybackSnapshotArgs, NativeAudio};

/// 与桌面 `desktop_media::REMOTE_EVENT` 同名，前端 PlayerBar 共用 next/previous 监听。
const REMOTE_EVENT: &str = "desktop-media-control";
const DEFAULT_SEEK_SECONDS: f64 = 10.0;

struct RemoteBridge {
    app: AppHandle,
    coordinator: Arc<OnceLock<Arc<PlaybackCoordinator>>>,
}

static REMOTE_BRIDGE: OnceLock<RemoteBridge> = OnceLock::new();

pub struct AndroidMediaSession {
    app: AppHandle,
    /// Coalesce rapid snapshot publishes onto one worker so `run_mobile_plugin`
    /// cannot pile up on the actor thread.
    pending: Arc<Mutex<Option<ApplyPlaybackSnapshotArgs>>>,
    wake: Arc<std::sync::mpsc::Sender<()>>,
}

impl AndroidMediaSession {
    pub fn spawn(
        app: AppHandle,
        coordinator: Arc<OnceLock<Arc<PlaybackCoordinator>>>,
    ) -> Result<Self, String> {
        REMOTE_BRIDGE
            .set(RemoteBridge {
                app: app.clone(),
                coordinator,
            })
            .map_err(|_| "Android 媒体桥重复初始化".to_string())?;

        let pending = Arc::new(Mutex::new(None));
        let (wake_tx, wake_rx) = std::sync::mpsc::channel::<()>();
        let worker_app = app.clone();
        let worker_pending = Arc::clone(&pending);
        std::thread::Builder::new()
            .name("kdj-android-media".into())
            .spawn(move || {
                while wake_rx.recv().is_ok() {
                    loop {
                        let payload = {
                            let mut slot = worker_pending
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            slot.take()
                        };
                        let Some(payload) = payload else {
                            break;
                        };
                        push_snapshot(&worker_app, &payload);
                        // Drain coalesced updates without sleeping on an empty queue.
                        if worker_pending
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .is_none()
                        {
                            break;
                        }
                    }
                }
            })
            .map_err(|error| format!("启动 Android 媒体镜像线程失败：{error}"))?;

        Ok(Self {
            app,
            pending,
            wake: Arc::new(wake_tx),
        })
    }

    pub fn update(&self, snapshot: &PlaybackSnapshot) {
        let payload = snapshot_args(snapshot);
        {
            let mut slot = self
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *slot = Some(payload);
        }
        let _ = self.wake.send(());
    }
}

impl Clone for AndroidMediaSession {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            pending: Arc::clone(&self.pending),
            wake: Arc::clone(&self.wake),
        }
    }
}

fn push_snapshot<R: Runtime>(app: &AppHandle<R>, payload: &ApplyPlaybackSnapshotArgs) {
    let Some(plugin) = app.try_state::<NativeAudio<R>>() else {
        tracing::warn!("native-audio 未就绪，跳过 MediaSession 镜像");
        return;
    };
    if let Err(error) = plugin.apply_playback_snapshot(payload) {
        tracing::warn!("{error}");
    }
}

fn snapshot_args(snapshot: &PlaybackSnapshot) -> ApplyPlaybackSnapshotArgs {
    ApplyPlaybackSnapshotArgs {
        sequence: snapshot.sequence,
        phase: phase_wire(snapshot.phase),
        track_id: snapshot.track_id,
        title: snapshot.title.clone(),
        artist: snapshot.artist.clone(),
        album: snapshot.album.clone(),
        artwork_url: snapshot.artwork_url.clone(),
        current_time: finite_nonnegative(snapshot.current_time),
        duration: finite_nonnegative(snapshot.duration),
        desired_playing: snapshot.desired_playing,
        is_playing: snapshot.is_playing,
        buffering: snapshot.buffering,
        rate: if snapshot.rate.is_finite() && snapshot.rate > 0.0 {
            snapshot.rate
        } else {
            1.0
        },
        volume: snapshot.volume.clamp(0.0, 1.0),
        error: snapshot.error.clone(),
    }
}

fn phase_wire(phase: PlaybackPhase) -> String {
    match phase {
        PlaybackPhase::Idle => "idle",
        PlaybackPhase::Loading => "loading",
        PlaybackPhase::Ready => "ready",
        PlaybackPhase::Playing => "playing",
        PlaybackPhase::Paused => "paused",
        PlaybackPhase::Seeking => "seeking",
        PlaybackPhase::Transitioning => "transitioning",
        PlaybackPhase::Ended => "ended",
        PlaybackPhase::Error => "error",
    }
    .to_string()
}

fn finite_nonnegative(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else if value.is_finite() {
        0.0
    } else {
        0.0
    }
}

fn handle_remote(action: &str, position: f64) {
    let Some(bridge) = REMOTE_BRIDGE.get() else {
        tracing::warn!("Android 媒体桥尚未就绪：{action}");
        return;
    };
    match action {
        "next" => emit_frontend(&bridge.app, "next"),
        "previous" => emit_frontend(&bridge.app, "previous"),
        other => {
            let Some(coordinator) = bridge.coordinator.get().cloned() else {
                tracing::warn!("播放器尚未绑定，忽略远程命令：{other}");
                return;
            };
            if let Err(error) = submit_remote(&coordinator, other, position) {
                tracing::warn!("执行 Android 远程媒体命令失败：{error}");
            }
        }
    }
}

fn submit_remote(
    coordinator: &PlaybackCoordinator,
    action: &str,
    position: f64,
) -> Result<(), String> {
    let command = match action {
        "play" => PlaybackCommand::Play,
        "pause" => PlaybackCommand::Pause,
        "toggle" => {
            if coordinator.snapshot()?.desired_playing {
                PlaybackCommand::Pause
            } else {
                PlaybackCommand::Play
            }
        }
        "seek" => PlaybackCommand::Seek {
            position: finite_nonnegative(position),
        },
        "seekBy" => {
            let snapshot = coordinator.snapshot()?;
            let mut next = (snapshot.current_time + position).max(0.0);
            if snapshot.duration > 0.0 {
                next = next.min(snapshot.duration);
            }
            PlaybackCommand::Seek { position: next }
        }
        "setVolume" => PlaybackCommand::SetVolume {
            volume: position.clamp(0.0, 1.0) as f32,
        },
        "seekForward" => relative_seek(coordinator, DEFAULT_SEEK_SECONDS)?,
        "seekBackward" => relative_seek(coordinator, -DEFAULT_SEEK_SECONDS)?,
        _ => return Ok(()),
    };
    coordinator.submit_platform(command).map(|_| ())
}

fn relative_seek(coordinator: &PlaybackCoordinator, delta: f64) -> Result<PlaybackCommand, String> {
    let snapshot = coordinator.snapshot()?;
    let mut position = (snapshot.current_time + delta).max(0.0);
    if snapshot.duration > 0.0 {
        position = position.min(snapshot.duration);
    }
    Ok(PlaybackCommand::Seek { position })
}

fn emit_frontend(app: &AppHandle, action: &'static str) {
    if let Err(error) = app.emit(REMOTE_EVENT, action) {
        tracing::warn!("发送系统媒体切歌事件失败：{error}");
    }
}

#[no_mangle]
pub extern "system" fn Java_app_tauri_nativeaudio_NativeAudioBridge_submitRemote(
    mut env: JNIEnv,
    _class: JClass,
    action: JString,
    position: jdouble,
) {
    let action = match env.get_string(&action) {
        Ok(value) => match value.to_str() {
            Ok(text) => text.to_string(),
            Err(error) => {
                tracing::warn!("远程媒体命令 UTF-8 无效：{error}");
                return;
            }
        },
        Err(error) => {
            tracing::warn!("读取远程媒体命令失败：{error}");
            return;
        }
    };
    handle_remote(&action, position);
}
