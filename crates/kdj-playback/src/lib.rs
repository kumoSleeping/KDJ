//! Cross-platform playback coordination above the realtime renderer.
//!
//! This crate owns command ordering, authoritative snapshots, Deck lifecycle, bounded streaming
//! decode and stale-worker cancellation. Tauri and platform media sessions are adapters: they do
//! not own playback state.

mod contract;
mod coordinator;
mod platform;
mod remote_source;

pub use contract::{
    CommandAck, PlaybackBeatGrid, PlaybackClock, PlaybackCommand, PlaybackDeckClock,
    PlaybackLevels, PlaybackPhase, PlaybackPlatterPhase, PlaybackSnapshot, PlaybackSource,
    PlaybackSourceKind, PlaybackSyncPhase, PlaybackSyncSnapshot, PlaybackTransitionPlan,
};
pub use coordinator::PlaybackCoordinator;
pub use platform::{CpalOutputFactory, PlaybackOutput, PlaybackOutputFactory, PlaybackOutputSpec};
