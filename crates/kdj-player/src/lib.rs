//! Shared realtime transport and mixer primitives.
//!
//! Decoding, network I/O and platform media sessions live outside the audio callback. The
//! callback accepts only fixed-size [`RtCommand`] values through a bounded SPSC queue.

mod command;
mod decode;
mod dsp;
mod engine;
mod manual_fx;
mod output;
mod state;
mod stream;
mod stretch;
mod time_stretch;

/// Stable DSP Q values behind the semantic low / medium / high resonance setting. Low preserves
/// the legacy channel-filter response. High is a Pioneer-like resonant sweep; Q = 3.2 gives a
/// clearer cutoff whoosh than 2.4 without returning to the former unsafe `Q = 4` (~12 dB) peak.
/// Both throws then take a 0.95 headroom scale so the resonant bump sits a little farther from
/// the soft ceiling. The resonant path already has a soft ceiling so mastered transients stay
/// below hard clip.
pub const FILTER_RESONANCE_LOW_Q: f32 = 0.72;
pub const FILTER_RESONANCE_MEDIUM_Q: f32 = 1.85;
pub const FILTER_RESONANCE_HIGH_Q: f32 = 3.2;
pub const DEFAULT_FILTER_RESONANCE_Q: f32 = FILTER_RESONANCE_HIGH_Q;
/// Fixed live-EQ analyser width shared by the realtime engine and the Tauri event contract.
pub const EQ_SPECTRUM_BANDS: usize = 15;

pub use command::{
    DeckFxKind, DeckFxSlot, DeckId, PlatterPhase, PlayerMode, RtCommand, TransitionPlan,
};
pub use decode::{
    decode_file, decode_file_with_limit, decode_file_with_limit_and_cancel, DecodedTrack,
};
pub use engine::{
    command_channel, AudioRenderer, CommandError, PlayerController, PERFORMANCE_PREROLL_SECONDS,
};
pub use output::{
    open_dynamic_default, open_prepared_default, DeviceOutput, DynamicPlayer, OutputError,
    OutputSpec,
};
pub use state::{OutputCallbackTiming, TransportSnapshot};
pub use stream::{
    decode_file_streaming, decode_file_streaming_seekable, decode_live_stem_streaming,
    decode_source_streaming, decode_source_streaming_seekable, decode_stem_cache_streaming,
    format_loop_clock, run_pitch_preserving_pipeline, FrameLerp, LoopWindow, StemFrame,
    StreamMetadata, StreamSeekControl, StreamSource, StreamWriter, StreamingMediaSource,
    DEFAULT_STREAM_BUFFER_SECONDS, LOOP_CAPTURE_HISTORY_SECONDS, MAX_TRANSPORT_LOOP_PCM_BYTES,
    MAX_TRANSPORT_LOOP_SECONDS, STEM_GAIN_MAX, STEM_LANES,
};
pub use stretch::{stretch_preserving_pitch, stretch_preserving_pitch_with_cancel};
pub use time_stretch::{
    normalize_rate, PitchPreservingStretcher, TempoControl, TimeStretchFrame, MAX_TEMPO_RATE,
    MIN_TEMPO_RATE,
};
