//! Platform adapter for the shared Rust playback coordinator.
//!
//! Desktop and Android both submit through this thin Tauri surface. Command ordering, decode
//! workers, Deck lifecycle and authoritative state live in `kdj-playback`; CPAL (CoreAudio /
//! WASAPI / AAudio) selection lives in `kdj-player`. System media-session policy stays outside:
//! souvlaki on desktop, Kotlin MediaSession on Android.

use std::sync::Arc;
use std::sync::OnceLock;

use kdj_playback::{CommandAck, PlaybackCommand, PlaybackCoordinator, PlaybackSnapshot};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "android")]
use crate::android_media::AndroidMediaSession;
#[cfg(desktop)]
use crate::desktop_media::DesktopMediaSession;

pub const STATE_EVENT: &str = "playback-state";
pub const LEVEL_EVENT: &str = "playback-levels";
pub const CLOCK_EVENT: &str = "playback-clock";

pub struct DesktopPlayerHandle {
    coordinator: Arc<PlaybackCoordinator>,
    #[cfg(desktop)]
    _media_session: Option<DesktopMediaSession>,
    #[cfg(target_os = "android")]
    _media_session: Option<AndroidMediaSession>,
}

impl DesktopPlayerHandle {
    pub fn spawn(app: AppHandle) -> Result<Self, String> {
        #[cfg(desktop)]
        {
            let coordinator_slot = Arc::new(OnceLock::new());
            let media_session =
                match DesktopMediaSession::spawn(app.clone(), Arc::clone(&coordinator_slot)) {
                    Ok(session) => Some(session),
                    Err(error) => {
                        tracing::warn!("{error}；播放器仍可使用，但系统媒体键不可用");
                        None
                    }
                };
            let event_app = app.clone();
            let event_media = media_session.clone();
            let coordinator = Arc::new(PlaybackCoordinator::spawn(move |snapshot| {
                if let Some(media) = &event_media {
                    media.update(&snapshot);
                }
                if let Err(error) = event_app.emit(STATE_EVENT, snapshot) {
                    tracing::warn!("发送播放器状态失败：{error}");
                }
            })?);
            coordinator_slot
                .set(Arc::clone(&coordinator))
                .map_err(|_| "系统媒体控制重复绑定播放器".to_string())?;
            {
                let level_app = app.clone();
                coordinator.subscribe_levels(move |levels| {
                    if let Err(error) = level_app.emit(LEVEL_EVENT, levels) {
                        tracing::warn!("发送电平失败：{error}");
                    }
                });
            }
            {
                let clock_app = app.clone();
                coordinator.subscribe_clock(move |clock| {
                    if let Err(error) = clock_app.emit(CLOCK_EVENT, clock) {
                        tracing::warn!("发送播放时钟失败：{error}");
                    }
                });
            }
            return Ok(Self {
                coordinator,
                _media_session: media_session,
            });
        }

        #[cfg(target_os = "android")]
        {
            let coordinator_slot = Arc::new(OnceLock::new());
            let media_session =
                match AndroidMediaSession::spawn(app.clone(), Arc::clone(&coordinator_slot)) {
                    Ok(session) => Some(session),
                    Err(error) => {
                        tracing::warn!("{error}；播放器仍可使用，但通知栏/线控不可用");
                        None
                    }
                };
            let event_app = app.clone();
            let event_media = media_session.clone();
            let coordinator = Arc::new(PlaybackCoordinator::spawn(move |snapshot| {
                if let Some(media) = &event_media {
                    media.update(&snapshot);
                }
                if let Err(error) = event_app.emit(STATE_EVENT, snapshot) {
                    tracing::warn!("发送播放器状态失败：{error}");
                }
            })?);
            coordinator_slot
                .set(Arc::clone(&coordinator))
                .map_err(|_| "Android 媒体控制重复绑定播放器".to_string())?;
            {
                let level_app = app.clone();
                coordinator.subscribe_levels(move |levels| {
                    if let Err(error) = level_app.emit(LEVEL_EVENT, levels) {
                        tracing::warn!("发送电平失败：{error}");
                    }
                });
            }
            {
                let clock_app = app.clone();
                coordinator.subscribe_clock(move |clock| {
                    if let Err(error) = clock_app.emit(CLOCK_EVENT, clock) {
                        tracing::warn!("发送播放时钟失败：{error}");
                    }
                });
            }
            return Ok(Self {
                coordinator,
                _media_session: media_session,
            });
        }

        #[cfg(not(any(desktop, target_os = "android")))]
        {
            let _ = app;
            Err("当前平台未启用共享播放器".to_string())
        }
    }

    fn submit(&self, command_id: u64, command: PlaybackCommand) -> Result<CommandAck, String> {
        self.coordinator.submit_with_id(command_id, command)
    }

    fn submit_control(&self, command: PlaybackCommand) -> Result<CommandAck, String> {
        self.coordinator.submit_platform(command)
    }

    fn snapshot(&self) -> Result<PlaybackSnapshot, String> {
        self.coordinator.snapshot()
    }
}

/// Installs the event listener before requesting this snapshot on the frontend. The snapshot and
/// every later event carry one monotonic sequence, so crossing Tauri channels cannot rewind UI.
#[tauri::command]
pub fn playback_initialize(
    player: tauri::State<'_, DesktopPlayerHandle>,
) -> Result<PlaybackSnapshot, String> {
    player.snapshot()
}

/// Returns as soon as the coordinator accepts and publishes the command. Decode, pre-read, seek
/// preparation and DJ handoff continue as owned worker/actor continuations and never hold invoke.
#[tauri::command]
pub fn playback_command(
    player: tauri::State<'_, DesktopPlayerHandle>,
    command_id: u64,
    command: PlaybackCommand,
) -> Result<CommandAck, String> {
    player.submit(command_id, command)
}

/// Continuous TEMPO/mixer controls. They share the actor thread but must not consume frontend
/// command IDs or wait behind load/seek acknowledgements.
#[tauri::command]
pub fn playback_control(
    player: tauri::State<'_, DesktopPlayerHandle>,
    command: PlaybackCommand,
) -> Result<CommandAck, String> {
    player.submit_control(command)
}

#[tauri::command]
pub fn playback_state(
    player: tauri::State<'_, DesktopPlayerHandle>,
) -> Result<PlaybackSnapshot, String> {
    player.snapshot()
}
