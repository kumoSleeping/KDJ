//! Compact source-time features for offline visualization (30 Hz, or 60 Hz in the studio).
//! The decoder and FFT window are bounded: no whole-track PCM or spectrogram.
use anyhow::{Context, Result, ensure};
use kdj_core::audio_visualizer::Spectrum;
use rustfft::{FftPlanner, num_complex::Complex32};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub const SAMPLE_RATE: u32 = 22050;
pub const FPS: u32 = 30;
const FFT_SIZE: usize = 2048;
/// An explicit memory ceiling for malformed/endless inputs, not a decode timeout.
const MAX_SAMPLES: u64 = SAMPLE_RATE as u64 * 60 * 60 * 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureFrame {
    pub bands: Vec<f32>,
    pub bass: f32,
    pub rms: f32,
    pub onset: f32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureTimeline {
    pub version: u32,
    pub sample_rate: u32,
    pub sample_count: u64,
    pub fps: u32,
    /// Frame i is centered on floor(i * sample_rate / fps); edges are zero padded.
    pub frames: Vec<FeatureFrame>,
}
impl FeatureTimeline {
    pub fn duration_seconds(&self) -> f64 {
        self.sample_count as f64 / self.sample_rate as f64
    }
}

struct Analyzer {
    fps: u32,
    ring: VecDeque<f32>,
    received: u64,
    real_samples: u64,
    window: Vec<f64>,
    fft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    buffer: Vec<Complex32>,
    scratch: Vec<Complex32>,
    ranges: Vec<(usize, usize)>,
    previous_raw: Vec<f32>,
    settings: Spectrum,
    frames: Vec<FeatureFrame>,
}
impl Analyzer {
    fn new(settings: &Spectrum) -> Result<Self> {
        ensure!((16..=96).contains(&settings.bands), "频带数量无效");
        ensure!(
            settings.sensitivity.is_finite() && (0.1..=4.).contains(&settings.sensitivity),
            "频谱灵敏度无效"
        );
        ensure!(
            settings.smoothing.is_finite() && (0.0..=0.98).contains(&settings.smoothing),
            "频谱平滑参数无效"
        );
        let fft = FftPlanner::new().plan_fft_forward(FFT_SIZE);
        let scratch = vec![Complex32::default(); fft.get_inplace_scratch_len()];
        let ranges = (0..settings.bands)
            .map(|i| {
                let bin = |j: usize| {
                    (40. * 250_f64.powf(j as f64 / settings.bands as f64) * FFT_SIZE as f64
                        / SAMPLE_RATE as f64)
                        .floor() as usize
                };
                let first = bin(i).clamp(1, FFT_SIZE / 2);
                (first, bin(i + 1).max(first + 1).min(FFT_SIZE / 2 + 1))
            })
            .collect();
        Ok(Self {
            fps: FPS,
            ring: VecDeque::from(vec![0.; FFT_SIZE]),
            received: 0,
            real_samples: 0,
            window: crate::dsp::hann_window(FFT_SIZE),
            fft,
            buffer: vec![Complex32::default(); FFT_SIZE],
            scratch,
            ranges,
            previous_raw: vec![0.; settings.bands],
            settings: settings.clone(),
            frames: vec![],
        })
    }
    fn push(&mut self, value: f32) {
        self.ring.pop_front();
        self.ring
            .push_back(if value.is_finite() { value } else { 0. });
        self.received += 1;
        let center = self.frames.len() as u64 * SAMPLE_RATE as u64 / self.fps as u64;
        if self.received == center + FFT_SIZE as u64 / 2 {
            self.emit();
        }
    }
    fn consume(&mut self, values: &[f32]) {
        for &value in values {
            if self.real_samples >= MAX_SAMPLES {
                break;
            }
            self.push(value);
            self.real_samples += 1;
        }
    }
    fn emit(&mut self) {
        let mut power = 0.;
        for (i, &sample) in self.ring.iter().enumerate() {
            power += sample as f64 * sample as f64;
            self.buffer[i] = Complex32::new(sample * self.window[i] as f32, 0.);
        }
        self.fft
            .process_with_scratch(&mut self.buffer, &mut self.scratch);
        let mut bands = Vec::with_capacity(self.ranges.len());
        let mut onset = 0.;
        let (mut bass, mut bass_count) = (0., 0);
        for (i, &(first, end)) in self.ranges.iter().enumerate() {
            let magnitude = self.buffer[first..end]
                .iter()
                .map(|v| v.norm())
                .fold(0_f32, f32::max)
                * 4.
                / FFT_SIZE as f32;
            let raw = (((20.
                * (magnitude * self.settings.sensitivity as f32)
                    .max(1e-9)
                    .log10())
                + 60.)
                / 60.)
                .clamp(0., 1.);
            onset += (raw - self.previous_raw[i]).max(0.);
            self.previous_raw[i] = raw;
            let previous = self.frames.last().map_or(0., |frame| frame.bands[i]);
            let value = raw.max(previous * self.settings.smoothing as f32);
            bands.push(value);
            if first as f64 * SAMPLE_RATE as f64 / FFT_SIZE as f64 <= 160. {
                bass += value;
                bass_count += 1;
            }
        }
        self.frames.push(FeatureFrame {
            bands,
            bass: if bass_count == 0 {
                0.
            } else {
                bass / bass_count as f32
            },
            rms: (power / FFT_SIZE as f64).sqrt().min(1.) as f32,
            onset: (onset * 3. / self.settings.bands as f32).min(1.),
        });
    }
    fn finish(mut self) -> Result<FeatureTimeline> {
        ensure!(self.real_samples > 0, "音频解码结果为空");
        let count = (self.real_samples * self.fps as u64).div_ceil(SAMPLE_RATE as u64);
        while (self.frames.len() as u64) < count {
            self.push(0.);
        }
        self.frames.truncate(count as usize);
        Ok(FeatureTimeline {
            version: 1,
            sample_rate: SAMPLE_RATE,
            sample_count: self.real_samples,
            fps: self.fps,
            frames: self.frames,
        })
    }
}

pub fn analyze(
    path: &Path,
    spectrum: &Spectrum,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<FeatureTimeline> {
    analyze_at_fps(path, spectrum, FPS, cancelled)
}

/// Denser source analysis is independent of the preview/export frame rate.
pub fn analyze_at_fps(
    path: &Path,
    spectrum: &Spectrum,
    fps: u32,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<FeatureTimeline> {
    ensure!(matches!(fps, 30 | 60), "可视化分析频率无效");
    ensure!(!cancelled(), "可视化分析已取消");
    let mut analyzer = Analyzer::new(spectrum)?;
    analyzer.fps = fps;
    let oversized = AtomicBool::new(false);
    let duration = crate::decode::stream_mono(
        path,
        SAMPLE_RATE,
        &|| cancelled() || oversized.load(Ordering::Relaxed),
        |packet| {
            if analyzer.real_samples + packet.len() as u64 > MAX_SAMPLES {
                oversized.store(true, Ordering::Relaxed);
            }
            analyzer.consume(packet);
        },
    )?;
    ensure!(
        !oversized.load(Ordering::Relaxed),
        "可视化音频超过六小时分析上限"
    );
    duration.context("可视化分析已取消")?;
    ensure!(!cancelled(), "可视化分析已取消");
    analyzer.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn samples(values: &[f32], chunks: usize) -> FeatureTimeline {
        let mut a = Analyzer::new(&Spectrum::default()).unwrap();
        for part in values.chunks(chunks) {
            a.consume(part);
        }
        a.finish().unwrap()
    }
    #[test]
    fn silence_and_short_tail_have_exact_frame_counts() {
        for count in [1, 100, 734, 735, 736, 22050, 22051] {
            let timeline = samples(&vec![0.; count], 117);
            assert_eq!(timeline.frames.len(), (count * 30).div_ceil(22050));
            assert!(
                timeline
                    .frames
                    .iter()
                    .all(|f| f.rms == 0. && f.bands.iter().all(|&v| v == 0.))
            );
        }
    }
    #[test]
    fn chunking_does_not_change_source_time_or_features() {
        let values: Vec<_> = (0..44100)
            .map(|i| (std::f32::consts::TAU * i as f32 * 440. / SAMPLE_RATE as f32).sin() * 0.5)
            .collect();
        let a = samples(&values, 1);
        let b = samples(&values, 4096);
        assert_eq!(
            serde_json::to_vec(&a).unwrap(),
            serde_json::to_vec(&b).unwrap()
        );
        assert_eq!(a.frames.len(), 60);
        let frame = &a.frames[30];
        let peak = frame
            .bands
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.total_cmp(b))
            .unwrap()
            .0;
        let center = 40. * 250_f64.powf((peak as f64 + 0.5) / 48.);
        assert!((center - 440.).abs() < 80., "peak {center}");
        assert!(frame.rms > 0.3 && frame.rms < 0.4);
    }
    #[test]
    fn cancellation_precedes_file_io_and_invalid_settings_fail() {
        assert!(
            analyze(Path::new("/does-not-exist"), &Spectrum::default(), &|| true)
                .unwrap_err()
                .to_string()
                .contains("取消")
        );
        let mut spectrum = Spectrum::default();
        spectrum.bands = usize::MAX;
        assert!(Analyzer::new(&spectrum).is_err());
    }
}
