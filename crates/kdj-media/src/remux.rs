//! Download finishing: DASH / adaptive video and audio streams into one MP4, an audio track
//! out into M4A, and the calibrated start offset.
//!
//! The offset is held to the sample: audio is decoded, cut or padded and encoded again with
//! the system AAC encoder; video is copied and its edit list starts it at the same instant
//! (whole GOPs before the cut are dropped, a negative offset is an empty edit). Audio that is
//! not AAC (MP3, FLAC) is re-encoded the same way when it has to go into M4A.

use crate::audio::{self, Shape};
use crate::mp4::read::{Movie, Track};
use crate::mp4::write::{self, Brand, Edit, OutSample, OutTrack};
use anyhow::{bail, ensure, Context, Result};
use std::path::{Path, PathBuf};

/// AAC bitrate for re-encoded download audio.
const VIDEO_AUDIO_BITRATE: u32 = 192_000;
const AUDIO_BITRATE: u32 = 192_000;

pub struct Job<'a> {
    pub output: &'a Path,
    /// Scratch files go here and are removed afterwards.
    pub scratch: &'a Path,
    pub offset_ms: i64,
    pub cancelled: &'a dyn Fn() -> bool,
}

fn copied(track: &Track, source: usize) -> Result<OutTrack> {
    crate::mp4::read::ensure_supported_entry(track)?;
    let mut samples: Vec<OutSample> = track.samples.iter().map(|s| OutSample { source, offset: s.offset, size: s.size, duration: s.duration, cts: s.cts, sync: s.sync }).collect();
    if let Some(last) = samples.last_mut() {
        // A fragment's last sample may carry no duration; repeat the one before it.
        if last.duration == 0 {
            last.duration = track.samples.iter().rev().nth(1).map_or(1, |s| s.duration.max(1));
        }
    }
    Ok(OutTrack {
        handler: track.handler,
        timescale: track.timescale,
        language: track.language,
        width: track.width,
        height: track.height,
        entries: track.entries.clone(),
        samples,
        edit: Edit { lead: 0, media_time: track.edit_media_time.unwrap_or(0).max(0), duration: None },
    })
}

/// The video track starting `offset_ms` later (positive) or after that much nothing (negative).
fn shifted_video(track: &Track, source: usize, offset_ms: i64) -> Result<OutTrack> {
    let mut out = copied(track, source)?;
    let ts = track.timescale as i64;
    if offset_ms < 0 {
        out.edit.lead = (-offset_ms * ts / 1000) as u64;
        return Ok(out);
    }
    let start = out.edit.media_time + offset_ms * ts / 1000;
    // Decode times of each sample; keep from the last sync sample at or before `start`.
    let mut dts = 0i64;
    let mut keep_from = (0, 0i64);
    for (n, s) in out.samples.iter().enumerate() {
        if s.sync && dts + s.cts as i64 <= start {
            keep_from = (n, dts);
        }
        dts += s.duration as i64;
    }
    ensure!(start < dts, "Offset 超过了视频长度");
    out.samples.drain(..keep_from.0);
    out.edit.media_time = start - keep_from.1;
    Ok(out)
}

fn temp(job: &Job, name: &str) -> PathBuf {
    job.scratch.join(format!("kdj-media-{name}-{:08x}", std::process::id() ^ (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos()))))
}

/// The audio track of `path`, re-encoded with the offset applied. The source's own edit
/// (encoder priming, end padding) is honoured first, as players honour it.
fn shifted_audio(path: &Path, track: &Track, scratch: &Path, source: usize, offset_ms: i64, bitrate: u32, cancelled: &dyn Fn() -> bool) -> Result<OutTrack> {
    if crate::pcm::inspect(path).is_err() {
        bail!("这个音轨的编码解不了（例如杜比 E-AC-3），不能加 Offset，也不能转成 AAC");
    }
    ensure!(crate::aac::available(), "这台设备没有系统 AAC 编码器，不能加 Offset，也不能把音轨转成 AAC");
    let rate = track.aac().map_or(track.timescale, |a| a.sample_rate).max(1) as i64;
    let start = track.edit_media_time.unwrap_or(0).max(0) * rate / track.timescale.max(1) as i64;
    let length = (track.duration_secs() * rate as f64).round() as i64;
    let offset = offset_ms * rate / 1000;
    ensure!(offset < length, "Offset 超过了音频长度");
    let shape = if offset >= 0 {
        Shape { skip: (start + offset) as u64, lead: 0, frames: Some((length - offset) as u64) }
    } else {
        Shape { skip: start as u64, lead: (-offset) as u64, frames: Some((length - offset) as u64) }
    };
    audio::encode(path, scratch, source, None, bitrate, shape, cancelled)
}

fn first<'a>(movie: &'a Movie, video: bool) -> Option<&'a Track> {
    if video { movie.video() } else { movie.audio() }
}

/// `video`'s video track and `audio`'s audio track (either may be the same file, or
/// absent) into one MP4 at `job.output`.
pub fn mux(video: Option<&Path>, audio: Option<&Path>, job: &Job) -> Result<()> {
    ensure!(video.is_some() || audio.is_some(), "没有要封装的轨道");
    let mut sources: Vec<PathBuf> = Vec::new();
    let mut tracks = Vec::new();
    let mut scratch = Vec::new();
    if let Some(path) = video {
        let movie = Movie::open(path)?;
        let track = first(&movie, true).context("视频文件里没有画面轨道")?;
        sources.push(path.to_path_buf());
        tracks.push(if job.offset_ms == 0 { copied(track, 0)? } else { shifted_video(track, 0, job.offset_ms)? });
    }
    if let Some(path) = audio {
        let movie = Movie::open(path)?;
        if let Some(track) = first(&movie, false) {
            if job.offset_ms == 0 {
                sources.push(path.to_path_buf());
                tracks.push(copied(track, sources.len() - 1)?);
            } else {
                let file = temp(job, "audio");
                scratch.push(file.clone());
                sources.push(file.clone());
                let made = shifted_audio(path, track, &file, sources.len() - 1, job.offset_ms, VIDEO_AUDIO_BITRATE, job.cancelled);
                match made {
                    Ok(track) => tracks.push(track),
                    Err(error) => {
                        cleanup(&scratch);
                        return Err(error);
                    }
                }
            }
        } else if video.is_none() {
            bail!("音频文件里没有音轨");
        }
    }
    let brand = if video.is_some() { Brand::Mp4 } else { Brand::M4a };
    let refs: Vec<&Path> = sources.iter().map(PathBuf::as_path).collect();
    let result = write::write(job.output, &refs, &tracks, brand, job.cancelled);
    cleanup(&scratch);
    if result.is_err() {
        let _ = std::fs::remove_file(job.output);
    }
    result
}

/// The audio track of `source` alone, as M4A: AAC copied, anything else symphonia decodes
/// (MP3, FLAC) re-encoded to AAC.
pub fn extract_audio(source: &Path, job: &Job) -> Result<()> {
    let movie = Movie::open(source)?;
    let track = movie.audio().context("文件里没有音轨")?;
    if job.offset_ms == 0 && track.aac().is_some() {
        return mux(None, Some(source), job);
    }
    let file = temp(job, "audio");
    let result = shifted_audio(source, track, &file, 0, job.offset_ms, AUDIO_BITRATE, job.cancelled)
        .and_then(|track| write::write(job.output, &[file.as_path()], &[track], Brand::M4a, job.cancelled));
    cleanup(&[file]);
    if result.is_err() {
        let _ = std::fs::remove_file(job.output);
    }
    result
}

fn cleanup(files: &[PathBuf]) {
    for file in files {
        let _ = std::fs::remove_file(file);
    }
}

/// Whether a re-encode with the offset can happen on this device.
pub fn offset_supported() -> bool {
    crate::aac::available()
}

/// Length of a media file as its container states it, adding up fragments (seconds).
pub fn duration_secs(path: &Path) -> Option<f64> {
    if !crate::mp4::read::looks_like_mp4(path) {
        return None;
    }
    Movie::open(path).ok().map(|m| m.duration_secs()).filter(|d| d.is_finite() && *d > 0.)
}
