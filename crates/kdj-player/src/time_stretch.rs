//! Streaming, pitch-preserving tempo conversion backed by Rubber Band R3.
//!
//! Rubber Band always runs on the preparation worker. The platform audio callback only consumes
//! already-rendered PCM from a bounded ring and therefore never enters C++, allocates, locks, or
//! blocks on the time-stretch engine.

use std::collections::VecDeque;
use std::ffi::c_void;
use std::marker::PhantomData;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use anyhow::{bail, Result};

/// The public performance control and DSP both use this deliberately bounded interval.
pub const MIN_TEMPO_RATE: f32 = 0.5;
pub const MAX_TEMPO_RATE: f32 = 2.0;

/// Rubber Band's R3 real-time engine is fed bounded blocks so its internal real-time path never
/// has to resize. This is preparation-worker state, not a hardware callback block size.
const MAX_PROCESS_FRAMES: usize = 4_096;
const RETRIEVE_FRAMES: usize = 4_096;
/// Below this, Rubber Band R3 is an identity with hop-rate phase artifacts. Pass PCM through.
const UNITY_RATE_EPSILON: f32 = 0.0005;

const OPTION_PROCESS_REAL_TIME: i32 = 0x0000_0001;
const OPTION_CHANNELS_TOGETHER: i32 = 0x1000_0000;
const OPTION_ENGINE_FINER: i32 = 0x2000_0000;
const RUBBER_BAND_OPTIONS: i32 =
    OPTION_PROCESS_REAL_TIME | OPTION_CHANNELS_TOGETHER | OPTION_ENGINE_FINER;

type RubberBandState = *mut c_void;

unsafe extern "C" {
    fn rubberband_new(
        sample_rate: u32,
        channels: u32,
        options: i32,
        initial_time_ratio: f64,
        initial_pitch_scale: f64,
    ) -> RubberBandState;
    fn rubberband_delete(state: RubberBandState);
    fn rubberband_reset(state: RubberBandState);
    fn rubberband_get_engine_version(state: RubberBandState) -> i32;
    fn rubberband_set_time_ratio(state: RubberBandState, ratio: f64);
    fn rubberband_get_preferred_start_pad(state: RubberBandState) -> u32;
    fn rubberband_get_start_delay(state: RubberBandState) -> u32;
    fn rubberband_set_max_process_size(state: RubberBandState, frames: u32);
    fn rubberband_get_samples_required(state: RubberBandState) -> u32;
    fn rubberband_process(
        state: RubberBandState,
        input: *const *const f32,
        frames: u32,
        final_block: i32,
    );
    fn rubberband_available(state: RubberBandState) -> i32;
    fn rubberband_retrieve(state: RubberBandState, output: *const *mut f32, frames: u32) -> u32;
}

/// A lock-free, latest-value Tempo target shared by the coordinator and stretch worker.
///
/// Slider and SYNC updates overwrite one atomic value rather than queuing obsolete intermediate
/// positions. Rubber Band observes it immediately before its next input block.
#[derive(Clone, Debug)]
pub struct TempoControl(Arc<AtomicU32>);

impl TempoControl {
    pub fn new(rate: f32) -> Self {
        let control = Self(Arc::new(AtomicU32::new(1.0f32.to_bits())));
        control.set(rate);
        control
    }

    pub fn set(&self, rate: f32) {
        self.0
            .store(normalize_rate(rate).to_bits(), Ordering::Release);
    }

    pub fn rate(&self) -> f32 {
        normalize_rate(f32::from_bits(self.0.load(Ordering::Acquire)))
    }

    pub fn is_unity(&self) -> bool {
        is_unity_rate(self.rate())
    }
}

fn is_unity_rate(rate: f32) -> bool {
    (rate - 1.0).abs() < UNITY_RATE_EPSILON
}

pub fn normalize_rate(rate: f32) -> f32 {
    if rate.is_finite() {
        rate.clamp(MIN_TEMPO_RATE, MAX_TEMPO_RATE)
    } else {
        1.0
    }
}

/// Maps one KDJ ring frame to Rubber Band's deinterleaved channel API.
///
/// Stereo uses two channels. [`crate::StemFrame`] uses all eight lane channels in one processor,
/// which keeps every stem and both sides phase-coherent under the same R3 analysis decisions.
pub trait TimeStretchFrame: Copy + Send + 'static {
    const CHANNELS: usize;

    fn push_planar(self, channels: &mut [Vec<f32>]);
    fn from_planar(channels: &[Vec<f32>], frame: usize) -> Self;
}

impl TimeStretchFrame for [f32; 2] {
    const CHANNELS: usize = 2;

    fn push_planar(self, channels: &mut [Vec<f32>]) {
        channels[0].push(finite(self[0]));
        channels[1].push(finite(self[1]));
    }

    fn from_planar(channels: &[Vec<f32>], frame: usize) -> Self {
        [channels[0][frame], channels[1][frame]]
    }
}

/// Incremental Rubber Band R3 processor owned by one preparation worker.
pub struct PitchPreservingStretcher<F: TimeStretchFrame> {
    state: NonNull<c_void>,
    control: TempoControl,
    input: Vec<Vec<f32>>,
    input_ptrs: Vec<*const f32>,
    output: Vec<Vec<f32>>,
    output_ptrs: Vec<*mut f32>,
    zeroes: Vec<f32>,
    zero_ptrs: Vec<*const f32>,
    next_required: usize,
    applied_rate: f32,
    remaining_start_delay: usize,
    expected_output_frames: f64,
    emitted_output_frames: usize,
    rate_spans: VecDeque<RateSpan>,
    finished: bool,
    marker: PhantomData<F>,
}

#[derive(Clone, Copy)]
struct RateSpan {
    output_frames: f64,
    rate: f32,
}

impl<F: TimeStretchFrame> PitchPreservingStretcher<F> {
    pub fn new(control: TempoControl, sample_rate: u32) -> Result<Self> {
        if sample_rate == 0 {
            bail!("Rubber Band sample rate must be non-zero");
        }
        if F::CHANNELS == 0 || F::CHANNELS > u32::MAX as usize {
            bail!("invalid Rubber Band channel count {}", F::CHANNELS);
        }

        let rate = control.rate();
        // SAFETY: the vendored C API returns one uniquely-owned state or null on failure.
        let state = unsafe {
            rubberband_new(
                sample_rate,
                F::CHANNELS as u32,
                RUBBER_BAND_OPTIONS,
                1.0 / f64::from(rate),
                1.0,
            )
        };
        let state =
            NonNull::new(state).ok_or_else(|| anyhow::anyhow!("Rubber Band init failed"))?;

        let mut processor = Self {
            state,
            control,
            input: (0..F::CHANNELS)
                .map(|_| Vec::with_capacity(MAX_PROCESS_FRAMES))
                .collect(),
            input_ptrs: vec![std::ptr::null(); F::CHANNELS],
            output: (0..F::CHANNELS)
                .map(|_| vec![0.0; RETRIEVE_FRAMES])
                .collect(),
            output_ptrs: vec![std::ptr::null_mut(); F::CHANNELS],
            zeroes: vec![0.0; MAX_PROCESS_FRAMES],
            zero_ptrs: vec![std::ptr::null(); F::CHANNELS],
            next_required: 1,
            applied_rate: rate,
            remaining_start_delay: 0,
            expected_output_frames: 0.0,
            emitted_output_frames: 0,
            rate_spans: VecDeque::new(),
            finished: false,
            marker: PhantomData,
        };
        for channel in 0..F::CHANNELS {
            processor.output_ptrs[channel] = processor.output[channel].as_mut_ptr();
            processor.zero_ptrs[channel] = processor.zeroes.as_ptr();
        }
        if is_unity_rate(rate) {
            processor.applied_rate = 1.0;
        } else {
            processor.configure_and_prime()?;
        }
        Ok(processor)
    }

    pub fn engine_version(&self) -> i32 {
        // SAFETY: `state` remains valid until Drop and is accessed only by this worker.
        unsafe { rubberband_get_engine_version(self.state.as_ptr()) }
    }

    /// Reset analysis history at a seek/loop discontinuity and reapply real-time alignment.
    pub fn reset(&mut self) -> Result<()> {
        for channel in &mut self.input {
            channel.clear();
        }
        self.expected_output_frames = 0.0;
        self.emitted_output_frames = 0;
        self.rate_spans.clear();
        self.finished = false;
        if is_unity_rate(self.control.rate()) {
            self.applied_rate = 1.0;
            self.remaining_start_delay = 0;
            self.next_required = 1;
            return Ok(());
        }
        // SAFETY: no concurrent calls are made for this worker-owned state.
        unsafe { rubberband_reset(self.state.as_ptr()) };
        self.configure_and_prime()
    }

    /// Feed one hardware-rate source frame. Newly available output is delivered before return.
    pub fn push<S>(&mut self, frame: F, mut sink: S) -> Result<()>
    where
        S: FnMut(F, f32) -> Result<()>,
    {
        if self.finished {
            return Ok(());
        }
        let rate = self.control.rate();
        if is_unity_rate(rate) {
            if !is_unity_rate(self.applied_rate) {
                self.reset()?;
            }
            self.applied_rate = 1.0;
            sink(frame, 1.0)?;
            return Ok(());
        }
        if is_unity_rate(self.applied_rate) {
            self.reset()?;
        }
        frame.push_planar(&mut self.input);
        if self.input_len() >= self.next_required {
            self.process_input(false)?;
            self.drain_output(None, &mut sink)?;
            self.refresh_required();
        }
        Ok(())
    }

    /// Mark EOF, drain Rubber Band, and trim real-time mode's rounded final padding.
    pub fn finish<S>(&mut self, mut sink: S) -> Result<()>
    where
        S: FnMut(F, f32) -> Result<()>,
    {
        if self.finished {
            return Ok(());
        }
        if is_unity_rate(self.applied_rate) && self.input_len() == 0 {
            self.finished = true;
            return Ok(());
        }
        self.process_input(true)?;
        let target_frames = self.expected_output_frames.round().max(0.0) as usize;
        self.drain_output(Some(target_frames), &mut sink)?;
        self.finished = true;
        Ok(())
    }

    fn configure_and_prime(&mut self) -> Result<()> {
        let rate = self.control.rate();
        self.applied_rate = rate;
        // SAFETY: all calls occur before this state's next real input block and on one thread.
        unsafe {
            rubberband_set_max_process_size(self.state.as_ptr(), MAX_PROCESS_FRAMES as u32);
            // As in Mixxx, visit the largest supported time ratio once so Rubber Band reserves
            // headroom before live playback, then restore the actual target.
            rubberband_set_time_ratio(self.state.as_ptr(), 2.0);
            rubberband_set_time_ratio(self.state.as_ptr(), 1.0 / f64::from(rate));
            self.remaining_start_delay = rubberband_get_start_delay(self.state.as_ptr()) as usize;
        }

        let mut padding =
            unsafe { rubberband_get_preferred_start_pad(self.state.as_ptr()) as usize };
        while padding > 0 {
            let frames = padding.min(MAX_PROCESS_FRAMES);
            // SAFETY: every pointer addresses `frames` initialized zeroes and the pointer array
            // contains exactly F::CHANNELS entries for this state.
            unsafe {
                rubberband_process(
                    self.state.as_ptr(),
                    self.zero_ptrs.as_ptr(),
                    frames as u32,
                    0,
                )
            };
            padding -= frames;
            self.discard_prime_output()?;
        }
        self.refresh_required();
        Ok(())
    }

    fn input_len(&self) -> usize {
        self.input.first().map_or(0, Vec::len)
    }

    fn update_rate(&mut self) {
        let rate = self.control.rate();
        if (rate - self.applied_rate).abs() > f32::EPSILON {
            // SAFETY: target updates are applied from the same worker that calls process().
            unsafe {
                rubberband_set_time_ratio(self.state.as_ptr(), 1.0 / f64::from(rate));
            }
            self.applied_rate = rate;
        }
    }

    fn process_input(&mut self, final_block: bool) -> Result<()> {
        self.update_rate();
        let frames = self.input_len();
        if frames > MAX_PROCESS_FRAMES {
            bail!("Rubber Band input block exceeded its preallocated maximum");
        }
        for channel in 0..F::CHANNELS {
            debug_assert_eq!(self.input[channel].len(), frames);
            self.input_ptrs[channel] = if frames == 0 {
                self.zeroes.as_ptr()
            } else {
                self.input[channel].as_ptr()
            };
        }
        let output_frames = frames as f64 / f64::from(self.applied_rate);
        self.expected_output_frames += output_frames;
        if output_frames > 0.0 {
            if let Some(last) = self
                .rate_spans
                .back_mut()
                .filter(|last| (last.rate - self.applied_rate).abs() <= f32::EPSILON)
            {
                last.output_frames += output_frames;
            } else {
                self.rate_spans.push_back(RateSpan {
                    output_frames,
                    rate: self.applied_rate,
                });
            }
        }
        // SAFETY: all channel arrays contain `frames` samples and remain stable for this call.
        unsafe {
            rubberband_process(
                self.state.as_ptr(),
                self.input_ptrs.as_ptr(),
                frames as u32,
                i32::from(final_block),
            )
        };
        for channel in &mut self.input {
            channel.clear();
        }
        Ok(())
    }

    fn refresh_required(&mut self) {
        // A zero requirement means output should be retrieved first. We retrieve after every
        // process call, so one frame is the safe progress fallback if the library still says 0.
        self.next_required =
            unsafe { rubberband_get_samples_required(self.state.as_ptr()) as usize }
                .clamp(1, MAX_PROCESS_FRAMES);
    }

    fn discard_prime_output(&mut self) -> Result<()> {
        loop {
            let available = unsafe { rubberband_available(self.state.as_ptr()) };
            if available <= 0 {
                return Ok(());
            }
            let requested = (available as usize).min(RETRIEVE_FRAMES);
            let retrieved = unsafe {
                rubberband_retrieve(
                    self.state.as_ptr(),
                    self.output_ptrs.as_ptr(),
                    requested as u32,
                ) as usize
            };
            if retrieved == 0 {
                bail!("Rubber Band reported output but retrieved no frames");
            }
            self.remaining_start_delay = self.remaining_start_delay.saturating_sub(retrieved);
        }
    }

    fn drain_output<S>(&mut self, final_limit: Option<usize>, sink: &mut S) -> Result<()>
    where
        S: FnMut(F, f32) -> Result<()>,
    {
        loop {
            let available = unsafe { rubberband_available(self.state.as_ptr()) };
            if available <= 0 {
                return Ok(());
            }
            let requested = (available as usize).min(RETRIEVE_FRAMES);
            let retrieved = unsafe {
                rubberband_retrieve(
                    self.state.as_ptr(),
                    self.output_ptrs.as_ptr(),
                    requested as u32,
                ) as usize
            };
            if retrieved == 0 {
                bail!("Rubber Band reported output but retrieved no frames");
            }
            for frame in 0..retrieved {
                if self.remaining_start_delay > 0 {
                    self.remaining_start_delay -= 1;
                    continue;
                }
                if final_limit.is_some_and(|limit| self.emitted_output_frames >= limit) {
                    continue;
                }
                let media_advance = self.next_media_advance();
                sink(F::from_planar(&self.output, frame), media_advance)?;
                self.emitted_output_frames += 1;
            }
        }
    }

    fn next_media_advance(&mut self) -> f32 {
        let mut output_remaining = 1.0f64;
        let mut media_advance = 0.0f64;
        while output_remaining > 1e-9 {
            let Some(span) = self.rate_spans.front_mut() else {
                media_advance += output_remaining * f64::from(self.applied_rate);
                break;
            };
            let taken = span.output_frames.min(output_remaining);
            media_advance += taken * f64::from(span.rate);
            span.output_frames -= taken;
            output_remaining -= taken;
            if span.output_frames <= 1e-9 {
                self.rate_spans.pop_front();
            }
        }
        media_advance as f32
    }
}

impl<F: TimeStretchFrame> Drop for PitchPreservingStretcher<F> {
    fn drop(&mut self) {
        // SAFETY: this is the unique owner and no C call can outlive Drop.
        unsafe { rubberband_delete(self.state.as_ptr()) };
    }
}

fn finite(sample: f32) -> f32 {
    if sample.is_finite() {
        sample
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StemFrame;

    fn sine(frequency: f32, seconds: f32, sample_rate: u32) -> Vec<[f32; 2]> {
        (0..(seconds * sample_rate as f32) as usize)
            .map(|frame| {
                let value =
                    (std::f32::consts::TAU * frequency * frame as f32 / sample_rate as f32).sin();
                [value, value]
            })
            .collect()
    }

    fn stretch(input: &[[f32; 2]], rate: f32, sample_rate: u32) -> Vec<[f32; 2]> {
        let mut processor =
            PitchPreservingStretcher::new(TempoControl::new(rate), sample_rate).unwrap();
        assert_eq!(processor.engine_version(), 3, "KDJ must run Rubber Band R3");
        let mut output = Vec::new();
        for frame in input {
            processor
                .push(*frame, |frame, _| {
                    output.push(frame);
                    Ok(())
                })
                .unwrap();
        }
        processor
            .finish(|frame, _| {
                output.push(frame);
                Ok(())
            })
            .unwrap();
        output
    }

    fn frequency_from_crossings(samples: &[[f32; 2]], sample_rate: u32) -> f32 {
        let edge = (samples.len() / 10).min(samples.len() / 2);
        let window = &samples[edge..samples.len().saturating_sub(edge)];
        let crossings = window
            .windows(2)
            .filter(|pair| pair[0][0] <= 0.0 && pair[1][0] > 0.0)
            .count();
        crossings as f32 / (window.len() as f32 / sample_rate as f32)
    }

    #[test]
    fn r3_changes_duration_without_changing_pitch() {
        let sample_rate = 48_000;
        let input = sine(440.0, 2.0, sample_rate);
        for rate in [0.5, 0.8, 1.25, 1.6, 2.0] {
            let output = stretch(&input, rate, sample_rate);
            let expected = input.len() as f32 / rate;
            assert!(
                (output.len() as f32 - expected).abs() < sample_rate as f32 * 0.035,
                "rate={rate} expected={expected} actual={}",
                output.len()
            );
            assert!(output
                .iter()
                .all(|frame| frame[0].is_finite() && frame[1].is_finite()));
            let frequency = frequency_from_crossings(&output, sample_rate);
            assert!(
                (frequency - 440.0).abs() < 8.0,
                "rate={rate} frequency={frequency}"
            );
        }
    }

    #[test]
    fn r3_observes_dynamic_tempo_without_rebuilding() {
        let sample_rate = 48_000;
        let input = sine(330.0, 2.0, sample_rate);
        let control = TempoControl::new(1.0);
        let mut processor = PitchPreservingStretcher::new(control.clone(), sample_rate).unwrap();
        let mut output = Vec::new();
        let mut media_frames = 0.0f64;
        for (index, frame) in input.iter().copied().enumerate() {
            if index == input.len() / 2 {
                control.set(1.5);
            }
            processor
                .push(frame, |frame, media_advance| {
                    output.push(frame);
                    media_frames += f64::from(media_advance);
                    Ok(())
                })
                .unwrap();
        }
        processor
            .finish(|frame, media_advance| {
                output.push(frame);
                media_frames += f64::from(media_advance);
                Ok(())
            })
            .unwrap();

        assert!((output.len() as f32 / sample_rate as f32 - 1.667).abs() < 0.1);
        assert!((frequency_from_crossings(&output, sample_rate) - 330.0).abs() < 8.0);
        assert!(
            (media_frames - input.len() as f64).abs() < 2.0,
            "rendered source clock {media_frames} did not cover {} input frames",
            input.len()
        );
    }

    #[test]
    fn r3_continuous_slider_updates_stay_finite() {
        let sample_rate = 48_000;
        let input = sine(550.0, 1.5, sample_rate);
        let control = TempoControl::new(1.0);
        let mut processor = PitchPreservingStretcher::new(control.clone(), sample_rate).unwrap();
        let mut output = Vec::new();
        for (index, frame) in input.iter().copied().enumerate() {
            if index % 240 == 0 {
                let phase = (index / 240) % 80;
                let triangle = if phase <= 40 { phase } else { 80 - phase };
                control.set(0.8 + triangle as f32 * 0.01);
            }
            processor
                .push(frame, |frame, _| {
                    output.push(frame);
                    Ok(())
                })
                .unwrap();
        }
        processor
            .finish(|frame, _| {
                output.push(frame);
                Ok(())
            })
            .unwrap();

        assert!(output.len() > input.len() * 3 / 4);
        assert!(output.len() < input.len() * 3 / 2);
        assert!(output.iter().flatten().all(|sample| sample.is_finite()));
    }

    #[test]
    fn r3_processes_stems_as_one_eight_channel_session() {
        let sample_rate = 48_000;
        let rate = 1.25;
        let mut processor =
            PitchPreservingStretcher::<StemFrame>::new(TempoControl::new(rate), sample_rate)
                .unwrap();
        assert_eq!(<StemFrame as TimeStretchFrame>::CHANNELS, 8);
        let mut output = Vec::new();
        for frame in 0..sample_rate as usize {
            let signal =
                (std::f32::consts::TAU * 330.0 * frame as f32 / sample_rate as f32).sin() * 0.25;
            let mut lanes = [0.0; 8];
            lanes[6] = signal;
            lanes[7] = signal;
            processor
                .push(StemFrame::separated_with_gain(lanes, 1.2), |frame, _| {
                    output.push(frame);
                    Ok(())
                })
                .unwrap();
        }
        processor
            .finish(|frame, _| {
                output.push(frame);
                Ok(())
            })
            .unwrap();

        let expected = sample_rate as f32 / rate;
        assert!((output.len() as f32 - expected).abs() < sample_rate as f32 * 0.04);
        let vocal_energy: f64 = output
            .iter()
            .map(|frame| f64::from(frame.lanes[6]).powi(2))
            .sum();
        let other_energy: f64 = output
            .iter()
            .flat_map(|frame| frame.lanes[..6].iter())
            .map(|sample| f64::from(*sample).powi(2))
            .sum();
        assert!(vocal_energy > 100.0);
        assert!(
            other_energy < 1e-8,
            "inactive stem lanes leaked: {other_energy}"
        );
        assert!(output
            .iter()
            .all(|frame| (frame.reconstruction_gain - 1.0).abs() < f32::EPSILON));
    }

    #[test]
    fn reset_reapplies_padding_and_delay_compensation() {
        let sample_rate = 48_000;
        let input = sine(220.0, 0.5, sample_rate);
        let mut processor =
            PitchPreservingStretcher::new(TempoControl::new(1.0), sample_rate).unwrap();
        let mut first = Vec::new();
        for frame in &input {
            processor
                .push(*frame, |frame, _| {
                    first.push(frame);
                    Ok(())
                })
                .unwrap();
        }
        processor
            .finish(|frame, _| {
                first.push(frame);
                Ok(())
            })
            .unwrap();

        processor.reset().unwrap();
        let mut second = Vec::new();
        for frame in &input {
            processor
                .push(*frame, |frame, _| {
                    second.push(frame);
                    Ok(())
                })
                .unwrap();
        }
        processor
            .finish(|frame, _| {
                second.push(frame);
                Ok(())
            })
            .unwrap();

        assert_eq!(first.len(), second.len());
        assert_eq!(first.len(), input.len());
    }
}
