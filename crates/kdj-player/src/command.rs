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
    SetPlaying(bool),
    SetMasterGain(f32),
    SetDeckGain {
        deck: DeckId,
        gain: f32,
    },
    SetRate {
        deck: DeckId,
        rate: f32,
    },
    SetEq {
        deck: DeckId,
        low_db: f32,
        high_db: f32,
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

/// Internal source-lifetime messages share the transport queue so installing PCM and applying
/// the first seek/gain are totally ordered at one callback boundary. The address is never exposed
/// outside this crate: `DynamicPlayer` retains the matching `Arc<DecodedTrack>` until the audio
/// callback acknowledges retirement.
#[derive(Clone, Copy, Debug)]
pub(crate) enum EngineCommand {
    Transport(RtCommand),
    InstallPrepared {
        deck: DeckId,
        source_id: u64,
        address: usize,
        start_frame: u64,
    },
    ClearPrepared {
        deck: DeckId,
    },
}
