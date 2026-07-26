//! Serato 式彩色波形：**每一列一根柱子**，高度 = 响度，颜色 = 这一列的频谱构成。
//!
//! 做法照搬 libdjwaveform / Serato 的模型：STFT 之后，一帧（一列）先算出
//! 低/中/高三段的能量，高度取三段之和，颜色取三段的**相对占比**。
//!
//! 波形单开一条路径而不是塞进分析结果：它是纯展示用的，
//! 既不影响 BPM/调性，也不该逼用户为了看波形去重跑一次分析。

use kumodeck_core::models::Waveform;

use crate::dsp::{self, percentile};

/// 16 kHz：奈奎斯特 8 kHz，高频段还留得住镲和空气感；
/// 再高就只是让解码和 STFT 变慢，对一条几百像素宽的波形没有意义。
pub const WAVEFORM_SR: u32 = 16000;
const N_FFT: usize = 1024;
const HOP: usize = 512;
/// Serato 的三色交叉点（社区实测）：红↔绿 ≈ 200 Hz，绿↔蓝 ≈ 1.5 kHz。
/// 2.5 kHz 试过，人声段会被算成"高频"而发蓝，1.5 kHz 才把人声留在绿区。
const XOVER_LOW: f64 = 200.0;
const XOVER_HIGH: f64 = 1500.0;
const AMP_GAMMA: f64 = 1.2;
/// γ 很大是必须的：占比的偏离量本身很小（0.45 → 0.50 这种级别），
/// γ=2 出来是一片淡彩，γ=6 才是 DJ 软件里那种能一眼分辨段落的饱和色。
const COLOR_GAMMA: f64 = 6.0;
/// 通道下限：纯 (255,0,0) 在深色底上太扎眼，抬一点让暗通道保留一丝底色。
const COLOR_FLOOR: f64 = 0.12;

pub fn band_waveform(samples: &[f32], sr: f64, buckets: usize) -> Waveform {
    let buckets = buckets.clamp(64, 2000);
    // center=false：波形要的是"第 n 段音频长什么样"，不需要和拍点对齐
    let spec = stft_no_center(samples, N_FFT, HOP);
    let n_frames = spec.frames;
    if n_frames == 0 {
        return Waveform::default();
    }

    let freqs = dsp::rfft_freqs(N_FFT, sr);
    let band_of = |bin: usize| -> usize {
        let hz = freqs[bin];
        if hz < XOVER_LOW {
            0
        } else if hz < XOVER_HIGH {
            1
        } else {
            2
        }
    };

    // 每帧三段的功率
    let mut energies = [
        vec![0.0f64; n_frames],
        vec![0.0f64; n_frames],
        vec![0.0f64; n_frames],
    ];
    for frame in 0..n_frames {
        for bin in 0..spec.bins {
            let magnitude = spec.at(bin, frame) as f64;
            energies[band_of(bin)][frame] += magnitude * magnitude;
        }
    }

    // 帧 → 显示格。尾巴不足一格的直接截掉，补零会画出一根假的静音柱。
    let step = (n_frames / buckets).max(1);
    let count = n_frames / step;
    if count == 0 {
        return Waveform::default();
    }
    let mut bands = [vec![0.0f64; count], vec![0.0f64; count], vec![0.0f64; count]];
    for (band, source) in bands.iter_mut().zip(&energies) {
        for (index, slot) in band.iter_mut().enumerate() {
            let start = index * step;
            *slot = source[start..start + step].iter().sum::<f64>() / step as f64;
        }
    }

    // ---- 高度：三段功率之和开根号（= 幅度），再做百分位对比拉伸。
    // 只除以 P99 是不够的：现代母带压完之后整首的 RMS 都挤在 0.6~1.0，
    // 画出来就是一条实心带。把 P5 当作"地板"减掉，起伏才回得来。
    let mut amp: Vec<f64> = (0..count)
        .map(|i| (bands[0][i] + bands[1][i] + bands[2][i]).sqrt())
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
    for value in amp.iter_mut() {
        *value = ((*value - lo) / (hi - lo).max(1e-9)).clamp(0.0, 1.0).powf(AMP_GAMMA);
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
    let mut mag: [Vec<f64>; 3] = [
        bands[0].iter().map(|v| v.sqrt()).collect(),
        bands[1].iter().map(|v| v.sqrt()).collect(),
        bands[2].iter().map(|v| v.sqrt()).collect(),
    ];

    // 配色前先沿时间轴做滑动平均：一格才 200~300 ms，底鼓和踩镲会逐格交替，
    // 不平滑的话每根柱子颜色都跳，画出来是彩色噪点。
    // 高度不参与平滑——瞬态该锐就得锐。
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
        amp: amp
            .into_iter()
            .map(|v| ((v * 10_000.0).round() / 10_000.0) as f32)
            .collect(),
        r,
        g,
        b,
    }
}

/// `center = false` 的 STFT。波形不需要和拍点对齐，省掉两端的反射补零。
fn stft_no_center(samples: &[f32], n_fft: usize, hop: usize) -> dsp::Spectrogram {
    use rustfft::num_complex::Complex32;
    use rustfft::FftPlanner;

    let bins = n_fft / 2 + 1;
    if samples.len() < n_fft {
        return dsp::Spectrogram {
            bins,
            frames: 0,
            data: Vec::new(),
        };
    }
    let frames = 1 + (samples.len() - n_fft) / hop;
    let window = dsp::hann_window(n_fft);

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n_fft);
    let mut scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];
    let mut buffer = vec![Complex32::new(0.0, 0.0); n_fft];
    let mut data = vec![0.0f32; bins * frames];

    for frame in 0..frames {
        let start = frame * hop;
        for (i, slot) in buffer.iter_mut().enumerate() {
            *slot = Complex32::new(samples[start + i] * window[i] as f32, 0.0);
        }
        fft.process_with_scratch(&mut buffer, &mut scratch);
        for bin in 0..bins {
            data[bin * frames + frame] = buffer[bin].norm();
        }
    }
    dsp::Spectrogram { bins, frames, data }
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
    fn bucket_count_follows_the_integer_division_rule() {
        // 分格是 `step = max(1, n_frames/buckets)` 再 `count = n_frames/step`
        //（和 Python 版同一个公式）。两条推论：
        //  1. 帧数不够时，请求再多格也只能给出帧数那么多列；
        //  2. 帧数远多于请求格数时，整数除法会让实际列数略多于请求值。
        let sr = WAVEFORM_SR as f64;
        let frames_of = |seconds: f64| 1 + ((seconds * sr) as usize - N_FFT) / HOP;

        // 30 秒 ≈ 937 帧：请求 640 格时 step 被压到 1，只能原样给 937 列
        let short = band_waveform(&tone(440.0, 30.0, sr), sr, 640);
        assert_eq!(short.amp.len(), frames_of(30.0), "帧数不足时按帧给");

        // 5 分钟 ≈ 9370 帧：这时才谈得上"接近请求值"
        let long_samples = tone(440.0, 300.0, sr);
        for buckets in [100usize, 300, 640] {
            let wave = band_waveform(&long_samples, sr, buckets);
            assert!(
                wave.amp.len() >= buckets && wave.amp.len() <= buckets * 12 / 10,
                "请求 {buckets} 格，实际 {}",
                wave.amp.len()
            );
        }
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
