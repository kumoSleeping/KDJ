//! The video track of an export: closed H.264 GOPs from the editor's encoders, appended
//! to a scratch file as MP4 samples while the export runs, numbered at the exact frame rate.

use crate::h264;
use crate::mp4::read::Movie;
use crate::mp4::write::{Edit, OutSample, OutTrack};
use anyhow::{ensure, Context, Result};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub struct VideoTrack {
    file: BufWriter<File>,
    path: PathBuf,
    source: usize,
    width: u32,
    height: u32,
    timescale: u32,
    tick: u32,
    offset: u64,
    samples: Vec<OutSample>,
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
}

impl VideoTrack {
    /// Samples go to `scratch`, which becomes writer source `source`.
    pub fn create(scratch: &Path, source: usize, width: u32, height: u32, fps: u32) -> Result<Self> {
        ensure!(fps > 0, "帧率无效");
        let timescale = if 90_000 % fps == 0 { 90_000 } else { fps * 1000 };
        let file = File::create(scratch).with_context(|| format!("创建临时视频失败：{}", scratch.display()))?;
        Ok(Self { file: BufWriter::with_capacity(4 << 20, file), path: scratch.to_path_buf(), source, width, height, timescale, tick: timescale / fps, offset: 0, samples: Vec::new(), sps: None, pps: None })
    }

    pub fn frames(&self) -> u64 {
        self.samples.len() as u64
    }

    /// Appends one closed GOP (Annex B, parameter sets before its key frame) and
    /// returns how many pictures it held. Every GOP must carry the same parameter sets.
    pub fn push_gop(&mut self, gop: &[u8]) -> Result<u64> {
        let units = h264::access_units(gop)?;
        ensure!(units.first().is_some_and(|u| u.key), "视频分段必须以关键帧开始");
        for unit in &units[0].units {
            let slot = match h264::nal_type(unit) {
                7 => &mut self.sps,
                8 => &mut self.pps,
                _ => continue,
            };
            match slot {
                Some(known) => ensure!(known.as_slice() == *unit, "视频分段的编码参数不一致"),
                None => *slot = Some(unit.to_vec()),
            }
        }
        ensure!(self.sps.is_some() && self.pps.is_some(), "视频分段缺少参数集");
        for unit in &units {
            let bytes = h264::sample_bytes(unit);
            ensure!(!bytes.is_empty(), "视频分段里有空画面");
            self.file.write_all(&bytes)?;
            self.samples.push(OutSample { source: self.source, offset: self.offset, size: bytes.len() as u32, duration: self.tick, cts: 0, sync: unit.key });
            self.offset += bytes.len() as u64;
        }
        Ok(units.len() as u64)
    }

    /// The finished track. The SPS is rewritten to say BT.709 limited range, which is
    /// what the editor's I420 frames are, whatever its encoder wrote.
    pub fn finish(mut self) -> Result<OutTrack> {
        self.file.flush()?;
        self.file.get_ref().sync_data()?;
        let sps = h264::sps_bt709_limited(self.sps.as_deref().context("没有视频画面")?)?;
        let (width, height) = h264::sps_dimensions(&sps)?;
        ensure!((width, height) == (self.width, self.height), "编码器输出的画面尺寸 {width}x{height} 与画布不符");
        let entry = h264::sample_entry(&sps, self.pps.as_deref().unwrap(), width, height)?;
        Ok(OutTrack { handler: *b"vide", timescale: self.timescale, language: crate::audio::LANGUAGE_UND, width, height, entries: vec![entry], samples: self.samples, edit: Edit::default() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// What a finished export holds, read back from the file.
#[derive(Clone, Debug, PartialEq)]
pub struct Checked {
    pub width: u32,
    pub height: u32,
    pub frames: u64,
    pub fps: f64,
    pub video_secs: f64,
    pub audio_secs: f64,
    pub audio_rate: u32,
}

/// Reads an exported MP4 back: one H.264 track and one AAC-LC track.
pub fn check(path: &Path) -> Result<Checked> {
    let movie = Movie::open(path)?;
    let video = movie.video().context("成品没有画面")?;
    let audio = movie.audio().context("成品没有音轨")?;
    ensure!(&video.codec() == b"avc1", "成品画面不是 H.264");
    let aac = audio.aac().context("成品音轨不是 AAC")?;
    let frames = video.samples.len() as u64;
    let video_secs = video.duration_secs();
    Ok(Checked {
        width: video.width,
        height: video.height,
        frames,
        fps: if video_secs > 0. { frames as f64 / video_secs } else { 0. },
        video_secs,
        audio_secs: audio.duration_secs(),
        audio_rate: aac.sample_rate,
    })
}
