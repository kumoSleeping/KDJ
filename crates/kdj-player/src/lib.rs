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
mod stream;
mod stretch;
mod time_stretch;

/// Stable DSP Q values behind the semantic low / medium / high resonance setting. Low preserves
/// the legacy channel-filter response. High is a Pioneer-like resonant sweep; the former `Q = 4`
/// peak could add ~12 dB on mastered material, so 2.4 stays musical and the resonant path already
/// has a soft ceiling.
pub const FILTER_RESONANCE_LOW_Q: f32 = 0.72;
pub const FILTER_RESONANCE_MEDIUM_Q: f32 = 1.4;
pub const FILTER_RESONANCE_HIGH_Q: f32 = 2.4;
pub const DEFAULT_FILTER_RESONANCE_Q: f32 = FILTER_RESONANCE_HIGH_Q;

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
pub use stream::{
    decode_file_region, decode_file_streaming, decode_file_streaming_looped,
    decode_live_stem_streaming, decode_source_region, decode_source_streaming,
    decode_source_streaming_looped, decode_stem_cache_region, decode_stem_cache_streaming,
    run_pitch_preserving_pipeline, stream_decoded_loop, FrameLerp, LoopWindow, StemFrame,
    StreamMetadata, StreamSeekControl, StreamSource, StreamWriter, StreamingMediaSource,
    DEFAULT_STREAM_BUFFER_SECONDS, STEM_GAIN_MAX, STEM_LANES,
};
pub use stretch::{stretch_preserving_pitch, stretch_preserving_pitch_with_cancel};
pub use time_stretch::{
    normalize_rate, PitchPreservingStretcher, TempoControl, TimeStretchFrame, MAX_TEMPO_RATE,
    MIN_TEMPO_RATE,
};
