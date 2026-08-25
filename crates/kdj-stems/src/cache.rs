use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::RUNTIME_ID;

const MAGIC: &[u8; 8] = b"KDJSTEM1";
const VERSION: u16 = 1;
pub const HEADER_BYTES: u64 = 64;
pub const BYTES_PER_FRAME: u64 = 16;
pub const ALL_STEM_MASK: u8 = 0b1111;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StemKind {
    Drums,
    Bass,
    Other,
    Vocals,
}

impl StemKind {
    pub const ALL: [Self; 4] = [Self::Drums, Self::Bass, Self::Other, Self::Vocals];

    pub const fn index(self) -> usize {
        match self {
            Self::Drums => 0,
            Self::Bass => 1,
            Self::Other => 2,
            Self::Vocals => 3,
        }
    }

    pub const fn bit(self) -> u8 {
        1 << self.index()
    }
}

#[derive(Clone, Debug)]
pub struct StemCacheHeader {
    pub sample_rate: u32,
    pub frames: u64,
    pub source_mtime: i64,
    /// Stable algorithm fingerprint. This occupies the legacy 32-byte cache-header slot.
    pub algorithm_fingerprint: [u8; 32],
}

/// Historical random-access PCM cache writer. It owns only audio frames; STEM waveform sidecars
/// were removed with the display pipeline.
pub(crate) struct StemCacheWriter {
    destination: PathBuf,
    temporary: PathBuf,
    writer: File,
    header: StemCacheHeader,
    written_frames: u64,
}

impl StemCacheWriter {
    pub fn create(destination: &Path, header: StemCacheHeader) -> Result<Self> {
        let parent = destination.parent().context("STEM cache 没有父目录")?;
        fs::create_dir_all(parent)?;
        let temporary = destination.with_extension("kdstem.partial");
        let _ = fs::remove_file(&temporary);
        let mut writer = File::create(&temporary)?;
        write_header(&mut writer, &header)?;
        writer.set_len(HEADER_BYTES + header.frames.saturating_mul(BYTES_PER_FRAME))?;
        Ok(Self {
            destination: destination.to_path_buf(),
            temporary,
            writer,
            header,
            written_frames: 0,
        })
    }

    /// Writes one non-overlapping logical output block at its final timeline position.
    pub fn write_block(&mut self, start_frame: u64, frames: &[[[f32; 2]; 4]]) -> Result<()> {
        let frame_count = frames.len() as u64;
        if start_frame.saturating_add(frame_count) > self.header.frames {
            bail!("STEM block exceeds cache duration");
        }
        let mut bytes = vec![0u8; frames.len() * BYTES_PER_FRAME as usize];
        for (frame_index, stems) in frames.iter().enumerate() {
            for (stem_index, stereo) in stems.iter().enumerate() {
                for (channel, value) in stereo.iter().enumerate() {
                    let pcm =
                        (finite(*value).clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16;
                    let offset =
                        frame_index * BYTES_PER_FRAME as usize + (stem_index * 2 + channel) * 2;
                    bytes[offset..offset + 2].copy_from_slice(&pcm.to_le_bytes());
                }
            }
        }
        self.writer.seek(SeekFrom::Start(
            HEADER_BYTES + start_frame.saturating_mul(BYTES_PER_FRAME),
        ))?;
        self.writer.write_all(&bytes)?;
        self.written_frames = self.written_frames.saturating_add(frame_count);
        Ok(())
    }

    pub fn finish(mut self) -> Result<()> {
        if self.written_frames != self.header.frames {
            bail!(
                "STEM cache frames {} != expected {}",
                self.written_frames,
                self.header.frames
            );
        }
        self.writer.flush()?;
        self.writer.sync_all()?;
        drop(self.writer);
        let _ = fs::remove_file(&self.destination);
        fs::rename(&self.temporary, &self.destination)?;
        Ok(())
    }
}

pub fn read_cache_header(path: &Path) -> Result<StemCacheHeader> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut magic = [0u8; 8];
    reader.read_exact(&mut magic)?;
    if &magic != MAGIC {
        bail!("不是 KDJ STEM cache");
    }
    let version = read_u16(&mut reader)?;
    if version != VERSION {
        bail!("STEM cache version {version} != {VERSION}");
    }
    let mut small = [0u8; 2];
    reader.read_exact(&mut small)?;
    if small[0] != 4 {
        bail!("STEM cache 轨道数不是 4");
    }
    let sample_rate = read_u32(&mut reader)?;
    let frames = read_u64(&mut reader)?;
    let source_mtime = read_i64(&mut reader)?;
    let mut algorithm_fingerprint = [0u8; 32];
    reader.read_exact(&mut algorithm_fingerprint)?;
    let expected_len = HEADER_BYTES + frames.saturating_mul(BYTES_PER_FRAME);
    let actual_len = reader.get_ref().metadata()?.len();
    if actual_len != expected_len {
        bail!("STEM cache length {actual_len} != {expected_len}");
    }
    Ok(StemCacheHeader {
        sample_rate,
        frames,
        source_mtime,
        algorithm_fingerprint,
    })
}

pub(crate) fn algorithm_fingerprint() -> [u8; 32] {
    Sha256::digest(RUNTIME_ID.as_bytes()).into()
}

fn write_header(writer: &mut impl Write, header: &StemCacheHeader) -> Result<()> {
    writer.write_all(MAGIC)?;
    writer.write_all(&VERSION.to_le_bytes())?;
    writer.write_all(&[4, 0])?;
    writer.write_all(&header.sample_rate.to_le_bytes())?;
    writer.write_all(&header.frames.to_le_bytes())?;
    writer.write_all(&header.source_mtime.to_le_bytes())?;
    writer.write_all(&header.algorithm_fingerprint)?;
    Ok(())
}

fn finite(value: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

fn read_u16(reader: &mut impl Read) -> Result<u16> {
    let mut bytes = [0; 2];
    reader.read_exact(&mut bytes)?;
    Ok(u16::from_le_bytes(bytes))
}

fn read_u32(reader: &mut impl Read) -> Result<u32> {
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(reader: &mut impl Read) -> Result<u64> {
    let mut bytes = [0; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}

fn read_i64(reader: &mut impl Read) -> Result<i64> {
    let mut bytes = [0; 8];
    reader.read_exact(&mut bytes)?;
    Ok(i64::from_le_bytes(bytes))
}

/// Used by the player to seek directly to one cache frame.
pub fn seek_cache_frame(reader: &mut (impl Read + Seek), frame: u64) -> Result<()> {
    reader.seek(SeekFrom::Start(
        HEADER_BYTES + frame.saturating_mul(BYTES_PER_FRAME),
    ))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stem_bits_are_stable_across_cache_and_player() {
        assert_eq!(StemKind::Drums.bit(), 1);
        assert_eq!(StemKind::Bass.bit(), 2);
        assert_eq!(StemKind::Other.bit(), 4);
        assert_eq!(StemKind::Vocals.bit(), 8);
        assert_eq!(
            StemKind::ALL
                .into_iter()
                .fold(0, |mask, stem| mask | stem.bit()),
            ALL_STEM_MASK
        );
    }

    #[test]
    fn pcm_cache_writer_roundtrips_its_audio_header() {
        let destination = std::env::temp_dir().join(format!(
            "kdj-stem-audio-cache-{}.kdstem",
            std::process::id()
        ));
        let _ = fs::remove_file(&destination);
        let header = StemCacheHeader {
            sample_rate: 44_100,
            frames: 2,
            source_mtime: 7,
            algorithm_fingerprint: algorithm_fingerprint(),
        };
        let mut writer = StemCacheWriter::create(&destination, header.clone()).unwrap();
        writer
            .write_block(0, &[[[0.25, -0.25]; 4], [[0.5, -0.5]; 4]])
            .unwrap();
        writer.finish().unwrap();
        let loaded = read_cache_header(&destination).unwrap();
        assert_eq!(loaded.sample_rate, header.sample_rate);
        assert_eq!(loaded.frames, header.frames);
        assert_eq!(loaded.source_mtime, header.source_mtime);
        assert_eq!(loaded.algorithm_fingerprint, header.algorithm_fingerprint);
        let _ = fs::remove_file(destination);
    }
}
