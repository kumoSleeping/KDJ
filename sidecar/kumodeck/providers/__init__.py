"""各平台 provider 的统一出口。

`bilibili` 由视频侧单独实现，import 失败时不能拖垮整包
（音乐三家能用就该能用），所以放在 try/except 里。
"""

from __future__ import annotations

from .base import (
    QUALITY_ORDER,
    MusicProvider,
    ProgressFn,
    ProviderContext,
    embed_metadata,
    finalize_filename,
    format_bytes,
    host_is,
    json_safe,
    noop_progress,
    normalize_quality_start,
    qr_data_url,
    qr_data_url_from_text,
    quality_gradient,
    render_filename,
    rewrite_qr_png,
    run_async,
    sanitize_filename_value,
)
from .netease import NeteaseProvider
from .qqmusic import QQMusicProvider
from .soundcloud import SoundCloudProvider

__all__ = [
    "QUALITY_ORDER",
    "MusicProvider",
    "NeteaseProvider",
    "ProgressFn",
    "ProviderContext",
    "QQMusicProvider",
    "SoundCloudProvider",
    "embed_metadata",
    "finalize_filename",
    "format_bytes",
    "host_is",
    "json_safe",
    "noop_progress",
    "normalize_quality_start",
    "qr_data_url",
    "qr_data_url_from_text",
    "quality_gradient",
    "render_filename",
    "rewrite_qr_png",
    "run_async",
    "sanitize_filename_value",
]

try:
    from .bilibili import BilibiliProvider
except ImportError:  # pragma: no cover - 视频 provider 尚未就绪时照常工作
    BilibiliProvider = None  # type: ignore[assignment]
else:
    __all__.append("BilibiliProvider")
