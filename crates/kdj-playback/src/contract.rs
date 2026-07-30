use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSource {
    pub track_id: i64,
    pub path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub artwork_url: Option<String>,
    #[serde(default)]
    pub position: f64,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default = "default_rate")]
    pub rate: f32,
    #[serde(default)]
    pub autoplay: bool,
}

fn default_rate() -> f32 {
    1.0
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackTransitionPlan {
    #[serde(default)]
    pub eq: bool,
    #[serde(default)]
    pub filter: bool,
    #[serde(default)]
    pub vocal_cut: bool,
    #[serde(default)]
    pub echo: bool,
    #[serde(default)]
    pub alarm: bool,
    #[serde(default)]
    pub hydrant: bool,
    #[serde(default)]
    pub beat_seconds: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PlaybackCommand {
    Load { source: PlaybackSource },
    Prepare { source: PlaybackSource },
    SetQueue { sources: Vec<PlaybackSource> },
    Play,
    Pause,
    Seek { position: f64 },
    Handoff {
        #[serde(rename = "trackId")]
        track_id: i64,
        position: f64,
        seconds: f64,
        #[serde(default)]
        plan: PlaybackTransitionPlan,
    },
    SetVolume { volume: f32 },
    SetTransportFade { enabled: bool },
    SetEq {
        #[serde(rename = "lowDb")]
        low_db: f32,
        #[serde(rename = "highDb")]
        high_db: f32,
    },
    Dispose,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackPhase {
    #[default]
    Idle,
    Loading,
    Ready,
    Playing,
    Paused,
    Seeking,
    Transitioning,
    Ended,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSnapshot {
    pub sequence: u64,
    pub last_command_id: u64,
    pub phase: PlaybackPhase,
    pub track_id: Option<i64>,
    pub prepared_track_id: Option<i64>,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork_url: Option<String>,
    pub current_time: f64,
    pub duration: f64,
    pub desired_playing: bool,
    pub is_playing: bool,
    pub buffering: bool,
    pub transitioning: bool,
    pub rate: f32,
    pub volume: f32,
    pub transport_fade_enabled: bool,
    pub error: String,
}

impl Default for PlaybackSnapshot {
    fn default() -> Self {
        Self {
            sequence: 0,
            last_command_id: 0,
            phase: PlaybackPhase::Idle,
            track_id: None,
            prepared_track_id: None,
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            artwork_url: None,
            current_time: 0.0,
            duration: 0.0,
            desired_playing: false,
            is_playing: false,
            buffering: false,
            transitioning: false,
            rate: 1.0,
            volume: 1.0,
            transport_fade_enabled: false,
            error: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandAck {
    pub command_id: u64,
    pub accepted_sequence: u64,
    pub snapshot: PlaybackSnapshot,
}
