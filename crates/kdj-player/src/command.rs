/// Selects the buffering policy without changing the public transport state.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(u8)]
pub enum PlayerMode {
    #[default]
    Continuous,
    RealtimeDj,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(u8)]
pub enum DeckId {
    #[default]
    A = 0,
    B = 1,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(u8)]
pub enum PlatterPhase {
    #[default]
    Start,
    Move,
    End,
    /// Explicit Play/Pause/load cancellation: no coast and no inherited velocity.
    Cancel,
}

/// Manual Performance effects. The discriminants are stable callback data, not a serialized API.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(u8)]
pub enum DeckFxKind {
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

impl DeckFxKind {
    pub const ALL: [Self; 9] = [
        Self::Echo,
        Self::Reverb,
        Self::Flanger,
        Self::Phaser,
        Self::BitCrusher,
        Self::Gate,
        Self::Alarm,
        Self::Hydrant,
        Self::Rocket,
    ];
}

/// One of the three serial manual-FX slots. MIX is a dry/wet crossfade; PARAMETER controls the
/// effect-specific characteristic (for example LFO rate or decay). Both are normalized to 0..1
/// by the coordinator before reaching the callback.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DeckFxSlot {
    pub kind: DeckFxKind,
    pub enabled: bool,
    pub mix: f32,
    pub parameter: f32,
}

impl Default for DeckFxSlot {
    fn default() -> Self {
        Self {
            kind: DeckFxKind::Echo,
            enabled: false,
            mix: 0.5,
            parameter: 0.5,
        }
    }
}

impl DeckId {
    pub const fn other(self) -> Self {
        match self {
            Self::A => Self::B,
            Self::B => Self::A,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TransitionPlan {
    pub flags: u8,
    /// One beat on the output clock, used by delay-based effects.
    pub beat_frames: u32,
}

impl TransitionPlan {
    pub const EQ: u8 = 1 << 0;
    pub const FILTER: u8 = 1 << 1;
    pub const VOCAL_CUT: u8 = 1 << 2;
    pub const ECHO: u8 = 1 << 3;
    pub const ALARM: u8 = 1 << 4;
    pub const HYDRANT: u8 = 1 << 5;
    /// 同曲 seek：两台 Deck 做总增益恒定的极短平滑换手，避免阶跃爆点和双时间线叠音。
    pub const SEEK_DUCK: u8 = 1 << 6;

    pub const fn contains(self, flag: u8) -> bool {
        self.flags & flag != 0
    }
}

/// Commands consumed at the start of an audio callback.
///
/// This type deliberately contains no `String`, `Vec`, `Arc` or callback. Preparing and
/// releasing decoded sources must happen on worker/control threads, never here.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RtCommand {
    SetMode(PlayerMode),
    SetPlaying {
        playing: bool,
        fade_frames: u32,
    },
    SetMasterGain(f32),
    SetDeckGain {
        deck: DeckId,
        gain: f32,
    },
    SetDeckPlaying {
        deck: DeckId,
        playing: bool,
    },
    /// Route this Deck to output channels 3/4 when the selected device exposes a cue pair.
    SetDeckPfl {
        deck: DeckId,
        enabled: bool,
    },
    /// One callback-domain platter state machine. Velocity is normalized media speed: 1.0 is
    /// nominal forward playback and -1.0 is nominal reverse. End includes the final input speed
    /// in the same command, so queue/IPC timing cannot erase a throw.
    ControlDeckPlatter {
        deck: DeckId,
        phase: PlatterPhase,
        velocity: f64,
    },
    /// Atomic high-rate platter observation. Start/End remain ordered gesture edges above, while
    /// each replaceable Move carries its own device-derived freshness horizon.
    UpdateDeckPlatter {
        deck: DeckId,
        velocity: f64,
        valid_for_seconds: f32,
    },
    SetRate {
        deck: DeckId,
        rate: f32,
    },
    /// Change both persistent Deck tempos at one callback boundary. A linked SYNC fader must not
    /// expose an intermediate frame where only one side has adopted the new clock rate.
    SetDeckRates {
        rates: [f32; 2],
    },
    /// Small callback-domain phase correction layered after the pitch-preserving worker. Unlike a
    /// persistent TEMPO change this never asks Rubber Band R3 to rebuild its live ratio plan.
    SetDeckPhaseCorrection {
        deck: DeckId,
        multiplier: f32,
    },
    /// Per-lane STEM gains in `StemKind::index` order (drums, bass, other, vocals). Applied by
    /// the renderer with a short ramp, so mute/volume moves land at the next callback frame
    /// without touching any decode worker.
    SetDeckStemGains {
        deck: DeckId,
        gains: [f32; 4],
    },
    /// Transport-level loop on the *currently installed* source. The callback wraps its media
    /// cursor into `[start_frames, start_frames + frames)` instead of ending the Deck; EQ, STEM
    /// gains and TEMPO stay on that source. Installing a replacement source clears this flag
    /// until the coordinator restores it.
    SetDeckLoop {
        deck: DeckId,
        /// Even LoopWindow generation. Streaming PCM carries this generation to the callback so
        /// desired control state cannot be confused with a different cached loop revision.
        generation: u64,
        looping: bool,
        /// Inclusive loop-in, in the same output-rate frame units as `deck_positions`.
        start_frames: u64,
        /// Loop duration in those frames. Ignored when `looping` is false.
        frames: u64,
    },
    /// Put the installed source on a silent timeline before its first media frame. The decoder
    /// remains parked at frame 0 until this signed callback clock reaches zero.
    SetDeckPreroll {
        deck: DeckId,
        frames: u64,
    },
    SetEq {
        deck: DeckId,
        trim_db: f32,
        low_db: f32,
        mid_db: f32,
        high_db: f32,
        filter: f32,
    },
    /// Three serial manual Performance FX slots. `pad` is 0 when no momentary Pad FX is held.
    SetDeckFx {
        deck: DeckId,
        slots: [DeckFxSlot; 3],
        pad: u8,
        beat_seconds: f32,
    },
    /// Global Q for the Performance channel filter. It is prevalidated on the control thread;
    /// the callback only swaps coefficients for both decks at its next boundary.
    SetFilterResonance {
        q: f32,
    },
    /// Select a cue that a decode worker has already made available to the renderer.
    SeekPrepared {
        deck: DeckId,
        frame: u64,
    },
    /// Move to the other prewarmed deck over exactly `transition_frames` output frames.
    HandoffPrepared {
        to: DeckId,
        target_frame: u64,
        transition_frames: u32,
        plan: TransitionPlan,
    },
}

/// Identifies the concrete stable address installed in the callback source table.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum SourceKind {
    #[default]
    Decoded,
    Stream,
    StemStream,
}

/// Internal source-lifetime messages share the transport queue so installing a source and its
/// first transport command are totally ordered at one callback boundary. DynamicPlayer retains
/// the matching Arc until the audio callback acknowledges retirement.
#[derive(Clone, Copy, Debug)]
pub(crate) enum EngineCommand {
    Transport(RtCommand),
    InstallPrepared {
        deck: DeckId,
        source_id: u64,
        source_kind: SourceKind,
        address: usize,
        start_frame: u64,
    },
    ClearPrepared {
        deck: DeckId,
    },
}
