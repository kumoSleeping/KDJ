use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

use crate::{DeckId, PlayerMode};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TransportSnapshot {
    pub mode: PlayerMode,
    pub playing: bool,
    pub deck_playing: [bool; 2],
    pub active_deck: DeckId,
    pub transitioning: bool,
    pub transition_to: DeckId,
    pub output_frames: u64,
    pub deck_frames: [u64; 2],
    pub deck_source_ids: [u64; 2],
    /// Callback-observed output-ring starvation transitions for the currently installed source.
    pub deck_output_underruns: [u64; 2],
    /// Lowest callback-boundary output-ring fill for the current source; zero means unobserved.
    pub deck_min_buffered_frames: [u64; 2],
}

pub(crate) struct SharedState {
    generation: AtomicU64,
    mode: AtomicU8,
    playing: AtomicBool,
    deck_a_playing: AtomicBool,
    deck_b_playing: AtomicBool,
    active_deck: AtomicU8,
    transitioning: AtomicBool,
    transition_to: AtomicU8,
    output_frames: AtomicU64,
    deck_a_frame: AtomicU64,
    deck_b_frame: AtomicU64,
    deck_a_source: AtomicU64,
    deck_b_source: AtomicU64,
    deck_a_output_underruns: AtomicU64,
    deck_b_output_underruns: AtomicU64,
    deck_a_min_buffered_frames: AtomicU64,
    deck_b_min_buffered_frames: AtomicU64,
}

impl Default for SharedState {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(0),
            mode: AtomicU8::new(PlayerMode::Continuous as u8),
            playing: AtomicBool::new(false),
            deck_a_playing: AtomicBool::new(false),
            deck_b_playing: AtomicBool::new(false),
            active_deck: AtomicU8::new(DeckId::A as u8),
            transitioning: AtomicBool::new(false),
            transition_to: AtomicU8::new(DeckId::A as u8),
            output_frames: AtomicU64::new(0),
            deck_a_frame: AtomicU64::new(0),
            deck_b_frame: AtomicU64::new(0),
            deck_a_source: AtomicU64::new(0),
            deck_b_source: AtomicU64::new(0),
            deck_a_output_underruns: AtomicU64::new(0),
            deck_b_output_underruns: AtomicU64::new(0),
            deck_a_min_buffered_frames: AtomicU64::new(0),
            deck_b_min_buffered_frames: AtomicU64::new(0),
        }
    }
}

impl SharedState {
    pub(crate) fn publish(
        &self,
        mode: PlayerMode,
        playing: bool,
        deck_playing: [bool; 2],
        active_deck: DeckId,
        transition_to: Option<DeckId>,
        output_frames: u64,
        deck_frames: [u64; 2],
        deck_source_ids: [u64; 2],
        deck_output_underruns: [u64; 2],
        deck_min_buffered_frames: [u64; 2],
    ) {
        // A seqlock prevents control readers from combining fields from two callbacks.
        // The audio thread still never takes a lock or waits for another thread.
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.mode.store(mode as u8, Ordering::Relaxed);
        self.playing.store(playing, Ordering::Relaxed);
        self.deck_a_playing
            .store(deck_playing[0], Ordering::Relaxed);
        self.deck_b_playing
            .store(deck_playing[1], Ordering::Relaxed);
        self.active_deck.store(active_deck as u8, Ordering::Relaxed);
        self.transitioning
            .store(transition_to.is_some(), Ordering::Relaxed);
        self.transition_to.store(
            transition_to.unwrap_or(active_deck) as u8,
            Ordering::Relaxed,
        );
        self.output_frames.store(output_frames, Ordering::Relaxed);
        self.deck_a_frame.store(deck_frames[0], Ordering::Relaxed);
        self.deck_b_frame.store(deck_frames[1], Ordering::Relaxed);
        self.deck_a_source
            .store(deck_source_ids[0], Ordering::Relaxed);
        self.deck_b_source
            .store(deck_source_ids[1], Ordering::Relaxed);
        self.deck_a_output_underruns
            .store(deck_output_underruns[0], Ordering::Relaxed);
        self.deck_b_output_underruns
            .store(deck_output_underruns[1], Ordering::Relaxed);
        self.deck_a_min_buffered_frames
            .store(deck_min_buffered_frames[0], Ordering::Relaxed);
        self.deck_b_min_buffered_frames
            .store(deck_min_buffered_frames[1], Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub(crate) fn snapshot(&self) -> TransportSnapshot {
        loop {
            let before = self.generation.load(Ordering::Acquire);
            if before & 1 == 1 {
                std::hint::spin_loop();
                continue;
            }
            let snapshot = TransportSnapshot {
                mode: match self.mode.load(Ordering::Relaxed) {
                    1 => PlayerMode::RealtimeDj,
                    _ => PlayerMode::Continuous,
                },
                playing: self.playing.load(Ordering::Relaxed),
                deck_playing: [
                    self.deck_a_playing.load(Ordering::Relaxed),
                    self.deck_b_playing.load(Ordering::Relaxed),
                ],
                active_deck: match self.active_deck.load(Ordering::Relaxed) {
                    1 => DeckId::B,
                    _ => DeckId::A,
                },
                transitioning: self.transitioning.load(Ordering::Relaxed),
                transition_to: match self.transition_to.load(Ordering::Relaxed) {
                    1 => DeckId::B,
                    _ => DeckId::A,
                },
                output_frames: self.output_frames.load(Ordering::Relaxed),
                deck_frames: [
                    self.deck_a_frame.load(Ordering::Relaxed),
                    self.deck_b_frame.load(Ordering::Relaxed),
                ],
                deck_source_ids: [
                    self.deck_a_source.load(Ordering::Relaxed),
                    self.deck_b_source.load(Ordering::Relaxed),
                ],
                deck_output_underruns: [
                    self.deck_a_output_underruns.load(Ordering::Relaxed),
                    self.deck_b_output_underruns.load(Ordering::Relaxed),
                ],
                deck_min_buffered_frames: [
                    self.deck_a_min_buffered_frames.load(Ordering::Relaxed),
                    self.deck_b_min_buffered_frames.load(Ordering::Relaxed),
                ],
            };
            if before == self.generation.load(Ordering::Acquire) {
                return snapshot;
            }
        }
    }
}

pub(crate) type SharedTransportState = Arc<SharedState>;
