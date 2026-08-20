//! Native four-stem separation and cache ownership.
//!
//! Model inference never runs in the audio callback. Desktop live STEM uses four Spleeter4 FP16
//! ONNX U-Nets behind ONNX Runtime. The public cache reader stays independent of that backend.

mod audio;
mod cache;
#[cfg(feature = "stem-debug-onnx")]
mod debug;
mod debug_dsp;
#[cfg(not(feature = "stem-debug-onnx"))]
mod debug_stub;
mod dj;
mod dsp;
mod instant;
mod live;
mod manager;
mod model;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
mod onnx;
mod runtime;
mod scan;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
pub mod seeklab;

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
pub use instant::{
    try_acquire_instant_admission, InstantAdmissionGuard, InstantStemChunk, InstantStemPool,
    InstantStemTicket, InstantTrack, InstantTrackTicket, INSTANT_CONTEXT_FRAMES,
    INSTANT_HANDOFF_FRAMES, INSTANT_HOP_BUDGET_MS, INSTANT_HOP_FRAMES, INSTANT_INPUT_FRAMES,
};
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

/// Stable model family/version identifiers used by installation and cache ownership.
pub const MODEL_ID: &str = "spleeter4-fp16-onnx";
pub const MODEL_VERSION: &str = "Best-Practice-87c5b6d";
pub const MODEL_ARCHIVE_BYTES: u64 = 78_856_560;
/// SHA-256 of the four model files concatenated in Drums / Bass / Other / Vocals order. This is
/// the cache identity; every individual artifact hash is also locked in `model.rs`.
pub const MODEL_ARCHIVE_SHA256: &str =
    "a9ef9575560b0d224dde174e886a09ee9b4e2b7fe537b040697446c5f8c8cf8f";
pub const MODEL_ARCHIVE_URL: &str = "https://huggingface.co/Best-Practice/spleeter-4stems-onnx";
pub const MODEL_DIRECTORY: &str = "spleeter4-fp16-onnx";
pub const SAMPLE_RATE: u32 = 44_100;
/// One model tile contains exactly 512 periodic-Hann STFT frames. We keep the centre 169 hops and
/// discard 173 hops on each edge. The 3.92-second retained core still fits the bounded four-second
/// Deck ring while the generous overlap keeps model-window edges out of playback.
pub const SEGMENT_SAMPLES: usize = 527_360;
pub const SEGMENT_CONTEXT_SAMPLES: usize = 177_152;
pub const SEGMENT_CORE_SAMPLES: usize = 173_056;
/// A 100 ms linear handoff between two highly correlated Spleeter4 estimates avoids both clicks and
/// the +3 dB lift that an equal-power blend caused for phase-aligned outputs.
pub const SEGMENT_HANDOFF_SAMPLES: usize = 4_410;
/// Waveform publication uses exactly the retained context-safe core.
pub const SEGMENT_WAVEFORM_GUARD_SAMPLES: usize = SEGMENT_CONTEXT_SAMPLES;
/// Compatibility name for consumers that describe the discarded edge context.
pub const SEGMENT_OVERLAP: usize = SEGMENT_CONTEXT_SAMPLES * 2;

/// ByteDance MobileNet_Subbandtime was trained on three-second stereo windows. Its reference
/// separator advances by half a window and keeps the middle 50%, so production discards 750 ms on
/// each edge and retains a 1.5-second core plus KDJ's 100 ms successor handoff tail.
pub const MOBILENET_SEGMENT_SAMPLES: usize = 132_300;
pub const MOBILENET_SEGMENT_CONTEXT_SAMPLES: usize = 33_075;
pub const MOBILENET_SEGMENT_CORE_SAMPLES: usize = 66_150;
pub const MOBILENET_SEGMENT_HANDOFF_SAMPLES: usize = SEGMENT_HANDOFF_SAMPLES;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StemTileGeometry {
    pub samples: usize,
    pub context: usize,
    pub core: usize,
    pub handoff: usize,
}

impl StemTileGeometry {
    pub const fn spleeter() -> Self {
        Self {
            samples: SEGMENT_SAMPLES,
            context: SEGMENT_CONTEXT_SAMPLES,
            core: SEGMENT_CORE_SAMPLES,
            handoff: SEGMENT_HANDOFF_SAMPLES,
        }
    }

    pub const fn mobilenet() -> Self {
        Self {
            samples: MOBILENET_SEGMENT_SAMPLES,
            context: MOBILENET_SEGMENT_CONTEXT_SAMPLES,
            core: MOBILENET_SEGMENT_CORE_SAMPLES,
            handoff: MOBILENET_SEGMENT_HANDOFF_SAMPLES,
        }
    }
}

pub fn stem_tile_geometry() -> StemTileGeometry {
    match crate::runtime::stem_runtime_preference().mode {
        kdj_core::StemMode::MobileNetTwo => StemTileGeometry::mobilenet(),
        _ => StemTileGeometry::spleeter(),
    }
}
