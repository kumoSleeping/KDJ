//! Read-only production/legacy overview and detail audit.
//!
//! This example is deliberately outside the Tauri runtime. `legacy_v0241_waveform` is a direct
//! transcription of tag v0.2.41's `band_waveform`; `current` calls the worktree production
//! analysis unchanged and applies the same fixed-column fit as `kdj-server`.

use std::env;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use kdj_analysis::decode::{decode_audio_native, resample_mono};
use kdj_analysis::dsp::{self, percentile};
use kdj_analysis::waveform::{
    analyze_waveform_evidence, band_energy, band_waveform_and_texture_with_evidence,
    detail_waveform_buckets, release_overview_waveform_with_detail_texture, RELEASE_OVERVIEW_SR,
    WAVEFORM_EVIDENCE_SR,
};
use kdj_core::models::Waveform;
use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;
use serde::Serialize;

const LEGACY_BUCKETS: usize = 640;
const CURRENT_BUCKETS: usize = 4_096;
const N_FFT: usize = 1_024;
const HOP: usize = 512;
const XOVER_LOW: f64 = 200.0;
const XOVER_HIGH: f64 = 1_500.0;
const AMP_GAMMA: f64 = 1.2;
const LEGACY_COLOR_GAMMA: f64 = 6.0;
const COLOR_FLOOR: f64 = 0.12;
const LEGACY_DETAIL_AMP_GAMMA: f64 = 0.90;
const DETAIL_COLOR_GAMMA: f64 = 2.4;
const DETAIL_COLOR_FLOOR: f64 = 0.06;

#[derive(Serialize)]
struct AuditPayload {
    schema: &'static str,
    source_path: String,
    title: String,
    legacy: ProfilePayload,
    current: ProfilePayload,
    legacy_detail: ProfilePayload,
    current_detail: ProfilePayload,
}

#[derive(Serialize)]
struct ProfilePayload {
    source_revision: &'static str,
    analysis_contract: &'static str,
    renderer_contract: &'static str,
    waveform: Waveform,
}

fn main() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let input = PathBuf::from(args.next().context("缺少输入歌曲路径")?);
    let output = PathBuf::from(args.next().context("缺少输出 JSON 路径")?);

    let decoded = decode_audio_native(&input, None)
        .with_context(|| format!("解码真实歌曲失败：{}", input.display()))?;
    let overview_samples = if decoded.sample_rate == RELEASE_OVERVIEW_SR {
        decoded.samples.clone()
    } else {
        resample_mono(&decoded.samples, decoded.sample_rate, RELEASE_OVERVIEW_SR)
    };
    let sample_rate = f64::from(RELEASE_OVERVIEW_SR);
    let legacy = legacy_v0241_waveform(&overview_samples, sample_rate, LEGACY_BUCKETS);
    let native_sample_rate = f64::from(decoded.sample_rate);
    let duration = decoded.samples.len() as f64 / native_sample_rate.max(1.0);
    let detail_buckets = detail_waveform_buckets(duration);
    let legacy_detail =
        legacy_pre_contour_detail_waveform(&decoded.samples, native_sample_rate, detail_buckets);
    let evidence_resampled = (decoded.sample_rate != WAVEFORM_EVIDENCE_SR)
        .then(|| resample_mono(&decoded.samples, decoded.sample_rate, WAVEFORM_EVIDENCE_SR));
    let evidence_samples = evidence_resampled.as_deref().unwrap_or(&decoded.samples);
    let evidence = analyze_waveform_evidence(evidence_samples, f64::from(WAVEFORM_EVIDENCE_SR));
    let (current_detail, detail_texture) = band_waveform_and_texture_with_evidence(
        evidence_samples,
        f64::from(WAVEFORM_EVIDENCE_SR),
        detail_buckets,
        &evidence,
    );
    let current = fit_release_overview_columns(
        release_overview_waveform_with_detail_texture(
            &overview_samples,
            sample_rate,
            CURRENT_BUCKETS,
            &evidence,
            &detail_texture,
        ),
        CURRENT_BUCKETS,
    );

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("创建审计目录失败：{}", parent.display()))?;
    }
    let payload = AuditPayload {
        schema: "kdj-waveform-structure-audit-v2",
        source_path: input.to_string_lossy().into_owned(),
        title: input
            .file_stem()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| input.to_string_lossy().into_owned()),
        legacy: ProfilePayload {
            source_revision: "tag v0.2.41 / fea301b26b410a41d5a04d7a4318f44c1814d56a",
            analysis_contract: "640 requested columns; 16 kHz STFT 1024/512; P5-P99 amplitude gamma 1.2; per-track relative band share; ~2 s colour smoothing; colour gamma 6.0; floor 0.12",
            renderer_contract: "v0.2.41 canvas: one CSS-pixel column; interval peak height; amplitude-weighted literal cached RGB; no display palette",
            waveform: legacy,
        },
        current: ProfilePayload {
            source_revision: "current worktree production path (not modified by this audit)",
            analysis_contract: "4096 fixed columns; release overview STFT; P5-P99 amplitude gamma 1.2; colour gamma 2.4; measured 1.05 s intra-section residual; wire-v2 contour present",
            renderer_contract: "current release-overview canvas: non-overlapping logical-pixel median height; amplitude-weighted RGB; approved low-dominance and saturation bounds",
            waveform: current,
        },
        legacy_detail: ProfilePayload {
            source_revision: "pre-contour baseline at HEAD 508a7cdf8981e255fcf12144191e6e962a83ba9e",
            analysis_contract: "native-rate complementary IIR bands; 100 columns/s capped at 24000; sqrt(RMS*peak) master; P99.5 amplitude gamma 0.90; 30 ms colour smoothing; colour gamma 2.4",
            renderer_contract: "pre-contour performance-detail canvas: interval peak height; one-physical-pixel colour footprint; symmetric solid RGB columns",
            waveform: legacy_detail,
        },
        current_detail: ProfilePayload {
            source_revision: "current worktree signed-contour production path (not modified by this audit)",
            analysis_contract: "44.1 kHz evidence PCM; 400 columns/s; hard symmetric crest geometry; 0.42 s measured intra-section residual; transient core channel",
            renderer_contract: "current performance-detail canvas: hard symmetric physical-pixel columns; interval peak pooling; linear-light RGB aggregation; transient core ownership",
            waveform: current_detail,
        },
    };
    let file =
        File::create(&output).with_context(|| format!("创建审计数据失败：{}", output.display()))?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer(&mut writer, &payload).context("写入审计数据失败")?;
    writer.flush()?;
    println!("legacy_columns={}", payload.legacy.waveform.amp.len());
    println!("current_columns={}", payload.current.waveform.amp.len());
    println!(
        "legacy_detail_columns={}",
        payload.legacy_detail.waveform.amp.len()
    );
    println!(
        "current_detail_columns={}",
        payload.current_detail.waveform.amp.len()
    );
    println!("output={}", output.display());
    Ok(())
}

/// Exact pre-contour detail analysis from repository HEAD before the signed waveform experiment.
/// `band_energy` and its 200 Hz master are unchanged in the worktree, so this only transcribes the
/// removed height normalisation while preserving the original colour calculation byte-for-byte.
fn legacy_pre_contour_detail_waveform(samples: &[f32], sr: f64, buckets: usize) -> Waveform {
    let energy = band_energy(samples, sr, buckets);
    let count = energy.overall.len();
    if count == 0 {
        return Waveform::default();
    }

    let mut overall = energy.overall;
    let mut magnitude = [energy.low, energy.mid, energy.high];
    let mut sorted = overall.clone();
    sorted.sort_by(f64::total_cmp);
    let hi = percentile(&sorted, 99.5).max(1e-9);
    for value in &mut overall {
        *value = (*value / hi).clamp(0.0, 1.0).powf(LEGACY_DETAIL_AMP_GAMMA);
    }

    let duration = samples.len() as f64 / sr.max(1.0);
    let columns_per_second = count as f64 / duration.max(1e-9);
    let span = if columns_per_second >= 20.0 { 3 } else { 1 };
    if count > span {
        for row in &mut magnitude {
            *row = dsp::moving_average(row, span);
        }
    }
    let share: [Vec<f64>; 3] = {
        let mut output = [vec![0.0; count], vec![0.0; count], vec![0.0; count]];
        for index in 0..count {
            let total =
                (magnitude[0][index] + magnitude[1][index] + magnitude[2][index]).max(1e-12);
            for band in 0..3 {
                output[band][index] = magnitude[band][index] / total;
            }
        }
        output
    };
    let reference: [f64; 3] = std::array::from_fn(|band| {
        let mut values = share[band].clone();
        let value = dsp::median(&mut values);
        if value <= 0.0 {
            1.0
        } else {
            value
        }
    });

    let mut red = vec![0u8; count];
    let mut green = vec![0u8; count];
    let mut blue = vec![0u8; count];
    for index in 0..count {
        let deviation: [f64; 3] = std::array::from_fn(|band| {
            (share[band][index] / reference[band]).powf(DETAIL_COLOR_GAMMA)
        });
        let peak = deviation.iter().copied().fold(0.0f64, f64::max).max(1e-9);
        let channels: [u8; 3] = std::array::from_fn(|band| {
            let normalized = (deviation[band] / peak).clamp(0.0, 1.0);
            let lifted = DETAIL_COLOR_FLOOR + (1.0 - DETAIL_COLOR_FLOOR) * normalized;
            (lifted * 255.0).round() as u8
        });
        red[index] = channels[0];
        green[index] = channels[1];
        blue[index] = channels[2];
    }

    Waveform {
        track_id: 0,
        duration: ((samples.len() as f64 / sr) * 1_000.0).round() / 1_000.0,
        amp: overall
            .into_iter()
            .map(|value| ((value * 10_000.0).round() / 10_000.0) as f32)
            .collect(),
        r: red,
        g: green,
        b: blue,
        ..Default::default()
    }
}

/// Exact v0.2.41 analysis contract (tag source: crates/kdj-analysis/src/waveform.rs).
fn legacy_v0241_waveform(samples: &[f32], sr: f64, buckets: usize) -> Waveform {
    let buckets = buckets.clamp(64, 2_000);
    let energies = legacy_band_energy_frames(samples, sr, N_FFT, HOP);
    let n_frames = energies[0].len();
    if n_frames == 0 {
        return Waveform::default();
    }
    let step = (n_frames / buckets).max(1);
    let count = n_frames / step;
    if count == 0 {
        return Waveform::default();
    }
    let mut bands = [
        vec![0.0f64; count],
        vec![0.0f64; count],
        vec![0.0f64; count],
    ];
    for (band, source) in bands.iter_mut().zip(&energies) {
        for (index, slot) in band.iter_mut().enumerate() {
            let start = index * step;
            *slot = source[start..start + step].iter().sum::<f64>() / step as f64;
        }
    }

    let mut amp: Vec<f64> = (0..count)
        .map(|index| (bands[0][index] + bands[1][index] + bands[2][index]).sqrt())
        .collect();
    let mut sorted = amp.clone();
    sorted.sort_by(f64::total_cmp);
    let hi = {
        let value = percentile(&sorted, 99.0);
        if value > 0.0 {
            value
        } else {
            1.0
        }
    };
    let lo = percentile(&sorted, 5.0);
    for value in &mut amp {
        *value = ((*value - lo) / (hi - lo).max(1e-9))
            .clamp(0.0, 1.0)
            .powf(AMP_GAMMA);
    }

    let mut magnitude: [Vec<f64>; 3] = [
        bands[0].iter().map(|value| value.sqrt()).collect(),
        bands[1].iter().map(|value| value.sqrt()).collect(),
        bands[2].iter().map(|value| value.sqrt()).collect(),
    ];
    let span = ((count / 128).max(3)) | 1;
    if count > span {
        for row in &mut magnitude {
            *row = dsp::moving_average(row, span);
        }
    }
    let share: [Vec<f64>; 3] = {
        let mut output = [vec![0.0; count], vec![0.0; count], vec![0.0; count]];
        for index in 0..count {
            let total =
                (magnitude[0][index] + magnitude[1][index] + magnitude[2][index]).max(1e-12);
            for band in 0..3 {
                output[band][index] = magnitude[band][index] / total;
            }
        }
        output
    };
    let reference: [f64; 3] = std::array::from_fn(|band| {
        let mut values = share[band].clone();
        let value = dsp::median(&mut values);
        if value <= 0.0 {
            1.0
        } else {
            value
        }
    });

    let mut red = vec![0u8; count];
    let mut green = vec![0u8; count];
    let mut blue = vec![0u8; count];
    for index in 0..count {
        let deviation: [f64; 3] = std::array::from_fn(|band| {
            (share[band][index] / reference[band]).powf(LEGACY_COLOR_GAMMA)
        });
        let peak = deviation.iter().copied().fold(0.0f64, f64::max).max(1e-9);
        let channels: [u8; 3] = std::array::from_fn(|band| {
            let normalized = (deviation[band] / peak).clamp(0.0, 1.0);
            let lifted = COLOR_FLOOR + (1.0 - COLOR_FLOOR) * normalized;
            (lifted * 255.0).round() as u8
        });
        red[index] = channels[0];
        green[index] = channels[1];
        blue[index] = channels[2];
    }

    Waveform {
        track_id: 0,
        duration: ((samples.len() as f64 / sr) * 1_000.0).round() / 1_000.0,
        amp: amp
            .into_iter()
            .map(|value| ((value * 10_000.0).round() / 10_000.0) as f32)
            .collect(),
        r: red,
        g: green,
        b: blue,
        ..Default::default()
    }
}

fn legacy_band_energy_frames(samples: &[f32], sr: f64, n_fft: usize, hop: usize) -> [Vec<f64>; 3] {
    if samples.len() < n_fft {
        return Default::default();
    }
    let bins = n_fft / 2 + 1;
    let frames = 1 + (samples.len() - n_fft) / hop;
    let window = dsp::hann_window(n_fft);
    let mut energies = [
        vec![0.0f64; frames],
        vec![0.0f64; frames],
        vec![0.0f64; frames],
    ];
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n_fft);
    let mut scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];
    let mut buffer = vec![Complex32::new(0.0, 0.0); n_fft];
    for frame in 0..frames {
        let start = frame * hop;
        for (index, slot) in buffer.iter_mut().enumerate() {
            *slot = Complex32::new(samples[start + index] * window[index] as f32, 0.0);
        }
        fft.process_with_scratch(&mut buffer, &mut scratch);
        for (bin, value) in buffer.iter().take(bins).enumerate() {
            let hz = bin as f64 * sr / n_fft as f64;
            let band = if hz < XOVER_LOW {
                0
            } else if hz < XOVER_HIGH {
                1
            } else {
                2
            };
            let magnitude = f64::from(value.norm());
            energies[band][frame] += magnitude * magnitude;
        }
    }
    energies
}

fn fit_release_overview_columns(wave: Waveform, columns: usize) -> Waveform {
    let source_len = wave.amp.len();
    if source_len == columns
        || source_len == 0
        || wave.r.len() != source_len
        || wave.g.len() != source_len
        || wave.b.len() != source_len
    {
        return wave;
    }
    let mut amp = Vec::with_capacity(columns);
    let mut red = Vec::with_capacity(columns);
    let mut green = Vec::with_capacity(columns);
    let mut blue = Vec::with_capacity(columns);
    for target in 0..columns {
        let start = target as f64 * source_len as f64 / columns as f64;
        let end = (target + 1) as f64 * source_len as f64 / columns as f64;
        let first = start.floor() as usize;
        let last = (end.ceil() as usize).min(source_len);
        let mut peak = 0.0f32;
        let mut r = 0.0f64;
        let mut g = 0.0f64;
        let mut b = 0.0f64;
        let mut total_weight = 0.0f64;
        for source in first..last {
            let overlap = (end.min((source + 1) as f64) - start.max(source as f64)).max(0.0);
            if overlap <= 0.0 {
                continue;
            }
            let value = wave.amp[source].clamp(0.0, 1.0);
            peak = peak.max(value);
            let weight = overlap * (f64::from(value) + 0.001);
            r += f64::from(wave.r[source]) * weight;
            g += f64::from(wave.g[source]) * weight;
            b += f64::from(wave.b[source]) * weight;
            total_weight += weight;
        }
        let fallback = first.min(source_len - 1);
        amp.push(peak);
        red.push(if total_weight > 0.0 {
            (r / total_weight).round() as u8
        } else {
            wave.r[fallback]
        });
        green.push(if total_weight > 0.0 {
            (g / total_weight).round() as u8
        } else {
            wave.g[fallback]
        });
        blue.push(if total_weight > 0.0 {
            (b / total_weight).round() as u8
        } else {
            wave.b[fallback]
        });
    }
    Waveform {
        track_id: wave.track_id,
        duration: wave.duration,
        amp,
        r: red,
        g: green,
        b: blue,
        ..Default::default()
    }
}
