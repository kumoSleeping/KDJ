use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::SAMPLE_RATE;

/// Immutable 44.1 kHz stereo PCM used by stateful streaming separators.
///
/// Decode/resample a track before publishing this cache. Random reads then become bounded memory
/// copies on an inference worker; the audio callback never opens or decodes a file. The same
/// allocation can be shared by both physical Decks when they load the same track.
#[derive(Clone, Debug)]
pub struct PcmRandomAccessCache {
    frames: Arc<[[f32; 2]]>,
}

impl PcmRandomAccessCache {
    pub fn from_interleaved(frames: Vec<[f32; 2]>) -> Self {
        Self {
            frames: frames.into(),
        }
    }

    pub fn from_planar(left: &[f32], right: &[f32]) -> Self {
        let frames = left
            .iter()
            .zip(right)
            .map(|(&left, &right)| [finite(left), finite(right)])
            .collect();
        Self::from_interleaved(frames)
    }

    pub fn frames(&self) -> u64 {
        self.frames.len() as u64
    }

    pub fn duration_seconds(&self) -> f64 {
        self.frames() as f64 / f64::from(SAMPLE_RATE)
    }

    pub fn frame(&self, index: u64) -> Option<[f32; 2]> {
        usize::try_from(index)
            .ok()
            .and_then(|index| self.frames.get(index))
            .copied()
    }

    /// Copies one RT3S single-frame input: the previous 512 samples followed by the 512 new
    /// samples at `frame_index`. Song edges are zero-padded. This bounded 8 KiB copy belongs on the
    /// inference worker, never in the platform audio callback.
    pub fn rt3s_window(&self, frame_index: u64) -> [[f32; 1_024]; 2] {
        let mut output = [[0.0; 1_024]; 2];
        let start = i128::from(frame_index) - 512;
        for offset in 0..1_024usize {
            let source = start + offset as i128;
            let Some(frame) = u64::try_from(source)
                .ok()
                .and_then(|index| self.frame(index))
            else {
                continue;
            };
            output[0][offset] = frame[0];
            output[1][offset] = frame[1];
        }
        output
    }
}

fn finite(value: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

/// Snapshot attached to every seek inference job.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StemSeekRequest {
    pub generation: u64,
    pub frame_index: u64,
}

/// Latest-request-wins control for one physical Deck.
///
/// Writers store the target before publishing a new generation. A worker snapshots the generation
/// on dequeue and checks [`is_current`](Self::is_current) before publishing any result. An old GPU
/// launch may finish, but it can never enter the new Deck ring.
#[derive(Debug, Default)]
pub struct DeckStemSeekControl {
    generation: AtomicU64,
    frame_index: AtomicU64,
}

impl DeckStemSeekControl {
    pub fn request(&self, frame_index: u64) -> StemSeekRequest {
        // Odd generations are an in-progress seqlock write; even generations are publishable.
        let generation = loop {
            let current = self.generation.load(Ordering::Acquire);
            if current & 1 != 0 {
                std::hint::spin_loop();
                continue;
            }
            if self
                .generation
                .compare_exchange(
                    current,
                    current.wrapping_add(1),
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                break current.wrapping_add(2);
            }
        };
        self.frame_index.store(frame_index, Ordering::Release);
        self.generation.store(generation, Ordering::Release);
        StemSeekRequest {
            generation,
            frame_index,
        }
    }

    pub fn latest(&self) -> StemSeekRequest {
        loop {
            let generation = self.generation.load(Ordering::Acquire);
            if generation & 1 != 0 {
                std::hint::spin_loop();
                continue;
            }
            let frame_index = self.frame_index.load(Ordering::Acquire);
            if generation == self.generation.load(Ordering::Acquire) {
                return StemSeekRequest {
                    generation,
                    frame_index,
                };
            }
        }
    }

    pub fn is_current(&self, request: StemSeekRequest) -> bool {
        self.generation.load(Ordering::Acquire) == request.generation
    }
}

/// Independent transport invalidation for Deck A and Deck B. Model weights may be shared, but
/// these controls, separator state, and the input/output rings must remain per Deck.
#[derive(Clone, Debug)]
pub struct DualDeckStemSeekControl {
    decks: [Arc<DeckStemSeekControl>; 2],
}

impl Default for DualDeckStemSeekControl {
    fn default() -> Self {
        Self {
            decks: std::array::from_fn(|_| Arc::new(DeckStemSeekControl::default())),
        }
    }
}

impl DualDeckStemSeekControl {
    pub fn deck(&self, deck: usize) -> Option<&Arc<DeckStemSeekControl>> {
        self.decks.get(deck)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rt3s_window_is_random_access_and_zero_pads_song_edges() {
        let cache = PcmRandomAccessCache::from_interleaved(
            (0..2_000)
                .map(|frame| [frame as f32, -(frame as f32)])
                .collect(),
        );

        let at_start = cache.rt3s_window(0);
        assert_eq!(at_start[0][0], 0.0);
        assert_eq!(at_start[0][511], 0.0);
        assert_eq!(at_start[0][512], 0.0);
        assert_eq!(at_start[0][1_023], 511.0);

        let interior = cache.rt3s_window(1_000);
        assert_eq!(interior[0][0], 488.0);
        assert_eq!(interior[0][512], 1_000.0);
        assert_eq!(interior[1][1_023], -1_511.0);
    }

    #[test]
    fn only_the_latest_hot_cue_request_can_publish() {
        let control = DeckStemSeekControl::default();
        let old = control.request(44_100 * 30);
        let latest = control.request(44_100 * 4);

        assert!(!control.is_current(old));
        assert!(control.is_current(latest));
        assert_eq!(control.latest(), latest);
    }

    #[test]
    fn physical_decks_have_independent_generations() {
        let controls = DualDeckStemSeekControl::default();
        let deck_a = controls.deck(0).unwrap().request(512);
        let deck_b = controls.deck(1).unwrap().request(4_096);
        let newer_a = controls.deck(0).unwrap().request(1_024);

        assert!(!controls.deck(0).unwrap().is_current(deck_a));
        assert!(controls.deck(0).unwrap().is_current(newer_a));
        assert!(controls.deck(1).unwrap().is_current(deck_b));
    }

    #[test]
    fn non_finite_pcm_is_sanitized_before_inference() {
        let cache = PcmRandomAccessCache::from_planar(&[f32::NAN], &[f32::INFINITY]);
        assert_eq!(cache.frame(0), Some([0.0, 0.0]));
    }
}
