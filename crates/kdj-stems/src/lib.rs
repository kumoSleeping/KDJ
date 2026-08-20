//! Native ByteDance two-stem separation and cache ownership.
//!
//! Model inference never runs in the audio callback. The live path uses the locked ByteDance
//! MobileNet_Subbandtime FP32 ONNX model behind ONNX Runtime. The public cache reader stays
//! independent of that backend.

mod audio;
mod cache;
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

pub use audio::StemWindowCursor;
pub use cache::{
    read_cache_header, seek_cache_frame, stem_cache_waveform, StemCacheHeader, StemKind,
    StemWaveform, ALL_STEM_MASK, BYTES_PER_FRAME, HEADER_BYTES,
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
pub const MODEL_ID: &str = "bytedance-mobilenet-subbandtime-2-fp32-onnx";
pub const MODEL_VERSION: &str = "zenodo-5804160-kdj-3s-v1";
pub const MODEL_ARCHIVE_BYTES: u64 = 6_414_644;
/// SHA-256 of the single locked ByteDance model file.
pub const MODEL_ARCHIVE_SHA256: &str =
    "999ba99f306f09c9a35a18fe0007b53f8ad2c3cb5bb9d638128bf7257cd8e991";
pub const MODEL_ARCHIVE_URL: &str = "https://github.com/bytedance/music_source_separation";
pub const MODEL_DIRECTORY: &str = "bytedance-mobilenet-subbandtime-2-fp32-onnx";
pub const SAMPLE_RATE: u32 = 44_100;
/// ByteDance uses a three-second stereo window, retaining the middle 1.5 seconds after discarding
/// 750 ms of context on either edge. These names remain stable for the player stream contract.
pub const SEGMENT_SAMPLES: usize = 132_300;
pub const SEGMENT_CONTEXT_SAMPLES: usize = 33_075;
pub const SEGMENT_CORE_SAMPLES: usize = 66_150;
/// A 100 ms linear handoff between adjacent ByteDance estimates avoids boundary clicks.
pub const SEGMENT_HANDOFF_SAMPLES: usize = 4_410;
/// Waveform publication uses exactly the retained context-safe core.
pub const SEGMENT_WAVEFORM_GUARD_SAMPLES: usize = SEGMENT_CONTEXT_SAMPLES;
/// Compatibility name for consumers that describe the discarded edge context.
pub const SEGMENT_OVERLAP: usize = SEGMENT_CONTEXT_SAMPLES * 2;

/// Explicit aliases for callers that name the ByteDance architecture.
pub const MOBILENET_SEGMENT_SAMPLES: usize = SEGMENT_SAMPLES;
pub const MOBILENET_SEGMENT_CONTEXT_SAMPLES: usize = SEGMENT_CONTEXT_SAMPLES;
pub const MOBILENET_SEGMENT_CORE_SAMPLES: usize = SEGMENT_CORE_SAMPLES;
pub const MOBILENET_SEGMENT_HANDOFF_SAMPLES: usize = SEGMENT_HANDOFF_SAMPLES;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StemTileGeometry {
    pub samples: usize,
    pub context: usize,
    pub core: usize,
    pub handoff: usize,
}

impl StemTileGeometry {
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
    StemTileGeometry::mobilenet()
}
