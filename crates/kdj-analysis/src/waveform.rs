//! DJ RGB 波形：**每一列一根柱子**，高度 = 峰值/能量混合包络，颜色 = 这一列的频谱构成。
//!
//! Mixxx 的正式波形不是把低采样率 STFT 拉宽，而是先用低/中/高分频器连续处理 PCM，
//! 再把细粒度峰值包络聚合到屏幕列。这里采用同一条快路径：互补 IIR crossover 只扫
//! 一遍样本，生成 200 列/秒的 master，overview 做能量汇聚，局部 DJ 视图保留
//! 400 个独立时间柱/秒。10 ms 测量窗抑制载波相位毛刺，2.5 ms 的显示步进仍保留
//! 鼓点核心柱；持续响度墙会自适应腾出瞬态空间。
//!
//! 波形单开一条路径而不是塞进分析结果：它是纯展示用的，
//! 既不影响 BPM/调性，也不该逼用户为了看波形去重跑一次分析。

use kdj_core::models::Waveform;
use realfft::RealFftPlanner;
use rustfft::num_complex::Complex32;

use crate::dsp::{self, percentile};

/// 合成测试和显式降采样调用方的参考采样率。产品装轨快路径保留音源 native rate，
/// 避免为了展示波形跑整轨 sinc resample。
pub const WAVEFORM_SR: u32 = 22_050;
/// v0.2.41 整曲预览的固定采样率。普通/DJ overview 继续用这条历史路径，
/// 高密度滚动波形则保持 native-rate Mixxx 路径。
pub const RELEASE_OVERVIEW_SR: u32 = 16_000;
/// 普通歌曲按 400 列/秒保存详细波形；长曲再受总列数上限保护。
/// The approved detail profile keeps four independent evidence columns per 10 ms measurement
/// window. The windows overlap; the display timestamps do not.
pub const DETAIL_WAVEFORM_COLUMNS_PER_SECOND: f64 = 400.0;
pub const MAX_WAVEFORM_BUCKETS: usize = 100_000;
const MIN_DETAIL_WAVEFORM_BUCKETS: usize = 2_000;
/// Stable rate used by the evidence detector. Geometry and the semantic STFT therefore agree
/// across 44.1/48/96 kHz source files without changing the release-overview's historical 16 kHz
/// analysis path.
pub const WAVEFORM_EVIDENCE_SR: u32 = 44_100;

/// Full-track master density used by the local DJ viewport. One decode should
/// always materialise this profile; 640-column overviews downsample it.
pub fn detail_waveform_buckets(duration_sec: f64) -> usize {
    if !duration_sec.is_finite() || duration_sec <= 0.0 {
        return MIN_DETAIL_WAVEFORM_BUCKETS;
    }
    ((duration_sec * DETAIL_WAVEFORM_COLUMNS_PER_SECOND).ceil() as usize)
        .clamp(MIN_DETAIL_WAVEFORM_BUCKETS, MAX_WAVEFORM_BUCKETS)
}

const MASTER_COLUMNS_PER_SECOND: f64 = 200.0;
/// Mixxx AnalyzerWaveform 的 RGB 分频点。相较旧 200/1500 Hz，能把人声主体留在中频，
/// 也不会把 2–4 kHz 的存在感全部误画成镲片蓝色。
const XOVER_LOW: f64 = 600.0;
const XOVER_HIGH: f64 = 4000.0;
/// 接近线性的高度保留段落动态；仍略提弱尾音，但不再把整首歌抬成实心墙。
/// 温和强调相对频谱偏离。旧 γ=6 把很小的比例变化推成纯 RGB，长时间观看刺眼，
/// 相邻列也会像彩色噪点一样跳。2.4 仍能区分鼓、人声与镲片段，但保留混合层次。
const COLOR_GAMMA: f64 = 2.4;
/// 暗通道只留少量底色；最终显示 palette 会再映射到低饱和冷色系。
const COLOR_FLOOR: f64 = 0.06;

const EVIDENCE_N_FFT: usize = 2_048;
const EVIDENCE_HOP: usize = 256;
const EVIDENCE_LAG: usize = 2;
/// A blank, user-visible whole-track preview gets a short CPU burst. Four workers are the
/// measured knee: they materially shorten the empty rail without paying the tiny 4 -> 8 worker
/// gain or changing the conservative budget used by background/detail generation.
const INTERACTIVE_PREVIEW_EVIDENCE_WORKERS: usize = 4;
const EVIDENCE_FREQUENCY_MAX_RADIUS: usize = 2;
const DETAIL_SEMANTIC_MIX: f64 = 0.46;
const OVERVIEW_SEMANTIC_MIX: f64 = 0.24;
// The section colour remains the authority. These gains only restore measured short-time
// chromatic residuals around a local baseline, with a little more room inside single-colour runs.
const OVERVIEW_TEXTURE_BASE_GAIN: f64 = 0.08;
const OVERVIEW_TEXTURE_BLOCK_GAIN: f64 = 0.18;
const OVERVIEW_TEXTURE_SPAN_SECONDS: f64 = 1.05;
const DETAIL_TEXTURE_BASE_GAIN: f64 = 0.10;
const DETAIL_TEXTURE_BLOCK_GAIN: f64 = 0.25;
const DETAIL_TEXTURE_SPAN_SECONDS: f64 = 0.42;
const TEXTURE_CHANNEL_FLOOR: f64 = 0.025;
const TEXTURE_VALUE_FLOOR: f64 = 0.91;
const TEXTURE_VALUE_LIFT: f64 = 0.09;
const DETAIL_EXTREMA_BLOCK_SIZE: usize = 32;

/// Non-STEM acoustic evidence shared by the detail and release-overview profiles.
///
/// The three semantic axes are measurements rather than class labels: low-frequency positive
/// spectral change, sustained mid-band periodic/harmonic evidence, and high-frequency positive
/// spectral change. Assigning those coordinates to R/G/B is the only fixed colour convention.
#[derive(Debug, Default)]
pub struct WaveformEvidence {
    sample_rate: f64,
    frame_hz: f64,
    frame_count: usize,
    energy_low: Vec<f64>,
    energy_mid: Vec<f64>,
    energy_high: Vec<f64>,
    drum_core: Vec<f64>,
    semantic_low: Vec<f64>,
    semantic_mid: Vec<f64>,
    semantic_high: Vec<f64>,
}

#[derive(Clone, Copy)]
enum ContourProfile {
    Overview,
}

#[derive(Default)]
struct ContourGeometry {
    minimum: Vec<f32>,
    maximum: Vec<f32>,
    amp: Vec<f32>,
    transient: Vec<u8>,
}

#[derive(Clone, Copy, Default)]
struct BucketStats {
    minimum: f64,
    maximum: f64,
    peak: f64,
    rms: f64,
}

struct DetailScanCache {
    square_prefix: Vec<f64>,
    block_minimum: Vec<f64>,
    block_maximum: Vec<f64>,
}

impl DetailScanCache {
    fn new(samples: &[f32]) -> Self {
        let blocks = samples.len().div_ceil(DETAIL_EXTREMA_BLOCK_SIZE);
        let mut square_prefix = Vec::with_capacity(samples.len() + 1);
        let mut block_minimum = Vec::with_capacity(blocks);
        let mut block_maximum = Vec::with_capacity(blocks);
        let mut square_sum = 0.0f64;
        square_prefix.push(square_sum);
        for chunk in samples.chunks(DETAIL_EXTREMA_BLOCK_SIZE) {
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
                square_sum += value * value;
                square_prefix.push(square_sum);
            }
            block_minimum.push(minimum);
            block_maximum.push(maximum);
        }
        Self {
            square_prefix,
            block_minimum,
            block_maximum,
        }
    }

    fn extrema(&self, samples: &[f32], start: usize, end: usize) -> (f64, f64) {
        debug_assert!(start < end && end <= samples.len());
        let first_full = start.div_ceil(DETAIL_EXTREMA_BLOCK_SIZE);
        let last_full = end / DETAIL_EXTREMA_BLOCK_SIZE;
        let mut minimum = 0.0f64;
        let mut maximum = 0.0f64;
        if first_full >= last_full {
            for sample in &samples[start..end] {
                let value = if sample.is_finite() {
                    f64::from(*sample)
                } else {
                    0.0
                };
                minimum = minimum.min(value);
                maximum = maximum.max(value);
            }
            return (minimum, maximum);
        }
        for sample in &samples[start..first_full * DETAIL_EXTREMA_BLOCK_SIZE] {
            let value = if sample.is_finite() {
                f64::from(*sample)
            } else {
                0.0
            };
            minimum = minimum.min(value);
            maximum = maximum.max(value);
        }
        for block in first_full..last_full {
            minimum = minimum.min(self.block_minimum[block]);
            maximum = maximum.max(self.block_maximum[block]);
        }
        for sample in &samples[last_full * DETAIL_EXTREMA_BLOCK_SIZE..end] {
            let value = if sample.is_finite() {
                f64::from(*sample)
            } else {
                0.0
            };
            minimum = minimum.min(value);
            maximum = maximum.max(value);
        }
        (minimum, maximum)
    }
}

/// Unnormalised crest-aware energy for the broad low/mid/high bands at a display resolution.
///
/// `band_waveform` turns these into relative low/mid/high strengths. The frontend display palette
/// bounds brightness without discarding that RGB identity. Live STEM lanes use the same energies.
#[derive(Debug, Default)]
pub struct BandEnergy {
    pub overall: Vec<f64>,
    pub low: Vec<f64>,
    pub mid: Vec<f64>,
    pub high: Vec<f64>,
}

#[derive(Debug, Default)]
struct EvidenceColourColumns {
    r: Vec<u8>,
    g: Vec<u8>,
    b: Vec<u8>,
    drum_gate: Vec<f64>,
    weight: Vec<f64>,
}

/// Pre-texture detail colour evidence that the release overview can reuse during the same decode.
/// Fields stay private so callers cannot accidentally reinterpret them as display RGB.
#[derive(Debug, Default)]
pub struct WaveformColourTexture {
    r: Vec<u8>,
    g: Vec<u8>,
    b: Vec<u8>,
    weight: Vec<f64>,
}

#[derive(Debug, Default)]
struct RawWaveformEvidence {
    flux_low: Vec<f64>,
    flux_body: Vec<f64>,
    flux_attack: Vec<f64>,
    flux_high: Vec<f64>,
    flux_broad: Vec<f64>,
    hfc: Vec<f64>,
    energy_low: Vec<f64>,
    energy_mid: Vec<f64>,
    energy_high: Vec<f64>,
    log_energy: Vec<f64>,
    voice_mid_share: Vec<f64>,
    spectral_flatness_mid: Vec<f64>,
    periodicity: Vec<f64>,
}

impl RawWaveformEvidence {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            flux_low: Vec::with_capacity(capacity),
            flux_body: Vec::with_capacity(capacity),
            flux_attack: Vec::with_capacity(capacity),
            flux_high: Vec::with_capacity(capacity),
            flux_broad: Vec::with_capacity(capacity),
            hfc: Vec::with_capacity(capacity),
            energy_low: Vec::with_capacity(capacity),
            energy_mid: Vec::with_capacity(capacity),
            energy_high: Vec::with_capacity(capacity),
            log_energy: Vec::with_capacity(capacity),
            voice_mid_share: Vec::with_capacity(capacity),
            spectral_flatness_mid: Vec::with_capacity(capacity),
            periodicity: Vec::with_capacity(capacity),
        }
    }

    fn append(&mut self, mut other: Self) {
        self.flux_low.append(&mut other.flux_low);
        self.flux_body.append(&mut other.flux_body);
        self.flux_attack.append(&mut other.flux_attack);
        self.flux_high.append(&mut other.flux_high);
        self.flux_broad.append(&mut other.flux_broad);
        self.hfc.append(&mut other.hfc);
        self.energy_low.append(&mut other.energy_low);
        self.energy_mid.append(&mut other.energy_mid);
        self.energy_high.append(&mut other.energy_high);
        self.log_energy.append(&mut other.log_energy);
        self.voice_mid_share.append(&mut other.voice_mid_share);
        self.spectral_flatness_mid
            .append(&mut other.spectral_flatness_mid);
        self.periodicity.append(&mut other.periodicity);
    }
}

/// Summarise complementary low/mid/high crossover envelopes without applying a display palette.
/// Each 5 ms frame uses sqrt(RMS × peak): RMS reveals section density while peak keeps transients.
pub fn band_energy(samples: &[f32], sr: f64, buckets: usize) -> BandEnergy {
    let buckets = buckets.clamp(64, MAX_WAVEFORM_BUCKETS);
    let master = peak_band_frames(samples, sr);
    let n_frames = master[0].len();
    if n_frames == 0 {
        return BandEnergy::default();
    }
    let count = buckets.min(n_frames);
    let mut energy = BandEnergy {
        overall: vec![0.0; count],
        low: vec![0.0; count],
        mid: vec![0.0; count],
        high: vec![0.0; count],
    };
    for index in 0..count {
        let start = index * n_frames / count;
        let end = ((index + 1) * n_frames / count)
            .max(start + 1)
            .min(n_frames);
        let width = (end - start) as f64;
        energy.overall[index] = master[0][start..end].iter().sum::<f64>() / width;
        energy.low[index] = master[1][start..end].iter().sum::<f64>() / width;
        energy.mid[index] = master[2][start..end].iter().sum::<f64>() / width;
        energy.high[index] = master[3][start..end].iter().sum::<f64>() / width;
    }
    energy
}

pub fn band_waveform(samples: &[f32], sr: f64, buckets: usize) -> Waveform {
    let evidence = analyze_waveform_evidence(samples, sr);
    band_waveform_with_evidence(samples, sr, buckets, &evidence)
}

/// Build the 400-column/s detail profile from one shared evidence pass.
pub fn band_waveform_with_evidence(
    samples: &[f32],
    sr: f64,
    buckets: usize,
    evidence: &WaveformEvidence,
) -> Waveform {
    band_waveform_and_texture_with_evidence(samples, sr, buckets, evidence).0
}

/// Build detail geometry plus the pre-texture colour evidence needed by the overview. Server
/// callers use this combined form so loading a track never repeats the high-density colour pass.
pub fn band_waveform_and_texture_with_evidence(
    samples: &[f32],
    sr: f64,
    buckets: usize,
    evidence: &WaveformEvidence,
) -> (Waveform, WaveformColourTexture) {
    if samples.is_empty()
        || !sr.is_finite()
        || sr <= 0.0
        || samples.len() < (sr * 0.010).round().max(1.0) as usize
        || evidence.frame_count == 0
    {
        return (Waveform::default(), WaveformColourTexture::default());
    }
    let duration = samples.len() as f64 / sr;
    let density_cap = (duration * DETAIL_WAVEFORM_COLUMNS_PER_SECOND)
        .ceil()
        .max(1.0) as usize;
    let requested = buckets
        .clamp(64, MAX_WAVEFORM_BUCKETS)
        .min(density_cap)
        .min(samples.len());
    let mut geometry = detail_pixel_geometry(samples, sr, requested);
    let count = geometry.amp.len();
    if count == 0 {
        return (Waveform::default(), WaveformColourTexture::default());
    }
    let columns_per_second = count as f64 / duration.max(1e-9);

    let drum_core = frame_peaks_to_columns(&evidence.drum_core, evidence, duration, count);
    let drum = spread_column_peaks(&drum_core);

    // A loud remix wall should not consume all vertical headroom. Only sustained high-energy
    // material receives the extra exponent; the independently detected onset then spends the
    // recovered space on its exact attack.
    let slow_span = (columns_per_second * 0.18).round().max(3.0) as usize | 1;
    let slow_level = dsp::moving_average(
        &geometry
            .amp
            .iter()
            .map(|value| f64::from(*value))
            .collect::<Vec<_>>(),
        slow_span,
    );
    for index in 0..count {
        let base = f64::from(geometry.amp[index]).clamp(0.0, 1.0);
        let wall = ((slow_level[index] - 0.52) / 0.36).clamp(0.0, 1.0);
        let contrast = base.powf(1.0 + 1.8 * wall);
        let boosted = (contrast + (1.0 - contrast) * 0.66 * drum[index].clamp(0.0, 1.0).powf(0.86))
            .clamp(0.0, 1.0);
        geometry.amp[index] = ((boosted * 10_000.0).round() / 10_000.0) as f32;
        // The approved renderer is a hard, symmetric time column. Keeping the wire contour
        // symmetric also prevents an older client from turning two independently aggregated
        // sides into the round/triangular shape rejected during review.
        geometry.minimum[index] = -(boosted as f32);
        geometry.maximum[index] = boosted as f32;
    }

    let mut colours = evidence_colour_columns(evidence, duration, count, DETAIL_SEMANTIC_MIX);
    let texture = WaveformColourTexture {
        r: colours.r.clone(),
        g: colours.g.clone(),
        b: colours.b.clone(),
        weight: geometry
            .amp
            .iter()
            .map(|value| f64::from(*value).clamp(0.0, 1.0))
            .collect(),
    };
    apply_intra_section_texture(
        &mut colours.r,
        &mut colours.g,
        &mut colours.b,
        &texture.r,
        &texture.g,
        &texture.b,
        columns_per_second,
        DETAIL_TEXTURE_SPAN_SECONDS,
        DETAIL_TEXTURE_BASE_GAIN,
        DETAIL_TEXTURE_BLOCK_GAIN,
    );
    geometry.transient = colours
        .drum_gate
        .into_iter()
        .map(|value| (value.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect();

    let waveform = Waveform {
        track_id: 0,
        duration: (duration * 1000.0).round() / 1000.0,
        amp: geometry.amp,
        minimum: geometry.minimum,
        maximum: geometry.maximum,
        r: colours.r,
        g: colours.g,
        b: colours.b,
        transient: geometry.transient,
    };
    (waveform, texture)
}

/// Extract non-STEM spectral/onset evidence once for both waveform assets.
pub fn analyze_waveform_evidence(samples: &[f32], sr: f64) -> WaveformEvidence {
    // A cache miss may happen while the same file is feeding an audible Deck. Keep the product
    // path to one low-QoS CPU owner; real FFT and scan reuse retain the safe speedups, while the
    // explicit audit entry point below can still compare deterministic multi-worker output.
    analyze_waveform_evidence_cancellable(samples, sr, &|| false).unwrap_or_default()
}

/// Extract the exact same evidence as [`analyze_waveform_evidence`], but abandon this optional
/// asset as soon as its owner reports realtime pressure.
///
/// Cancellation changes scheduling only, never samples or math: a completed `Some` is bit-for-bit
/// the ordinary single-worker result. Callers must retain their previous visual pixels on `None`.
pub fn analyze_waveform_evidence_cancellable(
    samples: &[f32],
    sr: f64,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<WaveformEvidence> {
    analyze_waveform_evidence_with_worker_limit_cancellable(samples, sr, 1, cancelled)
}

/// Finish a missing, user-visible whole-track preview as quickly as the safe measured budget
/// allows. Every worker remains background QoS and observes the same output-pressure fuse; only
/// the interactive release-overview cache-miss path should call this entry point.
pub fn analyze_waveform_evidence_preview_burst_cancellable(
    samples: &[f32],
    sr: f64,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<WaveformEvidence> {
    analyze_waveform_evidence_with_worker_limit_cancellable(
        samples,
        sr,
        INTERACTIVE_PREVIEW_EVIDENCE_WORKERS,
        cancelled,
    )
}

/// Timing-audit entry point. Product callers should use [`analyze_waveform_evidence`], whose
/// resource budget is intentionally conservative.
#[doc(hidden)]
pub fn analyze_waveform_evidence_with_worker_limit(
    samples: &[f32],
    sr: f64,
    worker_limit: usize,
) -> WaveformEvidence {
    analyze_waveform_evidence_with_worker_limit_cancellable(samples, sr, worker_limit, &|| false)
        .unwrap_or_default()
}

fn analyze_waveform_evidence_with_worker_limit_cancellable(
    samples: &[f32],
    sr: f64,
    worker_limit: usize,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<WaveformEvidence> {
    if cancelled() {
        return None;
    }
    if samples.is_empty() || !sr.is_finite() || sr <= 0.0 {
        return Some(WaveformEvidence::default());
    }
    let padded_count = samples.len().max(EVIDENCE_N_FFT);
    let frame_count = 1 + (padded_count - EVIDENCE_N_FFT).div_ceil(EVIDENCE_HOP);
    let frame_hz = sr / EVIDENCE_HOP as f64;
    // Small clips stay single-threaded; long songs give every worker enough frames to amortise
    // one local FFT planner and thread start.
    let workers = worker_limit.min(frame_count.div_ceil(2_048).max(1));
    let RawWaveformEvidence {
        flux_low,
        flux_body,
        flux_attack,
        flux_high,
        flux_broad,
        hfc,
        energy_low,
        energy_mid,
        energy_high,
        log_energy,
        voice_mid_share,
        spectral_flatness_mid,
        periodicity,
    } = analyze_waveform_evidence_frames(samples, sr, frame_count, workers, cancelled)?;
    if cancelled() {
        return None;
    }
    debug_assert_eq!(log_energy.len(), frame_count);
    let mut previous_log_energy = 0.0f64;
    let energy_attack: Vec<f64> = log_energy
        .iter()
        .map(|value| {
            let attack = (*value - previous_log_energy).max(0.0);
            previous_log_energy = *value;
            attack
        })
        .collect();

    let low = robust_novelty(&flux_low, frame_hz);
    let body = robust_novelty(&flux_body, frame_hz);
    let attack = robust_novelty(&flux_attack, frame_hz);
    let high = robust_novelty(&flux_high, frame_hz);
    let broad = robust_novelty(&flux_broad, frame_hz);
    let hfc = robust_novelty(&hfc, frame_hz);
    let energy_attack = robust_novelty(&energy_attack, frame_hz);
    if cancelled() {
        return None;
    }
    let kick: Vec<f64> = (0..frame_count)
        .map(|index| {
            (0.55 * low[index] + 0.27 * broad[index] + 0.18 * energy_attack[index]).clamp(0.0, 1.0)
        })
        .collect();
    let snare: Vec<f64> = (0..frame_count)
        .map(|index| {
            (0.34 * body[index] + 0.46 * attack[index] + 0.20 * broad[index]).clamp(0.0, 1.0)
        })
        .collect();
    let hat: Vec<f64> = (0..frame_count)
        .map(|index| (0.64 * high[index] + 0.36 * hfc[index]).clamp(0.0, 1.0))
        .collect();
    let combined: Vec<f64> = (0..frame_count)
        .map(|index| kick[index].max(snare[index]).max(0.82 * hat[index]))
        .collect();
    let adaptive_local =
        dsp::moving_average(&combined, (frame_hz * 0.20).round().max(3.0) as usize | 1);
    let global_floor = quantile(&combined, 62.0);
    let ceiling = quantile(&combined, 99.7);
    let local_maximum = local_maximum_mask(&combined, 2);
    let mut strength: Vec<f64> = (0..frame_count)
        .map(|index| {
            let threshold = 0.58 * adaptive_local[index] + 0.42 * global_floor;
            let value =
                ((combined[index] - threshold) / (ceiling - threshold).max(1e-9)).clamp(0.0, 1.0);
            if local_maximum[index] && value >= 0.10 {
                value
            } else {
                0.0
            }
        })
        .collect();
    for value in strength.iter_mut().take(4) {
        *value = 0.0;
    }
    let tail = frame_count.saturating_sub(4);
    for value in &mut strength[tail..] {
        *value = 0.0;
    }

    if cancelled() {
        return None;
    }

    let periodic_low = quantile(&periodicity, 25.0);
    let periodic_high = quantile(&periodicity, 97.5);
    let periodicity: Vec<f64> = periodicity
        .into_iter()
        .map(|value| {
            ((value - periodic_low) / (periodic_high - periodic_low).max(1e-9)).clamp(0.0, 1.0)
        })
        .collect();
    let tonality: Vec<f64> = spectral_flatness_mid
        .iter()
        .map(|value| ((0.52 - value) / 0.50).clamp(0.0, 1.0))
        .collect();
    let mid_share: Vec<f64> = voice_mid_share
        .iter()
        .map(|value| ((value - 0.18) / 0.62).clamp(0.0, 1.0))
        .collect();
    let log_total = log_energy;
    let energy_floor = quantile(&log_total, 10.0);
    let energy_ceiling = quantile(&log_total, 92.0);
    let mut semantic_mid: Vec<f64> = (0..frame_count)
        .map(|index| {
            let energy_gate = ((log_total[index] - energy_floor)
                / (energy_ceiling - energy_floor).max(1e-9))
            .clamp(0.0, 1.0);
            let sustained = 1.0 - 0.58 * broad[index].clamp(0.0, 1.0).sqrt();
            periodicity[index].powf(0.72)
                * tonality[index].powf(0.55)
                * mid_share[index].powf(0.62)
                * energy_gate.powf(0.45)
                * sustained
        })
        .collect();
    semantic_mid = dsp::moving_average(
        &semantic_mid,
        (frame_hz * 0.080).round().max(3.0) as usize | 1,
    );
    let vocal_low = quantile(&semantic_mid, 35.0);
    let vocal_high = quantile(&semantic_mid, 97.5);
    for value in &mut semantic_mid {
        *value = ((*value - vocal_low) / (vocal_high - vocal_low).max(1e-9)).clamp(0.0, 1.0);
    }

    if cancelled() {
        return None;
    }
    Some(WaveformEvidence {
        sample_rate: sr,
        frame_hz,
        frame_count,
        energy_low,
        energy_mid,
        energy_high,
        drum_core: strength.clone(),
        semantic_low: (0..frame_count)
            .map(|index| {
                ((0.82 * low[index] + 0.18 * body[index]) * strength[index]).clamp(0.0, 1.0)
            })
            .collect(),
        semantic_mid,
        semantic_high: (0..frame_count)
            .map(|index| attack[index].max(high[index]).max(hfc[index]) * strength[index])
            .map(|value| value.clamp(0.0, 1.0))
            .collect(),
    })
}

fn analyze_waveform_evidence_frames(
    samples: &[f32],
    sr: f64,
    frame_count: usize,
    workers: usize,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<RawWaveformEvidence> {
    let workers = workers.clamp(1, frame_count.max(1));
    if workers == 1 {
        return analyze_waveform_evidence_frame_range(samples, sr, 0, frame_count, cancelled);
    }
    let chunk = frame_count.div_ceil(workers);
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for worker in 0..workers {
            let first = worker * chunk;
            let last = ((worker + 1) * chunk).min(frame_count);
            if first >= last {
                continue;
            }
            handles.push(scope.spawn(move || {
                kdj_core::thread_qos::prefer_background();
                analyze_waveform_evidence_frame_range(samples, sr, first, last, cancelled)
            }));
        }
        let mut output = RawWaveformEvidence::with_capacity(frame_count);
        for handle in handles {
            output.append(handle.join().expect("waveform evidence worker panicked")?);
        }
        Some(output)
    })
}

fn analyze_waveform_evidence_frame_range(
    samples: &[f32],
    sr: f64,
    first_frame: usize,
    last_frame: usize,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<RawWaveformEvidence> {
    let capacity = last_frame.saturating_sub(first_frame);
    let mut output = RawWaveformEvidence::with_capacity(capacity);
    if capacity == 0 {
        return Some(output);
    }
    let bins = EVIDENCE_N_FFT / 2 + 1;
    let window: Vec<f32> = (0..EVIDENCE_N_FFT)
        .map(|index| {
            let phase = 2.0 * std::f64::consts::PI * index as f64 / (EVIDENCE_N_FFT - 1) as f64;
            (0.5 - 0.5 * phase.cos()) as f32
        })
        .collect();
    let frequencies: Vec<f64> = (0..bins)
        .map(|bin| bin as f64 * sr / EVIDENCE_N_FFT as f64)
        .collect();
    let range = |low: f64, high: f64| {
        let first = frequencies.partition_point(|frequency| *frequency < low);
        let last = frequencies.partition_point(|frequency| *frequency < high);
        first.min(bins)..last.min(bins)
    };
    let flux_low_range = range(35.0, 190.0);
    let flux_body_range = range(150.0, 1_400.0);
    let flux_attack_range = range(1_800.0, 8_000.0);
    let flux_high_range = range(6_000.0, 16_000.0);
    let flux_broad_range = range(35.0, 16_000.0);
    let energy_low_range = range(35.0, 200.0);
    let energy_mid_range = range(200.0, 1_500.0);
    let energy_high_range = range(1_500.0, 16_000.0);
    let voice_range = range(180.0, 5_000.0);
    let audible_range = range(35.0, 16_000.0);
    let hfc_weights: Vec<f64> = frequencies
        .iter()
        .map(|frequency| (frequency / 8_000.0).clamp(0.0, 2.0).sqrt())
        .collect();
    let lag_low = ((sr / 420.0).floor() as usize).max(1);
    let lag_high = ((sr / 75.0).ceil() as usize).min(EVIDENCE_N_FFT / 2);
    let voice_count = voice_range.len().max(1) as f64;
    let bins_f64 = bins as f64;

    // Audio is real-valued. The real FFT computes only its non-redundant half spectrum; every
    // worker owns a planner and scratch buffers, so no lock is taken between frame chunks.
    let mut planner = RealFftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(EVIDENCE_N_FFT);
    let inverse = planner.plan_fft_inverse(EVIDENCE_N_FFT);
    let mut forward_scratch = forward.make_scratch_vec();
    let mut inverse_scratch = inverse.make_scratch_vec();
    let mut buffer = forward.make_input_vec();
    let mut spectrum = forward.make_output_vec();
    let mut autocorrelation = inverse.make_output_vec();
    let mut history: [Vec<f64>; EVIDENCE_LAG] = std::array::from_fn(|_| vec![0.0; bins]);
    let mut magnitude = vec![0.0f64; bins];
    let mut power = vec![0.0f64; bins];
    let mut log_spectrum = vec![0.0f64; bins];
    let mut difference = vec![0.0f64; bins];

    // Two discarded warm-up frames reproduce the exact global lag history at a chunk boundary.
    let warm_first = first_frame.saturating_sub(EVIDENCE_LAG);
    for frame in warm_first..last_frame {
        // Four FFT frames are only ~23 ms of source at 44.1 kHz and take far less wall time. This
        // bounds how long an already-running visualization can ignore a newly endangered output
        // ring without adding a branch to every spectral bin.
        if frame & 3 == 0 && cancelled() {
            return None;
        }
        let start = frame * EVIDENCE_HOP;
        let available = samples.len().saturating_sub(start).min(EVIDENCE_N_FFT);
        for offset in 0..available {
            let sample = samples[start + offset];
            buffer[offset] = if sample.is_finite() { sample } else { 0.0 } * window[offset];
        }
        for slot in &mut buffer[available..] {
            *slot = 0.0;
        }
        forward
            .process_with_scratch(&mut buffer, &mut spectrum, &mut forward_scratch)
            .expect("real FFT buffers have planner-defined sizes");
        for bin in 0..bins {
            magnitude[bin] = f64::from(spectrum[bin].norm());
            power[bin] = magnitude[bin] * magnitude[bin];
        }
        let scale = (magnitude.iter().sum::<f64>() / bins_f64).max(1e-9);
        for bin in 0..bins {
            log_spectrum[bin] = (1.0 + magnitude[bin] / scale).ln();
        }
        difference.fill(0.0);
        if frame >= EVIDENCE_LAG {
            let previous = &history[frame % EVIDENCE_LAG];
            for bin in 0..bins {
                let first = bin.saturating_sub(EVIDENCE_FREQUENCY_MAX_RADIUS);
                let last = (bin + EVIDENCE_FREQUENCY_MAX_RADIUS + 1).min(bins);
                let local_max = previous[first..last].iter().copied().fold(0.0f64, f64::max);
                difference[bin] = (log_spectrum[bin] - local_max).max(0.0);
            }
        }
        history[frame % EVIDENCE_LAG].copy_from_slice(&log_spectrum);
        if frame < first_frame {
            continue;
        }

        output
            .flux_low
            .push(slice_mean(&difference, flux_low_range.clone()));
        output
            .flux_body
            .push(slice_mean(&difference, flux_body_range.clone()));
        output
            .flux_attack
            .push(slice_mean(&difference, flux_attack_range.clone()));
        output
            .flux_high
            .push(slice_mean(&difference, flux_high_range.clone()));
        output
            .flux_broad
            .push(slice_mean(&difference, flux_broad_range.clone()));
        output.hfc.push(
            difference
                .iter()
                .zip(&hfc_weights)
                .map(|(value, weight)| value * weight)
                .sum::<f64>()
                / bins_f64,
        );

        let total = (power.iter().sum::<f64>() / bins_f64).sqrt();
        output.log_energy.push((1.0 + total).ln());
        output
            .energy_low
            .push(slice_mean(&power, energy_low_range.clone()).sqrt());
        output
            .energy_mid
            .push(slice_mean(&power, energy_mid_range.clone()).sqrt());
        output
            .energy_high
            .push(slice_mean(&power, energy_high_range.clone()).sqrt());

        let voice_sum = voice_range
            .clone()
            .map(|index| power[index].max(1e-16))
            .sum::<f64>();
        let audible_sum = audible_range
            .clone()
            .map(|index| power[index])
            .sum::<f64>()
            .max(1e-16);
        output.voice_mid_share.push(voice_sum / audible_sum);
        let voice_log_mean = voice_range
            .clone()
            .map(|index| power[index].max(1e-16).ln())
            .sum::<f64>()
            / voice_count;
        let voice_mean = voice_sum / voice_count;
        output
            .spectral_flatness_mid
            .push(voice_log_mean.exp() / voice_mean.max(1e-16));

        for slot in &mut spectrum {
            *slot = Complex32::new(slot.norm_sqr(), 0.0);
        }
        inverse
            .process_with_scratch(&mut spectrum, &mut autocorrelation, &mut inverse_scratch)
            .expect("real inverse FFT buffers have planner-defined sizes");
        let zero_lag = f64::from(autocorrelation[0]).max(1e-16);
        let periodic_peak = if lag_low < lag_high {
            autocorrelation[lag_low..lag_high]
                .iter()
                .map(|value| f64::from(*value))
                .fold(0.0f64, f64::max)
        } else {
            0.0
        };
        output
            .periodicity
            .push((periodic_peak / zero_lag).clamp(0.0, 1.0));
    }
    (!cancelled()).then_some(output)
}

fn slice_mean(values: &[f64], range: std::ops::Range<usize>) -> f64 {
    if range.is_empty() {
        return 0.0;
    }
    values[range.clone()].iter().sum::<f64>() / range.len() as f64
}

fn quantile(values: &[f64], percent: f64) -> f64 {
    let sorted = sorted_finite(values.iter().copied());
    percentile(&sorted, percent)
}

fn robust_novelty(values: &[f64], frame_hz: f64) -> Vec<f64> {
    if values.is_empty() {
        return Vec::new();
    }
    let scale = quantile(values, 55.0).max(1e-12);
    let compressed: Vec<f64> = values
        .iter()
        .map(|value| (1.0 + value.max(0.0) / scale).ln())
        .collect();
    let local_floor =
        dsp::moving_average(&compressed, (frame_hz * 0.24).round().max(3.0) as usize | 1);
    let residual: Vec<f64> = compressed
        .iter()
        .zip(local_floor)
        .map(|(value, floor)| (value - 0.42 * floor).max(0.0))
        .collect();
    let low = quantile(&residual, 60.0);
    let high = quantile(&residual, 99.7);
    residual
        .into_iter()
        .map(|value| ((value - low) / (high - low).max(1e-12)).clamp(0.0, 1.0))
        .collect()
}

fn local_maximum_mask(values: &[f64], radius: usize) -> Vec<bool> {
    (0..values.len())
        .map(|index| {
            let first = index.saturating_sub(radius);
            let last = (index + radius + 1).min(values.len());
            values[index] >= values[first..last].iter().copied().fold(0.0f64, f64::max) - 1e-12
        })
        .collect()
}

fn detail_pixel_geometry(samples: &[f32], sr: f64, count: usize) -> ContourGeometry {
    if samples.is_empty() || count == 0 {
        return ContourGeometry::default();
    }
    let count = count.min(samples.len());
    let window_size = ((sr * 0.010).round() as usize).max(1).min(samples.len());
    // One sequential pass builds the RMS prefix and small extrema blocks. A 10 ms display window
    // then scans at most 62 edge samples instead of revisiting all 441 samples for every one of
    // the 100k detail columns; the block extrema are mathematically identical to the old scan.
    let scan = DetailScanCache::new(samples);
    let mut stats = Vec::with_capacity(count);
    let mut crest = Vec::with_capacity(count);
    for index in 0..count {
        let centre = (((index as f64 + 0.5) * samples.len() as f64 / count as f64).floor()
            as usize)
            .min(samples.len() - 1);
        let start = centre
            .saturating_sub(window_size / 2)
            .min(samples.len() - window_size);
        let end = start + window_size;
        let (minimum, maximum) = scan.extrema(samples, start, end);
        let peak = maximum.max(-minimum);
        let rms =
            ((scan.square_prefix[end] - scan.square_prefix[start]) / window_size as f64).sqrt();
        stats.push(BucketStats {
            minimum,
            maximum,
            peak,
            rms,
        });
        crest.push((rms * peak).sqrt());
    }
    let scale = quantile(&crest, 99.5).max(1e-12);
    let mut amp = Vec::with_capacity(count);
    let mut minimum = Vec::with_capacity(count);
    let mut maximum = Vec::with_capacity(count);
    for (bucket, value) in stats.iter().zip(crest) {
        let display = (value / scale).clamp(0.0, 1.0);
        let polarity = bucket.peak.max(1e-12);
        amp.push(((display * 10_000.0).round() / 10_000.0) as f32);
        minimum.push((-display * (-bucket.minimum).max(0.0) / polarity) as f32);
        maximum.push((display * bucket.maximum.max(0.0) / polarity) as f32);
    }
    ContourGeometry {
        minimum,
        maximum,
        amp,
        transient: vec![0; count],
    }
}

fn evidence_frame_time(index: usize, evidence: &WaveformEvidence) -> f64 {
    (index * EVIDENCE_HOP + EVIDENCE_N_FFT / 2) as f64 / evidence.sample_rate.max(1.0)
}

fn interpolate_evidence_frames(
    values: &[f64],
    evidence: &WaveformEvidence,
    duration: f64,
    count: usize,
) -> Vec<f64> {
    if values.is_empty() {
        return vec![0.0; count];
    }
    (0..count)
        .map(|index| {
            let time = (index as f64 + 0.5) / count as f64 * duration;
            let position =
                (time * evidence.sample_rate - EVIDENCE_N_FFT as f64 / 2.0) / EVIDENCE_HOP as f64;
            let position = position.clamp(0.0, (values.len() - 1) as f64);
            let left = position.floor() as usize;
            let right = (left + 1).min(values.len() - 1);
            values[left] + (values[right] - values[left]) * (position - left as f64)
        })
        .collect()
}

fn frame_peaks_to_columns(
    values: &[f64],
    evidence: &WaveformEvidence,
    duration: f64,
    count: usize,
) -> Vec<f64> {
    let mut output = vec![0.0f64; count];
    for (frame, value) in values.iter().copied().enumerate() {
        if value <= 0.0 {
            continue;
        }
        let index = (evidence_frame_time(frame, evidence) / duration.max(1e-9) * count as f64)
            .round() as isize;
        if index >= 0 && (index as usize) < count {
            output[index as usize] = output[index as usize].max(value);
        }
    }
    output
}

fn spread_column_peaks(source: &[f64]) -> Vec<f64> {
    let mut output = source.to_vec();
    for (offset, weight) in [(-1isize, 0.42), (1, 0.72), (2, 0.34)] {
        for (index, value) in source.iter().copied().enumerate() {
            let target = index as isize + offset;
            if target >= 0 && (target as usize) < output.len() {
                output[target as usize] = output[target as usize].max(value * weight);
            }
        }
    }
    output
}

fn relative_band_rgb(bands: &[Vec<f64>; 3], gamma: f64, floor: f64) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let count = bands.iter().map(Vec::len).min().unwrap_or(0);
    let mut share: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0.0; count]);
    for index in 0..count {
        let total = (bands[0][index] + bands[1][index] + bands[2][index]).max(1e-12);
        for band in 0..3 {
            share[band][index] = bands[band][index].max(0.0) / total;
        }
    }
    let reference: [f64; 3] = std::array::from_fn(|band| {
        let mut values = share[band].clone();
        dsp::median(&mut values).max(1e-12)
    });
    let mut channels: [Vec<u8>; 3] = std::array::from_fn(|_| vec![0; count]);
    for index in 0..count {
        let deviation: [f64; 3] =
            std::array::from_fn(|band| (share[band][index] / reference[band]).max(0.0).powf(gamma));
        let peak = deviation.iter().copied().fold(0.0f64, f64::max).max(1e-12);
        for band in 0..3 {
            let value = floor + (1.0 - floor) * (deviation[band] / peak).clamp(0.0, 1.0);
            channels[band][index] = (value * 255.0).round() as u8;
        }
    }
    (
        channels[0].clone(),
        channels[1].clone(),
        channels[2].clone(),
    )
}

/// Build the same non-STEM colour evidence at any requested time density. Keeping this separate
/// from geometry lets the whole-track preview borrow fast spectral texture without borrowing the
/// detail profile's height or transient aggregation.
fn evidence_colour_columns(
    evidence: &WaveformEvidence,
    duration: f64,
    count: usize,
    semantic_mix: f64,
) -> EvidenceColourColumns {
    if count == 0 || evidence.frame_count == 0 || duration <= 0.0 {
        return EvidenceColourColumns::default();
    }
    // Base frequency colour is relative to this track. The semantic layer only participates
    // where an independently measured onset or sustained mid-band feature is reliable.
    let colour_span = (evidence.frame_hz * 0.030).round().max(3.0) as usize | 1;
    let bands = [
        interpolate_evidence_frames(
            &dsp::moving_average(&evidence.energy_low, colour_span),
            evidence,
            duration,
            count,
        ),
        interpolate_evidence_frames(
            &dsp::moving_average(&evidence.energy_mid, colour_span),
            evidence,
            duration,
            count,
        ),
        interpolate_evidence_frames(
            &dsp::moving_average(&evidence.energy_high, colour_span),
            evidence,
            duration,
            count,
        ),
    ];
    let mut weight: Vec<f64> = (0..count)
        .map(|index| {
            (bands[0][index] + bands[1][index] + bands[2][index])
                .max(0.0)
                .sqrt()
        })
        .collect();
    let weight_scale = quantile(&weight, 99.5).max(1e-12);
    for value in &mut weight {
        *value = (*value / weight_scale).clamp(0.0, 1.0);
    }

    let (mut r, mut g, mut b) = relative_band_rgb(&bands, COLOR_GAMMA, COLOR_FLOOR);
    let drum_core = frame_peaks_to_columns(&evidence.drum_core, evidence, duration, count);
    let semantic_low = frame_peaks_to_columns(&evidence.semantic_low, evidence, duration, count);
    let semantic_high = frame_peaks_to_columns(&evidence.semantic_high, evidence, duration, count);
    let semantic_mid =
        interpolate_evidence_frames(&evidence.semantic_mid, evidence, duration, count);
    let drum_gate = semantic_colour_mix(
        &mut r,
        &mut g,
        &mut b,
        &semantic_low,
        &semantic_mid,
        &semantic_high,
        &drum_core,
        semantic_mix,
    );
    EvidenceColourColumns {
        r,
        g,
        b,
        drum_gate,
        weight,
    }
}

/// Match the audit candidate's amplitude-weighted reduction from fast detail evidence to the
/// fixed overview column count. The reduction happens before the local residual is measured, so
/// sub-frame colour noise cannot leak into the whole-track preview as random speckles.
fn aggregate_evidence_rgb(
    colours: &EvidenceColourColumns,
    target_count: usize,
) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    aggregate_weighted_rgb(
        &colours.r,
        &colours.g,
        &colours.b,
        &colours.weight,
        target_count,
    )
}

fn aggregate_detail_texture_rgb(
    texture: &WaveformColourTexture,
    target_count: usize,
) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    aggregate_weighted_rgb(
        &texture.r,
        &texture.g,
        &texture.b,
        &texture.weight,
        target_count,
    )
}

fn aggregate_weighted_rgb(
    source_r: &[u8],
    source_g: &[u8],
    source_b: &[u8],
    source_weight: &[f64],
    target_count: usize,
) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let source_count = source_r
        .len()
        .min(source_g.len())
        .min(source_b.len())
        .min(source_weight.len());
    if source_count == 0 || target_count == 0 {
        return (Vec::new(), Vec::new(), Vec::new());
    }
    if source_count == target_count {
        return (
            source_r[..source_count].to_vec(),
            source_g[..source_count].to_vec(),
            source_b[..source_count].to_vec(),
        );
    }
    let mut r = Vec::with_capacity(target_count);
    let mut g = Vec::with_capacity(target_count);
    let mut b = Vec::with_capacity(target_count);
    for target in 0..target_count {
        let first = target * source_count / target_count;
        let last = (((target + 1) * source_count).div_ceil(target_count))
            .max(first + 1)
            .min(source_count);
        let mut red = 0.0;
        let mut green = 0.0;
        let mut blue = 0.0;
        let mut total_weight = 0.0;
        for source in first..last {
            let weight = source_weight[source].clamp(0.0, 1.0) + 0.001;
            red += f64::from(source_r[source]) * weight;
            green += f64::from(source_g[source]) * weight;
            blue += f64::from(source_b[source]) * weight;
            total_weight += weight;
        }
        r.push((red / total_weight.max(1e-12)).round() as u8);
        g.push((green / total_weight.max(1e-12)).round() as u8);
        b.push((blue / total_weight.max(1e-12)).round() as u8);
    }
    (r, g, b)
}

/// Restore real short-time frequency variation inside a stable section colour. The residual is
/// zero-centred around the local texture baseline, and its gain is bounded by the already measured
/// dominance of the macro colour. It therefore cannot invent a new section or a random hue.
fn apply_intra_section_texture(
    r: &mut [u8],
    g: &mut [u8],
    b: &mut [u8],
    texture_r: &[u8],
    texture_g: &[u8],
    texture_b: &[u8],
    columns_per_second: f64,
    span_seconds: f64,
    base_gain: f64,
    block_gain: f64,
) {
    let count = r
        .len()
        .min(g.len())
        .min(b.len())
        .min(texture_r.len())
        .min(texture_g.len())
        .min(texture_b.len());
    if count == 0 {
        return;
    }
    let mut macro_chroma: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0.0; count]);
    let mut texture_chroma: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0.0; count]);
    for index in 0..count {
        let macro_total =
            (f64::from(r[index]) + f64::from(g[index]) + f64::from(b[index])).max(1e-9);
        let texture_total = (f64::from(texture_r[index])
            + f64::from(texture_g[index])
            + f64::from(texture_b[index]))
        .max(1e-9);
        macro_chroma[0][index] = f64::from(r[index]) / macro_total;
        macro_chroma[1][index] = f64::from(g[index]) / macro_total;
        macro_chroma[2][index] = f64::from(b[index]) / macro_total;
        texture_chroma[0][index] = f64::from(texture_r[index]) / texture_total;
        texture_chroma[1][index] = f64::from(texture_g[index]) / texture_total;
        texture_chroma[2][index] = f64::from(texture_b[index]) / texture_total;
    }
    let requested_span = (columns_per_second * span_seconds).round().max(3.0) as usize | 1;
    let span = requested_span.min(count).max(1);
    let local: [Vec<f64>; 3] =
        std::array::from_fn(|channel| dsp::moving_average(&texture_chroma[channel], span));
    let residual: [Vec<f64>; 3] = std::array::from_fn(|channel| {
        texture_chroma[channel]
            .iter()
            .zip(&local[channel])
            .map(|(value, baseline)| value - baseline)
            .collect()
    });
    let novelty_raw: Vec<f64> = (0..count)
        .map(|index| {
            (residual[0][index].powi(2) + residual[1][index].powi(2) + residual[2][index].powi(2))
                .sqrt()
        })
        .collect();
    let novelty_low = quantile(&novelty_raw, 45.0);
    let novelty_high = quantile(&novelty_raw, 98.5);

    for index in 0..count {
        let mut ordered = [
            macro_chroma[0][index],
            macro_chroma[1][index],
            macro_chroma[2][index],
        ];
        ordered.sort_by(f64::total_cmp);
        let dominance = ordered[2] - ordered[1];
        let block_strength = ((dominance - 0.10) / 0.42).clamp(0.0, 1.0);
        let gain = base_gain + block_gain * block_strength;
        let mut candidate: [f64; 3] = std::array::from_fn(|channel| {
            (macro_chroma[channel][index] + residual[channel][index] * gain)
                .max(TEXTURE_CHANNEL_FLOOR)
        });
        let total = candidate.iter().sum::<f64>().max(1e-9);
        for value in &mut candidate {
            *value /= total;
        }
        let novelty = ((novelty_raw[index] - novelty_low) / (novelty_high - novelty_low).max(1e-9))
            .clamp(0.0, 1.0);
        let value = TEXTURE_VALUE_FLOOR + TEXTURE_VALUE_LIFT * novelty.sqrt();
        let peak = candidate.iter().copied().fold(0.0f64, f64::max).max(1e-9);
        r[index] = (candidate[0] / peak * 255.0 * value).round() as u8;
        g[index] = (candidate[1] / peak * 255.0 * value).round() as u8;
        b[index] = (candidate[2] / peak * 255.0 * value).round() as u8;
    }
}

fn srgb_to_linear_channel(value: u8) -> f64 {
    let value = f64::from(value) / 255.0;
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb_channel(value: f64) -> u8 {
    let value = value.clamp(0.0, 1.0);
    let mapped = if value <= 0.003_130_8 {
        value * 12.92
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    };
    (mapped * 255.0).round().clamp(0.0, 255.0) as u8
}

/// Mix measured evidence into the base frequency colour. There are deliberately no class-to-hue
/// branches here: the low/mid/high ratios themselves are the colour coordinates.
fn semantic_colour_mix(
    r: &mut [u8],
    g: &mut [u8],
    b: &mut [u8],
    semantic_low: &[f64],
    semantic_mid: &[f64],
    semantic_high: &[f64],
    drum_core: &[f64],
    strength: f64,
) -> Vec<f64> {
    let count = r
        .len()
        .min(g.len())
        .min(b.len())
        .min(semantic_low.len())
        .min(semantic_mid.len())
        .min(semantic_high.len())
        .min(drum_core.len());
    let mut drum_gate_values = vec![0.0; count];
    for index in 0..count {
        let drum_gate = ((drum_core[index] - 0.16) / 0.84)
            .clamp(0.0, 1.0)
            .powf(0.72);
        let vocal_gate = ((semantic_mid[index] - 0.22) / 0.78)
            .clamp(0.0, 1.0)
            .powf(1.10);
        drum_gate_values[index] = drum_gate;
        let reliability = 1.0 - (1.0 - drum_gate) * (1.0 - vocal_gate);
        let weight = (strength * reliability).clamp(0.0, 1.0);
        if weight <= 0.0 {
            continue;
        }
        let peak = semantic_low[index]
            .max(semantic_mid[index])
            .max(semantic_high[index])
            .max(1e-9);
        let evidence_rgb = [
            semantic_low[index] / peak,
            semantic_mid[index] / peak,
            semantic_high[index] / peak,
        ];
        let base = [
            srgb_to_linear_channel(r[index]),
            srgb_to_linear_channel(g[index]),
            srgb_to_linear_channel(b[index]),
        ];
        let evidence = evidence_rgb
            .map(|value| srgb_to_linear_channel((value.clamp(0.0, 1.0) * 255.0).round() as u8));
        r[index] = linear_to_srgb_channel(base[0] * (1.0 - weight) + evidence[0] * weight);
        g[index] = linear_to_srgb_channel(base[1] * (1.0 - weight) + evidence[1] * weight);
        b[index] = linear_to_srgb_channel(base[2] * (1.0 - weight) + evidence[2] * weight);
    }
    drum_gate_values
}

fn overview_semantic_columns(
    evidence: &WaveformEvidence,
    duration: f64,
    count: usize,
) -> (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>) {
    let mut low = vec![0.0f64; count];
    let mut high = vec![0.0f64; count];
    let mut drum = vec![0.0f64; count];
    let mut mid_samples: Vec<Vec<f64>> = (0..count).map(|_| Vec::new()).collect();
    for frame in 0..evidence.frame_count {
        let target = (evidence_frame_time(frame, evidence) / duration.max(1e-9) * count as f64)
            .floor() as isize;
        if target < 0 || target as usize >= count {
            continue;
        }
        let target = target as usize;
        low[target] = low[target].max(evidence.semantic_low[frame]);
        high[target] = high[target].max(evidence.semantic_high[frame]);
        drum[target] = drum[target].max(evidence.drum_core[frame]);
        mid_samples[target].push(evidence.semantic_mid[frame]);
    }
    let fallback_mid =
        interpolate_evidence_frames(&evidence.semantic_mid, evidence, duration, count);
    let mut mid: Vec<f64> = mid_samples
        .into_iter()
        .enumerate()
        .map(|(index, values)| {
            if values.is_empty() {
                fallback_mid[index]
            } else {
                quantile(&values, 65.0)
            }
        })
        .collect();
    let span = (count as f64 / duration.max(1e-9) * 1.2).round().max(3.0) as usize | 1;
    mid = dsp::moving_average(&mid, span);
    (low, mid, high, drum)
}

/// 把 PCM 的真实正负极值重建成连续轮廓。高度由 peak/RMS 按 profile 混合，
/// 不再把单个 click 放大成整段实心墙；短边界核只修整轮廓，不移动瞬态时间坐标。
fn contour_geometry(
    samples: &[f32],
    sr: f64,
    requested: usize,
    profile: ContourProfile,
) -> ContourGeometry {
    if samples.is_empty() || !sr.is_finite() || sr <= 0.0 || requested == 0 {
        return ContourGeometry::default();
    }
    let count = requested.min(samples.len());
    let mut stats = Vec::with_capacity(count);
    for index in 0..count {
        let start = index * samples.len() / count;
        let end = ((index + 1) * samples.len() / count)
            .max(start + 1)
            .min(samples.len());
        let mut minimum = 0.0f64;
        let mut maximum = 0.0f64;
        let mut square_sum = 0.0f64;
        for sample in &samples[start..end] {
            let value = if sample.is_finite() {
                f64::from(*sample)
            } else {
                0.0
            };
            minimum = minimum.min(value);
            maximum = maximum.max(value);
            square_sum += value * value;
        }
        stats.push(BucketStats {
            minimum,
            maximum,
            peak: maximum.max(-minimum),
            rms: (square_sum / (end - start).max(1) as f64).sqrt(),
        });
    }

    let peak_scale =
        percentile(&sorted_finite(stats.iter().map(|bucket| bucket.peak)), 99.5).max(1e-9);
    let rms_scale =
        percentile(&sorted_finite(stats.iter().map(|bucket| bucket.rms)), 99.5).max(1e-9);
    let (peak_weight, rms_weight, gamma, boundary_peak_keep) = match profile {
        ContourProfile::Overview => (0.36, 0.64, 0.72, 0.68),
    };

    let mut amp = Vec::with_capacity(count);
    let mut top = Vec::with_capacity(count);
    let mut bottom = Vec::with_capacity(count);
    let mut raw_envelope = Vec::with_capacity(count);
    for bucket in &stats {
        let peak = (bucket.peak / peak_scale).clamp(0.0, 1.0);
        let rms = (bucket.rms / rms_scale).clamp(0.0, 1.0);
        let display = (peak_weight * peak + rms_weight * rms)
            .clamp(0.0, 1.0)
            .powf(gamma);
        let polarity_scale = bucket.peak.max(1e-12);
        amp.push(display);
        top.push(display * bucket.maximum.max(0.0) / polarity_scale);
        bottom.push(display * (-bucket.minimum).max(0.0) / polarity_scale);
        raw_envelope.push((bucket.rms * bucket.peak).sqrt());
    }
    let top = peak_preserving_boundary(&top, boundary_peak_keep);
    let bottom = peak_preserving_boundary(&bottom, boundary_peak_keep);
    let transient = robust_transients(&raw_envelope)
        .into_iter()
        .map(|value| (value.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect();

    ContourGeometry {
        minimum: bottom
            .into_iter()
            .map(|value| -value.clamp(0.0, 1.0) as f32)
            .collect(),
        maximum: top
            .into_iter()
            .map(|value| value.clamp(0.0, 1.0) as f32)
            .collect(),
        amp: amp
            .into_iter()
            .map(|value| ((value.clamp(0.0, 1.0) * 10_000.0).round() / 10_000.0) as f32)
            .collect(),
        transient,
    }
}

fn sorted_finite(values: impl Iterator<Item = f64>) -> Vec<f64> {
    let mut values: Vec<f64> = values.filter(|value| value.is_finite()).collect();
    values.sort_by(f64::total_cmp);
    values
}

fn triangular_smooth(values: &[f64]) -> Vec<f64> {
    if values.len() < 2 {
        return values.to_vec();
    }
    (0..values.len())
        .map(|index| {
            let left = values[index.saturating_sub(1)];
            let center = values[index];
            let right = values[(index + 1).min(values.len() - 1)];
            (left + center * 2.0 + right) / 4.0
        })
        .collect()
}

fn peak_preserving_boundary(values: &[f64], keep: f64) -> Vec<f64> {
    values
        .iter()
        .zip(triangular_smooth(values))
        .map(|(original, filtered)| (original * keep + filtered * (1.0 - keep)).clamp(0.0, 1.0))
        .collect()
}

fn robust_transients(envelope: &[f64]) -> Vec<f64> {
    if envelope.is_empty() {
        return Vec::new();
    }
    let mut previous = envelope[0];
    let mut delta = Vec::with_capacity(envelope.len());
    for value in envelope {
        delta.push((value - previous).max(0.0));
        previous += 0.18 * (value - previous);
    }
    let sorted = sorted_finite(delta.iter().copied());
    let threshold = percentile(&sorted, 93.0);
    let ceiling = percentile(&sorted, 99.7).max(threshold + 1e-12);
    delta
        .into_iter()
        .map(|value| ((value - threshold) / (ceiling - threshold)).clamp(0.0, 1.0))
        .collect()
}

/// 一阶互补 crossover：`low + mid + high == input`，没有 FFT 窗引入的 64 ms 拖影。
/// 每个输出 frame 保存该 5 ms 内 sqrt(RMS × peak) 的 crest-aware 包络，内存与曲长
/// 线性但只有四个 f64 序列。
fn peak_band_frames(samples: &[f32], sr: f64) -> [Vec<f64>; 4] {
    if !sr.is_finite() || sr <= 0.0 {
        return Default::default();
    }
    let frame_samples = (sr / MASTER_COLUMNS_PER_SECOND).round().max(1.0) as usize;
    if samples.len() < frame_samples {
        return Default::default();
    }
    let frames = samples.len().div_ceil(frame_samples);
    let mut peaks: [Vec<f64>; 4] = std::array::from_fn(|_| Vec::with_capacity(frames));
    let low_alpha = 1.0 - (-2.0 * std::f64::consts::PI * XOVER_LOW / sr).exp();
    let high_alpha = 1.0 - (-2.0 * std::f64::consts::PI * XOVER_HIGH / sr).exp();
    let mut low_state = 0.0f64;
    let mut mid_state = 0.0f64;

    for frame in samples.chunks(frame_samples) {
        let mut frame_peaks = [0.0f64; 4];
        let mut frame_squares = [0.0f64; 4];
        for sample in frame {
            let input = if sample.is_finite() {
                f64::from(*sample)
            } else {
                0.0
            };
            low_state += low_alpha * (input - low_state);
            let above_low = input - low_state;
            mid_state += high_alpha * (above_low - mid_state);
            let split = [
                input.abs(),
                low_state.abs(),
                mid_state.abs(),
                (above_low - mid_state).abs(),
            ];
            for index in 0..4 {
                frame_peaks[index] = frame_peaks[index].max(split[index]);
                frame_squares[index] += split[index] * split[index];
            }
        }
        for index in 0..4 {
            let rms = (frame_squares[index] / frame.len().max(1) as f64).sqrt();
            peaks[index].push((rms * frame_peaks[index]).sqrt());
        }
    }
    peaks
}

// ---------------------------------------------------------------- v0.2.41 整曲预览

const RELEASE_N_FFT: usize = 1024;
const RELEASE_HOP: usize = 512;
const RELEASE_XOVER_LOW: f64 = 200.0;
const RELEASE_XOVER_HIGH: f64 = 1500.0;
const RELEASE_AMP_GAMMA: f64 = 1.2;
const RELEASE_COLOR_GAMMA: f64 = 2.4;
const RELEASE_COLOR_FLOOR: f64 = 0.12;

/// v0.2.41 的整曲预览算法：16 kHz STFT、P5–P99 幅度拉伸，以及相对本曲
/// 常态占比的高饱和 RGB。只给 overview 使用；DJ 滚动主波形仍走 band_waveform。
pub fn release_overview_waveform(samples: &[f32], sr: f64, buckets: usize) -> Waveform {
    let evidence = analyze_waveform_evidence(samples, sr);
    release_overview_waveform_with_evidence(samples, sr, buckets, &evidence)
}

/// Preserve the historical section-height/base-colour analysis while adding the same measured
/// evidence used by the high-density detail asset.
pub fn release_overview_waveform_with_evidence(
    samples: &[f32],
    sr: f64,
    buckets: usize,
    evidence: &WaveformEvidence,
) -> Waveform {
    release_overview_waveform_internal(samples, sr, buckets, Some(evidence), None, None)
}

/// Build the exact release overview while allowing an optional UI request to yield to realtime
/// audio. A completed waveform uses the same stages and arithmetic as the ordinary API; `None`
/// means no partial or approximate pixels may be presented.
pub fn release_overview_waveform_with_evidence_cancellable(
    samples: &[f32],
    sr: f64,
    buckets: usize,
    evidence: &WaveformEvidence,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<Waveform> {
    release_overview_waveform_internal_cancellable(
        samples,
        sr,
        buckets,
        Some(evidence),
        None,
        // A cold visible preview already uses the measured four-worker evidence budget. The
        // historical 16 kHz colour/section FFT was accidentally left single-threaded, making the
        // second whole-song spectral pass a serial tail after the first one had finished. Frame
        // chunks are independent and concatenate in source order, so this changes scheduling but
        // remains bit-exact with the single-worker asset.
        Some(INTERACTIVE_PREVIEW_EVIDENCE_WORKERS),
        cancelled,
    )
}

/// Lightweight temporary overview for a media file that is still being written and played.
/// It preserves the proven release section geometry/base RGB, but deliberately skips the full
/// semantic evidence pass and stays single-threaded so progressive refreshes cannot starve audio.
pub fn progressive_release_overview_waveform(samples: &[f32], sr: f64, buckets: usize) -> Waveform {
    release_overview_waveform_internal(samples, sr, buckets, None, None, Some(1))
}

/// Generate the release overview while reusing the exact pre-texture detail colours already
/// produced by the sibling profile. This is visually identical to the approved audit composition
/// and removes the largest duplicated colour pass from normal track loading.
pub fn release_overview_waveform_with_detail_texture(
    samples: &[f32],
    sr: f64,
    buckets: usize,
    evidence: &WaveformEvidence,
    detail_texture: &WaveformColourTexture,
) -> Waveform {
    release_overview_waveform_internal(
        samples,
        sr,
        buckets,
        Some(evidence),
        Some(detail_texture),
        None,
    )
}

fn release_overview_waveform_internal(
    samples: &[f32],
    sr: f64,
    buckets: usize,
    evidence: Option<&WaveformEvidence>,
    detail_texture: Option<&WaveformColourTexture>,
    worker_limit: Option<usize>,
) -> Waveform {
    release_overview_waveform_internal_cancellable(
        samples,
        sr,
        buckets,
        evidence,
        detail_texture,
        worker_limit,
        &|| false,
    )
    .unwrap_or_default()
}

fn release_overview_waveform_internal_cancellable(
    samples: &[f32],
    sr: f64,
    buckets: usize,
    evidence: Option<&WaveformEvidence>,
    detail_texture: Option<&WaveformColourTexture>,
    worker_limit: Option<usize>,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<Waveform> {
    if cancelled() {
        return None;
    }
    let buckets = buckets.clamp(64, 4096);
    let energies = release_band_energy_frames_cancellable(
        samples,
        sr,
        RELEASE_N_FFT,
        RELEASE_HOP,
        worker_limit,
        cancelled,
    )?;
    let n_frames = energies[0].len();
    if n_frames == 0 {
        return Some(Waveform::default());
    }

    // 与 v0.2.41 一致：按整数步长聚合，尾巴不足一格时不补零。
    let step = (n_frames / buckets).max(1);
    let count = n_frames / step;
    if count == 0 {
        return Some(Waveform::default());
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
    if cancelled() {
        return None;
    }

    // Preview 的段落高低继续使用经过长期验证的 P5–P99 宏观包络。Signed contour
    // 只提供真实正负形状；不能用 γ<1 的细节提亮替换段落高度，否则 break/主歌也会
    // 被抬成粗墙，失去旧 overview 一眼可见的编排层次。
    let mut structure_amp: Vec<f64> = (0..count)
        .map(|i| (bands[0][i] + bands[1][i] + bands[2][i]).sqrt())
        .collect();
    let mut sorted = structure_amp.clone();
    sorted.sort_by(f64::total_cmp);
    let hi = percentile(&sorted, 99.0).max(1e-9);
    let lo = percentile(&sorted, 5.0);
    for value in &mut structure_amp {
        *value = ((*value - lo) / (hi - lo).max(1e-9))
            .clamp(0.0, 1.0)
            .powf(RELEASE_AMP_GAMMA);
    }

    let mut mag: [Vec<f64>; 3] = [
        bands[0].iter().map(|value| value.sqrt()).collect(),
        bands[1].iter().map(|value| value.sqrt()).collect(),
        bands[2].iter().map(|value| value.sqrt()).collect(),
    ];
    let span = ((count / 128).max(3)) | 1;
    if count > span {
        for row in mag.iter_mut() {
            *row = dsp::moving_average(row, span);
        }
    }

    let share: [Vec<f64>; 3] = {
        let mut out = [vec![0.0; count], vec![0.0; count], vec![0.0; count]];
        for i in 0..count {
            let total = (mag[0][i] + mag[1][i] + mag[2][i]).max(1e-12);
            for band in 0..3 {
                out[band][i] = mag[band][i] / total;
            }
        }
        out
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

    let mut r = vec![0u8; count];
    let mut g = vec![0u8; count];
    let mut b = vec![0u8; count];
    for i in 0..count {
        let dev: [f64; 3] = std::array::from_fn(|band| {
            (share[band][i] / reference[band]).powf(RELEASE_COLOR_GAMMA)
        });
        let peak = dev.iter().cloned().fold(0.0f64, f64::max).max(1e-9);
        let channels: [u8; 3] = std::array::from_fn(|band| {
            let normalized = (dev[band] / peak).clamp(0.0, 1.0);
            let lifted = RELEASE_COLOR_FLOOR + (1.0 - RELEASE_COLOR_FLOOR) * normalized;
            (lifted * 255.0).round() as u8
        });
        r[i] = channels[0];
        g[i] = channels[1];
        b[i] = channels[2];
    }
    if cancelled() {
        return None;
    }

    let duration = samples.len() as f64 / sr.max(1.0);
    let drum_gate = evidence.map(|evidence| {
        let (semantic_low, semantic_mid, semantic_high, drum_core) =
            overview_semantic_columns(evidence, duration, count);
        let drum_gate = semantic_colour_mix(
            &mut r,
            &mut g,
            &mut b,
            &semantic_low,
            &semantic_mid,
            &semantic_high,
            &drum_core,
            OVERVIEW_SEMANTIC_MIX,
        );

        // The slow release analysis above still owns section identity. A high-density pass over
        // the already-computed evidence supplies only the short-time residual, then collapses
        // back to the exact same overview count before any colour is changed.
        let (texture_r, texture_g, texture_b) = if let Some(detail_texture) = detail_texture {
            aggregate_detail_texture_rgb(detail_texture, count)
        } else {
            let texture_count = detail_waveform_buckets(duration).max(count);
            let fast_colours =
                evidence_colour_columns(evidence, duration, texture_count, DETAIL_SEMANTIC_MIX);
            aggregate_evidence_rgb(&fast_colours, count)
        };
        apply_intra_section_texture(
            &mut r,
            &mut g,
            &mut b,
            &texture_r,
            &texture_g,
            &texture_b,
            count as f64 / duration.max(1e-9),
            OVERVIEW_TEXTURE_SPAN_SECONDS,
            OVERVIEW_TEXTURE_BASE_GAIN,
            OVERVIEW_TEXTURE_BLOCK_GAIN,
        );
        drum_gate
    });
    if cancelled() {
        return None;
    }

    let mut geometry = contour_geometry(samples, sr, count, ContourProfile::Overview);
    for (index, target) in structure_amp.into_iter().enumerate() {
        let peak = geometry.maximum[index].max(-geometry.minimum[index]);
        if peak > 1e-9 {
            geometry.maximum[index] = geometry.maximum[index] / peak * target as f32;
            geometry.minimum[index] = geometry.minimum[index] / peak * target as f32;
        } else {
            geometry.maximum[index] = 0.0;
            geometry.minimum[index] = 0.0;
        }
        geometry.amp[index] = ((target * 10_000.0).round() / 10_000.0) as f32;
    }
    if let Some(drum_gate) = drum_gate {
        geometry.transient = drum_gate
            .into_iter()
            .map(|value| (value.clamp(0.0, 1.0) * 255.0).round() as u8)
            .collect();
    }

    if cancelled() {
        return None;
    }
    Some(Waveform {
        track_id: 0,
        duration: (duration * 1000.0).round() / 1000.0,
        amp: geometry.amp,
        minimum: geometry.minimum,
        maximum: geometry.maximum,
        r,
        g,
        b,
        transient: geometry.transient,
    })
}

fn release_band_energy_frames_cancellable(
    samples: &[f32],
    sr: f64,
    n_fft: usize,
    hop: usize,
    worker_limit: Option<usize>,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<[Vec<f64>; 3]> {
    if cancelled() {
        return None;
    }
    if samples.len() < n_fft {
        return Some(Default::default());
    }
    let frames = 1 + (samples.len() - n_fft) / hop;
    let window: Vec<f32> = dsp::hann_window(n_fft)
        .into_iter()
        .map(|value| value as f32)
        .collect();
    let workers = worker_limit
        .unwrap_or(1)
        .max(1)
        .min(frames.div_ceil(1_024).max(1));
    if workers == 1 {
        let bins = n_fft / 2 + 1;
        let low_end = ((RELEASE_XOVER_LOW * n_fft as f64 / sr).ceil() as usize).min(bins);
        let high_end =
            ((RELEASE_XOVER_HIGH * n_fft as f64 / sr).ceil() as usize).clamp(low_end, bins);
        return release_band_energy_frame_range_cancellable(
            samples, n_fft, hop, &window, low_end, high_end, 0, frames, cancelled,
        );
    }
    release_band_energy_frames_with_workers_cancellable(
        samples, sr, n_fft, hop, &window, frames, workers, cancelled,
    )
}

#[cfg(test)]
fn release_band_energy_frames_with_workers(
    samples: &[f32],
    sr: f64,
    n_fft: usize,
    hop: usize,
    window: &[f32],
    frames: usize,
    workers: usize,
) -> [Vec<f64>; 3] {
    release_band_energy_frames_with_workers_cancellable(
        samples,
        sr,
        n_fft,
        hop,
        window,
        frames,
        workers,
        &|| false,
    )
    .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn release_band_energy_frames_with_workers_cancellable(
    samples: &[f32],
    sr: f64,
    n_fft: usize,
    hop: usize,
    window: &[f32],
    frames: usize,
    workers: usize,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<[Vec<f64>; 3]> {
    if cancelled() {
        return None;
    }
    let bins = n_fft / 2 + 1;
    let low_end = ((RELEASE_XOVER_LOW * n_fft as f64 / sr).ceil() as usize).min(bins);
    let high_end = ((RELEASE_XOVER_HIGH * n_fft as f64 / sr).ceil() as usize).clamp(low_end, bins);
    let workers = workers.clamp(1, frames.max(1));
    if workers == 1 {
        return release_band_energy_frame_range_cancellable(
            samples, n_fft, hop, window, low_end, high_end, 0, frames, cancelled,
        );
    }
    let chunk = frames.div_ceil(workers);
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for worker in 0..workers {
            let first = worker * chunk;
            let last = ((worker + 1) * chunk).min(frames);
            if first >= last {
                continue;
            }
            handles.push(scope.spawn(move || {
                kdj_core::thread_qos::prefer_background();
                release_band_energy_frame_range_cancellable(
                    samples, n_fft, hop, window, low_end, high_end, first, last, cancelled,
                )
            }));
        }
        let mut energies: [Vec<f64>; 3] = std::array::from_fn(|_| Vec::with_capacity(frames));
        for handle in handles {
            let chunk = handle.join().expect("release waveform worker panicked")?;
            for band in 0..3 {
                energies[band].extend_from_slice(&chunk[band]);
            }
        }
        debug_assert!(energies.iter().all(|band| band.len() == frames));
        (!cancelled()).then_some(energies)
    })
}

#[allow(clippy::too_many_arguments)]
fn release_band_energy_frame_range_cancellable(
    samples: &[f32],
    n_fft: usize,
    hop: usize,
    window: &[f32],
    low_end: usize,
    high_end: usize,
    first_frame: usize,
    last_frame: usize,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<[Vec<f64>; 3]> {
    let bins = n_fft / 2 + 1;
    let band_ranges = [0..low_end, low_end..high_end, high_end..bins];
    let count = last_frame.saturating_sub(first_frame);
    let mut energies: [Vec<f64>; 3] = std::array::from_fn(|_| Vec::with_capacity(count));
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n_fft);
    let mut scratch = fft.make_scratch_vec();
    let mut buffer = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();

    for frame in first_frame..last_frame {
        if (frame - first_frame) % 8 == 0 && cancelled() {
            return None;
        }
        let start = frame * hop;
        for (index, slot) in buffer.iter_mut().enumerate() {
            *slot = samples[start + index] * window[index];
        }
        fft.process_with_scratch(&mut buffer, &mut spectrum, &mut scratch)
            .expect("real FFT buffers have planner-defined sizes");
        for (band, range) in band_ranges.iter().enumerate() {
            energies[band].push(
                spectrum[range.clone()]
                    .iter()
                    .map(|value| value.norm_sqr() as f64)
                    .sum(),
            );
        }
    }
    if cancelled() {
        None
    } else {
        Some(energies)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn tone(freq: f64, seconds: f64, sr: f64) -> Vec<f32> {
        (0..(seconds * sr) as usize)
            .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32)
            .collect()
    }

    #[test]
    fn every_channel_has_the_same_length_as_amp() {
        let samples = tone(440.0, 10.0, WAVEFORM_SR as f64);
        let wave = band_waveform(&samples, WAVEFORM_SR as f64, 200);
        assert!(!wave.amp.is_empty());
        assert_eq!(wave.r.len(), wave.amp.len());
        assert_eq!(wave.g.len(), wave.amp.len());
        assert_eq!(wave.b.len(), wave.amp.len());
        assert_eq!(wave.minimum.len(), wave.amp.len());
        assert_eq!(wave.maximum.len(), wave.amp.len());
        assert_eq!(wave.transient.len(), wave.amp.len());
        assert!(wave
            .minimum
            .iter()
            .all(|value| (-1.0..=0.0).contains(value)));
        assert!(wave.maximum.iter().all(|value| (0.0..=1.0).contains(value)));
        assert!((wave.duration - 10.0).abs() < 0.05);
    }

    #[test]
    fn cancellable_evidence_preserves_exact_output_when_allowed() {
        let samples = tone(440.0, 1.0, WAVEFORM_EVIDENCE_SR as f64);
        let expected = analyze_waveform_evidence(&samples, WAVEFORM_EVIDENCE_SR as f64);
        let actual =
            analyze_waveform_evidence_cancellable(&samples, WAVEFORM_EVIDENCE_SR as f64, &|| false)
                .expect("healthy audio should allow the optional evidence pass");
        assert_eq!(actual.frame_count, expected.frame_count);
        assert_eq!(actual.energy_low, expected.energy_low);
        assert_eq!(actual.energy_mid, expected.energy_mid);
        assert_eq!(actual.energy_high, expected.energy_high);
        assert_eq!(actual.drum_core, expected.drum_core);
        assert_eq!(actual.semantic_low, expected.semantic_low);
        assert_eq!(actual.semantic_mid, expected.semantic_mid);
        assert_eq!(actual.semantic_high, expected.semantic_high);
    }

    #[test]
    fn preview_burst_evidence_preserves_the_single_worker_result() {
        let sr = WAVEFORM_EVIDENCE_SR as f64;
        let mut samples = tone(110.0, 4.0, sr);
        samples.extend(tone(1_100.0, 4.0, sr));
        samples.extend(tone(6_000.0, 4.0, sr));
        let expected = analyze_waveform_evidence(&samples, sr);
        let actual = analyze_waveform_evidence_preview_burst_cancellable(&samples, sr, &|| false)
            .expect("healthy output should allow the preview burst");
        assert_eq!(actual.frame_count, expected.frame_count);
        assert_eq!(actual.energy_low, expected.energy_low);
        assert_eq!(actual.energy_mid, expected.energy_mid);
        assert_eq!(actual.energy_high, expected.energy_high);
        assert_eq!(actual.drum_core, expected.drum_core);
        assert_eq!(actual.semantic_low, expected.semantic_low);
        assert_eq!(actual.semantic_mid, expected.semantic_mid);
        assert_eq!(actual.semantic_high, expected.semantic_high);
    }

    #[test]
    fn cancellable_evidence_abandons_optional_fft_mid_pass() {
        let samples = tone(440.0, 8.0, WAVEFORM_EVIDENCE_SR as f64);
        let checks = AtomicUsize::new(0);
        let result =
            analyze_waveform_evidence_cancellable(&samples, WAVEFORM_EVIDENCE_SR as f64, &|| {
                checks.fetch_add(1, Ordering::Relaxed) >= 8
            });
        assert!(result.is_none());
        assert!(checks.load(Ordering::Relaxed) >= 9);
    }

    #[test]
    fn cancellable_release_overview_is_exact_when_allowed() {
        let sr = RELEASE_OVERVIEW_SR as f64;
        let mut samples = tone(95.0, 2.0, sr);
        samples.extend(tone(1_200.0, 2.0, sr));
        samples.extend(tone(5_500.0, 2.0, sr));
        let evidence = analyze_waveform_evidence(&samples, sr);
        let expected = release_overview_waveform_with_evidence(&samples, sr, 512, &evidence);
        let actual = release_overview_waveform_with_evidence_cancellable(
            &samples,
            sr,
            512,
            &evidence,
            &|| false,
        )
        .expect("healthy output keeps the exact release pass admitted");
        assert_eq!(actual.duration, expected.duration);
        assert_eq!(actual.amp, expected.amp);
        assert_eq!(actual.minimum, expected.minimum);
        assert_eq!(actual.maximum, expected.maximum);
        assert_eq!(actual.r, expected.r);
        assert_eq!(actual.g, expected.g);
        assert_eq!(actual.b, expected.b);
        assert_eq!(actual.transient, expected.transient);
    }

    #[test]
    fn cancellable_release_overview_abandons_the_optional_fft() {
        let sr = RELEASE_OVERVIEW_SR as f64;
        let samples = tone(440.0, 12.0, sr);
        let evidence = analyze_waveform_evidence(&samples, sr);
        let checks = AtomicUsize::new(0);
        let result = release_overview_waveform_with_evidence_cancellable(
            &samples,
            sr,
            512,
            &evidence,
            &|| checks.fetch_add(1, Ordering::Relaxed) >= 8,
        );
        assert!(result.is_none());
        assert!(checks.load(Ordering::Relaxed) >= 9);
    }

    #[test]
    fn parallel_evidence_frames_are_identical_to_the_single_worker_path() {
        let sr = RELEASE_OVERVIEW_SR as f64;
        let mut samples = tone(110.0, 3.0, sr);
        samples.extend(tone(1_100.0, 3.0, sr));
        samples.extend(tone(6_000.0, 3.0, sr));
        for index in (0..samples.len()).step_by(1_333) {
            samples[index] = 1.0;
        }
        let padded_count = samples.len().max(EVIDENCE_N_FFT);
        let frames = 1 + (padded_count - EVIDENCE_N_FFT).div_ceil(EVIDENCE_HOP);
        let single = analyze_waveform_evidence_frames(&samples, sr, frames, 1, &|| false)
            .expect("the reference evidence pass is not cancelled");
        let parallel = analyze_waveform_evidence_frames(&samples, sr, frames, 4, &|| false)
            .expect("the parallel evidence pass is not cancelled");
        assert_eq!(single.flux_low, parallel.flux_low);
        assert_eq!(single.flux_body, parallel.flux_body);
        assert_eq!(single.flux_attack, parallel.flux_attack);
        assert_eq!(single.flux_high, parallel.flux_high);
        assert_eq!(single.flux_broad, parallel.flux_broad);
        assert_eq!(single.hfc, parallel.hfc);
        assert_eq!(single.energy_low, parallel.energy_low);
        assert_eq!(single.energy_mid, parallel.energy_mid);
        assert_eq!(single.energy_high, parallel.energy_high);
        assert_eq!(single.log_energy, parallel.log_energy);
        assert_eq!(single.voice_mid_share, parallel.voice_mid_share);
        assert_eq!(single.spectral_flatness_mid, parallel.spectral_flatness_mid);
        assert_eq!(single.periodicity, parallel.periodicity);
    }

    #[test]
    fn block_extrema_are_identical_to_the_contiguous_reference_scan() {
        let mut samples: Vec<f32> = (0..257)
            .map(|index| ((index as f64 * 0.37).sin() * 0.8) as f32)
            .collect();
        samples[17] = f32::NAN;
        samples[64] = -1.25;
        samples[191] = 1.5;
        let scan = DetailScanCache::new(&samples);
        for start in 0..samples.len() {
            for width in [1usize, 7, 31, 32, 33, 95, 160] {
                let end = (start + width).min(samples.len());
                if start == end {
                    continue;
                }
                let mut expected_minimum = 0.0f64;
                let mut expected_maximum = 0.0f64;
                for sample in &samples[start..end] {
                    let value = if sample.is_finite() {
                        f64::from(*sample)
                    } else {
                        0.0
                    };
                    expected_minimum = expected_minimum.min(value);
                    expected_maximum = expected_maximum.max(value);
                }
                assert_eq!(
                    scan.extrema(&samples, start, end),
                    (expected_minimum, expected_maximum)
                );
            }
        }
    }

    #[test]
    fn parallel_release_fft_is_identical_to_the_single_worker_path() {
        let sr = RELEASE_OVERVIEW_SR as f64;
        let mut samples = tone(90.0, 4.0, sr);
        samples.extend(tone(900.0, 4.0, sr));
        samples.extend(tone(7_000.0, 4.0, sr));
        let frames = 1 + (samples.len() - RELEASE_N_FFT) / RELEASE_HOP;
        let window: Vec<f32> = dsp::hann_window(RELEASE_N_FFT)
            .into_iter()
            .map(|value| value as f32)
            .collect();
        let single = release_band_energy_frames_with_workers(
            &samples,
            sr,
            RELEASE_N_FFT,
            RELEASE_HOP,
            &window,
            frames,
            1,
        );
        let parallel = release_band_energy_frames_with_workers(
            &samples,
            sr,
            RELEASE_N_FFT,
            RELEASE_HOP,
            &window,
            frames,
            4,
        );
        assert_eq!(single, parallel);
    }

    #[test]
    fn bucket_count_is_exact_until_the_four_hundred_hz_density_is_exhausted() {
        let sr = WAVEFORM_SR as f64;

        // Requests below the evidence density remain exact.
        let short = band_waveform(&tone(440.0, 30.0, sr), sr, 640);
        assert_eq!(short.amp.len(), 640);

        // Requests above 400 Hz do not invent horizontally interpolated source columns.
        let oversized = band_waveform(&tone(440.0, 1.0, sr), sr, 2_000);
        assert_eq!(oversized.amp.len(), 400);

        // 长曲的 overview 也保持稳定 payload 大小。
        let long_samples = tone(440.0, 300.0, sr);
        for buckets in [100usize, 300, 640] {
            let wave = band_waveform(&long_samples, sr, buckets);
            assert_eq!(wave.amp.len(), buckets.max(64));
        }
    }

    #[test]
    fn detailed_profile_keeps_four_hundred_real_columns_per_second() {
        let sr = WAVEFORM_SR as f64;
        let seconds = 30.0;
        let requested = (seconds * DETAIL_WAVEFORM_COLUMNS_PER_SECOND) as usize;
        let wave = band_waveform(&tone(440.0, seconds, sr), sr, requested);
        assert_eq!(wave.amp.len(), requested);
    }

    #[test]
    fn detail_bucket_count_matches_the_frontend_viewport_contract() {
        assert_eq!(detail_waveform_buckets(0.0), 2_000);
        assert_eq!(detail_waveform_buckets(180.0), 72_000);
        assert_eq!(detail_waveform_buckets(600.0), 100_000);
    }

    #[test]
    fn bass_sections_read_redder_than_treble_sections_of_the_same_track() {
        // 颜色是**相对本曲常态**的偏离量（见模块注释里的方案 C），
        // 所以单独喂一个纯音是问不出颜色的——每一列的占比都一样，
        // 除掉常态之后三个通道齐平。要测的是"同一首曲子里段落之间分得开"。
        let sr = WAVEFORM_SR as f64;
        let mut samples = tone(100.0, 8.0, sr);
        samples.extend(tone(5000.0, 8.0, sr));

        let wave = band_waveform(&samples, sr, 200);
        let half = wave.amp.len() / 2;
        // 各取段落中央，避开交界处的平滑窗
        let bass_at = half / 2;
        let treble_at = half + half / 2;

        assert!(
            wave.r[bass_at] > wave.b[bass_at],
            "低频段应当偏红：r={} b={}",
            wave.r[bass_at],
            wave.b[bass_at]
        );
        assert!(
            wave.b[treble_at] > wave.r[treble_at],
            "高频段应当偏蓝：r={} b={}",
            wave.r[treble_at],
            wave.b[treble_at]
        );
    }

    #[test]
    fn amplitudes_stay_inside_the_unit_range() {
        let samples = tone(440.0, 10.0, WAVEFORM_SR as f64);
        let wave = band_waveform(&samples, WAVEFORM_SR as f64, 200);
        assert!(wave.amp.iter().all(|v| (0.0..=1.0).contains(v)));
    }

    #[test]
    fn crest_aware_envelope_keeps_sparse_transients_below_dense_sections() {
        let sr = WAVEFORM_SR as f64;
        let frame_samples = (sr / MASTER_COLUMNS_PER_SECOND).round() as usize;
        let mut sparse = vec![0.0f32; frame_samples * 32];
        for frame in 0..32 {
            sparse[frame * frame_samples] = 1.0;
        }
        let dense = vec![1.0f32; frame_samples * 32];
        let sparse_frames = peak_band_frames(&sparse, sr);
        let dense_frames = peak_band_frames(&dense, sr);
        let sparse_mean = sparse_frames[0].iter().sum::<f64>() / sparse_frames[0].len() as f64;
        let dense_mean = dense_frames[0].iter().sum::<f64>() / dense_frames[0].len() as f64;
        assert!(
            dense_mean > sparse_mean * 2.0,
            "相同 peak 的稀疏 click 不能再把段落画得和持续高能段一样满"
        );
    }

    #[test]
    fn colour_channels_never_go_fully_black() {
        // 段内残差允许把非主通道压到旧频带 floor 以下，但不能生成纯 RGB 黑通道。
        let samples = tone(100.0, 10.0, WAVEFORM_SR as f64);
        let wave = band_waveform(&samples, WAVEFORM_SR as f64, 200);
        assert!(wave.r.iter().all(|v| *v > 0));
        assert!(wave.g.iter().all(|v| *v > 0));
        assert!(wave.b.iter().all(|v| *v > 0));
    }

    #[test]
    fn too_short_input_returns_an_empty_waveform_instead_of_panicking() {
        let wave = band_waveform(&[0.0; 100], WAVEFORM_SR as f64, 200);
        assert!(wave.amp.is_empty());
    }

    #[test]
    fn release_overview_keeps_stft_colours_with_the_semantic_overlay_contract() {
        let sr = RELEASE_OVERVIEW_SR as f64;
        let mut samples = vec![0.0; (sr * 2.0) as usize];
        samples.extend(tone(100.0, 4.0, sr).into_iter().map(|sample| sample * 0.35));
        samples.extend(tone(5000.0, 4.0, sr));
        let wave = release_overview_waveform(&samples, sr, 200);
        assert!(!wave.amp.is_empty());
        assert_eq!(wave.minimum.len(), wave.amp.len());
        assert_eq!(wave.maximum.len(), wave.amp.len());
        assert_eq!(wave.transient.len(), wave.amp.len());
        assert!(wave
            .amp
            .iter()
            .take(wave.amp.len() / 6)
            .all(|value| *value <= 0.01));
        let bass = wave.amp.len() / 2;
        let treble = wave.amp.len() * 5 / 6;
        assert!(wave.r[bass] > wave.b[bass]);
        assert!(wave.b[treble] > wave.r[treble]);
        // Linear-light evidence and the approved local residual may lower an inactive coordinate
        // below the old frequency floor, but the display input must never collapse into black.
        assert!(wave.r.iter().all(|value| *value > 0));
        assert!(wave.g.iter().all(|value| *value > 0));
        assert!(wave.b.iter().all(|value| *value > 0));
    }

    #[test]
    fn release_overview_preserves_macro_section_height_contrast() {
        let sr = RELEASE_OVERVIEW_SR as f64;
        let seconds = 4.0;
        let mut samples = vec![0.0; (sr * seconds) as usize];
        samples.extend(
            tone(220.0, seconds, sr)
                .into_iter()
                .map(|sample| sample * 0.12),
        );
        samples.extend(
            tone(220.0, seconds, sr)
                .into_iter()
                .map(|sample| sample * 0.80),
        );

        let wave = release_overview_waveform(&samples, sr, 300);
        let third = wave.amp.len() / 3;
        let quiet_mean = wave.amp[third + third / 4..third * 2 - third / 4]
            .iter()
            .copied()
            .sum::<f32>()
            / (third - third / 2) as f32;
        let loud_mean = wave.amp[third * 2 + third / 4..wave.amp.len() - third / 4]
            .iter()
            .copied()
            .sum::<f32>()
            / (wave.amp.len() - third * 2 - third / 2) as f32;

        assert!(
            loud_mean > quiet_mean * 3.0,
            "macro overview must not lift quiet sections into the same thick wall: quiet={quiet_mean}, loud={loud_mean}",
        );
        assert!(
            wave.amp[..third / 2].iter().all(|value| *value <= 0.01),
            "true silence remains visibly separate from arranged sections",
        );
    }

    #[test]
    fn shared_detail_texture_changes_only_release_colour() {
        let sr = RELEASE_OVERVIEW_SR as f64;
        let mut samples = tone(110.0, 3.0, sr);
        samples.extend(tone(2_200.0, 3.0, sr));
        samples.extend(tone(6_000.0, 3.0, sr));
        let evidence = analyze_waveform_evidence(&samples, sr);
        let (_detail, texture) = band_waveform_and_texture_with_evidence(
            &samples,
            sr,
            detail_waveform_buckets(9.0),
            &evidence,
        );
        let fallback = release_overview_waveform_with_evidence(&samples, sr, 512, &evidence);
        let shared =
            release_overview_waveform_with_detail_texture(&samples, sr, 512, &evidence, &texture);
        assert_eq!(shared.amp, fallback.amp);
        assert_eq!(shared.minimum, fallback.minimum);
        assert_eq!(shared.maximum, fallback.maximum);
        assert_eq!(shared.transient, fallback.transient);
        let dominant_matches = (0..shared.r.len())
            .filter(|index| {
                let shared_rgb = [shared.r[*index], shared.g[*index], shared.b[*index]];
                let fallback_rgb = [fallback.r[*index], fallback.g[*index], fallback.b[*index]];
                shared_rgb
                    .iter()
                    .enumerate()
                    .max_by_key(|(_, value)| *value)
                    .map(|(channel, _)| channel)
                    == fallback_rgb
                        .iter()
                        .enumerate()
                        .max_by_key(|(_, value)| *value)
                        .map(|(channel, _)| channel)
            })
            .count();
        assert!(dominant_matches * 100 >= shared.r.len() * 95);
    }
}
