//! Retired instant-separation boundary.
//!
//! The production runtime has one ByteDance background separator. These compatibility types keep
//! the player stream contract source-compatible while making the retired instant path
//! impossible to construct or load.

use std::path::Path;
use std::sync::Arc;

use anyhow::{bail, Result};

pub const INSTANT_HOP_FRAMES: usize = 512;
pub const INSTANT_CONTEXT_FRAMES: usize = 1_024;
pub const INSTANT_INPUT_FRAMES: usize =
    INSTANT_CONTEXT_FRAMES + INSTANT_HOP_FRAMES + INSTANT_CONTEXT_FRAMES;
pub const INSTANT_HANDOFF_FRAMES: usize = 256;
pub const INSTANT_HOP_BUDGET_MS: u64 = 12;

pub struct InstantTrack;

impl InstantTrack {
    pub fn frames(&self) -> u64 {
        0
    }

    pub fn frame(&self, _index: u64) -> Option<[f32; 2]> {
        None
    }
}

pub struct InstantStemChunk {
    stems: [Vec<[f32; 2]>; 4],
}

impl InstantStemChunk {
    pub fn stems(&self) -> &[Vec<[f32; 2]>; 4] {
        &self.stems
    }

    pub fn frames(&self) -> usize {
        self.stems[0].len()
    }
}

#[derive(Clone)]
pub struct InstantTrackTicket;

impl InstantTrackTicket {
    pub fn ready(&self) -> Option<Arc<InstantTrack>> {
        None
    }

    pub fn wait<F>(&self, _cancelled: F) -> Result<Arc<InstantTrack>>
    where
        F: Fn() -> bool,
    {
        bail!("旧版即时 STEM runtime 已移除；请使用 ByteDance STEM")
    }
}

pub struct InstantAdmissionGuard;

pub(crate) fn instant_admission_active() -> bool {
    false
}

pub fn try_acquire_instant_admission(_deck: usize) -> Option<InstantAdmissionGuard> {
    None
}

pub struct InstantStemTicket;

impl InstantStemTicket {
    pub fn try_wait(&self) -> Result<Option<Arc<InstantStemChunk>>> {
        Ok(None)
    }
}

pub struct InstantStemPool;

impl InstantStemPool {
    pub fn new(_model_directory: &Path) -> Result<Arc<Self>> {
        bail!("旧版即时 STEM runtime 已移除；请使用 ByteDance STEM")
    }

    pub(crate) fn new_for_parent(_model_directory: &Path, _pool_id: u64) -> Result<Arc<Self>> {
        bail!("旧版即时 STEM runtime 已移除；请使用 ByteDance STEM")
    }

    pub fn prepare_track(&self, _path: &Path) -> Result<InstantTrackTicket> {
        bail!("旧版即时 STEM runtime 已移除；请使用 ByteDance STEM")
    }

    pub fn wait_ready<F>(&self, _deck: usize, _cancelled: F) -> Result<()>
    where
        F: Fn() -> bool,
    {
        bail!("旧版即时 STEM runtime 已移除；请使用 ByteDance STEM")
    }

    pub fn submit(
        &self,
        _deck: usize,
        _track: Arc<InstantTrack>,
        _frame_index: u64,
        _epoch: Arc<std::sync::atomic::AtomicU64>,
        _expected_epoch: u64,
    ) -> Result<InstantStemTicket> {
        bail!("旧版即时 STEM runtime 已移除；请使用 ByteDance STEM")
    }

    pub fn is_ready(&self, _deck: usize) -> bool {
        false
    }

    pub fn shutdown(&self, _reason: &'static str) {}
}
