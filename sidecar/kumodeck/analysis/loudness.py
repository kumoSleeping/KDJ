"""响度：RMS / 峰值 / 波峰因数 / 1–10 能量分级。"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# 数字静音的下限，避免 log10(0) 得 -inf
FLOOR = 1e-10
# 能量分级的两端锚点：-30 dBFS → 1，-6 dBFS → 10
ENERGY_MIN_DB = -30.0
ENERGY_MAX_DB = -6.0


@dataclass
class LoudnessResult:
    rms_db: float
    peak_db: float
    crest_db: float
    energy: int


def energy_from_rms_db(rms_db: float) -> int:
    """RMS dBFS → 1..10 线性分档并夹取。"""
    span = ENERGY_MAX_DB - ENERGY_MIN_DB
    ratio = (float(rms_db) - ENERGY_MIN_DB) / span
    value = int(round(1.0 + ratio * 9.0))
    return int(np.clip(value, 1, 10))


def analyze_loudness(samples: np.ndarray, sr: int) -> LoudnessResult:
    """samples 是单声道 float32（sr 目前只作签名统一，RMS 与采样率无关）。"""
    y = np.asarray(samples, dtype=np.float64).ravel()
    if y.size == 0:
        floor_db = 20.0 * np.log10(FLOOR)
        return LoudnessResult(rms_db=floor_db, peak_db=floor_db, crest_db=0.0, energy=1)

    rms = float(np.sqrt(np.mean(np.square(y))))
    peak = float(np.max(np.abs(y)))
    rms_db = 20.0 * np.log10(max(rms, FLOOR))
    peak_db = 20.0 * np.log10(max(peak, FLOOR))
    return LoudnessResult(
        rms_db=round(rms_db, 2),
        peak_db=round(peak_db, 2),
        crest_db=round(peak_db - rms_db, 2),
        energy=energy_from_rms_db(rms_db),
    )
