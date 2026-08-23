use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

use crate::{DeckId, PlayerMode, EQ_SPECTRUM_BANDS};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
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
    /// Post-EQ, pre-channel-fader peak level for live mixer meters (linear full scale).
    pub deck_peak_levels: [f32; 2],
    /// Fixed narrow-band post-EQ levels for each Deck, in linear full scale.
    pub deck_spectrum_levels: [[f32; EQ_SPECTRUM_BANDS]; 2],
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
    deck_a_peak_level: AtomicU32,
    deck_b_peak_level: AtomicU32,
    deck_spectrum_levels: [[AtomicU32; EQ_SPECTRUM_BANDS]; 2],
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
            deck_a_peak_level: AtomicU32::new(0),
            deck_b_peak_level: AtomicU32::new(0),
            deck_spectrum_levels: std::array::from_fn(|_| {
                std::array::from_fn(|_| AtomicU32::new(0))
            }),
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
        deck_peak_levels: [f32; 2],
        deck_spectrum_levels: [[f32; EQ_SPECTRUM_BANDS]; 2],
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
        self.deck_a_peak_level
            .store(deck_peak_levels[0].max(0.0).to_bits(), Ordering::Relaxed);
        self.deck_b_peak_level
            .store(deck_peak_levels[1].max(0.0).to_bits(), Ordering::Relaxed);
        for (target_deck, source_deck) in self.deck_spectrum_levels.iter().zip(deck_spectrum_levels)
        {
            for (target, source) in target_deck.iter().zip(source_deck) {
                target.store(source.max(0.0).to_bits(), Ordering::Relaxed);
            }
        }
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub(crate) fn snapshot(&self) -> TransportSnapshot {
        // 正常情况下重试几次就能读到一致快照。但音频回调线程若在 publish
        // 中途被系统杀死（拔设备/驱动复位/休眠唤醒），generation 会永远停在
        // 奇数——无界自旋会把控制线程整体卡死，表现为无法切歌、退出挂起。
        // 字段各自都是独立的原子读，重试耗尽后兜底返回“可能拼接了两次
        // 回调”的快照，对走带显示无害；绝不能为了一致性永远等下去。
        const MAX_ATTEMPTS: usize = 64;
        let mut last = TransportSnapshot::default();
        for _ in 0..MAX_ATTEMPTS {
            let before = self.generation.load(Ordering::Acquire);
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
                deck_peak_levels: [
                    f32::from_bits(self.deck_a_peak_level.load(Ordering::Relaxed)),
                    f32::from_bits(self.deck_b_peak_level.load(Ordering::Relaxed)),
                ],
                deck_spectrum_levels: std::array::from_fn(|deck| {
                    std::array::from_fn(|band| {
                        f32::from_bits(
                            self.deck_spectrum_levels[deck][band].load(Ordering::Relaxed),
                        )
                    })
                }),
            };
            if before & 1 == 0 && before == self.generation.load(Ordering::Acquire) {
                return snapshot;
            }
            last = snapshot;
            std::hint::spin_loop();
        }
        last
    }
}

pub(crate) type SharedTransportState = Arc<SharedState>;

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：音频回调死在 publish 中间时 generation 永远停在奇数，
    /// 快照读取必须有限次重试后返回，而不是把控制线程卡死。
    #[test]
    fn snapshot_returns_when_writer_died_mid_publish() {
        let state = SharedState::default();
        state.publish(
            PlayerMode::Continuous,
            true,
            DeckId::A,
            None,
            480,
            [240, 120],
            [7, 9],
        );
        // 模拟回调线程在两次 fetch_add 之间被杀：generation 手动拨成奇数。
        state.generation.store(1, Ordering::Release);

        // 若退化回无界自旋，这个调用永不结束，测试整体超时。
        let snapshot = state.snapshot();
        // 兜底路径也要读到中断那次 publish 已写入的字段，而不是全默认值。
        assert!(snapshot.playing);
        assert_eq!(snapshot.output_frames, 480);
        assert_eq!(snapshot.deck_source_ids, [7, 9]);
    }
}
