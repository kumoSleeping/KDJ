//! Platform adapter for the shared Rust playback coordinator.
//!
//! Desktop and Android both submit through this thin Tauri surface. Command ordering, decode
//! workers, Deck lifecycle and authoritative state live in `kdj-playback`; CPAL (CoreAudio /
//! WASAPI / AAudio) selection lives in `kdj-player`. System media-session policy stays outside:
//! souvlaki on desktop, Kotlin MediaSession on Android.

use std::sync::Arc;
use std::sync::OnceLock;

use kdj_playback::{
    CommandAck, ControlAck, PlaybackCommand, PlaybackCoordinator, PlaybackSnapshot,
    PlaybackWaveformWindow,
};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "android")]
use crate::android_media::AndroidMediaSession;
#[cfg(desktop)]
use crate::desktop_media::DesktopMediaSession;

pub const STATE_EVENT: &str = "playback-state";
pub const LEVEL_EVENT: &str = "playback-levels";
pub const CLOCK_EVENT: &str = "playback-clock";

const WINDOW_WIRE_MAGIC: &[u8; 8] = b"KDJWIN\0\0";
const WINDOW_WIRE_VERSION: u16 = 1;
const WINDOW_WIRE_HEADER_BYTES: usize = 48;
const WINDOW_WIRE_BYTES_PER_COLUMN: usize = 12;

/// Manager waveform IPC is a compact structure-of-arrays payload rather than serde JSON.
///
/// A normal twelve-second window has roughly 4,800 columns. JSON used to allocate seven large
/// JS Number arrays on the WebView main thread every time that window advanced; the exact same
/// evidence now crosses IPC in twelve bytes per column and is decoded directly into typed arrays.
fn encode_playback_waveform_window(window: PlaybackWaveformWindow) -> Result<Vec<u8>, String> {
    let wave = window.waveform;
    let count = wave.amp.len();
    let valid_channels = count > 0
        && wave.minimum.len() == count
        && wave.maximum.len() == count
        && wave.r.len() == count
        && wave.g.len() == count
        && wave.b.len() == count
        && wave.transient.len() == count;
    if !valid_channels
        || !wave.duration.is_finite()
        || wave.duration < 0.0
        || !window.source_start.is_finite()
        || !window.source_end.is_finite()
        || window.source_start < 0.0
        || window.source_end <= window.source_start
        || window.source_end > wave.duration + 1.0e-3
        || count > u32::MAX as usize
        || wave
            .minimum
            .iter()
            .chain(&wave.maximum)
            .any(|value| !value.is_finite())
    {
        return Err("局部波形数据无效".into());
    }

    let mut body =
        Vec::with_capacity(WINDOW_WIRE_HEADER_BYTES + count * WINDOW_WIRE_BYTES_PER_COLUMN);
    body.extend_from_slice(WINDOW_WIRE_MAGIC);
    body.extend_from_slice(&WINDOW_WIRE_VERSION.to_le_bytes());
    body.extend_from_slice(&0u16.to_le_bytes()); // flags / reserved
    body.extend_from_slice(&wave.track_id.to_le_bytes());
    body.extend_from_slice(&wave.duration.to_le_bytes());
    body.extend_from_slice(&window.source_start.to_le_bytes());
    body.extend_from_slice(&window.source_end.to_le_bytes());
    body.extend_from_slice(&(count as u32).to_le_bytes());
    debug_assert_eq!(body.len(), WINDOW_WIRE_HEADER_BYTES);
    for value in &wave.minimum {
        body.extend_from_slice(&value.to_le_bytes());
    }
    for value in &wave.maximum {
        body.extend_from_slice(&value.to_le_bytes());
    }
    body.extend_from_slice(&wave.r);
    body.extend_from_slice(&wave.g);
    body.extend_from_slice(&wave.b);
    body.extend_from_slice(&wave.transient);
    Ok(body)
}

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

    fn submit_control(&self, command: PlaybackCommand) -> Result<ControlAck, String> {
        self.coordinator.submit_control(command)
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
) -> Result<ControlAck, String> {
    player.submit_control(command)
}

#[tauri::command]
pub fn playback_state(
    player: tauri::State<'_, DesktopPlayerHandle>,
) -> Result<PlaybackSnapshot, String> {
    player.snapshot()
}

/// Return only the detailed source-time window needed by the six-second Manager rail.
///
/// The coordinator lends its already-decoded scratch PCM and the bounded analysis runs on a
/// blocking worker. Tauri's command thread, playback actor and CoreAudio/AAudio callback never do
/// FFT work or serialize a full-song waveform.
#[tauri::command]
pub async fn playback_waveform_window(
    player: tauri::State<'_, DesktopPlayerHandle>,
    track_id: i64,
    position: f64,
    viewport_seconds: f64,
    urgent: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    let coordinator = Arc::clone(&player.coordinator);
    let window = tauri::async_runtime::spawn_blocking(move || {
        coordinator.waveform_window(track_id, position, viewport_seconds, urgent.unwrap_or(true))
    })
    .await
    .map_err(|error| format!("局部波形任务异常退出：{error}"))??;
    let body = match window {
        Some(window) => encode_playback_waveform_window(window)?,
        // An empty raw response is the allocation-free "not ready yet" sentinel. It avoids
        // serializing JSON null on the hot retry path while scratch PCM catches up.
        None => Vec::new(),
    };
    Ok(tauri::ipc::Response::new(body))
}
