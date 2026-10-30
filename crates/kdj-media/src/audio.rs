//! AAC audio tracks: copied from a song that already is AAC, or encoded by the system
//! encoder from symphonia's decode of anything else.

use crate::aac;
use crate::mp4::read::Movie;
use crate::mp4::write::{Edit, OutSample, OutTrack};
use crate::pcm;
use anyhow::{ensure, Context, Result};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

pub const LANGUAGE_UND: u16 = 0x55c4;

/// What to make of the source's PCM: `skip` frames dropped from its start, `lead`
/// frames of silence before it, `frames` in total at most (all of them when `None`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Shape {
    pub skip: u64,
    pub lead: u64,
    pub frames: Option<u64>,
}

/// Encodes the song at `path` to AAC-LC at `rate` (its own when `None`), writing raw
/// frames to `scratch`. The track's samples point into `scratch` as source `source`;
/// it presents exactly the shaped PCM, the encoder's priming hidden by its edit.
pub fn encode(path: &Path, scratch: &Path, source: usize, rate: Option<u32>, bitrate: u32, shape: Shape, cancelled: &dyn Fn() -> bool) -> Result<OutTrack> {
    let input = pcm::inspect(path)?;
    let rate = rate.unwrap_or(input.sample_rate);
    let channels = input.channels;
    let aac::Opened { mut encoder, priming } = aac::open(rate, channels, bitrate)?;
    let mut file = BufWriter::new(File::create(scratch).with_context(|| format!("创建临时音频失败：{}", scratch.display()))?);
    let mut samples = Vec::new();
    let mut offset = 0u64;
    let mut store = |packets: Vec<Vec<u8>>, samples: &mut Vec<OutSample>| -> Result<()> {
        for packet in packets {
            file.write_all(&packet)?;
            samples.push(OutSample { source, offset, size: packet.len() as u32, duration: aac::FRAME as u32, cts: 0, sync: true });
            offset += packet.len() as u64;
        }
        Ok(())
    };
    let silence = vec![0f32; aac::FRAME * channels as usize];
    let mut lead = shape.lead;
    let limit = shape.frames.map(|f| f.saturating_sub(shape.lead));
    let mut total = 0u64;
    while lead > 0 {
        let n = lead.min(aac::FRAME as u64) as usize;
        store(encoder.encode(&silence[..n * channels as usize])?, &mut samples)?;
        lead -= n as u64;
        total += n as u64;
    }
    let mut skip = shape.skip * channels as u64;
    let decoded = pcm::decode(path, Some(rate), limit.map(|f| f + shape.skip), cancelled, &mut |pcm| {
        let drop = skip.min(pcm.len() as u64) as usize;
        skip -= drop as u64;
        if drop < pcm.len() {
            store(encoder.encode(&pcm[drop..])?, &mut samples)?;
        }
        Ok(())
    })?;
    total += decoded.saturating_sub(shape.skip);
    store(encoder.finish()?, &mut samples)?;
    drop(store);
    file.into_inner().map_err(|e| e.into_error())?.sync_data()?;
    ensure!(total > 0 && !samples.is_empty(), "音频为空，无法编码");
    let coded = samples.len() as u64 * aac::FRAME as u64;
    ensure!(coded >= priming as u64 + total, "AAC 编码器输出的帧数不够：{} 帧，需要 {}", coded, priming as u64 + total);
    Ok(OutTrack {
        handler: *b"soun",
        timescale: rate,
        language: LANGUAGE_UND,
        width: 0,
        height: 0,
        entries: vec![aac::sample_entry(rate, channels, &aac::audio_specific_config(rate, channels), bitrate)],
        samples,
        edit: Edit { lead: 0, media_time: priming as i64, duration: Some(total) },
    })
}

/// The song's own AAC track, unchanged, when it is in an MP4 container and at `rate`
/// (any rate when `None`). It presents from its first sample, as symphonia decodes it.
pub fn copy(path: &Path, source: usize, rate: Option<u32>, frames: Option<u64>) -> Option<OutTrack> {
    let movie = Movie::open(path).ok()?;
    let audio: Vec<_> = movie.tracks.iter().filter(|t| t.is_audio()).collect();
    let [track] = audio.as_slice() else { return None };
    let info = track.aac()?;
    if track.entries.len() != 1 || info.object_type != 2 || !(1..=2).contains(&info.channels) || rate.is_some_and(|r| r != info.sample_rate) || track.timescale != info.sample_rate {
        return None;
    }
    let mut samples: Vec<OutSample> = track.samples.iter().map(|s| OutSample { source, offset: s.offset, size: s.size, duration: s.duration, cts: 0, sync: true }).collect();
    let media: u64 = samples.iter().map(|s| s.duration as u64).sum();
    let mut edit = Edit::default();
    if let Some(frames) = frames.filter(|&f| f < media) {
        // Drop whole frames past the end, then cut the last one with the edit.
        let mut kept = 0u64;
        let keep = samples.iter().take_while(|s| { let keep = kept < frames; kept += s.duration as u64; keep }).count();
        samples.truncate(keep);
        edit.duration = Some(frames);
    }
    Some(OutTrack { handler: *b"soun", timescale: track.timescale, language: track.language, width: 0, height: 0, entries: track.entries.clone(), samples, edit })
}
