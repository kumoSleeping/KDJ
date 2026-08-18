use kdj_core::FilterResonance;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackSourceKind {
    #[default]
    Local,
    Remote,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSource {
    pub track_id: i64,
    pub path: String,
    #[serde(default)]
    pub source_kind: PlaybackSourceKind,
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
    /// The original path remains in `path`; enabling stems switches only the worker input.
    #[serde(default)]
    pub stem_cache_path: String,
    #[serde(default)]
    pub stem_enabled: bool,
    #[serde(default)]
    pub stem_mask: u8,
    /// Per-lane gains in `StemKind::index` order (drums, bass, other, vocals).
    #[serde(default = "default_stem_gains")]
    pub stem_gains: [f32; 4],
}

fn default_stem_gains() -> [f32; 4] {
    [1.0; 4]
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
    Load {
        source: PlaybackSource,
    },
    Prepare {
        source: PlaybackSource,
    },
    /// Performance 模式固定装入一侧 Deck；不会替换或回收另一侧。
    LoadDeck {
        deck: u8,
        source: PlaybackSource,
    },
    SetQueue {
        sources: Vec<PlaybackSource>,
    },
    Play,
    Pause,
    PlayDeck {
        deck: u8,
    },
    PauseDeck {
        deck: u8,
    },
    /// Capacitive platter contact freezes the callback cursor without changing `playing` or the
    /// Deck's desired transport state. Releasing a moved platter is followed by an ordinary
    /// seek, which keeps this hold until its replacement source is ready.
    SetDeckScratchHeld {
        deck: u8,
        held: bool,
    },
    /// Relative platter motion in track seconds. Applied immediately to a held Deck without
    /// rebuilding its decoder; note-off still seeks once to resync the streaming worker.
    ScratchDeck {
        deck: u8,
        delta: f64,
    },
    SeekDeck {
        deck: u8,
        position: f64,
        /// A capacitive scratch release must not briefly restart the old paused source. Keep the
        /// old Deck silent and let the replacement stream begin only after its seek buffer is
        /// ready.
        #[serde(default, rename = "playWhenReady")]
        play_when_ready: bool,
    },
    /// Momentary edge-jog pitch bend. `amount` is normalized to -1..1 and never changes the
    /// Deck's persisted TEMPO value.
    NudgeDeck {
        deck: u8,
        amount: f32,
    },
    SetDeckRate {
        deck: u8,
        rate: f32,
    },
    SetDeckMixer {
        deck: u8,
        #[serde(rename = "channelGain")]
        channel_gain: f32,
        #[serde(rename = "trimDb")]
        trim_db: f32,
        #[serde(rename = "lowDb")]
        low_db: f32,
        #[serde(rename = "midDb")]
        mid_db: f32,
        #[serde(rename = "highDb")]
        high_db: f32,
        filter: f32,
    },
    /// Global Performance filter resonance. The semantic setting is mapped to a bounded DSP Q
    /// inside the coordinator so the realtime command remains just a numeric coefficient.
    SetFilterResonance {
        #[serde(default)]
        resonance: FilterResonance,
    },
    SetDeckStems {
        #[serde(rename = "trackId")]
        track_id: i64,
        enabled: bool,
        #[serde(rename = "cachePath")]
        cache_path: String,
        mask: u8,
        #[serde(default = "default_stem_gains")]
        gains: [f32; 4],
    },
    /// Engage a transport loop over `[start, start + length]` seconds of the deck's current
    /// source. The running decoder, EQ and STEM session stay in place; only the playhead wraps.
    SetDeckLoop {
        #[serde(rename = "trackId")]
        track_id: i64,
        start: f64,
        length: f64,
    },
    ClearDeckLoop {
        #[serde(rename = "trackId")]
        track_id: i64,
    },
    Seek {
        position: f64,
    },
    Handoff {
        #[serde(rename = "trackId")]
        track_id: i64,
        position: f64,
        seconds: f64,
        #[serde(default)]
        plan: PlaybackTransitionPlan,
    },
    SetVolume {
        volume: f32,
    },
    SetTransportFade {
        enabled: bool,
    },
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
    /// Performance 模式固定的两侧 Deck 状态；普通播放也会反映实际物理 Deck。
    pub decks: [PlaybackDeckSnapshot; 2],
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackDeckSnapshot {
    pub track_id: Option<i64>,
    pub current_time: f64,
    pub duration: f64,
    pub desired_playing: bool,
    pub is_playing: bool,
    pub rate: f32,
    pub buffering: bool,
    /// Active engine loop window in track seconds; `None` when the deck plays linearly.
    pub loop_start: Option<f64>,
    pub loop_length: Option<f64>,
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
            decks: std::array::from_fn(|_| PlaybackDeckSnapshot {
                rate: 1.0,
                ..PlaybackDeckSnapshot::default()
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PlaybackCommand;

    #[test]
    fn scratch_release_seek_uses_the_camel_case_wire_flag() {
        let command: PlaybackCommand = serde_json::from_str(
            r#"{"type":"seekDeck","deck":0,"position":12.5,"playWhenReady":true}"#,
        )
        .expect("前端 scratch release 命令应可解析");
        assert!(matches!(
            command,
            PlaybackCommand::SeekDeck {
                deck: 0,
                position,
                play_when_ready: true,
            } if (position - 12.5).abs() < f64::EPSILON
        ));
    }

    #[test]
    fn capacitive_scratch_hold_is_a_distinct_transport_command() {
        let command: PlaybackCommand =
            serde_json::from_str(r#"{"type":"setDeckScratchHeld","deck":1,"held":true}"#)
                .expect("前端 jog touch 命令应可解析");
        assert!(matches!(
            command,
            PlaybackCommand::SetDeckScratchHeld {
                deck: 1,
                held: true
            }
        ));
    }

    #[test]
    fn capacitive_scratch_tick_is_a_relative_platter_command() {
        let command: PlaybackCommand =
            serde_json::from_str(r#"{"type":"scratchDeck","deck":0,"delta":-0.01}"#)
                .expect("前端 jog 刮擦 tick 应可解析");
        assert!(matches!(
            command,
            PlaybackCommand::ScratchDeck {
                deck: 0,
                delta,
            } if (delta + 0.01).abs() < f64::EPSILON
        ));
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandAck {
    pub command_id: u64,
    pub accepted_sequence: u64,
    pub snapshot: PlaybackSnapshot,
}
