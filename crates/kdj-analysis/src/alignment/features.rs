//! Reusable recording features. No PCM is retained after preparation.
use super::*;
use anyhow::ensure;
use std::io::{Read, Seek, SeekFrom, Write};

/// Bump whenever feature extraction or the binary layout changes.
pub const FEATURE_REVISION: u32 = 1;
/// Storage/working-set sizes, not limits on a recording's total duration.
pub const FEATURE_BLOCK_SECONDS: usize = 300;
pub const FEATURE_GUARD_SECONDS: usize = 30;
pub const FEATURE_MEMORY_BUDGET: usize = 32 * 1024 * 1024;
const MAGIC: &[u8; 8] = b"KDJALN01";

/// Small retrieval index. Spectra are only loaded after candidate selection.
pub struct AudioSummary {
    pub(super) envelope: Vec<f32>,
    pub(super) chroma: Vec<[f32; 12]>,
}

fn payload_bytes(samples: usize) -> usize {
    (samples / 400
        + samples.saturating_sub(FFT).div_ceil(HOP) * BANDS
        + samples.saturating_sub(2048).div_ceil(800) * 12)
        * 4
}

fn read_header(reader: &mut impl Read) -> Result<usize> {
    let mut header = [0u8; 20];
    reader.read_exact(&mut header)?;
    ensure!(&header[..8] == MAGIC, "无效的音频特征缓存");
    ensure!(
        u32::from_le_bytes(header[8..12].try_into()?) == FEATURE_REVISION,
        "音频特征版本已变化"
    );
    let samples = u64::from_le_bytes(header[12..20].try_into()?);
    // Bound allocations even for a damaged/untrusted cache header. The recording
    // itself may contain any number of these independently addressable blocks.
    ensure!(
        samples <= (FEATURE_MEMORY_BUDGET / 4) as u64,
        "音频特征块过大"
    );
    let samples = samples as usize;
    ensure!(
        payload_bytes(samples) <= FEATURE_MEMORY_BUDGET,
        "音频特征块过大"
    );
    Ok(samples)
}

impl AudioSummary {
    pub fn read_from(mut reader: impl Read + Seek) -> Result<Self> {
        let samples = read_header(&mut reader)?;
        ensure!(
            reader.seek(SeekFrom::End(0))? == (20 + payload_bytes(samples)) as u64,
            "音频特征缓存长度错误"
        );
        reader.seek(SeekFrom::Start(20))?;
        fn value(reader: &mut impl Read) -> Result<f32> {
            let mut bytes = [0; 4];
            reader.read_exact(&mut bytes)?;
            let value = f32::from_le_bytes(bytes);
            ensure!(value.is_finite(), "音频特征缓存包含无效数值");
            Ok(value)
        }
        let envelope = (0..samples / 400)
            .map(|_| value(&mut reader))
            .collect::<Result<Vec<_>>>()?;
        reader.seek(SeekFrom::Current(
            (samples.saturating_sub(FFT).div_ceil(HOP) * BANDS * 4) as i64,
        ))?;
        let mut chroma = Vec::new();
        for _ in 0..samples.saturating_sub(2048).div_ceil(800) {
            let mut frame = [0.; 12];
            for v in &mut frame {
                *v = value(&mut reader)?;
            }
            chroma.push(frame);
        }
        Ok(Self { envelope, chroma })
    }
}

pub struct AudioFeatures {
    pub(super) samples: usize,
    pub(super) envelope: Vec<f32>,
    pub(super) spectra: Vec<[f32; BANDS]>,
    pub(super) chroma: Vec<[f32; 12]>,
}

impl AudioFeatures {
    pub fn prepare(pcm: &[f32], canceled: impl Fn() -> bool) -> Result<Self> {
        Self::prepare_inner(pcm, &canceled)
    }

    // Keep the FFT/chroma loops in the optimized analysis crate even in tauri:dev.
    fn prepare_inner(pcm: &[f32], canceled: &dyn Fn() -> bool) -> Result<Self> {
        ensure!(pcm.iter().all(|v| v.is_finite()), "音频解码包含无效采样");
        if canceled() {
            bail!("匹配已取消")
        }
        Ok(Self {
            samples: pcm.len(),
            envelope: envelope(pcm),
            spectra: spectra(pcm, &canceled)?,
            chroma: fuzzy::chroma(pcm, &canceled)?,
        })
    }

    /// Fixed-size, little-endian floats; dimensions are derived from the sample
    /// count rather than trusting allocation lengths from a cache file.
    pub fn write_to(&self, mut writer: impl Write) -> Result<()> {
        writer.write_all(MAGIC)?;
        writer.write_all(&FEATURE_REVISION.to_le_bytes())?;
        writer.write_all(&(self.samples as u64).to_le_bytes())?;
        for value in self
            .envelope
            .iter()
            .chain(self.spectra.iter().flatten())
            .chain(self.chroma.iter().flatten())
        {
            writer.write_all(&value.to_le_bytes())?;
        }
        Ok(())
    }

    pub fn memory_bytes(&self) -> usize {
        (self.envelope.len() + self.spectra.len() * BANDS + self.chroma.len() * 12) * 4
    }

    pub fn summary(&self) -> AudioSummary {
        AudioSummary {
            envelope: self.envelope.clone(),
            chroma: self.chroma.clone(),
        }
    }

    pub fn duration_ms(&self) -> f64 {
        self.samples as f64 * 1000. / SAMPLE_RATE as f64
    }

    pub fn read_from(mut reader: impl Read) -> Result<Self> {
        let samples = read_header(&mut reader)?;
        let mut next = || -> Result<f32> {
            let mut bytes = [0; 4];
            reader.read_exact(&mut bytes)?;
            let value = f32::from_le_bytes(bytes);
            ensure!(value.is_finite(), "音频特征缓存包含无效数值");
            Ok(value)
        };
        let envelope = (0..samples / 400)
            .map(|_| next())
            .collect::<Result<Vec<_>>>()?;
        let mut spectra = Vec::new();
        for _ in 0..samples.saturating_sub(FFT).div_ceil(HOP) {
            let mut frame = [0.; BANDS];
            for value in &mut frame {
                *value = next()?;
            }
            spectra.push(frame);
        }
        let mut chroma = Vec::new();
        for _ in 0..samples.saturating_sub(2048).div_ceil(800) {
            let mut frame = [0.; 12];
            for value in &mut frame {
                *value = next()?;
            }
            chroma.push(frame);
        }
        ensure!(reader.read(&mut [0; 1])? == 0, "音频特征缓存长度错误");
        Ok(Self {
            samples,
            envelope,
            spectra,
            chroma,
        })
    }
}
