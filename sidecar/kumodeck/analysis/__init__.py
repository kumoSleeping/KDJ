"""音频分析子包：ffmpeg 解码 + 纯 numpy DSP（BPM / 调性 / 响度）。

对外只保证 `analyze_file` 和 `AnalysisResult` 稳定，其余子模块可自由重构。
"""

from __future__ import annotations

from .decode import DecodeError, FfmpegMissing, decode_audio, ffmpeg_available, probe_duration
from .engine import AnalysisResult, analyze_file, analyze_samples
from .key import KeyResult, analyze_key
from .loudness import LoudnessResult, analyze_loudness
from .tempo import TempoResult, analyze_tempo

__all__ = [
    "AnalysisResult",
    "DecodeError",
    "FfmpegMissing",
    "KeyResult",
    "LoudnessResult",
    "TempoResult",
    "analyze_file",
    "analyze_key",
    "analyze_loudness",
    "analyze_samples",
    "analyze_tempo",
    "decode_audio",
    "ffmpeg_available",
    "probe_duration",
]
