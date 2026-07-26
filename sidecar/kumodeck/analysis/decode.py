"""ffmpeg → numpy float32 PCM。

分析层的唯一 I/O 入口：外部只依赖 ffmpeg 子进程，避免引入 soundfile/audioread 这类
需要编译的解码库（用户装不上就整个功能瘫痪）。
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np

DEFAULT_SR = 22050


class FfmpegMissing(RuntimeError):
    """系统里找不到 ffmpeg 可执行文件。"""


class DecodeError(RuntimeError):
    """ffmpeg 能跑但解不出音频（文件损坏 / 非音频 / 无音轨）。"""


def ffmpeg_path() -> str | None:
    return shutil.which("ffmpeg")


def ffprobe_path() -> str | None:
    return shutil.which("ffprobe")


def ffmpeg_available() -> bool:
    return ffmpeg_path() is not None


def probe_duration(path: Path | str) -> float | None:
    """用 ffprobe 读时长（秒）。拿不到返回 None，由调用方决定要不要整段解码兜底。"""
    exe = ffprobe_path()
    if exe is None:
        return None
    cmd = [
        exe,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    text = proc.stdout.decode("utf-8", "ignore").strip()
    try:
        value = float(text)
    except ValueError:
        return None
    if value <= 0 or not np.isfinite(value):
        return None
    return value


def decode_audio(
    path: Path | str,
    sr: int = DEFAULT_SR,
    mono: bool = True,
    max_seconds: float | None = None,
    offset: float = 0.0,
) -> tuple[np.ndarray, int]:
    """解码为 float32 PCM。

    mono=True 返回一维数组；mono=False 返回 (n, 2)。
    `-ss` 放在 `-i` **之前**：ffmpeg 会先按容器索引快进再解码，长曲目从 15% 处起截
    能省掉几秒的无谓解码；现代 ffmpeg 的 input seek 已经是精确 seek，不损失定位精度。
    """
    exe = ffmpeg_path()
    if exe is None:
        raise FfmpegMissing("未找到 ffmpeg，请先安装并加入 PATH")

    channels = 1 if mono else 2
    cmd = [exe, "-v", "error", "-nostdin"]
    if offset and offset > 0:
        cmd += ["-ss", f"{float(offset):.6f}"]
    cmd += ["-i", str(path)]
    if max_seconds is not None and max_seconds > 0:
        cmd += ["-t", f"{float(max_seconds):.6f}"]
    cmd += [
        "-vn",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-ac",
        str(channels),
        "-ar",
        str(int(sr)),
        "-",
    ]

    try:
        proc = subprocess.run(cmd, capture_output=True)
    except OSError as exc:  # PATH 里有但实际不可执行
        raise FfmpegMissing(f"ffmpeg 无法启动: {exc}") from exc

    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "ignore").strip().splitlines()
        message = detail[-1] if detail else f"ffmpeg 退出码 {proc.returncode}"
        raise DecodeError(f"解码失败: {message}")

    raw = proc.stdout
    if len(raw) < 4:
        raise DecodeError("解码结果为空（文件可能没有音轨）")

    # 末尾可能不足一个 float32，截掉避免 frombuffer 报错
    usable = len(raw) - (len(raw) % 4)
    samples = np.frombuffer(raw[:usable], dtype="<f4")
    if not mono:
        usable_frames = samples.size - (samples.size % channels)
        samples = samples[:usable_frames].reshape(-1, channels)

    samples = np.ascontiguousarray(samples, dtype=np.float32)
    # 极少数损坏文件会解出 nan/inf，后面的 FFT 会被整片污染，这里直接清零
    if not np.all(np.isfinite(samples)):
        samples = np.nan_to_num(samples, nan=0.0, posinf=0.0, neginf=0.0)
    return samples, int(sr)
