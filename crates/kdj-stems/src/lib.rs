//! Model-free classical two-track separation and cache ownership.
//!
//! The live path uses a Redress/ADRess soft spatial estimate implemented with Rust FFTs. It has no
//! model weights, runtime downloads, or accelerator provider and never runs in the audio callback.

mod audio;
mod cache;
pub mod classical;
mod dj;
mod instant;
mod live;
mod manager;
mod runtime;
mod scan;

pub use audio::{decode_stereo_file, StemWindowCursor};
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
pub use manager::{StemCoordinator, StemRuntimeStatus, TrackStemStatus};
pub use scan::{next_scan_work, ScanJobView, ScanWork, StemScanStatus, SCAN_VIEWPORT_SECONDS};

/// Stable algorithm identifier used by live-pool and cache ownership.
pub const RUNTIME_ID: &str = "classical-redress-v1";
pub const RUNTIME_VERSION: &str = "redress-test-b";
pub const SAMPLE_RATE: u32 = 44_100;
/// One short realtime tile: 46 ms past context, 93 ms audible core, and 46 ms future context.
/// The classical FFT itself has 23.2 ms algorithmic latency at 44.1 kHz.
pub const SEGMENT_SAMPLES: usize = 8_192;
pub const SEGMENT_CONTEXT_SAMPLES: usize = 2_048;
pub const SEGMENT_CORE_SAMPLES: usize = 4_096;
/// One FFT hop is retained for the successor handoff.
pub const SEGMENT_HANDOFF_SAMPLES: usize = 512;
/// Waveform publication uses exactly the retained context-safe core.
pub const SEGMENT_WAVEFORM_GUARD_SAMPLES: usize = SEGMENT_CONTEXT_SAMPLES;
/// Compatibility name for consumers that describe the discarded edge context.
pub const SEGMENT_OVERLAP: usize = SEGMENT_CONTEXT_SAMPLES * 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StemTileGeometry {
    pub samples: usize,
    pub context: usize,
    pub core: usize,
    pub handoff: usize,
}

impl StemTileGeometry {
    pub const fn classical() -> Self {
        Self {
            samples: SEGMENT_SAMPLES,
            context: SEGMENT_CONTEXT_SAMPLES,
            core: SEGMENT_CORE_SAMPLES,
            handoff: SEGMENT_HANDOFF_SAMPLES,
        }
    }
}

pub fn stem_tile_geometry() -> StemTileGeometry {
    StemTileGeometry::classical()
}
