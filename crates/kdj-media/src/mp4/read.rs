//! MP4 / M4A / DASH `.m4s` reading: tracks, their sample entries and every sample's
//! place in the file, from sample tables or from movie fragments. Media data is never
//! loaded; only `moov` and `moof` boxes are read.

use super::boxes::{child, children, Cursor};
use anyhow::{bail, ensure, Context, Result};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    pub offset: u64,
    pub size: u32,
    pub duration: u32,
    /// Composition offset from the decode time.
    pub cts: i32,
    pub sync: bool,
}

#[derive(Clone, Debug)]
pub struct Track {
    pub id: u32,
    pub handler: [u8; 4],
    pub timescale: u32,
    pub language: u16,
    /// From `tkhd`, in pixels.
    pub width: u32,
    pub height: u32,
    /// `stsd` entries, each a whole box; samples use the first.
    pub entries: Vec<Vec<u8>>,
    /// First non-empty edit's start, in media time; leading empty edits in movie time.
    pub edit_media_time: Option<i64>,
    pub edit_lead: u64,
    /// That edit's length in movie time, and the movie timescale.
    pub edit_duration: Option<u64>,
    pub movie_timescale: u32,
    pub samples: Vec<Sample>,
}

#[derive(Clone, Debug)]
pub struct Movie {
    pub timescale: u32,
    pub tracks: Vec<Track>,
}

impl Track {
    pub fn is_video(&self) -> bool {
        &self.handler == b"vide"
    }
    pub fn is_audio(&self) -> bool {
        &self.handler == b"soun"
    }
    /// Fourcc of the sample entry (`avc1`, `hev1`, `av01`, `mp4a`, `Opus`, `ec-3`, ...).
    pub fn codec(&self) -> [u8; 4] {
        self.entries.first().and_then(|e| e.get(4..8)).map_or(*b"    ", |k| k.try_into().unwrap())
    }
    pub fn media_duration(&self) -> u64 {
        self.samples.iter().map(|s| s.duration as u64).sum()
    }
    pub fn duration_secs(&self) -> f64 {
        if self.timescale == 0 {
            return 0.;
        }
        let start = self.edit_media_time.unwrap_or(0).max(0) as u64;
        let media = self.media_duration().saturating_sub(start) as f64 / self.timescale as f64;
        match self.edit_duration.filter(|&d| d > 0 && self.movie_timescale > 0) {
            Some(d) => media.min(d as f64 / self.movie_timescale as f64),
            None => media,
        }
    }
    /// When the track starts in the movie (seconds): its leading empty edit, as players and
    /// FFmpeg place it. A media start inside the first edit is trimmed, not moved.
    pub fn start_secs(&self) -> f64 {
        if self.movie_timescale == 0 {
            return 0.;
        }
        self.edit_lead as f64 / self.movie_timescale as f64
    }
    /// AAC configuration when the first sample entry is `mp4a` carrying MPEG-4 audio.
    pub fn aac(&self) -> Option<AacInfo> {
        let entry = self.entries.first()?;
        if entry.get(4..8)? != b"mp4a" {
            return None;
        }
        aac_info(&entry[8..]).ok().flatten()
    }
}

impl Movie {
    pub fn open(path: &Path) -> Result<Self> {
        let mut file = File::open(path).with_context(|| format!("打开媒体文件失败：{}", path.display()))?;
        read_movie(&mut file).with_context(|| format!("无法读取 MP4 结构：{}", path.display()))
    }
    pub fn video(&self) -> Option<&Track> {
        self.tracks.iter().find(|t| t.is_video() && !t.samples.is_empty())
    }
    pub fn audio(&self) -> Option<&Track> {
        self.tracks.iter().find(|t| t.is_audio() && !t.samples.is_empty())
    }
    pub fn duration_secs(&self) -> f64 {
        self.tracks.iter().filter(|t| !t.samples.is_empty()).map(Track::duration_secs).fold(0., f64::max)
    }
}

/// Whether a file starts like an ISO BMFF file (`ftyp`, `styp`, or a leading `moov`).
pub fn looks_like_mp4(path: &Path) -> bool {
    let mut head = [0u8; 12];
    File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && matches!(&head[4..8], b"ftyp" | b"styp" | b"moov" | b"free" | b"sidx")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AacInfo {
    pub object_type: u8,
    pub sample_rate: u32,
    pub channels: u8,
}

/// AAC parameters from an `mp4a` entry's `esds`, when it carries MPEG-4 audio.
fn aac_info(entry: &[u8]) -> Result<Option<AacInfo>> {
    // SampleEntry (8) + AudioSampleEntry v0 fields (20); v1/v2 QuickTime layouts add more.
    let mut c = Cursor::new(entry);
    c.skip(8)?;
    let version = c.u16()?;
    c.skip(6)?;
    let channels = c.u16()?;
    c.skip(6)?;
    let rate = c.u32()? >> 16;
    match version {
        1 => c.skip(16)?,
        2 => c.skip(36)?,
        _ => {}
    }
    let Some(esds) = child(c.rest(), b"esds")? else { return Ok(None) };
    let mut d = Cursor::new(esds.payload);
    d.skip(4)?;
    let Some(asc) = find_descriptor(&mut d)? else { return Ok(None) };
    let Some(object_type) = asc.0 else { return Ok(None) };
    if object_type != 0x40 {
        return Ok(None);
    }
    let config = asc.1;
    if config.len() < 2 {
        return Ok(Some(AacInfo { object_type: 2, sample_rate: rate, channels: channels as u8 }));
    }
    let mut bits = crate::bits::BitReader::new(&config);
    let mut aot = bits.bits(5)?;
    if aot == 31 {
        aot = 32 + bits.bits(6)?;
    }
    let index = bits.bits(4)?;
    let sample_rate = if index == 15 { bits.bits(24)? } else { *AAC_RATES.get(index as usize).unwrap_or(&rate) };
    let config_channels = bits.bits(4)?;
    Ok(Some(AacInfo {
        object_type: aot as u8,
        sample_rate,
        channels: if config_channels == 0 { channels as u8 } else { config_channels as u8 },
    }))
}

pub const AAC_RATES: [u32; 13] = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/// Walks ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo.
fn find_descriptor(c: &mut Cursor) -> Result<Option<(Option<u8>, Vec<u8>)>> {
    let mut object = None;
    while c.left() > 2 {
        let tag = c.u8()?;
        let mut length = 0usize;
        for _ in 0..4 {
            let byte = c.u8()?;
            length = length << 7 | (byte & 0x7f) as usize;
            if byte & 0x80 == 0 {
                break;
            }
        }
        match tag {
            3 => {
                c.skip(2)?;
                let flags = c.u8()?;
                if flags & 0x80 != 0 {
                    c.skip(2)?;
                }
                if flags & 0x40 != 0 {
                    let url = c.u8()? as usize;
                    c.skip(url)?;
                }
                if flags & 0x20 != 0 {
                    c.skip(2)?;
                }
            }
            4 => {
                object = Some(c.u8()?);
                c.skip(12)?;
            }
            5 => return Ok(Some((object, c.bytes(length.min(c.left()))?.to_vec()))),
            _ => c.skip(length.min(c.left()))?,
        }
    }
    Ok(object.map(|o| (Some(o), Vec::new())))
}

#[derive(Clone, Copy, Default)]
struct Trex {
    duration: u32,
    size: u32,
    flags: u32,
}

fn read_movie(file: &mut File) -> Result<Movie> {
    let length = file.metadata()?.len();
    let mut pos = 0u64;
    let mut movie: Option<Movie> = None;
    let mut trex: Vec<(u32, Trex)> = Vec::new();
    let mut fragments: Vec<(u64, Vec<u8>)> = Vec::new();
    while pos + 8 <= length {
        file.seek(SeekFrom::Start(pos))?;
        let mut header = [0u8; 16];
        file.read_exact(&mut header[..8])?;
        let kind: [u8; 4] = header[4..8].try_into().unwrap();
        let (head, size) = match u32::from_be_bytes(header[..4].try_into().unwrap()) {
            0 => (8, length - pos),
            1 => {
                file.read_exact(&mut header[8..16])?;
                (16, u64::from_be_bytes(header[8..16].try_into().unwrap()))
            }
            size => (8, size as u64),
        };
        ensure!(size >= head, "MP4 box 长度无效");
        // A file cut short (an interrupted download) keeps whatever whole boxes it has.
        let size = size.min(length - pos);
        match &kind {
            b"moov" | b"moof" => {
                ensure!(size < 256 * 1024 * 1024, "MP4 头部过大");
                let mut body = vec![0u8; (size - head) as usize];
                file.read_exact(&mut body)?;
                if &kind == b"moov" {
                    let (m, t) = parse_moov(&body)?;
                    movie = Some(m);
                    trex = t;
                } else {
                    fragments.push((pos, body));
                }
            }
            _ => {}
        }
        pos += size;
    }
    let mut movie = movie.context("文件里没有 moov")?;
    for (moof_start, body) in fragments {
        parse_moof(&mut movie, &trex, moof_start, &body)?;
    }
    movie.tracks.retain(|t| !t.entries.is_empty());
    Ok(movie)
}

fn parse_moov(body: &[u8]) -> Result<(Movie, Vec<(u32, Trex)>)> {
    let mut movie = Movie { timescale: 1000, tracks: Vec::new() };
    let mut trex = Vec::new();
    for box_ in children(body)? {
        match &box_.kind {
            b"mvhd" => {
                let mut c = Cursor::new(box_.payload);
                let (version, _) = c.version_flags()?;
                c.skip(if version == 1 { 16 } else { 8 })?;
                movie.timescale = c.u32()?.max(1);
            }
            b"trak" => movie.tracks.push(parse_trak(box_.payload, movie.timescale)?),
            b"mvex" => {
                for t in children(box_.payload)? {
                    if &t.kind == b"trex" {
                        let mut c = Cursor::new(t.payload);
                        c.version_flags()?;
                        let id = c.u32()?;
                        c.u32()?;
                        trex.push((id, Trex { duration: c.u32()?, size: c.u32()?, flags: c.u32()? }));
                    }
                }
            }
            _ => {}
        }
    }
    Ok((movie, trex))
}

fn parse_trak(body: &[u8], timescale: u32) -> Result<Track> {
    let mut track = Track {
        id: 0,
        handler: *b"    ",
        timescale: 0,
        language: 0x55c4,
        width: 0,
        height: 0,
        entries: Vec::new(),
        edit_media_time: None,
        edit_lead: 0,
        edit_duration: None,
        movie_timescale: timescale,
        samples: Vec::new(),
    };
    let tkhd = child(body, b"tkhd")?.context("trak 缺少 tkhd")?;
    let mut c = Cursor::new(tkhd.payload);
    let (version, _) = c.version_flags()?;
    c.skip(if version == 1 { 16 } else { 8 })?;
    track.id = c.u32()?;
    c.skip(4)?;
    c.skip(if version == 1 { 8 } else { 4 })?;
    c.skip(8 + 2 + 2 + 2 + 2 + 36)?;
    track.width = c.u32()? >> 16;
    track.height = c.u32()? >> 16;
    if let Some(edts) = child(body, b"edts")? {
        if let Some(elst) = child(edts.payload, b"elst")? {
            let mut c = Cursor::new(elst.payload);
            let (version, _) = c.version_flags()?;
            for _ in 0..c.u32()? {
                let (duration, time) = if version == 1 { (c.u64()?, c.i64()?) } else { (c.u32()? as u64, c.i32()? as i64) };
                c.skip(4)?;
                if time == -1 {
                    if track.edit_media_time.is_none() {
                        track.edit_lead += duration;
                    }
                } else if track.edit_media_time.is_none() {
                    track.edit_media_time = Some(time);
                    track.edit_duration = Some(duration);
                }
            }
        }
    }
    let mdia = child(body, b"mdia")?.context("trak 缺少 mdia")?;
    let mdhd = child(mdia.payload, b"mdhd")?.context("mdia 缺少 mdhd")?;
    let mut c = Cursor::new(mdhd.payload);
    let (version, _) = c.version_flags()?;
    c.skip(if version == 1 { 16 } else { 8 })?;
    track.timescale = c.u32()?;
    c.skip(if version == 1 { 8 } else { 4 })?;
    track.language = c.u16()?;
    if let Some(hdlr) = child(mdia.payload, b"hdlr")? {
        track.handler = hdlr.payload.get(8..12).context("hdlr 不完整")?.try_into().unwrap();
    }
    let Some(minf) = child(mdia.payload, b"minf")? else { return Ok(track) };
    let Some(stbl) = child(minf.payload, b"stbl")? else { return Ok(track) };
    let boxes = children(stbl.payload)?;
    let find = |kind: &[u8; 4]| boxes.iter().find(|b| &b.kind == kind).map(|b| b.payload);
    if let Some(stsd) = find(b"stsd") {
        let mut c = Cursor::new(stsd);
        c.version_flags()?;
        let count = c.u32()?;
        let entries = children(c.rest())?;
        ensure!(entries.len() as u32 >= count.min(1), "stsd 不完整");
        track.entries = entries.iter().map(|e| e.raw.to_vec()).collect();
    }
    let Some(stsz) = find(b"stsz").or(find(b"stz2")) else { return Ok(track) };
    let sizes = sample_sizes(stsz, find(b"stz2").is_some())?;
    if sizes.is_empty() {
        return Ok(track);
    }
    let mut durations = Vec::with_capacity(sizes.len());
    if let Some(stts) = find(b"stts") {
        let mut c = Cursor::new(stts);
        c.version_flags()?;
        for _ in 0..c.u32()? {
            let (count, delta) = (c.u32()?, c.u32()?);
            for _ in 0..count.min((sizes.len() - durations.len()) as u32) {
                durations.push(delta);
            }
        }
    }
    durations.resize(sizes.len(), *durations.last().unwrap_or(&0));
    let mut cts = vec![0i32; sizes.len()];
    if let Some(ctts) = find(b"ctts") {
        let mut c = Cursor::new(ctts);
        c.version_flags()?;
        let mut n = 0;
        for _ in 0..c.u32()? {
            let (count, offset) = (c.u32()?, c.i32()?);
            for _ in 0..count {
                if n < cts.len() {
                    cts[n] = offset;
                    n += 1;
                }
            }
        }
    }
    let sync: Option<Vec<u32>> = find(b"stss").map(|stss| {
        let mut c = Cursor::new(stss);
        let _ = c.version_flags();
        let count = c.u32().unwrap_or(0);
        (0..count).filter_map(|_| c.u32().ok()).collect()
    });
    let mut chunk_offsets = Vec::new();
    if let Some(stco) = find(b"stco") {
        let mut c = Cursor::new(stco);
        c.version_flags()?;
        for _ in 0..c.u32()? {
            chunk_offsets.push(c.u32()? as u64);
        }
    } else if let Some(co64) = find(b"co64") {
        let mut c = Cursor::new(co64);
        c.version_flags()?;
        for _ in 0..c.u32()? {
            chunk_offsets.push(c.u64()?);
        }
    }
    let mut stsc = Vec::new();
    if let Some(data) = find(b"stsc") {
        let mut c = Cursor::new(data);
        c.version_flags()?;
        for _ in 0..c.u32()? {
            stsc.push((c.u32()?, c.u32()?));
            c.u32()?;
        }
    }
    ensure!(!stsc.is_empty() && !chunk_offsets.is_empty(), "样本表缺少 stsc/stco");
    let mut n = 0usize;
    for (k, &(first, per)) in stsc.iter().enumerate() {
        let last = stsc.get(k + 1).map_or(chunk_offsets.len() as u32, |next| next.0 - 1);
        for chunk in first..=last {
            let Some(&base) = chunk_offsets.get(chunk as usize - 1) else { break };
            let mut offset = base;
            for _ in 0..per {
                if n >= sizes.len() {
                    break;
                }
                track.samples.push(Sample {
                    offset,
                    size: sizes[n],
                    duration: durations[n],
                    cts: cts[n],
                    sync: sync.as_ref().is_none_or(|s| s.binary_search(&(n as u32 + 1)).is_ok()),
                });
                offset += sizes[n] as u64;
                n += 1;
            }
        }
    }
    ensure!(n == sizes.len(), "样本表与 chunk 表不一致");
    Ok(track)
}

fn sample_sizes(data: &[u8], compact: bool) -> Result<Vec<u32>> {
    let mut c = Cursor::new(data);
    c.version_flags()?;
    if compact {
        let field = c.u32()? & 0xff;
        let count = c.u32()? as usize;
        let mut out = Vec::with_capacity(count);
        let mut bits = crate::bits::BitReader::new(c.rest());
        for _ in 0..count {
            out.push(bits.bits(field)?);
        }
        return Ok(out);
    }
    let fixed = c.u32()?;
    let count = c.u32()? as usize;
    ensure!(count < 100_000_000, "样本数量异常");
    if fixed != 0 {
        return Ok(vec![fixed; count]);
    }
    (0..count).map(|_| c.u32()).collect()
}

fn parse_moof(movie: &mut Movie, trex: &[(u32, Trex)], moof_start: u64, body: &[u8]) -> Result<()> {
    for traf in children(body)?.into_iter().filter(|b| &b.kind == b"traf") {
        let boxes = children(traf.payload)?;
        let tfhd = boxes.iter().find(|b| &b.kind == b"tfhd").context("traf 缺少 tfhd")?;
        let mut c = Cursor::new(tfhd.payload);
        let (_, flags) = c.version_flags()?;
        let id = c.u32()?;
        let defaults = trex.iter().find(|(t, _)| *t == id).map(|(_, d)| *d).unwrap_or_default();
        let mut base = moof_start;
        if flags & 0x1 != 0 {
            base = c.u64()?;
        }
        if flags & 0x2 != 0 {
            c.u32()?;
        }
        let duration = if flags & 0x8 != 0 { c.u32()? } else { defaults.duration };
        let size = if flags & 0x10 != 0 { c.u32()? } else { defaults.size };
        let sample_flags = if flags & 0x20 != 0 { c.u32()? } else { defaults.flags };
        let Some(track) = movie.tracks.iter_mut().find(|t| t.id == id) else { continue };
        let mut next = base;
        for trun in boxes.iter().filter(|b| &b.kind == b"trun") {
            let mut c = Cursor::new(trun.payload);
            let (version, flags) = c.version_flags()?;
            let count = c.u32()?;
            let mut offset = if flags & 0x1 != 0 { base.checked_add_signed(c.i32()? as i64).context("trun 偏移无效")? } else { next };
            let first_flags = if flags & 0x4 != 0 { Some(c.u32()?) } else { None };
            for n in 0..count {
                let d = if flags & 0x100 != 0 { c.u32()? } else { duration };
                let s = if flags & 0x200 != 0 { c.u32()? } else { size };
                let f = if flags & 0x400 != 0 { c.u32()? } else if n == 0 { first_flags.unwrap_or(sample_flags) } else { sample_flags };
                let cts = if flags & 0x800 != 0 {
                    let raw = c.u32()?;
                    if version == 0 { raw.min(i32::MAX as u32) as i32 } else { raw as i32 }
                } else {
                    0
                };
                track.samples.push(Sample { offset, size: s, duration: d, cts, sync: f & 0x0001_0000 == 0 });
                offset += s as u64;
            }
            next = offset;
        }
    }
    Ok(())
}

pub fn ensure_supported_entry(track: &Track) -> Result<()> {
    if track.entries.len() > 1 {
        bail!("暂不支持多个样本描述的轨道");
    }
    Ok(())
}
