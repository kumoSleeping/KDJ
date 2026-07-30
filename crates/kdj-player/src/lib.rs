//! Shared realtime transport and mixer primitives.
//!
//! Decoding, network I/O and platform media sessions live outside the audio callback. The
//! callback accepts only fixed-size [`RtCommand`] values through a bounded SPSC queue.

mod command;
mod decode;
mod dsp;
mod engine;
mod output;
mod state;
mod stretch;

pub use command::{DeckId, PlayerMode, RtCommand, TransitionPlan};
pub use decode::{
    decode_file, decode_file_with_limit, decode_file_with_limit_and_cancel, DecodedTrack,
};
pub use engine::{command_channel, AudioRenderer, CommandError, PlayerController};
pub use output::{
    open_dynamic_default, open_prepared_default, DeviceOutput, DynamicPlayer, OutputError,
    OutputSpec,
};
pub use state::TransportSnapshot;
pub use stretch::{stretch_preserving_pitch, stretch_preserving_pitch_with_cancel};
