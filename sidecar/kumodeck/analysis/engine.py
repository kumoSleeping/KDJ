"""分析总入口：解码一段音频 → BPM / 调性 / 响度 → 汇总成一条 AnalysisResult。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .decode import DEFAULT_SR, DecodeError, FfmpegMissing, decode_audio, probe_duration
from .key import analyze_key
from .loudness import analyze_loudness
from .tempo import analyze_tempo

# 短于这个长度的曲子不做 15% 偏移，直接整段分析（interlude/采样包常见）
SHORT_TRACK_SECONDS = 60.0
# 从 15% 处开始截取：跳过 intro 的静音铺垫和无节奏段，BPM 稳定得多
ANALYSIS_OFFSET_RATIO = 0.15


@dataclass
class AnalysisResult:
    duration: float
    bpm: float | None
    bpm_raw: float | None
    bpm_confidence: float | None
    first_beat: float | None
    beat_times: list[float]
    key: str
    key_short: str
    camelot: str
    open_key: str
    key_confidence: float | None
    chroma: list[float]
    rms_db: float | None
    peak_db: float | None
    crest_db: float | None
    energy: int | None
    errors: list[str] = field(default_factory=list)


def _empty_result(duration: float = 0.0) -> AnalysisResult:
    return AnalysisResult(
        duration=duration,
        bpm=None,
        bpm_raw=None,
        bpm_confidence=None,
        first_beat=None,
        beat_times=[],
        key="",
        key_short="",
        camelot="",
        open_key="",
        key_confidence=None,
        chroma=[],
        rms_db=None,
        peak_db=None,
        crest_db=None,
        energy=None,
        errors=[],
    )


def analysis_window(duration: float | None, duration_limit: float) -> tuple[float, float | None]:
    """算出 (起始偏移秒, 最长截取秒)。"""
    if not duration or duration <= 0:
        return 0.0, duration_limit
    if duration < SHORT_TRACK_SECONDS:
        return 0.0, None
    offset = duration * ANALYSIS_OFFSET_RATIO
    remain = max(duration - offset, 0.0)
    if remain <= 0:
        return 0.0, duration_limit
    return offset, min(duration_limit, remain)


def analyze_samples(samples: np.ndarray, sr: int, *, offset: float = 0.0) -> AnalysisResult:
    """对已解码的样本做全部分析。offset 是这段样本在原曲里的起始秒数。

    三个子分析各自 try/except：任何一个炸了都只记 errors，其余字段照常产出 ——
    曲库里宁可有一半信息，也不要因为某首怪文件整条记录变空。
    """
    result = _empty_result(duration=offset + (samples.size / sr if sr else 0.0))

    try:
        tempo = analyze_tempo(samples, sr)
        if tempo.bpm > 0:
            result.bpm = tempo.bpm
            result.bpm_raw = tempo.bpm_raw
            result.bpm_confidence = tempo.confidence
            # 拍点换算回全曲绝对时间
            result.beat_times = [round(offset + t, 4) for t in tempo.beat_times]
            if result.beat_times:
                interval = tempo.beat_interval or 60.0 / tempo.bpm
                first = result.beat_times[0]
                # first_beat 表达的是"网格相位"：按恒定速度把首拍外推回 [0, 一拍) 区间，
                # 这样即使分析窗从曲子中段开始，DJ 也能用它对齐整首的网格。
                if interval > 0:
                    first = first - interval * np.floor(first / interval)
                result.first_beat = round(float(first), 4)
    except Exception as exc:  # noqa: BLE001 - 子分析失败不能影响整体
        result.errors.append(f"tempo: {exc}")

    try:
        key = analyze_key(samples, sr)
        result.key = key.key
        result.key_short = key.key_short
        result.camelot = key.camelot
        result.open_key = key.open_key
        result.key_confidence = key.confidence
        result.chroma = key.chroma
    except Exception as exc:  # noqa: BLE001
        result.errors.append(f"key: {exc}")

    try:
        loud = analyze_loudness(samples, sr)
        result.rms_db = loud.rms_db
        result.peak_db = loud.peak_db
        result.crest_db = loud.crest_db
        result.energy = loud.energy
    except Exception as exc:  # noqa: BLE001
        result.errors.append(f"loudness: {exc}")

    return result


def analyze_file(path: Path | str, *, duration_limit: float = 240.0) -> AnalysisResult:
    """分析一个音频文件。

    ffmpeg 缺失是环境问题，直接抛 FfmpegMissing 让上层提示安装；
    其余解码错误退化成一条带 errors 的空结果，让扫描任务能继续跑下去。
    """
    target = Path(path)
    duration = probe_duration(target)
    offset, max_seconds = analysis_window(duration, duration_limit)

    try:
        samples, sr = decode_audio(
            target, sr=DEFAULT_SR, mono=True, max_seconds=max_seconds, offset=offset
        )
    except FfmpegMissing:
        raise
    except (DecodeError, OSError) as exc:
        result = _empty_result(duration=float(duration or 0.0))
        result.errors.append(f"decode: {exc}")
        return result

    if samples.size == 0:
        result = _empty_result(duration=float(duration or 0.0))
        result.errors.append("decode: 解出 0 个采样点")
        return result

    result = analyze_samples(samples, sr, offset=offset)
    if duration and duration > 0:
        result.duration = round(float(duration), 3)
    else:
        result.errors.append("duration: ffprobe 不可用，时长按解码长度估算")
        result.duration = round(float(result.duration), 3)
    return result
