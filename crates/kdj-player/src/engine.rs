use std::fmt;
use std::sync::Arc;

use rtrb::{Consumer, Producer, RingBuffer};

use crate::dsp::DeckEq;
use crate::state::{SharedState, SharedTransportState};
use crate::{DeckId, DecodedTrack, PlayerMode, RtCommand, TransportSnapshot};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandError {
    Full,
}

impl fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("realtime command queue is full")
    }
}

impl std::error::Error for CommandError {}

/// Single-producer control handle. It is intentionally not `Clone`: a second producer would
/// violate the realtime queue's ownership contract.
pub struct PlayerController {
    producer: Producer<RtCommand>,
    shared: SharedTransportState,
}

impl PlayerController {
    pub fn send(&mut self, command: RtCommand) -> Result<(), CommandError> {
        self.producer.push(command).map_err(|_| CommandError::Full)
    }

    pub fn snapshot(&self) -> TransportSnapshot {
        self.shared.snapshot()
    }
}

#[derive(Clone, Copy, Debug)]
struct Transition {
    from: DeckId,
    to: DeckId,
    total_frames: u32,
    elapsed_frames: u32,
}

/// State owned exclusively by the platform audio callback.
pub struct AudioRenderer {
    consumer: Consumer<RtCommand>,
    shared: SharedTransportState,
    mode: PlayerMode,
    playing: bool,
    active_deck: DeckId,
    output_frames: u64,
    deck_positions: [f64; 2],
    deck_gains: [f32; 2],
    deck_rates: [f64; 2],
    source_rate_ratios: [f64; 2],
    output_sample_rate: u32,
    deck_eq: [DeckEq; 2],
    master_gain: f32,
    transition: Option<Transition>,
}

/// Creates the bounded control/audio halves. Capacity is fixed for the lifetime of the player.
pub fn command_channel(capacity: usize) -> (PlayerController, AudioRenderer) {
    assert!(capacity > 0, "command queue capacity must be non-zero");
    let (producer, consumer) = RingBuffer::new(capacity);
    let shared = Arc::new(SharedState::default());
    (
        PlayerController {
            producer,
            shared: Arc::clone(&shared),
        },
        AudioRenderer {
            consumer,
            shared,
            mode: PlayerMode::Continuous,
            playing: false,
            active_deck: DeckId::A,
            output_frames: 0,
            deck_positions: [0.0; 2],
            deck_gains: [1.0; 2],
            deck_rates: [1.0; 2],
            source_rate_ratios: [1.0; 2],
            output_sample_rate: 48_000,
            deck_eq: [DeckEq::default(); 2],
            master_gain: 1.0,
            transition: None,
        },
    )
}

impl AudioRenderer {
    /// Mixes one interleaved output block without allocating or taking a lock.
    ///
    /// Inputs must already be decoded, resampled and aligned to each deck's prepared cursor.
    /// Missing samples are treated as silence. Commands are applied before the first frame.
    pub fn render(&mut self, deck_a: &[f32], deck_b: &[f32], output: &mut [f32], channels: usize) {
        assert!(channels > 0, "channel count must be non-zero");
        assert_eq!(output.len() % channels, 0, "partial output frame");
        self.ensure_eq_sample_rate();
        self.drain_commands();

        let frame_count = output.len() / channels;
        for frame in 0..frame_count {
            let (transition_a, transition_b) = self.transition_gains();
            let index = frame * channels;
            let input_a = [
                deck_a.get(index).copied().unwrap_or(0.0),
                deck_a
                    .get(index + usize::from(channels > 1))
                    .copied()
                    .unwrap_or(0.0),
            ];
            let input_b = [
                deck_b.get(index).copied().unwrap_or(0.0),
                deck_b
                    .get(index + usize::from(channels > 1))
                    .copied()
                    .unwrap_or(0.0),
            ];
            let (a, b) = if self.playing {
                (
                    self.deck_eq[0].process_stereo(input_a),
                    self.deck_eq[1].process_stereo(input_b),
                )
            } else {
                ([0.0; 2], [0.0; 2])
            };
            for channel in 0..channels {
                output[index + channel] = if self.playing {
                    let side = channel.min(1);
                    (a[side] * self.deck_gains[0] * transition_a
                        + b[side] * self.deck_gains[1] * transition_b)
                        * self.master_gain
                } else {
                    0.0
                };
            }
            self.advance_frame();
        }
        self.publish();
    }

    /// Renders directly from two immutable predecoded tracks. Random seeks only change a frame
    /// index, so the callback never asks a compressed decoder to rebuild buffers.
    pub fn render_tracks(
        &mut self,
        deck_a: &DecodedTrack,
        deck_b: &DecodedTrack,
        output: &mut [f32],
        output_sample_rate: u32,
        output_channels: usize,
    ) {
        assert!(
            output_sample_rate > 0,
            "output sample rate must be non-zero"
        );
        assert!(output_channels > 0, "channel count must be non-zero");
        assert_eq!(output.len() % output_channels, 0, "partial output frame");
        self.output_sample_rate = output_sample_rate;
        self.source_rate_ratios = [
            f64::from(deck_a.sample_rate()) / f64::from(output_sample_rate),
            f64::from(deck_b.sample_rate()) / f64::from(output_sample_rate),
        ];
        self.ensure_eq_sample_rate();
        self.drain_commands();

        for frame in output.chunks_mut(output_channels) {
            let (transition_a, transition_b) = self.transition_gains();
            let (a, b) = if self.playing {
                (
                    self.deck_eq[0].process_stereo([
                        track_sample(deck_a, self.deck_positions[0], 0),
                        track_sample(deck_a, self.deck_positions[0], 1),
                    ]),
                    self.deck_eq[1].process_stereo([
                        track_sample(deck_b, self.deck_positions[1], 0),
                        track_sample(deck_b, self.deck_positions[1], 1),
                    ]),
                )
            } else {
                ([0.0; 2], [0.0; 2])
            };
            for (channel, sample) in frame.iter_mut().enumerate() {
                *sample = if self.playing {
                    let side = channel.min(1);
                    (a[side] * self.deck_gains[0] * transition_a
                        + b[side] * self.deck_gains[1] * transition_b)
                        * self.master_gain
                } else {
                    0.0
                };
            }
            self.advance_frame();
        }
        self.publish();
    }

    fn drain_commands(&mut self) {
        while let Ok(command) = self.consumer.pop() {
            self.apply(command);
        }
    }

    fn apply(&mut self, command: RtCommand) {
        match command {
            RtCommand::SetMode(mode) => self.mode = mode,
            RtCommand::SetPlaying(playing) => self.playing = playing,
            RtCommand::SetMasterGain(gain) => self.master_gain = normalized_gain(gain),
            RtCommand::SetDeckGain { deck, gain } => {
                self.deck_gains[deck as usize] = normalized_gain(gain);
            }
            RtCommand::SetRate { deck, rate } => {
                if rate.is_finite() && rate > 0.0 {
                    self.deck_rates[deck as usize] = f64::from(rate);
                }
            }
            RtCommand::SetEq {
                deck,
                low_db,
                high_db,
            } => self.deck_eq[deck as usize].configure(self.output_sample_rate, low_db, high_db),
            RtCommand::SeekPrepared { deck, frame } => {
                self.deck_positions[deck as usize] = frame as f64;
                self.deck_eq[deck as usize].reset();
                if deck == self.active_deck {
                    self.transition = None;
                }
            }
            RtCommand::HandoffPrepared {
                to,
                target_frame,
                transition_frames,
            } => {
                self.deck_positions[to as usize] = target_frame as f64;
                self.deck_eq[to as usize].reset();
                if to == self.active_deck || transition_frames == 0 {
                    self.active_deck = to;
                    self.transition = None;
                } else {
                    self.transition = Some(Transition {
                        from: self.active_deck,
                        to,
                        total_frames: transition_frames,
                        elapsed_frames: 0,
                    });
                }
            }
        }
    }

    fn ensure_eq_sample_rate(&mut self) {
        for eq in &mut self.deck_eq {
            eq.ensure_sample_rate(self.output_sample_rate);
        }
    }

    fn transition_gains(&self) -> (f32, f32) {
        let Some(transition) = self.transition else {
            return match self.active_deck {
                DeckId::A => (1.0, 0.0),
                DeckId::B => (0.0, 1.0),
            };
        };
        let progress = (transition.elapsed_frames + 1) as f32 / transition.total_frames as f32;
        // Equal-power crossfade keeps perceived loudness stable around the midpoint; a linear
        // 0.5 + 0.5 handoff audibly dips when the decks are not phase-correlated.
        let outgoing = (progress * std::f32::consts::FRAC_PI_2).cos();
        let incoming = (progress * std::f32::consts::FRAC_PI_2).sin();
        match (transition.from, transition.to) {
            (DeckId::A, DeckId::B) => (outgoing, incoming),
            (DeckId::B, DeckId::A) => (incoming, outgoing),
            _ => unreachable!("handoff always changes decks"),
        }
    }

    fn advance_frame(&mut self) {
        self.output_frames = self.output_frames.saturating_add(1);
        if self.playing {
            if let Some(transition) = self.transition {
                self.deck_positions[transition.from as usize] += self.deck_rates
                    [transition.from as usize]
                    * self.source_rate_ratios[transition.from as usize];
                self.deck_positions[transition.to as usize] += self.deck_rates
                    [transition.to as usize]
                    * self.source_rate_ratios[transition.to as usize];
            } else {
                self.deck_positions[self.active_deck as usize] += self.deck_rates
                    [self.active_deck as usize]
                    * self.source_rate_ratios[self.active_deck as usize];
            }
        }

        if self.playing {
            if let Some(mut transition) = self.transition {
                transition.elapsed_frames += 1;
                if transition.elapsed_frames >= transition.total_frames {
                    self.active_deck = transition.to;
                    self.transition = None;
                } else {
                    self.transition = Some(transition);
                }
            }
        }
    }

    fn publish(&self) {
        self.shared.publish(
            self.mode,
            self.playing,
            self.active_deck,
            self.output_frames,
            [self.deck_positions[0] as u64, self.deck_positions[1] as u64],
        );
    }
}

fn track_sample(track: &DecodedTrack, position: f64, channel: usize) -> f32 {
    if !position.is_finite() || position < 0.0 {
        return 0.0;
    }
    let base = position.floor() as usize;
    let fraction = (position - base as f64) as f32;
    let samples = track.interleaved();
    let index = base.saturating_mul(2).saturating_add(channel);
    let current = samples.get(index).copied().unwrap_or(0.0);
    let next = samples.get(index + 2).copied().unwrap_or(current);
    current + (next - current) * fraction
}

fn normalized_gain(gain: f32) -> f32 {
    if gain.is_finite() {
        gain.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_is_silent_and_does_not_advance_deck_clock() {
        let (controller, mut renderer) = command_channel(4);
        let mut output = [9.0; 4];
        renderer.render(&[1.0; 4], &[1.0; 4], &mut output, 2);
        assert_eq!(output, [0.0; 4]);
        assert_eq!(controller.snapshot().output_frames, 2);
        assert_eq!(controller.snapshot().deck_frames, [0, 0]);
    }

    #[test]
    fn prepared_handoff_is_sample_clocked_without_a_silent_frame() {
        let (mut controller, mut renderer) = command_channel(4);
        controller.send(RtCommand::SetPlaying(true)).unwrap();
        controller
            .send(RtCommand::HandoffPrepared {
                to: DeckId::B,
                target_frame: 8_000,
                transition_frames: 4,
            })
            .unwrap();

        let mut output = [0.0; 4];
        renderer.render(&[1.0; 4], &[-1.0; 4], &mut output, 1);
        let expected = [0.541_196, 0.0, -0.541_196, -1.0];
        for (actual, expected) in output.into_iter().zip(expected) {
            assert!((actual - expected).abs() < 0.000_01);
        }
        let snapshot = controller.snapshot();
        assert_eq!(snapshot.active_deck, DeckId::B);
        assert_eq!(snapshot.deck_frames, [4, 8_004]);
    }

    #[test]
    fn repeated_scrub_updates_coalesce_before_the_next_audio_frame() {
        let (mut controller, mut renderer) = command_channel(8);
        controller.send(RtCommand::SetPlaying(true)).unwrap();
        for frame in [1_000, 5_000, 9_000] {
            controller
                .send(RtCommand::SeekPrepared {
                    deck: DeckId::A,
                    frame,
                })
                .unwrap();
        }
        let mut output = [0.0; 1];
        renderer.render(&[1.0], &[], &mut output, 1);
        assert_eq!(controller.snapshot().deck_frames[0], 9_001);
    }

    #[test]
    fn seek_and_gain_apply_before_first_output_frame() {
        let (mut controller, mut renderer) = command_channel(8);
        controller.send(RtCommand::SetPlaying(true)).unwrap();
        controller
            .send(RtCommand::SeekPrepared {
                deck: DeckId::A,
                frame: 48_000,
            })
            .unwrap();
        controller.send(RtCommand::SetMasterGain(0.25)).unwrap();
        let mut output = [0.0; 2];
        renderer.render(&[1.0; 2], &[], &mut output, 1);
        assert_eq!(output, [0.25, 0.25]);
        assert_eq!(controller.snapshot().deck_frames[0], 48_002);
    }

    #[test]
    fn realtime_commands_are_fixed_size_and_need_no_drop() {
        assert!(!std::mem::needs_drop::<RtCommand>());
        assert!(std::mem::size_of::<RtCommand>() <= 24);
    }

    #[test]
    fn bounded_queue_reports_backpressure() {
        let (mut controller, _renderer) = command_channel(1);
        controller.send(RtCommand::SetPlaying(true)).unwrap();
        assert_eq!(
            controller.send(RtCommand::SetPlaying(false)),
            Err(CommandError::Full)
        );
    }
}
