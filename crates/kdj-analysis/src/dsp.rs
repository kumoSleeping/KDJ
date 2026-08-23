//! 通用 DSP 原语：窗函数 / 分帧 / STFT / mel 滤波器组 / 滑动均值 / 自相关。
//!
//! 直译自 `sidecar/kdj/analysis/tempo.py` 里那几个 numpy 实现。
//! 每一个都必须和 numpy 版**数值一致**——用户曲库里 1379 首歌已经按旧结果分析过，
//! 这一层差一点，BPM 和调号就会整片漂移，和声推荐跟着重排。

use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;

pub const N_FFT: usize = 2048;
pub const HOP: usize = 512;
pub const N_MELS: usize = 64;
pub const MEL_FMIN: f64 = 30.0;
pub const MEL_FMAX: f64 = 11000.0;

/// 周期型 Hann 窗（`sym=False`）。
///
/// 用**周期**窗而不是对称窗：STFT 重叠相加要靠周期性才一致。
/// numpy 里是 `0.5 - 0.5*cos(2πn/N)`，注意分母是 N 不是 N-1。
pub fn hann_window(n: usize) -> Vec<f64> {
    if n <= 1 {
        return vec![1.0; n.max(1)];
    }
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos())
        .collect()
}

/// 幅度谱，返回 `(1 + n_fft/2)` 行 × `n_frames` 列，按行主序展平。
///
/// `center = true` 时两端反射补零，使第 i 帧的时间中心正好是 `i*hop/sr`——
/// 拍点时间戳直接用 `frame*hop/sr` 就对齐了，不用再补半窗偏移。
pub struct Spectrogram {
    pub bins: usize,
    pub frames: usize,
    /// 行主序：`data[bin * frames + frame]`
    pub data: Vec<f32>,
}

impl Spectrogram {
    #[inline]
    pub fn at(&self, bin: usize, frame: usize) -> f32 {
        self.data[bin * self.frames + frame]
    }
}

pub fn stft_magnitude(samples: &[f32], n_fft: usize, hop: usize) -> Spectrogram {
    let padded = reflect_pad(samples, n_fft / 2, n_fft);
    let bins = n_fft / 2 + 1;
    if padded.len() < n_fft {
        return Spectrogram {
            bins,
            frames: 0,
            data: Vec::new(),
        };
    }
    let frames = 1 + (padded.len() - n_fft) / hop;
    let window = hann_window(n_fft);

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n_fft);
    let mut scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];
    let mut buffer = vec![Complex32::new(0.0, 0.0); n_fft];
    let mut data = vec![0.0f32; bins * frames];

    for frame in 0..frames {
        let start = frame * hop;
        for (i, slot) in buffer.iter_mut().enumerate() {
            *slot = Complex32::new(padded[start + i] * window[i] as f32, 0.0);
        }
        fft.process_with_scratch(&mut buffer, &mut scratch);
        for bin in 0..bins {
            data[bin * frames + frame] = buffer[bin].norm();
        }
    }
    Spectrogram { bins, frames, data }
}

/// numpy `np.pad(y, pad, mode="reflect")`，长度不足时退回补零（和 Python 一致）。
fn reflect_pad(samples: &[f32], pad: usize, min_len: usize) -> Vec<f32> {
    let n = samples.len();
    if n == 0 {
        return vec![0.0; min_len];
    }
    let mut out = Vec::with_capacity(n + 2 * pad + min_len);
    if n > pad {
        // reflect：不重复边界元素，y[pad], y[pad-1], ..., y[1]
        for i in (1..=pad).rev() {
            out.push(samples[i]);
        }
        out.extend_from_slice(samples);
        for i in 1..=pad {
            out.push(samples[n - 1 - i]);
        }
    } else {
        // 样本比 pad 还短时 numpy 用的是 constant 模式
        out.extend(std::iter::repeat(0.0).take(pad));
        out.extend_from_slice(samples);
        out.extend(std::iter::repeat(0.0).take(pad));
    }
    while out.len() < min_len {
        out.push(0.0);
    }
    out
}

/// HTK 公式（不是 Slaney）。起音检测只关心刻度单调压缩，HTK 更简单。
pub fn hz_to_mel(hz: f64) -> f64 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

pub fn mel_to_hz(mel: f64) -> f64 {
    700.0 * (10.0f64.powf(mel / 2595.0) - 1.0)
}

pub fn rfft_freqs(n_fft: usize, sr: f64) -> Vec<f64> {
    (0..=n_fft / 2)
        .map(|i| i as f64 * sr / n_fft as f64)
        .collect()
}

/// 三角滤波器组，`n_mels` 行 × `1 + n_fft/2` 列。峰值归一（不做 Slaney 面积归一）。
pub fn mel_filterbank(sr: f64, n_fft: usize, n_mels: usize, fmin: f64, fmax: f64) -> Vec<Vec<f32>> {
    let fmax = if fmax > sr / 2.0 { sr / 2.0 } else { fmax };
    let freqs = rfft_freqs(n_fft, sr);
    let mel_lo = hz_to_mel(fmin);
    let mel_hi = hz_to_mel(fmax);
    let edges: Vec<f64> = (0..n_mels + 2)
        .map(|i| {
            let t = i as f64 / (n_mels + 1) as f64;
            mel_to_hz(mel_lo + t * (mel_hi - mel_lo))
        })
        .collect();

    (0..n_mels)
        .map(|i| {
            let (left, center, right) = (edges[i], edges[i + 1], edges[i + 2]);
            if right <= left {
                return vec![0.0f32; freqs.len()];
            }
            freqs
                .iter()
                .map(|f| {
                    let rising = (f - left) / (center - left).max(1e-9);
                    let falling = (right - f) / (right - center).max(1e-9);
                    rising.min(falling).max(0.0) as f32
                })
                .collect()
        })
        .collect()
}

/// 滑动均值（边缘 edge 复制补齐），前缀和实现 O(n)。
pub fn moving_average(x: &[f64], win: usize) -> Vec<f64> {
    let win = win.max(1);
    if win <= 1 || x.is_empty() {
        return x.to_vec();
    }
    let pad_left = win / 2;
    let pad_right = win - 1 - pad_left;
    let mut padded = Vec::with_capacity(x.len() + win);
    padded.extend(std::iter::repeat(x[0]).take(pad_left));
    padded.extend_from_slice(x);
    padded.extend(std::iter::repeat(x[x.len() - 1]).take(pad_right));

    let mut prefix = vec![0.0f64; padded.len() + 1];
    for (i, value) in padded.iter().enumerate() {
        prefix[i + 1] = prefix[i] + value;
    }
    (0..x.len())
        .map(|i| (prefix[i + win] - prefix[i]) / win as f64)
        .collect()
}

/// 循环自相关（补零到 2N 以上避免 wrap），返回 lag = 0..=max_lag 的**无偏**估计。
///
/// 无偏这一步不能省：lag 越大重叠样本越少，不除以重叠数会让长 lag 系统性偏小，
/// 慢速的曲子会被系统性判快。
pub fn autocorrelate(x: &[f64], max_lag: usize) -> Vec<f64> {
    let n = x.len();
    if n == 0 {
        return vec![0.0; max_lag + 1];
    }
    let mean = x.iter().sum::<f64>() / n as f64;
    let nfft = (2 * n).max(2).next_power_of_two();

    let mut planner = FftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(nfft);
    let ifft = planner.plan_fft_inverse(nfft);
    let mut buffer: Vec<rustfft::num_complex::Complex<f64>> = (0..nfft)
        .map(|i| {
            let value = if i < n { x[i] - mean } else { 0.0 };
            rustfft::num_complex::Complex::new(value, 0.0)
        })
        .collect();
    fft.process(&mut buffer);
    for slot in buffer.iter_mut() {
        // |X|²：功率谱，逆变换回来就是自相关
        *slot = rustfft::num_complex::Complex::new(slot.norm_sqr(), 0.0);
    }
    ifft.process(&mut buffer);

    (0..=max_lag.min(nfft - 1))
        .map(|lag| {
            let overlap = (n as f64 - lag as f64).max(1.0);
            buffer[lag].re / nfft as f64 / overlap
        })
        .chain(std::iter::repeat(0.0))
        .take(max_lag + 1)
        .collect()
}

/// 抛物线插值求亚采样峰位。
///
/// 自相关的 lag 只有整数分辨率，不插值 BPM 误差可达 2%（174 BPM 时差 3 个数）。
pub fn parabolic_peak(values: &[f64], idx: usize) -> f64 {
    if idx == 0 || idx + 1 >= values.len() {
        return idx as f64;
    }
    let (a, b, c) = (values[idx - 1], values[idx], values[idx + 1]);
    let denom = a - 2.0 * b + c;
    if denom.abs() < 1e-12 {
        return idx as f64;
    }
    let shift = 0.5 * (a - c) / denom;
    if !shift.is_finite() || shift.abs() > 1.0 {
        return idx as f64;
    }
    idx as f64 + shift
}

pub fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    }
}

/// numpy `np.percentile(..., interpolation="linear")`。
pub fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let pos = (q / 100.0) * (sorted.len() - 1) as f64;
    let low = pos.floor() as usize;
    let high = pos.ceil() as usize;
    if low == high {
        return sorted[low];
    }
    sorted[low] + (sorted[high] - sorted[low]) * (pos - low as f64)
}

/// 线性插值取值，等价 `np.interp(pos, arange(n), values)`。
pub fn interp_at(values: &[f64], pos: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let clamped = pos.clamp(0.0, (values.len() - 1) as f64);
    let low = clamped.floor() as usize;
    let high = clamped.ceil() as usize;
    if low == high {
        return values[low];
    }
    let frac = clamped - low as f64;
    values[low] * (1.0 - frac) + values[high] * frac
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn hann_is_periodic_not_symmetric() {
        let w = hann_window(4);
        // 周期窗：w[0]=0，且不以 0 结尾（对称窗才两端都是 0）
        assert!(close(w[0], 0.0, 1e-12));
        assert!(close(w[1], 0.5, 1e-12));
        assert!(close(w[2], 1.0, 1e-12));
        assert!(close(w[3], 0.5, 1e-12), "对称窗这里会是 0");
    }

    #[test]
    fn mel_scale_roundtrips() {
        for hz in [30.0, 440.0, 1000.0, 11025.0] {
            assert!(close(mel_to_hz(hz_to_mel(hz)), hz, 1e-6), "{hz}");
        }
        // HTK 而不是 Slaney：1000 Hz 处 HTK 给的是 999.99…，Slaney 给 15 个 mel
        assert!(close(hz_to_mel(1000.0), 999.9855, 1e-3));
    }

    #[test]
    fn filterbank_matches_the_numpy_implementation() {
        // 对拍值来自 sidecar 的 mel_filterbank(22050, 2048, 64, 30, 11000)。
        // 注意峰值**不是** 1.0：三角形顶点很少正好落在某个 FFT bin 上，
        // 低频带尤其窄，所以峰值天然小于 1——这不是 bug，Python 也一样。
        let fb = mel_filterbank(22050.0, N_FFT, N_MELS, MEL_FMIN, MEL_FMAX);
        assert_eq!(fb.len(), N_MELS);
        assert_eq!(fb[0].len(), N_FFT / 2 + 1);

        let expected_peaks = [
            0.916_689, 0.946_714, 0.984_958, 0.878_331, 0.977_000, 0.888_912, 0.896_536, 0.904_366,
        ];
        for (i, want) in expected_peaks.iter().enumerate() {
            let peak = fb[i].iter().cloned().fold(0.0f32, f32::max) as f64;
            assert!(
                close(peak, *want, 1e-5),
                "第 {i} 行峰值 {peak}，期望 {want}"
            );
        }
        let row3_sum: f64 = fb[3].iter().map(|v| *v as f64).sum();
        assert!(close(row3_sum, 3.381_121, 1e-4), "第 3 行和 {row3_sum}");
    }

    #[test]
    fn stft_of_a_sine_peaks_at_the_right_bin() {
        let sr = 22050.0;
        let freq = 440.0;
        let samples: Vec<f32> = (0..sr as usize)
            .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32)
            .collect();
        let spec = stft_magnitude(&samples, N_FFT, HOP);
        assert!(spec.frames > 30);

        let mid = spec.frames / 2;
        let (peak_bin, _) = (0..spec.bins)
            .map(|bin| (bin, spec.at(bin, mid)))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .unwrap();
        let expected = (freq * N_FFT as f64 / sr).round() as usize;
        assert!(
            peak_bin.abs_diff(expected) <= 1,
            "峰值 bin {peak_bin}，期望 {expected}"
        );
    }

    #[test]
    fn stft_frame_count_matches_the_numpy_formula() {
        // center=True 补 n_fft/2，帧数应当是 1 + len/hop
        let samples = vec![0.1f32; 22050];
        let spec = stft_magnitude(&samples, N_FFT, HOP);
        assert_eq!(spec.frames, 1 + 22050 / HOP);
    }

    #[test]
    fn moving_average_uses_edge_padding() {
        let x = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let got = moving_average(&x, 3);
        // 边缘复制：[1,1,2,3,4,5,5]
        assert!(close(got[0], (1.0 + 1.0 + 2.0) / 3.0, 1e-12));
        assert!(close(got[2], 3.0, 1e-12));
        assert!(close(got[4], (4.0 + 5.0 + 5.0) / 3.0, 1e-12));
        assert_eq!(got.len(), x.len());
    }

    #[test]
    fn autocorrelation_finds_the_period_of_a_pulse_train() {
        // 每 10 个样本一个脉冲
        let mut x = vec![0.0f64; 500];
        for i in (0..500).step_by(10) {
            x[i] = 1.0;
        }
        let ac = autocorrelate(&x, 40);
        // lag=10/20/30 应当是局部极大
        for lag in [10usize, 20, 30] {
            assert!(ac[lag] > ac[lag - 1], "lag={lag}");
            assert!(ac[lag] > ac[lag + 1], "lag={lag}");
        }
    }

    #[test]
    fn autocorrelation_is_unbiased_across_lags() {
        // 无偏化之后，纯周期信号在各个周期倍数上的值应当量级相当，
        // 不做无偏的话长 lag 会被系统性压低，慢曲子就会被判快
        let mut x = vec![0.0f64; 1000];
        for i in (0..1000).step_by(25) {
            x[i] = 1.0;
        }
        let ac = autocorrelate(&x, 200);
        let ratio = ac[200] / ac[25];
        assert!(ratio > 0.7, "lag=200 相对 lag=25 衰减过多：{ratio}");
    }

    #[test]
    fn parabolic_interpolation_recovers_a_subsample_peak() {
        // 顶点在 2.25 处的抛物线
        let values: Vec<f64> = (0..5).map(|i| -(i as f64 - 2.25).powi(2)).collect();
        assert!(close(parabolic_peak(&values, 2), 2.25, 1e-9));
        // 边界不插值
        assert!(close(parabolic_peak(&values, 0), 0.0, 1e-12));
    }

    #[test]
    fn percentile_matches_numpy_linear_interpolation() {
        let sorted = vec![1.0, 2.0, 3.0, 4.0];
        assert!(close(percentile(&sorted, 25.0), 1.75, 1e-12));
        assert!(close(percentile(&sorted, 75.0), 3.25, 1e-12));
        assert!(close(percentile(&sorted, 50.0), 2.5, 1e-12));
    }

    #[test]
    fn median_handles_both_parities() {
        assert!(close(median(&mut [3.0, 1.0, 2.0]), 2.0, 1e-12));
        assert!(close(median(&mut [4.0, 1.0, 3.0, 2.0]), 2.5, 1e-12));
    }

    #[test]
    fn reflect_padding_does_not_duplicate_the_edge_sample() {
        let samples = vec![1.0f32, 2.0, 3.0, 4.0, 5.0];
        let padded = reflect_pad(&samples, 2, 0);
        // numpy reflect: [3,2, 1,2,3,4,5, 4,3]
        assert_eq!(padded, vec![3.0, 2.0, 1.0, 2.0, 3.0, 4.0, 5.0, 4.0, 3.0]);
    }
}
