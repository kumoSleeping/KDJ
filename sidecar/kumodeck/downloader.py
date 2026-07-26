"""DownloadManager：下载任务队列 / 线程池 / 进度广播 / 取消。

任务表用 OrderedDict + 一把可重入锁保护：HTTP 线程（enqueue/cancel/snapshot）和
下载工作线程（改状态、报进度）会同时访问它。
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections import OrderedDict, deque
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Deque

from .config import AppConfig
from .events import EventHub
from .models import DownloadTask, SongSource, VideoDownloadRequest, VideoInfo

logger = logging.getLogger("kumodeck.downloader")

MAX_HISTORY = 200

# 进度节流：一次下载每秒能触发上百次 chunk 回调，若每次都广播，
# WS 会被打爆（前端 setState 也跟着爆），而且 UI 上肉眼根本分不出 0.1% 的差别。
# 规则：最多 4 次/秒，或进度前进 ≥1% 立刻发一次；终态永远立刻发。
PROGRESS_MIN_INTERVAL = 0.25
PROGRESS_MIN_DELTA = 0.01

# 速度用滑动窗口算：瞬时值（本次 chunk / 本次耗时）抖得没法看，
# 累计平均值又在网络变化时反应太慢。
SPEED_WINDOW = 3.0

TERMINAL_STATES = frozenset({"done", "failed", "canceled"})

FinishedFn = Callable[[str, Path, "SongSource | None"], None]


class _Job:
    """一条任务的运行期状态（DownloadTask 只放要给前端看的字段）。"""

    __slots__ = ("task", "source", "cancel", "future", "launch", "last_emit", "last_progress", "samples")

    def __init__(self, task: DownloadTask, source: SongSource | None) -> None:
        self.task = task
        self.source = source
        self.cancel = threading.Event()
        self.future: Future | None = None
        # 自动下载关着时先攒着：这里存"真正提交进线程池"的动作，等放行再调
        self.launch: Callable[[], None] | None = None
        self.last_emit = 0.0
        self.last_progress = -1.0
        self.samples: Deque[tuple[float, int]] = deque(maxlen=64)


# ---------------------------------------------------------------- 视频 provider 适配


def _pick_method(provider: Any, names: tuple[str, ...]) -> Callable[..., Any]:
    """在 provider 上按优先级找方法。

    视频 provider（bilibili）的方法名不在跨模块契约里，这里给几个候选名兜底，
    找不到就抛出一条把候选名列全的错误，方便对齐。
    """
    for name in names:
        method = getattr(provider, name, None)
        if callable(method):
            return method
    raise AttributeError(
        f"{type(provider).__name__} 缺少视频接口，期望以下之一：{', '.join(names)}"
    )


def resolve_video(provider: Any, url: str) -> VideoInfo:
    return _pick_method(provider, ("resolve_video", "video_info", "info"))(url)


def download_video(
    provider: Any,
    request: VideoDownloadRequest,
    cancel: threading.Event,
    on_progress: Callable[[int, int], None],
) -> Path:
    method = _pick_method(provider, ("download_video", "download_stream", "fetch_video"))
    return Path(method(request, cancel, on_progress))


class DownloadManager:
    def __init__(
        self,
        providers: dict[str, Any],
        config: AppConfig,
        hub: EventHub,
        on_finished: FinishedFn,
    ) -> None:
        self._providers = providers
        self._config = config
        self._hub = hub
        self._on_finished = on_finished
        self._lock = threading.RLock()
        self._jobs: "OrderedDict[str, _Job]" = OrderedDict()
        self._concurrency = max(1, int(config.concurrent_downloads))
        self._pool = ThreadPoolExecutor(
            max_workers=self._concurrency, thread_name_prefix="kd-download"
        )
        self._closed = False

    # ------------------------------------------------------------ 入队

    def enqueue_audio(self, sources: list[SongSource], quality: str | None) -> list[DownloadTask]:
        target_quality = quality or self._config.default_quality
        tasks: list[DownloadTask] = []
        for source in sources:
            job = self._create_job(
                kind="audio",
                platform=source.platform,
                title=source.title,
                artist=source.artist_text,
                quality=target_quality,
                source=source,
            )
            provider = self._providers.get(source.platform)
            if provider is None:
                self._fail(job, f"平台 {source.platform} 不可用（provider 未加载）")
            else:
                self._launch_or_hold(job, self._run_audio, job, provider, target_quality)
            tasks.append(job.task.model_copy(deep=True))
        self._broadcast_list()
        return tasks

    def enqueue_video(self, request: VideoDownloadRequest, provider: Any) -> DownloadTask:
        title = request.bvid or request.url or "视频"
        job = self._create_job(
            kind="video",
            platform="bilibili",
            title=title,
            artist="",
            quality="audio" if request.audio_only else f"{request.max_height}p",
            source=None,
        )
        self._launch_or_hold(job, self._run_video, job, provider, request)
        self._broadcast_list()
        return job.task.model_copy(deep=True)

    def _create_job(
        self,
        *,
        kind: str,
        platform: str,
        title: str,
        artist: str,
        quality: str,
        source: SongSource | None,
    ) -> _Job:
        now = time.time()
        task = DownloadTask(
            id=uuid.uuid4().hex[:12],
            kind=kind,  # type: ignore[arg-type]
            platform=platform,  # type: ignore[arg-type]
            title=title or "未命名",
            artist=artist,
            quality=quality,
            state="queued",
            created_at=now,
            updated_at=now,
        )
        job = _Job(task, source)
        with self._lock:
            self._jobs[task.id] = job
            self._trim_locked()
        return job

    def _launch_or_hold(self, job: _Job, fn: Callable[..., None], *args: Any) -> None:
        """自动下载开着就直接进线程池；关着先攒着（state 停在 queued）。"""

        def launch() -> None:
            job.future = self._pool.submit(fn, *args)

        if self._config.auto_start_downloads:
            launch()
        else:
            job.launch = launch

    def release_pending(self) -> int:
        """把攒着没跑的任务全部放行（拨开自动下载开关时调用），返回放行数。"""
        with self._lock:
            held = [
                job
                for job in self._jobs.values()
                if job.launch is not None and job.task.state == "queued"
            ]
            launchers = [(job, job.launch) for job in held]
            for job in held:
                job.launch = None
        for _, launch in launchers:
            if launch is not None:
                launch()
        if launchers:
            self._broadcast_list()
        return len(launchers)

    # ------------------------------------------------------------ 查询 / 控制

    def snapshot(self) -> list[DownloadTask]:
        with self._lock:
            # 深拷贝：工作线程随时在改这些对象，直接返回引用会让 FastAPI
            # 序列化到一半读到"进度已更新、状态还没更新"的中间态。
            return [job.task.model_copy(deep=True) for job in self._jobs.values()]

    def get(self, task_id: str) -> DownloadTask | None:
        with self._lock:
            job = self._jobs.get(task_id)
            return job.task.model_copy(deep=True) if job else None

    def cancel(self, task_id: str) -> DownloadTask | None:
        with self._lock:
            job = self._jobs.get(task_id)
            if job is None:
                return None
            if job.task.state in TERMINAL_STATES:
                return job.task.model_copy(deep=True)
            job.cancel.set()
            still_queued = job.task.state == "queued"
        if still_queued:
            # 还没轮到它跑 → 直接从线程池里撤下来，撤不掉就靠 cancel 事件在
            # _run_* 开头自己退出。攒着没放行的把 launch 一并丢掉，
            # 免得之后拨开自动下载开关时把已取消的任务复活。
            job.launch = None
            if job.future is not None:
                job.future.cancel()
            self._settle(job, "canceled", error="已取消")
        else:
            # 正在跑：provider 会在下一个 chunk 检查 cancel 事件；这里先标出来给 UI 反馈。
            self._touch(job)
        return self.get(task_id)

    def clear_finished(self) -> int:
        with self._lock:
            removed = [tid for tid, job in self._jobs.items() if job.task.state in TERMINAL_STATES]
            for tid in removed:
                del self._jobs[tid]
        if removed:
            self._broadcast_list()
        return len(removed)

    def set_track_id(self, task_id: str, track_id: int) -> None:
        with self._lock:
            job = self._jobs.get(task_id)
            if job is None:
                return
            job.task.track_id = track_id
        self._emit(job, force=True)

    def set_concurrency(self, value: int) -> None:
        value = max(1, int(value))
        with self._lock:
            if value == self._concurrency or self._closed:
                return
            old = self._pool
            self._concurrency = value
            self._pool = ThreadPoolExecutor(max_workers=value, thread_name_prefix="kd-download")
        # 老池子不 wait：里面可能还有正在下的大文件，等它自己跑完再释放。
        old.shutdown(wait=False)

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
            jobs = list(self._jobs.values())
        for job in jobs:
            job.cancel.set()
        self._pool.shutdown(wait=False)

    # ------------------------------------------------------------ 执行

    def _run_audio(self, job: _Job, provider: Any, quality: str) -> None:
        if job.cancel.is_set():
            self._settle(job, "canceled", error="已取消")
            return
        self._start(job)
        assert job.source is not None
        try:
            path = Path(provider.download(job.source, quality, job.cancel, self._progress_fn(job)))
        except Exception as exc:  # noqa: BLE001 - provider 什么都可能抛
            self._handle_failure(job, exc)
            return
        if job.cancel.is_set():
            self._settle(job, "canceled", error="已取消")
            return
        self._finish(job, path)

    def _run_video(self, job: _Job, provider: Any, request: VideoDownloadRequest) -> None:
        if job.cancel.is_set():
            self._settle(job, "canceled", error="已取消")
            return
        self._start(job)
        try:
            # 先解析一次拿标题：队列里挂个 BV 号用户根本认不出是哪个视频。
            if request.url or request.bvid:
                try:
                    info = resolve_video(provider, request.url or request.bvid)
                    if info and info.title:
                        with self._lock:
                            job.task.title = info.title
                            job.task.artist = info.author
                    self._emit(job, force=True)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("视频信息预解析失败（不影响下载）：%s", exc)
            path = download_video(provider, request, job.cancel, self._progress_fn(job))
        except Exception as exc:  # noqa: BLE001
            self._handle_failure(job, exc)
            return
        if job.cancel.is_set():
            self._settle(job, "canceled", error="已取消")
            return
        self._finish(job, path)

    def _handle_failure(self, job: _Job, exc: Exception) -> None:
        if job.cancel.is_set():
            self._settle(job, "canceled", error="已取消")
            return
        logger.exception("下载失败：%s", job.task.title)
        message = str(exc) or type(exc).__name__
        self._settle(job, "failed", error=message)
        self._hub.publish_toast("error", f"下载失败：{job.task.title} —— {message}")

    def _start(self, job: _Job) -> None:
        with self._lock:
            job.task.state = "running"
            job.task.updated_at = time.time()
        job.samples.append((time.monotonic(), 0))
        self._emit(job, force=True)

    def _finish(self, job: _Job, path: Path) -> None:
        size = 0
        try:
            size = path.stat().st_size
        except OSError:
            pass
        with self._lock:
            job.task.state = "done"
            job.task.path = str(path)
            job.task.progress = 1.0
            job.task.speed_bps = 0.0
            if size:
                job.task.downloaded_bytes = size
                job.task.total_bytes = max(job.task.total_bytes, size)
            # provider 可能因为版权降级了音质，用最终文件后缀纠正显示值。
            suffix = path.suffix.lower().lstrip(".")
            if suffix in {"flac", "mp3", "m4a", "wav", "aac", "ogg", "mp4"}:
                job.task.quality = suffix if job.task.kind == "audio" else job.task.quality
            job.task.updated_at = time.time()
        self._emit(job, force=True)
        try:
            self._on_finished(job.task.id, path, job.source)
        except Exception:  # noqa: BLE001 - 入库失败不能反过来把下载判成失败
            logger.exception("下载完成回调异常：%s", path)

    def _fail(self, job: _Job, message: str) -> None:
        self._settle(job, "failed", error=message)

    def _settle(self, job: _Job, state: str, *, error: str = "") -> None:
        with self._lock:
            if job.task.state in TERMINAL_STATES:
                return
            job.task.state = state  # type: ignore[assignment]
            job.task.error = error
            job.task.speed_bps = 0.0
            job.task.updated_at = time.time()
        self._emit(job, force=True)

    def _touch(self, job: _Job) -> None:
        with self._lock:
            job.task.updated_at = time.time()
        self._emit(job, force=True)

    # ------------------------------------------------------------ 进度

    def _progress_fn(self, job: _Job) -> Callable[[int, int], None]:
        def on_progress(downloaded: int, total: int) -> None:
            now = time.monotonic()
            with self._lock:
                task = job.task
                task.downloaded_bytes = int(downloaded)
                if total:
                    task.total_bytes = int(total)
                task.progress = min(1.0, downloaded / total) if total else 0.0
                job.samples.append((now, int(downloaded)))
                task.speed_bps = _window_speed(job.samples, now)
                task.updated_at = time.time()
                progress = task.progress
                due = (
                    now - job.last_emit >= PROGRESS_MIN_INTERVAL
                    or progress - job.last_progress >= PROGRESS_MIN_DELTA
                )
                if due:
                    job.last_emit = now
                    job.last_progress = progress
                    payload = task.model_copy(deep=True)
                else:
                    payload = None
            if payload is not None:
                self._hub.publish("download.updated", payload)

        return on_progress

    def _emit(self, job: _Job, *, force: bool = False) -> None:
        with self._lock:
            now = time.monotonic()
            if not force and now - job.last_emit < PROGRESS_MIN_INTERVAL:
                return
            job.last_emit = now
            job.last_progress = job.task.progress
            payload = job.task.model_copy(deep=True)
        self._hub.publish("download.updated", payload)

    def _broadcast_list(self) -> None:
        self._hub.publish("download.list", self.snapshot())

    def _trim_locked(self) -> None:
        """只保留 200 条，超出的从最老的**终态**任务开始丢（不能丢正在跑的）。"""
        if len(self._jobs) <= MAX_HISTORY:
            return
        for tid in list(self._jobs.keys()):
            if len(self._jobs) <= MAX_HISTORY:
                break
            if self._jobs[tid].task.state in TERMINAL_STATES:
                del self._jobs[tid]


def _window_speed(samples: Deque[tuple[float, int]], now: float) -> float:
    while len(samples) > 2 and now - samples[0][0] > SPEED_WINDOW:
        samples.popleft()
    if len(samples) < 2:
        return 0.0
    t0, b0 = samples[0]
    t1, b1 = samples[-1]
    dt = t1 - t0
    if dt <= 0.05:
        return 0.0
    return max(0.0, (b1 - b0) / dt)
