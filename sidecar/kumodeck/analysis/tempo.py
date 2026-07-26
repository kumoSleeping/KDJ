"""BPM 估计 + 节拍网格（纯 numpy 实现）。

流程：STFT → mel 起音强度包络 → 自相关粗估速度 → 梳状滤波做倍频修正 →
Ellis 动态规划跟踪拍点 → 由拍点回算精修 BPM。

本文件同时收着几个通用 DSP 原语（分帧 / STFT / mel 滤波器组），`key.py` 直接复用，
不再单开文件，免得和契约里列的 analysis/ 文件清单对不上。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# ---------------------------------------------------------------- 参数

N_FFT = 2048
HOP = 512
N_MELS = 64
MEL_FMIN = 30.0
MEL_FMAX = 11000.0

BPM_MIN = 60.0
BPM_MAX = 200.0
# DJ 常用区间。落在区间外的速度对 DJ 基本不可用（73 BPM 没法拿来对拍），
# 而倍频错进区间内是无害的——节拍网格照样对齐，只是数字翻倍。
# 所以这里不是"加点权重"，而是硬性优先，见 _prefer_dj_range。
DJ_BPM_LOW = 85.0
DJ_BPM_HIGH = 175.0
# 区间外的候选要好到什么程度才值得放弃区间内的选项。
# 0.55 = 区间内候选只要保住区间外最优的 55% 梳状分就赢。
# 这个数字是拿真实曲库调出来的：再高会把 174 BPM 的 DnB 压成 87，再低则救不回半速误判。
DJ_RANGE_RESCUE = 0.55
TIGHTNESS = 100.0
# 倍频修正的候选倍率（含 3 连音关系，用来救 1.5 倍误判）
OCTAVE_FACTORS = (1.0 / 3.0, 0.5, 1.0 / 1.5, 1.0, 1.5, 2.0, 3.0)
# 试过给非二倍关系（×1.5 / ×⅔）打 0.8 折，想修 130→86.7 这类误判。
# 实测无效：误判没修好，与 librosa 的一致率反而从 31% 掉到 29%。
# 结论是问题不在倍率集合，而在梳状分本身对真实音乐区分度太低（见 docs/02）。
# 不留没有证据支持的旋钮。
# 两个候选相对差在这个比例内就当同一个速度合并。
# 152.3 / 152.5 / 154.0 本来是同一个速度的不同推导路径，
# 按绝对值分桶会把它们的"票"拆成三份，反而输给一个孤立的错误候选。
CANDIDATE_MERGE_RATIO = 0.02


@dataclass
class TempoResult:
    bpm: float
    bpm_raw: float
    confidence: float
    beat_times: list[float] = field(default_factory=list)
    first_beat: float = 0.0
    beat_interval: float = 0.0


# ---------------------------------------------------------------- 通用 DSP


def hann_window(n: int) -> np.ndarray:
    """周期型 Hann 窗（sym=False），STFT 用周期窗才能保证重叠相加一致。"""
    if n <= 1:
        return np.ones(max(n, 1), dtype=np.float64)
    return 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n) / n)


def frame_signal(y: np.ndarray, frame_length: int, hop: int) -> np.ndarray:
    """滑窗分帧，返回 (n_frames, frame_length)。用 stride 视图，不复制数据。"""
    y = np.asarray(y)
    if y.size < frame_length:
        y = np.pad(y, (0, frame_length - y.size))
    n_frames = 1 + (y.size - frame_length) // hop
    view = np.lib.stride_tricks.sliding_window_view(y, frame_length)
    return view[:: hop][:n_frames]


def stft_magnitude(
    y: np.ndarray, n_fft: int = N_FFT, hop: int = HOP, center: bool = True
) -> np.ndarray:
    """幅度谱，返回 (1 + n_fft//2, n_frames) 的 float32。

    center=True 时两端反射补零，使第 i 帧的时间中心正好是 i*hop / sr —— 拍点时间戳
    直接用 frame*hop/sr 就对齐了，不用再补半窗偏移。
    分块做 rfft：numpy 的 FFT 会把 float32 提升成 complex128，整段一次算 4 分钟的
    曲子要几百 MB，分块后峰值内存压到几十 MB。
    """
    y = np.asarray(y, dtype=np.float32).ravel()
    if center:
        pad = n_fft // 2
        mode = "reflect" if y.size > pad else "constant"
        y = np.pad(y, pad, mode=mode)
    if y.size < n_fft:
        y = np.pad(y, (0, n_fft - y.size))

    n_frames = 1 + (y.size - n_fft) // hop
    frames = frame_signal(y, n_fft, hop)[:n_frames]
    win = hann_window(n_fft).astype(np.float32)

    out = np.empty((n_fft // 2 + 1, n_frames), dtype=np.float32)
    block = 1024
    for start in range(0, n_frames, block):
        stop = min(start + block, n_frames)
        spec = np.fft.rfft(frames[start:stop] * win, axis=-1)
        out[:, start:stop] = np.abs(spec).T.astype(np.float32)
    return out


def hz_to_mel(hz: np.ndarray | float) -> np.ndarray | float:
    """HTK 公式（不是 Slaney），起音检测只关心刻度单调压缩，HTK 更简单。"""
    return 2595.0 * np.log10(1.0 + np.asarray(hz, dtype=np.float64) / 700.0)


def mel_to_hz(mel: np.ndarray | float) -> np.ndarray | float:
    return 700.0 * (10.0 ** (np.asarray(mel, dtype=np.float64) / 2595.0) - 1.0)


def mel_filterbank(
    sr: int,
    n_fft: int = N_FFT,
    n_mels: int = N_MELS,
    fmin: float = MEL_FMIN,
    fmax: float | None = None,
) -> np.ndarray:
    """三角滤波器组，返回 (n_mels, 1 + n_fft//2)。峰值归一（不做 Slaney 面积归一）。"""
    if fmax is None or fmax > sr / 2:
        fmax = sr / 2
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    edges = mel_to_hz(np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2))

    fb = np.zeros((n_mels, freqs.size), dtype=np.float32)
    for i in range(n_mels):
        left, center, right = edges[i], edges[i + 1], edges[i + 2]
        if right <= left:
            continue
        rising = (freqs - left) / max(center - left, 1e-9)
        falling = (right - freqs) / max(right - center, 1e-9)
        tri = np.minimum(rising, falling)
        fb[i] = np.maximum(tri, 0.0).astype(np.float32)
    return fb


def moving_average(x: np.ndarray, win: int) -> np.ndarray:
    """滑动均值（边缘用 edge 复制补齐），前缀和实现，O(n)。"""
    x = np.asarray(x, dtype=np.float64)
    win = max(1, int(win))
    if win <= 1 or x.size == 0:
        return x.copy()
    pad_left = win // 2
    pad_right = win - 1 - pad_left
    xp = np.pad(x, (pad_left, pad_right), mode="edge")
    cs = np.concatenate(([0.0], np.cumsum(xp)))
    return (cs[win:] - cs[:-win]) / win


def autocorrelate(x: np.ndarray, max_lag: int) -> np.ndarray:
    """循环自相关（补零到 2N 以上避免 wrap），返回 lag=0..max_lag 的无偏估计。"""
    x = np.asarray(x, dtype=np.float64)
    n = x.size
    if n == 0:
        return np.zeros(max_lag + 1)
    centered = x - x.mean()
    nfft = 1 << int(np.ceil(np.log2(max(2 * n, 2))))
    spec = np.fft.rfft(centered, nfft)
    ac = np.fft.irfft(spec * np.conj(spec), nfft)[: max_lag + 1]
    # 无偏：lag 越大重叠样本越少，不除会让长 lag 系统性偏小
    counts = np.maximum(n - np.arange(ac.size), 1)
    return ac / counts


# ---------------------------------------------------------------- 起音包络


def onset_envelope(
    samples: np.ndarray,
    sr: int,
    n_fft: int = N_FFT,
    hop: int = HOP,
    n_mels: int = N_MELS,
) -> tuple[np.ndarray, float]:
    """起音强度包络 + 帧率 fps。

    mel 谱一阶差分 → 半波整流 → 频带求和 → 减 0.5 s 滑动均值 → 再整流 → 归一化。
    减滑动均值是为了压掉长音符的持续能量，只留下"变化"，对 pad/人声铺底的曲子很关键。
    """
    y = np.asarray(samples, dtype=np.float32).ravel()
    if y.size == 0:
        return np.zeros(0), sr / hop
    peak = float(np.max(np.abs(y)))
    if peak > 0:
        y = y / peak  # 归一化，让 log1p(10*S) 的压缩量和音量无关

    spec = stft_magnitude(y, n_fft=n_fft, hop=hop)
    fb = mel_filterbank(sr, n_fft=n_fft, n_mels=n_mels, fmin=MEL_FMIN, fmax=min(MEL_FMAX, sr / 2))
    mel = fb @ spec
    logmel = np.log1p(10.0 * mel.astype(np.float64))

    diff = np.diff(logmel, axis=1, prepend=logmel[:, :1])
    env = np.maximum(diff, 0.0).sum(axis=0)

    fps = sr / hop
    win = int(round(0.5 * fps))
    win = max(3, win | 1)
    env = np.maximum(env - moving_average(env, win), 0.0)

    top = float(env.max()) if env.size else 0.0
    if top > 0:
        env = env / top
    return env, fps


# ---------------------------------------------------------------- 速度估计


def _tempo_prior(bpm: np.ndarray | float) -> np.ndarray | float:
    """对数正态先验，中心 120 BPM，σ=0.9 个八度。抑制自相关天然偏爱的长 lag。"""
    return np.exp(-0.5 * (np.log2(np.asarray(bpm, dtype=np.float64) / 120.0) / 0.9) ** 2)


def _parabolic_peak(values: np.ndarray, idx: int) -> float:
    """抛物线插值求亚采样峰位，自相关 lag 只有整数分辨率，不插值 BPM 误差可达 2%。"""
    if idx <= 0 or idx >= values.size - 1:
        return float(idx)
    a, b, c = values[idx - 1], values[idx], values[idx + 1]
    denom = a - 2.0 * b + c
    if abs(denom) < 1e-12:
        return float(idx)
    shift = 0.5 * (a - c) / denom
    if not np.isfinite(shift) or abs(shift) > 1.0:
        return float(idx)
    return float(idx) + float(shift)


def comb_score(env: np.ndarray, period: float) -> float:
    """梳状滤波打分：按 period 折叠包络，取最优相位下的"拍上能量 − 拍间能量"。

    只看拍上能量是分不出 T 和 2T 的（2T 的每一次命中都落在真拍上，均值一样高）。
    减掉偏移半个周期的"拍间能量"就能分开：
      - period = 真周期 → 拍间是弱拍，差值大；
      - period = 2×真周期 → 拍间正好是另一半真拍，差值≈0；
      - period = 0.5×真周期 → 拍上一半命中空档，均值本身就低。
    这正是舞曲 128 被判成 64/256 的解药。
    """
    env = np.asarray(env, dtype=np.float64)
    n = env.size
    if period < 2.0 or n < 8:
        return 0.0
    n_cycles = int((n - 1) // period)
    if n_cycles < 3:
        return 0.0

    grid = np.arange(n_cycles + 1, dtype=np.float64)
    n_phase = max(2, int(np.ceil(period)))
    phases = np.arange(n_phase, dtype=np.float64)
    xs = np.arange(n, dtype=np.float64)

    pos_on = phases[:, None] + period * grid[None, :]
    pos_off = pos_on + period / 2.0

    def _fold(pos: np.ndarray) -> np.ndarray:
        valid = pos <= (n - 1)
        vals = np.interp(np.clip(pos, 0.0, n - 1.0).ravel(), xs, env).reshape(pos.shape)
        vals = np.where(valid, vals, 0.0)
        counts = np.maximum(valid.sum(axis=1), 1)
        return vals.sum(axis=1) / counts

    on = _fold(pos_on)
    off = _fold(pos_off)
    best = int(np.argmax(on))
    contrast = max(float(on[best] - off[best]), 0.0)
    # 加一点绝对能量：全曲毫无拍间对比时（纯 pad/氛围）至少还能按能量排出个先后
    return contrast + 0.05 * float(on[best])


def tempo_candidates(env: np.ndarray, fps: float, top: int = 3) -> list[float]:
    """自相关粗估：在 [BPM_MIN, BPM_MAX] 对应的 lag 区间取前 top 个峰。"""
    if env.size < 16:
        return []
    min_lag = max(2, int(np.floor(60.0 * fps / BPM_MAX)))
    max_lag = int(np.ceil(60.0 * fps / BPM_MIN))
    max_lag = min(max_lag, env.size - 2)
    if max_lag <= min_lag + 1:
        return []

    ac = autocorrelate(env, max_lag)
    lags = np.arange(ac.size, dtype=np.float64)
    weighted = np.zeros_like(ac)
    band = slice(min_lag, max_lag + 1)
    bpms = 60.0 * fps / np.maximum(lags[band], 1e-9)
    weighted[band] = np.maximum(ac[band], 0.0) * _tempo_prior(bpms)

    inner = weighted[min_lag + 1 : max_lag]
    left = weighted[min_lag : max_lag - 1]
    right = weighted[min_lag + 2 : max_lag + 1]
    peak_idx = np.nonzero((inner > left) & (inner >= right) & (inner > 0))[0] + min_lag + 1
    if peak_idx.size == 0:
        peak_idx = np.array([int(np.argmax(weighted))])

    order = peak_idx[np.argsort(weighted[peak_idx])[::-1]][:top]
    out: list[float] = []
    for idx in order:
        lag = _parabolic_peak(weighted, int(idx))
        if lag <= 0:
            continue
        out.append(60.0 * fps / lag)
    return out


def _merge_candidates(scored: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """把彼此相差不到 CANDIDATE_MERGE_RATIO 的候选并成一条，保留最高分。

    同一个真实速度会经由不同 base × factor 推导出好几个几乎相同的值
    （152.3 / 152.5 / 154.0）。不合并的话它们互相分票，一个孤立的错误候选
    反而能靠"没人跟它抢"胜出。
    """
    merged: list[tuple[float, float]] = []
    for score, bpm in sorted(scored, key=lambda item: -item[0]):
        for index, (kept_score, kept_bpm) in enumerate(merged):
            if abs(bpm - kept_bpm) / max(kept_bpm, 1e-9) <= CANDIDATE_MERGE_RATIO:
                # 已有更高分的同族代表；把这次的分数并进去（取大），bpm 用高分那个
                merged[index] = (max(kept_score, score), kept_bpm)
                break
        else:
            merged.append((score, bpm))
    return merged


def _prefer_dj_range(
    best: tuple[float, float], candidates: list[tuple[float, float]]
) -> tuple[float, float]:
    """最优解落在 DJ 区间外时，尝试换成同族的区间内倍频。

    只有当区间内候选保住了 DJ_RANGE_RESCUE 比例的分数才换——
    否则一首真正的 200 BPM 硬核会被无脑砍成 100。
    """
    best_score, best_bpm = best
    if DJ_BPM_LOW <= best_bpm <= DJ_BPM_HIGH or best_score <= 0:
        return best
    in_range = [
        (score, bpm)
        for score, bpm in candidates
        if DJ_BPM_LOW <= bpm <= DJ_BPM_HIGH and score >= best_score * DJ_RANGE_RESCUE
    ]
    if not in_range:
        return best
    # 同族优先（是 best 的整数/简单倍频关系），其次分数高的
    def rank(item: tuple[float, float]) -> tuple[int, float]:
        score, bpm = item
        ratio = bpm / best_bpm
        related = min(abs(ratio - f) for f in OCTAVE_FACTORS) < 0.03
        return (0 if related else 1, -score)

    return min(in_range, key=rank)


def choose_tempo(env: np.ndarray, fps: float) -> tuple[float, float]:
    """返回 (最终 bpm, 自相关粗估 bpm)。倍频修正在这里做。"""
    cands = tempo_candidates(env, fps)
    if not cands:
        return 0.0, 0.0
    bpm_raw = cands[0]

    scored: list[tuple[float, float]] = []
    for base in cands:
        for factor in OCTAVE_FACTORS:
            bpm = base * factor
            if bpm < BPM_MIN or bpm > BPM_MAX:
                continue
            period = 60.0 * fps / bpm
            score = comb_score(env, period) * float(_tempo_prior(bpm))
            scored.append((score, bpm))

    if not scored:
        return bpm_raw, bpm_raw
    merged = _merge_candidates(scored)
    best = max(merged, key=lambda item: item[0])
    return _prefer_dj_range(best, merged)[1], bpm_raw


# ---------------------------------------------------------------- 节拍跟踪（Ellis DP）


def _local_score(env: np.ndarray, period: float) -> np.ndarray:
    """DP 的局部得分：包络按 std 归一后用 σ=period/32 的高斯窗平滑（Ellis 原做法）。"""
    env = np.asarray(env, dtype=np.float64)
    std = float(env.std())
    norm = env / std if std > 0 else env.copy()
    half = max(1, int(round(period)))
    axis = np.arange(-half, half + 1, dtype=np.float64)
    window = np.exp(-0.5 * (axis * 32.0 / max(period, 1e-6)) ** 2)
    return np.convolve(norm, window, mode="same")


def beat_track_dp(env: np.ndarray, period: float, tightness: float = TIGHTNESS) -> np.ndarray:
    """Ellis 动态规划节拍跟踪，返回拍点所在帧号（升序）。

    D[t] = local[t] + max_τ (−tightness·(log(τ/period))² + D[t−τ])，
    τ 只在 [period/2, 2·period] 里找 —— 放开范围会让 DP 直接跳成半速/倍速。
    """
    env = np.asarray(env, dtype=np.float64)
    n = env.size
    if n == 0 or period < 2.0:
        return np.zeros(0, dtype=int)

    local = _local_score(env, period)
    lo = int(round(period / 2.0))
    hi = int(round(2.0 * period))
    if hi <= lo:
        hi = lo + 1
    taus = np.arange(lo, hi + 1, dtype=int)
    taus = taus[taus >= 1]
    if taus.size == 0:
        return np.zeros(0, dtype=int)
    penalty = -tightness * (np.log(taus / period) ** 2)

    cumscore = np.zeros(n, dtype=np.float64)
    backlink = np.full(n, -1, dtype=int)
    threshold = 0.01 * float(local.max()) if local.size else 0.0
    started = False

    for t in range(n):
        prev = t - taus
        ok = prev >= 0
        if not ok.any():
            cumscore[t] = local[t]
            backlink[t] = -1
            continue
        cand = penalty[ok] + cumscore[prev[ok]]
        best = int(np.argmax(cand))
        cumscore[t] = local[t] + cand[best]
        if not started and local[t] < threshold:
            backlink[t] = -1  # 开头的静音段不参与成链
        else:
            backlink[t] = int(prev[ok][best])
            started = True

    # 从"尾部得分最高的帧"起回溯：取 cumscore 的局部极大值里超过阈值的最后一个，
    # 直接用 argmax 会被结尾的渐弱段拖偏，用最后一个强局部极大更稳。
    if n < 3:
        tail = int(np.argmax(cumscore))
    else:
        is_max = np.zeros(n, dtype=bool)
        is_max[1:-1] = (cumscore[1:-1] > cumscore[:-2]) & (cumscore[1:-1] >= cumscore[2:])
        peaks = np.nonzero(is_max)[0]
        if peaks.size == 0:
            tail = int(np.argmax(cumscore))
        else:
            limit = 0.5 * float(np.sqrt(np.mean(cumscore[peaks] ** 2)))
            strong = peaks[cumscore[peaks] >= limit]
            tail = int(strong[-1]) if strong.size else int(peaks[-1])

    beats = [tail]
    guard = 0
    while backlink[beats[-1]] >= 0 and guard < n:
        beats.append(backlink[beats[-1]])
        guard += 1
    beats.reverse()
    frames = np.array(sorted(set(beats)), dtype=int)
    return _trim_beats(local, frames)


def _trim_beats(local: np.ndarray, frames: np.ndarray) -> np.ndarray:
    """砍掉首尾能量过弱的拍（intro 淡入 / outro 淡出会被 DP 一路补齐，是假拍）。"""
    if frames.size < 3:
        return frames
    strength = np.convolve(local[frames], hann_window(5), mode="same")
    limit = 0.5 * float(np.sqrt(np.mean(strength**2)))
    keep = np.nonzero(strength > limit)[0]
    if keep.size < 2:
        return frames
    return frames[keep[0] : keep[-1] + 1]


# ---------------------------------------------------------------- 精修


def _refine_period(frames: np.ndarray, fallback: float) -> tuple[float, float]:
    """由拍点回算周期（帧）与一致性置信度。

    契约写的是"相邻间隔中位数"，但拍点只有整数帧分辨率：174 BPM 时一拍才 14.85 帧，
    中位数取整误差直接是 1%（≈1.2 BPM）。所以先用中位数挑内点，再在最长内点连续段上
    做最小二乘拟合斜率 —— 跨几十拍平均，量化误差被摊到 0.1 BPM 以内。
    """
    if frames.size < 3:
        return fallback, 0.0
    intervals = np.diff(frames.astype(np.float64))
    median = float(np.median(intervals))
    if median <= 0:
        return fallback, 0.0

    q75, q25 = np.percentile(intervals, [75, 25])
    confidence = float(np.clip(1.0 - (q75 - q25) / median, 0.0, 1.0))

    tolerance = max(0.25 * median, 1.0)
    inlier = np.abs(intervals - median) <= tolerance
    # 找最长的连续内点段
    best_start = best_len = cur_start = cur_len = 0
    for i, ok in enumerate(inlier):
        if ok:
            if cur_len == 0:
                cur_start = i
            cur_len += 1
            if cur_len > best_len:
                best_start, best_len = cur_start, cur_len
        else:
            cur_len = 0
    if best_len < 3:
        return median, confidence

    segment = frames[best_start : best_start + best_len + 1].astype(np.float64)
    index = np.arange(segment.size, dtype=np.float64)
    slope = float(np.polyfit(index, segment, 1)[0])
    if not np.isfinite(slope) or slope <= 0 or abs(slope - median) > tolerance:
        return median, confidence
    return slope, confidence


# ---------------------------------------------------------------- 对外入口


def analyze_tempo(samples: np.ndarray, sr: int) -> TempoResult:
    """完整速度分析。samples 是单声道 float32，sr 是采样率。"""
    env, fps = onset_envelope(samples, sr)
    if env.size < 16 or float(env.max()) <= 0.0:
        return TempoResult(bpm=0.0, bpm_raw=0.0, confidence=0.0)

    bpm_guess, bpm_raw = choose_tempo(env, fps)
    if bpm_guess <= 0:
        return TempoResult(bpm=0.0, bpm_raw=0.0, confidence=0.0)

    period = 60.0 * fps / bpm_guess
    frames = beat_track_dp(env, period)
    if frames.size < 3:
        return TempoResult(
            bpm=round(bpm_guess, 2),
            bpm_raw=round(bpm_raw, 2),
            confidence=0.0,
            beat_times=[float(f) / fps for f in frames],
            first_beat=float(frames[0]) / fps if frames.size else 0.0,
            beat_interval=60.0 / bpm_guess,
        )

    refined_period, confidence = _refine_period(frames, period)
    bpm = 60.0 * fps / refined_period
    # DP 被局部乱拍带跑时（refined 与候选差一个八度以上）退回候选值
    if not (BPM_MIN * 0.8 <= bpm <= BPM_MAX * 1.2) or abs(np.log2(bpm / bpm_guess)) > 0.35:
        bpm = bpm_guess

    beat_times = [float(f) / fps for f in frames]
    return TempoResult(
        bpm=round(float(bpm), 2),
        bpm_raw=round(float(bpm_raw), 2),
        confidence=round(float(confidence), 3),
        beat_times=[round(t, 4) for t in beat_times],
        first_beat=round(beat_times[0], 4),
        beat_interval=round(60.0 / bpm, 6),
    )
