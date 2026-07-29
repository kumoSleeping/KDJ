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
    },
}
