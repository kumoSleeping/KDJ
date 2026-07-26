"""FastAPI 应用：全部 HTTP 路由 + 鉴权中间件 + WS hub。

路由一一对应 docs/00-architecture.md 第 2.2 / 2.3 节。

线程模型：
- 绝大多数路由写成同步 `def`，FastAPI 会自动丢到 anyio 线程池里跑。
  provider 的网络请求和 sqlite 查询都是阻塞的，写成 `async def` 会直接卡死事件循环，
  连 WS 心跳都发不出去。
- 扫描 / 分析 / 下载在各自的后台线程里跑，只通过 EventHub 往回报进度。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import secrets
import shutil
import subprocess
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any, Iterator

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import __version__
from .aggregate import interleave_sources, is_url, merge_results, split_intake_text
from .analysis.decode import decode_audio, ffmpeg_path
from .analysis.engine import analyze_file
from .config import AppConfig
from .downloader import DownloadManager, resolve_video
from .events import EventHub, Subscriber, encode_event
from .library.db import Database
from .library.folders import (
    FolderError,
    build_tree,
    create_folder,
    delete_folder,
    ensure_inside,
    infer_roots,
    init_manifests,
    link_file,
    move_file,
    move_folder,
    read_manifest,
    rename_folder,
    resolve_roots,
    write_manifest,
)
from .library.scan import scan_paths
from .library.service import LibraryService
from .models import (
    Account,
    AnalyzeRequest,
    AnalyzeResponse,
    DownloadRequest,
    DownloadTask,
    FolderCreateRequest,
    FolderDeleteRequest,
    FolderInitRequest,
    FolderMoveRequest,
    FolderOpRequest,
    FolderOpResult,
    FolderOrderRequest,
    FolderRenameRequest,
    FolderTree,
    HarmonicMatch,
    Health,
    IntakeItem,
    IntakeRequest,
    IntakeResponse,
    LibraryStats,
    MergedGroup,
    QrSession,
    QrState,
    ResolveRequest,
    ResolveResponse,
    ScanRequest,
    ScanResponse,
    SearchRequest,
    SearchResponse,
    Settings,
    SongSource,
    Track,
    TrackPage,
    TrackPatch,
    VideoDownloadRequest,
    VideoInfo,
)
from .providers.base import ProviderContext
from .providers.bilibili import BilibiliProvider
from .providers.netease import NeteaseProvider
from .providers.qqmusic import QQMusicProvider
from .providers.soundcloud import SoundCloudProvider
from .tagging import read_cover, write_analysis_tags

logger = logging.getLogger("kumodeck.app")

TOKEN_HEADER = "X-KumoDeck-Token"

# <audio src> / <img src> 发不出自定义请求头，这两个端点必须额外接受 ?token=
QUERY_TOKEN_PREFIXES = ("/api/library/audio/", "/api/library/cover/")

# 分析是 CPU 密集的（ffmpeg 解码 + numpy FFT），worker 开多了会把机器压满，
# 表现是 UI 掉帧、下载速度也跟着掉。固定 2 个。
ANALYSIS_WORKERS = 2

SEARCH_TIMEOUT = 25.0
# 波形：只用来画图，采样率和窗长按"够看"取，不按"够分析"取
WAVEFORM_SR = 16000
WAVEFORM_NFFT = 1024
WAVEFORM_HOP = 512
# Serato 的三色交叉点（社区实测）：红↔绿 ≈ 200 Hz，绿↔蓝 ≈ 1.5 kHz。
# 2.5 kHz 试过，人声段会被算成"高频"而发蓝，1.5 kHz 才把人声留在绿区。
WAVEFORM_XOVER_LOW = 200.0
WAVEFORM_XOVER_HIGH = 1500.0
# 高度 γ：>1 压低中等响度，让副歌和间奏拉开差距
WAVEFORM_AMP_GAMMA = 1.2
# 颜色 γ：作用在"频段占比 / 全曲常态占比"上。3 太淡、12 会糊成色块，6 刚好
WAVEFORM_COLOR_GAMMA = 6.0
# 暗通道的地板，避免出现纯红/纯蓝这种在深色底上刺眼的色
WAVEFORM_COLOR_FLOOR = 0.12
# 批量投喂：外层并发条数，以及单条（含它内部的多平台并发）的上限
INTAKE_WORKERS = 4
INTAKE_TIMEOUT = 90.0
STREAM_CHUNK = 256 * 1024

_AUDIO_MIME = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".aiff": "audio/aiff",
    ".aif": "audio/aiff",
    ".mp4": "video/mp4",
}


class _AnalyzeJob:
    """一次 analyze 请求的进度聚合器（多个 worker 线程并发上报）。"""

    def __init__(self, job_id: str, track_ids: list[int]) -> None:
        self.job_id = job_id
        self.track_ids = list(track_ids)
        self.total = len(self.track_ids)
        self.done = 0
        # 取消是**协作式**的：只在每首歌开始前检查一次。
        # 分析一首要几秒，中途硬杀线程会留下半写的数据库行，不值得。
        self.canceled = threading.Event()
        self._lock = threading.Lock()

    def step(self) -> int:
        with self._lock:
            self.done += 1
            return self.done

    def skip(self, count: int) -> int:
        """取消之后把剩下的一次性记完，好让进度条走到头而不是停在半路。"""
        with self._lock:
            self.done += count
            return self.done


def _build_providers(ctx: ProviderContext) -> dict[str, Any]:
    """逐个构造 provider；单个 provider 起不来不能把整个 sidecar 拖垮
    （比如某平台的 SDK 在当前系统上初始化失败，用户至少还能用曲库）。"""
    providers: dict[str, Any] = {}
    for cls in (NeteaseProvider, QQMusicProvider, SoundCloudProvider, BilibiliProvider):
        try:
            instance = cls(ctx)  # type: ignore[call-arg]
            providers[instance.platform] = instance
        except Exception as exc:  # noqa: BLE001
            logger.error("provider %s 初始化失败：%s", cls.__name__, exc)
    return providers


def _parse_range(header: str, size: int) -> tuple[int, int] | None:
    """解析 `Range: bytes=start-end`，返回闭区间；不合法返回 None。"""
    value = (header or "").strip().lower()
    if not value.startswith("bytes="):
        return None
    spec = value[6:].split(",")[0].strip()
    start_text, _, end_text = spec.partition("-")
    try:
        if start_text:
            start = int(start_text)
            end = int(end_text) if end_text else size - 1
        else:
            # `bytes=-500` = 最后 500 字节
            if not end_text:
                return None
            length = int(end_text)
            if length <= 0:
                return None
            start = max(0, size - length)
            end = size - 1
    except ValueError:
        return None
    if start >= size or start < 0 or end < start:
        return None
    return start, min(end, size - 1)


def _iter_file(path: Path, start: int, end: int) -> Iterator[bytes]:
    remaining = end - start + 1
    with path.open("rb") as handle:
        handle.seek(start)
        while remaining > 0:
            chunk = handle.read(min(STREAM_CHUNK, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


# 这些后缀是视频容器：播放时不给 <audio> 塞整个视频文件（mkv 根本放不了），
# 先用 ffmpeg 把音轨抽出来缓存成 m4a，再按普通音频伺服。
VIDEO_SUFFIXES = frozenset({".mp4", ".m4v", ".mov", ".webm", ".mkv"})


def _extracted_audio(path: Path, track_id: int, cache_dir: Path) -> Path:
    """视频文件 → 音轨 m4a 缓存。remux（流拷贝）优先，编码不兼容再转码 AAC。

    缓存键带 mtime：文件被替换后旧缓存自动失效。半成品写 .partial 名，
    ffmpeg 中断不会留下能被下次请求误用的坏文件（对应 V-11 的写盘纪律）。
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    mtime = int(path.stat().st_mtime)
    target = cache_dir / f"{track_id}-{mtime}.m4a"
    if target.is_file() and target.stat().st_size > 0:
        return target

    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        raise HTTPException(status_code=500, detail="系统里没有 ffmpeg，视频音轨播放不了")
    tmp = cache_dir / f"{track_id}-{mtime}.partial.m4a"
    # webm/mkv 里常见 opus/vorbis，塞不进 m4a 容器，copy 会失败 → 第二轮转码
    for codec_args in (("-c:a", "copy"), ("-c:a", "aac", "-b:a", "192k")):
        cmd = [
            ffmpeg, "-y", "-v", "error", "-i", str(path), "-vn",
            *codec_args, "-movflags", "+faststart", str(tmp),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=300, check=False)
        except subprocess.TimeoutExpired:
            break
        if proc.returncode == 0 and tmp.is_file() and tmp.stat().st_size > 0:
            os.replace(tmp, target)
            return target
    tmp.unlink(missing_ok=True)
    raise HTTPException(status_code=422, detail="抽不出音轨（文件可能损坏或没有音频流）")


def _audio_response(path: Path, request: Request) -> Response:
    """带 Range 支持的音频流。

    不做 206 的话，Chrome 的 <audio> 拿不到 Accept-Ranges，
    拖动进度条会直接从头重下（大 flac 上表现为"拖不动"）。
    """
    size = path.stat().st_size
    media_type = _AUDIO_MIME.get(path.suffix.lower(), "application/octet-stream")
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}

    range_header = request.headers.get("range", "")
    if not range_header:
        headers["Content-Length"] = str(size)
        return StreamingResponse(
            _iter_file(path, 0, size - 1), media_type=media_type, headers=headers
        )

    span = _parse_range(range_header, size)
    if span is None:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"},
        )
    start, end = span
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(end - start + 1)
    return StreamingResponse(
        _iter_file(path, start, end),
        status_code=206,
        media_type=media_type,
        headers=headers,
    )


def create_app(config: AppConfig) -> FastAPI:  # noqa: C901 - 路由集中注册，拆开反而更难读
    hub = EventHub()
    database = Database(config.db_path)
    database.init_schema()
    library = LibraryService(database)

    provider_ctx = ProviderContext(
        data_dir=config.data_dir,
        download_dir=config.download_dir,
        filename_template=config.filename_template,
        default_quality=config.default_quality,
        netease_use_download_api=config.netease_use_download_api,
        soundcloud_enabled=config.soundcloud_enabled,
        video_dir=config.video_dir,
        video_format=config.video_format,
    )
    providers = _build_providers(provider_ctx)

    analysis_pool = ThreadPoolExecutor(
        max_workers=ANALYSIS_WORKERS, thread_name_prefix="kd-analyze"
    )
    # 插队用的单线程池。正在放的那首必须马上出 BPM/调号——它排在几百首后面
    # 等十分钟是没用的。单独一条线程而不是给主池加优先级：
    # ThreadPoolExecutor 没有优先级队列，另起一条最省事，也天然不会被批量饿死。
    priority_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kd-analyze-now")

    # 下载完成后是否分析：DownloadRequest.analyze 可以覆盖全局设置，
    # 但 enqueue_audio 的签名里没有这个参数，所以按 task_id 记在这里。
    analyze_pref: dict[str, bool] = {}
    pref_lock = threading.Lock()

    # 混合搜索要标 in_library，逐组查库太慢，缓存一份 "platform:key" 集合。
    index_state: dict[str, Any] = {"stamp": 0.0, "keys": frozenset()}
    index_lock = threading.Lock()

    def invalidate_index() -> None:
        with index_lock:
            index_state["stamp"] = 0.0

    def library_source_keys() -> frozenset[str]:
        with index_lock:
            stamp = index_state["stamp"]
            if stamp and time.monotonic() - stamp < 5.0:
                return index_state["keys"]  # type: ignore[return-value]
        try:
            rows = database.connect().execute(
                "SELECT source_platform, source_key FROM tracks "
                "WHERE source_key IS NOT NULL AND source_key <> ''"
            ).fetchall()
            keys = frozenset(f"{row['source_platform']}:{row['source_key']}" for row in rows)
        except Exception:  # noqa: BLE001 - 标记失败只影响一个 UI 角标
            logger.exception("读取曲库来源索引失败")
            keys = frozenset()
        with index_lock:
            index_state["keys"] = keys
            index_state["stamp"] = time.monotonic()
        return keys

    # ------------------------------------------------------------ 分析

    # 正在跑的分析任务，供「停止分析」用。只留最近一个：
    # UI 上也只有一个进度条，同时跑两批分析没有意义。
    current_analysis: dict[str, _AnalyzeJob] = {}

    def analyze_one(job: _AnalyzeJob, track_id: int) -> None:
        if job.canceled.is_set():
            # 已取消：直接记数走人。线程池里排队的任务撤不掉，只能让它们空转一遍。
            done = job.skip(1)
            if done >= job.total:
                current_analysis.pop(job.job_id, None)
                invalidate_index()
                hub.publish("library.updated", {"track_ids": job.track_ids})
                hub.publish(
                    "analyze.progress",
                    {
                        "job_id": job.job_id,
                        "done": job.total,
                        "total": job.total,
                        "current": "",
                        "track_id": None,
                    },
                )
            return
        track = library.get(track_id)
        current = track.filename if track else str(track_id)
        if track is not None:
            try:
                result = analyze_file(
                    Path(track.path), duration_limit=float(config.analysis_duration)
                )
                library.save_analysis(track_id, result)
                if config.write_tags_after_analyze:
                    fresh = library.get(track_id) or track
                    write_analysis_tags(
                        Path(fresh.path),
                        bpm=fresh.bpm,
                        camelot=fresh.camelot,
                        music_key=fresh.music_key,
                        energy=fresh.energy,
                        comment=fresh.comment,
                    )
            except Exception as exc:  # noqa: BLE001 - 单曲分析失败不影响整批
                logger.exception("分析失败：%s", track.path)
                hub.publish_toast("warn", f"分析失败：{current} —— {exc}")
        done = job.step()
        hub.publish(
            "analyze.progress",
            {
                "job_id": job.job_id,
                "done": done,
                "total": job.total,
                "current": current,
                "track_id": track_id,
            },
        )
        if done >= job.total:
            current_analysis.pop(job.job_id, None)
            invalidate_index()
            # 整批结束才发一次 library.updated：逐条发的话，
            # 分析一千首会让前端刷一千次列表。单曲刷新可以靠 analyze.progress.track_id。
            hub.publish("library.updated", {"track_ids": job.track_ids})

    def queue_analysis(
        track_ids: list[int], job_id: str | None = None, *, priority: bool = False
    ) -> tuple[str, int]:
        job_id = job_id or uuid.uuid4().hex[:12]
        job = _AnalyzeJob(job_id, track_ids)
        if not track_ids:
            hub.publish(
                "analyze.progress",
                {"job_id": job_id, "done": 0, "total": 0, "current": "", "track_id": None},
            )
            return job_id, 0
        # 插队任务不登记进 current_analysis：它只有一首，
        # 「停止分析」要停的是那批几百首的，不该把插队的也一起掐了。
        pool = priority_pool if priority else analysis_pool
        if not priority:
            current_analysis[job_id] = job
        for track_id in track_ids:
            pool.submit(analyze_one, job, track_id)
        return job_id, job.total

    # ------------------------------------------------------------ 下载完成回调

    def on_download_finished(task_id: str, path: Path, source: SongSource | None) -> None:
        try:
            track_id = library.upsert_file(
                path,
                source_platform=source.platform if source else "local",
                source_key=source.key if source else "",
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("下载完成入库失败：%s", path)
            hub.publish_toast("warn", f"入库失败：{path.name} —— {exc}")
            return
        manager.set_track_id(task_id, track_id)
        invalidate_index()
        hub.publish("library.updated", {"track_ids": [track_id]})
        with pref_lock:
            wants = analyze_pref.pop(task_id, None)
        if wants if wants is not None else config.auto_analyze:
            queue_analysis(library.pending_analysis_ids([track_id], False))

    manager = DownloadManager(providers, config, hub, on_download_finished)

    # ------------------------------------------------------------ 扫描

    def run_scan(job_id: str, paths: list[str], recursive: bool, analyze: bool) -> None:
        def on_progress(done: int, total: int, current: str) -> None:
            hub.publish(
                "scan.progress",
                {
                    "job_id": job_id,
                    "done": done,
                    "total": total,
                    "current": current,
                    # 遍历阶段还不知道总数，total<=0 就当作还在 walk。
                    "phase": "walk" if total <= 0 else "tag",
                },
            )

        try:
            track_ids = scan_paths(library, paths, recursive, on_progress)
        except Exception as exc:  # noqa: BLE001
            logger.exception("扫描失败")
            hub.publish_toast("error", f"扫描失败：{exc}")
            hub.publish(
                "scan.progress",
                {"job_id": job_id, "done": 0, "total": 0, "current": "", "phase": "done"},
            )
            return
        total = len(track_ids)
        hub.publish(
            "scan.progress",
            {"job_id": job_id, "done": total, "total": total, "current": "", "phase": "done"},
        )
        invalidate_index()
        hub.publish("library.updated", {"track_ids": track_ids})
        hub.publish_toast("info", f"扫描完成，共 {total} 首")
        if analyze and track_ids:
            queue_analysis(library.pending_analysis_ids(track_ids, False))

    # ------------------------------------------------------------ 生命周期

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        # EventHub 必须在这里拿到"正在跑的"那个事件循环——工作线程要靠它
        # 做 call_soon_threadsafe，在 uvicorn 起循环之前去猜一定是错的。
        hub.set_loop(asyncio.get_running_loop())
        logger.info("sidecar 启动：data_dir=%s download_dir=%s", config.data_dir, config.download_dir)
        try:
            yield
        finally:
            hub.set_loop(None)
            manager.shutdown()
            analysis_pool.shutdown(wait=False)
            priority_pool.shutdown(wait=False)
            database.close_all()

    app = FastAPI(title="KumoDeck sidecar", version=__version__, lifespan=lifespan)

    # ------------------------------------------------------------ 鉴权

    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):  # noqa: ANN001
        path = request.url.path
        if request.method == "OPTIONS" or path == "/api/health":
            return await call_next(request)
        supplied = request.headers.get(TOKEN_HEADER, "")
        if not supplied and path.startswith(QUERY_TOKEN_PREFIXES):
            supplied = request.query_params.get("token", "")
        # compare_digest 而不是 ==：token 是长期有效的，别给旁路计时留口子。
        if not secrets.compare_digest(supplied, config.token):
            return JSONResponse({"detail": "未授权：缺少或错误的访问令牌"}, status_code=401)
        return await call_next(request)

    # CORS 必须最后加（Starlette 里后加的在最外层），这样浏览器的预检请求
    # 在进鉴权之前就被应答——预检不带自定义头，否则必然 401。
    # 只监听 127.0.0.1 且强制 token，放开 origin 不构成额外暴露面。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
    )

    # ------------------------------------------------------------ 异常

    def _error_response(request: Request, exc: Exception, status: int) -> JSONResponse:
        logger.error(
            "%s %s -> %s\n%s",
            request.method,
            request.url.path,
            status,
            "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
        )
        return JSONResponse({"detail": str(exc) or type(exc).__name__}, status_code=status)

    async def handle_value_error(request: Request, exc: Exception):  # noqa: ANN201
        return _error_response(request, exc, 400)

    async def handle_not_found(request: Request, exc: Exception):  # noqa: ANN201
        return _error_response(request, exc, 404)

    async def handle_permission(request: Request, exc: Exception):  # noqa: ANN201
        return _error_response(request, exc, 403)

    async def handle_unexpected(request: Request, exc: Exception):  # noqa: ANN201
        return _error_response(request, exc, 500)

    app.add_exception_handler(ValueError, handle_value_error)
    app.add_exception_handler(FileNotFoundError, handle_not_found)
    app.add_exception_handler(PermissionError, handle_permission)
    app.add_exception_handler(Exception, handle_unexpected)

    # ------------------------------------------------------------ 基础

    @app.get("/api/health", response_model=Health)
    def health() -> Health:
        return Health(
            ok=True,
            version=__version__,
            ffmpeg=shutil.which("ffmpeg") is not None,
            data_dir=str(config.data_dir),
            download_dir=str(config.download_dir),
        )

    @app.get("/api/settings", response_model=Settings)
    def get_settings() -> Settings:
        return config.to_settings()

    @app.put("/api/settings", response_model=Settings)
    def put_settings(payload: Settings) -> Settings:
        settings = config.apply_settings(payload)
        # provider 共享同一个 ProviderContext 实例，改字段即可全部生效。
        provider_ctx.download_dir = config.download_dir
        provider_ctx.filename_template = config.filename_template
        provider_ctx.default_quality = config.default_quality
        provider_ctx.netease_use_download_api = config.netease_use_download_api
        provider_ctx.soundcloud_enabled = config.soundcloud_enabled
        provider_ctx.video_dir = config.video_dir
        provider_ctx.video_format = config.video_format
        manager.set_concurrency(config.concurrent_downloads)
        # 「自动下载」开关拨开的那一刻，把攒着的排队任务全放行——
        # 开关本身就是"现在开始下"的动作，不必再多一个开始按钮。
        if config.auto_start_downloads:
            manager.release_pending()
        return settings

    # ------------------------------------------------------------ 账号

    def _provider_or_404(platform: str) -> Any:
        provider = providers.get(platform)
        if provider is None:
            raise HTTPException(status_code=404, detail=f"平台不可用：{platform}")
        return provider

    @app.get("/api/accounts", response_model=list[Account])
    def list_accounts() -> list[Account]:
        accounts: list[Account] = []
        for platform in ("wyy", "qqm", "soundcloud", "bilibili"):
            provider = providers.get(platform)
            if provider is None:
                continue
            try:
                accounts.append(provider.account())
            except Exception as exc:  # noqa: BLE001 - 一个平台挂了不能让整页空白
                logger.warning("读取 %s 账号状态失败：%s", platform, exc)
                accounts.append(
                    Account(
                        platform=platform,  # type: ignore[arg-type]
                        label=getattr(provider, "label", platform),
                        state="unknown",
                        detail=str(exc),
                    )
                )
        return accounts

    @app.post("/api/accounts/{platform}/login/qr", response_model=QrSession)
    def login_qr(platform: str) -> QrSession:
        provider = _provider_or_404(platform)
        session_id, image, url = provider.create_qr()
        return QrSession(
            platform=platform,  # type: ignore[arg-type]
            session_id=session_id,
            image=image,
            url=url,
        )

    @app.get("/api/accounts/{platform}/login/qr/{session_id}", response_model=QrState)
    def login_qr_state(platform: str, session_id: str) -> QrState:
        provider = _provider_or_404(platform)
        state, message = provider.poll_qr(session_id)
        account: Account | None = None
        if state == "done":
            with suppress(Exception):
                account = provider.account()
            if account is not None:
                hub.publish("account.changed", account)
        return QrState(session_id=session_id, state=state, message=message, account=account)

    @app.post("/api/accounts/{platform}/logout", response_model=Account)
    def logout(platform: str) -> Account:
        provider = _provider_or_404(platform)
        provider.logout()
        account = provider.account()
        hub.publish("account.changed", account)
        return account

    # ------------------------------------------------------------ 搜索

    @app.post("/api/search", response_model=SearchResponse)
    def search(payload: SearchRequest) -> SearchResponse:
        return _search_core(payload)

    def _search_core(payload: SearchRequest) -> SearchResponse:
        """搜索的实现主体。/api/search 和 /api/intake 都走它，避免两份逻辑漂移。"""
        started = time.monotonic()
        errors: dict[str, str] = {}
        targets: list[tuple[str, Any]] = []
        for platform in dict.fromkeys(payload.platforms):
            if platform == "local":
                continue
            if platform == "soundcloud" and not config.soundcloud_enabled:
                errors[platform] = "SoundCloud 未在设置中启用"
                continue
            provider = providers.get(platform)
            if provider is None:
                errors[platform] = "平台不可用"
                continue
            targets.append((platform, provider))

        per_platform: dict[str, list[SongSource]] = {}
        if targets:
            # 各平台并发搜；不用 with 语句，因为退出时会 join 所有线程——
            # 某个平台卡住会把整个请求一起拖死。
            pool = ThreadPoolExecutor(max_workers=len(targets), thread_name_prefix="kd-search")
            try:
                futures = {
                    name: pool.submit(provider.search, payload.query, payload.limit)
                    for name, provider in targets
                }
                for name, future in futures.items():
                    try:
                        per_platform[name] = list(future.result(timeout=SEARCH_TIMEOUT) or [])
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("搜索 %s 失败：%s", name, exc)
                        errors[name] = str(exc) or type(exc).__name__
            finally:
                pool.shutdown(wait=False)

        if payload.merge:
            # platforms 的顺序就是用户拖出来的优先级：决定同一首歌默认从哪家下
            groups = merge_results(payload.query, per_platform, payload.platforms)
        else:
            groups = _singleton_groups(per_platform, payload.platforms)

        known = library_source_keys()
        for group in groups:
            group.in_library = any(f"{s.platform}:{s.key}" in known for s in group.sources)

        return SearchResponse(
            query=payload.query,
            groups=groups,
            per_platform=per_platform,
            errors=errors,
            elapsed_ms=round((time.monotonic() - started) * 1000, 1),
        )

    def _resolve_core(url: str, limit: int) -> tuple[ResolveResponse | None, str]:
        """逐个平台试解析。返回 (结果, 最后一次错误)，结果为 None 表示没人认得这个链接。"""
        last_error = ""
        for platform in ("wyy", "qqm", "soundcloud"):
            provider = providers.get(platform)
            if provider is None:
                continue
            try:
                result = provider.resolve(url, limit)
            except Exception as exc:  # noqa: BLE001 - 换下一个平台继续试
                logger.warning("解析 %s 失败：%s", platform, exc)
                last_error = str(exc)
                continue
            if result is not None:
                return result, last_error
        return None, last_error

    @app.post("/api/resolve", response_model=ResolveResponse)
    def resolve(payload: ResolveRequest) -> ResolveResponse:
        url = (payload.url or "").strip()
        if not url:
            raise HTTPException(status_code=400, detail="链接不能为空")
        result, last_error = _resolve_core(url, payload.limit)
        if result is not None:
            return result
        raise HTTPException(
            status_code=400,
            detail=f"无法识别的链接{'：' + last_error if last_error else ''}",
        )

    @app.post("/api/intake", response_model=IntakeResponse)
    def intake(payload: IntakeRequest) -> IntakeResponse:
        """把一大段粘贴文本变成一批结果：链接去解析，其余的去搜索。

        每条独立成 IntakeItem，前端按"包含关系"渲染——歌单是一个可折叠的包，
        关键词搜索是一组候选。这样批量下歌单和批量搜歌是同一套交互。
        """
        started = time.monotonic()
        entries, skipped = split_intake_text(payload.text, max_entries=payload.max_entries)
        if not entries:
            raise HTTPException(status_code=400, detail="没有解析出任何关键词或链接")

        known = library_source_keys()

        def handle(entry: str) -> IntakeItem:
            if is_url(entry):
                try:
                    result, last_error = _resolve_core(entry, 500)
                except Exception as exc:  # noqa: BLE001 - 单条失败不能拖垮整批
                    return IntakeItem(entry=entry, kind="error", error=str(exc))
                if result is None:
                    return IntakeItem(
                        entry=entry,
                        kind="error",
                        error=f"无法识别的链接{'：' + last_error if last_error else ''}",
                    )
                groups = _singleton_groups({result.platform: list(result.sources)})
                return IntakeItem(
                    entry=entry,
                    kind=result.kind,
                    platform=result.platform,
                    title=result.title,
                    groups=groups,
                )
            try:
                response = _search_core(
                    SearchRequest(
                        query=entry,
                        platforms=list(payload.platforms),
                        limit=payload.limit,
                        merge=payload.merge,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                return IntakeItem(entry=entry, kind="error", error=str(exc))
            return IntakeItem(
                entry=entry,
                kind="search",
                title=entry,
                groups=response.groups,
                errors=response.errors,
            )

        # 并发但收着点：每条 entry 自己还会再并发打各平台，
        # 外层再开大就等于对平台接口发起几十路并发，非常容易被限流。
        items: list[IntakeItem] = []
        if len(entries) == 1:
            items = [handle(entries[0])]
        else:
            pool = ThreadPoolExecutor(
                max_workers=min(INTAKE_WORKERS, len(entries)), thread_name_prefix="kd-intake"
            )
            try:
                futures = [pool.submit(handle, entry) for entry in entries]
                for entry, future in zip(entries, futures):
                    try:
                        items.append(future.result(timeout=INTAKE_TIMEOUT))
                    except Exception as exc:  # noqa: BLE001
                        items.append(IntakeItem(entry=entry, kind="error", error=str(exc)))
            finally:
                pool.shutdown(wait=False)

        for item in items:
            for group in item.groups:
                group.in_library = any(f"{s.platform}:{s.key}" in known for s in group.sources)

        return IntakeResponse(
            items=items,
            skipped=skipped,
            elapsed_ms=round((time.monotonic() - started) * 1000, 1),
        )

    # ------------------------------------------------------------ 下载

    @app.get("/api/downloads", response_model=list[DownloadTask])
    def list_downloads() -> list[DownloadTask]:
        return manager.snapshot()

    @app.post("/api/downloads", response_model=list[DownloadTask])
    def create_downloads(payload: DownloadRequest) -> list[DownloadTask]:
        if not payload.sources:
            raise HTTPException(status_code=400, detail="没有要下载的曲目")
        tasks = manager.enqueue_audio(payload.sources, payload.quality)
        if payload.analyze is not None:
            with pref_lock:
                for task in tasks:
                    analyze_pref[task.id] = bool(payload.analyze)
        return tasks

    @app.post("/api/downloads/{task_id}/cancel", response_model=DownloadTask)
    def cancel_download(task_id: str) -> DownloadTask:
        task = manager.cancel(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        return task

    @app.post("/api/downloads/clear")
    def clear_downloads() -> dict[str, int]:
        return {"removed": manager.clear_finished()}

    # ------------------------------------------------------------ 视频

    @app.post("/api/video/resolve", response_model=VideoInfo)
    def video_resolve(payload: ResolveRequest) -> VideoInfo:
        provider = _provider_or_404("bilibili")
        url = (payload.url or "").strip()
        if not url:
            raise HTTPException(status_code=400, detail="链接不能为空")
        return resolve_video(provider, url)

    @app.post("/api/video/download", response_model=DownloadTask)
    def video_download(payload: VideoDownloadRequest) -> DownloadTask:
        provider = _provider_or_404("bilibili")
        if not (payload.url or payload.bvid):
            raise HTTPException(status_code=400, detail="缺少视频链接或 BV 号")
        request = payload.model_copy(deep=True)
        # 前端没显式给画质/转码时跟随全局设置。
        if request.max_height <= 0:
            request.max_height = config.video_max_height
        if not request.transcode:
            request.transcode = config.video_transcode
        return manager.enqueue_video(request, provider)

    # ------------------------------------------------------------ 曲库

    @app.get("/api/library/tracks", response_model=TrackPage)
    def library_tracks(
        q: str = "",
        key: str = "",
        bpm_min: float | None = None,
        bpm_max: float | None = None,
        energy_min: int | None = None,
        analyzed: bool | None = None,
        folder: str = "",
        folder_deep: bool = False,
        sort: str = "added_at",
        order: str = "desc",
        limit: int = 200,
        offset: int = 0,
    ) -> TrackPage:
        return library.list_tracks(
            q=q,
            key=key,
            bpm_min=bpm_min,
            bpm_max=bpm_max,
            energy_min=energy_min,
            analyzed=analyzed,
            folder=folder,
            folder_deep=folder_deep,
            sort=sort,
            order=order,
            limit=max(1, min(limit, 1000)),
            offset=max(0, offset),
        )

    @app.get("/api/library/tracks/{track_id}", response_model=Track)
    def library_track(track_id: int) -> Track:
        track = library.get(track_id)
        if track is None:
            raise HTTPException(status_code=404, detail="曲目不存在")
        return track

    @app.patch("/api/library/tracks/{track_id}", response_model=Track)
    def library_patch(track_id: int, payload: TrackPatch) -> Track:
        track = library.patch(track_id, payload)
        hub.publish("library.updated", {"track_ids": [track_id]})
        return track

    @app.delete("/api/library/tracks/{track_id}")
    def library_delete(track_id: int, delete_file: bool = False) -> dict[str, bool]:
        ok = library.delete(track_id, delete_file)
        if not ok:
            raise HTTPException(status_code=404, detail="曲目不存在")
        invalidate_index()
        hub.publish("library.updated", {"track_ids": [track_id]})
        return {"ok": True}

    # -------------------------------------------------------- 文件夹模式
    #
    # 全部落到真实文件系统上，不是数据库里的虚拟分组：DJ 出场前要把一套歌
    # 拷进 U 盘、要拿 Rekordbox 再读一遍，虚拟分组到那一步就没了。

    def _adopt_inferred_roots() -> None:
        """library_dirs 为空但库里已经有歌时，反推一个根目录并写回设置。

        针对的是文件夹模式上线之前扫过歌的库：不补这一下，那些人打开曲库
        看到的是"还没有曲库目录"，而歌就在列表里摆着，只能自己再扫一遍。
        只在为空时做一次，之后用户在设置里怎么改都不会被覆盖。
        """
        if config.library_dirs:
            return
        inferred = infer_roots(library.all_paths())
        if not inferred:
            return
        settings = config.to_settings()
        settings.library_dirs = [str(path) for path in inferred]
        config.apply_settings(settings)
        logger.info("从已入库路径反推曲库根目录：%s", settings.library_dirs)

    def _roots() -> list[Path]:
        _adopt_inferred_roots()
        roots = resolve_roots(list(config.library_dirs))
        if not roots:
            raise HTTPException(status_code=400, detail="还没有配置曲库目录，去设置里加一个")
        return roots

    @app.get("/api/library/folders", response_model=FolderTree)
    def library_folders() -> FolderTree:
        _adopt_inferred_roots()
        return build_tree(list(config.library_dirs), library.all_paths())

    @app.post("/api/library/folders/create", response_model=FolderTree)
    def library_folder_create(payload: FolderCreateRequest) -> FolderTree:
        try:
            create_folder(payload.parent, payload.name, _roots())
        except FolderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"建不了文件夹：{exc}") from exc
        return build_tree(list(config.library_dirs), library.all_paths())

    @app.post("/api/library/folders/rename", response_model=FolderTree)
    def library_folder_rename(payload: FolderRenameRequest) -> FolderTree:
        roots = _roots()
        try:
            old = ensure_inside(payload.path, roots)
            new = rename_folder(payload.path, payload.name, roots)
        except FolderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"改不了名：{exc}") from exc
        # 目录一改名，它下面每一首歌的 path 都失效了，必须整枝跟着改；
        # 漏掉这步的话曲库里全是"文件已丢失"。
        moved = library.rebase_paths(old, new)
        invalidate_index()
        hub.publish("library.updated", {"track_ids": moved})
        return build_tree(list(config.library_dirs), library.all_paths())

    @app.post("/api/library/folders/delete", response_model=FolderTree)
    def library_folder_delete(payload: FolderDeleteRequest) -> FolderTree:
        try:
            delete_folder(payload.path, _roots())
        except FolderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return build_tree(list(config.library_dirs), library.all_paths())

    @app.post("/api/library/folders/init", response_model=FolderTree)
    def library_folder_init(payload: FolderInitRequest) -> FolderTree:
        """初始化：给目录树每一层写上 .kumodeck.json，顺序从此可调、可跟着文件夹搬走。"""
        roots = _roots()
        targets = [ensure_inside(payload.path, roots)] if payload.path else roots
        created = 0
        try:
            for target in targets:
                created += init_manifests(target, roots)
        except FolderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        logger.info("初始化文件夹清单：新建 %d 份", created)
        return build_tree(list(config.library_dirs), library.all_paths())

    @app.post("/api/library/folders/move", response_model=FolderTree)
    def library_folder_move(payload: FolderMoveRequest) -> FolderTree:
        roots = _roots()
        try:
            old, new = move_folder(payload.path, payload.dest_parent, roots)
        except FolderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"搬不动：{exc}") from exc
        # 和改名同理：整枝的 path 都要跟着改，否则曲库里全是"文件已丢失"
        moved = library.rebase_paths(old, new) if old != new else []
        if moved:
            invalidate_index()
            hub.publish("library.updated", {"track_ids": moved})
        return build_tree(list(config.library_dirs), library.all_paths())

    @app.post("/api/library/folders/order", response_model=FolderTree)
    def library_folder_order(payload: FolderOrderRequest) -> FolderTree:
        roots = _roots()
        try:
            target = ensure_inside(payload.path, roots)
        except FolderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not target.is_dir():
            raise HTTPException(status_code=400, detail="文件夹不存在")
        # 合并写：同一份清单里既有子目录名（文件夹树的顺序）也有文件名（曲目手排）。
        # 拖文件夹时提交的是目录名、拖曲目时提交的是文件名——直接整份覆盖会把
        # 另一类的顺序抹掉。规则：没被这次提交涉及的名字按原相对顺序放前面。
        # 目录和文件从不在同一个列表里渲染，两类之间的先后无所谓。
        submitted = [name for name in payload.names if name]
        submitted_set = set(submitted)
        kept = [
            name
            for name in (read_manifest(target).get("order") or [])
            if isinstance(name, str) and name not in submitted_set
        ]
        write_manifest(target, kept + submitted)
        return build_tree(list(config.library_dirs), library.all_paths())

    @app.post("/api/library/folders/apply", response_model=FolderOpResult)
    def library_folder_apply(payload: FolderOpRequest) -> FolderOpResult:
        """把选中的曲目移动 / 链接到目标文件夹。

        link 用硬链接：同一份数据两个路径，一首歌同时进两个 set 不多占空间。
        跨卷或文件系统不支持时 folders.link_file 会自己退到符号链接、再退到复制。
        """
        try:
            dest = ensure_inside(payload.dest, _roots())
        except FolderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not dest.is_dir():
            raise HTTPException(status_code=400, detail="目标不是文件夹")

        touched: list[int] = []
        methods: dict[str, int] = {}
        errors: dict[str, str] = {}
        for track_id in payload.track_ids:
            track = library.get(track_id)
            if track is None:
                errors[str(track_id)] = "曲目不存在"
                continue
            source = Path(track.path)
            if not source.is_file():
                errors[str(track_id)] = "文件已丢失"
                continue
            if source.parent == dest:
                continue  # 拖回原地：静默跳过，不算错误
            try:
                if payload.op == "move":
                    target = move_file(source, dest)
                    library.relocate(track_id, target)
                    touched.append(track_id)
                    methods["move"] = methods.get("move", 0) + 1
                else:
                    target, method = link_file(source, dest)
                    new_id = library.upsert_file(target, source_platform=track.source_platform)
                    # 链接的两端是同一份音频，分析结果直接抄过去，不用再等一次分析
                    library.clone_metadata(track_id, new_id)
                    touched.append(new_id)
                    methods[method] = methods.get(method, 0) + 1
            except (OSError, FolderError) as exc:
                errors[str(track_id)] = str(exc)

        if touched:
            invalidate_index()
            hub.publish("library.updated", {"track_ids": touched})
        return FolderOpResult(track_ids=touched, op=payload.op, methods=methods, errors=errors)

    @app.post("/api/library/scan", response_model=ScanResponse)
    def library_scan(payload: ScanRequest) -> ScanResponse:
        paths = [p for p in (payload.paths or []) if str(p).strip()]
        if not paths:
            paths = list(config.library_dirs)
        if not paths:
            raise HTTPException(status_code=400, detail="没有可扫描的目录")
        # 显式扫描过的目录自动登记成曲库根目录。
        # 不这么做的话，用户点「扫描目录」加进来的歌在文件夹树里一个都看不见
        # （树只认 library_dirs），还得再去设置里把同一个目录加一遍。
        #
        # 但**已经在某个根下面的子目录不再登记**：文件夹树里点一个子目录就会触发
        # 一次扫描（未入库的自动导入），如果每次都登记，那个子目录会同时以
        # "根"和"djay 的子节点"两个身份出现在树上，看着像凭空多出来一份。
        settings = config.to_settings()
        existing = resolve_roots(settings.library_dirs)
        merged = list(settings.library_dirs)
        for item in paths:
            candidate = Path(item).expanduser()
            if not candidate.is_dir():
                continue
            try:
                ensure_inside(candidate, existing)
                continue  # 已经在某个根里，不用再登记
            except FolderError:
                pass
            normalized = str(candidate)
            if normalized not in merged:
                merged.append(normalized)
                existing = resolve_roots(merged)
        if merged != settings.library_dirs:
            settings.library_dirs = merged
            config.apply_settings(settings)
        job_id = uuid.uuid4().hex[:12]
        # 立刻返回，真实数量走 scan.progress / library.updated——
        # 遍历大目录要几十秒，同步等会把 HTTP 请求拖超时。
        threading.Thread(
            target=run_scan,
            args=(job_id, paths, payload.recursive, payload.analyze),
            name=f"kd-scan-{job_id}",
            daemon=True,
        ).start()
        return ScanResponse(job_id=job_id, found=0)

    @app.post("/api/library/analyze", response_model=AnalyzeResponse)
    def library_analyze(payload: AnalyzeRequest) -> AnalyzeResponse:
        track_ids = library.pending_analysis_ids(payload.track_ids, payload.force)
        job_id, queued = queue_analysis(track_ids, priority=payload.priority)
        return AnalyzeResponse(job_id=job_id, queued=queued)

    @app.post("/api/library/analyze/cancel")
    def library_analyze_cancel(job_id: str = "") -> dict[str, Any]:
        """停止分析。已经在跑的那一首会跑完——半途掐断会留下半写的行。"""
        jobs = (
            [current_analysis[job_id]] if job_id in current_analysis else list(current_analysis.values())
        )
        if not jobs:
            return {"canceled": 0, "remaining": 0}
        remaining = 0
        for job in jobs:
            job.canceled.set()
            remaining += max(0, job.total - job.done)
        hub.publish_toast("info", f"已停止分析，剩下 {remaining} 首不再处理")
        return {"canceled": len(jobs), "remaining": remaining}

    @app.post("/api/library/tracks/{track_id}/write-tags", response_model=Track)
    def library_write_tags(track_id: int) -> Track:
        track = library.get(track_id)
        if track is None:
            raise HTTPException(status_code=404, detail="曲目不存在")
        write_analysis_tags(
            Path(track.path),
            bpm=track.bpm,
            camelot=track.camelot,
            music_key=track.music_key,
            energy=track.energy,
            comment=track.comment,
        )
        return track

    @app.get("/api/library/harmonic/{track_id}", response_model=list[HarmonicMatch])
    def library_harmonic(
        track_id: int, bpm_tolerance: float = 12.0, limit: int = 60, wide: bool = True
    ) -> list[HarmonicMatch]:
        """能接上的下一首。

        默认容差从 ±6 放宽到 ±12 BPM：±6 在 128 BPM 上不到 5%，
        而现场 pitch 推 ±6% 是常规操作，卡在 ±6 会白白滤掉一大半能接的曲子。
        """
        if library.get(track_id) is None:
            raise HTTPException(status_code=404, detail="曲目不存在")
        return library.harmonic_matches(
            track_id, bpm_tolerance, max(1, min(limit, 200)), wide=wide
        )

    @app.get("/api/library/stats", response_model=LibraryStats)
    def library_stats() -> LibraryStats:
        return library.stats()

    @app.get("/api/library/audio/{track_id}")
    def library_audio(track_id: int, request: Request, token: str = "") -> Response:
        del token  # 中间件已经校验过，这里只是让 ?token= 不被当成未知参数
        track = library.get(track_id)
        if track is None:
            raise HTTPException(status_code=404, detail="曲目不存在")
        path = Path(track.path)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="音频文件已丢失")
        if path.suffix.lower() in VIDEO_SUFFIXES:
            path = _extracted_audio(path, track.id, config.data_dir / "audio-cache")
        return _audio_response(path, request)

    @app.get("/api/library/waveform/{track_id}")
    def library_waveform(track_id: int, buckets: int = 640) -> dict[str, Any]:
        """整轨彩色波形：每列一个高度 + 一个 RGB，前端直接一列一根柱子地画。

        为什么颜色要分频而高度不分：现代母带压得很平，单条灰色包络整首都是
        一块实心，看不出结构。把「这一列的能量落在哪个频段」编码成颜色之后，
        鼓组（红）、人声与主旋律（绿）、镲与空气感（蓝）一眼可辨，
        drop、break、纯人声段不用听就能定位——Serato / Rekordbox 都是这个模型。

        为什么单开一条接口而不是塞进分析结果：波形是纯展示用的，
        既不影响 BPM/调性，也不该逼用户为了看波形去重跑一次分析。
        结果按 (id, buckets, mtime) 缓存到 data/waveform/，第二次是秒开。
        """
        buckets = max(64, min(buckets, 2000))
        track = library.get(track_id)
        if track is None:
            raise HTTPException(status_code=404, detail="曲目不存在")
        path = Path(track.path)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="音频文件已丢失")

        try:
            mtime = int(path.stat().st_mtime)
        except OSError:
            mtime = 0
        cache_dir = config.data_dir / "waveform"
        # v2 = 三条包络 → 每列一色的格式变更。不带版本号的话，旧缓存会以旧
        # 结构被原样返回，前端拿到没有 amp 的对象只会画出一片空白。
        cache_file = cache_dir / f"{track_id}-v2-{buckets}-{mtime}.json"
        if cache_file.is_file():
            with suppress(Exception):
                return json.loads(cache_file.read_text("utf-8"))

        try:
            # 16 kHz：奈奎斯特 8 kHz，高频段还留得住镲和空气感；
            # 再高就只是让解码和 STFT 变慢，对一条几百像素宽的波形没有意义。
            samples, sr = decode_audio(path, sr=WAVEFORM_SR, mono=True)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"解码失败：{exc}") from exc
        if samples.size < WAVEFORM_NFFT:
            raise HTTPException(status_code=422, detail="文件没有可解码的音频")

        payload = _band_waveform(samples, sr, buckets)
        payload["track_id"] = track_id
        with suppress(Exception):
            cache_dir.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(payload), "utf-8")
        return payload

    @app.get("/api/library/cover/{track_id}")
    def library_cover(track_id: int, token: str = "") -> Response:
        del token
        track = library.get(track_id)
        if track is None:
            raise HTTPException(status_code=404, detail="曲目不存在")
        cover = read_cover(Path(track.path))
        if cover is None:
            raise HTTPException(status_code=404, detail="没有内嵌封面")
        data, mime = cover
        # 曲库列表每行都放缩略图，滚一屏就是几十个请求；不给缓存头的话
        # 每次滚回来都要重新读文件、重新解 tag。封面几乎不变，缓存一小时足够。
        return Response(
            content=data,
            media_type=mime or "image/jpeg",
            headers={"Cache-Control": "private, max-age=3600"},
        )

    # ------------------------------------------------------------ WebSocket

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket, token: str = Query(default="")) -> None:
        # WS 握手带不了自定义头，token 只能走 query。
        if not secrets.compare_digest(token, config.token):
            await websocket.close(code=4401)
            return
        await websocket.accept()
        subscriber = hub.subscribe()
        try:
            # 连上先给一次全量队列，避免前端要等下一次进度事件才知道有哪些任务。
            await websocket.send_text(encode_event("download.list", manager.snapshot()))
            await _pump(websocket, subscriber)
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001
            logger.debug("WS 连接异常结束", exc_info=True)
        finally:
            hub.unsubscribe(subscriber)
            with suppress(Exception):
                await websocket.close()

    return app


async def _pump(websocket: WebSocket, subscriber: Subscriber) -> None:
    """同时等"有新事件要发"和"客户端断开"。

    只 await 队列的话，客户端悄悄断开时这个协程会一直挂着（没有事件就永远不会去 send，
    也就永远发现不了断开），连接和订阅都泄漏。所以必须并行跑一个 receive 任务。
    """

    async def receiver() -> None:
        while True:
            # 前端不发消息，这里唯一的作用是在断开时抛 WebSocketDisconnect。
            await websocket.receive()

    receive_task = asyncio.ensure_future(receiver())
    try:
        while True:
            get_task = asyncio.ensure_future(subscriber.get())
            done, _ = await asyncio.wait(
                {get_task, receive_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if receive_task in done:
                get_task.cancel()
                receive_task.result()  # 触发 WebSocketDisconnect
                return
            await websocket.send_text(get_task.result())
    finally:
        receive_task.cancel()
        with suppress(Exception):
            await receive_task


def _band_waveform(samples: np.ndarray, sr: int, buckets: int) -> dict[str, Any]:
    """Serato 式彩色波形：**每一列一根柱子**，高度 = 响度，颜色 = 这一列的频谱构成。

    做法照搬 libdjwaveform / Serato 的模型：STFT 之后，一帧（一列）先算出
    低/中/高三段的能量，高度取三段之和，颜色取三段的**相对占比**。
    分频点用社区实测的 Serato 交叉点：红↔绿 ≈ 200 Hz，绿↔蓝 ≈ 1.5 kHz。

    上一版是「三条包络各画各的高度，再用 screen 混色叠起来」——那画出来是
    三团上下对称的色块套在一起（蓝在中间、红绿探出头），不是波形。
    关键区别在这里：高度只有一个（总能量），颜色才是分频的结果。
    """
    window = np.hanning(WAVEFORM_NFFT + 1)[:WAVEFORM_NFFT].astype(np.float32)
    n_frames = 1 + (samples.size - WAVEFORM_NFFT) // WAVEFORM_HOP
    frames = np.lib.stride_tricks.sliding_window_view(samples, WAVEFORM_NFFT)[::WAVEFORM_HOP]
    frames = frames[:n_frames]

    freqs = np.fft.rfftfreq(WAVEFORM_NFFT, 1.0 / sr)
    masks = (
        freqs < WAVEFORM_XOVER_LOW,
        (freqs >= WAVEFORM_XOVER_LOW) & (freqs < WAVEFORM_XOVER_HIGH),
        freqs >= WAVEFORM_XOVER_HIGH,
    )

    # 分块做 STFT：整轨一次性展开在长曲子上会吃掉几百 MB
    chunk = 2048
    energies = [np.empty(n_frames, dtype=np.float64) for _ in masks]
    for start in range(0, n_frames, chunk):
        block = frames[start : start + chunk] * window
        power = np.abs(np.fft.rfft(block, axis=1)) ** 2
        for index, mask in enumerate(masks):
            energies[index][start : start + block.shape[0]] = power[:, mask].sum(axis=1)

    # 帧 → 显示格。尾巴不足一格的直接截掉，补零会画出一根假的静音柱。
    step = max(1, n_frames // buckets)
    count = n_frames // step
    bands = np.stack(
        [energy[: step * count].reshape(count, step).mean(axis=1) for energy in energies]
    )  # (3, count) 功率域

    # ---- 高度：三段功率之和开根号（= 幅度），再做百分位对比拉伸。
    # 只除以 P99 是不够的：现代母带压完之后整首的 RMS 都挤在 0.6~1.0，
    # 画出来就是一条实心带。把 P5 当作"地板"减掉，起伏才回得来。
    amp = np.sqrt(bands.sum(axis=0))
    hi = float(np.percentile(amp, 99)) or 1.0
    lo = float(np.percentile(amp, 5))
    amp = np.clip((amp - lo) / max(hi - lo, 1e-9), 0.0, 1.0)
    amp = np.power(amp, WAVEFORM_AMP_GAMMA)

    # ---- 颜色：这一列的频谱**占比**，相对全曲常态的偏离量。
    #
    # 试过三种，前两种都不行：
    #   A. 三段幅度用同一个尺度直接当 RGB（最朴素的 Serato 做法）——
    #      中频带宽最宽、能量天然最大，每列的最大通道永远是绿，整首绿成一片。
    #   B. 三段各按自己的 P95 归一——去掉了频段间的系统偏置，但三段的响度
    #      是高度相关的（一起大声一起小声），归一后每列三通道都接近 1，整首发白。
    #   C. 先把每列化成"低/中/高各占多少"（除掉共同的响度），再和全曲的常态
    #      占比相比 —— 只有比常态更强的频段才亮。鼓点段红、人声段绿、镲密的段蓝。
    # 代价：颜色是**相对本曲**的，两首曲子的同一个颜色不代表同样的绝对频谱。
    # 但波形是拿来看单曲结构的，段落之间分得开比跨曲可比更有用。
    #
    # 配色前先沿时间轴做滑动平均：一格才 200~300 ms，底鼓和踩镲会逐格交替，
    # 不平滑的话每根柱子颜色都跳，画出来是彩色噪点。高度不参与平滑——瞬态该锐就得锐。
    mag = np.sqrt(bands)
    span = max(3, count // 128) | 1  # 取奇数，卷积后长度对得上
    if count > span:
        kernel = np.ones(span) / span
        mag = np.stack([np.convolve(row, kernel, mode="same") for row in mag])
    share = mag / np.maximum(mag.sum(axis=0), 1e-12)
    # 用中位数而不是均值：几个特别猛的低频瞬态会把均值拉高，常态就跑偏了
    ref = np.median(share, axis=1).reshape(3, 1)
    ref[ref <= 0.0] = 1.0
    # γ 很大是必须的：占比的偏离量本身很小（0.45 → 0.50 这种级别），
    # γ=2 出来是一片淡彩，γ=6 才是 DJ 软件里那种能一眼分辨段落的饱和色。
    dev = np.power(share / ref, WAVEFORM_COLOR_GAMMA)
    rgb = np.clip(dev / np.maximum(dev.max(axis=0), 1e-9), 0.0, 1.0)
    # 通道下限：纯 (255,0,0) 在深色底上太扎眼，抬一点让暗通道保留一丝底色
    rgb = WAVEFORM_COLOR_FLOOR + (1.0 - WAVEFORM_COLOR_FLOOR) * rgb
    rgb8 = np.rint(rgb * 255.0).astype(int)

    return {
        "duration": round(float(samples.size) / sr, 3),
        "amp": [round(float(v), 4) for v in amp],
        "r": rgb8[0].tolist(),
        "g": rgb8[1].tolist(),
        "b": rgb8[2].tolist(),
    }


def _singleton_groups(
    per_platform: dict[str, list[SongSource]],
    priority: list[str] | None = None,
) -> list[MergedGroup]:
    """merge=False 时也给前端一份统一结构的 groups（一个来源一组），
    这样结果表不用为两种模式写两套渲染。

    顺序走 interleave_sources：按平台一个个平铺的话，列表会是
    "上半截全网易云、下半截全 QQ"，跨平台比价的意义就没了。
    """
    groups: list[MergedGroup] = []
    for source in interleave_sources(per_platform, priority):
        gid = hashlib.sha1(f"{source.platform}:{source.key}".encode("utf-8")).hexdigest()[:12]
        groups.append(
            MergedGroup(
                group_id=gid,
                title=source.title,
                artists=list(source.artists),
                album=source.album,
                duration=source.duration,
                cover=source.cover,
                sources=[source],
                best_source_index=0,
                score=0.0,
                in_library=False,
            )
        )
    return groups
