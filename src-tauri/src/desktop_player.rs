//! Desktop platform adapter for the shared Rust playback coordinator.
//!
//! Tauri owns serialization and event delivery only. Command ordering, decode workers, Deck
//! lifecycle and authoritative state live in `kdj-playback`; CPAL selection lives in `kdj-player`.

use kdj_playback::{CommandAck, PlaybackCommand, PlaybackCoordinator, PlaybackSnapshot};
use tauri::{AppHandle, Emitter};

pub const STATE_EVENT: &str = "playback-state";

pub struct DesktopPlayerHandle {
    coordinator: PlaybackCoordinator,
}

impl DesktopPlayerHandle {
    pub fn spawn(app: AppHandle) -> Result<Self, String> {
        let event_app = app.clone();
        let coordinator = PlaybackCoordinator::spawn(move |snapshot| {
            if let Err(error) = event_app.emit(STATE_EVENT, snapshot) {
                tracing::warn!("发送播放器状态失败：{error}");
            }
        })?;
        Ok(Self { coordinator })
    }

    fn submit(&self, command_id: u64, command: PlaybackCommand) -> Result<CommandAck, String> {
        self.coordinator.submit_with_id(command_id, command)
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

#[tauri::command]
pub fn playback_state(
    player: tauri::State<'_, DesktopPlayerHandle>,
) -> Result<PlaybackSnapshot, String> {
    player.snapshot()
}
