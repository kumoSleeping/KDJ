"""LibraryService：曲库的查询 / 过滤 / 入库 / 和声推荐 / 统计。

所有 SQL 都收在这一层，上面的 app.py 只跟 pydantic 模型打交道。
"""

from __future__ import annotations

import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from ..models import HarmonicMatch, LibraryStats, Track, TrackPage, TrackPatch
from ..tagging import read_tags
from .db import Database
from .folders import link_state

# ---------------------------------------------------------------- Camelot 表

# 逐条对应 docs/00-architecture.md 第 5 节的调号轮表格
CAMELOT_TO_KEY: dict[str, str] = {
    "1A": "Ab minor", "1B": "B major",
    "2A": "Eb minor", "2B": "F# major",
    "3A": "Bb minor", "3B": "Db major",
    "4A": "F minor", "4B": "Ab major",
    "5A": "C minor", "5B": "Eb major",
    "6A": "G minor", "6B": "Bb major",
    "7A": "D minor", "7B": "F major",
    "8A": "A minor", "8B": "C major",
    "9A": "E minor", "9B": "G major",
    "10A": "B minor", "10B": "D major",
    "11A": "F# minor", "11B": "A major",
    "12A": "Db minor", "12B": "E major",
}

# 反查表：把用户可能输入的各种写法都归到 Camelot。
# 同音异名（G# = Ab、D# = Eb、A# = Bb、C# = Db、Gb = F#）必须都收进来，
# 否则用户搜 "G# minor" 会一首都搜不到。
_ENHARMONIC = {
    "ab": "g#", "g#": "ab", "eb": "d#", "d#": "eb", "bb": "a#", "a#": "bb",
    "db": "c#", "c#": "db", "gb": "f#", "f#": "gb",
}


def _key_variants(name: str) -> list[str]:
    root, _, mode = name.partition(" ")
    short_mode = "m" if mode.startswith("min") else ""
    roots = [root]
    alt = _ENHARMONIC.get(root.lower())
    if alt:
        roots.append(alt.capitalize() if len(alt) == 1 else alt[0].upper() + alt[1:])
    out: list[str] = []
    for r in roots:
        out.append(f"{r} {mode}".lower())
        out.append(f"{r}{short_mode}".lower())
        out.append(f"{r} {'min' if short_mode else 'maj'}".lower())
    return out


KEY_TO_CAMELOT: dict[str, str] = {}
for _code, _name in CAMELOT_TO_KEY.items():
    for _variant in _key_variants(_name):
        KEY_TO_CAMELOT.setdefault(_variant, _code)

_CAMELOT_RE = re.compile(r"^(1[0-2]|[1-9])\s*([ABab])$")

RELATION_LABELS: dict[str, str] = {
    "same": "同调",
    "energy_up": "提能量",
    "energy_down": "降能量",
    "relative": "转大小调",
    "energy_boost": "情绪跳",
    "two_step": "跨两格",
    "diagonal": "斜接",
}

# 调性距离：越远排得越后（进 score 的加权距离）
_RELATION_DISTANCE: dict[str, float] = {
    "same": 0.0,
    "energy_up": 1.0,
    "energy_down": 1.0,
    "relative": 1.2,
    "energy_boost": 2.0,
    "two_step": 2.4,
    "diagonal": 2.8,
}


class TrackNotFound(LookupError):
    """patch 一个不存在的 track 时抛，app 层转 404。"""


# ---------------------------------------------------------------- 工具


def now_iso() -> str:
    """ISO8601 UTC。用文本存是为了让 ORDER BY added_at 直接按时间排。"""
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def normalize_path(path: str | Path) -> str:
    """入库的 path 是 UNIQUE 键，写入和查询必须用同一套归一化规则。

    只做 expanduser + abspath + normpath，**不做 realpath**：
    符号链接解析会让下载器传进来的路径和扫描出来的路径对不上。
    """
    return os.path.normpath(os.path.abspath(os.path.expanduser(str(path))))


def parse_key_filter(value: str) -> tuple[str, str]:
    """把用户输入的调性过滤条件解析成 (camelot, 原始文本)。

    既接受 "8A"/"8a"，也接受 "A minor"/"Am"/"a min"。
    认不出来就返回 ("", 原始文本)，由调用方退化成 music_key 模糊匹配。
    """
    raw = (value or "").strip()
    if not raw:
        return "", ""
    m = _CAMELOT_RE.match(raw.replace(" ", ""))
    if m:
        return f"{int(m.group(1))}{m.group(2).upper()}", raw
    return KEY_TO_CAMELOT.get(raw.lower().replace("♯", "#").replace("♭", "b"), ""), raw


def camelot_wrap(number: int) -> int:
    """1..12 的环形（12 + 1 = 1）。"""
    return ((number - 1) % 12) + 1


def split_camelot(camelot: str) -> tuple[int, str] | None:
    m = _CAMELOT_RE.match((camelot or "").strip().replace(" ", ""))
    if not m:
        return None
    return int(m.group(1)), m.group(2).upper()


def camelot_relations(camelot: str, *, wide: bool = False) -> dict[str, str]:
    """给定 Camelot 返回 {兼容调: relation}。

    核心四条（规则见文档第 5 节）：同号 / ±1 同字母 / 同号异字母（相对大小调）。

    `wide=True` 再加两组现场真会用、但听感变化更明显的：
    `+7 同字母`（情绪跳）和 `±2 同字母`（跨两格）。它们排序时会被 _RELATION_DISTANCE
    压后，所以打开之后只是"列表更长"，不会把稳妥的选项挤下去。
    """
    parsed = split_camelot(camelot)
    if parsed is None:
        return {}
    number, letter = parsed
    other = "B" if letter == "A" else "A"
    out = {
        f"{number}{letter}": "same",
        f"{camelot_wrap(number + 1)}{letter}": "energy_up",
        f"{camelot_wrap(number - 1)}{letter}": "energy_down",
        f"{number}{other}": "relative",
    }
    if wide:
        # setdefault：小调号绕圈之后可能和上面撞车，先到的关系更近，不要覆盖
        out.setdefault(f"{camelot_wrap(number + 7)}{letter}", "energy_boost")
        out.setdefault(f"{camelot_wrap(number + 2)}{letter}", "two_step")
        out.setdefault(f"{camelot_wrap(number - 2)}{letter}", "two_step")
        # 相邻调的相对大小调：换调又换调式，属于"敢接才接"，排最后
        out.setdefault(f"{camelot_wrap(number + 1)}{other}", "diagonal")
        out.setdefault(f"{camelot_wrap(number - 1)}{other}", "diagonal")
    return out


def bpm_bucket(bpm: float) -> str:
    """统计用的 BPM 分档，键就是前端要显示的字符串。"""
    if bpm < 90:
        return "<90"
    if bpm >= 170:
        return "170+"
    low = int(bpm // 10 * 10)
    return f"{low}-{low + 9}"


BPM_BUCKET_ORDER: tuple[str, ...] = (
    "<90", "90-99", "100-109", "110-119", "120-129",
    "130-139", "140-149", "150-159", "160-169", "170+",
)


def _like(term: str) -> str:
    """LIKE 通配符转义。用户搜 "50%" 不该变成匹配一切。"""
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped.lower()}%"


def _escape_like(term: str) -> str:
    """只做 LIKE 通配符转义，不加 %，也不转小写。

    路径不做 LOWER()：入库时存的是文件系统给的原样大小写，
    比较也按原样，才不会在大小写敏感的文件系统上漏掉曲目。
    """
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _chunks(items: Sequence[int], size: int = 900) -> Iterable[Sequence[int]]:
    """SQLite 的 IN (...) 有参数个数上限（默认 999），大列表必须切块。"""
    for i in range(0, len(items), size):
        yield items[i : i + size]


# sort 白名单：绝对不能把 query string 直接拼进 ORDER BY（SQL 注入），
# 也不能只做转义——SQLite 的标识符引用规则太松，白名单映射是唯一安全的做法。
SORT_COLUMNS: dict[str, str] = {
    "added_at": "added_at",
    "modified_at": "modified_at",
    "analyzed_at": "analyzed_at",
    "title": "title",
    "artist": "artist",
    "album": "album",
    "genre": "genre",
    "year": "year",
    "filename": "filename",
    "duration": "duration",
    "bpm": "bpm",
    "energy": "energy",
    "rating": "rating",
    "size": "size",
    # Camelot 直接按字符串排会得到 "10A" < "8A"，必须拆成 数字*2 + 字母
    "camelot": (
        "(CASE WHEN camelot IS NULL OR camelot = '' THEN NULL ELSE "
        "CAST(SUBSTR(camelot, 1, LENGTH(camelot) - 1) AS INTEGER) * 2 "
        "+ (CASE WHEN UPPER(SUBSTR(camelot, -1)) = 'B' THEN 1 ELSE 0 END) END)"
    ),
}
SORT_COLUMNS["key"] = SORT_COLUMNS["camelot"]

DEFAULT_SORT = "added_at"


class LibraryService:
    def __init__(self, db: Database) -> None:
        self.db = db
        # 幂等，重复调用无害；保证任何入口拿到的都是建好表的库
        self.db.init_schema()

    # ------------------------------------------------------------ 读

    def list_tracks(
        self,
        *,
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
        where: list[str] = []
        params: list[Any] = []

        folder = (folder or "").strip().rstrip("/")
        if folder:
            # 按路径前缀过滤。folder_deep=False 时再排掉"还有下一层分隔符"的，
            # 这样点开一个文件夹看到的就是它本层的东西，和访达一致；
            # 想连子文件夹一起看再打开开关。
            prefix = _escape_like(normalize_path(folder) + os.sep)
            where.append("path LIKE ? ESCAPE '\\'")
            params.append(f"{prefix}%")
            if not folder_deep:
                # 再往下还有一层分隔符的（= 在子目录里）排掉。
                # os.sep 必须过转义：Windows 的分隔符恰好是 LIKE 的转义符 '\'，
                # 裸拼出来的 %\% 意思是"字面百分号"，子目录一个都排不掉。
                where.append("path NOT LIKE ? ESCAPE '\\'")
                params.append(f"{prefix}%{_escape_like(os.sep)}%")

        q = (q or "").strip()
        if q:
            # 标题/艺人/专辑/文件名一起匹配，大小写不敏感
            needle = _like(q)
            where.append(
                "(LOWER(COALESCE(title, '')) LIKE ? ESCAPE '\\'"
                " OR LOWER(COALESCE(artist, '')) LIKE ? ESCAPE '\\'"
                " OR LOWER(COALESCE(album, '')) LIKE ? ESCAPE '\\'"
                " OR LOWER(COALESCE(filename, '')) LIKE ? ESCAPE '\\')"
            )
            params.extend([needle] * 4)

        camelot, raw_key = parse_key_filter(key)
        if camelot:
            where.append("UPPER(COALESCE(camelot, '')) = ?")
            params.append(camelot)
        elif raw_key:
            where.append("LOWER(COALESCE(music_key, '')) LIKE ? ESCAPE '\\'")
            params.append(_like(raw_key))

        if bpm_min is not None:
            where.append("bpm IS NOT NULL AND bpm >= ?")
            params.append(float(bpm_min))
        if bpm_max is not None:
            where.append("bpm IS NOT NULL AND bpm <= ?")
            params.append(float(bpm_max))
        if energy_min is not None:
            where.append("energy IS NOT NULL AND energy >= ?")
            params.append(int(energy_min))
        if analyzed is True:
            where.append("analyzed_at IS NOT NULL")
        elif analyzed is False:
            where.append("analyzed_at IS NULL")

        clause = f" WHERE {' AND '.join(where)}" if where else ""

        sort_key = (sort or "").strip().lower()
        limit = max(1, min(int(limit or 200), 2000))
        offset = max(0, int(offset or 0))

        if sort_key == "custom" and folder and not folder_deep:
            # 手排模式：顺序在这个文件夹自己的 .kumodeck.json 里（文件名列表）。
            # 单个 set 文件夹最多几百首，全取出来按清单排再切页，
            # 比往 SQL 里拼几百个 WHEN 的 CASE 干净，也复用同一套 WHERE。
            from .folders import read_manifest

            conn = self.db.connect()
            total = int(
                conn.execute(f"SELECT COUNT(*) AS n FROM tracks{clause}", params).fetchone()["n"]
            )
            rows = list(conn.execute(f"SELECT * FROM tracks{clause}", params).fetchall())
            listed = [
                name
                for name in (read_manifest(Path(folder)).get("order") or [])
                if isinstance(name, str)
            ]
            position = {name: index for index, name in enumerate(listed)}
            tail = len(position)
            # 清单里没有的（新扫进来的）按文件名排在后面，和文件夹树同一条规则
            rows.sort(key=lambda r: (position.get(str(r["filename"]), tail), str(r["filename"]).lower()))
            page = rows[offset : offset + limit]
            tag_map = self._tags_for(conn, [int(r["id"]) for r in page])
            items = [self._row_to_track(r, tag_map.get(int(r["id"]), [])) for r in page]
            return TrackPage(items=items, total=total, offset=offset, limit=limit)

        column = SORT_COLUMNS.get(sort_key, SORT_COLUMNS[DEFAULT_SORT])
        direction = "ASC" if (order or "").strip().lower() == "asc" else "DESC"

        conn = self.db.connect()
        total = int(conn.execute(f"SELECT COUNT(*) AS n FROM tracks{clause}", params).fetchone()["n"])
        # `<col> IS NULL` 放第一排序键 = 空值永远垫底（升序降序都一样），
        # 再拿 id 兜底保证分页稳定不重复
        rows = conn.execute(
            f"SELECT * FROM tracks{clause} ORDER BY ({column}) IS NULL, ({column}) {direction}, id DESC"
            " LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()

        tag_map = self._tags_for(conn, [int(r["id"]) for r in rows])
        items = [self._row_to_track(r, tag_map.get(int(r["id"]), [])) for r in rows]
        return TrackPage(items=items, total=total, offset=offset, limit=limit)

    def get(self, track_id: int) -> Track | None:
        conn = self.db.connect()
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (int(track_id),)).fetchone()
        if row is None:
            return None
        return self._row_to_track(row, self._tags_for(conn, [int(row["id"])]).get(int(row["id"]), []))

    def get_by_path(self, path: str) -> Track | None:
        conn = self.db.connect()
        row = conn.execute("SELECT * FROM tracks WHERE path = ?", (normalize_path(path),)).fetchone()
        if row is None:
            return None
        return self._row_to_track(row, self._tags_for(conn, [int(row["id"])]).get(int(row["id"]), []))

    # ------------------------------------------------------------ 写

    def patch(self, track_id: int, patch: TrackPatch) -> Track:
        track_id = int(track_id)
        conn = self.db.connect()
        if conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone() is None:
            raise TrackNotFound(track_id)

        fields: dict[str, Any] = {}
        for name in ("rating", "color", "comment", "cue_ms", "title", "artist", "album", "genre"):
            value = getattr(patch, name, None)
            if value is not None:
                fields[name] = value
        if "rating" in fields:
            fields["rating"] = max(0, min(5, int(fields["rating"])))

        tags = getattr(patch, "tags", None)
        with conn:
            if fields:
                fields["modified_at"] = now_iso()
                assignments = ", ".join(f"{k} = ?" for k in fields)  # 键全是上面写死的字面量
                conn.execute(
                    f"UPDATE tracks SET {assignments} WHERE id = ?", [*fields.values(), track_id]
                )
            if tags is not None:
                conn.execute("DELETE FROM tags WHERE track_id = ?", (track_id,))
                cleaned = {t.strip() for t in tags if t and t.strip()}
                conn.executemany(
                    "INSERT OR IGNORE INTO tags (track_id, tag) VALUES (?, ?)",
                    [(track_id, t) for t in sorted(cleaned)],
                )
                if not fields:
                    conn.execute("UPDATE tracks SET modified_at = ? WHERE id = ?", (now_iso(), track_id))

        track = self.get(track_id)
        if track is None:  # pragma: no cover - 上面刚确认存在
            raise TrackNotFound(track_id)
        return track

    def delete(self, track_id: int, delete_file: bool = False) -> bool:
        track_id = int(track_id)
        conn = self.db.connect()
        row = conn.execute("SELECT path FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if row is None:
            return False
        with conn:
            conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
            conn.execute("DELETE FROM tags WHERE track_id = ?", (track_id,))
            conn.execute("DELETE FROM playlist_items WHERE track_id = ?", (track_id,))
        if delete_file:
            # 文件删不掉（权限/已被移走）不该让接口失败，记录已从库里移除即可
            try:
                Path(row["path"]).unlink()
            except OSError:
                pass
        return True

    def upsert_file(self, path: Path, *, source_platform: str = "local", source_key: str = "") -> int:
        """把一个音频文件写进库，返回 track id。同一路径重复调用是幂等的。"""
        key_path = normalize_path(path)
        file_path = Path(key_path)
        try:
            stat = file_path.stat()
        except OSError as exc:
            raise FileNotFoundError(f"无法读取文件: {key_path}") from exc
        mtime = float(stat.st_mtime)
        size = int(stat.st_size)

        conn = self.db.connect()
        row = conn.execute(
            "SELECT id, file_mtime, size, source_platform, source_key FROM tracks WHERE path = ?",
            (key_path,),
        ).fetchone()
        if row is not None:
            old_mtime = row["file_mtime"]
            # 增量：mtime + size 都没变就直接返回，省掉读标签（扫描里最贵的一步）
            if old_mtime is not None and abs(float(old_mtime) - mtime) < 1e-6 and int(row["size"] or 0) == size:
                # 唯一例外：来源信息是调用方带进来的（下载完成时补登记），
                # 文件没变也要认，否则重复下载的曲目会一直挂着 local
                self._touch_source(conn, int(row["id"]), row, source_platform, source_key)
                return int(row["id"])

        tags = read_tags(file_path)
        title = tags.get("title") or file_path.stem
        now = now_iso()

        if row is None:
            try:
                with conn:
                    cursor = conn.execute(
                        "INSERT INTO tracks (path, filename, title, artist, album, genre, year,"
                        " duration, bitrate, samplerate, channels, format, size,"
                        " source_platform, source_key, added_at, modified_at, file_mtime,"
                        " rating, analysis_error)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')",
                        (
                            key_path, file_path.name, title,
                            tags.get("artist", ""), tags.get("album", ""),
                            tags.get("genre", ""), tags.get("year", ""),
                            tags.get("duration"), tags.get("bitrate"),
                            tags.get("samplerate"), tags.get("channels"),
                            tags.get("format", ""), size,
                            source_platform or "local", source_key or "",
                            now, now, mtime,
                        ),
                    )
                return int(cursor.lastrowid)
            except sqlite3.IntegrityError:
                # 两个扫描线程同时撞到同一个文件：UNIQUE(path) 拦下后回读即可
                again = conn.execute("SELECT id FROM tracks WHERE path = ?", (key_path,)).fetchone()
                if again is None:
                    raise
                row = again

        track_id = int(row["id"])
        # 文件内容变了：技术字段一定更新；文本标签只在**读到非空值**时覆盖，
        # 避免标签被清空或读失败时把库里已有的信息（含用户手改过的）抹掉。
        fields: dict[str, Any] = {
            "filename": file_path.name,
            "size": size,
            "file_mtime": mtime,
            "modified_at": now,
        }
        for name in ("artist", "album", "genre", "year", "format"):
            value = tags.get(name) or ""
            if value:
                fields[name] = value
        if tags.get("title"):
            fields["title"] = tags["title"]
        for name in ("duration", "bitrate", "samplerate", "channels"):
            if tags.get(name):
                fields[name] = tags[name]
        if source_platform and source_platform != "local":
            fields["source_platform"] = source_platform
        if source_key:
            fields["source_key"] = source_key

        # 注意：**不清空**分析结果。写回标签（write_analysis_tags）本身会改 mtime，
        # 若这里把 analyzed_at 置空，每次写完标签再扫描就会无限重分析。
        assignments = ", ".join(f"{k} = ?" for k in fields)
        with conn:
            conn.execute(f"UPDATE tracks SET {assignments} WHERE id = ?", [*fields.values(), track_id])
        return track_id

    @staticmethod
    def _touch_source(
        conn: sqlite3.Connection,
        track_id: int,
        row: sqlite3.Row,
        source_platform: str,
        source_key: str,
    ) -> None:
        fields: dict[str, Any] = {}
        if source_platform and source_platform != "local" and row["source_platform"] != source_platform:
            fields["source_platform"] = source_platform
        if source_key and row["source_key"] != source_key:
            fields["source_key"] = source_key
        if not fields:
            return
        assignments = ", ".join(f"{k} = ?" for k in fields)
        with conn:
            conn.execute(f"UPDATE tracks SET {assignments} WHERE id = ?", [*fields.values(), track_id])

    def save_analysis(self, track_id: int, result: Any) -> None:
        """写入 AnalysisResult。

        参数用鸭子类型取值而不是 import AnalysisResult：分析层依赖 numpy/ffmpeg，
        曲库层不该被它拖下水（缺 ffmpeg 时曲库仍要能用）。
        """
        track_id = int(track_id)
        errors = list(getattr(result, "errors", None) or [])
        now = now_iso()
        fields: dict[str, Any] = {
            "bpm": _clean_float(getattr(result, "bpm", None)),
            "bpm_confidence": _clean_float(getattr(result, "bpm_confidence", None)),
            "first_beat": _clean_float(getattr(result, "first_beat", None)),
            "music_key": _text(getattr(result, "key", "")),
            "camelot": _text(getattr(result, "camelot", "")).upper(),
            "open_key": _text(getattr(result, "open_key", "")),
            "key_confidence": _clean_float(getattr(result, "key_confidence", None)),
            "energy": _clean_int(getattr(result, "energy", None)),
            "rms_db": _clean_float(getattr(result, "rms_db", None)),
            "peak_db": _clean_float(getattr(result, "peak_db", None)),
            # 即使子分析失败也要盖上 analyzed_at，否则 pending 队列永远清不空、
            # 每次「分析未分析曲目」都会把坏文件重跑一遍。想重试用 force。
            "analyzed_at": now,
            "modified_at": now,
            "analysis_error": "; ".join(str(e) for e in errors),
        }
        duration = _clean_float(getattr(result, "duration", None))
        conn = self.db.connect()
        assignments = ", ".join(f"{k} = ?" for k in fields)
        with conn:
            conn.execute(f"UPDATE tracks SET {assignments} WHERE id = ?", [*fields.values(), track_id])
            if duration:
                # 解码出来的时长比容器头里的更准，但只在库里没有时补
                conn.execute(
                    "UPDATE tracks SET duration = ? WHERE id = ? AND (duration IS NULL OR duration <= 0)",
                    (duration, track_id),
                )

    # ------------------------------------------------------------ 分析队列

    def pending_analysis_ids(self, track_ids: list[int] | None, force: bool) -> list[int]:
        """返回需要分析的 track id。force=True 时不管分析过没有全都返回。"""
        conn = self.db.connect()
        condition = "" if force else " WHERE analyzed_at IS NULL"
        if track_ids is None:
            rows = conn.execute(f"SELECT id FROM tracks{condition} ORDER BY id").fetchall()
            return [int(r["id"]) for r in rows]

        wanted = [int(t) for t in track_ids]
        if not wanted:
            return []
        found: set[int] = set()
        for chunk in _chunks(wanted):
            placeholders = ",".join("?" * len(chunk))
            where = f" WHERE id IN ({placeholders})" + ("" if force else " AND analyzed_at IS NULL")
            for r in conn.execute(f"SELECT id FROM tracks{where}", list(chunk)):
                found.add(int(r["id"]))
        # 保持调用方给的顺序（前端选中的顺序 = 用户期望的分析顺序）
        seen: set[int] = set()
        return [t for t in wanted if t in found and not (t in seen or seen.add(t))]

    # ------------------------------------------------------------ 和声推荐

    def harmonic_matches(
        self,
        track_id: int,
        bpm_tolerance: float,
        limit: int,
        *,
        wide: bool = True,
    ) -> list[HarmonicMatch]:
        """Camelot 兼容 + BPM 接近的候选，score 越大越靠前。

        默认走 wide：宁可多列几首让人自己挑，也不要因为规则太紧而空手。
        排序把稳妥的选项放前面，所以"更多"不会变成"更差"。
        """
        source = self.get(int(track_id))
        if source is None or not source.camelot:
            return []
        relations = camelot_relations(source.camelot, wide=wide)
        if not relations:
            return []

        tolerance = float(bpm_tolerance) if bpm_tolerance and bpm_tolerance > 0 else 6.0
        limit = max(1, min(int(limit or 50), 500))

        conn = self.db.connect()
        placeholders = ",".join("?" * len(relations))
        params: list[Any] = [*relations.keys(), int(track_id)]
        bpm_clause = ""
        if source.bpm:
            # BPM 范围下推到 SQL，别把整个兼容调的曲目都拉进内存再筛。
            # ratio r 下候选要落在 [(src-tol)/r, (src+tol)/r]；BETWEEN 遇到 NULL 为假，
            # 顺带把没分析出 BPM 的候选也挡掉了。
            low, high = float(source.bpm) - tolerance, float(source.bpm) + tolerance
            ranges = [(low, high), (low * 2, high * 2), (low / 2, high / 2)]
            bpm_clause = " AND (" + " OR ".join(["bpm BETWEEN ? AND ?"] * len(ranges)) + ")"
            for lo, hi in ranges:
                params.extend([lo, hi])
        rows = conn.execute(
            f"SELECT * FROM tracks WHERE UPPER(COALESCE(camelot, '')) IN ({placeholders})"
            f" AND id != ?{bpm_clause}",
            params,
        ).fetchall()
        tag_map = self._tags_for(conn, [int(r["id"]) for r in rows])

        matches: list[HarmonicMatch] = []
        for row in rows:
            relation = relations.get(_text(row["camelot"]).upper())
            if relation is None:
                continue
            candidate_bpm = row["bpm"]

            if source.bpm and candidate_bpm:
                aligned = _best_tempo(float(candidate_bpm), float(source.bpm), tolerance)
                if aligned is None:
                    continue
                ratio, delta = aligned
            elif source.bpm and not candidate_bpm:
                # 本曲有 BPM、候选没分析出 BPM：没法确认能不能对拍，直接排除
                continue
            else:
                ratio, delta = 1.0, 0.0

            distance = (
                abs(delta) / max(tolerance, 0.5)
                + 0.5 * _RELATION_DISTANCE[relation]
                + (0.0 if ratio == 1.0 else 0.75)  # 半速/倍速能接，但不如同速自然
            )
            matches.append(
                HarmonicMatch(
                    track=self._row_to_track(row, tag_map.get(int(row["id"]), [])),
                    relation=relation,
                    relation_label=RELATION_LABELS[relation],
                    bpm_delta=round(delta, 2),
                    tempo_ratio=ratio,
                    score=round(1.0 / (1.0 + distance), 4),
                )
            )

        matches.sort(key=lambda m: (-m.score, abs(m.bpm_delta), m.track.title.lower()))
        # 同一首歌常常在好几个 set 文件夹里各有一份（硬链接/拷贝），
        # 不去重的话推荐列表会连着四行 EMOTION。按 标题+艺人 归一后只留分数最高的；
        # 没有标题的退回文件名，免得一堆未打标签的被并成一条。
        seen: set[tuple[str, str]] = set()
        unique: list[HarmonicMatch] = []
        for match in matches:
            track = match.track
            ident = (
                (track.title or track.filename).strip().lower(),
                (track.artist or "").strip().lower(),
            )
            if ident in seen:
                continue
            seen.add(ident)
            unique.append(match)
        return unique[:limit]

    # ------------------------------------------------------------ 统计

    def stats(self) -> LibraryStats:
        conn = self.db.connect()
        row = conn.execute(
            "SELECT COUNT(*) AS total,"
            " SUM(CASE WHEN analyzed_at IS NOT NULL THEN 1 ELSE 0 END) AS analyzed,"
            " COALESCE(SUM(duration), 0) AS total_duration,"
            " COALESCE(SUM(size), 0) AS total_size FROM tracks"
        ).fetchone()

        by_camelot: dict[str, int] = {}
        for r in conn.execute(
            "SELECT UPPER(camelot) AS c, COUNT(*) AS n FROM tracks"
            " WHERE camelot IS NOT NULL AND camelot != '' GROUP BY UPPER(camelot)"
        ):
            by_camelot[str(r["c"])] = int(r["n"])
        # 按轮盘顺序输出，前端画 Camelot 轮时不用再排
        ordered_camelot = {c: by_camelot[c] for c in CAMELOT_TO_KEY if c in by_camelot}

        buckets: dict[str, int] = {}
        for r in conn.execute("SELECT bpm FROM tracks WHERE bpm IS NOT NULL AND bpm > 0"):
            name = bpm_bucket(float(r["bpm"]))
            buckets[name] = buckets.get(name, 0) + 1
        ordered_buckets = {b: buckets[b] for b in BPM_BUCKET_ORDER if b in buckets}

        by_platform: dict[str, int] = {}
        for r in conn.execute(
            "SELECT COALESCE(NULLIF(source_platform, ''), 'local') AS p, COUNT(*) AS n"
            " FROM tracks GROUP BY p"
        ):
            by_platform[str(r["p"])] = int(r["n"])

        return LibraryStats(
            total=int(row["total"] or 0),
            analyzed=int(row["analyzed"] or 0),
            total_duration=float(row["total_duration"] or 0.0),
            total_size=int(row["total_size"] or 0),
            by_camelot=ordered_camelot,
            by_bpm_bucket=ordered_buckets,
            by_platform=by_platform,
        )

    # ------------------------------------------------------------ 文件夹

    def all_paths(self) -> list[str]:
        """全部曲目路径。文件夹树按它统计每个目录下有几首。"""
        conn = self.db.connect()
        return [str(row["path"]) for row in conn.execute("SELECT path FROM tracks")]

    def relocate(self, track_id: int, new_path: Path) -> Track:
        """曲目文件被移动之后，把库里的 path/filename 跟着改掉。

        不重新读标签：移动不改内容，重读一遍是纯浪费；
        分析结果、评分、备注全都原样保留——这正是"移动"和"删了再扫"的区别。
        """
        track_id = int(track_id)
        key_path = normalize_path(new_path)
        conn = self.db.connect()
        with conn:
            conn.execute(
                "UPDATE tracks SET path = ?, filename = ?, modified_at = ? WHERE id = ?",
                (key_path, os.path.basename(key_path), now_iso(), track_id),
            )
        track = self.get(track_id)
        if track is None:
            raise TrackNotFound(track_id)
        return track

    def rebase_paths(self, old_dir: Path, new_dir: Path) -> list[int]:
        """目录改名后，把该目录下所有曲目的 path 前缀整体换掉，返回受影响的 id。

        用 Python 改而不是一条 `UPDATE ... replace(path, ?, ?)`：SQL 的 replace
        会替换字符串里**每一处**匹配，路径里恰好出现两次同名片段时就会改错
        （`/Music/set1/set1/a.mp3` 这种目录并不罕见）。
        """
        old_prefix = normalize_path(old_dir) + os.sep
        new_prefix = normalize_path(new_dir) + os.sep
        conn = self.db.connect()
        rows = conn.execute(
            "SELECT id, path FROM tracks WHERE path LIKE ? ESCAPE '\\'",
            (f"{_escape_like(old_prefix)}%",),
        ).fetchall()
        if not rows:
            return []
        stamp = now_iso()
        updates = [
            (new_prefix + str(row["path"])[len(old_prefix) :], stamp, int(row["id"]))
            for row in rows
        ]
        with conn:
            conn.executemany(
                "UPDATE tracks SET path = ?, modified_at = ? WHERE id = ?", updates
            )
        return [int(row["id"]) for row in rows]

    def clone_metadata(self, source_id: int, target_id: int) -> None:
        """把分析结果和人工标记复制到链接出来的那一份上。

        链接的两端是同一份音频，重新分析必然得到同样的 BPM / 调号，
        让用户为了一个链接再等一次分析没有道理。评分和备注一并带过去，
        因为在 DJ 眼里那就是"同一首歌"。
        """
        conn = self.db.connect()
        columns = (
            "title", "artist", "album", "genre", "year", "duration", "bitrate",
            "samplerate", "channels", "format", "bpm", "bpm_confidence", "first_beat",
            "music_key", "camelot", "open_key", "key_confidence", "energy",
            "rms_db", "peak_db", "rating", "color", "comment", "cue_ms",
            "source_platform", "source_key", "analyzed_at", "analysis_error",
        )
        row = conn.execute(
            f"SELECT {', '.join(columns)} FROM tracks WHERE id = ?", (int(source_id),)
        ).fetchone()
        if row is None:
            return
        assignments = ", ".join(f"{name} = ?" for name in columns)  # 列名是上面写死的字面量
        with conn:
            conn.execute(
                f"UPDATE tracks SET {assignments}, modified_at = ? WHERE id = ?",
                [*[row[name] for name in columns], now_iso(), int(target_id)],
            )
            conn.execute("DELETE FROM tags WHERE track_id = ?", (int(target_id),))
            conn.execute(
                "INSERT OR IGNORE INTO tags (track_id, tag) SELECT ?, tag FROM tags WHERE track_id = ?",
                (int(target_id), int(source_id)),
            )

    # ------------------------------------------------------------ 扫描辅助

    def file_index(self) -> dict[str, tuple[int, float]]:
        """path → (id, file_mtime)。扫描前一次性拉出来做增量比对，
        比每个文件查一次库快一个数量级。"""
        conn = self.db.connect()
        out: dict[str, tuple[int, float]] = {}
        for row in conn.execute("SELECT id, path, file_mtime, size FROM tracks"):
            out[str(row["path"])] = (int(row["id"]), float(row["file_mtime"] or 0.0))
        return out

    # ------------------------------------------------------------ 内部

    @staticmethod
    def _tags_for(conn: sqlite3.Connection, track_ids: Sequence[int]) -> dict[int, list[str]]:
        """一次查完整页的 tags，避免 N+1。"""
        out: dict[int, list[str]] = {}
        if not track_ids:
            return out
        for chunk in _chunks(list(track_ids)):
            placeholders = ",".join("?" * len(chunk))
            for row in conn.execute(
                f"SELECT track_id, tag FROM tags WHERE track_id IN ({placeholders}) ORDER BY tag",
                list(chunk),
            ):
                out.setdefault(int(row["track_id"]), []).append(str(row["tag"]))
        return out

    @staticmethod
    def _row_to_track(row: sqlite3.Row, tags: Sequence[str] = ()) -> Track:
        data = {key: row[key] for key in row.keys()}
        return Track(
            id=int(data["id"]),
            path=_text(data.get("path")),
            filename=_text(data.get("filename")),
            title=_text(data.get("title")),
            artist=_text(data.get("artist")),
            album=_text(data.get("album")),
            genre=_text(data.get("genre")),
            year=_text(data.get("year")),
            duration=_clean_float(data.get("duration")),
            bitrate=_clean_int(data.get("bitrate")),
            samplerate=_clean_int(data.get("samplerate")),
            channels=_clean_int(data.get("channels")),
            format=_text(data.get("format")),
            size=int(data.get("size") or 0),
            bpm=_clean_float(data.get("bpm")),
            bpm_confidence=_clean_float(data.get("bpm_confidence")),
            first_beat=_clean_float(data.get("first_beat")),
            music_key=_text(data.get("music_key")),
            camelot=_text(data.get("camelot")).upper(),
            open_key=_text(data.get("open_key")),
            key_confidence=_clean_float(data.get("key_confidence")),
            energy=_clean_int(data.get("energy")),
            rms_db=_clean_float(data.get("rms_db")),
            peak_db=_clean_float(data.get("peak_db")),
            rating=int(data.get("rating") or 0),
            color=_text(data.get("color")),
            comment=_text(data.get("comment")),
            cue_ms=_clean_int(data.get("cue_ms")),
            source_platform=_text(data.get("source_platform")) or "local",
            source_key=_text(data.get("source_key")),
            analyzed_at=data.get("analyzed_at") or None,
            added_at=_text(data.get("added_at")),
            modified_at=_text(data.get("modified_at")),
            analysis_error=_text(data.get("analysis_error")),
            tags=list(tags),
            folder=os.path.dirname(_text(data.get("path"))),
            link=link_state(Path(_text(data.get("path")))),
        )


def _best_tempo(candidate_bpm: float, source_bpm: float, tolerance: float) -> tuple[float, float] | None:
    """在同速/半速/倍速里挑一个能对上的。

    返回 (tempo_ratio, bpm_delta)，delta 是**折算后**的差值（候选 BPM × ratio - 本曲 BPM）。
    172 和 86 在 DJ 眼里是同一个速度，只按原始 BPM 比会漏掉一半可用曲目。
    """
    best: tuple[float, float] | None = None
    for ratio in (1.0, 0.5, 2.0):  # 1.0 放最前，同分时优先同速
        delta = candidate_bpm * ratio - source_bpm
        if abs(delta) > tolerance:
            continue
        if best is None or abs(delta) < abs(best[1]):
            best = (ratio, delta)
    return best


def _clean_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN 进 JSON 会变成非法字面量
        return None
    return number


def _clean_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
