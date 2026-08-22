use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use kdj_stems::classical::{ClassicalMode, ClassicalSeparator};
use kdj_stems::{
    decode_stereo_file, stem_tile_geometry, SAMPLE_RATE, SEGMENT_CONTEXT_SAMPLES,
    SEGMENT_CORE_SAMPLES, SEGMENT_SAMPLES,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Metrics {
    algorithm: &'static str,
    audio_seconds: f64,
    processing_ms: f64,
    realtime_factor: f64,
    cpu_ratio: Option<f64>,
    algorithmic_latency_ms: f64,
    first_block_ms: f64,
    seek_first_block_ms: f64,
    estimated_working_bytes: usize,
}

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let input = PathBuf::from(
        args.next()
            .context("usage: classical_stem_lab INPUT OUTPUT_DIR")?,
    );
    let output = PathBuf::from(
        args.next()
            .context("usage: classical_stem_lab INPUT OUTPUT_DIR")?,
    );
    if args.next().is_some() {
        bail!("usage: classical_stem_lab INPUT OUTPUT_DIR");
    }
    fs::create_dir_all(&output)?;
    let decoded = decode_stereo_file(&input)?;
    let mut reports = Vec::new();
    for (directory, mode, name) in [
        ("test-a", ClassicalMode::Center, "center-extraction"),
        ("test-b", ClassicalMode::Redress, "redress-soft-mask"),
    ] {
        let destination = output.join(directory);
        fs::create_dir_all(&destination)?;
        let (vocals, instrumental, metrics) = run_tiled(&decoded, mode, name)?;
        write_float_wav(&destination.join("vocals.wav"), &vocals)?;
        write_float_wav(&destination.join("instrumental.wav"), &instrumental)?;
        reports.push(metrics);
    }
    let json = serde_json::to_string_pretty(&reports)?;
    fs::write(output.join("metrics.json"), &json)?;
    println!("{json}");
    Ok(())
}

fn run_tiled(
    input: &[[f32; 2]],
    mode: ClassicalMode,
    name: &'static str,
) -> Result<(Vec<[f32; 2]>, Vec<[f32; 2]>, Metrics)> {
    let geometry = stem_tile_geometry();
    let mut separator = ClassicalSeparator::new(mode);
    let mut vocals = vec![[0.0, 0.0]; input.len()];
    let mut instrumental = vec![[0.0, 0.0]; input.len()];
    let cpu = CpuMeter::start();
    let started = Instant::now();
    let mut first_block_ms = 0.0;
    for (tile_index, core_start) in (0..input.len()).step_by(SEGMENT_CORE_SAMPLES).enumerate() {
        let tile = input_tile(input, core_start);
        let block_started = Instant::now();
        let separated = separator.process_stereo(&tile)?;
        if tile_index == 0 {
            first_block_ms = block_started.elapsed().as_secs_f64() * 1_000.0;
        }
        let copied = SEGMENT_CORE_SAMPLES.min(input.len() - core_start);
        vocals[core_start..core_start + copied].copy_from_slice(
            &separated.vocals[SEGMENT_CONTEXT_SAMPLES..SEGMENT_CONTEXT_SAMPLES + copied],
        );
        instrumental[core_start..core_start + copied].copy_from_slice(
            &separated.instrumental[SEGMENT_CONTEXT_SAMPLES..SEGMENT_CONTEXT_SAMPLES + copied],
        );
    }
    let processing = started.elapsed();
    let cpu_ratio = cpu.finish(processing);

    separator.reset();
    let seek_start = input.len().saturating_div(2);
    let seek_tile = input_tile(input, seek_start);
    let seek_started = Instant::now();
    let _ = separator.process_stereo(&seek_tile)?;
    let seek_first_block_ms = seek_started.elapsed().as_secs_f64() * 1_000.0;
    let audio_seconds = input.len() as f64 / f64::from(SAMPLE_RATE);
    let estimated_working_bytes = separator.workspace_bytes()
        + SEGMENT_SAMPLES * size_of::<[f32; 2]>() * 5
        + (vocals.len() + instrumental.len()) * size_of::<[f32; 2]>();
    let metrics = Metrics {
        algorithm: name,
        audio_seconds,
        processing_ms: processing.as_secs_f64() * 1_000.0,
        realtime_factor: processing.as_secs_f64() / audio_seconds.max(f64::EPSILON),
        cpu_ratio,
        algorithmic_latency_ms: separator.algorithmic_latency_frames() as f64
            / f64::from(SAMPLE_RATE)
            * 1_000.0,
        first_block_ms,
        seek_first_block_ms,
        estimated_working_bytes,
    };
    debug_assert_eq!(geometry.samples, SEGMENT_SAMPLES);
    Ok((vocals, instrumental, metrics))
}

fn input_tile(input: &[[f32; 2]], core_start: usize) -> Vec<[f32; 2]> {
    let mut tile = vec![[0.0, 0.0]; SEGMENT_SAMPLES];
    let source_start = core_start as isize - SEGMENT_CONTEXT_SAMPLES as isize;
    for (offset, frame) in tile.iter_mut().enumerate() {
        let source = source_start + offset as isize;
        if source >= 0 {
            if let Some(value) = input.get(source as usize) {
                *frame = *value;
            }
        }
    }
    tile
}

fn write_float_wav(path: &Path, samples: &[[f32; 2]]) -> Result<()> {
    let data_bytes = u32::try_from(samples.len().saturating_mul(8)).context("WAV too large")?;
    let mut writer = BufWriter::new(File::create(path)?);
    writer.write_all(b"RIFF")?;
    writer.write_all(&(36u32.saturating_add(data_bytes)).to_le_bytes())?;
    writer.write_all(b"WAVEfmt ")?;
    writer.write_all(&16u32.to_le_bytes())?;
    writer.write_all(&3u16.to_le_bytes())?; // IEEE float
    writer.write_all(&2u16.to_le_bytes())?;
    writer.write_all(&SAMPLE_RATE.to_le_bytes())?;
    writer.write_all(&(SAMPLE_RATE * 8).to_le_bytes())?;
    writer.write_all(&8u16.to_le_bytes())?;
    writer.write_all(&32u16.to_le_bytes())?;
    writer.write_all(b"data")?;
    writer.write_all(&data_bytes.to_le_bytes())?;
    for frame in samples {
        writer.write_all(&frame[0].to_le_bytes())?;
        writer.write_all(&frame[1].to_le_bytes())?;
    }
    writer.flush()?;
    Ok(())
}

struct CpuMeter {
    started_ns: Option<u64>,
}

impl CpuMeter {
    fn start() -> Self {
        Self {
            started_ns: process_cpu_ns(),
        }
    }

    fn finish(self, wall: std::time::Duration) -> Option<f64> {
        let cpu = process_cpu_ns()?.saturating_sub(self.started_ns?);
        Some(cpu as f64 / wall.as_nanos().max(1) as f64)
    }
}

#[cfg(target_os = "macos")]
fn process_cpu_ns() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    let usage = unsafe { usage.assume_init() };
    let timeval_ns =
        |value: libc::timeval| value.tv_sec as u64 * 1_000_000_000 + value.tv_usec as u64 * 1_000;
    Some(timeval_ns(usage.ru_utime) + timeval_ns(usage.ru_stime))
}

#[cfg(not(target_os = "macos"))]
fn process_cpu_ns() -> Option<u64> {
    None
}
