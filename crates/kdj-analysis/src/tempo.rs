//! BPM 估计 + 节拍网格。
//!
//! 流程：STFT → mel 起音强度包络 → 自相关粗估速度 → 低速候选消歧 →
//! Ellis 动态规划跟踪拍点 → 由拍点回算精修 BPM。
//!
//! 直译自 `sidecar/kdj/analysis/tempo.py`。里面每个魔法常数都是拿真实曲库调出来的，
//! **不要凭直觉改**——Python 版的注释里已经记了两次"试过 X，实测更差"的结论。

use crate::dsp::{
    self, autocorrelate, hann_window, interp_at, median, mel_filterbank, moving_average,
    parabolic_peak, percentile, HOP, MEL_FMAX, MEL_FMIN, N_FFT, N_MELS,
};

pub const BPM_MIN: f64 = 60.0;
pub const BPM_MAX: f64 = 200.0;
const TIGHTNESS: f64 = 100.0;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TempoResult {
    pub bpm: f64,
    pub bpm_raw: f64,
    pub confidence: f64,
    pub beat_times: Vec<f64>,
    /// Normalized onset strength at each tracked beat, used only for conservative 4/4 accent
    /// classification. Equal-strength beats intentionally produce no downbeat claim.
    pub beat_strengths: Vec<f64>,
    pub first_beat: f64,
    pub beat_interval: f64,
}

// ---------------------------------------------------------------- 起音包络

/// 起音强度包络 + 帧率 fps。
///
/// mel 谱一阶差分 → 半波整流 → 频带求和 → 减 0.5 s 滑动均值 → 再整流 → 归一化。
/// 减滑动均值是为了压掉长音符的持续能量，只留下"变化"，
/// 对 pad / 人声铺底的曲子很关键。
pub fn onset_envelope(samples: &[f32], sr: f64) -> (Vec<f64>, f64) {
    let fps = sr / HOP as f64;
    if samples.is_empty() {
        return (Vec::new(), fps);
    }
    let peak = samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
    // 归一化，让 log1p(10*S) 的压缩量和音量无关
    let normalized: Vec<f32> = if peak > 0.0 {
        samples.iter().map(|s| s / peak).collect()
    } else {
        samples.to_vec()
    };

    let spec = dsp::stft_magnitude(&normalized, N_FFT, HOP);
    if spec.frames == 0 {
        return (Vec::new(), fps);
    }
    let fb = mel_filterbank(sr, N_FFT, N_MELS, MEL_FMIN, MEL_FMAX.min(sr / 2.0));

    // logmel[(mel, frame)]，随后沿时间一阶差分
    let mut logmel = vec![0.0f64; N_MELS * spec.frames];
    for (mel, row) in fb.iter().enumerate() {
        for frame in 0..spec.frames {
            let mut acc = 0.0f64;
            for (bin, weight) in row.iter().enumerate() {
                if *weight != 0.0 {
                    acc += *weight as f64 * spec.at(bin, frame) as f64;
                }
            }
            logmel[mel * spec.frames + frame] = (1.0 + 10.0 * acc).ln();
        }
    }

    // np.diff(..., prepend=第一列) → 第 0 帧的差分恒为 0
    let mut env = vec![0.0f64; spec.frames];
    for mel in 0..N_MELS {
        let row = &logmel[mel * spec.frames..(mel + 1) * spec.frames];
        for frame in 1..spec.frames {
            let diff = row[frame] - row[frame - 1];
            if diff > 0.0 {
                env[frame] += diff;
            }
        }
    }

    let win = {
        let raw = (0.5 * fps).round() as usize;
        (raw | 1).max(3)
    };
    let baseline = moving_average(&env, win);
    for (value, base) in env.iter_mut().zip(baseline) {
        *value = (*value - base).max(0.0);
    }

    let top = env.iter().cloned().fold(0.0f64, f64::max);
    if top > 0.0 {
        for value in env.iter_mut() {
            *value /= top;
        }
    }
    (env, fps)
}

// ---------------------------------------------------------------- 速度估计

/// 对数正态先验，中心 120 BPM，σ = 0.9 个八度。抑制自相关天然偏爱的长 lag。
fn tempo_prior(bpm: f64) -> f64 {
    (-0.5 * ((bpm / 120.0).log2() / 0.9).powi(2)).exp()
}

/// 梳状滤波打分：按 period 折叠包络，取最优相位下的「拍上能量 − 拍间能量」。
///
/// 只看拍上能量是分不出 T 和 2T 的（2T 的每一次命中都落在真拍上，均值一样高）。
/// 减掉偏移半个周期的"拍间能量"就能分开：
/// - period = 真周期 → 拍间是弱拍，差值大；
/// - period = 2×真周期 → 拍间正好是另一半真拍，差值 ≈ 0；
/// - period = 0.5×真周期 → 拍上一半命中空档，均值本身就低。
///
/// 这正是舞曲 128 被判成 64/256 的解药。
pub fn comb_score(env: &[f64], period: f64) -> f64 {
    let n = env.len();
    if period < 2.0 || n < 8 {
        return 0.0;
    }
    let n_cycles = ((n - 1) as f64 / period) as usize;
    if n_cycles < 3 {
        return 0.0;
    }
    let n_phase = (period.ceil() as usize).max(2);
    let limit = (n - 1) as f64;

    let mut best_on = f64::NEG_INFINITY;
    let mut best_off = 0.0;
    for phase in 0..n_phase {
        let mut on_sum = 0.0;
        let mut on_count = 0usize;
        let mut off_sum = 0.0;
        let mut off_count = 0usize;
        for cycle in 0..=n_cycles {
            let pos_on = phase as f64 + period * cycle as f64;
            if pos_on <= limit {
                on_sum += interp_at(env, pos_on);
                on_count += 1;
            }
            let pos_off = pos_on + period / 2.0;
            if pos_off <= limit {
                off_sum += interp_at(env, pos_off);
                off_count += 1;
            }
        }
        let on = on_sum / on_count.max(1) as f64;
        if on > best_on {
            best_on = on;
            best_off = off_sum / off_count.max(1) as f64;
        }
    }
    let contrast = (best_on - best_off).max(0.0);
    // 加一点绝对能量：全曲毫无拍间对比时（纯 pad / 氛围）至少还能按能量排出个先后
    contrast + 0.05 * best_on
}

/// 自相关粗估：在 `[BPM_MIN, BPM_MAX]` 对应的 lag 区间取前 `top` 个峰。
pub fn tempo_candidates(env: &[f64], fps: f64, top: usize) -> Vec<f64> {
    if env.len() < 16 {
        return Vec::new();
    }
    let min_lag = ((60.0 * fps / BPM_MAX).floor() as usize).max(2);
    let max_lag = ((60.0 * fps / BPM_MIN).ceil() as usize).min(env.len().saturating_sub(2));
    if max_lag <= min_lag + 1 {
        return Vec::new();
    }

    let ac = autocorrelate(env, max_lag);
    let mut weighted = vec![0.0f64; ac.len()];
    for lag in min_lag..=max_lag {
        let bpm = 60.0 * fps / (lag as f64).max(1e-9);
        weighted[lag] = ac[lag].max(0.0) * tempo_prior(bpm);
    }

    let mut peaks: Vec<usize> = (min_lag + 1..max_lag)
        .filter(|lag| {
            weighted[*lag] > weighted[lag - 1]
                && weighted[*lag] >= weighted[lag + 1]
                && weighted[*lag] > 0.0
        })
        .collect();
    if peaks.is_empty() {
        let argmax = weighted
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(i, _)| i)
            .unwrap_or(min_lag);
        peaks.push(argmax);
    }
    peaks.sort_by(|a, b| {
        weighted[*b]
            .partial_cmp(&weighted[*a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    peaks
        .into_iter()
        .take(top)
        .filter_map(|idx| {
            let lag = parabolic_peak(&weighted, idx);
            (lag > 0.0).then(|| 60.0 * fps / lag)
        })
        .collect()
}

/// 在自相关候选里找与 `bpm_raw` 成 `lo..=hi` 倍关系的峰。
fn find_ratio_peak(bpm_raw: f64, candidates: &[f64], lo: f64, hi: f64) -> Option<f64> {
    candidates
        .iter()
        .copied()
        .find(|candidate| (lo..=hi).contains(&(*candidate / bpm_raw)))
}

/// 在候选里取与 raw 成近 2× 的最快峰。
fn find_double_peak(bpm_raw: f64, candidates: &[f64]) -> Option<f64> {
    candidates
        .iter()
        .copied()
        .filter(|candidate| {
            let ratio = *candidate / bpm_raw;
            (1.95..=2.05).contains(&ratio)
        })
        .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
}

/// 起音包络里局部峰的密度（峰/秒）。阈值 0.15 对应归一化后的中等起音。
fn onset_peak_rate(env: &[f64], fps: f64) -> f64 {
    if env.len() < 3 || fps <= 0.0 {
        return 0.0;
    }
    let mut peaks = 0usize;
    for i in 1..env.len() - 1 {
        if env[i] >= 0.15 && env[i] > env[i - 1] && env[i] >= env[i + 1] {
            peaks += 1;
        }
    }
    let duration = env.len() as f64 / fps;
    if duration <= 0.0 {
        0.0
    } else {
        peaks as f64 / duration
    }
}

/// 若把 `bpm` 当拍速，平均每拍落多少起音峰。>1 说明网格偏慢（细分被算成拍）。
fn onsets_per_beat(env: &[f64], fps: f64, bpm: f64) -> f64 {
    if bpm <= 0.0 {
        return 0.0;
    }
    onset_peak_rate(env, fps) / (bpm / 60.0)
}

/// 4:3 提升：主峰常是「每三拍一组」的慢网格，真四分在 4/3 倍。
///
/// Our Chant：raw 92、次峰 184（2×）、第三峰 123（4/3）；梳状分 123 最高 → 123。
/// 只有当 4/3 峰的梳状分不弱于 raw **且不弱于 2×** 才升，避免和真倍速抢。
fn promote_four_three(env: &[f64], fps: f64, bpm_raw: f64, candidates: &[f64]) -> Option<f64> {
    // 只修「主峰偏慢」：raw 已在常见舞曲区就别再抬（Sky High 128 不该→172）。
    if bpm_raw >= 110.0 {
        return None;
    }
    let mid = find_ratio_peak(bpm_raw, candidates, 1.28, 1.40)?;
    // 起音过密（每拍 >1.4 个峰）是典型「高速曲被听成半速」：交给 2×，
    // 不让差一点的 4:3 峰（VICTORY 的 127）截胡真 2×（188）。
    if onsets_per_beat(env, fps, bpm_raw) >= 1.4 {
        return None;
    }
    let raw_score = comb_score(env, 60.0 * fps / bpm_raw);
    let mid_score = comb_score(env, 60.0 * fps / mid);
    if mid_score < raw_score {
        return None;
    }
    if let Some(double) = find_double_peak(bpm_raw, candidates) {
        let double_score = comb_score(env, 60.0 * fps / double);
        // 必须明显优于 2×，平局或微弱优势都留给倍速通道。
        if mid_score < double_score * 1.15 {
            return None;
        }
    }
    Some(mid)
}

/// 2× 半速救援。
///
/// - `bpm_raw < 75` 或 `85..90`：历史无条件提升（只要 2× 已是自相关峰）。
/// - 其它区间：单靠梳状会在 EDM 100↔200 与动画高速曲上互打脸
///   （Full Glory 梳状站 99、Summersong 梳状站 199，真相相反）。
///   用「每拍起音数」辅助：raw 上每拍 >~1.4 个起音 → 网格偏慢，抬到 2×；
///   每拍 ≤1 且只是梳状略偏 2× → 保持 raw（Summersong ~100）。
fn promote_double_tempo(env: &[f64], fps: f64, bpm_raw: f64, candidates: &[f64]) -> Option<f64> {
    let fast = find_double_peak(bpm_raw, candidates)?;
    let allow_unconditional = bpm_raw < 75.0 || (85.0..90.0).contains(&bpm_raw);
    if allow_unconditional {
        return Some(fast);
    }

    let raw_score = comb_score(env, 60.0 * fps / bpm_raw);
    let fast_score = comb_score(env, 60.0 * fps / fast);
    let opb = onsets_per_beat(env, fps, bpm_raw);

    // 起音明显密于「一拍一下」→ 主峰是半速（Full Glory opb≈1.6 / VICTORY≈1.5）。
    if opb >= 1.4 {
        return Some(fast);
    }
    let comb_ratio = fast_score / raw_score.max(1e-9);
    // 起音极稀（铺底长、鼓点很晚才进，如 ONENESS 约 21s 后才上速度）：
    // 密度统计失真，改信梳状。限定 raw∈[85,105]（高速曲半速主峰的典型落点），
    // 避免和 Summersong（opb≈0.95、同样 comb 略偏 2×）搅在一起。
    if opb < 0.5 && comb_ratio >= 1.3 && (85.0..105.0).contains(&bpm_raw) {
        return Some(fast);
    }
    // 梳状明显偏好 2× + 不算稀疏：BRAVE JEWEL（comb×3、opb≈1.0）。
    if comb_ratio >= 1.5 && opb >= 1.0 {
        return Some(fast);
    }
    // 梳状压倒性偏好 2×（≥2.5×）：流行朋克半速主峰（The Other Line comb×3.5、
    // opb≈0.71）。Summersong 2025 只有 comb×1.7 且 opb≈0.95，不会误触。
    if comb_ratio >= 2.5 && opb >= 0.65 {
        return Some(fast);
    }
    // 梳状略偏 2× + 中等偏密。
    if comb_ratio >= 1.0 && opb >= 1.25 {
        return Some(fast);
    }
    None
}

/// 3:2（×1.5）提升：每三个八分音符的强重音会把自相关主峰钉在真速度的 ⅔。
///
/// - `bpm_raw < 100`：历史规则，直接升到 1.5×（85→128/171、93→141 一类偶像曲）。
/// - `bpm_raw ≥ 100`：必须 1.5× 已是自相关峰，且梳状对比**不弱于**主峰才升。
///   Sing Alive 官方 195：主峰 129（=195×⅔），次峰 195，梳状分 195≥129 → 提升；
///   对正确的 120 不会仅仅因为存在弱 180 峰就被拉走。
fn promote_three_two(env: &[f64], fps: f64, bpm_raw: f64, candidates: &[f64]) -> Option<f64> {
    let fast = find_ratio_peak(bpm_raw, candidates, 1.45, 1.55)?;
    if bpm_raw < 100.0 {
        return Some(fast);
    }
    let raw_score = comb_score(env, 60.0 * fps / bpm_raw);
    let fast_score = comb_score(env, 60.0 * fps / fast);
    (fast_score >= raw_score).then_some(fast)
}

/// 返回 `(最终 bpm, 自相关粗估 bpm)`。倍频修正在这里做。
pub fn choose_tempo(env: &[f64], fps: f64) -> (f64, f64) {
    // 五个峰仍很便宜，却能保住 4:3 层级较弱的那一支（真实曲库里常落在第 4 峰）。
    let cands = tempo_candidates(env, fps, 5);
    let Some(&bpm_raw) = cands.first() else {
        return (0.0, 0.0);
    };

    // 以最强自相关峰为主，不再让梳状滤波在互不相关的速度族之间投票。
    // 后者会把 150 BPM 的 final phase 稳定选成三连音脉冲 100 BPM。
    //
    // 同一速度族内的关系按「更细 → 更粗」试：3:2、4:3、2:1。
    // 候选必须已经是自相关强峰，不会凭空造速度。
    if let Some(fast) = promote_three_two(env, fps, bpm_raw, &cands) {
        return (fast, bpm_raw);
    }
    // 4:3 必须在 2× 之前：否则 Our Chant 会先被 92→184 吃掉。
    if let Some(mid) = promote_four_three(env, fps, bpm_raw, &cands) {
        return (mid, bpm_raw);
    }
    if let Some(fast) = promote_double_tempo(env, fps, bpm_raw, &cands) {
        return (fast, bpm_raw);
    }

    // 高速主峰也可能只是细分拍。这里只在同一速度族内部比较梳状对比度：
    // 半速必须比高速更像“拍上强、拍间弱”；3:4 层则允许很小余量，因为
    // shuffle / 三连音编曲的四分音符并不一定拥有更强的全频瞬态。
    let raw_score = comb_score(env, 60.0 * fps / bpm_raw);
    let slower = cands.iter().copied().find(|candidate| {
        let ratio = *candidate / bpm_raw;
        let candidate_score = comb_score(env, 60.0 * fps / *candidate);
        ((0.48..=0.52).contains(&ratio)
            && (((155.0..=165.0).contains(&bpm_raw) && candidate_score > raw_score)
                || ((150.0..155.0).contains(&bpm_raw) && candidate_score > 3.0 * raw_score)))
            || ((100.0..=125.0).contains(&bpm_raw)
                && (0.73..=0.77).contains(&ratio)
                && candidate_score >= 0.85 * raw_score)
    });
    (slower.unwrap_or(bpm_raw), bpm_raw)
}

// ---------------------------------------------------------------- 节拍跟踪（Ellis DP）

/// DP 的局部得分：包络按 std 归一后用 σ = period/32 的高斯窗平滑（Ellis 原做法）。
fn local_score(env: &[f64], period: f64) -> Vec<f64> {
    let n = env.len();
    let mean = env.iter().sum::<f64>() / n.max(1) as f64;
    let var = env.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n.max(1) as f64;
    let std = var.sqrt();
    let norm: Vec<f64> = if std > 0.0 {
        env.iter().map(|v| v / std).collect()
    } else {
        env.to_vec()
    };

    let half = (period.round() as usize).max(1);
    let window: Vec<f64> = (0..=2 * half)
        .map(|i| {
            let axis = i as f64 - half as f64;
            (-0.5 * (axis * 32.0 / period.max(1e-6)).powi(2)).exp()
        })
        .collect();

    // np.convolve(..., mode="same")
    let mut out = vec![0.0f64; n];
    let offset = window.len() / 2;
    for (i, slot) in out.iter_mut().enumerate() {
        let mut acc = 0.0;
        for (k, w) in window.iter().enumerate() {
            let idx = i as isize + offset as isize - k as isize;
            if idx >= 0 && (idx as usize) < n {
                acc += norm[idx as usize] * w;
            }
        }
        *slot = acc;
    }
    out
}

/// Ellis 动态规划节拍跟踪，返回拍点所在帧号（升序）。
///
/// `D[t] = local[t] + max_τ (−tightness·(log(τ/period))² + D[t−τ])`，
/// τ 只在 `[period/2, 2·period]` 里找——放开范围会让 DP 直接跳成半速/倍速。
pub fn beat_track_dp(env: &[f64], period: f64) -> Vec<usize> {
    let n = env.len();
    if n == 0 || period < 2.0 {
        return Vec::new();
    }
    let local = local_score(env, period);
    let lo = (period / 2.0).round() as usize;
    let hi = {
        let raw = (2.0 * period).round() as usize;
        if raw <= lo {
            lo + 1
        } else {
            raw
        }
    };
    let taus: Vec<usize> = (lo.max(1)..=hi).collect();
    if taus.is_empty() {
        return Vec::new();
    }
    let penalty: Vec<f64> = taus
        .iter()
        .map(|tau| -TIGHTNESS * ((*tau as f64 / period).ln()).powi(2))
        .collect();

    let mut cumscore = vec![0.0f64; n];
    let mut backlink = vec![-1isize; n];
    let threshold = 0.01 * local.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let mut started = false;

    for t in 0..n {
        let mut best_value = f64::NEG_INFINITY;
        let mut best_prev = -1isize;
        for (tau, pen) in taus.iter().zip(&penalty) {
            if *tau > t {
                continue;
            }
            let prev = t - tau;
            let value = pen + cumscore[prev];
            if value > best_value {
                best_value = value;
                best_prev = prev as isize;
            }
        }
        if best_prev < 0 {
            cumscore[t] = local[t];
            backlink[t] = -1;
            continue;
        }
        cumscore[t] = local[t] + best_value;
        if !started && local[t] < threshold {
            // 开头的静音段不参与成链
            backlink[t] = -1;
        } else {
            backlink[t] = best_prev;
            started = true;
        }
    }

    // 从"尾部得分最高的帧"起回溯：取 cumscore 的局部极大值里超过阈值的最后一个。
    // 直接用 argmax 会被结尾的渐弱段拖偏。
    let tail = if n < 3 {
        argmax(&cumscore)
    } else {
        let peaks: Vec<usize> = (1..n - 1)
            .filter(|t| cumscore[*t] > cumscore[t - 1] && cumscore[*t] >= cumscore[t + 1])
            .collect();
        if peaks.is_empty() {
            argmax(&cumscore)
        } else {
            let rms = (peaks.iter().map(|p| cumscore[*p].powi(2)).sum::<f64>()
                / peaks.len() as f64)
                .sqrt();
            let limit = 0.5 * rms;
            peaks
                .iter()
                .rev()
                .find(|p| cumscore[**p] >= limit)
                .copied()
                .unwrap_or(*peaks.last().unwrap())
        }
    };

    let mut beats = vec![tail];
    let mut guard = 0;
    while backlink[*beats.last().unwrap()] >= 0 && guard < n {
        beats.push(backlink[*beats.last().unwrap()] as usize);
        guard += 1;
    }
    beats.sort_unstable();
    beats.dedup();
    trim_beats(&local, &beats)
}

fn argmax(values: &[f64]) -> usize {
    values
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(i, _)| i)
        .unwrap_or(0)
}

/// 砍掉首尾能量过弱的拍（intro 淡入 / outro 淡出会被 DP 一路补齐，是假拍）。
fn trim_beats(local: &[f64], frames: &[usize]) -> Vec<usize> {
    if frames.len() < 3 {
        return frames.to_vec();
    }
    let picked: Vec<f64> = frames.iter().map(|f| local[*f]).collect();
    let window = hann_window(5);
    let offset = window.len() / 2;
    let strength: Vec<f64> = (0..picked.len())
        .map(|i| {
            let mut acc = 0.0;
            for (k, w) in window.iter().enumerate() {
                let idx = i as isize + offset as isize - k as isize;
                if idx >= 0 && (idx as usize) < picked.len() {
                    acc += picked[idx as usize] * w;
                }
            }
            acc
        })
        .collect();
    let rms = (strength.iter().map(|s| s * s).sum::<f64>() / strength.len() as f64).sqrt();
    let limit = 0.5 * rms;
    let keep: Vec<usize> = strength
        .iter()
        .enumerate()
        .filter(|(_, s)| **s > limit)
        .map(|(i, _)| i)
        .collect();
    if keep.len() < 2 {
        return frames.to_vec();
    }
    frames[keep[0]..=keep[keep.len() - 1]].to_vec()
}

// ---------------------------------------------------------------- 精修

/// 由拍点回算周期（帧）与一致性置信度。
///
/// 契约写的是"相邻间隔中位数"，但拍点只有整数帧分辨率：174 BPM 时一拍才 14.85 帧，
/// 中位数取整误差直接是 1%（≈1.2 BPM）。所以先用中位数挑内点，
/// 再在最长内点连续段上做最小二乘拟合斜率——跨几十拍平均，量化误差被摊到 0.1 BPM 以内。
fn refine_period(frames: &[usize], fallback: f64) -> (f64, f64) {
    if frames.len() < 3 {
        return (fallback, 0.0);
    }
    let intervals: Vec<f64> = frames
        .windows(2)
        .map(|pair| (pair[1] - pair[0]) as f64)
        .collect();
    let mut sorted = intervals.clone();
    let med = median(&mut sorted);
    if med <= 0.0 {
        return (fallback, 0.0);
    }
    let q25 = percentile(&sorted, 25.0);
    let q75 = percentile(&sorted, 75.0);
    let confidence = (1.0 - (q75 - q25) / med).clamp(0.0, 1.0);

    let tolerance = (0.25 * med).max(1.0);
    let inlier: Vec<bool> = intervals
        .iter()
        .map(|value| (value - med).abs() <= tolerance)
        .collect();

    // 最长连续内点段
    let (mut best_start, mut best_len, mut cur_start, mut cur_len) =
        (0usize, 0usize, 0usize, 0usize);
    for (i, ok) in inlier.iter().enumerate() {
        if *ok {
            if cur_len == 0 {
                cur_start = i;
            }
            cur_len += 1;
            if cur_len > best_len {
                best_start = cur_start;
                best_len = cur_len;
            }
        } else {
            cur_len = 0;
        }
    }
    if best_len < 3 {
        return (med, confidence);
    }

    let segment: Vec<f64> = frames[best_start..=best_start + best_len]
        .iter()
        .map(|f| *f as f64)
        .collect();
    let slope = least_squares_slope(&segment);
    if !slope.is_finite() || slope <= 0.0 || (slope - med).abs() > tolerance {
        return (med, confidence);
    }
    (slope, confidence)
}

/// `np.polyfit(arange(n), y, 1)[0]`
fn least_squares_slope(y: &[f64]) -> f64 {
    let n = y.len() as f64;
    let mean_x = (n - 1.0) / 2.0;
    let mean_y = y.iter().sum::<f64>() / n;
    let mut num = 0.0;
    let mut den = 0.0;
    for (i, value) in y.iter().enumerate() {
        let dx = i as f64 - mean_x;
        num += dx * (value - mean_y);
        den += dx * dx;
    }
    if den == 0.0 {
        f64::NAN
    } else {
        num / den
    }
}

// ---------------------------------------------------------------- 对外入口

fn round_to(value: f64, digits: i32) -> f64 {
    let factor = 10f64.powi(digits);
    (value * factor).round() / factor
}

/// 完整速度分析。`samples` 是单声道 f32。
pub fn analyze_tempo(samples: &[f32], sr: f64) -> TempoResult {
    let (env, fps) = onset_envelope(samples, sr);
    if env.len() < 16 || env.iter().cloned().fold(0.0f64, f64::max) <= 0.0 {
        return TempoResult::default();
    }
    let (bpm_guess, bpm_raw) = choose_tempo(&env, fps);
    if bpm_guess <= 0.0 {
        return TempoResult::default();
    }

    let period = 60.0 * fps / bpm_guess;
    let frames = beat_track_dp(&env, period);
    let beat_times: Vec<f64> = frames.iter().map(|f| *f as f64 / fps).collect();
    if frames.len() < 3 {
        let interval = 60.0 / bpm_guess;
        return TempoResult {
            bpm: round_to(bpm_guess, 2),
            bpm_raw: round_to(bpm_raw, 2),
            confidence: 0.0,
            first_beat: beat_times.first().copied().unwrap_or(0.0),
            beat_interval: interval,
            beat_times,
            beat_strengths: frames
                .iter()
                .map(|frame| env.get(*frame).copied().unwrap_or(0.0))
                .collect(),
        };
    }

    let (refined_period, confidence) = refine_period(&frames, period);
    let mut bpm = 60.0 * fps / refined_period;
    // DP 被局部乱拍带跑时（refined 与候选差一个八度以上）退回候选值
    if !(BPM_MIN * 0.8..=BPM_MAX * 1.2).contains(&bpm) || (bpm / bpm_guess).log2().abs() > 0.35 {
        bpm = bpm_guess;
    }

    let beat_interval = 60.0 / bpm;
    TempoResult {
        bpm: round_to(bpm, 2),
        bpm_raw: round_to(bpm_raw, 2),
        confidence: round_to(confidence, 3),
        first_beat: round_to(beat_times[0], 4),
        beat_interval: round_to(beat_interval, 6),
        beat_times: beat_times.iter().map(|t| round_to(*t, 4)).collect(),
        beat_strengths: frames
            .iter()
            .map(|frame| env.get(*frame).copied().unwrap_or(0.0))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一段带清晰鼓点的信号：每 `beat_period` 秒一个短促脉冲 + 一点底噪。
    fn click_track(bpm: f64, seconds: f64, sr: f64) -> Vec<f32> {
        let n = (seconds * sr) as usize;
        let period = 60.0 / bpm * sr;
        let mut out = vec![0.0f32; n];
        let mut click = 0.0f64;
        while (click as usize) < n {
            let start = click as usize;
            // 5 ms 的指数衰减脉冲，频谱够宽，mel 差分能抓到
            for i in 0..(0.005 * sr) as usize {
                if start + i >= n {
                    break;
                }
                let t = i as f64 / sr;
                let envelope = (-t * 600.0).exp();
                let tone = (2.0 * std::f64::consts::PI * 180.0 * t).sin();
                out[start + i] += (envelope * tone) as f32;
            }
            click += period;
        }
        out
    }

    #[test]
    fn recovers_the_tempo_of_a_synthetic_click_track() {
        let sr = 22050.0;
        for bpm in [90.0, 120.0, 128.0, 140.0, 160.0] {
            let samples = click_track(bpm, 30.0, sr);
            let got = analyze_tempo(&samples, sr);
            let error = (got.bpm - bpm).abs();
            assert!(
                error < 1.0,
                "{bpm} BPM 的节拍轨测出 {}（误差 {error:.2}）",
                got.bpm
            );
        }
    }

    #[test]
    fn beat_grid_is_monotonic_and_starts_near_zero() {
        let sr = 22050.0;
        let got = analyze_tempo(&click_track(128.0, 30.0, sr), sr);
        assert!(
            got.beat_times.len() > 40,
            "拍点太少：{}",
            got.beat_times.len()
        );
        assert!(
            got.beat_times.windows(2).all(|pair| pair[1] > pair[0]),
            "拍点必须严格递增"
        );
        assert_eq!(got.first_beat, got.beat_times[0]);
        assert!(
            got.first_beat < 1.0,
            "第一拍应当靠近开头：{}",
            got.first_beat
        );
        assert!((got.beat_interval - 60.0 / got.bpm).abs() < 1e-5);
    }

    #[test]
    fn comb_score_separates_the_true_period_from_its_double() {
        // 每 20 帧一个拍：真周期 20，倍周期 40
        let mut env = vec![0.0f64; 600];
        for i in (0..600).step_by(20) {
            env[i] = 1.0;
        }
        let true_score = comb_score(&env, 20.0);
        let double_score = comb_score(&env, 40.0);
        let half_score = comb_score(&env, 10.0);
        assert!(
            true_score > double_score,
            "真周期 {true_score} 应当高过倍周期 {double_score}"
        );
        assert!(
            true_score > half_score,
            "真周期 {true_score} 应当高过半周期 {half_score}"
        );
    }

    #[test]
    fn low_tempo_double_promotion_only_accepts_explicit_fast_pulses() {
        let empty = vec![0.0; 64];
        // 85–90：无条件允许明确的 2×。
        assert_eq!(
            promote_double_tempo(&empty, 43.0, 85.74, &[85.74, 171.30, 113.58]),
            Some(171.30)
        );
        // 4:3 不是 2×。
        assert_eq!(
            promote_double_tempo(&empty, 43.0, 92.5, &[92.5, 123.3, 73.9]),
            None
        );

        let fps = 43.0664;

        // 真半速 EDM：每拍一个起音（opb≈1），即使有 2× 候选也不升。
        let mut half_time = vec![0.0f64; 4000];
        let period = 60.0 * fps / 100.0;
        let mut pos = 0.0_f64;
        while (pos as usize) + 1 < half_time.len() {
            half_time[pos.round() as usize] = 1.0;
            pos += period;
        }
        assert!(
            (onsets_per_beat(&half_time, fps, 100.0) - 1.0).abs() < 0.15,
            "构造的 EDM 包络应约 1 起音/拍"
        );
        assert_eq!(
            promote_double_tempo(&half_time, fps, 99.8, &[99.8, 199.6]),
            None,
            "Summersong 类 100 BPM 不应翻到 200"
        );

        // 高速曲半速主峰：真 200 网格上每拍都有起音，在 100 上看就是 opb≈2。
        let mut dense = vec![0.0f64; 4000];
        let true_period = 60.0 * fps / 199.4;
        let mut pos = 0.0_f64;
        while (pos as usize) + 1 < dense.len() {
            dense[pos.round() as usize] = 1.0;
            pos += true_period;
        }
        assert!(
            onsets_per_beat(&dense, fps, 99.8) >= 1.4,
            "Full Glory 类应看到偏密的起音"
        );
        assert_eq!(
            promote_double_tempo(&dense, fps, 99.8, &[99.8, 199.4]),
            Some(199.4),
            "起音过密的 99 主峰应升到 199"
        );
    }

    #[test]
    fn four_three_beats_double_when_comb_agrees() {
        let fps = 43.0664;
        // 真 123 网格；raw 会像 92，2× 像 184。
        let mut env = vec![0.0f64; 4000];
        let period = 60.0 * fps / 123.1;
        let mut pos = 0.0_f64;
        while (pos as usize) + 1 < env.len() {
            env[pos.round() as usize] = 1.0;
            pos += period;
        }
        assert_eq!(
            promote_four_three(&env, fps, 92.4, &[92.4, 184.5, 123.1, 61.6]),
            Some(123.1),
            "Our Chant 类应选 4:3 而不是 2×"
        );
    }

    #[test]
    fn three_two_promotion_lifts_sing_alive_style_raw_peaks() {
        // raw < 100：不看梳状，只要 1.5× 峰在候选里就升（旧行为）。
        let empty = vec![0.0; 64];
        assert_eq!(
            promote_three_two(&empty, 43.0, 92.94, &[92.94, 141.10, 69.95]),
            Some(141.10)
        );
        // 4:3 不是 1.5×。
        assert_eq!(
            promote_three_two(&empty, 43.0, 92.5, &[92.5, 123.3, 73.9]),
            None
        );

        // Sing Alive 形状：主峰 129，次峰 195（=1.5×）。
        // 包络只在真周期（195）上放脉冲 → 梳状分站在 195，应提升。
        let fps = 43.0664;
        let raw = 129.1825;
        let fast = 195.4130;
        let true_period = 60.0 * fps / fast;
        let mut env = vec![0.0f64; 4000];
        let mut pos = 0.0_f64;
        while (pos as usize) + 1 < env.len() {
            env[pos.round() as usize] = 1.0;
            pos += true_period;
        }
        assert_eq!(
            promote_three_two(&env, fps, raw, &[raw, fast, 97.73]),
            Some(fast),
            "129 主峰应被提升到 195"
        );

        // 包络只在 120 周期上有脉冲时，即使候选里有 180 也不提升。
        let mut raw_favored = vec![0.0f64; 4000];
        let raw_period = 60.0 * fps / 120.0;
        let mut pos = 0.0_f64;
        while (pos as usize) + 1 < raw_favored.len() {
            raw_favored[pos.round() as usize] = 1.0;
            pos += raw_period;
        }
        assert_eq!(
            promote_three_two(&raw_favored, fps, 120.0, &[120.0, 180.0]),
            None,
            "真 120 不应被 180 候选拉走"
        );
    }

    #[test]
    fn silence_yields_no_tempo_rather_than_a_random_one() {
        let got = analyze_tempo(&vec![0.0f32; 22050 * 5], 22050.0);
        assert_eq!(got.bpm, 0.0);
        assert!(got.beat_times.is_empty());
    }

    #[test]
    fn refine_period_beats_the_median_on_quantized_frames() {
        // 真周期 14.85 帧（≈174 BPM @ 43 fps），拍点只有整数分辨率
        let true_period = 14.85f64;
        let frames: Vec<usize> = (0..60)
            .map(|i| (i as f64 * true_period).round() as usize)
            .collect();
        let (refined, confidence) = refine_period(&frames, 15.0);
        assert!(
            (refined - true_period).abs() < 0.05,
            "拟合出 {refined}，真值 {true_period}"
        );
        assert!(confidence > 0.5, "间隔很规整，置信度应当高：{confidence}");
    }

    #[test]
    fn least_squares_slope_matches_polyfit() {
        let y: Vec<f64> = (0..10).map(|i| 3.0 + 2.5 * i as f64).collect();
        assert!((least_squares_slope(&y) - 2.5).abs() < 1e-12);
    }
}
