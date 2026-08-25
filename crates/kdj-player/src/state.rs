use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

use crate::{DeckId, PlayerMode, EQ_SPECTRUM_BANDS};

/// CPAL stream-clock timing for one output callback. Values are nanoseconds from a stable origin
/// chosen when the stream starts; only differences are meaningful outside the audio backend.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct OutputCallbackTiming {
    pub callback_time_ns: u64,
    /// Predicted DAC time of the first frame in the callback buffer.
    pub playback_time_ns: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TransportSnapshot {
    pub mode: PlayerMode,
    pub playing: bool,
    pub deck_playing: [bool; 2],
    pub active_deck: DeckId,
    pub transitioning: bool,
    pub transition_to: DeckId,
    pub output_frames: u64,
    pub output_sample_rate: u32,
    pub callback_time_ns: u64,
    /// Predicted DAC time of the media positions in this snapshot (end of the rendered buffer).
    pub presentation_time_ns: u64,
    /// Signed media clocks; negative frames are silent Performance pre-roll before source frame 0.
    pub deck_frames: [i64; 2],
    pub deck_source_ids: [u64; 2],
    pub deck_target_rates: [f32; 2],
    pub deck_audible_rates: [f32; 2],
    pub deck_rate_revisions: [u64; 2],
    pub deck_audible_rate_revisions: [u64; 2],
    pub deck_discontinuity_revisions: [u64; 2],
    pub deck_scratch_held: [bool; 2],
    /// Internal cached/coasting voice ownership. This may outlive public physical platter motion.
    pub deck_scratch_voice_active: [bool; 2],
    /// Loop generation and window that have actually reached the DAC-facing callback.
    pub deck_loop_generations: [u64; 2],
    pub deck_loop_active: [bool; 2],
    pub deck_loop_start_frames: [u64; 2],
    pub deck_loop_length_frames: [u64; 2],
    pub deck_loop_wrap_counts: [u64; 2],
    pub deck_loop_stall_frames: [u64; 2],
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
    output_sample_rate: AtomicU32,
    callback_time_ns: AtomicU64,
    presentation_time_ns: AtomicU64,
    deck_a_frame: AtomicU64,
    deck_b_frame: AtomicU64,
    deck_a_source: AtomicU64,
    deck_b_source: AtomicU64,
    deck_target_rates: [AtomicU32; 2],
    deck_audible_rates: [AtomicU32; 2],
    deck_rate_revisions: [AtomicU64; 2],
    deck_audible_rate_revisions: [AtomicU64; 2],
    deck_discontinuity_revisions: [AtomicU64; 2],
    deck_scratch_held: [AtomicBool; 2],
    deck_scratch_voice_active: [AtomicBool; 2],
    deck_loop_generations: [AtomicU64; 2],
    deck_loop_active: [AtomicBool; 2],
    deck_loop_start_frames: [AtomicU64; 2],
    deck_loop_length_frames: [AtomicU64; 2],
    deck_loop_wrap_counts: [AtomicU64; 2],
    deck_loop_stall_frames: [AtomicU64; 2],
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
            output_sample_rate: AtomicU32::new(0),
            callback_time_ns: AtomicU64::new(0),
            presentation_time_ns: AtomicU64::new(0),
            deck_a_frame: AtomicU64::new(0),
            deck_b_frame: AtomicU64::new(0),
            deck_a_source: AtomicU64::new(0),
            deck_b_source: AtomicU64::new(0),
            deck_target_rates: std::array::from_fn(|_| AtomicU32::new(1.0f32.to_bits())),
            deck_audible_rates: std::array::from_fn(|_| AtomicU32::new(1.0f32.to_bits())),
            deck_rate_revisions: std::array::from_fn(|_| AtomicU64::new(0)),
            deck_audible_rate_revisions: std::array::from_fn(|_| AtomicU64::new(0)),
            deck_discontinuity_revisions: std::array::from_fn(|_| AtomicU64::new(0)),
            deck_scratch_held: std::array::from_fn(|_| AtomicBool::new(false)),
            deck_scratch_voice_active: std::array::from_fn(|_| AtomicBool::new(false)),
            deck_loop_generations: std::array::from_fn(|_| AtomicU64::new(0)),
            deck_loop_active: std::array::from_fn(|_| AtomicBool::new(false)),
            deck_loop_start_frames: std::array::from_fn(|_| AtomicU64::new(0)),
            deck_loop_length_frames: std::array::from_fn(|_| AtomicU64::new(0)),
            deck_loop_wrap_counts: std::array::from_fn(|_| AtomicU64::new(0)),
            deck_loop_stall_frames: std::array::from_fn(|_| AtomicU64::new(0)),
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
        output_sample_rate: u32,
        callback_time_ns: u64,
        presentation_time_ns: u64,
        deck_frames: [i64; 2],
        deck_source_ids: [u64; 2],
        deck_target_rates: [f32; 2],
        deck_audible_rates: [f32; 2],
        deck_rate_revisions: [u64; 2],
        deck_audible_rate_revisions: [u64; 2],
        deck_discontinuity_revisions: [u64; 2],
        deck_scratch_held: [bool; 2],
        deck_scratch_voice_active: [bool; 2],
        deck_loop_generations: [u64; 2],
        deck_loop_active: [bool; 2],
        deck_loop_start_frames: [u64; 2],
        deck_loop_length_frames: [u64; 2],
        deck_loop_wrap_counts: [u64; 2],
        deck_loop_stall_frames: [u64; 2],
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
        self.output_sample_rate
            .store(output_sample_rate, Ordering::Relaxed);
        self.callback_time_ns
            .store(callback_time_ns, Ordering::Relaxed);
        self.presentation_time_ns
            .store(presentation_time_ns, Ordering::Relaxed);
        self.deck_a_frame
            .store(deck_frames[0] as u64, Ordering::Relaxed);
        self.deck_b_frame
            .store(deck_frames[1] as u64, Ordering::Relaxed);
        self.deck_a_source
            .store(deck_source_ids[0], Ordering::Relaxed);
        self.deck_b_source
            .store(deck_source_ids[1], Ordering::Relaxed);
        for index in 0..2 {
            self.deck_target_rates[index]
                .store(deck_target_rates[index].to_bits(), Ordering::Relaxed);
            self.deck_audible_rates[index]
                .store(deck_audible_rates[index].to_bits(), Ordering::Relaxed);
            self.deck_rate_revisions[index].store(deck_rate_revisions[index], Ordering::Relaxed);
            self.deck_audible_rate_revisions[index]
                .store(deck_audible_rate_revisions[index], Ordering::Relaxed);
            self.deck_discontinuity_revisions[index]
                .store(deck_discontinuity_revisions[index], Ordering::Relaxed);
            self.deck_scratch_held[index].store(deck_scratch_held[index], Ordering::Relaxed);
            self.deck_scratch_voice_active[index]
                .store(deck_scratch_voice_active[index], Ordering::Relaxed);
            self.deck_loop_generations[index]
                .store(deck_loop_generations[index], Ordering::Relaxed);
            self.deck_loop_active[index].store(deck_loop_active[index], Ordering::Relaxed);
            self.deck_loop_start_frames[index]
                .store(deck_loop_start_frames[index], Ordering::Relaxed);
            self.deck_loop_length_frames[index]
                .store(deck_loop_length_frames[index], Ordering::Relaxed);
            self.deck_loop_wrap_counts[index]
                .store(deck_loop_wrap_counts[index], Ordering::Relaxed);
            self.deck_loop_stall_frames[index]
                .store(deck_loop_stall_frames[index], Ordering::Relaxed);
        }
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
                output_sample_rate: self.output_sample_rate.load(Ordering::Relaxed),
                callback_time_ns: self.callback_time_ns.load(Ordering::Relaxed),
                presentation_time_ns: self.presentation_time_ns.load(Ordering::Relaxed),
                deck_frames: [
                    self.deck_a_frame.load(Ordering::Relaxed) as i64,
                    self.deck_b_frame.load(Ordering::Relaxed) as i64,
                ],
                deck_source_ids: [
                    self.deck_a_source.load(Ordering::Relaxed),
                    self.deck_b_source.load(Ordering::Relaxed),
                ],
                deck_target_rates: std::array::from_fn(|index| {
                    f32::from_bits(self.deck_target_rates[index].load(Ordering::Relaxed))
                }),
                deck_audible_rates: std::array::from_fn(|index| {
                    f32::from_bits(self.deck_audible_rates[index].load(Ordering::Relaxed))
                }),
                deck_rate_revisions: std::array::from_fn(|index| {
                    self.deck_rate_revisions[index].load(Ordering::Relaxed)
                }),
                deck_audible_rate_revisions: std::array::from_fn(|index| {
                    self.deck_audible_rate_revisions[index].load(Ordering::Relaxed)
                }),
                deck_discontinuity_revisions: std::array::from_fn(|index| {
                    self.deck_discontinuity_revisions[index].load(Ordering::Relaxed)
                }),
                deck_scratch_held: std::array::from_fn(|index| {
                    self.deck_scratch_held[index].load(Ordering::Relaxed)
                }),
                deck_scratch_voice_active: std::array::from_fn(|index| {
                    self.deck_scratch_voice_active[index].load(Ordering::Relaxed)
                }),
                deck_loop_generations: std::array::from_fn(|index| {
                    self.deck_loop_generations[index].load(Ordering::Relaxed)
                }),
                deck_loop_active: std::array::from_fn(|index| {
                    self.deck_loop_active[index].load(Ordering::Relaxed)
                }),
                deck_loop_start_frames: std::array::from_fn(|index| {
                    self.deck_loop_start_frames[index].load(Ordering::Relaxed)
                }),
                deck_loop_length_frames: std::array::from_fn(|index| {
                    self.deck_loop_length_frames[index].load(Ordering::Relaxed)
                }),
                deck_loop_wrap_counts: std::array::from_fn(|index| {
                    self.deck_loop_wrap_counts[index].load(Ordering::Relaxed)
                }),
                deck_loop_stall_frames: std::array::from_fn(|index| {
                    self.deck_loop_stall_frames[index].load(Ordering::Relaxed)
                }),
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
            [true, false],
            DeckId::A,
            None,
            480,
            48_000,
            1_000_000,
            1_010_000,
            [240, 120],
            [7, 9],
            [1.0, 1.0],
            [1.0, 1.0],
            [1, 1],
            [1, 1],
            [0, 0],
            [false, false],
            [false, false],
            [0, 0],
            [false, false],
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
            [0.0, 0.0],
            [[0.0; EQ_SPECTRUM_BANDS]; 2],
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
