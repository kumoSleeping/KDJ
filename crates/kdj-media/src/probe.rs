//! What a media file holds, from its container alone: its picture's size, rate and colour, whether
//! its sound can be decoded, and how long each lasts. Nothing is decoded. The editor reads its
//! sources through this where it used to ask FFprobe.
//!
//! MP4 / MOV / M4A are read by [`crate::mp4`], Matroska / WebM by a small EBML walk of the segment
//! head, and any other sound by symphonia. Other video containers are refused by name.

use anyhow::{bail, Context, Result};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Picture {
    /// As shown: after the container's rotation and pixel aspect.
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// Sample entry fourcc (`avc1`, `hvc1`, …) or Matroska codec id (`V_VP9`, …).
    pub codec: String,
    /// PQ or HLG transfer, or Dolby Vision.
    pub hdr: bool,
    pub secs: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Probe {
    pub picture: Option<Picture>,
    /// The sound's length, when the file has sound symphonia can decode. Opus, AC-3 and other
    /// tracks it cannot decode count as no sound (docs/known-limitations.md).
    pub sound_secs: Option<f64>,
    /// Where the sound starts against the picture (seconds): the sound's leading empty edit
    /// less the picture's, as FFmpeg's stream start times put them.
    pub audio_shift_secs: f64,
}

/// Video containers the editor reads; the window's decoder (mediabunny) reads the same.
pub const VIDEO_CONTAINERS: &[&str] = &["mp4", "m4v", "mov", "mkv", "webm"];

pub fn probe(path: &Path) -> Result<Probe> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    if crate::mp4::read::looks_like_mp4(path) {
        return mp4(path);
    }
    if matroska_head(path) {
        return matroska(path);
    }
    if crate::pcm::inspect(path).is_ok() {
        let secs = crate::pcm::duration_secs(path).context("无法确定音频时长")?;
        return Ok(Probe { picture: None, sound_secs: crate::pcm::decodable(path).then_some(secs), audio_shift_secs: 0. });
    }
    if ["avi", "flv", "ts", "m2ts", "mts", "wmv", "mpg", "mpeg", "3gp", "rmvb"].contains(&ext.as_str()) {
        bail!("剪辑还不能读 .{ext} 视频：请先转成 MP4：{}", path.display())
    }
    bail!("无法识别的媒体文件：{}", path.display())
}

fn mp4(path: &Path) -> Result<Probe> {
    let movie = crate::mp4::read::Movie::open(path)?;
    let sound = movie.audio().filter(|_| crate::pcm::decodable(path));
    let picture = movie.video().map(|track| {
        let secs = track.duration_secs();
        let media = track.media_duration() as f64 / track.timescale.max(1) as f64;
        let entry = track.entries.first().map(Vec::as_slice).unwrap_or_default();
        let visual = visual_entry(entry);
        let (mut width, mut height) = match (track.width, track.height) {
            (0, _) | (_, 0) => (visual.width, visual.height),
            size => size,
        };
        if track.rotation % 180 == 90 {
            std::mem::swap(&mut width, &mut height);
        }
        let codec = String::from_utf8_lossy(&track.codec()).trim().to_string();
        Picture {
            width,
            height,
            fps: rate(track.samples.len() as f64, media),
            hdr: visual.hdr || matches!(codec.as_str(), "dvh1" | "dvhe" | "dvav" | "dva1"),
            codec,
            secs,
        }
    });
    if picture.is_none() && movie.audio().is_none() {
        bail!("文件里没有画面也没有声音：{}", path.display())
    }
    let shift = match (movie.audio(), movie.video()) {
        (Some(a), Some(v)) => a.start_secs() - v.start_secs(),
        _ => 0.,
    };
    Ok(Probe { picture, sound_secs: sound.map(|t| t.duration_secs()), audio_shift_secs: shift })
}

/// Frames per second from a count over a length; 30 when either is unknown.
fn rate(frames: f64, secs: f64) -> f64 {
    let fps = frames / secs;
    if fps.is_finite() && fps >= 1. { fps.min(240.) } else { 30. }
}

#[derive(Default)]
struct Visual {
    width: u32,
    height: u32,
    hdr: bool,
}

/// A VisualSampleEntry's coded size, pixel aspect (`pasp`) and colour (`colr`).
fn visual_entry(entry: &[u8]) -> Visual {
    // Box header (8), SampleEntry (8), then pre_defined/reserved (16) before width and height.
    const BOXES: usize = 8 + 78;
    let mut visual = Visual::default();
    let Some(size) = entry.get(32..36) else { return visual };
    visual.width = u16::from_be_bytes([size[0], size[1]]) as u32;
    visual.height = u16::from_be_bytes([size[2], size[3]]) as u32;
    let Ok(children) = crate::mp4::boxes::children(entry.get(BOXES..).unwrap_or_default()) else { return visual };
    for child in children {
        match &child.kind {
            b"pasp" if child.payload.len() >= 8 => {
                let h = u32::from_be_bytes(child.payload[0..4].try_into().unwrap());
                let v = u32::from_be_bytes(child.payload[4..8].try_into().unwrap());
                if h > 0 && v > 0 && h != v {
                    visual.width = (visual.width as u64 * h as u64 / v as u64) as u32;
                }
            }
            b"colr" if child.payload.len() >= 8 && matches!(&child.payload[0..4], b"nclx" | b"nclc") => {
                let transfer = u16::from_be_bytes([child.payload[6], child.payload[7]]);
                visual.hdr |= matches!(transfer, 16 | 18);
            }
            _ => {}
        }
    }
    visual
}

const EBML: u64 = 0x1a45_dfa3;
const SEGMENT: u64 = 0x1853_8067;
const INFO: u64 = 0x1549_a966;
const TIMESTAMP_SCALE: u64 = 0x2a_d7b1;
const DURATION: u64 = 0x4489;
const TRACKS: u64 = 0x1654_ae6b;
const TRACK_ENTRY: u64 = 0xae;
const TRACK_TYPE: u64 = 0x83;
const CODEC_ID: u64 = 0x86;
const DEFAULT_DURATION: u64 = 0x23_e383;
const VIDEO: u64 = 0xe0;
const PIXEL_WIDTH: u64 = 0xb0;
const PIXEL_HEIGHT: u64 = 0xba;
const DISPLAY_WIDTH: u64 = 0x54b0;
const DISPLAY_HEIGHT: u64 = 0x54ba;
const DISPLAY_UNIT: u64 = 0x54b2;
const COLOUR: u64 = 0x55b0;
const TRANSFER: u64 = 0x55ba;
const CLUSTER: u64 = 0x1f43_b675;
/// How far into a file the segment head is looked for.
const HEAD_LIMIT: u64 = 64 << 20;

fn matroska_head(path: &Path) -> bool {
    let mut head = [0u8; 4];
    File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && head == [0x1a, 0x45, 0xdf, 0xa3]
}

struct Ebml<R> {
    inner: R,
    pos: u64,
}

impl<R: Read + Seek> Ebml<R> {
    fn byte(&mut self) -> Result<u8> {
        let mut b = [0u8];
        self.inner.read_exact(&mut b)?;
        self.pos += 1;
        Ok(b[0])
    }
    /// A variable-length number: IDs keep their marker bit, sizes drop it. Sizes of all ones
    /// are unknown (`u64::MAX`).
    fn vint(&mut self, keep_marker: bool) -> Result<u64> {
        let first = self.byte()?;
        let len = first.leading_zeros() as usize + 1;
        if len > 8 {
            bail!("EBML 长度无效")
        }
        let mut value = if keep_marker { first as u64 } else { (first as u64) & (0xff >> len) };
        let mut all_ones = value == (0xff >> len) as u64;
        for _ in 1..len {
            let b = self.byte()?;
            all_ones &= b == 0xff;
            value = (value << 8) | b as u64;
        }
        Ok(if !keep_marker && all_ones { u64::MAX } else { value })
    }
    fn head(&mut self) -> Result<(u64, u64)> {
        Ok((self.vint(true)?, self.vint(false)?))
    }
    fn bytes(&mut self, size: u64) -> Result<Vec<u8>> {
        if size > 1 << 20 {
            bail!("EBML 元素过大")
        }
        let mut data = vec![0; size as usize];
        self.inner.read_exact(&mut data)?;
        self.pos += size;
        Ok(data)
    }
    fn skip(&mut self, size: u64) -> Result<()> {
        self.pos = self.inner.seek(SeekFrom::Current(size as i64))?;
        Ok(())
    }
}

fn uint(data: &[u8]) -> u64 {
    data.iter().fold(0, |v, &b| (v << 8) | b as u64)
}

fn float(data: &[u8]) -> f64 {
    match data.len() {
        4 => f32::from_be_bytes(data.try_into().unwrap()) as f64,
        8 => f64::from_be_bytes(data.try_into().unwrap()),
        _ => 0.,
    }
}

#[derive(Default)]
struct MkvTrack {
    kind: u64,
    codec: String,
    frame_ns: u64,
    width: u32,
    height: u32,
    display: Option<(u32, u32)>,
    hdr: bool,
}

fn matroska(path: &Path) -> Result<Probe> {
    let file = File::open(path).with_context(|| format!("打开媒体文件失败：{}", path.display()))?;
    let mut r = Ebml { inner: BufReader::new(file), pos: 0 };
    let (id, size) = r.head()?;
    if id != EBML {
        bail!("不是 Matroska 文件")
    }
    r.skip(size)?;
    let (id, size) = r.head()?;
    if id != SEGMENT {
        bail!("Matroska 缺少 Segment")
    }
    let end = if size == u64::MAX { u64::MAX } else { r.pos + size };
    let mut scale = 1_000_000u64;
    let mut duration = None;
    let mut tracks: Vec<MkvTrack> = vec![];
    let mut seen_tracks = false;
    while r.pos < end.min(HEAD_LIMIT) {
        let Ok((id, size)) = r.head() else { break };
        match id {
            INFO => {
                let stop = r.pos + size;
                while r.pos < stop {
                    let (id, size) = r.head()?;
                    match id {
                        TIMESTAMP_SCALE => scale = uint(&r.bytes(size)?).max(1),
                        DURATION => duration = Some(float(&r.bytes(size)?)),
                        _ => r.skip(size)?,
                    }
                }
            }
            TRACKS => {
                seen_tracks = true;
                let stop = r.pos + size;
                while r.pos < stop {
                    let (id, size) = r.head()?;
                    if id == TRACK_ENTRY {
                        tracks.push(track_entry(&mut r, size)?);
                    } else {
                        r.skip(size)?;
                    }
                }
            }
            CLUSTER => break,
            _ if size == u64::MAX => break,
            _ => r.skip(size)?,
        }
        if seen_tracks && duration.is_some() {
            break;
        }
    }
    let secs = duration.map(|d| d * scale as f64 / 1e9).filter(|s| s.is_finite() && *s > 0.);
    let video = tracks.iter().find(|t| t.kind == 1);
    let audio = tracks.iter().any(|t| t.kind == 2);
    let sound_secs = (audio && crate::pcm::decodable(path))
        .then(|| secs.or_else(|| crate::pcm::duration_secs(path)))
        .flatten();
    let picture = match video {
        Some(t) => {
            let secs = secs.with_context(|| format!("视频没有写明时长：{}", path.display()))?;
            let (width, height) = t.display.filter(|&(w, h)| w > 0 && h > 0).unwrap_or((t.width, t.height));
            let fps = if t.frame_ns > 0 { rate(1e9 / t.frame_ns as f64, 1.) } else { 30. };
            Some(Picture { width, height, fps, codec: t.codec.clone(), hdr: t.hdr, secs })
        }
        None => None,
    };
    if picture.is_none() && sound_secs.is_none() && !audio {
        bail!("文件里没有画面也没有声音：{}", path.display())
    }
    Ok(Probe { picture, sound_secs, audio_shift_secs: 0. })
}

fn track_entry<R: Read + Seek>(r: &mut Ebml<R>, size: u64) -> Result<MkvTrack> {
    let mut t = MkvTrack::default();
    let stop = r.pos + size;
    while r.pos < stop {
        let (id, size) = r.head()?;
        match id {
            TRACK_TYPE => t.kind = uint(&r.bytes(size)?),
            CODEC_ID => t.codec = String::from_utf8_lossy(&r.bytes(size)?).trim_end_matches('\0').to_string(),
            DEFAULT_DURATION => t.frame_ns = uint(&r.bytes(size)?),
            VIDEO => {
                let stop = r.pos + size;
                let mut unit = 0;
                let mut display = (0, 0);
                while r.pos < stop {
                    let (id, size) = r.head()?;
                    match id {
                        PIXEL_WIDTH => t.width = uint(&r.bytes(size)?) as u32,
                        PIXEL_HEIGHT => t.height = uint(&r.bytes(size)?) as u32,
                        DISPLAY_WIDTH => display.0 = uint(&r.bytes(size)?) as u32,
                        DISPLAY_HEIGHT => display.1 = uint(&r.bytes(size)?) as u32,
                        DISPLAY_UNIT => unit = uint(&r.bytes(size)?),
                        COLOUR => {
                            let stop = r.pos + size;
                            while r.pos < stop {
                                let (id, size) = r.head()?;
                                if id == TRANSFER {
                                    t.hdr = matches!(uint(&r.bytes(size)?), 16 | 18);
                                } else {
                                    r.skip(size)?;
                                }
                            }
                        }
                        _ => r.skip(size)?,
                    }
                }
                // Display sizes in other units (centimetres, an aspect ratio) only shape the
                // pixels: scale the width to that aspect.
                if display.0 > 0 && display.1 > 0 {
                    t.display = Some(if unit == 0 {
                        display
                    } else {
                        ((t.height as u64 * display.0 as u64 / display.1 as u64) as u32, t.height)
                    });
                }
            }
            _ => r.skip(size)?,
        }
    }
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_coded_size_is_read_from_the_sample_entry() {
        let mut entry = vec![0u8; 8 + 78];
        entry[32..34].copy_from_slice(&1920u16.to_be_bytes());
        entry[34..36].copy_from_slice(&1080u16.to_be_bytes());
        let visual = visual_entry(&entry);
        assert_eq!((visual.width, visual.height, visual.hdr), (1920, 1080, false));
    }

    #[test]
    fn pq_and_hlg_are_hdr() {
        for (transfer, hdr) in [(1u16, false), (16, true), (18, true)] {
            let mut entry = vec![0u8; 8 + 78];
            let mut colr = b"nclx".to_vec();
            colr.extend(9u16.to_be_bytes());
            colr.extend(transfer.to_be_bytes());
            colr.extend(9u16.to_be_bytes());
            colr.push(0);
            entry.extend(crate::mp4::boxes::mp4_box(b"colr", &colr));
            assert_eq!(visual_entry(&entry).hdr, hdr, "transfer {transfer}");
        }
    }

    #[test]
    fn rates_fall_back_to_thirty() {
        assert_eq!(rate(0., 0.), 30.);
        assert!((rate(2997., 100.) - 29.97).abs() < 1e-9);
    }

    #[test]
    fn ebml_sizes_drop_their_marker_and_ids_keep_it() {
        let data = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0, 0, 0, 0, 0x81, 0xff];
        let mut r = Ebml { inner: std::io::Cursor::new(&data[..]), pos: 0 };
        assert_eq!(r.head().unwrap(), (EBML, 4));
        r.skip(4).unwrap();
        assert_eq!(r.vint(false).unwrap(), 1);
        assert_eq!(r.vint(false).unwrap(), u64::MAX);
    }
}
