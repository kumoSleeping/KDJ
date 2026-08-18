//! Native, model-free four-stem approximation and cache ownership.
//!
//! The default desktop path is pure Rust classical DSP. It combines a stereo centre mask with
//! median-filter HPSS on short streaming chunks and never downloads or loads an AI model.

mod audio;
mod cache;
mod classical;
#[cfg(all(feature = "ai-stem-legacy", target_os = "macos"))]
mod coreml;
mod debug;
mod debug_dsp;
mod dj;
#[cfg(feature = "ai-stem-legacy")]
mod dsp;
mod live;
mod manager;
#[cfg(feature = "ai-stem-legacy")]
mod model;
#[cfg(all(feature = "ai-stem-legacy", target_os = "windows"))]
mod onnx;
mod runtime;
mod scan;

// Preserved only as one deletion-ready boundary while the classical replacement is evaluated.
// Nothing in the default runtime references these modules or their external artifacts.
#[cfg(feature = "ai-stem-legacy")]
#[path = "debug_ai.rs"]
mod legacy_ai_debug;
#[cfg(feature = "ai-stem-legacy")]
#[path = "manager_ai.rs"]
mod legacy_ai_manager;
#[cfg(feature = "ai-stem-legacy")]
#[path = "runtime_ai.rs"]
mod legacy_ai_runtime;

pub use audio::StemWindowCursor;
pub use cache::{
    read_cache_header, seek_cache_frame, stem_cache_waveform, StemCacheHeader, StemKind,
    StemWaveform, ALL_STEM_MASK, BYTES_PER_FRAME, HEADER_BYTES,
};
pub use debug::{
    render_stem_debug, stem_debug_model_catalog, StemDebugLane, StemDebugModel,
    StemDebugModelCatalog, StemDebugModelStatus, StemDebugRender,
};
pub use dj::{DeckStemSeekControl, DualDeckStemSeekControl, PcmRandomAccessCache, StemSeekRequest};
pub use live::{
    acquire_stem_pool, any_live_audio_lease_held, begin_live_stem_waveform,
    begin_scan_stem_waveform, live_stem_coverage, live_stem_range_covered, live_stem_waveform,
    live_stem_waveform_delta, publish_live_stem_waveform_block, publish_scan_stem_waveform_block,
    record_stem_output_underrun, record_stem_output_underrun_for_deck, release_scan_stem_waveform,
    stem_output_underruns, stem_output_underruns_by_deck, stem_runtime_diagnostics,
    stem_tile_cache_key, LiveStemCoverage, LiveStemWaveGuard, LiveStemWaveformDelta, StemChunk,
    StemInferencePool, StemInferenceTicket, StemPoolGuard, StemRuntimeDiagnostics, StemScanGuard,
};
pub use manager::{ModelStatus, StemCoordinator, TrackStemStatus};
pub use scan::{next_scan_work, ScanJobView, ScanWork, StemScanStatus, SCAN_VIEWPORT_SECONDS};

pub const MODEL_ID: &str = "classical-vocal-hpss";
pub const MODEL_VERSION: &str = "dsp-v2.1";
/// Stable non-file identity passed through the legacy `cachePath` transport field. The playback
/// actor uses this only to key and reuse the live DSP pool; the model-free runtime never opens it.
pub const RUNTIME_KEY: &str = "builtin://classical-vocal-hpss/dsp-v2.1";
pub const MODEL_ARCHIVE_BYTES: u64 = 0;
/// Algorithm/cache identity, not a downloadable artifact hash.
pub const MODEL_ARCHIVE_SHA256: &str =
    "0e8753c00bb5ab754f0c693cb725b11399d87104fe4c9ee7906f58a8fa72a6cb";
pub const MODEL_ARCHIVE_URL: &str = "";
pub const MODEL_DIRECTORY: &str = "";
pub const SAMPLE_RATE: u32 = 44_100;
/// 557 ms input chunk: 93 ms context + 371 ms published core + 93 ms context. The context covers
/// the ±8-frame median window while keeping cache-miss work small enough for a live stream.
pub const SEGMENT_SAMPLES: usize = 24_576;
pub const SEGMENT_CONTEXT_SAMPLES: usize = 4_096;
pub const SEGMENT_CORE_SAMPLES: usize = 16_384;
/// A short complementary-mask handoff suppresses boundary zipper noise.
pub const SEGMENT_HANDOFF_SAMPLES: usize = 1_024;
/// Waveform publication uses exactly the retained context-safe core.
pub const SEGMENT_WAVEFORM_GUARD_SAMPLES: usize = SEGMENT_CONTEXT_SAMPLES;
/// Compatibility name for consumers that describe the discarded edge context.
pub const SEGMENT_OVERLAP: usize = SEGMENT_CONTEXT_SAMPLES * 2;
