"""SoundCloud provider（yt-dlp 封装）。

搬自 `kumocode_v2/entari_plugin_kumo_music_dl/service.py::SoundCloudClient`。
SoundCloud 没有扫码登录，账号态只反映"设置里有没有打开这个开关"；
`soundcloud_enabled` 关掉时 search/resolve 返回空、download 直接抛错。
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Any

import httpx

from ..models import Account, ResolveResponse, SongSource
from .base import (
    ProgressFn,
    ProviderContext,
    embed_metadata,
    host_is,
    json_safe,
    noop_progress,
    render_filename,
)

logger = logging.getLogger("kumodeck.providers.soundcloud")

OAUTH_TOKEN_ENV = "SOUNDCLOUD_OAUTH_TOKEN"
COOKIE_FILE_ENV = "SOUNDCLOUD_COOKIE_FILE"
DISABLED_MESSAGE = "未启用，在「下载」里打开开关"


class SoundCloudProvider:
    platform = "soundcloud"
    label = "SoundCloud"

    def __init__(self, ctx: ProviderContext) -> None:
        self.ctx = ctx

    # ------------------------------------------------------------ 账号

    def account(self) -> Account:
        if not self.ctx.soundcloud_enabled:
            return Account(
                platform="soundcloud",
                label=self.label,
                state="missing",
                detail=DISABLED_MESSAGE,
                supports_login=False,
            )
        detail = "已启用（yt-dlp）"
        if os.environ.get(OAUTH_TOKEN_ENV, "").strip():
            detail = "已启用（yt-dlp + OAuth token）"
        return Account(
            platform="soundcloud",
            label=self.label,
            state="valid",
            detail=detail,
            supports_login=False,
        )

    def create_qr(self) -> tuple[str, str, str]:
        raise RuntimeError("SoundCloud 不需要扫码登录")

    def poll_qr(self, session_id: str) -> tuple[str, str]:
        return "error", "SoundCloud 不需要扫码登录"

    def logout(self) -> None:
        """无登录态可清。"""

    # ------------------------------------------------------------ yt-dlp

    def _ydl_options(self, *, download: bool = False, flat: bool = False) -> dict[str, Any]:
        options: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": False,
            # 列表场景用扁平抽取：否则 20 条搜索结果要逐条打详情接口，慢到没法用
            "extract_flat": "in_playlist" if flat else False,
            "skip_download": not download,
        }
        token = os.environ.get(OAUTH_TOKEN_ENV, "").strip()
        if token:
            options.update({"username": "oauth", "password": token})
        cookie_file = os.environ.get(COOKIE_FILE_ENV, "").strip()
        if cookie_file:
            options["cookiefile"] = cookie_file
        return options

    @staticmethod
    def _load_ydl() -> Any:
        try:
            from yt_dlp import YoutubeDL
        except ImportError as exc:  # pragma: no cover - 取决于安装环境
            raise RuntimeError("缺少 yt-dlp 依赖，无法使用 SoundCloud。") from exc
        return YoutubeDL

    def _extract(self, target: str, *, flat: bool) -> dict[str, Any] | None:
        YoutubeDL = self._load_ydl()
        with YoutubeDL(self._ydl_options(flat=flat)) as ydl:
            info = ydl.extract_info(target, download=False)
        return info if isinstance(info, dict) else None

    # ------------------------------------------------------------ 搜索 / 解析

    def search(self, keyword: str, limit: int = 20) -> list[SongSource]:
        keyword = str(keyword or "").strip()
        if not self.ctx.soundcloud_enabled or not keyword:
            return []
        limit = max(1, int(limit or 20))
        info = self._extract(f"scsearch{limit}:{keyword}", flat=True)
        entries = [entry for entry in ((info or {}).get("entries") or []) if isinstance(entry, dict)]
        sources = [self._to_source(entry) for entry in entries[:limit] if self._entry_url(entry)]
        return sources

    def resolve(self, url: str, limit: int = 500) -> ResolveResponse | None:
        text = str(url or "").strip()
        if not self._is_soundcloud_link(text):
            return None
        if not self.ctx.soundcloud_enabled:
            raise RuntimeError(DISABLED_MESSAGE)
        limit = max(1, int(limit or 500))
        info = self._extract(text, flat=True)
        if not info:
            raise RuntimeError("没有读取到 SoundCloud 内容。")
        entries = [entry for entry in (info.get("entries") or []) if isinstance(entry, dict)]
        if entries:
            sources = [self._to_source(entry) for entry in entries[:limit] if self._entry_url(entry)]
            if not sources:
                raise RuntimeError("SoundCloud 结果里没有可用音轨。")
            title = str(info.get("title") or "SoundCloud 歌单")
            kind = "album" if "/albums/" in text.lower() else "playlist"
            return ResolveResponse(kind=kind, platform="soundcloud", title=title, sources=sources)
        source = self._to_source(info)
        if not source.payload.get("webpage_url"):
            # 短链场景 webpage_url 可能缺失，兜底用原始输入，否则没法下载
            source.payload["webpage_url"] = str(info.get("original_url") or text)
        return ResolveResponse(
            kind="song",
            platform="soundcloud",
            title=str(info.get("title") or source.title),
            sources=[source],
        )

    @staticmethod
    def _is_soundcloud_link(text: str) -> bool:
        # on.soundcloud.com 是 soundcloud.com 的子域，host_is 已覆盖
        return host_is(text, "soundcloud.com") or host_is(text, "snd.sc")

    # ------------------------------------------------------------ 下载

    def download(
        self,
        source: SongSource,
        quality: str = "",
        cancel: threading.Event | None = None,
        on_progress: ProgressFn = noop_progress,
    ) -> Path:
        if not self.ctx.soundcloud_enabled:
            raise RuntimeError(DISABLED_MESSAGE)
        cancel = cancel or threading.Event()
        on_progress = on_progress or noop_progress
        if cancel.is_set():
            raise RuntimeError("下载已取消")
        url = str((source.payload or {}).get("webpage_url") or "")
        if not url:
            raise RuntimeError("SoundCloud 音轨缺少下载链接。")

        YoutubeDL = self._load_ydl()
        from yt_dlp.utils import DownloadCancelled

        output_dir = self.ctx.platform_dir("soundcloud")
        base = render_filename(
            self.ctx.filename_template,
            source.title,
            source.artist_text,
            source.album,
            source.key,
            "audio",
            output_dir,
        )
        # 容器由 yt-dlp 决定（mp3/opus/m4a 都可能），模板留 %(ext)s
        output_template = str((output_dir / Path(base).stem).with_suffix(".%(ext)s"))

        def hook(status: dict[str, Any]) -> None:
            if cancel.is_set():
                raise DownloadCancelled("下载已取消")
            phase = status.get("status")
            if phase == "downloading":
                downloaded = int(status.get("downloaded_bytes") or 0)
                total = int(status.get("total_bytes") or status.get("total_bytes_estimate") or 0)
                on_progress(downloaded, total)
            elif phase == "finished":
                total = int(status.get("total_bytes") or status.get("downloaded_bytes") or 0)
                on_progress(total, total)

        options = self._ydl_options(download=True)
        options.update(
            {
                "format": "bestaudio/best",
                "outtmpl": output_template,
                "noplaylist": True,
                "overwrites": True,
                "progress_hooks": [hook],
            }
        )
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            requested = (info or {}).get("requested_downloads") or []
            if requested and requested[0].get("filepath"):
                path = Path(requested[0]["filepath"])
            else:
                path = Path(ydl.prepare_filename(info))
        if cancel.is_set():
            path.unlink(missing_ok=True)
            raise RuntimeError("下载已取消")
        if not path.exists():
            raise RuntimeError("SoundCloud 下载完成但没有找到文件。")

        cover_data = self._fetch_cover(str((source.payload or {}).get("thumbnail") or source.cover))
        try:
            embed_metadata(path, source.title, source.artists or ["Unknown"], source.album, cover_data)
        except Exception as exc:
            logger.warning("SoundCloud 写标签失败 song=%s: %s", source.key, exc)
        return path

    @staticmethod
    def _fetch_cover(thumbnail: str) -> bytes | None:
        if not thumbnail:
            return None
        try:
            resp = httpx.get(thumbnail, timeout=20, follow_redirects=True)
            resp.raise_for_status()
            return resp.content
        except Exception:
            return None

    # ------------------------------------------------------------ 归一化

    @staticmethod
    def _entry_url(entry: dict[str, Any]) -> str:
        return str(entry.get("webpage_url") or entry.get("original_url") or entry.get("url") or "")

    @classmethod
    def _to_source(cls, entry: dict[str, Any]) -> SongSource:
        webpage_url = cls._entry_url(entry)
        artists = [str(name) for name in (entry.get("artists") or []) if name]
        if not artists:
            artists = [str(entry.get("artist") or entry.get("uploader") or "Unknown")]
        thumbnail = str(entry.get("thumbnail") or "")
        if not thumbnail:
            thumbnails = [item for item in (entry.get("thumbnails") or []) if isinstance(item, dict)]
            if thumbnails:
                thumbnail = str(thumbnails[-1].get("url") or "")
        duration = entry.get("duration")
        payload = {
            "webpage_url": webpage_url,
            "thumbnail": thumbnail,
            "duration": duration,
            "license": entry.get("license"),
            "uploader": entry.get("uploader"),
        }
        return SongSource(
            platform="soundcloud",
            key=str(entry.get("id") or webpage_url),
            title=str(entry.get("title") or entry.get("track") or "Unknown"),
            artists=artists,
            album=str(entry.get("album") or ""),
            duration=float(duration) if isinstance(duration, (int, float)) and duration > 0 else None,
            cover=thumbnail,
            # SoundCloud 免费流最高就是 128kbps mp3 / opus
            max_quality="128",
            vip=False,
            payload=json_safe(payload),
        )
