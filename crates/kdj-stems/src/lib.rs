//! Native four-stem separation and cache ownership.
//!
//! Model inference never runs in the audio callback. Desktop live STEM uses the fixed-shape
//! SCNet Small spectral core through Core ML on macOS and ONNX Runtime on Windows. The public
//! cache reader stays independent of that backend.

mod audio;
mod cache;
#[cfg(target_os = "macos")]
mod coreml;
#[cfg(feature = "stem-debug-onnx")]
mod debug;
mod debug_dsp;
#[cfg(not(feature = "stem-debug-onnx"))]
mod debug_stub;
mod dj;
mod dsp;
mod live;
mod manager;
mod model;
#[cfg(target_os = "windows")]
mod onnx;
mod runtime;
mod scan;

pub use audio::StemWindowCursor;
pub use cache::{
    read_cache_header, seek_cache_frame, stem_cache_waveform, StemCacheHeader, StemKind,
    StemWaveform, ALL_STEM_MASK, BYTES_PER_FRAME, HEADER_BYTES,
};
#[cfg(feature = "stem-debug-onnx")]
pub use debug::{
    render_stem_debug, stem_debug_model_catalog, StemDebugLane, StemDebugModel,
    StemDebugModelCatalog, StemDebugModelStatus, StemDebugRender,
};
#[cfg(not(feature = "stem-debug-onnx"))]
pub use debug_stub::{
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

/// Stable model family/version identifiers used by installation and cache ownership. The
/// deployment artifacts were exported from tensors byte-identical to ZFTurbo's v1.0.6 checkpoint
/// (`1bc0…2aa`); Core ML/ONNX package hashes are verified separately in `model.rs`.
pub const MODEL_ID: &str = "scnet-small";
pub const MODEL_VERSION: &str = "ZF-v1.0.6+deploy-v0.1.2";
pub const MODEL_ARCHIVE_BYTES: u64 = 34_543_230;
/// Weight identity in cache headers, deliberately independent of Core ML versus ONNX packaging.
pub const MODEL_ARCHIVE_SHA256: &str =
    "1bc0d1abb20bfdf966dcd07637bafd03e4bc13653d09ef18bc9b3e342eafe2aa";
pub const MODEL_ARCHIVE_URL: &str = "https://github.com/demixr/scnet-executorch/releases/download/v0.1.2/scnet_coreml.mlpackage.zip";
pub const MODEL_DIRECTORY: &str = "scnet_coreml.mlpackage";
pub const SAMPLE_RATE: u32 = 44_100;
/// Fixed 7.8-second deployment shape: 1.95 s left context + 3.9 s retained core + 1.95 s right
/// context. Adjacent requests overlap by 50%; only their context-safe centre enters playback.
pub const SEGMENT_SAMPLES: usize = 343_980;
pub const SEGMENT_CONTEXT_SAMPLES: usize = 85_995;
pub const SEGMENT_CORE_SAMPLES: usize = 171_990;
/// A 100 ms linear handoff between two highly correlated SCNet estimates avoids both clicks and
/// the +3 dB lift that an equal-power blend caused for phase-aligned outputs.
pub const SEGMENT_HANDOFF_SAMPLES: usize = 4_410;
/// Waveform publication uses exactly the retained context-safe core.
pub const SEGMENT_WAVEFORM_GUARD_SAMPLES: usize = SEGMENT_CONTEXT_SAMPLES;
/// Compatibility name for consumers that describe the discarded edge context.
pub const SEGMENT_OVERLAP: usize = SEGMENT_CONTEXT_SAMPLES * 2;
