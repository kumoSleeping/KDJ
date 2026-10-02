//! Incremental live spectra and short-span constellation peaks. Offline and
//! capture extraction share the same grid, warm-up and 20 ms peak look-ahead.
use super::*;
use rustfft::Fft;
use std::{
    collections::VecDeque,
    io::{Read, Write},
    sync::Arc,
};

pub const LIVE_FEATURE_REVISION: u32 = 5;
const MAGIC: &[u8; 8] = b"KDJLVF06";
const HISTORY: usize = 10;
const LIVE_FFT: usize = 512;
const PEAK_RADIUS: usize = 2;
const FRAME_BYTES: usize = BANDS * 4 + 8;

#[derive(Default)]
pub struct LiveFeatures {
    pub(super) spectra: Vec<[f32; BANDS]>,
    // Zero is padding; other values are log-frequency bins (48 per octave).
    pub(super) peaks: Vec<[u16; 4]>,
}
impl LiveFeatures {
    pub fn prepare(pcm: &[f32], canceled: &dyn Fn() -> bool) -> Result<Self> {
        let mut stream = LiveFeatureStream::new(pcm.len() / HOP + 1);
        stream.push(pcm, canceled)?;
        Ok(Self {
            spectra: stream.frames.into_iter().collect(),
            peaks: stream.peaks.into_iter().collect(),
        })
    }
    pub fn duration_ms(&self) -> f64 {
        if self.spectra.is_empty() {
            0.
        } else {
            ((self.spectra.len() - 1) * HOP + LIVE_FFT) as f64 * 1000. / SAMPLE_RATE as f64
        }
    }
    /// First stored frame's PCM origin, including the causal feature warm-up.
    pub fn origin_seconds() -> f64 {
        ((HISTORY + PEAK_RADIUS) * HOP) as f64 / SAMPLE_RATE as f64
    }
    pub fn memory_bytes(&self) -> usize {
        self.spectra.len() * FRAME_BYTES
    }
    pub fn frame_count(&self) -> usize { self.spectra.len() }
    /// Bounded receive-side window; callers reset it on transport/sequence gaps.
    pub fn append(&mut self, chunk: Self, capacity: usize) {
        self.spectra.extend(chunk.spectra);
        self.peaks.extend(chunk.peaks);
        let excess = self.spectra.len().saturating_sub(capacity);
        self.spectra.drain(..excess);
        self.peaks.drain(..excess);
    }
    pub fn recent(&self, seconds: f64) -> Option<Self> {
        let count = ((seconds * SAMPLE_RATE as f64 - LIVE_FFT as f64) / HOP as f64).floor().max(0.) as usize + 1;
        if count < 2 || self.spectra.len() < count { return None; }
        let skip = self.spectra.len() - count;
        Some(Self { spectra: self.spectra[skip..].to_vec(), peaks: self.peaks[skip..].to_vec() })
    }
    pub fn write_to(&self, mut writer: impl Write) -> Result<()> {
        anyhow::ensure!(
            self.spectra.len() == self.peaks.len(),
            "地标与频谱时间轴不一致"
        );
        writer.write_all(MAGIC)?;
        writer.write_all(&(self.spectra.len() as u32).to_le_bytes())?;
        for (frame, peaks) in self.spectra.iter().zip(&self.peaks) {
            for value in frame {
                writer.write_all(&value.to_le_bytes())?;
            }
            for peak in peaks {
                writer.write_all(&peak.to_le_bytes())?;
            }
        }
        Ok(())
    }
    pub fn read_from(mut reader: impl Read) -> Result<Self> {
        let mut magic = [0; 8];
        reader.read_exact(&mut magic)?;
        anyhow::ensure!(&magic == MAGIC, "实时特征版本已变化");
        let mut bytes = [0; 4];
        reader.read_exact(&mut bytes)?;
        let count = u32::from_le_bytes(bytes) as usize;
        anyhow::ensure!(
            count > 0 && count <= FEATURE_MEMORY_BUDGET / FRAME_BYTES,
            "实时特征长度无效"
        );
        let mut spectra = Vec::with_capacity(count);
        let mut peaks = Vec::with_capacity(count);
        for _ in 0..count {
            let mut frame = [0.; BANDS];
            for value in &mut frame {
                reader.read_exact(&mut bytes)?;
                *value = f32::from_le_bytes(bytes);
                anyhow::ensure!(value.is_finite(), "实时特征包含无效数值");
            }
            let mut points = [0; 4];
            for point in &mut points {
                let mut bytes = [0; 2];
                reader.read_exact(&mut bytes)?;
                *point = u16::from_le_bytes(bytes);
                anyhow::ensure!(*point <= 255, "地标频率无效");
            }
            spectra.push(frame);
            peaks.push(points);
        }
        anyhow::ensure!(reader.read(&mut [0; 1])? == 0, "实时特征存在多余数据");
        Ok(Self { spectra, peaks })
    }
}

struct PendingFrame {
    spectrum: [f32; BANDS],
    power: [f32; LIVE_FFT / 2],
    end: u64,
}

/// No recording-wide normalization and no FFT recomputation of old PCM. Only
/// the central frame of a five-frame neighborhood is committed to the stream.
pub struct LiveFeatureStream {
    fft: Arc<dyn Fft<f32>>,
    buffer: Vec<Complex32>,
    scratch: Vec<Complex32>,
    hann: [f32; LIVE_FFT],
    bins: [usize; BANDS + 1],
    pcm: VecDeque<f32>,
    history: VecDeque<[f32; BANDS]>,
    pending: VecDeque<PendingFrame>,
    frames: VecDeque<[f32; BANDS]>,
    peaks: VecDeque<[u16; 4]>,
    capacity: usize,
    received: u64,
    next_start: u64,
    last_end: u64,
}
impl LiveFeatureStream {
    pub fn new(capacity: usize) -> Self {
        let fft = FftPlanner::<f32>::new().plan_fft_forward(LIVE_FFT);
        let scratch = vec![Complex32::default(); fft.get_inplace_scratch_len()];
        Self {
            fft,
            scratch,
            buffer: vec![Complex32::default(); LIVE_FFT],
            hann: std::array::from_fn(|i| {
                0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / LIVE_FFT as f32).cos()
            }),
            bins: std::array::from_fn(|i| {
                (60f64 * (3800f64 / 60.).powf(i as f64 / BANDS as f64) * LIVE_FFT as f64
                    / SAMPLE_RATE as f64)
                    .round() as usize
            }),
            pcm: VecDeque::new(),
            history: VecDeque::with_capacity(HISTORY),
            pending: VecDeque::with_capacity(PEAK_RADIUS * 2 + 1),
            frames: VecDeque::new(),
            peaks: VecDeque::new(),
            capacity: capacity.max(1),
            received: 0,
            next_start: 0,
            last_end: 0,
        }
    }
    pub fn reset(&mut self) {
        self.pcm.clear();
        self.history.clear();
        self.pending.clear();
        self.frames.clear();
        self.peaks.clear();
        self.received = 0;
        self.next_start = 0;
        self.last_end = 0;
    }
    fn commit(&mut self) {
        let center = &self.pending[PEAK_RADIUS];
        let maximum = center.power.iter().copied().fold(0f32, f32::max);
        let mut candidates = Vec::new();
        // Ignore DC/rumble and the capture resampler's upper transition band.
        for bin in 8..224 {
            let power = center.power[bin];
            if power < 1e-8 || power < maximum * 0.01 {
                continue;
            }
            let peak = self.pending.iter().enumerate().all(|(time, frame)| {
                (bin - 1..=bin + 1).all(|neighbor| {
                    time == PEAK_RADIUS && neighbor == bin || frame.power[neighbor] < power
                })
            });
            if !peak {
                continue;
            }
            let left = center.power[bin - 1].max(1e-20).ln();
            let middle = power.ln();
            let right = center.power[bin + 1].max(1e-20).ln();
            let denominator = left - 2. * middle + right;
            let delta = if denominator.abs() > 1e-6 {
                (0.5 * (left - right) / denominator).clamp(-0.5, 0.5)
            } else {
                0.
            };
            let frequency = (bin as f32 + delta) * SAMPLE_RATE as f32 / LIVE_FFT as f32;
            let code = (1. + (frequency / 100.).log2() * 48.).round() as u16;
            candidates.push((power, code));
        }
        candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut peaks = [0; 4];
        for (slot, (_, code)) in peaks.iter_mut().zip(candidates) {
            *slot = code;
        }
        if self.frames.len() == self.capacity {
            self.frames.pop_front();
            self.peaks.pop_front();
        }
        self.frames.push_back(center.spectrum);
        self.peaks.push_back(peaks);
        self.last_end = center.end;
        self.pending.pop_front();
    }
    pub fn push(&mut self, pcm: &[f32], canceled: &dyn Fn() -> bool) -> Result<()> {
        anyhow::ensure!(pcm.iter().all(|v| v.is_finite()), "捕获音频包含无效数值");
        self.pcm.extend(pcm);
        self.received += pcm.len() as u64;
        while self.pcm.len() >= LIVE_FFT {
            if self.next_start % 8000 == 0 && canceled() {
                bail!("实时特征提取已取消")
            }
            for (i, sample) in self.pcm.iter().take(LIVE_FFT).enumerate() {
                self.buffer[i] = Complex32::new(*sample * self.hann[i], 0.);
            }
            self.fft
                .process_with_scratch(&mut self.buffer, &mut self.scratch);
            let power = std::array::from_fn(|i| self.buffer[i].norm_sqr());
            let raw: [f32; BANDS] = std::array::from_fn(|i| {
                let lo = self.bins[i].max(1);
                let hi = self.bins[i + 1].max(lo + 1).min(LIVE_FFT / 2);
                (power[lo..hi].iter().sum::<f32>() / (hi - lo) as f32)
                    .max(1e-10)
                    .ln()
            });
            if self.history.len() == HISTORY {
                let previous = self.history.pop_front().unwrap();
                let common = (3..15).map(|i| raw[i] - previous[i]).sum::<f32>() / 12.;
                let spectrum = std::array::from_fn(|i| raw[i] - previous[i] - common);
                self.pending.push_back(PendingFrame {
                    spectrum,
                    power,
                    end: self.next_start + LIVE_FFT as u64,
                });
                if self.pending.len() == PEAK_RADIUS * 2 + 1 {
                    self.commit();
                }
            }
            self.history.push_back(raw);
            self.pcm.drain(..HOP);
            self.next_start += HOP as u64;
        }
        Ok(())
    }
    /// Export each committed frame once, retaining FFT/history/look-ahead state.
    /// The frame index is on the capture generation's 10 ms grid. Tail age maps
    /// the last frame endpoint back to the timestamped input PCM endpoint.
    pub fn take_committed(&mut self) -> Option<(LiveFeatures, u64, f64)> {
        if self.frames.is_empty() { return None; }
        let first = (self.last_end - LIVE_FFT as u64) / HOP as u64 + 1 - self.frames.len() as u64;
        Some((LiveFeatures { spectra: self.frames.drain(..).collect(), peaks: self.peaks.drain(..).collect() },
            first, (self.received - self.last_end) as f64 / SAMPLE_RATE as f64))
    }
    /// The timestamp excludes both the unfinished FFT and peak look-ahead.
    pub fn recent(&self, seconds: f64) -> Option<(LiveFeatures, f64)> {
        let frames = ((seconds * SAMPLE_RATE as f64 - LIVE_FFT as f64) / HOP as f64)
            .floor()
            .max(0.) as usize
            + 1;
        if self.frames.len() < frames || frames < 2 {
            return None;
        }
        let skip = self.frames.len() - frames;
        Some((
            LiveFeatures {
                spectra: self.frames.iter().skip(skip).copied().collect(),
                peaks: self.peaks.iter().skip(skip).copied().collect(),
            },
            (self.received - self.last_end) as f64 / SAMPLE_RATE as f64,
        ))
    }
}
