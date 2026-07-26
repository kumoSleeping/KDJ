"""调性识别：chroma → Krumhansl-Schmuckler → 24 调 → Camelot / OpenKey。"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .tempo import stft_magnitude

# 调性只关心频率分辨率，时间分辨率无所谓：
# 契约里 tempo 用的 2048（22050 Hz 下 bin 宽 10.8 Hz）在 180 Hz 以下已经宽过一个半音，
# 低音区会整片糊掉，所以这里把窗加到 4096（bin 宽 5.4 Hz），hop 相应放到 1024 省内存。
N_FFT = 4096
HOP = 1024
# C2 ~ C7，低于 C2 基本是底鼓/低频噪声，高于 C7 是镲片噪声，都会污染 chroma
FMIN = 65.4
FMAX = 2093.0
# 谐波抑制：沿时间的中值滤波长度（帧）
HARMONIC_MEDIAN = 17

# Krumhansl-Schmuckler 模板（契约 3.3 给定，索引 0 = 主音）
MAJOR_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
MINOR_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)

# 音级 → 显示名。大调用契约表里的写法（Db/Ab/Eb/Bb/F#），
# 小调同样照抄契约表（G#/Ab minor 取 Ab，C#/Db minor 取 Db）。
MAJOR_NAMES = ("C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
MINOR_NAMES = ("C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")

# Camelot 表：逐条照抄契约 3.3 的表格，key = (音级, 是否小调)
# 音级：C=0 Db=1 D=2 Eb=3 E=4 F=5 F#=6 G=7 Ab=8 A=9 Bb=10 B=11
CAMELOT: dict[tuple[int, bool], str] = {
    # ---- A 列：小调 ----
    (8, True): "1A",  # Ab minor / G# minor
    (3, True): "2A",  # Eb minor
    (10, True): "3A",  # Bb minor
    (5, True): "4A",  # F minor
    (0, True): "5A",  # C minor
    (7, True): "6A",  # G minor
    (2, True): "7A",  # D minor
    (9, True): "8A",  # A minor
    (4, True): "9A",  # E minor
    (11, True): "10A",  # B minor
    (6, True): "11A",  # F# minor
    (1, True): "12A",  # Db minor / C# minor
    # ---- B 列：大调 ----
    (11, False): "1B",  # B major
    (6, False): "2B",  # F# major
    (1, False): "3B",  # Db major
    (8, False): "4B",  # Ab major
    (3, False): "5B",  # Eb major
    (10, False): "6B",  # Bb major
    (5, False): "7B",  # F major
    (0, False): "8B",  # C major
    (7, False): "9B",  # G major
    (2, False): "10B",  # D major
    (9, False): "11B",  # A major
    (4, False): "12B",  # E major
}


@dataclass
class KeyResult:
    key: str
    key_short: str
    camelot: str
    open_key: str
    confidence: float
    chroma: list[float] = field(default_factory=list)


def camelot_to_open_key(camelot: str) -> str:
    """Camelot → OpenKey。

    推导：OpenKey 的 1d 定义为 C 大调、1m 为 A 小调，而 Camelot 里 C 大调是 8B、
    A 小调是 8A，两套轮盘只差一个固定旋转量 7。所以 open = camelot − 7，
    结果落到 1..12 循环里，即 ((n − 8) mod 12) + 1；字母 A→m（小调）、B→d（大调）。
    校验：1A(Ab minor) → ((1−8) mod 12)+1 = 6 → 6m ✓；6B(Bb major) → 11d ✓。
    """
    if not camelot or len(camelot) < 2:
        return ""
    letter = camelot[-1].upper()
    try:
        number = int(camelot[:-1])
    except ValueError:
        return ""
    if letter not in ("A", "B") or not 1 <= number <= 12:
        return ""
    open_number = ((number - 8) % 12) + 1
    return f"{open_number}{'m' if letter == 'A' else 'd'}"


def _median_filter_time(spec: np.ndarray, size: int = HARMONIC_MEDIAN) -> np.ndarray:
    """沿时间做中值滤波（谐波成分保留、瞬态打击成分被压掉）。

    分块滑窗：整段一次 sliding_window_view 会把内存放大 size 倍，4 分钟曲子直接上 GB。
    """
    if size <= 1 or spec.shape[1] < size:
        return spec
    pad = size // 2
    padded = np.pad(spec, ((0, 0), (pad, pad)), mode="edge")
    out = np.empty_like(spec)
    block = 512
    for start in range(0, spec.shape[1], block):
        stop = min(start + block, spec.shape[1])
        chunk = padded[:, start : stop + 2 * pad]
        windows = np.lib.stride_tricks.sliding_window_view(chunk, size, axis=1)
        out[:, start:stop] = np.median(windows, axis=-1)
    return out


def chroma_weights(sr: int, n_fft: int = N_FFT) -> tuple[np.ndarray, np.ndarray]:
    """(12, n_selected) 的映射矩阵 + 选中的 bin 掩码。

    每个 bin 按 midi = 69 + 12*log2(f/440) 折算到连续音高，用三角权重摊到相邻两个半音，
    比"四舍五入到最近半音"平滑，能吃掉一点音准偏差和频率量化误差。
    """
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    mask = (freqs >= FMIN) & (freqs <= FMAX)
    selected = freqs[mask]
    weights = np.zeros((12, selected.size), dtype=np.float32)
    if selected.size == 0:
        return weights, mask

    midi = 69.0 + 12.0 * np.log2(selected / 440.0)
    low = np.floor(midi).astype(int)
    frac = midi - low
    cols = np.arange(selected.size)
    weights[low % 12, cols] += (1.0 - frac).astype(np.float32)
    weights[(low + 1) % 12, cols] += frac.astype(np.float32)
    return weights, mask


def compute_chroma(samples: np.ndarray, sr: int) -> np.ndarray:
    """12 维 chroma（已归一到最大值 1）。"""
    y = np.asarray(samples, dtype=np.float32).ravel()
    if y.size < N_FFT:
        return np.zeros(12, dtype=np.float64)
    peak = float(np.max(np.abs(y)))
    if peak > 0:
        y = y / peak

    spec = stft_magnitude(y, n_fft=N_FFT, hop=HOP)
    weights, mask = chroma_weights(sr, N_FFT)
    spec = spec[mask]
    if spec.size == 0:
        return np.zeros(12, dtype=np.float64)

    spec = _median_filter_time(spec, HARMONIC_MEDIAN)
    frames = (weights @ spec).astype(np.float64)  # (12, n_frames)

    # 每帧 L2 归一，抵消音量起伏；再沿时间取中位数（比均值抗鼓点/瞬态干扰）
    norms = np.linalg.norm(frames, axis=0)
    norms[norms <= 0] = 1.0
    frames = frames / norms
    chroma = np.median(frames, axis=1)

    top = float(chroma.max())
    if top > 0:
        chroma = chroma / top
    return chroma


def _pearson(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom <= 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def key_from_chroma(chroma: np.ndarray) -> KeyResult:
    """对 24 个候选调（12 音级 × 大小调）求皮尔逊相关，取最大。"""
    chroma = np.asarray(chroma, dtype=np.float64)
    if chroma.size != 12 or float(np.max(np.abs(chroma))) <= 0:
        return KeyResult(key="", key_short="", camelot="", open_key="", confidence=0.0, chroma=[0.0] * 12)

    major = np.asarray(MAJOR_PROFILE, dtype=np.float64)
    minor = np.asarray(MINOR_PROFILE, dtype=np.float64)
    scores: list[tuple[float, int, bool]] = []
    for tonic in range(12):
        # np.roll(profile, tonic) 把模板的主音位置搬到 tonic 音级上
        scores.append((_pearson(chroma, np.roll(major, tonic)), tonic, False))
        scores.append((_pearson(chroma, np.roll(minor, tonic)), tonic, True))

    scores.sort(key=lambda item: item[0], reverse=True)
    best_score, tonic, is_minor = scores[0]
    second = scores[1][0]
    confidence = float(np.clip((best_score - second) / (abs(best_score) + 1e-9), 0.0, 1.0))

    name = (MINOR_NAMES if is_minor else MAJOR_NAMES)[tonic]
    key = f"{name} {'minor' if is_minor else 'major'}"
    key_short = f"{name}m" if is_minor else name
    camelot = CAMELOT[(tonic, is_minor)]
    return KeyResult(
        key=key,
        key_short=key_short,
        camelot=camelot,
        open_key=camelot_to_open_key(camelot),
        confidence=round(confidence, 3),
        chroma=[round(float(v), 4) for v in chroma],
    )


def analyze_key(samples: np.ndarray, sr: int) -> KeyResult:
    """完整调性分析。samples 是单声道 float32。"""
    return key_from_chroma(compute_chroma(samples, sr))
