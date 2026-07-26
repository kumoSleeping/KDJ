"""SQLite 连接管理 + 建表 / 迁移。

建表语句逐字对应 `docs/00-architecture.md` 第 5 节，改这里必须先改文档。
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

# --- 逐字照抄 docs/00-architecture.md 第 5 节 ---------------------------------
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  title TEXT, artist TEXT, album TEXT, genre TEXT, year TEXT,
  duration REAL,           -- 秒
  bitrate INTEGER, samplerate INTEGER, channels INTEGER,
  format TEXT,             -- mp3/flac/m4a/wav
  size INTEGER,
  bpm REAL, bpm_confidence REAL,
  first_beat REAL,
  music_key TEXT,          -- "A minor"
  camelot TEXT,            -- "8A"
  open_key TEXT,
  key_confidence REAL,
  energy INTEGER,
  rms_db REAL, peak_db REAL,
  rating INTEGER DEFAULT 0,
  color TEXT,
  comment TEXT,
  cue_ms INTEGER,
  source_platform TEXT,    -- wyy/qqm/soundcloud/bilibili/local
  source_key TEXT,
  analyzed_at TEXT,        -- ISO8601，NULL = 未分析
  added_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  file_mtime REAL,
  analysis_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracks_camelot ON tracks(camelot);
CREATE INDEX IF NOT EXISTS idx_tracks_bpm ON tracks(bpm);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id INTEGER NOT NULL, track_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);
CREATE TABLE IF NOT EXISTS tags (
  track_id INTEGER NOT NULL, tag TEXT NOT NULL,
  PRIMARY KEY (track_id, tag)
);
"""

# 老库升级用：只列可空列（NOT NULL 列没法 ALTER ADD，而它们从 v1 起就存在）。
# 名字是模块常量、不来自外部输入，拼进 DDL 是安全的。
_MIGRATION_COLUMNS: tuple[tuple[str, str], ...] = (
    ("title", "TEXT"),
    ("artist", "TEXT"),
    ("album", "TEXT"),
    ("genre", "TEXT"),
    ("year", "TEXT"),
    ("duration", "REAL"),
    ("bitrate", "INTEGER"),
    ("samplerate", "INTEGER"),
    ("channels", "INTEGER"),
    ("format", "TEXT"),
    ("size", "INTEGER"),
    ("bpm", "REAL"),
    ("bpm_confidence", "REAL"),
    ("first_beat", "REAL"),
    ("music_key", "TEXT"),
    ("camelot", "TEXT"),
    ("open_key", "TEXT"),
    ("key_confidence", "REAL"),
    ("energy", "INTEGER"),
    ("rms_db", "REAL"),
    ("peak_db", "REAL"),
    ("rating", "INTEGER DEFAULT 0"),
    ("color", "TEXT"),
    ("comment", "TEXT"),
    ("cue_ms", "INTEGER"),
    ("source_platform", "TEXT"),
    ("source_key", "TEXT"),
    ("analyzed_at", "TEXT"),
    ("file_mtime", "REAL"),
    ("analysis_error", "TEXT"),
)


class Database:
    """每线程一条连接的 SQLite 封装。

    sidecar 会在线程池里并发写（扫描线程 + 分析线程 + HTTP 请求线程），所以：

    1. **不用** `check_same_thread=False` 共用一条连接——那样多线程写会互相踩游标，
       是最典型的 "Recursive use of cursors not allowed"。正确做法是 `threading.local()`
       每线程各持一条连接，由 SQLite 自己做文件级并发控制。
    2. `journal_mode=WAL`：默认的 rollback journal 下，读会阻塞写、写会阻塞读，
       边扫描边查列表必然报 "database is locked"。WAL 允许一写多读。
    3. `busy_timeout=5000`：WAL 下写-写仍然互斥，扫描线程和分析线程同时提交时
       后来者要等；不设 busy_timeout 会立刻抛 "database is locked" 而不是排队。
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._local = threading.local()
        self._lock = threading.Lock()
        # 记下所有连接只为了 close_all；线程退出后连接对象仍留在这里，
        # 但 sidecar 的线程池是有界的，不会无限增长。
        self._connections: dict[int, sqlite3.Connection] = {}

    # ------------------------------------------------------------ 连接

    def connect(self) -> sqlite3.Connection:
        """取当前线程的连接，没有就建一条。"""
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            return conn

        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)

        conn = sqlite3.connect(str(self.path), timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        # WAL 下 NORMAL 已经足够安全（崩溃最多丢最后一个事务，曲库可重扫）
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")

        self._local.conn = conn
        with self._lock:
            self._connections[threading.get_ident()] = conn
        return conn

    # ------------------------------------------------------------ 建表

    def init_schema(self) -> None:
        """幂等：全部 CREATE ... IF NOT EXISTS，外加缺列补齐。"""
        conn = self.connect()
        with self._lock:
            conn.executescript(SCHEMA_SQL)
            existing = {row["name"] for row in conn.execute("PRAGMA table_info(tracks)")}
            for name, decl in _MIGRATION_COLUMNS:
                if name not in existing:
                    conn.execute(f"ALTER TABLE tracks ADD COLUMN {name} {decl}")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)")
            conn.commit()

    # ------------------------------------------------------------ 关闭

    def close_all(self) -> None:
        """退出时收尾。

        sqlite3 连接只能在自己的线程里关，跨线程 close() 会抛 ProgrammingError，
        所以这里逐条 try 掉——进程都要退了，关不上也不影响数据（WAL 会自动恢复）。
        """
        with self._lock:
            connections = list(self._connections.values())
            self._connections.clear()
        for conn in connections:
            try:
                conn.close()
            except Exception:
                pass
        self._local = threading.local()
