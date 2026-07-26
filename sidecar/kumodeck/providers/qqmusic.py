"""QQ 音乐 provider（qqmusic-api-python）。

搬自 `kumocode_v2/entari_plugin_kumo_music_dl/service.py::QQMusicClient`。
上游 SDK 全异步，这里用 `run_async` 包成同步；扫码从原来的 `while True` 死等
改成把 QR 存在 `self._qr_sessions` 里、每次 poll 只 check 一次。
"""

from __future__ import annotations

import html
import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import httpx
from qqmusic_api.core import Client as QQClient
from qqmusic_api.models.request import Credential
from qqmusic_api.modules.login import QRCodeLoginEvents, QRLoginType
from qqmusic_api.modules.search import SearchType
from qqmusic_api.modules.song import SongFileInfo, SongFileType

from ..models import Account, Quality, ResolveResponse, SongSource
from .base import (
    ProgressFn,
    ProviderContext,
    embed_metadata,
    host_is,
    json_safe,
    noop_progress,
    normalize_quality_start,
    qr_data_url,
    render_filename,
    run_async,
)

try:  # 0.7 起 query_song 改成收 SongQueryInfo，0.5 还是裸 id/mid 列表
    from qqmusic_api.modules.song import SongQueryInfo
except ImportError:  # pragma: no cover - 取决于装的 SDK 版本
    SongQueryInfo = None  # type: ignore[assignment]

logger = logging.getLogger("kumodeck.providers.qqmusic")

QR_SESSION_TTL = 15 * 60
CDN_FALLBACK = "https://dl.stream.qqmusic.qq.com/"
PROFILE_TTL = 300.0

#: 契约音质 → SDK 文件类型
FILE_TYPE_MAP: dict[str, Any] = {
    "flac": SongFileType.FLAC,
    "320": SongFileType.MP3_320,
    "128": SongFileType.MP3_128,
}

#: 老版本 session 文件用的驼峰键 → Credential 字段名
CREDENTIAL_KEY_MAP = {
    "loginType": "login_type",
    "encryptUin": "encrypt_uin",
    "musickeyCreateTime": "musickey_create_time",
    "keyExpiresIn": "key_expires_in",
    "bindAccountType": "bind_account_type",
    "needRefreshKeyIn": "need_refresh_key_in",
}


def _as_dict(value: Any) -> dict[str, Any]:
    """SDK 的 pydantic 模型 / NamedTuple / 普通对象统一摊成 dict。"""
    if isinstance(value, dict):
        return value
    dumped = json_safe(value)
    return dumped if isinstance(dumped, dict) else {}


class QQMusicProvider:
    platform = "qqm"
    label = "QQ 音乐"

    def __init__(self, ctx: ProviderContext) -> None:
        self.ctx = ctx
        self._lock = threading.RLock()
        self._credential: Credential | None = None
        self._credential_invalid = False
        self._session_mtime: float | None = None
        self._qr_sessions: dict[str, dict[str, Any]] = {}
        self._cdn_base: str | None = None
        self._cdn_base_expires_at = 0.0
        self._profile: tuple[str, str] | None = None
        self._profile_at = 0.0
        self._load_session(force=True)

    # ------------------------------------------------------------ 登录态

    @property
    def session_file(self) -> Path:
        return self.ctx.session_dir / "qqmusic.json"

    def _load_session(self, *, force: bool = False) -> None:
        path = self.session_file
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return
        if not force and mtime == self._session_mtime:
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("读取 QQ 音乐登录态失败：%s", exc)
            return
        if not isinstance(data, dict):
            return
        for old, new in CREDENTIAL_KEY_MAP.items():
            if old in data and new not in data:
                data[new] = data.pop(old)
        try:
            with self._lock:
                self._credential = Credential(**data)
                self._credential_invalid = False
                self._session_mtime = mtime
        except Exception as exc:
            logger.warning("解析 QQ 音乐凭证失败：%s", exc)

    def _store_credential(self, credential: Credential) -> None:
        payload = credential.model_dump() if hasattr(credential, "model_dump") else dict(credential.__dict__)
        path = self.session_file
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(json_safe(payload), ensure_ascii=False), encoding="utf-8")
        with self._lock:
            self._credential = credential
            self._credential_invalid = False
            self._profile = None
            self._profile_at = 0.0
            try:
                self._session_mtime = path.stat().st_mtime
            except OSError:
                self._session_mtime = None

    def _invalidate_expired_credential(self, exc: Exception) -> None:
        """接口明确回"凭证失效"时才作废本地登录态，网络错误不算。"""
        text = str(exc).lower()
        markers = (
            "登录凭证已过期",
            "登录凭证失效",
            "凭证失效",
            "登录过期",
            "credential expired",
            "credential has expired",
            "not logged in",
            "未登录",
        )
        if not any(marker in text for marker in markers):
            return
        if self._credential_invalid:
            return
        self._credential_invalid = True
        try:
            self.session_file.unlink(missing_ok=True)
        except OSError:
            pass
        self._session_mtime = None
        logger.warning("QQ 音乐凭证被接口拒绝，已作废：%s", exc)

    @staticmethod
    def _credential_expired(credential: Credential) -> bool:
        create_time = int(getattr(credential, "musickey_create_time", 0) or 0)
        ttl = int(getattr(credential, "key_expires_in", 0) or 0)
        if create_time > 0 and ttl > 0:
            return time.time() >= create_time + ttl
        expired_at = int(getattr(credential, "expired_at", 0) or 0)
        # expired_at 有时是时长有时是时间戳，只有看着像 epoch 才当过期时间用
        if expired_at > 1_000_000_000:
            return time.time() >= expired_at
        return False

    def _refresh_credential(self) -> bool:
        credential = self._credential
        if credential is None:
            return False
        try:
            refreshed = self._run(lambda client: client.login.refresh_credential(credential))
        except Exception as exc:
            self._invalidate_expired_credential(exc)
            logger.warning("刷新 QQ 音乐凭证失败：%s", exc)
            return False
        if refreshed and getattr(refreshed, "musickey", ""):
            self._store_credential(refreshed)
            return True
        return False

    def account(self) -> Account:
        self._load_session()
        credential = self._credential
        if credential is None:
            return Account(platform="qqm", label=self.label, state="missing", detail="未登录")
        if self._credential_invalid:
            return Account(platform="qqm", label=self.label, state="expired", detail="登录凭证已失效，请重新扫码")
        state = "valid"
        detail = ""
        if self._credential_expired(credential):
            # 本地判断过期先静默刷一次，刷不动才算真掉线
            if not self._refresh_credential():
                state = "expired"
                detail = "登录凭证已过期，请重新扫码"
        nickname, avatar = self._fetch_profile() if state == "valid" else ("", "")
        if state == "valid" and not detail:
            detail = f"musicid={getattr(self._credential, 'musicid', '')}"
        return Account(
            platform="qqm",
            label=self.label,
            state=state,  # type: ignore[arg-type]
            nickname=nickname,
            avatar=avatar,
            detail=detail,
        )

    def _fetch_profile(self) -> tuple[str, str]:
        """昵称/头像，带 5 分钟缓存——account() 会被前端轮询，不能每次都打网络。"""
        now = time.monotonic()
        if self._profile is not None and now - self._profile_at < PROFILE_TTL:
            return self._profile
        credential = self._credential
        euin = str(getattr(credential, "encrypt_uin", "") or "") if credential else ""
        profile = ("", "")
        if euin:
            try:
                res = self._run(lambda client: client.user.get_homepage(euin, credential=credential))
                base = _as_dict(getattr(res, "base_info", None))
                profile = (str(base.get("name") or ""), str(base.get("avatar") or ""))
            except Exception as exc:
                self._invalidate_expired_credential(exc)
                logger.debug("获取 QQ 音乐昵称失败：%s", exc)
        self._profile = profile
        self._profile_at = now
        return profile

    # ------------------------------------------------------------ 异步桥接

    def _run(self, build: Callable[[Any], Any]) -> Any:
        """跑一次 SDK 调用：模块方法要么是协程，要么返回待 execute 的 Request。"""
        credential = self._credential

        async def runner() -> Any:
            client = QQClient(credential=credential)
            try:
                value = build(client)
                if hasattr(value, "__await__"):
                    return await value
                return await client.execute(value)
            finally:
                await client.close()

        return run_async(runner)

    # ------------------------------------------------------------ 扫码

    def create_qr(self) -> tuple[str, str, str]:
        qr = self._run(lambda client: client.login.get_qrcode(QRLoginType.QQ))
        data = getattr(qr, "data", b"") or b""
        if not data:
            raise RuntimeError("QQ 音乐二维码获取失败")
        session_id = uuid4().hex
        self._prune_qr_sessions()
        # QR 里带着 qrsig，后续 check 全靠它；client 本身无状态，可以每次新建
        self._qr_sessions[session_id] = {"qr": qr, "created_at": time.time()}
        return session_id, qr_data_url(data, source_mime=str(getattr(qr, "mimetype", "") or "image/png")), ""

    def poll_qr(self, session_id: str) -> tuple[str, str]:
        entry = self._qr_sessions.get(session_id)
        if not entry:
            return "error", "二维码会话不存在或已过期，请重新获取"
        qr = entry["qr"]
        try:
            result = self._run(lambda client: client.login.check_qrcode(qr))
        except Exception as exc:
            return "error", f"检查二维码状态失败：{exc}"[:160]
        event = getattr(result, "event", None)
        if event == QRCodeLoginEvents.TIMEOUT:
            self._qr_sessions.pop(session_id, None)
            return "expired", "二维码已过期，请重新获取"
        if event == QRCodeLoginEvents.REFUSE:
            self._qr_sessions.pop(session_id, None)
            return "refused", "已在手机上拒绝登录"
        if event == QRCodeLoginEvents.SCAN:
            return "waiting", "等待手机扫码"
        if event == QRCodeLoginEvents.CONF:
            return "scanned", "已扫码，请在手机上确认"
        if event == QRCodeLoginEvents.DONE and getattr(result, "credential", None):
            self._qr_sessions.pop(session_id, None)
            self._store_credential(result.credential)
            return "done", "登录成功"
        return "waiting", ""

    def _prune_qr_sessions(self) -> None:
        now = time.time()
        for key in [k for k, v in self._qr_sessions.items() if now - float(v.get("created_at") or 0) > QR_SESSION_TTL]:
            self._qr_sessions.pop(key, None)

    def logout(self) -> None:
        credential = self._credential
        if credential is not None:
            try:
                self._run(lambda client: client.login.logout(credential))
            except Exception:
                pass
        with self._lock:
            self._credential = None
            self._credential_invalid = False
            self._session_mtime = None
            self._profile = None
            self._profile_at = 0.0
        try:
            self.session_file.unlink(missing_ok=True)
        except OSError:
            pass
        self._qr_sessions.clear()

    # ------------------------------------------------------------ 搜索 / 解析

    def search(self, keyword: str, limit: int = 20) -> list[SongSource]:
        keyword = str(keyword or "").strip()
        if not keyword:
            return []
        limit = max(1, int(limit or 20))
        try:
            res = self._run(
                lambda client: client.search.search_by_type(
                    keyword,
                    search_type=SearchType.SONG,
                    num=limit,
                    page=1,
                    highlight=False,
                )
            )
        except Exception as exc:
            self._invalidate_expired_credential(exc)
            raise
        songs = getattr(res, "song", None) or []
        return [self._to_source(song) for song in songs[:limit]]

    def parse_playlist(self, text: str) -> str | None:
        text = self._expand_short_link(text)
        if not self._is_qq_link(text):
            return None
        parsed = urlparse(text)
        path = parsed.path
        if "playsong" in path:
            return None
        params = parse_qs(parsed.query)
        # taoge.html 是 QQ 音乐 App 分享歌单的经典落地页
        if "id" in params and any(
            marker in path for marker in ("playlist", "songlist", "details/playlist", "taoge")
        ):
            return params["id"][0]
        blob = f"{path}#{parsed.fragment}"
        for pattern in (r"playlist[/=](\d+)", r"songlist[/=](\d+)"):
            match = re.search(pattern, blob)
            if match:
                return match.group(1)
        return None

    def parse_song(self, text: str) -> str | None:
        text = self._expand_short_link(text)
        if not self._is_qq_link(text):
            return None
        parsed = urlparse(text)
        params = parse_qs(parsed.query)
        for key in ("songmid", "mid"):
            value = (params.get(key) or [""])[0]
            if value:
                return value
        song_id = (params.get("songid") or params.get("id") or [""])[0]
        if song_id and ("playsong" in parsed.path or "song" in parsed.path):
            return song_id
        media_mid = (params.get("media_mid") or [""])[0]
        if media_mid:
            return media_mid
        parts = [part for part in parsed.path.split("/") if part]
        if parts and ("song" in parsed.path or "playsong" in parsed.path):
            candidate = parts[-1]
            if re.fullmatch(r"[0-9A-Za-z]+", candidate):
                return candidate
        return None

    @staticmethod
    def _is_qq_link(text: str) -> bool:
        return host_is(text, "qq.com") or host_is(text, "qqmusic.com")

    @staticmethod
    def _expand_short_link(text: str) -> str:
        """展开 url.cn 短链。

        和网易云的 163cn.tv 一样：**必须**用 host 精确判断再发请求，
        子串判断会让任意带 `?x=url.cn` 的链接把我们变成 SSRF 跳板。
        """
        text = html.unescape(str(text or "").strip())
        if not host_is(text, "url.cn"):
            return text
        try:
            with httpx.Client(follow_redirects=True, timeout=8) as client:
                resolved = str(client.get(text).url)
            if host_is(resolved, "qq.com"):
                return resolved
        except Exception:
            pass
        return text

    def resolve(self, url: str, limit: int = 500) -> ResolveResponse | None:
        text = self._expand_short_link(url)
        if not self._is_qq_link(text):
            return None
        limit = max(1, int(limit or 500))
        song_mid = self.parse_song(text)
        if song_mid:
            song = self._query_song(song_mid)
            if not song:
                raise RuntimeError(f"没有读取到这首 QQ 音乐歌曲（{song_mid}）")
            source = self._to_source(song)
            return ResolveResponse(kind="song", platform="qqm", title=source.title, sources=[source])
        playlist_id = self.parse_playlist(text)
        if playlist_id:
            title, songs = self._playlist_tracks(playlist_id, limit)
            if not songs:
                raise RuntimeError(f"没有读取到这个 QQ 音乐歌单（{playlist_id}）")
            return ResolveResponse(
                kind="playlist",
                platform="qqm",
                title=title,
                sources=[self._to_source(song) for song in songs[:limit]],
            )
        return None

    def _query_song(self, key: str) -> dict[str, Any]:
        value: str | int = int(key) if str(key).isdigit() else str(key)

        def build(client: Any) -> Any:
            if SongQueryInfo is not None:
                info = SongQueryInfo(id=value) if isinstance(value, int) else SongQueryInfo(mid=str(value))
                return client.song.query_song([info])
            return client.song.query_song([value])

        try:
            res = self._run(build)
        except Exception as exc:
            self._invalidate_expired_credential(exc)
            raise
        tracks = getattr(res, "tracks", None) or []
        return _as_dict(tracks[0]) if tracks else {}

    def _playlist_tracks(self, playlist_id: str, limit: int) -> tuple[str, list[Any]]:
        """歌单分页拉取：hasmore 与 total 双终止条件，任一到头就停。"""
        tracks: list[Any] = []
        title = f"QQ 音乐歌单 {playlist_id}"
        page = 1
        total: int | None = None
        while True:
            res = self._run(
                lambda client, current=page: client.songlist.get_detail(int(playlist_id), num=100, page=current)
            )
            songs = list(getattr(res, "songs", None) or [])
            info = _as_dict(getattr(res, "info", None))
            if page == 1:
                title = str(info.get("title") or info.get("dirname") or info.get("dissname") or title)
            tracks.extend(song for song in songs if _as_dict(song).get("mid") or _as_dict(song).get("id"))
            raw_total = getattr(res, "total", None)
            total = int(raw_total) if isinstance(raw_total, int) and raw_total > 0 else total
            hasmore = bool(getattr(res, "hasmore", 0))
            if not hasmore or not songs or len(tracks) >= limit:
                break
            if total is not None and len(tracks) >= total:
                break
            page += 1
        return title, tracks

    # ------------------------------------------------------------ 下载

    def download(
        self,
        source: SongSource,
        quality: str = "",
        cancel: threading.Event | None = None,
        on_progress: ProgressFn = noop_progress,
    ) -> Path:
        cancel = cancel or threading.Event()
        on_progress = on_progress or noop_progress
        if cancel.is_set():
            raise RuntimeError("下载已取消")
        output_dir = self.ctx.platform_dir("qqmusic")
        raw = dict(source.payload or {})
        file_type = FILE_TYPE_MAP.get(normalize_quality_start(quality or self.ctx.default_quality), SongFileType.MP3_320)

        media_mid = str((raw.get("file") or {}).get("media_mid") or raw.get("media_mid") or source.key)
        album_mid = self._album_mid(raw)
        resolved = self._download_url(source.key, media_mid, file_type)
        if not resolved:
            # 搜索结果里的 media_mid 偶尔是空的，回查一次详情再试
            detail = self._query_song(source.key)
            if detail:
                raw = detail
                media_mid = str((raw.get("file") or {}).get("media_mid") or source.key)
                album_mid = album_mid or self._album_mid(raw)
                resolved = self._download_url(source.key, media_mid, file_type)
        if not resolved:
            raise RuntimeError("QQ 音乐没有返回可用下载地址（可能是版权受限或需要绿钻）")
        url, actual_file_type = resolved
        ext = str(actual_file_type.e).lstrip(".")
        logger.info(
            "qqmusic download quality: song=%s requested=%s actual=%s downgraded=%s",
            source.key,
            getattr(file_type, "name", file_type),
            getattr(actual_file_type, "name", actual_file_type),
            file_type != actual_file_type,
        )

        filepath = output_dir / render_filename(
            self.ctx.filename_template,
            source.title,
            source.artist_text,
            source.album,
            source.key,
            ext,
            output_dir,
        )
        if filepath.exists():
            filepath.unlink()

        cover_data: bytes | None = None
        downloaded = 0
        try:
            with httpx.Client(timeout=30, follow_redirects=True) as client:
                cover_data = self._fetch_cover(client, album_mid or source.cover)
                with client.stream("GET", url) as resp:
                    resp.raise_for_status()
                    total = int(resp.headers.get("content-length") or 0)
                    on_progress(0, total)
                    with filepath.open("wb") as fp:
                        for chunk in resp.iter_bytes(64 * 1024):
                            if cancel.is_set():
                                raise RuntimeError("下载已取消")
                            if not chunk:
                                continue
                            fp.write(chunk)
                            downloaded += len(chunk)
                            on_progress(downloaded, total)
        except BaseException:
            filepath.unlink(missing_ok=True)
            raise

        try:
            embed_metadata(filepath, source.title, source.artists or ["Unknown"], source.album, cover_data)
        except Exception as exc:
            logger.warning("QQ 音乐写标签失败 song=%s: %s", source.key, exc)
        return filepath

    def _download_url(self, song_mid: str, media_mid: str, file_type: Any) -> tuple[str, Any] | None:
        """按 flac → 320 → 128 依次要链接，拿到哪个就用哪个。"""
        try:
            url = self._get_song_url(song_mid, media_mid, file_type)
            if url:
                return url, file_type
        except Exception:
            pass
        fallback_types: list[Any] = []
        if file_type == SongFileType.FLAC:
            fallback_types.extend([SongFileType.MP3_320, SongFileType.MP3_128])
        elif file_type == SongFileType.MP3_320:
            fallback_types.append(SongFileType.MP3_128)
        for fallback_type in fallback_types:
            try:
                url = self._get_song_url(song_mid, media_mid, fallback_type)
                if url:
                    return url, fallback_type
            except Exception:
                pass
        return None

    def _get_song_url(self, song_mid: str, media_mid: str, file_type: Any) -> str | None:
        info = SongFileInfo(mid=str(song_mid), media_mid=str(media_mid), file_type=file_type)
        credential = self._credential
        try:
            res = self._run(
                lambda client: client.song.get_song_urls([info], file_type=file_type, credential=credential)
            )
        except Exception as exc:
            self._invalidate_expired_credential(exc)
            raise
        for item in getattr(res, "data", None) or []:
            purl = str(getattr(item, "purl", "") or "")
            if not purl:
                continue
            if purl.startswith(("http://", "https://")):
                return purl
            return f"{self._get_cdn_base()}{purl}"
        return None

    def _get_cdn_base(self) -> str:
        """CDN 域名缓存：dispatch 给的 refresh_time 可能很大，硬压到 30 分钟以内。"""
        now = time.monotonic()
        if self._cdn_base and now < self._cdn_base_expires_at:
            return self._cdn_base
        try:
            dispatch = self._run(lambda client: client.song.get_cdn_dispatch())
            bases = [str(item) for item in (getattr(dispatch, "sip", None) or [])]
            selected = next(
                (base for base in bases if base.startswith("https://") and "sjy6.stream.qqmusic.qq.com" in base),
                CDN_FALLBACK,
            )
            self._cdn_base = selected.rstrip("/") + "/"
            refresh_time = int(getattr(dispatch, "refresh_time", 1800) or 1800)
            self._cdn_base_expires_at = now + max(60, min(refresh_time, 1800))
        except Exception:
            self._cdn_base = CDN_FALLBACK
            self._cdn_base_expires_at = now + 60
        return self._cdn_base

    @staticmethod
    def _fetch_cover(client: httpx.Client, album_mid_or_url: str) -> bytes | None:
        if not album_mid_or_url:
            return None
        if album_mid_or_url.startswith(("http://", "https://")):
            url = album_mid_or_url
        else:
            url = f"https://y.qq.com/music/photo_new/T002R300x300M000{album_mid_or_url}.jpg?max_age=2592000"
        try:
            resp = client.get(url, timeout=10)
            resp.raise_for_status()
            return resp.content
        except Exception:
            return None

    @staticmethod
    def _album_mid(raw: dict[str, Any]) -> str:
        album = raw.get("album") if isinstance(raw.get("album"), dict) else {}
        return str(album.get("mid") or raw.get("album_mid") or str(album.get("pmid") or "").split("_")[0] or "")

    # ------------------------------------------------------------ 归一化

    @classmethod
    def _to_source(cls, song: Any) -> SongSource:
        data = _as_dict(song)
        title = str(data.get("name") or data.get("title") or data.get("songname") or "Unknown")
        mid = data.get("mid") or data.get("songmid") or data.get("id")
        artists = [
            str(singer.get("name") or "")
            for singer in (data.get("singer") or [])
            if isinstance(singer, dict) and singer.get("name")
        ]
        album = data.get("album") if isinstance(data.get("album"), dict) else {}
        album_mid = cls._album_mid(data)
        interval = data.get("interval") or 0
        duration = float(interval) if isinstance(interval, (int, float)) and interval > 0 else None
        file_info = data.get("file") if isinstance(data.get("file"), dict) else {}
        max_quality: Quality | None = None
        if int(file_info.get("size_flac") or 0) > 0:
            max_quality = "flac"
        elif int(file_info.get("size_320mp3") or 0) > 0:
            max_quality = "320"
        elif int(file_info.get("size_128mp3") or 0) > 0:
            max_quality = "128"
        pay = data.get("pay") if isinstance(data.get("pay"), dict) else {}
        vip = any(int(pay.get(key) or 0) == 1 for key in ("pay_play", "pay_down", "pay_month"))
        return SongSource(
            platform="qqm",
            key=str(mid or ""),
            title=title,
            artists=artists,
            album=str(album.get("name") or album.get("title") or ""),
            duration=duration,
            cover=f"https://y.qq.com/music/photo_new/T002R300x300M000{album_mid}.jpg" if album_mid else "",
            max_quality=max_quality,
            vip=vip,
            payload=json_safe(data),
        )
