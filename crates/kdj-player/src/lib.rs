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

pub use command::{DeckId, PlayerMode, RtCommand};
pub use decode::{decode_file, DecodedTrack};
pub use engine::{command_channel, AudioRenderer, CommandError, PlayerController};
pub use output::{open_prepared_default, DeviceOutput, OutputError, OutputSpec};
pub use state::TransportSnapshot;
