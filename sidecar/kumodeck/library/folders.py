"""文件夹模式：把曲库映射到真实目录，并在真实目录上做移动 / 链接。

设计前提：**文件夹就是磁盘上的文件夹**，不是数据库里的虚拟分组。
DJ 出场前要把一套歌拷进 U 盘、要用别的软件（Rekordbox / Serato）再读一遍，
虚拟分组到了那一步就没了。所以这里所有操作都落到文件系统上，
数据库只是跟着改 path。

一首歌要同时出现在两个 set 里时用**硬链接**：同一份数据、两个路径，
不额外占空间，两边删掉任何一个都不影响另一个。跨卷或文件系统不支持时
依次退到符号链接、真复制。

安全：dest 一律必须落在已配置的曲库根目录内（resolve 之后判断），
否则渲染进程就能借这个接口把文件挪到系统任意位置。
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path

from ..models import FolderNode, FolderTree
from ..tagging import MEDIA_EXTENSIONS

logger = logging.getLogger("kumodeck.folders")

# 每个受管目录里放一份清单文件，记这一层的**子目录显示顺序**。
#
# 为什么是"每个目录一份"而不是"根目录一份大清单"：清单跟着文件夹走。
# 出场前把 `温州/` 整个拷进 U 盘，顺序也一起过去了；
# 把某个子目录挪到别的根下面，它内部的顺序照样成立。
# 一份中心清单做不到这两点，而且一旦和磁盘不同步就整棵树错位。
#
# 为什么不存进 SQLite：数据库在 app 的 userData 里，换台电脑就没了；
# 而 DJ 的目录本来就是要跨机器搬的。
MANIFEST_NAME = ".kumodeck.json"
MANIFEST_VERSION = 1

# 扫描目录树的深度上限。DJ 的歌单目录一般 1~2 层，给到 6 层足够，
# 同时挡住 node_modules 那种病态深度把 UI 卡死。
MAX_DEPTH = 6
# 单个目录下的子目录上限，防止误选了一个几万条目的目录
MAX_CHILDREN = 500

_SKIP_DIRS = {".git", ".svn", "node_modules", "__pycache__", ".Trash", ".partial"}


class FolderError(Exception):
    """文件夹操作失败（越界、重名、IO）。路由层转成 400。"""


def _norm(path: str | Path) -> Path:
    """和 `service.normalize_path` 完全同一套归一化：expanduser + abspath + normpath。

    **不能**换成 `Path.resolve()`。resolve 会解析符号链接，而入库的 path 没解析过；
    两边规则一旦不一致，文件夹树的计数就会全落到 `outside` 里。
    """
    return Path(os.path.normpath(os.path.abspath(os.path.expanduser(str(path)))))


def _within(child: Path, parent: Path) -> bool:
    if child == parent:
        return True
    try:
        return child.is_relative_to(parent)
    except ValueError:  # pragma: no cover - 只在 Windows 跨盘符时抛
        return False


def ensure_inside(dest: str | Path, roots: list[Path]) -> Path:
    """确认 dest 在某个曲库根目录里（含根目录本身），返回归一化后的绝对路径。

    没有这一步，`dest="/"` 或 `dest="../../.."` 就能把用户的音乐文件搬到任意位置。
    用 is_relative_to 而不是字符串前缀比较：后者会被 `/Users/me/Music-evil`
    这种同前缀的兄弟目录骗过去。

    归一化路径和 realpath **两道都要过**：前者挡 `..`，后者挡"曲库里放一个
    指向 /etc 的符号链接再往里搬文件"。只做前者会被符号链接绕过，
    只做后者又会和数据库里未解析的 path 对不上。
    """
    target = _norm(dest)
    for root in roots:
        if not _within(target, root):
            continue
        real_target = Path(os.path.realpath(target))
        if _within(real_target, Path(os.path.realpath(root))):
            return target
        raise FolderError(f"目标目录经符号链接指到了曲库之外：{target}")
    raise FolderError(f"目标目录不在曲库范围内：{target}")


def resolve_roots(dirs: list[str]) -> list[Path]:
    """把设置里的曲库目录变成去重、存在、已归一化的根列表。

    **互相包含的只留最外层那个**：如果 `~/git/djay` 和 `~/git/djay/温州` 都在列表里，
    温州会在树上同时以"根"和"djay 的子节点"两个身份出现，看着像凭空多了一份。
    历史设置里已经攒下这种重复项，所以在这里统一收口，而不是只在写入时防。
    """
    seen: list[Path] = []
    for item in dirs:
        if not item:
            continue
        path = _norm(item)
        if path.is_dir() and path not in seen:
            seen.append(path)
    return [
        path for path in seen if not any(other != path and _within(path, other) for other in seen)
    ]


def infer_roots(track_paths: list[str]) -> list[Path]:
    """没配曲库目录时，从已入库的路径反推一个根目录。

    为的是"文件夹模式上线之前就扫过歌"的用户：他们的 library_dirs 是空的，
    文件夹树会一片空白，而歌明明都在。

    做法是"每个存歌的目录各自往上退一层"，不是"取全体的最近公共祖先"：
    实际的库常常横跨两棵树（下载目录 `~/Music/KumoDeck/netease` +
    自己的 `~/git/djay/温州`），取公共祖先会一路退到 `~`，
    等于把整个家目录当曲库根——又慢又危险，拖拽的落点校验就是按根来的。
    分头退一层则刚好得到 `~/Music/KumoDeck` 和 `~/git/djay` 两个根。

    退到家目录、`/Users`、`/Volumes`、`/` 这些就不再往上，用存歌的目录本身当根。
    """
    parents = {_norm(os.path.dirname(p)) for p in track_paths if p}
    if not parents:
        return []
    home = Path.home()
    blocked = {Path("/"), home, home.parent, Path("/Volumes"), Path("/tmp")}

    candidates: set[Path] = set()
    for parent in parents:
        up = parent.parent
        candidates.add(parent if (up in blocked or len(up.parts) < 4) else up)

    # 互相包含时只留最外层的那个，免得同一批歌在树里出现两次
    roots = [
        node
        for node in sorted(candidates)
        if not any(other != node and _within(node, other) for other in candidates)
    ]
    return [node for node in roots if node.is_dir()]


# ------------------------------------------------------------------ 目录清单


def read_manifest(directory: Path) -> dict:
    """读目录里的 `.kumodeck.json`。读不出来一律当成空清单。

    清单只影响显示顺序，坏了不该让整棵树打不开——所以这里吞掉所有异常，
    最坏情况是退回按名字排序，用户看到的是"顺序被重置了"，而不是白屏。
    """
    path = directory / MANIFEST_NAME
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def write_manifest(directory: Path, order: list[str]) -> None:
    payload = {"version": MANIFEST_VERSION, "order": order}
    try:
        (directory / MANIFEST_NAME).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), "utf-8"
        )
    except OSError as exc:
        logger.warning("写不了 %s：%s", directory / MANIFEST_NAME, exc)


def _child_names(directory: Path) -> list[str]:
    try:
        entries = [
            entry.name
            for entry in os.scandir(directory)
            if entry.is_dir(follow_symlinks=False)
            and not entry.name.startswith(".")
            and entry.name not in _SKIP_DIRS
        ]
    except OSError:
        return []
    return sorted(entries, key=str.lower)


def count_audio_files(directory: Path) -> int:
    """这一层目录里有几个音频文件（不含子目录）。

    树上要同时显示"库里有几首"和"磁盘上有几个"：两者不一致就说明这个目录
    还没扫过。没有这个数，用户看到的是一个空文件夹，而歌明明就在里面。
    """
    try:
        return sum(
            1
            for entry in os.scandir(directory)
            if entry.is_file(follow_symlinks=False)
            and not entry.name.startswith(".")
            and os.path.splitext(entry.name)[1].lower() in MEDIA_EXTENSIONS
        )
    except OSError:
        return 0


def apply_order(directory: Path, names: list[str]) -> list[str]:
    """按清单里的顺序排列子目录名。

    清单里有、磁盘上没有的（被删/改名了）直接丢掉；
    磁盘上有、清单里没有的（新建的）按名字排在后面。
    两边都不强行同步回文件——只有用户真的调过顺序才写盘。
    """
    listed = [name for name in names if isinstance(name, str)]
    actual = _child_names(directory)
    index = {name: position for position, name in enumerate(listed)}
    known = [name for name in actual if name in index]
    known.sort(key=lambda name: index[name])
    fresh = [name for name in actual if name not in index]
    return known + fresh


def init_manifests(directory: Path, roots: list[Path], depth: int = 0) -> int:
    """给目录树里每一层补上清单文件，返回新建了几个。

    这就是用户说的"初始化文件夹"：跑完之后每一层都有了自己的顺序记录，
    之后拖动排序才有地方落。已经有清单的目录不动，不覆盖用户排好的顺序。
    """
    ensure_inside(directory, roots)
    created = 0
    if not (directory / MANIFEST_NAME).exists():
        write_manifest(directory, _child_names(directory))
        created += 1
    if depth < MAX_DEPTH:
        for name in _child_names(directory):
            created += init_manifests(directory / name, roots, depth + 1)
    return created


def _count_index(paths: list[str]) -> dict[str, int]:
    """曲目路径 → 所在目录的直接计数。"""
    counts: dict[str, int] = {}
    for raw in paths:
        parent = os.path.dirname(raw)
        counts[parent] = counts.get(parent, 0) + 1
    return counts


def _walk(directory: Path, counts: dict[str, int], depth: int) -> FolderNode:
    children: list[FolderNode] = []
    manifest = read_manifest(directory)
    if depth < MAX_DEPTH:
        # 顺序由目录自己的清单决定，不是字母序：DJ 的 set 目录是按演出顺序排的，
        # 按字母排会把「5月 / 6yue / 7yue」打散成毫无意义的次序。
        names = apply_order(directory, manifest.get("order") or [])[:MAX_CHILDREN]
        for name in names:
            children.append(_walk(directory / name, counts, depth + 1))

    direct = counts.get(str(directory), 0)
    files = count_audio_files(directory)
    return FolderNode(
        path=str(directory),
        name=directory.name or str(directory),
        parent=str(directory.parent),
        track_count=direct,
        file_count=files,
        # 累计计数让人一眼看出哪个分支是空的，不用一层层点开
        total_count=direct + sum(child.total_count for child in children),
        # 未入库 = 磁盘上有、库里没有。负数没有意义（库里可能还留着已删文件的记录）
        pending_count=max(0, files - direct) + sum(child.pending_count for child in children),
        children=children,
        managed=bool(manifest),
    )


def build_tree(dirs: list[str], track_paths: list[str]) -> FolderTree:
    """按设置里的曲库目录构建文件夹树，并统计每个目录下的曲目数。

    统计走**数据库里已有的路径**而不是再扫一次磁盘：树只需要知道
    "库里这些歌分别躺在哪"，重新遍历文件系统既慢又会把没入库的文件算进来。
    """
    roots = resolve_roots(dirs)
    counts = _count_index(track_paths)
    nodes = [_walk(root, counts, 0) for root in roots]
    for node in nodes:
        node.is_root = True
    inside = sum(node.total_count for node in nodes)
    return FolderTree(roots=nodes, outside=max(0, len(track_paths) - inside))


# ------------------------------------------------------------------ 目录操作


def create_folder(parent: str, name: str, roots: list[Path]) -> Path:
    clean = (name or "").strip().strip("/")
    if not clean or clean in {".", ".."} or "/" in clean or "\\" in clean:
        raise FolderError("文件夹名不合法")
    base = ensure_inside(parent, roots)
    if not base.is_dir():
        raise FolderError("上级目录不存在")
    target = base / clean
    # 再验一次：clean 已经排除了分隔符，这里挡的是符号链接把 target 指到界外
    ensure_inside(target.parent, roots)
    if target.exists():
        raise FolderError("同名文件夹已存在")
    target.mkdir()
    return target


def rename_folder(path: str, name: str, roots: list[Path]) -> Path:
    clean = (name or "").strip().strip("/")
    if not clean or clean in {".", ".."} or "/" in clean or "\\" in clean:
        raise FolderError("文件夹名不合法")
    source = ensure_inside(path, roots)
    if source in roots:
        raise FolderError("曲库根目录不能在这里改名，去设置里改")
    if not source.is_dir():
        raise FolderError("文件夹不存在")
    target = source.parent / clean
    if target.exists():
        raise FolderError("同名文件夹已存在")
    source.rename(target)
    return target


def move_folder(source_path: str, dest_parent: str, roots: list[Path]) -> tuple[Path, Path]:
    """把一整个文件夹搬进另一个文件夹，返回 (旧路径, 新路径)。

    这是"拖到另一层"时做的事。三条必须挡住：
      - 根目录不能被搬（它由设置里的曲库目录决定）；
      - 不能搬进自己或自己的子目录里（会把整棵子树搬没）；
      - 目标下同名已存在时不合并，直接报错——静默合并会让两批同名文件混在一起。
    """
    source = ensure_inside(source_path, roots)
    parent = ensure_inside(dest_parent, roots)
    if source in roots:
        raise FolderError("曲库根目录不能拖动，去设置里改")
    if not source.is_dir():
        raise FolderError("文件夹不存在")
    if not parent.is_dir():
        raise FolderError("目标不是文件夹")
    if _within(parent, source):
        raise FolderError("不能把文件夹拖进它自己里面")
    target = parent / source.name
    if target == source:
        return source, source
    if target.exists():
        raise FolderError(f"「{parent.name}」下已经有同名文件夹了")
    shutil.move(str(source), str(target))
    return source, target


def delete_folder(path: str, roots: list[Path]) -> Path:
    """只删空目录。递归删会连带删掉音频文件，这个按钮不该有那么大的杀伤力。"""
    target = ensure_inside(path, roots)
    if target in roots:
        raise FolderError("曲库根目录不能在这里删除，去设置里移除")
    if not target.is_dir():
        raise FolderError("文件夹不存在")
    try:
        target.rmdir()
    except OSError as exc:
        raise FolderError(f"文件夹非空或删不掉：{exc}") from exc
    return target


# ------------------------------------------------------------------ 文件操作


def unique_target(directory: Path, filename: str) -> Path:
    """同名时加 ` (2)`、` (3)`…… 不覆盖已有文件。

    覆盖同名文件是不可逆的：DJ 的两个 set 里同名不同 mix 的文件很常见
    （`Track - Artist.mp3` 可能是 radio edit 也可能是 extended），
    静默覆盖会直接丢掉一首歌。
    """
    target = directory / filename
    if not target.exists():
        return target
    stem, suffix = os.path.splitext(filename)
    for index in range(2, 1000):
        candidate = directory / f"{stem} ({index}){suffix}"
        if not candidate.exists():
            return candidate
    raise FolderError("目标目录里同名文件太多")


def move_file(source: Path, directory: Path) -> Path:
    target = unique_target(directory, source.name)
    # shutil.move 跨卷时会退化成"复制 + 删除"，os.replace 直接报 EXDEV。
    # 用户完全可能把外置硬盘上的歌拖进内置盘的文件夹里，必须支持跨卷。
    shutil.move(str(source), str(target))
    return target


def link_file(source: Path, directory: Path) -> tuple[Path, str]:
    """优先硬链接，退符号链接，再退真复制。返回 (目标路径, 实际用的方式)。"""
    target = unique_target(directory, source.name)
    try:
        os.link(source, target)
        return target, "hardlink"
    except OSError:
        pass
    try:
        os.symlink(source, target)
        return target, "symlink"
    except OSError:
        pass
    shutil.copy2(source, target)
    return target, "copy"


def link_state(path: Path) -> str:
    """这个文件是不是某个链接的一端。前端据此在列表里打个链接标记。

    `st_nlink > 1` 只说明"同一份数据有多个名字"，看不出另一个名字在哪，
    但对用户要回答的问题（"这首为什么出现两次？"）已经够了。
    """
    try:
        if path.is_symlink():
            return "symlink"
        return "hardlink" if path.stat().st_nlink > 1 else ""
    except OSError:
        return ""
