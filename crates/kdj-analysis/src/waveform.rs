//! DJ RGB 波形：**每一列一根柱子**，高度 = 峰值包络，颜色 = 这一列的频谱构成。
//!
//! Mixxx 的正式波形不是把低采样率 STFT 拉宽，而是先用低/中/高分频器连续处理 PCM，
//! 再把细粒度峰值包络聚合到屏幕列。这里采用同一条快路径：互补 IIR crossover 只扫
//! 一遍样本，生成 200 列/秒的 master，overview 取均值，局部 DJ 视图保留 100 列/秒。
//!
//! 波形单开一条路径而不是塞进分析结果：它是纯展示用的，
//! 既不影响 BPM/调性，也不该逼用户为了看波形去重跑一次分析。

use kdj_core::models::Waveform;

use crate::dsp::{self, percentile};

/// 合成测试和显式降采样调用方的参考采样率。产品装轨快路径保留音源 native rate，
/// 避免为了展示波形跑整轨 sinc resample。
pub const WAVEFORM_SR: u32 = 22_050;
/// 普通歌曲按 100 列/秒保存详细波形；十分钟以上曲目再受总列数上限保护。
pub const DETAIL_WAVEFORM_COLUMNS_PER_SECOND: f64 = 100.0;
pub const MAX_WAVEFORM_BUCKETS: usize = 24_000;
const MIN_DETAIL_WAVEFORM_BUCKETS: usize = 2_000;

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
/// 小于 1 的 gamma 会保住 break、弱拍和混响尾巴；旧 1.2 会把它们压进中线。
const AMP_GAMMA: f64 = 0.72;
/// γ 很大是必须的：占比的偏离量本身很小（0.45 → 0.50 这种级别），
/// γ=2 出来是一片淡彩，γ=6 才是 DJ 软件里那种能一眼分辨段落的饱和色。
const COLOR_GAMMA: f64 = 6.0;
/// 通道下限：纯 (255,0,0) 在深色底上太扎眼，抬一点让暗通道保留一丝底色。
const COLOR_FLOOR: f64 = 0.12;

/// Unnormalised peak energy for the broad low/mid/high bands at a display resolution.
///
/// `band_waveform` turns these into intentionally vivid full-track RGB. Live STEM lanes instead
/// use the genuine ratios and loudness below to preserve each separated source's stable character.
#[derive(Debug, Default)]
pub struct BandEnergy {
    pub overall: Vec<f64>,
    pub low: Vec<f64>,
    pub mid: Vec<f64>,
    pub high: Vec<f64>,
}

/// Summarise the complementary low/mid/high crossover peaks without applying a display palette.
/// Each result column is the mean of its underlying 5 ms peak frames.
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
    let energy = band_energy(samples, sr, buckets);
    let count = energy.overall.len();
    if count == 0 {
        return Waveform::default();
    }

    // 细 master → 请求列。每列对 5 ms 峰值取均值，和 Mixxx summary 的
    // “先取细峰、再平均”一致：overview 不会被单个 click 撑成实心墙，详细档也不糊瞬态。
    let mut overall = energy.overall;
    let bands = [energy.low, energy.mid, energy.high];

    // ---- 高度：P99.5 只负责挡异常峰，不再减 P5。真正的静音仍是 0，弱 intro、
    // break 和 reverb tail 不会像旧实现一样被整段裁掉。
    let mut sorted = overall.clone();
    sorted.sort_by(f64::total_cmp);
    let hi = {
        let value = percentile(&sorted, 99.5);
        if value > 0.0 {
            value
        } else {
            1.0
        }
    };
    for value in overall.iter_mut() {
        *value = (*value / hi).clamp(0.0, 1.0).powf(AMP_GAMMA);
    }

    // ---- 颜色：这一列的频谱**占比**，相对全曲常态的偏离量。
    //
    // 试过三种，前两种都不行：
    //   A. 三段幅度用同一个尺度直接当 RGB——中频带宽最宽、能量天然最大，
    //      每列的最大通道永远是绿，整首绿成一片。
    //   B. 三段各按自己的 P95 归一——三段的响度是高度相关的（一起大声一起小声），
    //      归一后每列三通道都接近 1，整首发白。
    //   C. 先把每列化成"低/中/高各占多少"（除掉共同的响度），再和全曲的常态
    //      占比相比——只有比常态更强的频段才亮。鼓点段红、人声段绿、镲密的段蓝。
    //
    // 代价：颜色是**相对本曲**的，两首曲子的同一个颜色不代表同样的绝对频谱。
    // 但波形是拿来看单曲结构的，段落之间分得开比跨曲可比更有用。
    let mut mag = bands;

    // overview 的单列已经平均了数十个 master 峰，不必再跨秒平滑。只有详细档做
    // 3 列去毛刺（约 30 ms）；旧 `count/128` 在 4096 档会把颜色抹平一秒以上。
    let duration = samples.len() as f64 / sr.max(1.0);
    let columns_per_second = count as f64 / duration.max(1e-9);
    let span = if columns_per_second >= 20.0 { 3 } else { 1 };
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

    // 用中位数而不是均值：几个特别猛的低频瞬态会把均值拉高，常态就跑偏了
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
        let dev: [f64; 3] =
            std::array::from_fn(|band| (share[band][i] / reference[band]).powf(COLOR_GAMMA));
        let peak = dev.iter().cloned().fold(0.0f64, f64::max).max(1e-9);
        let channels: [u8; 3] = std::array::from_fn(|band| {
            let normalized = (dev[band] / peak).clamp(0.0, 1.0);
            let lifted = COLOR_FLOOR + (1.0 - COLOR_FLOOR) * normalized;
            (lifted * 255.0).round() as u8
        });
        r[i] = channels[0];
        g[i] = channels[1];
        b[i] = channels[2];
    }

    Waveform {
        track_id: 0,
        duration: ((samples.len() as f64 / sr) * 1000.0).round() / 1000.0,
        amp: overall
            .into_iter()
            .map(|v| ((v * 10_000.0).round() / 10_000.0) as f32)
            .collect(),
        r,
        g,
        b,
    }
}

/// 一阶互补 crossover：`low + mid + high == input`，没有 FFT 窗引入的 64 ms 拖影。
/// 每个输出 frame 保存该 5 ms 内的绝对峰，内存与曲长线性但只有四个 f64 序列。
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
            }
        }
        for index in 0..4 {
            peaks[index].push(frame_peaks[index]);
        }
    }
    peaks
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!((wave.duration - 10.0).abs() < 0.05);
    }

    #[test]
    fn bucket_count_is_exact_until_the_master_density_is_exhausted() {
        let sr = WAVEFORM_SR as f64;
        let frames_of = |seconds: f64| {
            ((seconds * sr) as usize).div_ceil((sr / MASTER_COLUMNS_PER_SECOND).round() as usize)
        };

        // 30 秒有约 6000 个 master 峰；普通 overview 应严格得到请求的 640 列。
        let short = band_waveform(&tone(440.0, 30.0, sr), sr, 640);
        assert_eq!(short.amp.len(), 640);

        // 请求超过 master 密度时不补假列，前端在屏幕空间插值。
        let oversized = band_waveform(&tone(440.0, 1.0, sr), sr, 2_000);
        assert_eq!(oversized.amp.len(), frames_of(1.0));

        // 长曲的 overview 也保持稳定 payload 大小。
        let long_samples = tone(440.0, 300.0, sr);
        for buckets in [100usize, 300, 640] {
            let wave = band_waveform(&long_samples, sr, buckets);
            assert_eq!(wave.amp.len(), buckets.max(64));
        }
    }

    #[test]
    fn detailed_profile_keeps_one_hundred_real_columns_per_second() {
        let sr = WAVEFORM_SR as f64;
        let seconds = 30.0;
        let requested = (seconds * DETAIL_WAVEFORM_COLUMNS_PER_SECOND) as usize;
        let wave = band_waveform(&tone(440.0, seconds, sr), sr, requested);
        assert_eq!(wave.amp.len(), requested);
    }

    #[test]
    fn detail_bucket_count_matches_the_frontend_viewport_contract() {
        assert_eq!(detail_waveform_buckets(0.0), 2_000);
        assert_eq!(detail_waveform_buckets(180.0), 18_000);
        assert_eq!(detail_waveform_buckets(600.0), 24_000);
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
    fn colour_channels_never_go_fully_black() {
        // 纯 (255,0,0) 在深色底上太扎眼，暗通道要保留一丝底色
        let samples = tone(100.0, 10.0, WAVEFORM_SR as f64);
        let wave = band_waveform(&samples, WAVEFORM_SR as f64, 200);
        let floor = (COLOR_FLOOR * 255.0).round() as u8;
        assert!(wave.r.iter().all(|v| *v >= floor));
        assert!(wave.g.iter().all(|v| *v >= floor));
        assert!(wave.b.iter().all(|v| *v >= floor));
    }

    #[test]
    fn too_short_input_returns_an_empty_waveform_instead_of_panicking() {
        let wave = band_waveform(&[0.0; 100], WAVEFORM_SR as f64, 200);
        assert!(wave.amp.is_empty());
    }
}
