use std::fs::File;
use std::path::Path;

use anyhow::{bail, Context, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Immutable stereo PCM prepared away from the realtime callback.
#[derive(Debug)]
pub struct DecodedTrack {
    samples: Box<[f32]>,
    sample_rate: u32,
}

impl DecodedTrack {
    pub fn from_interleaved_stereo(samples: Vec<f32>, sample_rate: u32) -> Result<Self> {
        if sample_rate == 0 {
            bail!("decoded audio has no sample rate");
        }
        if samples.is_empty() || samples.len() % 2 != 0 {
            bail!("stereo PCM must contain complete non-empty frames");
        }
        Ok(Self {
            samples: samples.into_iter().map(finite).collect(),
            sample_rate,
        })
    }

    pub const fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub const fn channels(&self) -> usize {
        2
    }

    pub fn frames(&self) -> usize {
        self.samples.len() / self.channels()
    }

    pub fn byte_len(&self) -> usize {
        self.samples
            .len()
            .saturating_mul(std::mem::size_of::<f32>())
    }

    pub fn duration_seconds(&self) -> f64 {
        self.frames() as f64 / f64::from(self.sample_rate)
    }

    pub fn interleaved(&self) -> &[f32] {
        &self.samples
    }

    /// O(1) prepared seek used by the realtime deck; no decoder work happens here.
    pub fn frame_slice(&self, frame: u64) -> &[f32] {
        let sample = usize::try_from(frame)
            .unwrap_or(usize::MAX)
            .saturating_mul(self.channels())
            .min(self.samples.len());
        &self.samples[sample..]
    }
}

/// Decodes a local file to finite interleaved stereo PCM on a worker thread.
pub fn decode_file(path: &Path) -> Result<DecodedTrack> {
    decode_file_with_limit(path, usize::MAX)
}

/// Bounded variant for long-running application runtimes. The limit is checked while packets are
/// appended so an unexpectedly long recording cannot exhaust memory before the caller sees it.
pub fn decode_file_with_limit(path: &Path, max_pcm_bytes: usize) -> Result<DecodedTrack> {
    decode_file_with_limit_and_cancel(path, max_pcm_bytes, || false)
}

pub fn decode_file_with_limit_and_cancel<F>(
    path: &Path,
    max_pcm_bytes: usize,
    cancelled: F,
) -> Result<DecodedTrack>
where
    F: Fn() -> bool,
{
    if cancelled() {
        bail!("audio preparation cancelled");
    }
    let file = File::open(path).with_context(|| format!("open audio: {}", path.display()))?;
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
        .with_context(|| format!("unsupported audio format: {}", path.display()))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|candidate| {
            let params = &candidate.codec_params;
            params.codec != CODEC_TYPE_NULL
                && (params.channels.is_some() || params.sample_rate.is_some())
        })
        .context("audio stream not found")?;
    let track_id = track.id;
    let params = track.codec_params.clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .context("audio decoder unavailable")?;

    let mut sample_rate = params.sample_rate.filter(|rate| *rate > 0).unwrap_or(0);
    let mut stereo = Vec::new();
    let mut conversion: Option<(SampleBuffer<f32>, u64, usize, u32)> = None;

    loop {
        if cancelled() {
            bail!("audio preparation cancelled");
        }
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                break
            }
            Err(Error::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(error) => return Err(error).context("read audio packet"),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(Error::DecodeError(_)) => continue,
            Err(Error::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(error) => return Err(error).context("decode audio packet"),
        };
        let spec = *decoded.spec();
        if spec.rate > 0 {
            if sample_rate != 0 && sample_rate != spec.rate {
                bail!("sample rate changed within one track");
            }
            sample_rate = spec.rate;
        }
        let channels = spec.channels.count().max(1);
        let required_capacity = decoded.capacity() as u64;
        let recreate = conversion
            .as_ref()
            .is_none_or(|(_, capacity, old_channels, old_rate)| {
                *capacity < required_capacity || *old_channels != channels || *old_rate != spec.rate
            });
        if recreate {
            conversion = Some((
                SampleBuffer::new(required_capacity, spec),
                required_capacity,
                channels,
                spec.rate,
            ));
        }
        let buffer = &mut conversion.as_mut().expect("conversion buffer").0;
        buffer.copy_interleaved_ref(decoded);
        let samples = buffer.samples();
        let appended_samples = samples.len() / channels * 2;
        let next_samples = stereo.len().saturating_add(appended_samples);
        if next_samples.saturating_mul(std::mem::size_of::<f32>()) > max_pcm_bytes {
            bail!(
                "decoded PCM exceeds {} MiB limit",
                max_pcm_bytes / (1024 * 1024)
            );
        }
        stereo.reserve(appended_samples);
        for frame in samples.chunks_exact(channels) {
            let (left, right) = if channels == 1 {
                (frame[0], frame[0])
            } else {
                (frame[0], frame[1])
            };
            stereo.push(finite(left));
            stereo.push(finite(right));
        }
    }

    if stereo.is_empty() {
        bail!("decoded audio is empty");
    }
    if sample_rate == 0 {
        bail!("decoded audio has no sample rate");
    }
    DecodedTrack::from_interleaved_stereo(stereo, sample_rate)
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

    #[test]
    fn decodes_stereo_pcm_and_seeks_by_frame() {
        let path = std::env::temp_dir().join(format!("kdj-player-{}.wav", std::process::id()));
        let pcm: [i16; 4] = [1_000, -1_000, 2_000, -2_000];
        let data_len = (pcm.len() * 2) as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&48_000u32.to_le_bytes());
        wav.extend_from_slice(&(48_000u32 * 4).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for sample in pcm {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        std::fs::write(&path, wav).unwrap();

        let decoded = decode_file(&path).unwrap();
        let _ = std::fs::remove_file(path);
        assert_eq!(decoded.sample_rate(), 48_000);
        assert_eq!(decoded.frames(), 2);
        assert_eq!(decoded.frame_slice(1).len(), 2);
        assert!(decoded.frame_slice(99).is_empty());
    }

    #[test]
    fn cancellation_stops_before_decoder_work() {
        let path =
            std::env::temp_dir().join(format!("kdj-player-cancel-{}.wav", std::process::id()));
        std::fs::write(&path, b"not read after cancellation").unwrap();
        let result = decode_file_with_limit_and_cancel(&path, 1024, || true);
        let _ = std::fs::remove_file(path);
        assert!(result.is_err());
        assert!(format!("{:#}", result.unwrap_err()).contains("cancelled"));
    }
}
