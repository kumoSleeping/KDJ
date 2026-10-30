//! AAC-LC encoding through the operating system's own encoder: AudioToolbox on macOS,
//! Media Foundation on Windows, MediaCodec on Android. There is no pure-Rust AAC
//! encoder worth shipping, and every one of these is already on the device.

use crate::mp4::boxes::{full_box, mp4_box, BoxBuf};
use anyhow::{bail, Result};

#[cfg(target_os = "macos")]
mod apple;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "android")]
mod android;

/// AAC-LC frames are 1024 samples per channel.
pub const FRAME: usize = 1024;

/// A system AAC-LC encoder taking interleaved f32 PCM.
pub trait AacEncoder: Send {
    fn sample_rate(&self) -> u32;
    fn channels(&self) -> u32;
    /// Samples per channel the encoder puts before the first input sample (priming).
    /// A track presents from here (`elst`), so decoding stays sample-aligned.
    fn priming(&self) -> u32;
    /// Raw AAC frames (no ADTS) produced so far by `pcm` and earlier input.
    fn encode(&mut self, pcm: &[f32]) -> Result<Vec<Vec<u8>>>;
    /// Drains the remaining frames.
    fn finish(&mut self) -> Result<Vec<Vec<u8>>>;
}

/// The system encoder, or why this device has none.
pub fn encoder(sample_rate: u32, channels: u32, bitrate: u32) -> Result<Box<dyn AacEncoder>> {
    if !(1..=2).contains(&channels) {
        bail!("AAC 编码只支持单声道或立体声");
    }
    if sampling_index(sample_rate).is_none() {
        bail!("AAC 不支持 {sample_rate} Hz 采样率");
    }
    #[cfg(target_os = "macos")]
    return Ok(Box::new(apple::Encoder::new(sample_rate, channels, bitrate)?));
    #[cfg(target_os = "windows")]
    return Ok(Box::new(windows::Encoder::new(sample_rate, channels, bitrate)?));
    #[cfg(target_os = "android")]
    return Ok(Box::new(android::Encoder::new(sample_rate, channels, bitrate)?));
    #[allow(unreachable_code)]
    {
        let _ = bitrate;
        bail!("这个系统没有可用的 AAC 编码器")
    }
}

/// Whether [`encoder`] can work here at all (it may still fail to open).
pub const fn available() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows", target_os = "android"))
}

pub fn sampling_index(rate: u32) -> Option<u8> {
    crate::mp4::read::AAC_RATES.iter().position(|&r| r == rate).map(|i| i as u8)
}

/// AudioSpecificConfig for AAC-LC.
pub fn audio_specific_config(sample_rate: u32, channels: u32) -> Vec<u8> {
    let index = sampling_index(sample_rate).unwrap_or(4) as u16;
    let value = (2u16 << 11) | (index << 7) | ((channels as u16 & 0xf) << 3);
    value.to_be_bytes().to_vec()
}

fn descriptor(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let len = body.len() as u32;
    out.extend_from_slice(&[0x80 | (len >> 21 & 0x7f) as u8, 0x80 | (len >> 14 & 0x7f) as u8, 0x80 | (len >> 7 & 0x7f) as u8, (len & 0x7f) as u8]);
    out.extend_from_slice(body);
    out
}

/// The `mp4a` sample entry for AAC with this configuration.
pub fn sample_entry(sample_rate: u32, channels: u32, asc: &[u8], bitrate: u32) -> Vec<u8> {
    let mut config = BoxBuf::default();
    config.u8(0x40);
    config.u8(0x15);
    config.bytes(&[0, 0x18, 0]);
    config.u32(bitrate);
    config.u32(bitrate);
    config.bytes(&descriptor(5, asc));
    let mut es = BoxBuf::default();
    es.u16(1);
    es.u8(0);
    es.bytes(&descriptor(4, &config.0));
    es.bytes(&descriptor(6, &[2]));
    let esds = full_box(b"esds", 0, 0, &descriptor(3, &es.0));
    let mut entry = BoxBuf::default();
    entry.bytes(&[0; 6]);
    entry.u16(1);
    entry.bytes(&[0; 8]);
    entry.u16(channels as u16);
    entry.u16(16);
    entry.u32(0);
    entry.u32(if sample_rate < 65536 { sample_rate << 16 } else { 0 });
    entry.bytes(&esds);
    mp4_box(b"mp4a", &entry.0)
}

/// An encoder and the delay it really has, in samples per channel.
pub struct Opened {
    pub encoder: Box<dyn AacEncoder>,
    pub priming: u32,
}

/// Opens the system encoder and finds its priming: once per format, by encoding a
/// short burst of noise and locating it again in symphonia's decode of the result.
/// Encoders that do not report their delay (Media Foundation, MediaCodec) are thereby
/// held to the same alignment as AudioToolbox, which does.
pub fn open(sample_rate: u32, channels: u32, bitrate: u32) -> Result<Opened> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static MEASURED: OnceLock<Mutex<HashMap<(u32, u32, u32), u32>>> = OnceLock::new();
    let key = (sample_rate, channels, bitrate);
    let cached = MEASURED.get_or_init(Default::default).lock().unwrap().get(&key).copied();
    let priming = match cached {
        Some(priming) => priming,
        None => {
            let measured = measure_priming(encoder(sample_rate, channels, bitrate)?.as_mut())?;
            MEASURED.get_or_init(Default::default).lock().unwrap().insert(key, measured);
            measured
        }
    };
    Ok(Opened { encoder: encoder(sample_rate, channels, bitrate)?, priming })
}

fn measure_priming(encoder: &mut dyn AacEncoder) -> Result<u32> {
    use symphonia::core::audio::{Channels, SampleBuffer};
    use symphonia::core::codecs::{CodecParameters, DecoderOptions, CODEC_TYPE_AAC};
    use symphonia::core::formats::Packet;
    let (rate, channels) = (encoder.sample_rate(), encoder.channels() as usize);
    const NOISE: usize = 8 * FRAME;
    const LAGS: usize = 4 * FRAME;
    let mut seed = 0x2545_f491_u32;
    let noise: Vec<f32> = (0..NOISE)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed as f32 / u32::MAX as f32 - 0.5) * 0.6
        })
        .collect();
    let mut pcm = Vec::with_capacity((NOISE + LAGS) * channels);
    for n in 0..NOISE + LAGS {
        let v = noise.get(n).copied().unwrap_or(0.);
        pcm.extend(std::iter::repeat_n(v, channels));
    }
    let mut packets = encoder.encode(&pcm)?;
    packets.extend(encoder.finish()?);
    let mut params = CodecParameters::new();
    params
        .for_codec(CODEC_TYPE_AAC)
        .with_sample_rate(rate)
        .with_channels(if channels == 1 { Channels::FRONT_CENTRE } else { Channels::FRONT_LEFT | Channels::FRONT_RIGHT })
        .with_extra_data(audio_specific_config(rate, channels as u32).into_boxed_slice());
    let mut decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default())?;
    let mut decoded: Vec<f32> = Vec::new();
    for (n, packet) in packets.iter().enumerate() {
        let audio = decoder.decode(&Packet::new_from_slice(0, (n * FRAME) as u64, FRAME as u64, packet))?;
        let mut buffer = SampleBuffer::<f32>::new(audio.capacity() as u64, *audio.spec());
        buffer.copy_interleaved_ref(audio);
        decoded.extend(buffer.samples().iter().step_by(channels));
    }
    let window = 2 * FRAME;
    let (mut best, mut best_lag) = (f64::MIN, 0);
    for lag in 0..LAGS.min(decoded.len().saturating_sub(window)) {
        let score: f64 = (0..window).map(|i| noise[FRAME + i] as f64 * decoded[FRAME + i + lag] as f64).sum();
        if score > best {
            (best, best_lag) = (score, lag);
        }
    }
    if best <= 0. {
        bail!("无法确定 AAC 编码器的延迟");
    }
    tracing::info!(reported = encoder.priming(), measured = best_lag, rate, channels, "AAC 编码器延迟");
    Ok(best_lag as u32)
}

/// Interleaved PCM into whole AAC frames, the remainder kept for the next call.
#[derive(Default)]
pub(crate) struct FrameQueue {
    pending: Vec<f32>,
}

impl FrameQueue {
    pub fn push(&mut self, pcm: &[f32]) {
        self.pending.extend_from_slice(pcm);
    }
    pub fn take(&mut self, samples: usize) -> Option<Vec<f32>> {
        (self.pending.len() >= samples).then(|| self.pending.drain(..samples).collect())
    }
    pub fn rest(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asc_is_aac_lc() {
        assert_eq!(audio_specific_config(48000, 2), [0x11, 0x90]);
        assert_eq!(audio_specific_config(44100, 2), [0x12, 0x10]);
    }

    #[test]
    fn sample_entry_reads_back() {
        let entry = sample_entry(48000, 2, &audio_specific_config(48000, 2), 256_000);
        let track = crate::mp4::read::Track {
            id: 1,
            handler: *b"soun",
            timescale: 48000,
            language: 0,
            width: 0,
            height: 0,
            entries: vec![entry],
            edit_media_time: None,
            edit_lead: 0,
            edit_duration: None,
            movie_timescale: 1000,
            samples: Vec::new(),
        };
        let info = track.aac().unwrap();
        assert_eq!((info.object_type, info.sample_rate, info.channels), (2, 48000, 2));
    }
}
