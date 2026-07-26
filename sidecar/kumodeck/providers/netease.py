"""网易云音乐 provider（pyncm）。

搬自 `kumocode_v2/entari_plugin_kumo_music_dl/service.py::NeteaseMusicClient`，
桌面端改动只有三处：SongItem → SongSource、下载加进度/取消、扫码改成非阻塞轮询。
"""

from __future__ import annotations

import html
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import httpx
import pyncm
from mutagen import File as MutagenFile
from pyncm import apis as ncm_apis
from pyncm.apis import login as ncm_login
from pyncm.apis import playlist as ncm_playlist
from pyncm.apis import track as ncm_track
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from ..models import Account, Quality, ResolveResponse, SongSource
from .base import (
    ProgressFn,
    ProviderContext,
    embed_metadata,
    host_is,
    json_safe,
    noop_progress,
    normalize_quality_start,
    qr_data_url_from_text,
    quality_gradient,
    render_filename,
)

logger = logging.getLogger("kumodeck.providers.netease")

#: 契约音质 → (pyncm level, 期望容器)
LEVEL_MAP: dict[str, tuple[str, str]] = {
    "flac": ("lossless", "flac"),
    "320": ("exhigh", "mp3"),
    "128": ("standard", "mp3"),
}

QR_SESSION_TTL = 15 * 60


class NeteaseProvider:
    platform = "wyy"
    label = "网易云音乐"

    def __init__(self, ctx: ProviderContext) -> None:
        self.ctx = ctx
        # pyncm 的 Session 是进程级全局单例，多线程下载会并发碰它，
        # 所有 API 调用都必须串在同一把锁后面
        self._lock = threading.RLock()
        self._qr_sessions: dict[str, dict[str, Any]] = {}
        self._session_mtime: float | None = None
        self._configure_session()
        self._load_session(force=True)

    # ------------------------------------------------------------ 登录态

    @property
    def session_file(self) -> Path:
        return self.ctx.session_dir / "netease.pyncm"

    def _configure_session(self) -> None:
        retry = Retry(total=5, backoff_factor=1, status_forcelist=[500, 502, 503, 504])
        adapter = HTTPAdapter(max_retries=retry)
        session = pyncm.GetCurrentSession()
        session.mount("http://", adapter)
        session.mount("https://", adapter)

    def _load_session(self, *, force: bool = False) -> None:
        """按需把落盘的登录态灌回 pyncm 全局 Session。

        原实现每次 API 调用前都无条件重新解析一遍（zlib+json），
        桌面端并发下载时这开销很浪费，改成只在文件 mtime 变化时重载。
        """
        path = self.session_file
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return
        if not force and mtime == self._session_mtime:
            return
        with self._lock:
            try:
                pyncm.SetCurrentSession(pyncm.LoadSessionFromString(path.read_text(encoding="utf-8")))
                self._configure_session()
                self._session_mtime = mtime
            except Exception as exc:
                logger.warning("加载网易云登录态失败：%s", exc)

    def _save_session(self) -> None:
        path = self.session_file
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            path.write_text(pyncm.DumpSessionAsString(pyncm.GetCurrentSession()), encoding="utf-8")
        try:
            self._session_mtime = path.stat().st_mtime
        except OSError:
            self._session_mtime = None

    def account(self) -> Account:
        self._load_session()
        if not self.session_file.exists():
            return Account(platform="wyy", label=self.label, state="missing", detail="未登录")
        session = pyncm.GetCurrentSession()
        try:
            with self._lock:
                status = ncm_login.GetCurrentLoginStatus()
        except Exception as exc:
            # 网络抖动不能把"已登录"误报成掉线，降级成 unknown 让前端保持原样
            return Account(
                platform="wyy",
                label=self.label,
                state="unknown",
                nickname=str(getattr(session, "nickname", "") or ""),
                detail=f"登录态检查失败：{exc}"[:160],
            )
        data = status.get("data", status) if isinstance(status, dict) else {}
        profile = data.get("profile") or {}
        account_id = (data.get("account") or {}).get("id")
        if profile and account_id:
            vip_type = int(profile.get("vipType") or 0)
            return Account(
                platform="wyy",
                label=self.label,
                state="valid",
                nickname=str(profile.get("nickname") or ""),
                avatar=str(profile.get("avatarUrl") or ""),
                detail="黑胶会员" if vip_type else "普通用户",
            )
        return Account(
            platform="wyy",
            label=self.label,
            state="expired",
            detail="登录态已失效，请重新扫码",
        )

    # ------------------------------------------------------------ 扫码

    def create_qr(self) -> tuple[str, str, str]:
        with self._lock:
            res = ncm_login.LoginQrcodeUnikey(dtype=1)
        unikey = str((res or {}).get("unikey") or "")
        if not unikey:
            raise RuntimeError(f"网易云二维码获取失败：{res}")
        url = f"https://music.163.com/login?codekey={unikey}"
        session_id = uuid4().hex
        self._prune_qr_sessions()
        self._qr_sessions[session_id] = {"unikey": unikey, "created_at": time.time()}
        return session_id, qr_data_url_from_text(url), url

    def poll_qr(self, session_id: str) -> tuple[str, str]:
        entry = self._qr_sessions.get(session_id)
        if not entry:
            return "error", "二维码会话不存在或已过期，请重新获取"
        try:
            with self._lock:
                res = ncm_login.LoginQrcodeCheck(entry["unikey"])
        except Exception as exc:
            return "error", f"检查二维码状态失败：{exc}"[:160]
        code = (res or {}).get("code")
        message = str((res or {}).get("message") or "")
        # 800 过期 / 801 待扫 / 802 已扫待确认 / 803 登录成功
        if code == 800:
            self._qr_sessions.pop(session_id, None)
            return "expired", message or "二维码已过期，请重新获取"
        if code == 801:
            return "waiting", message or "等待手机扫码"
        if code == 802:
            nickname = str((res or {}).get("nickname") or "")
            return "scanned", message or (f"{nickname} 已扫码，请在手机上确认" if nickname else "已扫码，请在手机上确认")
        if code == 803:
            self._qr_sessions.pop(session_id, None)
            self._finish_login()
            return "done", message or "登录成功"
        return "waiting", message

    def _finish_login(self) -> None:
        """扫码成功后把 profile 写进 Session 再落盘。

        pyncm 的 Session.dump() 会带上 login_info，先拉一次登录态，
        重启后 account() 不用再发请求就能显示昵称。
        """
        with self._lock:
            try:
                status = ncm_login.GetCurrentLoginStatus()
                pyncm.WriteLoginInfo(status)
            except Exception as exc:
                logger.warning("写入网易云登录信息失败：%s", exc)
        self._save_session()

    def _prune_qr_sessions(self) -> None:
        now = time.time()
        for key in [k for k, v in self._qr_sessions.items() if now - float(v.get("created_at") or 0) > QR_SESSION_TTL]:
            self._qr_sessions.pop(key, None)

    def logout(self) -> None:
        with self._lock:
            try:
                ncm_login.LoginLogout()
            except Exception:
                pass
            pyncm.SetCurrentSession(pyncm.CreateNewSession())
            self._configure_session()
        try:
            self.session_file.unlink(missing_ok=True)
        except OSError:
            pass
        self._session_mtime = None
        self._qr_sessions.clear()

    # ------------------------------------------------------------ 搜索 / 解析

    def search(self, keyword: str, limit: int = 20) -> list[SongSource]:
        keyword = str(keyword or "").strip()
        if not keyword:
            return []
        limit = max(1, int(limit or 20))
        self._load_session()
        with self._lock:
            res = ncm_apis.cloudsearch.GetSearchResult(keyword=keyword, limit=limit, stype=1)
        if not isinstance(res, dict) or res.get("code") != 200:
            raise RuntimeError(f"网易云搜索失败：code={(res or {}).get('code')}")
        songs = (res.get("result") or {}).get("songs") or []
        return [self._to_source(song) for song in songs[:limit]]

    def parse_url(self, text: str) -> tuple[str | None, str | None]:
        """从分享文本里抠出 (kind, id)；不是网易云链接返回 (None, None)。"""
        text = html.unescape(str(text or "").strip())
        # 只有 host 确实是 163cn.tv 时才展开短链——此前用子串判断，
        # 任意 URL 只要带上 ?ref=163cn.tv 就会让我们去请求它（盲 SSRF）。
        if host_is(text, "163cn.tv") and not host_is(text, "music.163.com"):
            try:
                with httpx.Client(follow_redirects=True, timeout=8) as client:
                    resolved = str(client.get(text).url)
                if host_is(resolved, "music.163.com"):
                    text = resolved
            except Exception:
                pass
        if not host_is(text, "music.163.com") and "music.163.com" not in text:
            return None, None
        parsed = urlparse(text)
        params = parse_qs(parsed.query)
        frag_params: dict[str, list[str]] = {}
        path = parsed.path
        # 网页版链接的真身在 fragment 里：/#/song?id=xxx
        if parsed.fragment:
            frag_path = parsed.fragment
            if "?" in frag_path:
                frag_path_part, frag_query = frag_path.split("?", 1)
                frag_params = parse_qs(frag_query)
            else:
                frag_path_part = frag_path
            if "id" in frag_params and "id" not in params:
                params["id"] = frag_params["id"]
            if not path or path == "/":
                path = frag_path_part if frag_path_part.startswith("/") else f"/{frag_path_part}"
        path_lower = path.lower()
        song_id = (params.get("id") or [""])[0]
        if song_id:
            if "/song" in path_lower:
                return "song", song_id
            if "/playlist" in path_lower:
                return "playlist", song_id
        for kind in ("song", "playlist"):
            match = re.search(rf"/{kind}[^\d]*(\d+)", path_lower)
            if match:
                return kind, match.group(1)
        if "id" in params:
            if "song" in text and "playlist" not in path_lower:
                return "song", params["id"][0]
            if "playlist" in text:
                return "playlist", params["id"][0]
        match = re.search(r"(song|playlist)[^\d]*(\d+)", text)
        if match:
            return match.group(1), match.group(2)
        return None, None

    def resolve(self, url: str, limit: int = 500) -> ResolveResponse | None:
        kind, key = self.parse_url(url)
        if not kind or not key:
            return None
        limit = max(1, int(limit or 500))
        if kind == "song":
            songs = self._track_detail([key])
            if not songs:
                raise RuntimeError(f"没有读取到这首网易云歌曲（id={key}）")
            source = self._to_source(songs[0])
            return ResolveResponse(kind="song", platform="wyy", title=source.title, sources=[source])
        title, songs = self._playlist_tracks(key)
        if not songs:
            raise RuntimeError(f"没有读取到这个网易云歌单（id={key}）")
        sources = [self._to_source(song) for song in songs[:limit]]
        return ResolveResponse(kind="playlist", platform="wyy", title=title, sources=sources)

    def _track_detail(self, song_ids: list[str]) -> list[dict[str, Any]]:
        self._load_session()
        with self._lock:
            res = ncm_track.GetTrackDetail([str(i) for i in song_ids])
        if isinstance(res, dict) and res.get("code") == 200:
            return list(res.get("songs") or [])
        return []

    def _playlist_tracks(self, playlist_id: str) -> tuple[str, list[dict[str, Any]]]:
        """歌单三级回退：AllTracks → PlaylistInfo.tracks → trackIds 反查详情。

        大歌单的 GetPlaylistInfo 只回前若干首，AllTracks 又时不时抽风，
        两条路都走不通时再用 trackIds 逐个查详情。
        """
        self._load_session()
        default_title = f"网易云歌单 {playlist_id}"
        first_error: Exception | None = None
        try:
            with self._lock:
                res = ncm_playlist.GetPlaylistAllTracks(playlist_id)
            songs = list(res.get("songs") or []) if isinstance(res, dict) else []
            if songs:
                return default_title, songs
        except Exception as exc:
            first_error = exc

        try:
            with self._lock:
                res = ncm_playlist.GetPlaylistInfo(playlist_id)
            playlist = res.get("playlist", {}) if isinstance(res, dict) else {}
            title = str((playlist or {}).get("name") or default_title)
            songs = list(playlist.get("tracks") or []) if isinstance(playlist, dict) else []
            if songs:
                return title, songs
            track_ids = playlist.get("trackIds") or [] if isinstance(playlist, dict) else []
            ids = [str(item.get("id")) for item in track_ids if isinstance(item, dict) and item.get("id")]
            if ids:
                detail_songs: list[dict[str, Any]] = []
                # 详情接口一次最多 1000 首，大歌单要分批
                for start in range(0, len(ids), 500):
                    detail_songs.extend(self._track_detail(ids[start : start + 500]))
                if detail_songs:
                    return title, detail_songs
            if isinstance(res, dict) and res.get("code") and res.get("code") != 200:
                raise ValueError(f"网易云歌单接口返回 code={res.get('code')}")
        except Exception as exc:
            if first_error:
                raise ValueError(f"读取网易云歌单失败：{first_error}; fallback: {exc}") from exc
            raise ValueError(f"读取网易云歌单失败：{exc}") from exc

        if first_error:
            raise ValueError(f"读取网易云歌单失败：{first_error}")
        return default_title, []

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
        self._load_session()
        output_dir = self.ctx.platform_dir("netease")
        start_quality = normalize_quality_start(quality or self.ctx.default_quality)

        song_info: dict[str, Any] = dict(source.payload or {})
        data: dict[str, Any] | None = None
        code: Any = None
        audio_api = "download-v1" if self.ctx.netease_use_download_api else "player-v1"
        requested_level = LEVEL_MAP[start_quality][0]
        with self._lock:
            if not song_info.get("al"):
                songs = self._track_detail([source.key])
                if songs:
                    song_info = songs[0]
            for quality_key in quality_gradient(start_quality):
                if cancel.is_set():
                    raise RuntimeError("下载已取消")
                requested_level = LEVEL_MAP[quality_key][0]
                started = time.monotonic()
                if self.ctx.netease_use_download_api:
                    audio_res = ncm_track.GetTrackDownloadURLV1(source.key, level=requested_level)
                else:
                    audio_res = ncm_track.GetTrackAudioV1(source.key, level=requested_level)
                data = self._first_audio_data(audio_res)
                code = audio_res.get("code") if isinstance(audio_res, dict) else None
                logger.info(
                    "netease audio api=%s song=%s level=%s code=%s elapsed_ms=%.0f",
                    audio_api,
                    source.key,
                    requested_level,
                    code,
                    (time.monotonic() - started) * 1000,
                )
                if code == 200 and data and data.get("url"):
                    break
            # player-v1 全梯度都空时退回 legacy 接口，老账号/老曲目还能捞一把
            if not self.ctx.netease_use_download_api and (code != 200 or not data or not data.get("url")):
                audio_api = "player-legacy"
                audio_res = ncm_track.GetTrackAudio(source.key)
                data = self._first_audio_data(audio_res)
                code = audio_res.get("code") if isinstance(audio_res, dict) else None

        if code != 200 or not data or not data.get("url"):
            raise RuntimeError("网易云没有返回可用下载地址（可能是版权受限或需要会员）")

        ext = str(data.get("type") or "mp3")
        expected_ext = "flac" if start_quality == "flac" else "mp3"
        logger.info(
            "netease download quality: song=%s api=%s start=%s requested=%s actual_type=%s br=%s size=%s downgraded=%s",
            source.key,
            audio_api,
            start_quality,
            requested_level,
            ext,
            data.get("br"),
            data.get("size"),
            expected_ext == "flac" and ext.lower() != "flac",
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

        total = int(data.get("size") or 0)
        downloaded = 0
        try:
            with pyncm.GetCurrentSession().get(data["url"], stream=True, timeout=60) as resp:
                resp.raise_for_status()
                header_total = int(resp.headers.get("content-length") or 0)
                total = header_total or total
                on_progress(0, total)
                with filepath.open("wb") as fp:
                    for chunk in resp.iter_content(chunk_size=64 * 1024):
                        if cancel.is_set():
                            raise RuntimeError("下载已取消")
                        if not chunk:
                            continue
                        fp.write(chunk)
                        downloaded += len(chunk)
                        on_progress(downloaded, total)
        except BaseException:
            # 半成品文件不能留在下载目录里，否则会被曲库扫描当成正常曲目
            filepath.unlink(missing_ok=True)
            raise

        if self._looks_like_failed_download(filepath, source):
            filepath.unlink(missing_ok=True)
            raise RuntimeError("网易云只返回了试听片段（需要会员或版权受限）")

        cover_data = self._fetch_cover(source, song_info)
        try:
            embed_metadata(filepath, source.title, source.artists or ["Unknown"], source.album, cover_data)
        except Exception as exc:
            logger.warning("网易云写标签失败 song=%s: %s", source.key, exc)
        return filepath

    def _fetch_cover(self, source: SongSource, song_info: dict[str, Any]) -> bytes | None:
        cover_url = source.cover or ((song_info.get("al") or {}).get("picUrl") if isinstance(song_info, dict) else "")
        if not cover_url:
            return None
        try:
            resp = pyncm.GetCurrentSession().get(str(cover_url), timeout=20)
            if resp.status_code == 200:
                return resp.content
        except Exception:
            return None
        return None

    def _looks_like_failed_download(self, filepath: Path, source: SongSource) -> bool:
        """试听片段检测：文件过小、或时长明显短于应有时长，就当失败。"""
        try:
            if not filepath.exists() or filepath.stat().st_size < 100 * 1024:
                return True
            audio = MutagenFile(filepath)
            duration = getattr(getattr(audio, "info", None), "length", None)
            expected = self._expected_duration(source)
            if duration is None:
                return False
            if expected and expected > 60 and duration < min(45, expected * 0.5):
                return True
            return bool(duration <= 35 and (not expected or expected > 60))
        except Exception:
            return False

    @staticmethod
    def _expected_duration(source: SongSource) -> float | None:
        if source.duration and source.duration > 0:
            return float(source.duration)
        raw = source.payload or {}
        value = raw.get("dt") or raw.get("duration")
        if isinstance(value, (int, float)) and value > 0:
            return float(value) / 1000 if value > 1000 else float(value)
        return None

    @staticmethod
    def _first_audio_data(audio_res: Any) -> dict[str, Any] | None:
        data = audio_res.get("data") if isinstance(audio_res, dict) else None
        if isinstance(data, list):
            return data[0] if data else None
        if isinstance(data, dict):
            return data
        return None

    # ------------------------------------------------------------ 归一化

    @classmethod
    def _to_source(cls, song: dict[str, Any]) -> SongSource:
        artists = [
            str(artist.get("name") or "")
            for artist in (song.get("ar") or song.get("artists") or [])
            if isinstance(artist, dict) and artist.get("name")
        ]
        album = song.get("al") or song.get("album") or {}
        if not isinstance(album, dict):
            album = {}
        raw_duration = song.get("dt") or song.get("duration") or 0
        duration: float | None = None
        if isinstance(raw_duration, (int, float)) and raw_duration > 0:
            # dt 是毫秒；老接口的 duration 偶尔直接给秒
            duration = float(raw_duration) / 1000 if raw_duration > 1000 else float(raw_duration)
        max_quality, vip = cls._quality_and_vip(song)
        return SongSource(
            platform="wyy",
            key=str(song.get("id") or ""),
            title=str(song.get("name") or "Unknown"),
            artists=artists,
            album=str(album.get("name") or ""),
            duration=duration,
            cover=str(album.get("picUrl") or ""),
            max_quality=max_quality,
            vip=vip,
            payload=json_safe(song),
        )

    @staticmethod
    def _quality_and_vip(song: dict[str, Any]) -> tuple[Quality | None, bool]:
        privilege = song.get("privilege") if isinstance(song.get("privilege"), dict) else {}
        max_quality: Quality | None = None
        # 详情接口给的是 sq/hr/h/m/l 五档音质对象，搜索接口只给 privilege.maxbr
        if song.get("sq") or song.get("hr"):
            max_quality = "flac"
        elif song.get("h"):
            max_quality = "320"
        elif song.get("m") or song.get("l"):
            max_quality = "128"
        else:
            maxbr = privilege.get("maxbr") or song.get("maxbr") or 0
            try:
                maxbr = int(maxbr)
            except (TypeError, ValueError):
                maxbr = 0
            if maxbr >= 999000:
                max_quality = "flac"
            elif maxbr >= 320000:
                max_quality = "320"
            elif maxbr > 0:
                max_quality = "128"
        fee = privilege.get("fee", song.get("fee"))
        try:
            fee = int(fee) if fee is not None else 0
        except (TypeError, ValueError):
            fee = 0
        # fee: 1=VIP 专享 4=专辑付费 8=低音质免费（非会员只能听低码率）
        return max_quality, fee in {1, 4}
