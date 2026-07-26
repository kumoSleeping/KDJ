"""provider 层的公共设施：上下文、协议、文件名 / 标签 / 二维码 / 音质工具。

这些实现整体搬自 `kumocode_v2/entari_plugin_kumo_music_dl/service.py`——
那份代码已经在生产环境跑通、并且修过实际的安全问题（`host_is` 那条注释里
说的盲 SSRF）。桌面端只是把它从"聊天机器人服务"解耦成"provider"，
逻辑本身不要重写。
"""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import enum
import io
import logging
import math
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol, runtime_checkable
from urllib.parse import urlparse

import segno
from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover

from ..models import Account, ResolveResponse, SongSource

logger = logging.getLogger("kumodeck.providers")

__all__ = [
    "QUALITY_ORDER",
    "ProgressFn",
    "ProviderContext",
    "MusicProvider",
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

QUALITY_ORDER: tuple[str, ...] = ("flac", "320", "128")

#: 下载进度回调：(已下载字节, 总字节；总字节未知时为 0)
ProgressFn = Callable[[int, int], None]


def noop_progress(_downloaded: int, _total: int) -> None:
    """默认进度回调，什么都不做。"""


# ---------------------------------------------------------------- 上下文与协议


@dataclass
class ProviderContext:
    """provider 需要的全部外部配置，由 app 层从 `Settings` 组装后注入。

    provider 不读全局配置、不落自己的 settings 文件，方便测试和多实例。
    """

    data_dir: Path
    download_dir: Path
    filename_template: str = "{title} - {artist}"
    default_quality: str = "flac"
    netease_use_download_api: bool = False
    soundcloud_enabled: bool = False
    # 视频单独的落盘目录和容器格式。None = 跟随 download_dir。
    video_dir: Path | None = None
    video_format: str = "mp4"

    @property
    def session_dir(self) -> Path:
        """各平台登录态落盘目录（`data_dir/sessions`）。"""
        return self.data_dir / "sessions"

    def platform_dir(self, name: str) -> Path:
        """按平台分子目录存放下载文件，顺手建目录。"""
        target = self.download_dir / name
        target.mkdir(parents=True, exist_ok=True)
        return target

    def video_output_dir(self) -> Path:
        """视频落盘目录。和音频分开：视频动辄几百 MB，
        混进音乐目录会被曲库扫描一起扫走。"""
        target = self.video_dir or self.download_dir
        target.mkdir(parents=True, exist_ok=True)
        return target


@runtime_checkable
class MusicProvider(Protocol):
    """音乐平台 provider 协议。

    实现方全部是**同步**的：sidecar 的搜索/下载都跑在工作线程里，
    异步 SDK（QQ 音乐）由各 provider 内部用 `run_async` 包成同步。
    """

    platform: str
    label: str

    def account(self) -> Account:
        """当前登录态。不要抛异常，网络问题一律降级成 state="unknown"。"""
        ...

    def create_qr(self) -> tuple[str, str, str]:
        """新建扫码会话，返回 (session_id, data:image/png;base64,..., 登录链接)。"""
        ...

    def poll_qr(self, session_id: str) -> tuple[str, str]:
        """**非阻塞**地查一次扫码状态，返回 (QrStateValue, 提示文案)。"""
        ...

    def logout(self) -> None:
        """清空本地登录态。"""
        ...

    def search(self, keyword: str, limit: int) -> list[SongSource]:
        ...

    def resolve(self, url: str, limit: int) -> ResolveResponse | None:
        """解析歌曲/歌单链接；**不是本平台的链接返回 None**（让上层继续问别的 provider）。"""
        ...

    def download(
        self,
        source: SongSource,
        quality: str,
        cancel: threading.Event,
        on_progress: ProgressFn,
    ) -> Path:
        """下载单曲，返回最终文件路径；失败抛异常（不要返回 None）。"""
        ...


# ---------------------------------------------------------------- 异步桥接


def run_async(coro_factory: Callable[[], Awaitable[Any]]) -> Any:
    """在同步线程里跑一段 async 代码。

    不用 `asyncio.run`：它在"当前线程已有运行中的循环"时直接抛错。
    这里显式建循环、跑完关掉；万一调用方本来就在事件循环里（比如被
    FastAPI 的协程直接调用），就换一个线程跑，避免死锁。
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return _run_in_new_loop(coro_factory)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(_run_in_new_loop, coro_factory).result()


def _run_in_new_loop(coro_factory: Callable[[], Awaitable[Any]]) -> Any:
    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        return loop.run_until_complete(coro_factory())
    finally:
        try:
            pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception:  # 收尾失败不该盖住业务结果
            pass
        asyncio.set_event_loop(None)
        loop.close()


# ---------------------------------------------------------------- 通用小工具


def format_bytes(size: int | float | None) -> str:
    value = float(size or 0)
    if value < 1024:
        return f"{int(value)}B"
    if value < 1024 * 1024:
        return f"{value / 1024:.1f}KB"
    if value < 1024 * 1024 * 1024:
        return f"{value / (1024 * 1024):.2f}MB"
    return f"{value / (1024 * 1024 * 1024):.3f}GB"


def host_is(url: str, domain: str) -> bool:
    """判断 URL 的 host 是否就是 domain（或其子域）。

    子串判断（`"163cn.tv" in text`）会把 path/query 里的同名片段也算命中，
    任意 URL 只要带上 `?ref=163cn.tv` 就能骗我们去请求它——那是修过的盲 SSRF，
    所有"是不是本平台链接"的判断都必须走这里。
    """
    try:
        host = (urlparse(str(url or "").strip()).hostname or "").lower().rstrip(".")
    except ValueError:
        return False
    target = domain.lower()
    return host == target or host.endswith("." + target)


def json_safe(value: Any, _depth: int = 0) -> Any:
    """递归转成 JSON 可序列化的值。

    `SongSource.payload` 要经 HTTP 往返（前端拿到再回传给下载接口），
    枚举 / pydantic 模型 / NaN 这些东西必须先摊平，否则序列化直接炸。
    """
    if _depth > 12:
        return str(value)
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, enum.Enum):
        return json_safe(value.value, _depth + 1)
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, dict):
        return {str(key): json_safe(item, _depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [json_safe(item, _depth + 1) for item in value]
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        try:
            return json_safe(dump(), _depth + 1)
        except Exception:
            pass
    if hasattr(value, "_asdict"):
        try:
            return json_safe(value._asdict(), _depth + 1)
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        try:
            return json_safe(vars(value), _depth + 1)
        except Exception:
            pass
    return str(value)


# ---------------------------------------------------------------- 音质


def normalize_quality_start(quality: str | None) -> str:
    aliases = {
        "max": "flac",
        "lossless": "flac",
        "hires": "flac",
        "sq": "flac",
        "flac": "flac",
        "320": "320",
        "320k": "320",
        "exhigh": "320",
        "mp3_320": "320",
        "128": "128",
        "128k": "128",
        "standard": "128",
        "mp3_128": "128",
    }
    key = str(quality or "").strip().lower().replace("-", "_")
    if key in aliases:
        return aliases[key]
    if key:
        logger.warning("unknown quality start %r, fallback to flac", quality)
    return "flac"


def quality_gradient(quality: str | None) -> tuple[str, ...]:
    """音质降级梯度：从请求音质一路往下退，例如 flac → 320 → 128。"""
    start = normalize_quality_start(quality)
    return QUALITY_ORDER[QUALITY_ORDER.index(start) :]


# ---------------------------------------------------------------- 文件名


def sanitize_filename_value(value: Any, fallback: str = "Unknown") -> str:
    text = str(value or "").strip()
    text = re.sub(r'[\\/*?:"<>|\r\n\t]+', "", text)
    text = re.sub(r"\s+", " ", text).strip().strip(". ")
    return text or fallback


def finalize_filename(filename: str, output_dir: Path, fallback_ext: str = "mp3") -> str:
    """净化文件名并按**字节**截断。

    中文标题一个字 3 字节，按字符截断会超出文件系统 NAME_MAX；
    截断后可能切碎一个多字节字符，所以要一路退到能 decode 为止。
    """
    raw_name = Path(filename).name
    stem, ext = os.path.splitext(raw_name)
    safe_stem = sanitize_filename_value(stem, fallback="track")
    safe_ext = re.sub(r"[^A-Za-z0-9]+", "", ext.lstrip(".")) or fallback_ext
    ext_part = f".{safe_ext.lower()}" if safe_ext else ""
    name_max = 255
    try:
        name_max = os.pathconf(output_dir, "PC_NAME_MAX")
    except (AttributeError, OSError, ValueError):
        pass
    max_stem_bytes = max(1, name_max - len(ext_part.encode("utf-8")))
    encoded = safe_stem.encode("utf-8")
    if len(encoded) > max_stem_bytes:
        truncated = encoded[:max_stem_bytes]
        while truncated:
            try:
                safe_stem = truncated.decode("utf-8")
                break
            except UnicodeDecodeError:
                truncated = truncated[:-1]
    safe_stem = safe_stem.rstrip(". ") or "track"
    return f"{safe_stem}{ext_part}"


def render_filename(
    template: str,
    title: str,
    artists: str,
    album: str,
    key: str,
    ext: str,
    output_dir: Path,
) -> str:
    safe_title = sanitize_filename_value(title)
    safe_artists = sanitize_filename_value(artists)
    safe_album = sanitize_filename_value(album, "")
    safe_ext = re.sub(r"[^A-Za-z0-9]+", "", ext.lstrip(".")) or "mp3"
    try:
        filename = template.format(
            title=safe_title,
            artist=safe_artists,
            artists=safe_artists,
            album=safe_album,
            track=safe_title,
            id=key,
        )
    except Exception:
        # 用户模板里写了不认识的占位符时不能让整单下载失败
        filename = f"{safe_title} - {safe_artists}"
    return finalize_filename(f"{filename}.{safe_ext}", output_dir)


# ---------------------------------------------------------------- 标签


def embed_metadata(
    filepath: Path,
    title: str,
    artists: list[str],
    album: str,
    cover_data: bytes | None,
) -> None:
    """写入标题 / 艺人 / 专辑 / 封面。分析结果（BPM/KEY）由 tagging.py 负责。"""
    ext = filepath.suffix.lower()
    if ext == ".mp3":
        try:
            audio = MP3(filepath, ID3=ID3)
        except Exception:
            audio = MP3(filepath)
            audio.add_tags()
        if audio.tags is None:
            audio.add_tags()
        audio.tags.add(TIT2(encoding=3, text=title))
        audio.tags.add(TPE1(encoding=3, text=artists))
        audio.tags.add(TALB(encoding=3, text=album))
        if cover_data:
            audio.tags.add(
                APIC(encoding=3, mime=_cover_mime(cover_data), type=3, desc="Cover", data=cover_data)
            )
        audio.save()
    elif ext == ".flac":
        audio = FLAC(filepath)
        audio["title"] = title
        audio["artist"] = artists
        audio["album"] = album
        if cover_data:
            audio.add_picture(_flac_picture(cover_data))
        audio.save()
    elif ext in {".m4a", ".mp4"}:
        audio = MP4(filepath)
        audio["\xa9nam"] = [title]
        audio["\xa9ART"] = artists
        if album:
            audio["\xa9alb"] = [album]
        if cover_data:
            image_format = MP4Cover.FORMAT_PNG if cover_data.startswith(b"\x89PNG") else MP4Cover.FORMAT_JPEG
            audio["covr"] = [MP4Cover(cover_data, imageformat=image_format)]
        audio.save()
    elif ext in {".ogg", ".opus"}:
        # SoundCloud 走 yt-dlp，落地经常是 opus/ogg，原实现没覆盖到
        from mutagen.oggopus import OggOpus
        from mutagen.oggvorbis import OggVorbis

        audio = OggOpus(filepath) if ext == ".opus" else OggVorbis(filepath)
        audio["title"] = [title]
        audio["artist"] = list(artists)
        if album:
            audio["album"] = [album]
        if cover_data:
            picture = _flac_picture(cover_data)
            audio["metadata_block_picture"] = [base64.b64encode(picture.write()).decode("ascii")]
        audio.save()


def _cover_mime(cover_data: bytes) -> str:
    return "image/png" if cover_data.startswith(b"\x89PNG") else "image/jpeg"


def _flac_picture(cover_data: bytes) -> Picture:
    picture = Picture()
    picture.type = 3
    picture.mime = _cover_mime(cover_data)
    picture.desc = "Cover"
    picture.data = cover_data
    return picture


# ---------------------------------------------------------------- 二维码


def rewrite_qr_png(data: bytes, *, source_mime: str = "image/png", min_size: int = 420) -> tuple[bytes, str]:
    """把平台返回的小尺寸二维码放大成正常 RGB PNG。

    QQ 音乐 / 网易云给的原图只有一两百像素，直接塞进前端会糊到扫不出来；
    这里整数倍最近邻放大（保持码块边缘锐利），必要时再补白边。
    """
    try:
        from PIL import Image
    except Exception:
        return data, source_mime

    try:
        image = Image.open(io.BytesIO(data))
        image = image.convert("RGB")
        longest = max(image.size) or 1
        scale = max(1, (min_size + longest - 1) // longest)
        if scale > 1:
            image = image.resize((image.width * scale, image.height * scale), Image.Resampling.NEAREST)
        if image.width < min_size or image.height < min_size:
            canvas = Image.new("RGB", (max(min_size, image.width), max(min_size, image.height)), "white")
            canvas.paste(image, ((canvas.width - image.width) // 2, (canvas.height - image.height) // 2))
            image = canvas
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=False)
        return buffer.getvalue(), "image/png"
    except Exception:
        return data, source_mime


def qr_data_url(data: bytes, *, source_mime: str = "image/png") -> str:
    """PNG 字节 → `data:image/png;base64,...`（前端 <img src> 直接用）。"""
    payload, mime = rewrite_qr_png(data, source_mime=source_mime)
    return f"data:{mime};base64,{base64.b64encode(payload).decode('ascii')}"


def qr_data_url_from_text(text: str, *, scale: int = 10) -> str:
    """把一段文本（登录 URL）编码成二维码 data URL。"""
    buffer = io.BytesIO()
    segno.make_qr(text).save(buffer, kind="png", scale=scale)
    return qr_data_url(buffer.getvalue())
