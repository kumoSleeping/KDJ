//! Progressive MP4 writing: `ftyp`, then `moov`, then one interleaved `mdat` copied
//! from the source files, so a file plays while it is still being read ("faststart")
//! and nothing larger than one chunk is held in memory.

use super::boxes::{full_box, mp4_box, BoxBuf};
use anyhow::{bail, ensure, Context, Result};
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Movie timescale for `mvhd`, `tkhd` and edit durations.
const MOVIE_TIMESCALE: u32 = 1000;
/// Interleave in chunks of about this long, or this large.
const CHUNK_SECONDS: f64 = 0.5;
const CHUNK_BYTES: u64 = 1 << 20;

#[derive(Clone, Copy, Debug)]
pub struct OutSample {
    /// Index into the writer's sources.
    pub source: usize,
    pub offset: u64,
    pub size: u32,
    pub duration: u32,
    pub cts: i32,
    pub sync: bool,
}

/// What a track presents: `lead` of nothing, then media from `media_time` for
/// `duration` (both in the track's timescale). The default presents all samples.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Edit {
    pub lead: u64,
    pub media_time: i64,
    pub duration: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct OutTrack {
    pub handler: [u8; 4],
    pub timescale: u32,
    pub language: u16,
    pub width: u32,
    pub height: u32,
    /// Whole sample entry boxes; every sample uses the first.
    pub entries: Vec<Vec<u8>>,
    pub samples: Vec<OutSample>,
    pub edit: Edit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Brand {
    Mp4,
    M4a,
}

impl OutTrack {
    fn media_duration(&self) -> u64 {
        self.samples.iter().map(|s| s.duration as u64).sum()
    }
    /// Presentation length in the track's timescale.
    fn presented(&self) -> u64 {
        let media = self.edit.duration.unwrap_or_else(|| self.media_duration().saturating_sub(self.edit.media_time.max(0) as u64));
        self.edit.lead + media
    }
    fn needs_edit(&self) -> bool {
        self.edit.lead > 0 || self.edit.media_time != 0 || self.edit.duration.is_some()
    }
}

fn to_movie(value: u64, timescale: u32) -> u64 {
    ((value as u128 * MOVIE_TIMESCALE as u128 + timescale as u128 / 2) / timescale.max(1) as u128) as u64
}

#[derive(Clone, Copy)]
struct Chunk {
    track: usize,
    first: usize,
    count: usize,
    start: f64,
    bytes: u64,
}

fn chunks(tracks: &[OutTrack]) -> Vec<Chunk> {
    let mut out = Vec::new();
    for (t, track) in tracks.iter().enumerate() {
        let mut time = 0u64;
        let mut current: Option<Chunk> = None;
        for (n, sample) in track.samples.iter().enumerate() {
            let at = time as f64 / track.timescale as f64;
            let split = current.as_ref().is_some_and(|c| {
                at - c.start >= CHUNK_SECONDS || c.bytes + sample.size as u64 > CHUNK_BYTES || {
                    let last = &track.samples[c.first + c.count - 1];
                    last.source != sample.source
                }
            });
            if split {
                out.push(current.take().unwrap());
            }
            let chunk = current.get_or_insert(Chunk { track: t, first: n, count: 0, start: at, bytes: 0 });
            chunk.count += 1;
            chunk.bytes += sample.size as u64;
            time += sample.duration as u64;
        }
        out.extend(current);
    }
    out.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.track.cmp(&b.track)));
    out
}

fn ftyp(brand: Brand, tracks: &[OutTrack]) -> Vec<u8> {
    let mut b = BoxBuf::default();
    match brand {
        Brand::M4a => {
            b.bytes(b"M4A ");
            b.u32(0x200);
            b.bytes(b"M4A isommp42");
        }
        Brand::Mp4 => {
            b.bytes(b"isom");
            b.u32(0x200);
            b.bytes(b"isomiso2mp41");
            if tracks.iter().any(|t| t.entries.first().is_some_and(|e| e.get(4..8) == Some(b"avc1"))) {
                b.bytes(b"avc1");
            }
        }
    }
    mp4_box(b"ftyp", &b.0)
}

const MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

fn moov(tracks: &[OutTrack], layout: &[Chunk], offsets: &[u64], large: bool) -> Result<Vec<u8>> {
    let duration = tracks.iter().map(|t| to_movie(t.presented(), t.timescale)).max().unwrap_or(0);
    let mut mvhd = BoxBuf::default();
    mvhd.u64(0);
    mvhd.u64(0);
    mvhd.u32(MOVIE_TIMESCALE);
    mvhd.u64(duration);
    mvhd.u32(0x0001_0000);
    mvhd.u16(0x0100);
    mvhd.bytes(&[0; 10]);
    for value in MATRIX {
        mvhd.u32(value);
    }
    mvhd.bytes(&[0; 24]);
    mvhd.u32(tracks.len() as u32 + 1);
    let mut body = full_box(b"mvhd", 1, 0, &mvhd.0);
    for (t, track) in tracks.iter().enumerate() {
        let own: Vec<(usize, &Chunk)> = layout.iter().enumerate().filter(|(_, c)| c.track == t).collect();
        body.extend(trak(t as u32 + 1, track, &own, offsets, large)?);
    }
    Ok(mp4_box(b"moov", &body))
}

fn trak(id: u32, track: &OutTrack, own: &[(usize, &Chunk)], offsets: &[u64], large: bool) -> Result<Vec<u8>> {
    let video = &track.handler == b"vide";
    let mut tkhd = BoxBuf::default();
    tkhd.u64(0);
    tkhd.u64(0);
    tkhd.u32(id);
    tkhd.u32(0);
    tkhd.u64(to_movie(track.presented(), track.timescale));
    tkhd.bytes(&[0; 8]);
    tkhd.u16(0);
    tkhd.u16(0);
    tkhd.u16(if &track.handler == b"soun" { 0x0100 } else { 0 });
    tkhd.u16(0);
    for value in MATRIX {
        tkhd.u32(value);
    }
    tkhd.u32(if video { track.width << 16 } else { 0 });
    tkhd.u32(if video { track.height << 16 } else { 0 });
    let mut body = full_box(b"tkhd", 1, 3, &tkhd.0);
    if track.needs_edit() {
        let mut elst = BoxBuf::default();
        let entries = if track.edit.lead > 0 { 2 } else { 1 };
        elst.u32(entries);
        if track.edit.lead > 0 {
            elst.u64(to_movie(track.edit.lead, track.timescale));
            elst.u64(u64::MAX);
            elst.u32(0x0001_0000);
        }
        let media = track.presented() - track.edit.lead;
        elst.u64(to_movie(media, track.timescale));
        elst.u64(track.edit.media_time as u64);
        elst.u32(0x0001_0000);
        body.extend(mp4_box(b"edts", &full_box(b"elst", 1, 0, &elst.0)));
    }
    let mut mdhd = BoxBuf::default();
    mdhd.u64(0);
    mdhd.u64(0);
    mdhd.u32(track.timescale);
    mdhd.u64(track.media_duration());
    mdhd.u16(track.language);
    mdhd.u16(0);
    let mut mdia = full_box(b"mdhd", 1, 0, &mdhd.0);
    let mut hdlr = BoxBuf::default();
    hdlr.u32(0);
    hdlr.bytes(&track.handler);
    hdlr.bytes(&[0; 12]);
    hdlr.bytes(if video { b"VideoHandler\0" } else { b"SoundHandler\0" });
    mdia.extend(full_box(b"hdlr", 0, 0, &hdlr.0));
    let mut minf = if video {
        full_box(b"vmhd", 0, 1, &[0; 8])
    } else if &track.handler == b"soun" {
        full_box(b"smhd", 0, 0, &[0; 4])
    } else {
        full_box(b"nmhd", 0, 0, &[])
    };
    let mut dref = BoxBuf::default();
    dref.u32(1);
    dref.bytes(&full_box(b"url ", 0, 1, &[]));
    minf.extend(mp4_box(b"dinf", &full_box(b"dref", 0, 0, &dref.0)));
    minf.extend(stbl(track, own, offsets, large)?);
    mdia.extend(mp4_box(b"minf", &minf));
    body.extend(mp4_box(b"mdia", &mdia));
    Ok(mp4_box(b"trak", &body))
}

fn stbl(track: &OutTrack, own: &[(usize, &Chunk)], offsets: &[u64], large: bool) -> Result<Vec<u8>> {
    let mut stsd = BoxBuf::default();
    ensure!(!track.entries.is_empty(), "轨道缺少样本描述");
    stsd.u32(track.entries.len() as u32);
    for entry in &track.entries {
        stsd.bytes(entry);
    }
    let mut body = full_box(b"stsd", 0, 0, &stsd.0);
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for s in &track.samples {
        match runs.last_mut() {
            Some((count, delta)) if *delta == s.duration => *count += 1,
            _ => runs.push((1, s.duration)),
        }
    }
    let mut stts = BoxBuf::default();
    stts.u32(runs.len() as u32);
    for (count, delta) in runs {
        stts.u32(count);
        stts.u32(delta);
    }
    body.extend(full_box(b"stts", 0, 0, &stts.0));
    if track.samples.iter().any(|s| s.cts != 0) {
        let mut runs: Vec<(u32, i32)> = Vec::new();
        for s in &track.samples {
            match runs.last_mut() {
                Some((count, offset)) if *offset == s.cts => *count += 1,
                _ => runs.push((1, s.cts)),
            }
        }
        let mut ctts = BoxBuf::default();
        ctts.u32(runs.len() as u32);
        for (count, offset) in runs {
            ctts.u32(count);
            ctts.i32(offset);
        }
        let negative = track.samples.iter().any(|s| s.cts < 0);
        body.extend(full_box(b"ctts", if negative { 1 } else { 0 }, 0, &ctts.0));
    }
    if !track.samples.iter().all(|s| s.sync) {
        let mut stss = BoxBuf::default();
        let sync: Vec<u32> = track.samples.iter().enumerate().filter(|(_, s)| s.sync).map(|(n, _)| n as u32 + 1).collect();
        stss.u32(sync.len() as u32);
        for n in sync {
            stss.u32(n);
        }
        body.extend(full_box(b"stss", 0, 0, &stss.0));
    }
    let mut stsc = BoxBuf::default();
    let mut entries: Vec<(u32, u32)> = Vec::new();
    for (n, (_, chunk)) in own.iter().enumerate() {
        if entries.last().is_none_or(|e| e.1 != chunk.count as u32) {
            entries.push((n as u32 + 1, chunk.count as u32));
        }
    }
    stsc.u32(entries.len() as u32);
    for (first, per) in entries {
        stsc.u32(first);
        stsc.u32(per);
        stsc.u32(1);
    }
    body.extend(full_box(b"stsc", 0, 0, &stsc.0));
    let mut stsz = BoxBuf::default();
    stsz.u32(0);
    stsz.u32(track.samples.len() as u32);
    for s in &track.samples {
        stsz.u32(s.size);
    }
    body.extend(full_box(b"stsz", 0, 0, &stsz.0));
    let mut stco = BoxBuf::default();
    stco.u32(own.len() as u32);
    for (index, _) in own {
        if large {
            stco.u64(offsets[*index]);
        } else {
            stco.u32(u32::try_from(offsets[*index]).context("chunk 偏移超过 4 GiB")?);
        }
    }
    body.extend(full_box(if large { b"co64" } else { b"stco" }, 0, 0, &stco.0));
    Ok(mp4_box(b"stbl", &body))
}

/// Writes `tracks` to `output`, copying sample data from `sources`. `cancelled` is
/// polled between chunks; a cancelled write leaves a partial file for the caller to remove.
pub fn write(output: &Path, sources: &[&Path], tracks: &[OutTrack], brand: Brand, cancelled: &dyn Fn() -> bool) -> Result<()> {
    ensure!(!tracks.is_empty() && tracks.iter().all(|t| !t.samples.is_empty()), "没有可写入的媒体轨道");
    for track in tracks {
        ensure!(track.timescale > 0, "轨道时间刻度无效");
        ensure!(track.samples.iter().all(|s| s.source < sources.len()), "样本来源无效");
    }
    let layout = chunks(tracks);
    let payload: u64 = layout.iter().map(|c| c.bytes).sum();
    let large = payload > u32::MAX as u64 - (64 << 20);
    let ftyp = ftyp(brand, tracks);
    let mut offsets = vec![0u64; layout.len()];
    let moov_size = moov(tracks, &layout, &offsets, large)?.len() as u64;
    let mdat_header: u64 = if large { 16 } else { 8 };
    let mut at = ftyp.len() as u64 + moov_size + mdat_header;
    for (n, chunk) in layout.iter().enumerate() {
        offsets[n] = at;
        at += chunk.bytes;
    }
    let moov = moov(tracks, &layout, &offsets, large)?;
    ensure!(moov.len() as u64 == moov_size, "moov 长度不稳定");

    let mut files: Vec<File> = sources.iter().map(|p| File::open(p).with_context(|| format!("打开媒体来源失败：{}", p.display()))).collect::<Result<_>>()?;
    let mut out = BufWriter::with_capacity(1 << 20, File::create(output).with_context(|| format!("创建输出文件失败：{}", output.display()))?);
    out.write_all(&ftyp)?;
    out.write_all(&moov)?;
    if large {
        out.write_all(&1u32.to_be_bytes())?;
        out.write_all(b"mdat")?;
        out.write_all(&(payload + 16).to_be_bytes())?;
    } else {
        out.write_all(&((payload + 8) as u32).to_be_bytes())?;
        out.write_all(b"mdat")?;
    }
    let mut buffer = Vec::new();
    for chunk in &layout {
        if cancelled() {
            bail!("已取消");
        }
        let samples = &tracks[chunk.track].samples[chunk.first..chunk.first + chunk.count];
        // Runs of samples that sit back to back in their source are read at once.
        let mut n = 0;
        while n < samples.len() {
            let start = samples[n];
            let mut end = start.offset + start.size as u64;
            let mut m = n + 1;
            while m < samples.len() && samples[m].offset == end {
                end += samples[m].size as u64;
                m += 1;
            }
            let file = &mut files[start.source];
            file.seek(SeekFrom::Start(start.offset))?;
            buffer.resize((end - start.offset) as usize, 0);
            file.read_exact(&mut buffer).context("媒体来源比它的索引短，文件可能不完整")?;
            out.write_all(&buffer)?;
            n = m;
        }
    }
    let file = out.into_inner().map_err(|e| e.into_error())?;
    ensure!(file.metadata()?.len() == at, "写入的文件长度不符");
    Ok(())
}
