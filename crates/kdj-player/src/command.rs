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
    /// Capacitive platter contact temporarily owns this Deck's media cursor. This is deliberately
    /// separate from `SetDeckPlaying`: the logical transport stays playing while the callback
    /// stops consuming its source, so a release cannot be mistaken for a Play/Pause transition.
    SetDeckScratchHeld {
        deck: DeckId,
        held: bool,
    },
    /// Relative platter motion while a capacitive hold owns this Deck. The callback plays the
    /// moved audio immediately instead of waiting for a decoder rebuild on note-off.
    ScratchDeck {
        deck: DeckId,
        delta_frames: f64,
    },
    SetRate {
        deck: DeckId,
        rate: f32,
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
        looping: bool,
        /// Inclusive loop-in, in the same output-rate frame units as `deck_positions`.
        start_frames: u64,
        /// Loop duration in those frames. Ignored when `looping` is false.
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
