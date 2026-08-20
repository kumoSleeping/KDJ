use std::collections::VecDeque;
use std::fs::File;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::SAMPLE_RATE;

pub(crate) struct StereoAudio {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

/// Keeps one probed ISOMP4/decoder open so STEM scan can seek tiles without re-parsing `moov`.
pub(crate) struct StereoRegionDecoder {
    path: PathBuf,
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    source_rate: u32,
    conversion: Option<(SampleBuffer<f32>, u64, usize, u32)>,
    /// Decoded 44.1 kHz frames not consumed by the last exact region request. Symphonia packets
    /// are normally much larger than one 512-frame model hop; throwing this tail away skips source
    /// audio on the next hop and turns the STEM stream into short pops.
    output_pending: VecDeque<[f32; 2]>,
    resample_previous: Option<[f32; 2]>,
    resample_source_index: u64,
    resample_next_output_position: f64,
}

impl StereoRegionDecoder {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let file =
            File::open(path).with_context(|| format!("打开 STEM 音频失败：{}", path.display()))?;
        let source = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
            hint.with_extension(extension);
        }
        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                source,
                &FormatOptions {
                    enable_gapless: true,
                    ..Default::default()
                },
                &MetadataOptions::default(),
            )
            .with_context(|| format!("无法识别 STEM 音频：{}", path.display()))?;
        let format = probed.format;
        let track = format
            .tracks()
            .iter()
            .find(|candidate| candidate.codec_params.codec != CODEC_TYPE_NULL)
            .context("文件里没有可解码音轨")?;
        let track_id = track.id;
        let params = track.codec_params.clone();
        let source_rate = params.sample_rate.unwrap_or(0);
        let decoder = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .context("没有可用的 STEM 音频解码器")?;
        Ok(Self {
            path: path.to_path_buf(),
            format,
            decoder,
            track_id,
            source_rate,
            conversion: None,
            output_pending: VecDeque::new(),
            resample_previous: None,
            resample_source_index: 0,
            resample_next_output_position: 0.0,
        })
    }

    pub(crate) fn matches(&self, path: &Path) -> bool {
        self.path == path
    }

    pub(crate) fn decode_region(
        &mut self,
        start: f64,
        frames: usize,
    ) -> Result<(Vec<f32>, Vec<f32>)> {
        if frames == 0 {
            return Ok((Vec::new(), Vec::new()));
        }
        self.seek_to(start.max(0.0))?;
        self.read_exact(frames)
    }

    fn read_exact(&mut self, frames: usize) -> Result<(Vec<f32>, Vec<f32>)> {
        if frames == 0 {
            return Ok((Vec::new(), Vec::new()));
        }
        let decoded = self.read_samples(Some(frames))?;
        let mut left = decoded.left;
        let mut right = decoded.right;
        left.resize(frames, 0.0);
        right.resize(frames, 0.0);
        Ok((left, right))
    }

    fn seek_to(&mut self, start: f64) -> Result<()> {
        let seeked = self.format.seek(
            symphonia::core::formats::SeekMode::Accurate,
            symphonia::core::formats::SeekTo::Time {
                time: symphonia::core::units::Time::from(start),
                track_id: Some(self.track_id),
            },
        );
        if seeked.is_err() && start > 0.0 {
            tracing::debug!(
                start,
                path = %self.path.display(),
                "STEM 扫描 seek 失败，改从头解码"
            );
        }
        self.decoder.reset();
        self.output_pending.clear();
        self.resample_previous = None;
        self.resample_source_index = 0;
        self.resample_next_output_position = 0.0;
        Ok(())
    }

    pub(crate) fn read_samples(&mut self, max_frames: Option<usize>) -> Result<StereoAudio> {
        self.read_samples_with_cancel(max_frames, || false)
    }

    pub(crate) fn read_samples_with_cancel<F>(
        &mut self,
        max_frames: Option<usize>,
        cancelled: F,
    ) -> Result<StereoAudio>
    where
        F: Fn() -> bool,
    {
        let mut left = Vec::new();
        let mut right = Vec::new();
        loop {
            if cancelled() {
                bail!("STEM PCM decode cancelled");
            }
            let remaining = max_frames
                .map(|limit| limit.saturating_sub(left.len().min(right.len())))
                .unwrap_or(usize::MAX);
            if remaining == 0 {
                break;
            }
            let take = remaining.min(self.output_pending.len());
            for _ in 0..take {
                let frame = self
                    .output_pending
                    .pop_front()
                    .expect("pending length checked");
                left.push(frame[0]);
                right.push(frame[1]);
            }
            if max_frames.is_some_and(|limit| left.len().min(right.len()) >= limit) {
                break;
            }
            if !self.decode_packet_into_pending()? {
                break;
            }
        }
        if left.is_empty() || self.source_rate == 0 {
            if max_frames.is_some() {
                return Ok(StereoAudio {
                    left: Vec::new(),
                    right: Vec::new(),
                });
            }
            bail!("STEM 音频解码结果为空");
        }
        Ok(StereoAudio { left, right })
    }

    /// Decode one source packet and append every continuously resampled frame to `output_pending`.
    /// Keeping packet overflow is essential: a 48 kHz FLAC packet can contain thousands of
    /// samples while a successor tile may ask for less than the decoder packet tail.
    fn decode_packet_into_pending(&mut self) -> Result<bool> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(symphonia::core::errors::Error::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    return Ok(false);
                }
                Err(symphonia::core::errors::Error::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(error) => return Err(error).context("读取 STEM 音频包"),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                Err(symphonia::core::errors::Error::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(error) => return Err(error).context("解码 STEM 音频包"),
            };
            let spec = *decoded.spec();
            if spec.rate == 0 {
                continue;
            }
            if self.source_rate != 0 && self.source_rate != spec.rate {
                bail!("音频内部采样率发生变化");
            }
            self.source_rate = spec.rate;
            let channels = spec.channels.count().max(1);
            let required = decoded.capacity() as u64;
            let recreate =
                self.conversion
                    .as_ref()
                    .is_none_or(|(_, capacity, old_channels, old_rate)| {
                        *capacity < required || *old_channels != channels || *old_rate != spec.rate
                    });
            if recreate {
                self.conversion = Some((
                    SampleBuffer::new(required, spec),
                    required,
                    channels,
                    spec.rate,
                ));
            }
            let buffer = &mut self.conversion.as_mut().expect("conversion buffer").0;
            buffer.copy_interleaved_ref(decoded);
            let source_frames: Vec<[f32; 2]> = buffer
                .samples()
                .chunks_exact(channels)
                .map(|frame| {
                    let left = finite(frame[0]);
                    [
                        left,
                        finite(if channels == 1 { frame[0] } else { frame[1] }),
                    ]
                })
                .collect();
            for frame in source_frames {
                self.push_resampled_source_frame(frame);
            }
            return Ok(true);
        }
    }

    fn push_resampled_source_frame(&mut self, current: [f32; 2]) {
        if let Some(previous) = self.resample_previous {
            let step = f64::from(self.source_rate) / f64::from(SAMPLE_RATE);
            while self.resample_next_output_position <= self.resample_source_index as f64 {
                let fraction = (self.resample_next_output_position
                    - (self.resample_source_index - 1) as f64)
                    .clamp(0.0, 1.0) as f32;
                self.output_pending.push_back([
                    previous[0] + (current[0] - previous[0]) * fraction,
                    previous[1] + (current[1] - previous[1]) * fraction,
                ]);
                self.resample_next_output_position += step;
            }
        }
        self.resample_previous = Some(current);
        self.resample_source_index = self.resample_source_index.saturating_add(1);
    }
}

/// Decode `[start, start + frames)` at 44.1 kHz stereo, padding with silence if the file ends.
pub(crate) fn decode_stereo_region(
    path: &Path,
    start: f64,
    frames: usize,
) -> Result<(Vec<f32>, Vec<f32>)> {
    let mut decoder = StereoRegionDecoder::open(path)?;
    decoder.decode_region(start, frames)
}

/// Reuse `cached` when it already holds this path; reopen once if a seek/decode fails.
pub(crate) fn decode_stereo_region_cached(
    cached: &mut Option<StereoRegionDecoder>,
    path: &Path,
    start: f64,
    frames: usize,
) -> Result<(Vec<f32>, Vec<f32>)> {
    if cached.as_ref().is_none_or(|decoder| !decoder.matches(path)) {
        *cached = Some(StereoRegionDecoder::open(path)?);
    }
    match cached
        .as_mut()
        .expect("STEM region decoder")
        .decode_region(start, frames)
    {
        Ok(samples) => Ok(samples),
        Err(_) => {
            *cached = Some(StereoRegionDecoder::open(path)?);
            cached
                .as_mut()
                .expect("STEM region decoder")
                .decode_region(start, frames)
        }
    }
}

/// Sequential fixed-shape ByteDance windows. A seek reopens the decoder; a context-safe core advance
/// only reads the new tail instead of re-parsing the file from the playhead each time.
pub struct StemWindowCursor {
    decoder: Option<StereoRegionDecoder>,
    path: PathBuf,
    left: Vec<f32>,
    right: Vec<f32>,
    origin: f64,
    sequential: bool,
}

impl Default for StemWindowCursor {
    fn default() -> Self {
        Self::new()
    }
}

impl StemWindowCursor {
    pub fn new() -> Self {
        Self {
            decoder: None,
            path: PathBuf::new(),
            left: Vec::new(),
            right: Vec::new(),
            origin: 0.0,
            sequential: false,
        }
    }

    pub fn window_for_core(
        &mut self,
        path: &Path,
        core_start: f64,
    ) -> Result<(Vec<f32>, Vec<f32>)> {
        let geometry = crate::stem_tile_geometry();
        let sr = f64::from(SAMPLE_RATE);
        let window_start = core_start - geometry.context as f64 / sr;
        self.fill(path, window_start, geometry.samples)?;
        Ok(self.slice(window_start, geometry.samples))
    }

    fn fill(&mut self, path: &Path, start: f64, frames: usize) -> Result<()> {
        if frames == 0 {
            self.left.clear();
            self.right.clear();
            self.origin = start;
            return Ok(());
        }
        let sr = f64::from(SAMPLE_RATE);
        let end = start + frames as f64 / sr;
        if self
            .decoder
            .as_ref()
            .is_some_and(|decoder| decoder.matches(path))
            && self.contains(start, frames)
        {
            return Ok(());
        }
        let have_end = self.origin + self.left.len() as f64 / sr;
        let same_file = self
            .decoder
            .as_ref()
            .is_some_and(|decoder| decoder.matches(path));
        let can_extend = same_file
            && self.sequential
            && start >= self.origin - 0.5 / sr
            && start < have_end + 0.5 / sr
            && end > have_end + 0.5 / sr;
        if can_extend {
            let extra = ((end - have_end) * sr).round().max(1.0) as usize;
            match self
                .decoder
                .as_mut()
                .expect("STEM window decoder")
                .read_exact(extra)
            {
                Ok((more_left, more_right)) => {
                    self.left.extend(more_left);
                    self.right.extend(more_right);
                    self.drop_before(start);
                    if self.contains(start, frames) {
                        return Ok(());
                    }
                }
                Err(_) => self.sequential = false,
            }
        }
        self.reload(path, start, frames)
    }

    fn reload(&mut self, path: &Path, start: f64, frames: usize) -> Result<()> {
        if self
            .decoder
            .as_ref()
            .is_none_or(|decoder| !decoder.matches(path))
        {
            self.decoder = Some(StereoRegionDecoder::open(path)?);
            self.path = path.to_path_buf();
        }
        let leading = if start < 0.0 {
            ((-start * f64::from(SAMPLE_RATE)).round() as usize).min(frames)
        } else {
            0
        };
        let decoded_frames = frames.saturating_sub(leading);
        let (decoded_left, decoded_right) = if decoded_frames == 0 {
            (Vec::new(), Vec::new())
        } else {
            match self
                .decoder
                .as_mut()
                .expect("STEM window decoder")
                .decode_region(start.max(0.0), decoded_frames)
            {
                Ok(samples) => samples,
                Err(_) => {
                    self.decoder = Some(StereoRegionDecoder::open(path)?);
                    self.decoder
                        .as_mut()
                        .expect("STEM window decoder")
                        .decode_region(start.max(0.0), decoded_frames)?
                }
            }
        };
        self.left = vec![0.0; frames];
        self.right = vec![0.0; frames];
        let copied = decoded_left
            .len()
            .min(decoded_right.len())
            .min(decoded_frames);
        if copied > 0 {
            self.left[leading..leading + copied].copy_from_slice(&decoded_left[..copied]);
            self.right[leading..leading + copied].copy_from_slice(&decoded_right[..copied]);
        }
        self.origin = start;
        self.sequential = true;
        Ok(())
    }

    fn contains(&self, start: f64, frames: usize) -> bool {
        if self.left.len() < frames || self.right.len() < frames {
            return false;
        }
        let sr = f64::from(SAMPLE_RATE);
        let have_end = self.origin + self.left.len() as f64 / sr;
        let end = start + frames as f64 / sr;
        start + 0.5 / sr >= self.origin && end <= have_end + 0.5 / sr
    }

    fn drop_before(&mut self, start: f64) {
        let sr = f64::from(SAMPLE_RATE);
        let skip = ((start - self.origin) * sr).round().max(0.0) as usize;
        if skip == 0 || skip >= self.left.len() {
            return;
        }
        self.left.drain(..skip);
        self.right.drain(..skip.min(self.right.len()));
        self.origin += skip as f64 / sr;
    }

    fn slice(&self, start: f64, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let sr = f64::from(SAMPLE_RATE);
        let offset = ((start - self.origin) * sr).round().max(0.0) as usize;
        let end = (offset + frames).min(self.left.len()).min(self.right.len());
        let mut left = vec![0.0; frames];
        let mut right = vec![0.0; frames];
        let copied = end.saturating_sub(offset);
        if copied > 0 {
            left[..copied].copy_from_slice(&self.left[offset..offset + copied]);
            right[..copied].copy_from_slice(&self.right[offset..offset + copied]);
        }
        (left, right)
    }
}

fn finite(sample: f32) -> f32 {
    if sample.is_finite() {
        sample
    } else {
        0.0
    }
}

/// Cache-producer 16-tap windowed-sinc resampling. Work starts automatically off the audio thread,
/// so the input can retain treble rather than taking the player's low-latency linear path.
#[cfg(test)]
fn resample(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if input.is_empty() || from_rate == to_rate {
        return input.to_vec();
    }
    const TAPS: i64 = 16;
    let ratio = f64::from(to_rate) / f64::from(from_rate);
    let cutoff = ratio.min(1.0);
    let output_len = (input.len() as f64 * ratio).floor() as usize;
    let last = input.len() as i64 - 1;
    (0..output_len)
        .map(|output| {
            let center = output as f64 / ratio;
            let base = center.floor() as i64;
            let mut value = 0.0;
            let mut weight_sum = 0.0;
            for offset in -TAPS + 1..=TAPS {
                let distance = (base + offset) as f64 - center;
                let index = (base + offset).clamp(0, last) as usize;
                let x = std::f64::consts::PI * distance * cutoff;
                let sinc = if x.abs() < 1e-9 {
                    cutoff
                } else {
                    cutoff * x.sin() / x
                };
                let phase = (distance / TAPS as f64 + 1.0) / 2.0;
                let window = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * phase).cos()
                    + 0.08 * (4.0 * std::f64::consts::PI * phase).cos();
                let weight = sinc * window;
                value += f64::from(input[index]) * weight;
                weight_sum += weight;
            }
            if weight_sum.abs() > 1e-12 {
                (value / weight_sum) as f32
            } else {
                input[base.clamp(0, last) as usize]
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SEGMENT_CORE_SAMPLES, SEGMENT_SAMPLES};
    use std::io::Write;

    #[test]
    fn stereo_resampler_preserves_duration() {
        let input = vec![0.0; 48_000];
        let output = resample(&input, 48_000, 44_100);
        assert!((output.len() as isize - 44_100).abs() <= 1);
    }

    #[test]
    fn reused_decoder_matches_a_fresh_open() {
        let dir = std::env::temp_dir().join(format!("kdj-stem-decoder-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tone.wav");
        write_sine_wav(&path, SAMPLE_RATE, SAMPLE_RATE as usize / 4).unwrap();

        let mut cached = None;
        let first = decode_stereo_region_cached(&mut cached, &path, 0.0, 2048).unwrap();
        let second = decode_stereo_region_cached(&mut cached, &path, 0.05, 2048).unwrap();
        let fresh_first = decode_stereo_region(&path, 0.0, 2048).unwrap();
        let fresh_second = decode_stereo_region(&path, 0.05, 2048).unwrap();
        assert_eq!(first.0.len(), fresh_first.0.len());
        assert_eq!(second.0.len(), fresh_second.0.len());
        let err = first
            .0
            .iter()
            .zip(fresh_first.0.iter())
            .map(|(left, right)| (left - right).abs())
            .fold(0.0f32, f32::max);
        assert!(err < 1e-4, "reused decoder drifted by {err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sequential_windows_preserve_the_exact_overlapping_audio() {
        let dir = std::env::temp_dir().join(format!("kdj-stem-window-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tone.wav");
        write_sine_wav(&path, SAMPLE_RATE, SAMPLE_RATE as usize / 4).unwrap();

        let mut cursor = StemWindowCursor::new();
        let first = cursor.window_for_core(&path, 0.05).unwrap();
        let second = cursor
            .window_for_core(
                &path,
                0.05 + SEGMENT_CORE_SAMPLES as f64 / f64::from(SAMPLE_RATE),
            )
            .unwrap();
        let overlap = SEGMENT_SAMPLES - SEGMENT_CORE_SAMPLES;
        let max_error = first
            .0
            .iter()
            .skip(SEGMENT_CORE_SAMPLES)
            .zip(second.0.iter())
            .take(overlap)
            .map(|(left, right)| (left - right).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_error < 1e-6,
            "sequential STEM windows skipped or repeated source PCM: max overlap error {max_error}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sequential_resampled_windows_keep_packet_boundaries_continuous() {
        let dir = std::env::temp_dir().join(format!("kdj-stem-window-48k-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tone-48k.wav");
        write_sine_wav(&path, 48_000, 48_000 / 2).unwrap();

        let first_core = 0.1;
        let second_core = first_core + SEGMENT_CORE_SAMPLES as f64 / f64::from(SAMPLE_RATE);
        let mut cursor = StemWindowCursor::new();
        let first = cursor.window_for_core(&path, first_core).unwrap();
        let sequential = cursor.window_for_core(&path, second_core).unwrap();
        let overlap = SEGMENT_SAMPLES - SEGMENT_CORE_SAMPLES;
        let overlap_error = first
            .0
            .iter()
            .skip(SEGMENT_CORE_SAMPLES)
            .zip(sequential.0.iter())
            .take(overlap)
            .map(|(left, right)| (left - right).abs())
            .fold(0.0f32, f32::max);
        assert!(
            overlap_error < 1e-6,
            "resampled sequential STEM overlap changed: max error {overlap_error}"
        );
        let max_delta = sequential
            .0
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_delta < 0.03,
            "resampled STEM source jumped at a decoder packet boundary: max delta {max_delta}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    fn write_sine_wav(path: &Path, sample_rate: u32, frames: usize) -> std::io::Result<()> {
        let mut data = Vec::with_capacity(44 + frames * 4);
        let data_bytes = (frames * 4) as u32;
        data.extend(b"RIFF");
        data.extend((36 + data_bytes).to_le_bytes());
        data.extend(b"WAVE");
        data.extend(b"fmt ");
        data.extend(16u32.to_le_bytes());
        data.extend(1u16.to_le_bytes());
        data.extend(2u16.to_le_bytes());
        data.extend(sample_rate.to_le_bytes());
        data.extend((sample_rate * 4).to_le_bytes());
        data.extend(4u16.to_le_bytes());
        data.extend(16u16.to_le_bytes());
        data.extend(b"data");
        data.extend(data_bytes.to_le_bytes());
        for index in 0..frames {
            let phase = std::f32::consts::TAU * 440.0 * index as f32 / sample_rate as f32;
            let sample = (phase.sin() * 0.2 * i16::MAX as f32) as i16;
            data.extend(sample.to_le_bytes());
            data.extend(sample.to_le_bytes());
        }
        let mut file = File::create(path)?;
        file.write_all(&data)
    }
}
