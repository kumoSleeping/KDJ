//! WebM (Matroska) Opus into Ogg Opus, packet for packet: what `ffmpeg -c:a copy -f opus` did.

use anyhow::{bail, ensure, Context, Result};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

const SEGMENT: u32 = 0x1853_8067;
const TRACKS: u32 = 0x1654_ae6b;
const TRACK_ENTRY: u32 = 0xae;
const TRACK_NUMBER: u32 = 0xd7;
const TRACK_TYPE: u32 = 0x83;
const CODEC_ID: u32 = 0x86;
const CODEC_PRIVATE: u32 = 0x63a2;
const CODEC_DELAY: u32 = 0x56aa;
const AUDIO: u32 = 0xe1;
const CHANNELS: u32 = 0x9f;
const CLUSTER: u32 = 0x1f43_b675;
const SIMPLE_BLOCK: u32 = 0xa3;
const BLOCK_GROUP: u32 = 0xa0;
const BLOCK: u32 = 0xa1;
const DISCARD_PADDING: u32 = 0x75a2;
const UNKNOWN: u64 = u64::MAX;

struct Reader<R> {
    inner: R,
    pos: u64,
}

impl<R: Read + Seek> Reader<R> {
    fn byte(&mut self) -> Result<u8> {
        let mut b = [0u8];
        self.inner.read_exact(&mut b)?;
        self.pos += 1;
        Ok(b[0])
    }
    /// Element ID with its marker bits kept, as IDs are written.
    fn id(&mut self) -> Result<u32> {
        let first = self.byte()?;
        let len = first.leading_zeros() + 1;
        ensure!(len <= 4, "WebM 元素 ID 无效");
        let mut value = first as u32;
        for _ in 1..len {
            value = value << 8 | self.byte()? as u32;
        }
        Ok(value)
    }
    fn size(&mut self) -> Result<u64> {
        let first = self.byte()?;
        let len = first.leading_zeros() + 1;
        ensure!(len <= 8, "WebM 元素长度无效");
        let mut value = (first as u64) & ((1u64 << (8 - len)) - 1);
        let mut all_ones = value == (1u64 << (8 - len)) - 1;
        for _ in 1..len {
            let b = self.byte()?;
            all_ones &= b == 0xff;
            value = value << 8 | b as u64;
        }
        Ok(if all_ones { UNKNOWN } else { value })
    }
    fn bytes(&mut self, count: u64) -> Result<Vec<u8>> {
        ensure!(count < 64 << 20, "WebM 元素过大");
        let mut out = vec![0u8; count as usize];
        self.inner.read_exact(&mut out)?;
        self.pos += count;
        Ok(out)
    }
    fn skip(&mut self, count: u64) -> Result<()> {
        self.inner.seek(SeekFrom::Current(count as i64))?;
        self.pos += count;
        Ok(())
    }
}

fn uint(data: &[u8]) -> u64 {
    data.iter().fold(0, |v, &b| v << 8 | b as u64)
}

fn int(data: &[u8]) -> i64 {
    if data.is_empty() {
        return 0;
    }
    let shift = 64 - 8 * data.len() as u32;
    ((uint(data) << shift) as i64) >> shift
}

#[derive(Default)]
struct Opus {
    number: u64,
    head: Vec<u8>,
    channels: u8,
    delay_ns: u64,
}

fn read_track(r: &mut Reader<impl Read + Seek>, end: u64) -> Result<Option<Opus>> {
    let mut track = Opus::default();
    let (mut kind, mut codec) = (0, String::new());
    while r.pos < end {
        let (id, size) = (r.id()?, r.size()?);
        match id {
            TRACK_NUMBER => track.number = uint(&r.bytes(size)?),
            TRACK_TYPE => kind = uint(&r.bytes(size)?),
            CODEC_ID => codec = String::from_utf8_lossy(&r.bytes(size)?).into_owned(),
            CODEC_PRIVATE => track.head = r.bytes(size)?,
            CODEC_DELAY => track.delay_ns = uint(&r.bytes(size)?),
            AUDIO => {
                let stop = r.pos + size;
                while r.pos < stop {
                    let (id, size) = (r.id()?, r.size()?);
                    if id == CHANNELS {
                        track.channels = uint(&r.bytes(size)?) as u8;
                    } else {
                        r.skip(size)?;
                    }
                }
            }
            _ => r.skip(size)?,
        }
    }
    Ok((kind == 2 && codec == "A_OPUS").then_some(track))
}

/// Samples at 48 kHz in one Opus packet, from its TOC byte.
fn opus_samples(packet: &[u8]) -> u64 {
    let Some(&toc) = packet.first() else { return 0 };
    let config = toc >> 3;
    let frame = match config {
        0..=11 => [480, 960, 1920, 2880][(config % 4) as usize],
        12..=15 => [480, 960][(config % 2) as usize],
        _ => [120, 240, 480, 960][(config % 4) as usize],
    };
    let frames = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => packet.get(1).map_or(0, |b| (b & 0x3f) as u64),
    };
    frame * frames
}

fn crc(data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (n, slot) in t.iter_mut().enumerate() {
            let mut r = (n as u32) << 24;
            for _ in 0..8 {
                r = if r & 0x8000_0000 != 0 { r << 1 ^ 0x04c1_1db7 } else { r << 1 };
            }
            *slot = r;
        }
        t
    });
    data.iter().fold(0u32, |c, &b| c << 8 ^ table[((c >> 24) as u8 ^ b) as usize])
}

struct OggWriter<W> {
    out: W,
    serial: u32,
    sequence: u32,
}

impl<W: Write> OggWriter<W> {
    fn page(&mut self, packets: &[Vec<u8>], granule: i64, flags: u8) -> Result<()> {
        let mut lacing = Vec::new();
        for packet in packets {
            lacing.extend(std::iter::repeat_n(255u8, packet.len() / 255));
            lacing.push((packet.len() % 255) as u8);
        }
        ensure!(lacing.len() <= 255, "Ogg 页过大");
        let mut page = Vec::with_capacity(27 + lacing.len() + packets.iter().map(Vec::len).sum::<usize>());
        page.extend_from_slice(b"OggS");
        page.push(0);
        page.push(flags);
        page.extend_from_slice(&granule.to_le_bytes());
        page.extend_from_slice(&self.serial.to_le_bytes());
        page.extend_from_slice(&self.sequence.to_le_bytes());
        page.extend_from_slice(&[0; 4]);
        page.push(lacing.len() as u8);
        page.extend_from_slice(&lacing);
        for packet in packets {
            page.extend_from_slice(packet);
        }
        let sum = crc(&page);
        page[22..26].copy_from_slice(&sum.to_le_bytes());
        self.out.write_all(&page)?;
        self.sequence += 1;
        Ok(())
    }
}

/// Copies the first Opus track of the WebM file at `input` into an Ogg Opus file.
pub fn opus_to_ogg(input: &Path, output: &Path, cancelled: &dyn Fn() -> bool) -> Result<()> {
    let file = File::open(input).with_context(|| format!("打开 WebM 失败：{}", input.display()))?;
    let length = file.metadata()?.len();
    let mut r = Reader { inner: BufReader::with_capacity(1 << 20, file), pos: 0 };
    ensure!(r.id()? == 0x1a45_dfa3, "不是 WebM 文件");
    let size = r.size()?;
    r.skip(size)?;
    ensure!(r.id()? == SEGMENT, "WebM 缺少 Segment");
    let size = r.size()?;
    let segment_end = if size == UNKNOWN { length } else { (r.pos + size).min(length) };
    let mut opus: Option<Opus> = None;
    let mut ogg: Option<OggWriter<BufWriter<File>>> = None;
    let mut granule = 0u64;
    let mut page: Vec<Vec<u8>> = Vec::new();
    let mut page_bytes = 0usize;
    let mut discard = 0u64;
    let mut cluster_end = 0u64;
    while r.pos + 2 <= segment_end {
        if cancelled() {
            bail!("已取消");
        }
        let id = match r.id() {
            Ok(id) => id,
            Err(_) => break,
        };
        let size = r.size()?;
        match id {
            TRACKS => {
                let end = r.pos + size;
                while r.pos < end {
                    let (id, size) = (r.id()?, r.size()?);
                    if id == TRACK_ENTRY && opus.is_none() {
                        let stop = r.pos + size;
                        opus = read_track(&mut r, stop)?;
                    } else {
                        r.skip(size)?;
                    }
                }
            }
            // Clusters and block groups are entered, not skipped.
            CLUSTER => cluster_end = if size == UNKNOWN { segment_end } else { r.pos + size },
            BLOCK_GROUP => {}
            SIMPLE_BLOCK | BLOCK => {
                let data = r.bytes(size)?;
                let Some(track) = opus.as_ref() else { continue };
                let mut c = 0;
                let first = data[0];
                let len = first.leading_zeros() as usize + 1;
                let mut number = (first as u64) & ((1u64 << (8 - len)) - 1);
                for b in &data[1..len] {
                    number = number << 8 | *b as u64;
                }
                c += len;
                if number != track.number {
                    continue;
                }
                let flags = data[c + 2];
                c += 3;
                ensure!(flags & 0x06 == 0, "暂不支持带 lacing 的 WebM Opus");
                if ogg.is_none() {
                    let head = if track.head.starts_with(b"OpusHead") {
                        track.head.clone()
                    } else {
                        let mut head = b"OpusHead".to_vec();
                        head.push(1);
                        head.push(track.channels.max(1));
                        head.extend_from_slice(&((track.delay_ns * 48_000 / 1_000_000_000) as u16).to_le_bytes());
                        head.extend_from_slice(&48_000u32.to_le_bytes());
                        head.extend_from_slice(&[0, 0, 0]);
                        head
                    };
                    let pre_skip = u16::from_le_bytes([head[10], head[11]]) as u64;
                    let mut tags = b"OpusTags".to_vec();
                    let vendor = b"KDJ";
                    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
                    tags.extend_from_slice(vendor);
                    tags.extend_from_slice(&0u32.to_le_bytes());
                    let out = File::create(output).with_context(|| format!("创建 Ogg 文件失败：{}", output.display()))?;
                    let mut writer = OggWriter { out: BufWriter::new(out), serial: 0x4b44_4a01, sequence: 0 };
                    writer.page(&[head], 0, 0x02)?;
                    writer.page(&[tags], 0, 0)?;
                    ogg = Some(writer);
                    granule = pre_skip;
                }
                let packet = data[c..].to_vec();
                granule += opus_samples(&packet);
                page_bytes += packet.len();
                page.push(packet);
                if page.len() >= 50 || page_bytes > 32 * 1024 {
                    ogg.as_mut().unwrap().page(&page, granule as i64, 0)?;
                    page.clear();
                    page_bytes = 0;
                }
            }
            DISCARD_PADDING => {
                let padding = int(&r.bytes(size)?);
                discard = (padding.max(0) as u64) * 48_000 / 1_000_000_000;
            }
            _ => {
                if size == UNKNOWN {
                    bail!("WebM 元素长度未知");
                }
                r.skip(size)?;
            }
        }
        let _ = cluster_end;
    }
    let mut ogg = ogg.context("WebM 里没有 Opus 音频")?;
    let end = granule.saturating_sub(discard);
    ogg.page(&page, end as i64, 0x04)?;
    let mut out = ogg.out.into_inner().map_err(|e| e.into_error())?;
    out.flush()?;
    out.sync_data()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ogg_crc_matches_the_reference() {
        // CRC-32/OGG of "123456789".
        assert_eq!(crc(b"123456789"), 0x89a1_897f);
    }

    #[test]
    fn opus_packet_lengths() {
        assert_eq!(opus_samples(&[0xfc]), 960); // CELT 20 ms, one frame
        assert_eq!(opus_samples(&[0xfd]), 1920); // two frames
        assert_eq!(opus_samples(&[0x78]), 960); // hybrid 20 ms
    }
}
