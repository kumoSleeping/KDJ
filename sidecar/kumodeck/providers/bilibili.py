"""哔哩哔哩视频 provider。

算法与安全策略沿用机器人版 `kumocode_v2/entari_plugin_kumo_video_dl/service.py`，
其中三处已修复的真实 bug 必须原样保留（见对应函数注释）：

1. 短链逐跳展开：`follow_redirects=False`，每一跳都重新校验域名白名单 + DNS 出来的 IP 是公网。
2. `detect_best_streams` 的返回是「定长二元组语义」`[视频流, 音频流]`，按位置解包，不能过滤 None 后按下标取。
3. ffmpeg 先写 `.partial/output.*`，校验通过后 `os.replace` 到最终路径，失败不污染上一次的成品。

桌面端相对机器人版的差异：去掉了 max_download_mb / max_duration 两个硬限制（保留 ffmpeg 超时），
媒体流下载改用同步 httpx（下载线程本来就是同步的，这样 cancel/进度回调都不用跨事件循环）。
"""

from __future__ import annotations

import asyncio
import base64
import html
import io
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, TypeVar
from urllib.parse import parse_qs, urlparse

import httpx
from bilibili_api import Credential, login_v2, user, video
from bilibili_api import search as bili_search

from ..models import Account, SongSource, VideoDownloadRequest, VideoInfo, VideoPage, VideoStreamOption
from .base import ProgressFn, ProviderContext, finalize_filename, sanitize_filename_value

T = TypeVar("T")


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)
DOWNLOAD_HEADERS = {
    "User-Agent": USER_AGENT,
    "Referer": "https://www.bilibili.com/",
}
ALLOWED_HOSTS = {
    "b23.tv",
    "bilibili.com",
    "www.bilibili.com",
    "m.bilibili.com",
}
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
BVID_RE = re.compile(r"(BV[0-9A-Za-z]{10})", re.IGNORECASE)
REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})

CHUNK_SIZE = 1024 * 1024
PROGRESS_INTERVAL = 0.2
FFMPEG_TIMEOUT_SECONDS = 30 * 60
TRANSCODE_CRF = 20
TRANSCODE_PRESET = "veryfast"
QR_SESSION_TTL = 10 * 60

# 清晰度 id → (展示名, 画面高度)。bilibili_api 的 VideoQuality 枚举里没有 6/74，
# 但 accept_quality 里会出现，所以这张表要比枚举更全。
QUALITY_META: dict[int, tuple[str, int]] = {
    6: ("极速 240P", 240),
    16: ("流畅 360P", 360),
    32: ("清晰 480P", 480),
    64: ("高清 720P", 720),
    74: ("高清 720P60", 720),
    80: ("高清 1080P", 1080),
    100: ("智能修复", 1080),
    112: ("高清 1080P 高码率", 1080),
    116: ("高清 1080P60", 1080),
    120: ("超清 4K", 2160),
    125: ("真彩 HDR", 2160),
    126: ("杜比视界", 2160),
    127: ("超高清 8K", 4320),
}
CODEC_PRIORITY = ("AVC", "HEV", "AV1", "UNKNOWN")


class DownloadCanceled(RuntimeError):
    """用户主动取消。继承 RuntimeError，上层用通用 except 也能兜住。"""


# ---------------------------------------------------------------- 事件循环

_SESSION_POOL_LOCK = threading.Lock()


def run_async(factory: Callable[[], Awaitable[T]]) -> T:
    """在一个全新的事件循环里跑完一个协程，并把 bilibili_api 绑在这个循环上的会话清干净。

    bilibili_api 全是 async，而 provider 对外必须是同步的。它内部按
    `session_pool[client][loop]` 缓存 HTTP 会话，如果只是把循环关掉，
    会话对象会连同死循环一起留在池子里（下次 atexit 清理时还会踩到已关闭的循环）。
    所以这里不用 `bilibili_api.request_settings` 那条「换同步 session」的路
    （它只对 curl_cffi 那套有意义，本项目只装了 httpx），而是走更稳的：
    跑完 → 主动 await client.close() → 从池子里摘掉本循环的条目 → 再关循环。

    参数是 factory 而不是协程对象：协程必须在目标循环已经是「当前循环」之后再构造，
    否则库里那些在构造期就 get_event_loop() 的代码会抓到别的循环。
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return _run_in_new_loop(factory)
    # 已经身处事件循环（例如被 async 路由直接调用）时 run_until_complete 会直接抛错，
    # 换个线程跑自己的循环。
    box: dict[str, Any] = {}

    def worker() -> None:
        try:
            box["value"] = _run_in_new_loop(factory)
        except BaseException as exc:  # noqa: BLE001 - 原样搬运到调用线程
            box["error"] = exc

    thread = threading.Thread(target=worker, daemon=True, name="kumodeck-bilibili")
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box["value"]


def _run_in_new_loop(factory: Callable[[], Awaitable[T]]) -> T:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(factory())
    finally:
        try:
            loop.run_until_complete(_close_bili_session())
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception:
            pass
        _forget_loop_sessions(loop)
        asyncio.set_event_loop(None)
        loop.close()


async def _close_bili_session() -> None:
    try:
        from bilibili_api.utils import network

        client = network.get_client()
    except Exception:
        return
    try:
        await client.close()
    except Exception:
        return
    # 再让出一次控制权，给底层 transport 的关闭回调一个执行机会，
    # 否则关循环时会刷 "Event loop is closed" 之类的噪音。
    await asyncio.sleep(0)


def _forget_loop_sessions(loop: asyncio.AbstractEventLoop) -> None:
    try:
        from bilibili_api.utils import network
    except Exception:
        return
    with _SESSION_POOL_LOCK:
        for pool_name in ("session_pool", "lazy_settings"):
            pools = getattr(network, pool_name, None)
            if not isinstance(pools, dict):
                continue
            for per_loop in list(pools.values()):
                if isinstance(per_loop, dict):
                    per_loop.pop(loop, None)


# ---------------------------------------------------------------- URL / SSRF


def _normalize_shared_text(value: Any) -> str:
    text = html.unescape(str(value or ""))
    return text.replace("\\/", "/")


def _clean_shared_url(value: str) -> str:
    return value.rstrip("。，、；：！？,.!?;:)]}>'\"")


def _host_allowed(host: str | None) -> bool:
    normalized = str(host or "").lower().rstrip(".")
    return normalized in ALLOWED_HOSTS or normalized.endswith(".bilibili.com")


def _resolves_to_public_ip(host: str | None) -> bool:
    """拒绝解析到私网/回环/链路本地地址的主机。

    白名单域名理论上不会解析到内网，但 DNS 可被投毒、跳转可被开放重定向指向内网，
    所以每一跳都要独立确认目标 IP 是公网地址。
    """
    name = str(host or "").strip()
    if not name:
        return False
    try:
        infos = socket.getaddrinfo(name, None, proto=socket.IPPROTO_TCP)
    except OSError:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            address = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if not address.is_global or address.is_loopback or address.is_private or address.is_link_local:
            return False
    return True


def _url_is_safe_bilibili(value: str) -> bool:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        return False
    if not _host_allowed(parsed.hostname):
        return False
    return _resolves_to_public_ip(parsed.hostname)


def _pick_bilibili_url(text: str) -> str:
    """从文本里挑出第一个通过白名单的 B 站链接。

    要遍历所有 URL 而不是只看第一个，否则「转自 t.cn/xxx 原视频 bilibili.com/xxx」整条会被拒。
    """
    for candidate in URL_RE.findall(text):
        cleaned = _clean_shared_url(candidate)
        if _host_allowed(urlparse(cleaned).hostname):
            return cleaned
    return ""


def _page_index_from_url(value: str) -> int:
    try:
        page_value = parse_qs(urlparse(value).query).get("p", ["1"])[0]
        return max(0, int(page_value) - 1)
    except (TypeError, ValueError):
        return 0


def _normalize_bvid(value: str) -> str:
    match = BVID_RE.search(str(value or ""))
    if not match:
        return ""
    raw = match.group(1)
    # 后 10 位是大小写敏感的 base58，只能把 BV 前缀规范成大写，其余原样保留。
    return "BV" + raw[2:]


def _expand_short_link(url: str, max_hops: int = 3) -> str:
    """逐跳展开短链，每一跳都独立校验域名白名单与目标 IP。

    不能图省事用 follow_redirects=True 一次性跟到底再校验最终 URL——
    中间跳转可以是任意内网地址，而那些请求是真的会发出去的（盲 SSRF）。
    """
    current = url
    with httpx.Client(
        follow_redirects=False,
        headers={"User-Agent": USER_AGENT},
        timeout=20.0,
    ) as client:
        for _ in range(max_hops):
            if not _url_is_safe_bilibili(current):
                raise ValueError("分享链接跳转到了不允许的地址")
            response = client.get(current)
            if response.status_code not in REDIRECT_CODES:
                response.raise_for_status()
                return str(response.url)
            location = response.headers.get("location") or ""
            if not location:
                return str(response.url)
            current = str(httpx.URL(current).join(location))
    raise ValueError("分享短链跳转次数过多")


_SEARCH_EM_RE = re.compile(r"</?em[^>]*>", re.IGNORECASE)


def _strip_search_markup(title: str) -> str:
    """搜索接口的标题带 <em class="keyword"> 高亮标签，展示前剥掉再反转义。"""
    return html.unescape(_SEARCH_EM_RE.sub("", title)).strip()


def _parse_clock(value: str) -> float | None:
    """搜索接口的时长是 "12:34" / "1:02:03" 这种钟面格式。"""
    parts = [p for p in value.strip().split(":") if p != ""]
    if not parts:
        return None
    try:
        seconds = 0.0
        for part in parts:
            seconds = seconds * 60 + float(part)
        return seconds if seconds > 0 else None
    except ValueError:
        return None


def _normalize_pic(url: str) -> str:
    """封面地址归一成 https 绝对链接。

    B 站接口回的是协议相对（//i2.hdslb.com/...）或纯 http，
    而渲染端 CSP 的 img-src 只放行 https 外链——不归一图就是白格子。
    """
    url = url.strip()
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith("http://"):
        return "https://" + url[len("http://"):]
    return url


@dataclass(frozen=True)
class VideoTarget:
    bvid: str
    page_index: int = 0
    resolved_url: str = ""


def resolve_video_target(source: str) -> VideoTarget:
    """把「分享文案 / 链接 / 裸 BV 号」解析成 (bvid, 分P 下标)。"""
    text = _normalize_shared_text(source).strip()
    shared_url = _pick_bilibili_url(text)
    direct_bvid = _normalize_bvid(text)
    page_index = _page_index_from_url(shared_url) if shared_url else 0

    if shared_url:
        parsed = urlparse(shared_url)
        # 普通站内链接里已经带 BV 号，没必要再发一次请求；b23.tv 短链才需要展开。
        if direct_bvid and str(parsed.hostname or "").lower() != "b23.tv":
            return VideoTarget(bvid=direct_bvid, page_index=page_index, resolved_url=shared_url)
        resolved_url = _expand_short_link(shared_url)
        if not _host_allowed(urlparse(resolved_url).hostname):
            raise ValueError("分享短链跳转到了非哔哩哔哩域名")
        resolved_bvid = _normalize_bvid(resolved_url)
        if resolved_bvid:
            return VideoTarget(
                bvid=resolved_bvid,
                page_index=_page_index_from_url(resolved_url),
                resolved_url=resolved_url,
            )

    if direct_bvid:
        return VideoTarget(bvid=direct_bvid, page_index=page_index)
    raise ValueError("没有找到有效的哔哩哔哩 BV 号或分享链接")


def _ensure_media_url(url: str) -> None:
    """媒体直链来自登录态 API 的响应（不是用户输入），CDN 域名也不固定，
    所以这里不做域名白名单，只挡掉 file:// 之类的协议和指向内网的主机。
    """
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("媒体直链协议不受支持")
    if not _resolves_to_public_ip(parsed.hostname):
        raise ValueError("媒体直链解析到了非公网地址")


# ---------------------------------------------------------------- 登录态


def load_credential(path: Path) -> Credential | None:
    if not path.exists():
        return None
    try:
        values = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(values, dict):
        return None
    allowed = {"sessdata", "bili_jct", "buvid3", "buvid4", "dedeuserid", "ac_time_value"}
    kwargs = {key: value for key, value in values.items() if key in allowed and value}
    return Credential(**kwargs) if kwargs.get("sessdata") else None


def save_credential(credential: Credential, path: Path) -> None:
    cookies = {str(key).lower(): value for key, value in credential.get_cookies().items() if value}
    values = {
        key: cookies[key]
        for key in ("sessdata", "bili_jct", "buvid3", "buvid4", "dedeuserid", "ac_time_value")
        if cookies.get(key)
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(values, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _cookie_jar(credential: Credential | None) -> dict[str, str]:
    if credential is None:
        return {}
    jar: dict[str, str] = {}
    for key, value in credential.get_cookies().items():
        # get_cookies 会把 Credential 上所有非 None 属性都塞进来，非字符串的直接丢掉。
        if isinstance(value, str) and value:
            jar[str(key)] = value
    return jar


def _qr_png(link: str, picture: Any) -> bytes:
    """优先用 segno 按链接重画二维码（尺寸可控、边距干净），失败再退回 bilibili_api 给的图。"""
    if link:
        try:
            import segno

            buffer = io.BytesIO()
            segno.make(link, error="m").save(
                buffer, kind="png", scale=8, border=2, dark="#000000", light="#ffffff"
            )
            return buffer.getvalue()
        except Exception:
            pass
    content = getattr(picture, "content", b"") or b""
    return bytes(content)


# ---------------------------------------------------------------- 清晰度


def _max_quality(max_height: int) -> video.VideoQuality:
    height = int(max_height or 1080)
    if height <= 360:
        return video.VideoQuality._360P
    if height <= 480:
        return video.VideoQuality._480P
    if height <= 720:
        return video.VideoQuality._720P
    if height <= 1080:
        # 100/112/116 都是 1080 高度但码率更高，用 _1080P_60 当上界可以把它们放进来。
        return video.VideoQuality._1080P_60
    if height <= 2160:
        return video.VideoQuality._4K
    return video.VideoQuality._8K


def _quality_meta(quality_id: int, fallback_height: int = 0) -> tuple[str, int]:
    label, height = QUALITY_META.get(int(quality_id), ("", 0))
    if not height:
        height = fallback_height
    if not label:
        label = f"{height}P" if height else f"QN {quality_id}"
    return label, height


def _codec_rank(name: str) -> int:
    upper = str(name or "").upper()
    return CODEC_PRIORITY.index(upper) if upper in CODEC_PRIORITY else len(CODEC_PRIORITY)


def _stream_options(payload: dict, detector: video.VideoDownloadURLDataDetecter) -> list[VideoStreamOption]:
    """把 get_download_url 的结果整理成前端画质下拉框用的选项，按 height 降序。"""
    data = payload.get("video_info") or payload
    options: dict[int, VideoStreamOption] = {}

    if not detector.check_flv_mp4_stream():
        try:
            streams = detector.detect()
        except Exception:
            streams = []
        for stream in streams:
            if not isinstance(stream, video.VideoStreamDownloadURL):
                continue
            quality_id = int(stream.video_quality.value)
            scale = getattr(stream, "scale", None) or (0, 0)
            label, height = _quality_meta(quality_id, int(scale[1] or 0))
            codec = getattr(stream.video_codecs, "name", "") or ""
            current = options.get(quality_id)
            # 同一档位可能有 AVC/HEV/AV1 三份，只留兼容性最好的那个编码名。
            if current is None or _codec_rank(codec) < _codec_rank(current.codec):
                options[quality_id] = VideoStreamOption(
                    quality_id=quality_id, label=label, height=height, codec=codec
                )

    if not options:
        # flv / mp4 单流，或者 detect() 撞上未知 qn 枚举时，退回接口自报的可选清晰度。
        ids = data.get("accept_quality") or []
        descriptions = data.get("accept_description") or []
        for position, raw_id in enumerate(ids):
            try:
                quality_id = int(raw_id)
            except (TypeError, ValueError):
                continue
            label, height = _quality_meta(quality_id)
            if position < len(descriptions) and descriptions[position]:
                label = str(descriptions[position])
            options[quality_id] = VideoStreamOption(
                quality_id=quality_id, label=label, height=height, codec=""
            )

    return sorted(options.values(), key=lambda item: (item.height, item.quality_id), reverse=True)


# ---------------------------------------------------------------- ffmpeg


def _ffmpeg_binary() -> str:
    binary = shutil.which("ffmpeg")
    if not binary:
        raise RuntimeError("没有找到 ffmpeg，请先安装 FFmpeg")
    return binary


def _kill_process(process: subprocess.Popen) -> None:
    try:
        process.kill()
    except OSError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def _run_ffmpeg(command: list[str], log_path: Path, cancel: threading.Event) -> None:
    """跑 ffmpeg，同时支持取消和超时。

    stderr 直接重定向到文件而不是 PIPE：转码时 ffmpeg 输出很啰嗦，
    用 PIPE 又不及时读会把管道写满导致死锁。
    """
    if cancel.is_set():
        # 短视频可能在第一次 wait 超时之前就跑完了，所以起进程之前先看一眼。
        raise DownloadCanceled("下载已取消")
    with log_path.open("wb") as log:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=log)
        deadline = time.monotonic() + FFMPEG_TIMEOUT_SECONDS
        while True:
            try:
                code = process.wait(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if cancel.is_set():
                    _kill_process(process)
                    raise DownloadCanceled("下载已取消")
                if time.monotonic() > deadline:
                    _kill_process(process)
                    raise RuntimeError("FFmpeg 处理超时")
    if code != 0:
        detail = ""
        try:
            lines = log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()
            detail = lines[-1].strip() if lines else ""
        except OSError:
            detail = ""
        raise RuntimeError(f"FFmpeg 处理失败：{detail or code}")


# ---------------------------------------------------------------- Provider


class BilibiliProvider:
    platform = "bilibili"
    label = "哔哩哔哩"

    def __init__(self, ctx: ProviderContext) -> None:
        self.ctx = ctx
        self.credential_file = ctx.session_dir / "bilibili.json"
        self._qr_lock = threading.Lock()
        self._qr_sessions: dict[str, tuple[login_v2.QrCodeLogin, float]] = {}

    # ------------------------------------------------------------ 账号

    def credential(self) -> Credential | None:
        return load_credential(self.credential_file)

    def account(self) -> Account:
        credential = self.credential()
        if credential is None:
            return Account(platform="bilibili", label=self.label, state="missing", detail="未登录")

        async def fetch() -> tuple[bool, dict]:
            valid = bool(await credential.check_valid())
            if not valid:
                return False, {}
            try:
                return True, dict(await user.get_self_info(credential) or {})
            except Exception:
                return True, {}

        try:
            valid, info = run_async(fetch)
        except Exception as exc:
            return Account(platform="bilibili", label=self.label, state="unknown", detail=str(exc))
        if not valid:
            return Account(
                platform="bilibili", label=self.label, state="expired", detail="登录已失效，请重新扫码"
            )
        uid = info.get("mid") or ""
        return Account(
            platform="bilibili",
            label=self.label,
            state="valid",
            nickname=str(info.get("name") or ""),
            avatar=str(info.get("face") or ""),
            detail=f"UID {uid}" if uid else "",
        )

    def create_qr(self) -> tuple[str, str, str]:
        self._prune_qr_sessions()
        qr_login = login_v2.QrCodeLogin(platform=login_v2.QrCodeLoginChannel.WEB)

        async def generate() -> None:
            await qr_login.generate_qrcode()

        run_async(generate)
        # bilibili_api 没给二维码链接的公开 getter，只能读私有属性；
        # 拿不到也不影响扫码（url 只是给前端做「浏览器打开」的兜底）。
        link = str(getattr(qr_login, "_QrCodeLogin__qr_link", "") or "")
        png = _qr_png(link, qr_login.get_qrcode_picture())
        if not png:
            raise RuntimeError("生成哔哩哔哩登录二维码失败")
        session_id = uuid.uuid4().hex
        with self._qr_lock:
            self._qr_sessions[session_id] = (qr_login, time.monotonic())
        data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        return session_id, data_url, link

    def poll_qr(self, session_id: str) -> tuple[str, str]:
        with self._qr_lock:
            entry = self._qr_sessions.get(session_id)
        if entry is None:
            return "expired", "登录会话不存在或已失效，请重新获取二维码"
        qr_login = entry[0]

        async def check() -> login_v2.QrCodeLoginEvents:
            return await qr_login.check_state()

        try:
            state = run_async(check)
        except Exception as exc:
            return "error", f"轮询登录状态失败：{exc}"

        if state == login_v2.QrCodeLoginEvents.DONE:
            try:
                save_credential(qr_login.get_credential(), self.credential_file)
            except Exception as exc:
                return "error", f"保存登录态失败：{exc}"
            with self._qr_lock:
                self._qr_sessions.pop(session_id, None)
            return "done", "登录成功"
        if state == login_v2.QrCodeLoginEvents.TIMEOUT:
            with self._qr_lock:
                self._qr_sessions.pop(session_id, None)
            return "expired", "二维码已过期，请重新获取"
        if state == login_v2.QrCodeLoginEvents.CONF:
            return "scanned", "已扫码，请在手机上确认登录"
        return "waiting", "等待扫码"

    def logout(self) -> None:
        try:
            self.credential_file.unlink(missing_ok=True)
        except OSError:
            pass
        with self._qr_lock:
            self._qr_sessions.clear()

    def _prune_qr_sessions(self) -> None:
        now = time.monotonic()
        with self._qr_lock:
            stale = [key for key, (_, born) in self._qr_sessions.items() if now - born > QR_SESSION_TTL]
            for key in stale:
                self._qr_sessions.pop(key, None)

    # ------------------------------------------------------------ 搜索（音乐管线）

    def search(self, keyword: str, limit: int = 20) -> list[SongSource]:
        """B 站关键词搜视频，回和音乐平台同构的 SongSource。

        下载走 download()（只抽音轨进曲库）。视频没有"音质档"概念，
        max_quality 留空，混合去重时它自然排在有 flac 标记的音乐平台后面。
        """
        keyword = str(keyword or "").strip()
        if not keyword:
            return []
        limit = max(1, min(int(limit or 20), 50))

        async def run() -> dict:
            result = await bili_search.search_by_type(
                keyword, search_type=bili_search.SearchObjectType.VIDEO, page=1
            )
            return dict(result or {})

        payload = run_async(run)
        sources: list[SongSource] = []
        for item in payload.get("result") or []:
            if not isinstance(item, dict):
                continue
            bvid = str(item.get("bvid") or "").strip()
            if not bvid:
                continue
            author = str(item.get("author") or "").strip()
            sources.append(
                SongSource(
                    platform="bilibili",
                    key=bvid,
                    title=_strip_search_markup(str(item.get("title") or bvid)),
                    artists=[author] if author else [],
                    album="",
                    duration=_parse_clock(str(item.get("duration") or "")),
                    cover=_normalize_pic(str(item.get("pic") or "")),
                    payload={"bvid": bvid},
                )
            )
            if len(sources) >= limit:
                break
        return sources

    def download(
        self,
        source: SongSource,
        quality: str,
        cancel: threading.Event,
        on_progress: ProgressFn,
    ) -> Path:
        """音乐下载管线的统一入口：B 站来源永远下**完整视频**。

        视频就是视频——画面不在下载环节丢掉。落到视频目录、照样入库，
        播放时曲库自己取它的音轨（/library/audio 的抽轨缓存）。
        想要纯 m4a 走视频面板里的「只要音轨」。quality 对 B 站没有意义，
        收下忽略，保持和网易云/QQ 同一个签名，downloader 不用特判平台。
        """
        del quality
        request = VideoDownloadRequest(
            bvid=str(source.key),
            page_index=int((source.payload or {}).get("page_index") or 0),
            # 搜索结果没有逐条选画质的入口，1080 是不吃亏的默认
            max_height=1080,
            audio_only=False,
            transcode=False,
        )
        return self.download_video(request, cancel, on_progress)

    # ------------------------------------------------------------ 解析

    def resolve_video(self, url: str) -> VideoInfo:
        target = resolve_video_target(url)
        credential = self.credential()

        async def fetch() -> tuple[bool, dict, dict, int]:
            logged_in = await self._check_login(credential)
            handle = video.Video(bvid=target.bvid, credential=credential if logged_in else None)
            info = dict(await handle.get_info() or {})
            pages = list(info.get("pages") or [])
            index = min(max(target.page_index, 0), max(len(pages) - 1, 0))
            download_data = dict(await handle.get_download_url(page_index=index) or {})
            return logged_in, info, download_data, index

        logged_in, info, download_data, index = run_async(fetch)

        detector = video.VideoDownloadURLDataDetecter(download_data)
        pages: list[VideoPage] = []
        for position, page in enumerate(info.get("pages") or []):
            pages.append(
                VideoPage(
                    index=position,  # 分 P 下标从 0 开始，和 get_download_url 的 page_index 对齐
                    title=str(page.get("part") or f"P{position + 1}"),
                    duration=int(page.get("duration") or 0),
                )
            )
        owner = info.get("owner") or {}
        return VideoInfo(
            bvid=str(info.get("bvid") or target.bvid),
            title=str(info.get("title") or target.bvid),
            author=str(owner.get("name") or ""),
            cover=_normalize_pic(str(info.get("pic") or "")),
            duration=int(info.get("duration") or 0),
            pages=pages,
            options=_stream_options(download_data, detector),
            logged_in=logged_in,
        )

    async def _check_login(self, credential: Credential | None) -> bool:
        if credential is None:
            return False
        try:
            return bool(await credential.check_valid())
        except Exception:
            return False

    def _target_of(self, req: VideoDownloadRequest) -> tuple[str, int]:
        if str(req.bvid or "").strip():
            bvid = _normalize_bvid(req.bvid)
            if not bvid:
                raise ValueError("BV 号格式不正确")
            return bvid, max(0, int(req.page_index or 0))
        target = resolve_video_target(req.url)
        # 前端没显式选分 P（page_index=0）时，沿用链接里 ?p= 带来的下标。
        explicit = max(0, int(req.page_index or 0))
        return target.bvid, explicit or target.page_index

    # ------------------------------------------------------------ 下载

    def download_video(
        self,
        req: VideoDownloadRequest,
        cancel: threading.Event,
        on_progress: ProgressFn,
    ) -> Path:
        bvid, requested_index = self._target_of(req)
        credential = self.credential()

        async def prepare() -> tuple[bool, dict, list[dict], int, dict]:
            logged_in = await self._check_login(credential)
            handle = video.Video(bvid=bvid, credential=credential if logged_in else None)
            info = dict(await handle.get_info() or {})
            pages = list(info.get("pages") or [])
            if pages and requested_index >= len(pages):
                raise ValueError(f"请求第 {requested_index + 1} P，但视频只有 {len(pages)} P")
            index = max(0, requested_index)
            download_data = dict(await handle.get_download_url(page_index=index) or {})
            return logged_in, info, pages, index, download_data

        logged_in, info, pages, index, download_data = run_async(prepare)
        if cancel.is_set():
            raise DownloadCanceled("下载已取消")

        detector = video.VideoDownloadURLDataDetecter(download_data)
        is_flv = detector.check_flv_mp4_stream()
        max_height = int(req.max_height or 1080)
        try:
            streams = detector.detect_best_streams(
                video_max_quality=_max_quality(max_height),
                audio_max_quality=video.AudioQuality._192K,
                codecs=[video.VideoCodecs.AVC, video.VideoCodecs.HEV, video.VideoCodecs.AV1],
                no_hdr=max_height < 2160,
                no_dolby_video=max_height < 2160,
                # 杜比全景声/Hi-Res 都不是 AAC，塞进 m4a 后 DJ 软件基本读不了，
                # 而且没法 `-c:a copy`，统一关掉换取「一定能直出 m4a」。
                no_dolby_audio=True,
                no_hires=True,
            )
        except Exception as exc:
            raise RuntimeError(f"解析哔哩哔哩视频流失败：{exc}") from exc

        # detect_best_streams 的返回是「定长 2 元组语义」：[视频流, 音频流]，未命中的位置是 None。
        # 绝不能过滤掉 None 再按下标取——那样下标含义会错位，把音频流当成视频流下载。
        padded = list(streams) + [None, None]
        video_stream, audio_stream = padded[0], padded[1]
        if video_stream is not None and not getattr(video_stream, "url", None):
            video_stream = None
        if audio_stream is not None and not getattr(audio_stream, "url", None):
            audio_stream = None

        title = self._compose_title(info, pages, index, bvid)
        # 视频平铺在设置里指定的视频目录下，不再按 BV 号建子目录。
        # 只要音轨时反而回到音频那边的 bilibili/ 子目录——那是要进曲库的素材。
        output_dir = (
            self.ctx.platform_dir(self.platform)
            if req.audio_only
            else self.ctx.video_output_dir()
        )
        extension = "m4a" if req.audio_only else (self.ctx.video_format or "mp4")
        safe_stem = sanitize_filename_value(title, bvid)
        output_path = output_dir / finalize_filename(
            f"{safe_stem}.{extension}", output_dir, extension
        )

        # 每个任务一个独立的暂存目录：并发下载时不能互相删对方的 .partial。
        temp_dir = output_dir / f".partial-{bvid}-p{index + 1}-{uuid.uuid4().hex[:8]}"
        if temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)
        temp_dir.mkdir(parents=True)
        staged = temp_dir / f"output.{extension}"
        log_path = temp_dir / "ffmpeg.log"
        cookies = _cookie_jar(credential if logged_in else None)

        try:
            if req.audio_only:
                # DJ 最常用的路径：只要音轨。dash 直接拿音频流；flv 只有一路混合流，
                # 那就整段拉下来再让 ffmpeg 抽音频。
                source = audio_stream if (audio_stream is not None and not is_flv) else video_stream
                if source is None:
                    raise RuntimeError("哔哩哔哩没有返回可下载的音频流")
                source_path = temp_dir / ("source.flv" if is_flv else "audio.m4s")
                self._fetch_streams([(str(source.url), source_path)], cookies, cancel, on_progress)
                self._extract_audio(source_path, staged, log_path, cancel)
            else:
                if video_stream is None:
                    raise RuntimeError("哔哩哔哩没有返回可下载的视频流（该视频可能没有可用的画质档位）")
                if is_flv:
                    source_path = temp_dir / "source.flv"
                    self._fetch_streams([(str(video_stream.url), source_path)], cookies, cancel, on_progress)
                    inputs = [source_path]
                else:
                    video_path = temp_dir / "video.m4s"
                    plan = [(str(video_stream.url), video_path)]
                    audio_path = temp_dir / "audio.m4s"
                    if audio_stream is not None:
                        plan.append((str(audio_stream.url), audio_path))
                    self._fetch_streams(plan, cookies, cancel, on_progress)
                    inputs = [video_path] + ([audio_path] if audio_stream is not None else [])
                self._mux_video(inputs, staged, log_path, cancel, bool(req.transcode), max_height)

            # 校验通过后才原子替换到最终路径：ffmpeg 直接写目标文件的话，
            # 超时/失败会把上一次的成品截断成坏文件并永久留在磁盘上。
            if not staged.exists() or staged.stat().st_size <= 0:
                raise RuntimeError("FFmpeg 没有生成有效的输出文件")
            os.replace(staged, output_path)
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

        return output_path

    def _compose_title(self, info: dict, pages: list[dict], index: int, bvid: str) -> str:
        title = str(info.get("title") or bvid)
        if len(pages) > 1:
            page = pages[index] if index < len(pages) else {}
            part = str(page.get("part") or "").strip()
            title = f"{title} - P{index + 1}" + (f" - {part}" if part else "")
        return title

    def _fetch_streams(
        self,
        plan: list[tuple[str, Path]],
        cookies: dict[str, str],
        cancel: threading.Event,
        on_progress: ProgressFn,
    ) -> None:
        """把这次任务要下的所有流当成一条进度上报（video + audio 字节数累加）。"""
        for url, _ in plan:
            _ensure_media_url(url)
        timeout = httpx.Timeout(connect=30.0, read=300.0, write=30.0, pool=30.0)
        with httpx.Client(
            headers=DOWNLOAD_HEADERS, cookies=cookies, timeout=timeout, follow_redirects=True
        ) as client:
            sizes = [self._probe_size(client, url) for url, _ in plan]
            total = sum(sizes) if all(size > 0 for size in sizes) else 0
            done = 0
            on_progress(0, total)
            for url, destination in plan:
                done = self._download_stream(client, url, destination, cancel, on_progress, done, total)

    def _probe_size(self, client: httpx.Client, url: str) -> int:
        try:
            response = client.head(url)
            if response.status_code < 400:
                length = int(response.headers.get("content-length") or 0)
                if length > 0:
                    return length
        except Exception:
            pass
        try:
            # B 站 CDN 经常对 HEAD 返回 405，用 1 字节 Range 换 Content-Range 里的总长度。
            # 这里必须用 stream：万一对端忽略 Range 直接回 200，普通 get 会把整个视频读进内存。
            with client.stream("GET", url, headers={"Range": "bytes=0-0"}) as response:
                if response.status_code >= 400:
                    return 0
                content_range = response.headers.get("content-range") or ""
                if "/" in content_range:
                    tail = content_range.rsplit("/", 1)[1].strip()
                    if tail.isdigit():
                        return int(tail)
                if response.status_code == 200:
                    # Range 被忽略时 content-length 就是完整长度，别白白丢掉进度总量。
                    return int(response.headers.get("content-length") or 0)
        except Exception:
            pass
        return 0

    def _download_stream(
        self,
        client: httpx.Client,
        url: str,
        destination: Path,
        cancel: threading.Event,
        on_progress: ProgressFn,
        offset: int,
        total: int,
    ) -> int:
        written = offset
        last_report = 0.0

        def report() -> None:
            # 探测出来的总长度偏小时至少别让进度超过 100%；探测失败（total=0）就如实报未知。
            on_progress(written, max(total, written) if total > 0 else 0)

        with client.stream("GET", url) as response:
            response.raise_for_status()
            with destination.open("wb") as output:
                for chunk in response.iter_bytes(CHUNK_SIZE):
                    if cancel.is_set():
                        raise DownloadCanceled("下载已取消")
                    output.write(chunk)
                    written += len(chunk)
                    now = time.monotonic()
                    if now - last_report >= PROGRESS_INTERVAL:
                        last_report = now
                        report()
        report()
        return written

    def _extract_audio(
        self, source: Path, staged: Path, log_path: Path, cancel: threading.Event
    ) -> None:
        ffmpeg = _ffmpeg_binary()
        base = [ffmpeg, "-y", "-i", str(source), "-vn", "-map", "0:a:0"]
        try:
            _run_ffmpeg(base + ["-c:a", "copy", "-movflags", "+faststart", str(staged)], log_path, cancel)
            return
        except DownloadCanceled:
            raise
        except RuntimeError:
            # 源音轨不是 AAC（flv 里常见 mp3）时 m4a 容器装不下，退回重编码。
            staged.unlink(missing_ok=True)
        _run_ffmpeg(
            base + ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(staged)],
            log_path,
            cancel,
        )

    def _mux_video(
        self,
        inputs: list[Path],
        staged: Path,
        log_path: Path,
        cancel: threading.Event,
        transcode: bool,
        max_height: int,
    ) -> None:
        ffmpeg = _ffmpeg_binary()
        command: list[str] = [ffmpeg, "-y"]
        for item in inputs:
            command.extend(["-i", str(item)])
        command.extend(["-map", "0:v:0"])
        if len(inputs) > 1:
            command.extend(["-map", "1:a:0"])
        else:
            command.extend(["-map", "0:a:0?"])
        if transcode:
            command.extend(
                [
                    "-c:v",
                    "libx264",
                    "-preset",
                    TRANSCODE_PRESET,
                    "-crf",
                    str(TRANSCODE_CRF),
                    "-vf",
                    f"scale=-2:min({max_height}\\,ih)",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                ]
            )
        else:
            # 桌面端没有体积限制的必要，默认直接封装，比重编码快一个数量级。
            command.extend(["-c", "copy"])
        command.extend(["-movflags", "+faststart", str(staged)])
        _run_ffmpeg(command, log_path, cancel)
