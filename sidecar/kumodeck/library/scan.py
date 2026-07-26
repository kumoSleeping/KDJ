"""目录扫描：遍历 → 过滤 → 增量入库。"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from ..tagging import MEDIA_EXTENSIONS
from .service import LibraryService, normalize_path

# 这些目录进去只有垃圾，还容易踩到几万个文件把扫描拖死
SKIP_DIR_NAMES = frozenset(
    {
        ".trash",
        ".trashes",
        "$recycle.bin",
        "__macosx",
        "node_modules",
        ".git",
        ".svn",
        ".hg",
        "system volume information",
        ".spotlight-v100",
        ".fseventsd",
        ".documentrevisions-v100",
    }
)

ProgressFn = Callable[[int, int, str], None]


def _skip_dir(name: str) -> bool:
    lowered = name.lower()
    return lowered in SKIP_DIR_NAMES or (name.startswith(".") and name != ".")


def _is_audio(name: str) -> bool:
    # macOS 在非 HFS 卷（U 盘/网盘）上给每个文件配一个 `._xxx.mp3` 资源叉，
    # 后缀和正主一模一样，不排掉会得到一堆 4KB 的"损坏音频"
    if name.startswith("._") or name.startswith("."):
        return False
    return os.path.splitext(name)[1].lower() in MEDIA_EXTENSIONS


def collect_files(paths: list[str], recursive: bool) -> list[str]:
    """把入参里的文件/目录展开成去重后的音频文件列表（已归一化路径）。"""
    found: list[str] = []
    seen: set[str] = set()

    def add(candidate: str) -> None:
        key = normalize_path(candidate)
        if key not in seen:
            seen.add(key)
            found.append(key)

    for raw in paths or []:
        root = Path(normalize_path(raw))
        if root.is_file():
            if _is_audio(root.name):
                add(str(root))
            continue
        if not root.is_dir():
            continue

        if not recursive:
            try:
                for entry in sorted(os.listdir(root)):
                    full = root / entry
                    if full.is_file() and _is_audio(entry):
                        add(str(full))
            except OSError:
                pass
            continue

        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            # 原地改 dirnames 才能让 os.walk 真正不进这些目录（剪枝，不是过滤结果）
            dirnames[:] = sorted(d for d in dirnames if not _skip_dir(d))
            for name in sorted(filenames):
                if _is_audio(name):
                    add(os.path.join(dirpath, name))

    return found


def scan_paths(
    service: LibraryService,
    paths: list[str],
    recursive: bool,
    on_progress: ProgressFn,
) -> list[int]:
    """扫描并入库，返回本次扫到的全部 track id（新增 + 更新 + 未变化）。

    返回值包含未变化的曲目，这样调用方可以直接拿它当"这批文件对应的曲目集合"
    去做后续的自动分析；要不要重分析由 `pending_analysis_ids` 决定。
    """
    files = collect_files(paths, recursive)
    total = len(files)
    _emit(on_progress, 0, total, "")
    if total == 0:
        return []

    # 一次性拉出已入库文件的 mtime，逐个查库在几万首的曲库上会慢得离谱
    index = service.file_index()

    track_ids: list[int] = []
    done = 0
    for file_path in files:
        done += 1
        try:
            known = index.get(file_path)
            if known is not None:
                try:
                    mtime = os.path.getmtime(file_path)
                except OSError:
                    mtime = None
                if mtime is not None and abs(known[1] - mtime) < 1e-6:
                    # 增量扫描：文件没动过就不重读标签
                    track_ids.append(known[0])
                    continue
            track_ids.append(service.upsert_file(Path(file_path)))
        except Exception:
            # 单个文件坏掉（权限/正在写入/编码异常）不能让整次扫描中断
            pass
        finally:
            _emit(on_progress, done, total, file_path)

    return track_ids


def _emit(on_progress: ProgressFn | None, done: int, total: int, current: str) -> None:
    if on_progress is None:
        return
    try:
        on_progress(done, total, current)
    except Exception:
        # 进度回调走的是 WS 广播，断线不该影响扫描本身
        pass
