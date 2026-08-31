//! Real-song timing audit for the two production waveform profiles.
//!
//! It times the shipped analysis stages and two superseded kernels side by side. The old kernels
//! are local to this example; they cannot enter the application runtime.

use std::collections::VecDeque;
use std::env;
use std::hint::black_box;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result};
use kdj_analysis::decode::{decode_audio_native, resample_mono};
use kdj_analysis::waveform::{
    analyze_waveform_evidence, analyze_waveform_evidence_preview_burst_cancellable,
    analyze_waveform_evidence_with_worker_limit, band_waveform_and_texture_with_evidence,
    detail_waveform_buckets, release_overview_waveform_with_detail_texture,
    release_overview_waveform_with_evidence, release_overview_waveform_with_evidence_cancellable,
    RELEASE_OVERVIEW_SR, WAVEFORM_EVIDENCE_SR,
};
use realfft::RealFftPlanner;
use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;
use serde::Serialize;

const N_FFT: usize = 2_048;
const HOP: usize = 256;
const OVERVIEW_COLUMNS: usize = 4_096;
const RUNS: usize = 3;

#[derive(Serialize)]
struct Report {
    source: String,
    duration_seconds: f64,
    columns: Columns,
    measured_ms: Measured,
    estimated_previous_ms: Profiles,
    optimized_ms: Profiles,
    speedup_percent: Profiles,
}

#[derive(Serialize)]
struct Columns {
    overview: usize,
    detail: usize,
}

#[derive(Serialize)]
struct Measured {
    evidence_real_fft: f64,
    evidence_workers: WorkerTimings,
    detail_stage: f64,
    overview_shared_texture: f64,
    overview_recomputed_texture: f64,
    old_complex_fft_kernel: f64,
    real_fft_kernel: f64,
    contiguous_window_scan_kernel: f64,
    block_window_scan_kernel: f64,
    rejected_sliding_window_kernel: f64,
}

#[derive(Serialize)]
struct WorkerTimings {
    one: f64,
    two: f64,
    four: f64,
    eight: f64,
}

#[derive(Serialize)]
struct WorkerSweep {
    workers: usize,
    median_ms: f64,
    runs_ms: Vec<f64>,
}

#[derive(Serialize)]
struct Profiles {
    overview_only: f64,
    detail_only: f64,
    overview_and_detail: f64,
}

fn main() -> Result<()> {
    let input = PathBuf::from(env::args_os().nth(1).context("缺少输入歌曲路径")?);
    let decode_started = Instant::now();
    let decoded = decode_audio_native(&input, None)
        .with_context(|| format!("解码真实歌曲失败：{}", input.display()))?;
    let decode_ms = decode_started.elapsed().as_secs_f64() * 1_000.0;
    let duration = decoded.samples.len() as f64 / f64::from(decoded.sample_rate).max(1.0);
    let evidence_resample_started = Instant::now();
    let evidence_resampled = (decoded.sample_rate != WAVEFORM_EVIDENCE_SR)
        .then(|| resample_mono(&decoded.samples, decoded.sample_rate, WAVEFORM_EVIDENCE_SR));
    let evidence_resample_ms = evidence_resample_started.elapsed().as_secs_f64() * 1_000.0;
    let evidence_samples = evidence_resampled.as_deref().unwrap_or(&decoded.samples);
    if env::args_os()
        .nth(2)
        .is_some_and(|mode| mode == "--production-once")
    {
        let evidence_started = Instant::now();
        let evidence = analyze_waveform_evidence_preview_burst_cancellable(
            evidence_samples,
            f64::from(WAVEFORM_EVIDENCE_SR),
            &|| false,
        )
        .context("生产预览证据计算被取消")?;
        let evidence_ms = evidence_started.elapsed().as_secs_f64() * 1_000.0;

        let release_resample_started = Instant::now();
        let release_resampled = (decoded.sample_rate != RELEASE_OVERVIEW_SR)
            .then(|| resample_mono(&decoded.samples, decoded.sample_rate, RELEASE_OVERVIEW_SR));
        let release_samples = release_resampled.as_deref().unwrap_or(&decoded.samples);
        let release_resample_ms = release_resample_started.elapsed().as_secs_f64() * 1_000.0;
        let release_started = Instant::now();
        let release = release_overview_waveform_with_evidence_cancellable(
            release_samples,
            f64::from(RELEASE_OVERVIEW_SR),
            OVERVIEW_COLUMNS,
            &evidence,
            &|| false,
        )
        .context("生产预览成图被取消")?;
        let release_ms = release_started.elapsed().as_secs_f64() * 1_000.0;

        // The product deliberately runs this as a later, single-worker background job. Decode it
        // again here as the server does instead of lending the interactive preview's PCM/evidence;
        // this keeps the reported budget honest for the proposed full-detail warmup.
        let detail_decode_started = Instant::now();
        let detail_decoded = decode_audio_native(&input, None)
            .with_context(|| format!("后台详细波形解码失败：{}", input.display()))?;
        let detail_decode_ms = detail_decode_started.elapsed().as_secs_f64() * 1_000.0;
        let detail_resample_started = Instant::now();
        let detail_resampled = (detail_decoded.sample_rate != WAVEFORM_EVIDENCE_SR).then(|| {
            resample_mono(
                &detail_decoded.samples,
                detail_decoded.sample_rate,
                WAVEFORM_EVIDENCE_SR,
            )
        });
        let detail_resample_ms = detail_resample_started.elapsed().as_secs_f64() * 1_000.0;
        let detail_samples = detail_resampled
            .as_deref()
            .unwrap_or(&detail_decoded.samples);
        let reused_detail_started = Instant::now();
        let (reused_detail, _) = band_waveform_and_texture_with_evidence(
            detail_samples,
            f64::from(WAVEFORM_EVIDENCE_SR),
            detail_waveform_buckets(duration),
            &evidence,
        );
        let reused_detail_render_ms = reused_detail_started.elapsed().as_secs_f64() * 1_000.0;
        let detail_evidence_started = Instant::now();
        let detail_evidence =
            analyze_waveform_evidence(detail_samples, f64::from(WAVEFORM_EVIDENCE_SR));
        let detail_evidence_ms = detail_evidence_started.elapsed().as_secs_f64() * 1_000.0;
        let detail_render_started = Instant::now();
        let (detail, _) = band_waveform_and_texture_with_evidence(
            detail_samples,
            f64::from(WAVEFORM_EVIDENCE_SR),
            detail_waveform_buckets(duration),
            &detail_evidence,
        );
        let detail_render_ms = detail_render_started.elapsed().as_secs_f64() * 1_000.0;
        assert_eq!(reused_detail.amp, detail.amp);
        assert_eq!(reused_detail.minimum, detail.minimum);
        assert_eq!(reused_detail.maximum, detail.maximum);
        assert_eq!(reused_detail.r, detail.r);
        assert_eq!(reused_detail.g, detail.g);
        assert_eq!(reused_detail.b, detail.b);
        assert_eq!(reused_detail.transient, detail.transient);
        let preview_total_ms =
            decode_ms + evidence_resample_ms + evidence_ms + release_resample_ms + release_ms;
        let background_detail_total_ms =
            detail_decode_ms + detail_resample_ms + detail_evidence_ms + detail_render_ms;
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "source": input,
                "duration_seconds": duration,
                "columns": release.amp.len(),
                "decode_ms": decode_ms,
                "evidence_resample_ms": evidence_resample_ms,
                "evidence_ms": evidence_ms,
                "release_resample_ms": release_resample_ms,
                "release_ms": release_ms,
                "preview_total_ms": preview_total_ms,
                "background_detail": {
                    "columns": detail.amp.len(),
                    "decode_ms": detail_decode_ms,
                    "evidence_resample_ms": detail_resample_ms,
                    "before_reuse": {
                        "evidence_ms": detail_evidence_ms,
                        "render_ms": detail_render_ms,
                        "total_ms": background_detail_total_ms,
                    },
                    "after_reuse": {
                        "evidence_ms": 0.0,
                        "render_ms": reused_detail_render_ms,
                        "total_ms": detail_decode_ms + detail_resample_ms + reused_detail_render_ms,
                    },
                },
            }))?
        );
        return Ok(());
    }
    if env::args_os()
        .nth(2)
        .is_some_and(|mode| mode == "--worker-sweep")
    {
        println!(
            "{}",
            serde_json::to_string_pretty(&worker_sweep(evidence_samples))?
        );
        return Ok(());
    }
    let release_resampled = (decoded.sample_rate != RELEASE_OVERVIEW_SR)
        .then(|| resample_mono(&decoded.samples, decoded.sample_rate, RELEASE_OVERVIEW_SR));
    let release_samples = release_resampled.as_deref().unwrap_or(&decoded.samples);
    let detail_columns = detail_waveform_buckets(duration);

    // One untimed pass supplies stable borrowed evidence for the profile-stage measurements.
    let evidence = analyze_waveform_evidence(evidence_samples, f64::from(WAVEFORM_EVIDENCE_SR));
    let evidence_ms = median_ms(|| {
        let value = analyze_waveform_evidence(evidence_samples, f64::from(WAVEFORM_EVIDENCE_SR));
        black_box(value);
    });
    let evidence_worker_ms = WorkerTimings {
        one: evidence_worker_ms(evidence_samples, 1),
        two: evidence_worker_ms(evidence_samples, 2),
        four: evidence_worker_ms(evidence_samples, 4),
        eight: evidence_worker_ms(evidence_samples, 8),
    };
    let detail_ms = median_ms(|| {
        let value = band_waveform_and_texture_with_evidence(
            evidence_samples,
            f64::from(WAVEFORM_EVIDENCE_SR),
            detail_columns,
            &evidence,
        );
        black_box(value);
    });
    let (detail, texture) = band_waveform_and_texture_with_evidence(
        evidence_samples,
        f64::from(WAVEFORM_EVIDENCE_SR),
        detail_columns,
        &evidence,
    );
    let overview_shared_ms = median_ms(|| {
        let value = release_overview_waveform_with_detail_texture(
            release_samples,
            f64::from(RELEASE_OVERVIEW_SR),
            OVERVIEW_COLUMNS,
            &evidence,
            &texture,
        );
        black_box(value);
    });
    let overview_recomputed_ms = median_ms(|| {
        let value = release_overview_waveform_with_evidence(
            release_samples,
            f64::from(RELEASE_OVERVIEW_SR),
            OVERVIEW_COLUMNS,
            &evidence,
        );
        black_box(value);
    });

    let complex_fft_ms = median_ms(|| {
        black_box(complex_fft_kernel(evidence_samples));
    });
    let real_fft_ms = median_ms(|| {
        black_box(real_fft_kernel(evidence_samples));
    });
    let old_scan_ms = median_ms(|| {
        black_box(window_scan_kernel(evidence_samples, detail_columns));
    });
    let block_scan_ms = median_ms(|| {
        black_box(block_window_kernel(evidence_samples, detail_columns));
    });
    let sliding_ms = median_ms(|| {
        black_box(sliding_window_kernel(evidence_samples, detail_columns));
    });

    let fft_debt = (complex_fft_ms - real_fft_ms).max(0.0);
    let window_debt = (old_scan_ms - block_scan_ms).max(0.0);
    let previous_evidence_ms = evidence_worker_ms.one + fft_debt;
    let previous = Profiles {
        overview_only: previous_evidence_ms + overview_recomputed_ms,
        detail_only: previous_evidence_ms + detail_ms + window_debt,
        overview_and_detail: previous_evidence_ms
            + detail_ms
            + window_debt
            + overview_recomputed_ms,
    };
    let optimized = Profiles {
        overview_only: evidence_ms + overview_recomputed_ms,
        detail_only: evidence_ms + detail_ms,
        overview_and_detail: evidence_ms + detail_ms + overview_shared_ms,
    };
    let speedup = Profiles {
        overview_only: percent(previous.overview_only, optimized.overview_only),
        detail_only: percent(previous.detail_only, optimized.detail_only),
        overview_and_detail: percent(previous.overview_and_detail, optimized.overview_and_detail),
    };
    let report = Report {
        source: input.to_string_lossy().into_owned(),
        duration_seconds: duration,
        columns: Columns {
            overview: OVERVIEW_COLUMNS,
            detail: detail.amp.len(),
        },
        measured_ms: Measured {
            evidence_real_fft: evidence_ms,
            evidence_workers: evidence_worker_ms,
            detail_stage: detail_ms,
            overview_shared_texture: overview_shared_ms,
            overview_recomputed_texture: overview_recomputed_ms,
            old_complex_fft_kernel: complex_fft_ms,
            real_fft_kernel: real_fft_ms,
            contiguous_window_scan_kernel: old_scan_ms,
            block_window_scan_kernel: block_scan_ms,
            rejected_sliding_window_kernel: sliding_ms,
        },
        estimated_previous_ms: previous,
        optimized_ms: optimized,
        speedup_percent: speedup,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn median_ms(mut operation: impl FnMut()) -> f64 {
    let mut values = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let started = Instant::now();
        operation();
        values.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn evidence_worker_ms(samples: &[f32], workers: usize) -> f64 {
    median_ms(|| {
        let value = analyze_waveform_evidence_with_worker_limit(
            samples,
            f64::from(WAVEFORM_EVIDENCE_SR),
            workers,
        );
        black_box(value);
    })
}

fn worker_sweep(samples: &[f32]) -> Vec<WorkerSweep> {
    const FIRST: usize = 3;
    const LAST: usize = 8;
    const WIDTH: usize = LAST - FIRST + 1;
    let mut runs = vec![Vec::with_capacity(WIDTH); WIDTH];
    // Rotate the order over six rounds. Every worker count occupies every thermal/order position
    // exactly once, which keeps the hybrid-core comparison honest on Apple Silicon.
    for round in 0..WIDTH {
        for position in 0..WIDTH {
            let workers = FIRST + (position + round) % WIDTH;
            let started = Instant::now();
            let value = analyze_waveform_evidence_with_worker_limit(
                samples,
                f64::from(WAVEFORM_EVIDENCE_SR),
                workers,
            );
            black_box(value);
            runs[workers - FIRST].push(started.elapsed().as_secs_f64() * 1_000.0);
        }
    }
    runs.into_iter()
        .enumerate()
        .map(|(index, runs_ms)| {
            let mut sorted = runs_ms.clone();
            sorted.sort_by(f64::total_cmp);
            let middle = sorted.len() / 2;
            let median_ms = (sorted[middle - 1] + sorted[middle]) * 0.5;
            WorkerSweep {
                workers: FIRST + index,
                median_ms,
                runs_ms,
            }
        })
        .collect()
}

fn percent(previous: f64, optimized: f64) -> f64 {
    ((previous - optimized) / previous.max(1e-9) * 100.0).max(0.0)
}

fn finite(samples: &[f32], index: usize) -> f64 {
    let value = samples[index];
    if value.is_finite() {
        f64::from(value)
    } else {
        0.0
    }
}

fn window_bounds(index: usize, samples: usize, count: usize, window: usize) -> (usize, usize) {
    let centre =
        (((index as f64 + 0.5) * samples as f64 / count as f64).floor() as usize).min(samples - 1);
    let start = centre.saturating_sub(window / 2).min(samples - window);
    (start, start + window)
}

fn window_scan_kernel(samples: &[f32], count: usize) -> f64 {
    let count = count.min(samples.len());
    let window = ((f64::from(WAVEFORM_EVIDENCE_SR) * 0.010).round() as usize)
        .max(1)
        .min(samples.len());
    let mut checksum = 0.0;
    for index in 0..count {
        let (start, end) = window_bounds(index, samples.len(), count, window);
        let mut minimum = 0.0f64;
        let mut maximum = 0.0f64;
        for source in start..end {
            let value = finite(samples, source);
            minimum = minimum.min(value);
            maximum = maximum.max(value);
        }
        checksum += maximum - minimum;
    }
    checksum
}

fn block_window_kernel(samples: &[f32], count: usize) -> f64 {
    const BLOCK: usize = 32;
    let count = count.min(samples.len());
    let window = ((f64::from(WAVEFORM_EVIDENCE_SR) * 0.010).round() as usize)
        .max(1)
        .min(samples.len());
    let mut block_minimum = Vec::with_capacity(samples.len().div_ceil(BLOCK));
    let mut block_maximum = Vec::with_capacity(samples.len().div_ceil(BLOCK));
    for chunk in samples.chunks(BLOCK) {
        let mut minimum = 0.0f64;
        let mut maximum = 0.0f64;
        for sample in chunk {
            let value = if sample.is_finite() {
                f64::from(*sample)
            } else {
                0.0
            };
            minimum = minimum.min(value);
            maximum = maximum.max(value);
        }
        block_minimum.push(minimum);
        block_maximum.push(maximum);
    }
    let mut checksum = 0.0;
    for index in 0..count {
        let (start, end) = window_bounds(index, samples.len(), count, window);
        let first_full = start.div_ceil(BLOCK);
        let last_full = end / BLOCK;
        let mut minimum = 0.0f64;
        let mut maximum = 0.0f64;
        if first_full >= last_full {
            for source in start..end {
                let value = finite(samples, source);
                minimum = minimum.min(value);
                maximum = maximum.max(value);
            }
        } else {
            for source in start..first_full * BLOCK {
                let value = finite(samples, source);
                minimum = minimum.min(value);
                maximum = maximum.max(value);
            }
            for block in first_full..last_full {
                minimum = minimum.min(block_minimum[block]);
                maximum = maximum.max(block_maximum[block]);
            }
            for source in last_full * BLOCK..end {
                let value = finite(samples, source);
                minimum = minimum.min(value);
                maximum = maximum.max(value);
            }
        }
        checksum += maximum - minimum;
    }
    checksum
}

fn sliding_window_kernel(samples: &[f32], count: usize) -> f64 {
    let count = count.min(samples.len());
    let window = ((f64::from(WAVEFORM_EVIDENCE_SR) * 0.010).round() as usize)
        .max(1)
        .min(samples.len());
    let mut minimum_queue = VecDeque::with_capacity(window);
    let mut maximum_queue = VecDeque::with_capacity(window);
    let mut loaded_end = 0usize;
    let mut checksum = 0.0;
    for index in 0..count {
        let (start, end) = window_bounds(index, samples.len(), count, window);
        if loaded_end < start {
            minimum_queue.clear();
            maximum_queue.clear();
            loaded_end = start;
        }
        while minimum_queue.front().is_some_and(|source| *source < start) {
            minimum_queue.pop_front();
        }
        while maximum_queue.front().is_some_and(|source| *source < start) {
            maximum_queue.pop_front();
        }
        for source in loaded_end..end {
            let value = finite(samples, source);
            while minimum_queue
                .back()
                .is_some_and(|previous| finite(samples, *previous) >= value)
            {
                minimum_queue.pop_back();
            }
            minimum_queue.push_back(source);
            while maximum_queue
                .back()
                .is_some_and(|previous| finite(samples, *previous) <= value)
            {
                maximum_queue.pop_back();
            }
            maximum_queue.push_back(source);
        }
        loaded_end = loaded_end.max(end);
        let minimum = minimum_queue
            .front()
            .map(|source| finite(samples, *source).min(0.0))
            .unwrap_or(0.0);
        let maximum = maximum_queue
            .front()
            .map(|source| finite(samples, *source).max(0.0))
            .unwrap_or(0.0);
        checksum += maximum - minimum;
    }
    checksum
}

fn hann(index: usize) -> f32 {
    let phase = 2.0 * std::f64::consts::PI * index as f64 / (N_FFT - 1) as f64;
    (0.5 - 0.5 * phase.cos()) as f32
}

fn complex_fft_kernel(samples: &[f32]) -> f64 {
    let frames = 1 + (samples.len().max(N_FFT) - N_FFT).div_ceil(HOP);
    let mut planner = FftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(N_FFT);
    let inverse = planner.plan_fft_inverse(N_FFT);
    let mut forward_scratch = vec![Complex32::default(); forward.get_inplace_scratch_len()];
    let mut inverse_scratch = vec![Complex32::default(); inverse.get_inplace_scratch_len()];
    let mut buffer = vec![Complex32::default(); N_FFT];
    let mut checksum = 0.0f64;
    for frame in 0..frames {
        let start = frame * HOP;
        for (offset, slot) in buffer.iter_mut().enumerate() {
            let sample = samples.get(start + offset).copied().unwrap_or(0.0);
            *slot = Complex32::new(
                if sample.is_finite() { sample } else { 0.0 } * hann(offset),
                0.0,
            );
        }
        forward.process_with_scratch(&mut buffer, &mut forward_scratch);
        checksum += f64::from(buffer[17].norm());
        for slot in &mut buffer {
            *slot = Complex32::new(slot.norm_sqr(), 0.0);
        }
        inverse.process_with_scratch(&mut buffer, &mut inverse_scratch);
        checksum += f64::from(buffer[211].re / buffer[0].re.max(1e-16));
    }
    checksum
}

fn real_fft_kernel(samples: &[f32]) -> f64 {
    let frames = 1 + (samples.len().max(N_FFT) - N_FFT).div_ceil(HOP);
    let mut planner = RealFftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(N_FFT);
    let inverse = planner.plan_fft_inverse(N_FFT);
    let mut forward_scratch = forward.make_scratch_vec();
    let mut inverse_scratch = inverse.make_scratch_vec();
    let mut input = forward.make_input_vec();
    let mut spectrum = forward.make_output_vec();
    let mut autocorrelation = inverse.make_output_vec();
    let mut checksum = 0.0f64;
    for frame in 0..frames {
        let start = frame * HOP;
        for (offset, slot) in input.iter_mut().enumerate() {
            let sample = samples.get(start + offset).copied().unwrap_or(0.0);
            *slot = if sample.is_finite() { sample } else { 0.0 } * hann(offset);
        }
        forward
            .process_with_scratch(&mut input, &mut spectrum, &mut forward_scratch)
            .expect("planner-defined buffers");
        checksum += f64::from(spectrum[17].norm());
        for slot in &mut spectrum {
            *slot = Complex32::new(slot.norm_sqr(), 0.0);
        }
        inverse
            .process_with_scratch(&mut spectrum, &mut autocorrelation, &mut inverse_scratch)
            .expect("planner-defined buffers");
        checksum += f64::from(autocorrelation[211] / autocorrelation[0].max(1e-16));
    }
    checksum
}
