//! A song as interleaved f32 PCM: decoded with symphonia exactly as the analysis decodes
//! it (gapless, every packet), downmixed to at most two channels, and resampled when the
//! output needs another rate.

use anyhow::{bail, Context, Result};
use rubato::audioadapter_buffers::owned::InterleavedOwned;
use rubato::{Fft, FixedSync, Indexing, Resampler};
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

const RESAMPLE_CHUNK: usize = 1024;

#[derive(Clone, Copy, Debug)]
pub struct Source {
    pub sample_rate: u32,
    pub channels: u32,
}

/// Rate and output channel count of the first audio track, without decoding it.
pub fn inspect(path: &Path) -> Result<Source> {
    let (format, track) = open(path)?;
    drop(format);
    Ok(track.1)
}

/// The first audio track's length (seconds) as its container states it, without decoding; None
/// when the container does not say.
pub fn duration_secs(path: &Path) -> Option<f64> {
    let (_, (track, source)) = open(path).ok()?;
    let frames = track.codec_params.n_frames?;
    let secs = match track.codec_params.time_base {
        Some(base) => {
            let time = base.calc_time(frames);
            time.seconds as f64 + time.frac
        }
        None => frames as f64 / source.sample_rate as f64,
    };
    (secs.is_finite() && secs > 0.).then_some(secs)
}

type Opened = (Box<dyn symphonia::core::formats::FormatReader>, (symphonia::core::formats::Track, Source));

fn open(path: &Path) -> Result<Opened> {
    let file = File::open(path).with_context(|| format!("打开音频失败：{}", path.display()))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default())
        .with_context(|| format!("无法识别音频格式：{}", path.display()))?;
    let track = probed.format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).context("文件里没有可解码的音轨")?.clone();
    let rate = track.codec_params.sample_rate.context("音轨没有采样率")?;
    let channels = track.codec_params.channels.map_or(2, |c| c.count() as u32).clamp(1, 2);
    Ok((probed.format, (track, Source { sample_rate: rate, channels })))
}

/// Streams the whole track to `consume` as interleaved PCM at `rate` (the source's own
/// when `None`) with the source's channel count capped at two. `frames` limits the
/// output length; returns the frames delivered. `cancelled` is polled between packets.
pub fn decode(path: &Path, rate: Option<u32>, frames: Option<u64>, cancelled: &dyn Fn() -> bool, consume: &mut dyn FnMut(&[f32]) -> Result<()>) -> Result<u64> {
    decode_from(path, rate, frames, 0, cancelled, consume)
}

/// As [`decode`], but from where players start the track: an MP4's edit list (the encoder
/// priming) is skipped, as FFmpeg skips it. For comparing a song with what is heard.
pub fn decode_played(path: &Path, rate: Option<u32>, frames: Option<u64>, cancelled: &dyn Fn() -> bool, consume: &mut dyn FnMut(&[f32]) -> Result<()>) -> Result<u64> {
    let skip = crate::mp4::read::looks_like_mp4(path)
        .then(|| crate::mp4::read::Movie::open(path).ok())
        .flatten()
        .and_then(|movie| {
            let track = movie.audio()?;
            let start = track.edit_media_time?.max(0) as u128;
            let source = inspect(path).ok()?.sample_rate;
            Some((start * rate.unwrap_or(source) as u128 / track.timescale.max(1) as u128) as u64)
        })
        .unwrap_or(0);
    decode_from(path, rate, frames, skip, cancelled, consume)
}

fn decode_from(path: &Path, rate: Option<u32>, frames: Option<u64>, skip: u64, cancelled: &dyn Fn() -> bool, consume: &mut dyn FnMut(&[f32]) -> Result<()>) -> Result<u64> {
    let (mut format, (track, source)) = open(path)?;
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())?;
    let channels = source.channels as usize;
    let target = rate.unwrap_or(source.sample_rate);
    let mut resampler = if target != source.sample_rate {
        Some(Fft::<f32>::new(source.sample_rate as usize, target as usize, RESAMPLE_CHUNK, channels, FixedSync::Input).context("无法建立重采样器")?)
    } else {
        None
    };
    let mut sink = Sink { consume, left: frames.unwrap_or(u64::MAX), delivered: 0, channels, skip: resampler.as_ref().map_or(0, |r| r.output_delay()) + skip as usize, played: skip };
    let mut pending: Vec<f32> = Vec::new();
    let mut input_frames = 0u64;
    let mut buffer: Option<SampleBuffer<f32>> = None;
    loop {
        if cancelled() {
            bail!("已取消");
        }
        if sink.left == 0 {
            break;
        }
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e.into()),
        };
        if packet.track_id() != track.id {
            continue;
        }
        let audio = decoder.decode(&packet)?;
        let spec = *audio.spec();
        if spec.rate != source.sample_rate {
            bail!("音轨中途改变采样率");
        }
        let needed = audio.capacity() * spec.channels.count();
        if buffer.as_ref().is_none_or(|b| b.capacity() < needed) {
            buffer = Some(SampleBuffer::new(audio.capacity() as u64, spec));
        }
        let buffer = buffer.as_mut().unwrap();
        buffer.copy_interleaved_ref(audio);
        let from = spec.channels.count().max(1);
        let samples = buffer.samples();
        let start = pending.len();
        match (from, channels) {
            (f, c) if f == c => pending.extend_from_slice(samples),
            (1, 2) => samples.iter().for_each(|&s| pending.extend_from_slice(&[s, s])),
            (f, 1) => samples.chunks(f).for_each(|frame| pending.push(frame.iter().sum::<f32>() / f as f32)),
            (f, _) => samples.chunks(f).for_each(|frame| pending.extend_from_slice(&[frame[0], frame[1]])),
        }
        input_frames += ((pending.len() - start) / channels) as u64;
        match resampler.as_mut() {
            None => {
                sink.push(&pending)?;
                pending.clear();
            }
            Some(r) => {
                let chunk = RESAMPLE_CHUNK * channels;
                let mut used = 0;
                while pending.len() - used >= chunk {
                    let input = InterleavedOwned::new_from(pending[used..used + chunk].to_vec(), channels, RESAMPLE_CHUNK).unwrap();
                    sink.push(&r.process(&input, None)?.take_data())?;
                    used += chunk;
                }
                pending.drain(..used);
            }
        }
    }
    if let Some(r) = resampler.as_mut() {
        // The tail, then silence until the resampler's delay has come out.
        let expected = (input_frames as u128 * target as u128 / source.sample_rate as u128) as u64;
        sink.left = sink.left.min(expected.saturating_sub(sink.delivered + sink.played));
        let mut tail = std::mem::take(&mut pending);
        while sink.left > 0 {
            let partial = tail.len() / channels;
            let mut data = tail.clone();
            data.resize(RESAMPLE_CHUNK * channels, 0.);
            let input = InterleavedOwned::new_from(data, channels, RESAMPLE_CHUNK).unwrap();
            let indexing = Indexing { input_offset: 0, output_offset: 0, partial_len: Some(partial), active_channels_mask: None };
            sink.push(&r.process(&input, Some(&indexing))?.take_data())?;
            tail.clear();
        }
    }
    Ok(sink.delivered)
}

struct Sink<'a> {
    consume: &'a mut dyn FnMut(&[f32]) -> Result<()>,
    left: u64,
    delivered: u64,
    channels: usize,
    /// Leading resampler delay and requested skip still to drop.
    skip: usize,
    /// Frames of the requested skip, which count against the source's length.
    played: u64,
}

impl Sink<'_> {
    fn push(&mut self, mut pcm: &[f32]) -> Result<()> {
        let skip = self.skip.min(pcm.len() / self.channels);
        self.skip -= skip;
        pcm = &pcm[skip * self.channels..];
        let frames = ((pcm.len() / self.channels) as u64).min(self.left);
        if frames > 0 {
            (self.consume)(&pcm[..frames as usize * self.channels])?;
            self.left -= frames;
            self.delivered += frames;
        }
        Ok(())
    }
}
