use kdj_core::FilterResonance;
use kdj_player::EQ_SPECTRUM_BANDS;
use serde::{Deserialize, Serialize};

/// Lightweight ~30 Hz meter event. It deliberately excludes transport metadata so live meters
/// do not force the full workspace through React on every visual frame.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackLevels {
    pub peaks: [f32; 2],
    pub bands: [[f32; EQ_SPECTRUM_BANDS]; 2],
}

/// Lightweight audio-authority event. The two positions and rates are sampled from one callback
/// seqlock snapshot, so waveform consumers never compare Decks from different output quanta.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackClock {
    pub output_frame: u64,
    pub output_sample_rate: u32,
    pub callback_time_ns: u64,
    pub presentation_time_ns: u64,
    pub decks: [PlaybackDeckClock; 2],
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackDeckClock {
    pub track_id: Option<i64>,
    pub source_id: u64,
    pub current_time: f64,
    pub target_rate: f32,
    pub applied_rate: f32,
    pub audible_rate: f32,
    pub target_revision: u64,
    pub applied_revision: u64,
    pub audible_revision: u64,
    pub discontinuity_revision: u64,
    pub playing: bool,
    pub scratch_held: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackSourceKind {
    #[default]
    Local,
    Remote,
}

/// Explicit musical grid attached to a Deck source. Beat phase and downbeat phase are separate:
/// an analyzer that only knows regular beats must leave downbeat_origin empty rather than painting
/// every arbitrary fourth beat as a musically trustworthy bar line.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackBeatGrid {
    pub bpm: f64,
    pub beat_origin: f64,
    #[serde(default)]
    pub downbeat_origin: Option<f64>,
    #[serde(default = "default_beats_per_bar")]
    pub beats_per_bar: u8,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub beats: Vec<f64>,
    #[serde(default)]
    pub downbeats: Vec<f64>,
    #[serde(default)]
    pub revision: String,
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
    pub beat_grid: Option<PlaybackBeatGrid>,
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

fn default_beats_per_bar() -> u8 {
    4
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackPlatterPhase {
    #[default]
    Start,
    Move,
    End,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackFxKind {
    #[default]
    Echo,
    Reverb,
    Flanger,
    Phaser,
    BitCrusher,
    Gate,
    Alarm,
    Hydrant,
    Rocket,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackFxSlot {
    #[serde(default)]
    pub kind: PlaybackFxKind,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_fx_control")]
    pub mix: f32,
    #[serde(default = "default_fx_control", alias = "depth")]
    pub parameter: f32,
}

impl Default for PlaybackFxSlot {
    fn default() -> Self {
        Self {
            kind: PlaybackFxKind::Echo,
            enabled: false,
            mix: default_fx_control(),
            parameter: default_fx_control(),
        }
    }
}

fn default_fx_control() -> f32 {
    0.5
}

fn default_fx_slots() -> [PlaybackFxSlot; 3] {
    [PlaybackFxSlot::default(); 3]
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
    SetDeckPfl {
        deck: u8,
        enabled: bool,
    },
    /// The only platter wire API. Pointer, touch and MIDI all provide signed velocity where 1.0
    /// is nominal forward playback. Gesture/sequence fencing makes stale independent IPC lanes
    /// harmless, and End carries the final velocity atomically so a throw cannot collapse to 0.
    ControlDeckPlatter {
        deck: u8,
        phase: PlaybackPlatterPhase,
        #[serde(rename = "gestureId")]
        gesture_id: u64,
        #[serde(default)]
        sequence: u64,
        #[serde(default)]
        velocity: f64,
        #[serde(default, rename = "expectedTrackId")]
        expected_track_id: Option<i64>,
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
    /// Linked SYNC tempo gesture. Both rates reach the realtime renderer in one command.
    SetDeckRates {
        rates: [f32; 2],
    },
    /// Manual SYNC is resolved against one native two-Deck clock sample. The coordinator changes
    /// the follower rate and prepares its phase-aligned replacement from that same sample.
    SyncDeck {
        follower: u8,
        master: u8,
        rate: f32,
        #[serde(rename = "followerBpm")]
        follower_bpm: f64,
        #[serde(rename = "followerFirstBeat")]
        follower_first_beat: f64,
        #[serde(rename = "masterBpm")]
        master_bpm: f64,
        #[serde(rename = "masterFirstBeat")]
        master_first_beat: f64,
        #[serde(default = "default_beats_per_bar", rename = "beatsPerBar")]
        beats_per_bar: u8,
    },
    /// Disable the persistent native Sync Group and restore the follower's uncorrected tempo.
    ClearSync,
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
    SetDeckFx {
        deck: u8,
        #[serde(default = "default_fx_slots")]
        slots: [PlaybackFxSlot; 3],
        pad: u8,
        #[serde(rename = "beatSeconds")]
        beat_seconds: f32,
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
    /// Atomically toggle Auto Loop. Enabling samples loop-in from the native callback clock; the
    /// frontend supplies only the duration and can never inject a stale playhead.
    ToggleDeckLoop {
        deck: u8,
        length: f64,
    },
    /// Resize the active loop while preserving its native loop-in frame.
    ResizeDeckLoop {
        deck: u8,
        length: f64,
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackSyncPhase {
    #[default]
    Disabled,
    Acquiring,
    Locked,
    Correcting,
    Suspended,
    Degraded,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSyncSnapshot {
    pub enabled: bool,
    pub leader: u8,
    pub follower: u8,
    pub phase: PlaybackSyncPhase,
    pub phase_error_seconds: f64,
    pub correction_rate: f32,
    /// Shared effective BPM both Decks play toward while SYNC is locked.
    pub target_bpm: f64,
    /// Half/double-time fold: leader effective BPM = multiple × follower effective BPM.
    pub multiple: f64,
}

impl Default for PlaybackSyncSnapshot {
    fn default() -> Self {
        Self {
            enabled: false,
            leader: 0,
            follower: 1,
            phase: PlaybackSyncPhase::Disabled,
            phase_error_seconds: 0.0,
            correction_rate: 1.0,
            target_bpm: 0.0,
            multiple: 1.0,
        }
    }
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
    pub sync: PlaybackSyncSnapshot,
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
    /// Rubber Band worker target already adopted; old-rate PCM may still be queued afterward.
    pub applied_rate: f32,
    /// Rate tagged on the PCM currently consumed by the audio callback.
    pub audible_rate: f32,
    pub target_rate_revision: u64,
    pub applied_rate_revision: u64,
    pub audible_rate_revision: u64,
    pub discontinuity_revision: u64,
    pub scratch_held: bool,
    pub buffering: bool,
    /// Current callback-facing PCM cushion in milliseconds.
    pub output_buffer_ms: u64,
    /// Lowest callback-boundary cushion observed for the installed source.
    pub minimum_output_buffer_ms: u64,
    /// Number of transitions into an empty output ring for the installed source.
    pub output_underruns: u64,
    /// Post-EQ, pre-channel-fader peak level in linear full scale; values >= 1 indicate clipping.
    pub peak_level: f32,
    /// Installed callback source kind. Pending replacements do not change this until promotion,
    /// allowing runtime switches to wait until ORG actually owns the Deck.
    pub stem_enabled: bool,
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
            sync: PlaybackSyncSnapshot::default(),
            decks: std::array::from_fn(|_| PlaybackDeckSnapshot {
                rate: 1.0,
                applied_rate: 1.0,
                audible_rate: 1.0,
                ..PlaybackDeckSnapshot::default()
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PlaybackCommand, PlaybackFxKind, PlaybackLevels, PlaybackPlatterPhase};

    #[test]
    fn manual_fx_wire_contract_preserves_three_slots_and_camel_case_kinds() {
        let command: PlaybackCommand = serde_json::from_str(
            r#"{"type":"setDeckFx","deck":1,"slots":[{"kind":"bitCrusher","enabled":true,"mix":0.25,"parameter":0.75},{"kind":"hydrant","enabled":false,"mix":0.5,"parameter":0.6},{"kind":"rocket","enabled":true,"mix":1.0,"parameter":0.9}],"pad":0,"beatSeconds":0.48}"#,
        )
        .expect("三槽效果器命令应可解析");
        assert!(matches!(
            command,
            PlaybackCommand::SetDeckFx {
                deck: 1,
                slots,
                pad: 0,
                beat_seconds,
            } if slots[0].kind == PlaybackFxKind::BitCrusher
                && slots[0].enabled
                && slots[1].kind == PlaybackFxKind::Hydrant
                && slots[2].kind == PlaybackFxKind::Rocket
                && (slots[0].mix - 0.25).abs() < f32::EPSILON
                && (slots[0].parameter - 0.75).abs() < f32::EPSILON
                && (beat_seconds - 0.48).abs() < f32::EPSILON
        ));
    }

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
    fn loop_wire_contract_targets_a_physical_deck_not_an_ambiguous_track_id() {
        let command: PlaybackCommand =
            serde_json::from_str(r#"{"type":"toggleDeckLoop","deck":1,"length":2.0}"#)
                .expect("Deck-addressed LOOP command should parse");
        assert!(matches!(
            command,
            PlaybackCommand::ToggleDeckLoop {
                deck: 1,
                length,
            } if (length - 2.0).abs() < f64::EPSILON
        ));

        let resize: PlaybackCommand =
            serde_json::from_str(r#"{"type":"resizeDeckLoop","deck":1,"length":4.0}"#)
                .expect("Deck-addressed LOOP resize should parse");
        assert!(matches!(
            resize,
            PlaybackCommand::ResizeDeckLoop {
                deck: 1,
                length,
            } if (length - 4.0).abs() < f64::EPSILON
        ));
    }

    #[test]
    fn sync_deck_wire_contract_carries_both_analysed_grids() {
        let command: PlaybackCommand = serde_json::from_str(
            r#"{"type":"syncDeck","follower":0,"master":1,"rate":0.98,"followerBpm":124.0,"followerFirstBeat":0.12,"masterBpm":128.0,"masterFirstBeat":0.08,"beatsPerBar":4}"#,
        )
        .expect("前端 SYNC 命令应可解析");
        assert!(matches!(
            command,
            PlaybackCommand::SyncDeck {
                follower: 0,
                master: 1,
                beats_per_bar: 4,
                ..
            }
        ));
    }

    #[test]
    fn normalized_platter_wire_contract_unifies_start_move_and_end() {
        let begin: PlaybackCommand = serde_json::from_str(
            r#"{"type":"controlDeckPlatter","deck":1,"phase":"start","gestureId":77,"expectedTrackId":9}"#,
        ).expect("generation-safe platter start should parse");
        assert!(matches!(
            begin,
            PlaybackCommand::ControlDeckPlatter {
                deck: 1,
                phase: PlaybackPlatterPhase::Start,
                gesture_id: 77,
                expected_track_id: Some(9),
                velocity: 0.0,
                ..
            }
        ));
        let update: PlaybackCommand = serde_json::from_str(
            r#"{"type":"controlDeckPlatter","deck":1,"phase":"move","gestureId":77,"sequence":3,"velocity":-2.5}"#,
        ).expect("generation-safe platter move should parse");
        assert!(matches!(
            update,
            PlaybackCommand::ControlDeckPlatter {
                phase: PlaybackPlatterPhase::Move,
                gesture_id: 77,
                sequence: 3,
                velocity,
                ..
            } if (velocity + 2.5).abs() < f64::EPSILON
        ));
        let end: PlaybackCommand = serde_json::from_str(
            r#"{"type":"controlDeckPlatter","deck":1,"phase":"end","gestureId":77,"sequence":4,"velocity":-1.75}"#,
        ).expect("platter end should carry the final throw atomically");
        assert!(matches!(
            end,
            PlaybackCommand::ControlDeckPlatter {
                phase: PlaybackPlatterPhase::End,
                velocity,
                ..
            } if (velocity + 1.75).abs() < f64::EPSILON
        ));
    }

    #[test]
    fn lightweight_levels_serialize_peaks_and_fifteen_bands_per_deck() {
        let mut levels = PlaybackLevels::default();
        levels.peaks = [0.25, 0.5];
        levels.bands[0][7] = 0.75;
        let json = serde_json::to_value(levels).expect("电平事件应可序列化");
        assert_eq!(json["peaks"][1], 0.5);
        assert_eq!(json["bands"][0].as_array().map(Vec::len), Some(15));
        assert_eq!(json["bands"][1].as_array().map(Vec::len), Some(15));
        assert_eq!(json["bands"][0][7], 0.75);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandAck {
    pub command_id: u64,
    pub accepted_sequence: u64,
    pub snapshot: PlaybackSnapshot,
}
