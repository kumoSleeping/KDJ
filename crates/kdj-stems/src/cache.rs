use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::{MODEL_ARCHIVE_SHA256, SAMPLE_RATE};

const MAGIC: &[u8; 8] = b"KDJSTEM1";
const VERSION: u16 = 1;
pub const HEADER_BYTES: u64 = 64;
pub const BYTES_PER_FRAME: u64 = 16;
pub const ALL_STEM_MASK: u8 = 0b1111;
const WAVE_COLUMNS_PER_SECOND: usize = 100;
const MAX_WAVE_COLUMNS: usize = 24_000;
const STEM_RGB_VERSION: u16 = 1;

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

    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "drums" => Some(Self::Drums),
            "bass" => Some(Self::Bass),
            "other" => Some(Self::Other),
            "vocals" => Some(Self::Vocals),
            _ => None,
        }
    }

    const fn cache_name(self) -> &'static str {
        match self {
            Self::Drums => "drums",
            Self::Bass => "bass",
            Self::Other => "other",
            Self::Vocals => "vocals",
        }
    }
}

#[derive(Clone, Debug)]
pub struct StemCacheHeader {
    pub sample_rate: u32,
    pub frames: u64,
    pub source_mtime: i64,
    pub model_sha256: [u8; 32],
}

#[derive(Clone, Debug, Serialize)]
pub struct StemWaveform {
    pub track_id: i64,
    pub duration: f64,
    pub amp: Vec<f32>,
    pub r: Vec<u8>,
    pub g: Vec<u8>,
    pub b: Vec<u8>,
    /// Full-timeline mask for centre-out progressive separation. Final caches contain all true;
    /// partial responses leave untouched time ranges false so the UI renders no fake baseline.
    pub known: Vec<bool>,
    /// Live-only scan origin/frontier in track seconds. Persistent waveform responses leave these
    /// empty; the frontend uses them for the immediate moving edge before first model output.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis_start: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis_frontier: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis_back_frontier: Option<f64>,
}

#[derive(Deserialize, Serialize)]
struct StemWaveformsFile {
    version: u16,
    sample_rate: u32,
    frames: u64,
    amp: [Vec<f32>; 4],
    #[serde(default)]
    known: Vec<bool>,
}

#[derive(Deserialize, Serialize)]
struct StemRgbFile {
    version: u16,
    sample_rate: u32,
    frames: u64,
    r: Vec<u8>,
    g: Vec<u8>,
    b: Vec<u8>,
}

pub(crate) struct StemCacheWriter {
    destination: PathBuf,
    temporary: PathBuf,
    wave_destination: PathBuf,
    wave_temporary: PathBuf,
    writer: File,
    header: StemCacheHeader,
    written_frames: u64,
    wave_amp: [Vec<f32>; 4],
    wave_known: Vec<bool>,
}

impl StemCacheWriter {
    pub fn create(destination: &Path, header: StemCacheHeader) -> Result<Self> {
        let parent = destination.parent().context("STEM cache 没有父目录")?;
        fs::create_dir_all(parent)?;
        let temporary = destination.with_extension("kdstem.partial");
        let wave_destination = waveform_path(destination);
        let wave_temporary = wave_destination.with_extension("json.partial");
        let _ = fs::remove_file(&temporary);
        let _ = fs::remove_file(&wave_temporary);
        for stem in StemKind::ALL {
            let _ = fs::remove_file(stem_rgb_path(destination, stem));
        }
        let mut writer = File::create(&temporary)?;
        write_header(&mut writer, &header)?;
        writer.set_len(HEADER_BYTES + header.frames.saturating_mul(BYTES_PER_FRAME))?;
        let wave_columns = header
            .frames
            .div_ceil(u64::from(SAMPLE_RATE) / WAVE_COLUMNS_PER_SECOND as u64)
            as usize;
        Ok(Self {
            destination: destination.to_path_buf(),
            temporary,
            wave_destination,
            wave_temporary,
            writer,
            header,
            written_frames: 0,
            wave_amp: std::array::from_fn(|_| vec![0.0; wave_columns]),
            wave_known: vec![false; wave_columns],
        })
    }

    /// Writes one non-overlapping logical output block at its final timeline position. Blocks may
    /// arrive in any order; this is what lets separation start around the loaded Deck position
    /// and expand outwards without publishing a corrupt sequential cache.
    pub fn write_block(&mut self, start_frame: u64, frames: &[[[f32; 2]; 4]]) -> Result<()> {
        let frame_count = frames.len() as u64;
        if start_frame.saturating_add(frame_count) > self.header.frames {
            bail!("STEM block exceeds cache duration");
        }
        let mut bytes = vec![0u8; frames.len() * BYTES_PER_FRAME as usize];
        let wave_frames = SAMPLE_RATE as usize / WAVE_COLUMNS_PER_SECOND;
        for (frame_index, stems) in frames.iter().enumerate() {
            let absolute_frame = start_frame as usize + frame_index;
            let wave_column = absolute_frame / wave_frames;
            if let Some(known) = self.wave_known.get_mut(wave_column) {
                *known = true;
            }
            for (stem_index, stereo) in stems.iter().enumerate() {
                if let Some(peak) = self.wave_amp[stem_index].get_mut(wave_column) {
                    *peak = peak.max(stereo[0].abs()).max(stereo[1].abs());
                }
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

    /// Atomically refreshes the sidecar consumed by the UI while the random-access cache remains
    /// private. Unknown columns stay genuinely empty instead of being stretched across the song.
    pub fn publish_progress(&self) -> Result<()> {
        let mut amplitudes = self.wave_amp.clone();
        for values in &mut amplitudes {
            normalize_known_amplitudes(values, &self.wave_known);
        }
        let waveforms = StemWaveformsFile {
            version: VERSION,
            sample_rate: self.header.sample_rate,
            frames: self.header.frames,
            amp: amplitudes,
            known: self.wave_known.clone(),
        };
        let staging = self.wave_temporary.with_extension("partial.next");
        let mut wave_file = BufWriter::new(File::create(&staging)?);
        serde_json::to_writer(&mut wave_file, &waveforms)?;
        wave_file.flush()?;
        drop(wave_file);
        let _ = fs::remove_file(&self.wave_temporary);
        fs::rename(staging, &self.wave_temporary)?;
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
        self.publish_progress()?;
        drop(self.writer);
        let _ = fs::remove_file(&self.destination);
        let _ = fs::remove_file(&self.wave_destination);
        fs::rename(&self.temporary, &self.destination)?;
        fs::rename(&self.wave_temporary, &self.wave_destination)?;
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
    let mut model_sha256 = [0u8; 32];
    reader.read_exact(&mut model_sha256)?;
    let expected_len = HEADER_BYTES + frames.saturating_mul(BYTES_PER_FRAME);
    let actual_len = reader.get_ref().metadata()?.len();
    if actual_len != expected_len {
        bail!("STEM cache length {actual_len} != {expected_len}");
    }
    Ok(StemCacheHeader {
        sample_rate,
        frames,
        source_mtime,
        model_sha256,
    })
}

pub fn stem_cache_waveform(
    cache_path: &Path,
    track_id: i64,
    stem: StemKind,
    columns: usize,
) -> Result<StemWaveform> {
    stem_cache_waveform_from_paths(
        cache_path,
        &waveform_path(cache_path),
        track_id,
        stem,
        columns,
        true,
    )
}

/// Reads either the final atomically-published waveform or the current centre-out progress
/// sidecar. The partial PCM cache is never returned to playback before all frames are complete.
pub fn stem_cache_waveform_progressive(
    cache_path: &Path,
    track_id: i64,
    stem: StemKind,
    columns: usize,
) -> Result<StemWaveform> {
    if cache_path.is_file() && waveform_path(cache_path).is_file() {
        return stem_cache_waveform(cache_path, track_id, stem, columns);
    }
    stem_cache_waveform_from_paths(
        &cache_path.with_extension("kdstem.partial"),
        &waveform_path(cache_path).with_extension("json.partial"),
        track_id,
        stem,
        columns,
        false,
    )
}

fn stem_cache_waveform_from_paths(
    cache_path: &Path,
    wave_path: &Path,
    track_id: i64,
    stem: StemKind,
    columns: usize,
    include_spectral_rgb: bool,
) -> Result<StemWaveform> {
    let header = read_cache_header(cache_path)?;
    let file: StemWaveformsFile = serde_json::from_reader(BufReader::new(File::open(wave_path)?))?;
    if file.version != VERSION
        || file.frames != header.frames
        || file.sample_rate != header.sample_rate
    {
        bail!("STEM waveform metadata 不匹配");
    }
    let requested = columns.clamp(64, MAX_WAVE_COLUMNS);
    let mut amp = file.amp[stem.index()].clone();
    let mut known = if file.known.len() == amp.len() {
        file.known
    } else {
        vec![true; amp.len()]
    };
    let color = stem_color(stem);
    let (mut red, mut green, mut blue) = if include_spectral_rgb {
        load_or_build_stem_rgb(cache_path, &header, stem, &amp)?
    } else {
        (
            vec![color[0]; amp.len()],
            vec![color[1]; amp.len()],
            vec![color[2]; amp.len()],
        )
    };
    if amp.len() > requested {
        [red, green, blue] = fit_rgb_columns(&red, &green, &blue, &amp, requested);
        amp = fit_amplitudes(&amp, requested);
        known = fit_known(&known, requested);
    }
    Ok(StemWaveform {
        track_id,
        duration: header.frames as f64 / f64::from(header.sample_rate),
        r: red,
        g: green,
        b: blue,
        amp,
        known,
        analysis_start: None,
        analysis_frontier: None,
        analysis_back_frontier: None,
    })
}

fn stem_rgb_path(cache_path: &Path, stem: StemKind) -> PathBuf {
    cache_path.with_extension(format!("{}.rgbwave.json", stem.cache_name()))
}

/// Final STEM caches created before RGB support already contain the separated PCM. Build one
/// small spectral-colour sidecar lazily from that PCM instead of forcing users to separate the
/// track again. New caches use the same path, so each stem is analysed at most once per cache.
fn load_or_build_stem_rgb(
    cache_path: &Path,
    header: &StemCacheHeader,
    stem: StemKind,
    amplitudes: &[f32],
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let path = stem_rgb_path(cache_path, stem);
    if let Ok(file) = File::open(&path) {
        if let Ok(cached) = serde_json::from_reader::<_, StemRgbFile>(BufReader::new(file)) {
            if cached.version == STEM_RGB_VERSION
                && cached.sample_rate == header.sample_rate
                && cached.frames == header.frames
                && cached.r.len() == amplitudes.len()
                && cached.g.len() == amplitudes.len()
                && cached.b.len() == amplitudes.len()
            {
                return Ok((cached.r, cached.g, cached.b));
            }
        }
    }

    let samples = read_stem_mono(cache_path, header.frames, stem)?;
    let wave = kdj_analysis::waveform::band_waveform(
        &samples,
        f64::from(header.sample_rate),
        amplitudes.len().clamp(64, MAX_WAVE_COLUMNS),
    );
    if wave.amp.is_empty()
        || wave.r.len() != wave.amp.len()
        || wave.g.len() != wave.amp.len()
        || wave.b.len() != wave.amp.len()
    {
        bail!("STEM RGB 波形分析没有生成有效频谱列");
    }
    let [red, green, blue] =
        fit_rgb_columns(&wave.r, &wave.g, &wave.b, &wave.amp, amplitudes.len());
    let cached = StemRgbFile {
        version: STEM_RGB_VERSION,
        sample_rate: header.sample_rate,
        frames: header.frames,
        r: red,
        g: green,
        b: blue,
    };
    write_stem_rgb(&path, &cached)?;
    Ok((cached.r, cached.g, cached.b))
}

fn read_stem_mono(cache_path: &Path, frames: u64, stem: StemKind) -> Result<Vec<f32>> {
    let sample_count = usize::try_from(frames).context("STEM cache 太长，无法生成 RGB 波形")?;
    let mut reader = BufReader::new(File::open(cache_path)?);
    reader.seek(SeekFrom::Start(HEADER_BYTES))?;
    let mut samples = Vec::with_capacity(sample_count);
    let mut remaining = sample_count;
    let sample_offset = stem.index() * 4;
    let mut bytes = vec![0u8; 8_192 * BYTES_PER_FRAME as usize];
    while remaining > 0 {
        let chunk_frames = remaining.min(8_192);
        let chunk_bytes = chunk_frames * BYTES_PER_FRAME as usize;
        reader.read_exact(&mut bytes[..chunk_bytes])?;
        for frame in bytes[..chunk_bytes].chunks_exact(BYTES_PER_FRAME as usize) {
            let left = i16::from_le_bytes([frame[sample_offset], frame[sample_offset + 1]]);
            let right = i16::from_le_bytes([frame[sample_offset + 2], frame[sample_offset + 3]]);
            samples.push((f32::from(left) + f32::from(right)) / (2.0 * f32::from(i16::MAX)));
        }
        remaining -= chunk_frames;
    }
    Ok(samples)
}

fn write_stem_rgb(path: &Path, waveform: &StemRgbFile) -> Result<()> {
    let staging = path.with_extension("rgbwave.json.partial");
    let mut writer = BufWriter::new(File::create(&staging)?);
    serde_json::to_writer(&mut writer, waveform)?;
    writer.flush()?;
    drop(writer);
    let _ = fs::remove_file(path);
    fs::rename(&staging, path)?;
    Ok(())
}

pub(crate) fn model_sha_bytes() -> [u8; 32] {
    let decoded = hex::decode(MODEL_ARCHIVE_SHA256).expect("constant model SHA is hex");
    decoded.try_into().expect("SHA-256 is 32 bytes")
}

pub fn waveform_path(cache_path: &Path) -> PathBuf {
    cache_path.with_extension("stemwaves.json")
}

fn write_header(writer: &mut impl Write, header: &StemCacheHeader) -> Result<()> {
    writer.write_all(MAGIC)?;
    writer.write_all(&VERSION.to_le_bytes())?;
    writer.write_all(&[4, 0])?;
    writer.write_all(&header.sample_rate.to_le_bytes())?;
    writer.write_all(&header.frames.to_le_bytes())?;
    writer.write_all(&header.source_mtime.to_le_bytes())?;
    writer.write_all(&header.model_sha256)?;
    Ok(())
}

fn normalize_known_amplitudes(values: &mut [f32], known: &[bool]) {
    if values.is_empty() {
        return;
    }
    let mut sorted: Vec<f32> = values
        .iter()
        .zip(known)
        .filter_map(|(value, known)| known.then_some(*value))
        .collect();
    if sorted.is_empty() {
        return;
    }
    sorted.sort_by(f32::total_cmp);
    let index = ((sorted.len() - 1) as f64 * 0.995).round() as usize;
    let scale = sorted[index].max(1e-6);
    for (value, known) in values.iter_mut().zip(known) {
        *value = if *known {
            (*value / scale).clamp(0.0, 1.0).powf(0.72)
        } else {
            0.0
        };
    }
}

fn fit_amplitudes(input: &[f32], output_len: usize) -> Vec<f32> {
    if input.len() <= output_len {
        return input.to_vec();
    }
    (0..output_len)
        .map(|index| {
            let start = index * input.len() / output_len;
            let end = ((index + 1) * input.len() / output_len).max(start + 1);
            input[start..end.min(input.len())]
                .iter()
                .copied()
                .fold(0.0f32, f32::max)
        })
        .collect()
}

fn fit_known(input: &[bool], output_len: usize) -> Vec<bool> {
    if input.len() <= output_len {
        return input.to_vec();
    }
    (0..output_len)
        .map(|index| {
            let start = index * input.len() / output_len;
            let end = ((index + 1) * input.len() / output_len).max(start + 1);
            input[start..end.min(input.len())]
                .iter()
                .any(|known| *known)
        })
        .collect()
}

fn fit_rgb_columns(
    red: &[u8],
    green: &[u8],
    blue: &[u8],
    amplitudes: &[f32],
    output_len: usize,
) -> [Vec<u8>; 3] {
    let source_len = amplitudes
        .len()
        .min(red.len())
        .min(green.len())
        .min(blue.len());
    if source_len == 0 || output_len == 0 {
        return Default::default();
    }
    if source_len == output_len {
        return [
            red[..source_len].to_vec(),
            green[..source_len].to_vec(),
            blue[..source_len].to_vec(),
        ];
    }
    if source_len < output_len {
        let mut output: [Vec<u8>; 3] = std::array::from_fn(|_| Vec::with_capacity(output_len));
        for index in 0..output_len {
            let source = if output_len > 1 {
                index as f64 * (source_len - 1) as f64 / (output_len - 1) as f64
            } else {
                0.0
            };
            let left = source.floor() as usize;
            let right = (left + 1).min(source_len - 1);
            let mix = source - left as f64;
            for (channel, values) in [red, green, blue].into_iter().enumerate() {
                output[channel].push(
                    (f64::from(values[left])
                        + (f64::from(values[right]) - f64::from(values[left])) * mix)
                        .round() as u8,
                );
            }
        }
        return output;
    }

    let mut output: [Vec<u8>; 3] = std::array::from_fn(|_| Vec::with_capacity(output_len));
    for target in 0..output_len {
        let start = target * source_len / output_len;
        let end = ((target + 1) * source_len / output_len)
            .max(start + 1)
            .min(source_len);
        let mut sums = [0.0f64; 3];
        let mut weight = 0.0f64;
        for index in start..end {
            let sample_weight = f64::from(amplitudes[index].max(0.0)) + 0.001;
            sums[0] += f64::from(red[index]) * sample_weight;
            sums[1] += f64::from(green[index]) * sample_weight;
            sums[2] += f64::from(blue[index]) * sample_weight;
            weight += sample_weight;
        }
        for channel in 0..3 {
            output[channel].push((sums[channel] / weight.max(1e-9)).round() as u8);
        }
    }
    output
}

fn stem_color(stem: StemKind) -> [u8; 3] {
    match stem {
        StemKind::Drums => [255, 145, 55],
        StemKind::Bass => [255, 65, 75],
        StemKind::Other => [125, 150, 255],
        // 人声用带一点蓝与黄的绿色，与 DJ 软件的人声惯例一致。
        StemKind::Vocals => [80, 216, 142],
    }
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
    fn progressive_writer_preserves_unknown_timeline_columns_until_their_block_arrives() {
        let destination = std::env::temp_dir().join(format!(
            "kdj-progressive-stem-{}.kdstem",
            std::process::id()
        ));
        let _ = fs::remove_file(&destination);
        let _ = fs::remove_file(destination.with_extension("kdstem.partial"));
        let _ = fs::remove_file(waveform_path(&destination));
        let _ = fs::remove_file(waveform_path(&destination).with_extension("json.partial"));
        let header = StemCacheHeader {
            sample_rate: SAMPLE_RATE,
            frames: 882,
            source_mtime: 7,
            model_sha256: model_sha_bytes(),
        };
        let frame = [[0.25, -0.25]; 4];
        let mut writer = StemCacheWriter::create(&destination, header).unwrap();
        writer.write_block(441, &vec![frame; 441]).unwrap();
        writer.publish_progress().unwrap();
        let partial =
            stem_cache_waveform_progressive(&destination, 9, StemKind::Drums, 64).unwrap();
        assert_eq!(partial.known, vec![false, true]);
        assert_eq!(partial.amp[0], 0.0);
        assert!(partial.amp[1] > 0.0);

        writer.write_block(0, &vec![frame; 441]).unwrap();
        writer.finish().unwrap();
        let complete = stem_cache_waveform(&destination, 9, StemKind::Drums, 64).unwrap();
        assert_eq!(complete.known, vec![true, true]);
        assert!(complete.amp.iter().all(|value| *value > 0.0));
        let _ = fs::remove_file(&destination);
        let _ = fs::remove_file(waveform_path(&destination));
        let _ = fs::remove_file(stem_rgb_path(&destination, StemKind::Drums));
    }

    #[test]
    fn final_stem_waveform_uses_its_own_spectral_rgb_instead_of_a_fixed_colour() {
        let destination =
            std::env::temp_dir().join(format!("kdj-rgb-stem-{}.kdstem", std::process::id()));
        let _ = fs::remove_file(&destination);
        let _ = fs::remove_file(waveform_path(&destination));
        let _ = fs::remove_file(stem_rgb_path(&destination, StemKind::Drums));
        let seconds = 4usize;
        let frame_count = SAMPLE_RATE as usize * seconds;
        let header = StemCacheHeader {
            sample_rate: SAMPLE_RATE,
            frames: frame_count as u64,
            source_mtime: 8,
            model_sha256: model_sha_bytes(),
        };
        let frames: Vec<[[f32; 2]; 4]> = (0..frame_count)
            .map(|index| {
                let frequency = if index < frame_count / 2 {
                    100.0
                } else {
                    5_000.0
                };
                let sample =
                    (std::f32::consts::TAU * frequency * index as f32 / SAMPLE_RATE as f32).sin()
                        * 0.5;
                [[sample, sample]; 4]
            })
            .collect();
        let mut writer = StemCacheWriter::create(&destination, header).unwrap();
        writer.write_block(0, &frames).unwrap();
        writer.finish().unwrap();

        let wave = stem_cache_waveform(&destination, 10, StemKind::Drums, 400).unwrap();
        let low = wave.amp.len() / 4;
        let high = wave.amp.len() * 3 / 4;
        assert!(
            wave.r[low] > wave.b[low],
            "low stem section should read red"
        );
        assert!(
            wave.b[high] > wave.r[high],
            "high stem section should read blue"
        );
        assert!(wave.r.iter().zip(&wave.b).any(|(red, blue)| red != blue));

        let _ = fs::remove_file(&destination);
        let _ = fs::remove_file(waveform_path(&destination));
        let _ = fs::remove_file(stem_rgb_path(&destination, StemKind::Drums));
    }
}
