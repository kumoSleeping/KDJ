//! SQLite 连接池 + 建表 / 迁移。
//!
//! 表结构和 v0.1.x **逐字一致**——用户手上已经有一个 `kumodeck.db`，
//! 里面躺着 1379 首歌的分析结果，schema 对不上就等于让人从头再扫一遍。

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;

pub type Conn = r2d2::PooledConnection<SqliteConnectionManager>;

/// 逐字照抄 v0.1.x 的 `library/db.py`。
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  title TEXT, artist TEXT, album TEXT, genre TEXT, year TEXT,
  duration REAL,
  bitrate INTEGER, samplerate INTEGER, channels INTEGER,
  format TEXT,
  size INTEGER,
  bpm REAL, bpm_confidence REAL,
  first_beat REAL,
  music_key TEXT,
  camelot TEXT,
  open_key TEXT,
  key_confidence REAL,
  energy INTEGER,
  rms_db REAL, peak_db REAL,
  rating INTEGER DEFAULT 0,
  color TEXT,
  comment TEXT,
  cue_ms INTEGER,
  source_platform TEXT,
  source_key TEXT,
  analyzed_at TEXT,
  added_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  file_mtime REAL,
  analysis_error TEXT
);
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
"#;

/// 索引**必须在补列之后**再建。
///
/// Python 版是先 `executescript`（里面含建索引）再 ALTER ADD COLUMN，
/// 于是"老库缺 camelot 列"时会卡在 `CREATE INDEX ... ON tracks(camelot)` 上。
/// 现实里没炸过（那些列从 v1 起就在），但顺序反了就是反了，这里改对。
const INDEX_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_tracks_camelot ON tracks(camelot);
CREATE INDEX IF NOT EXISTS idx_tracks_bpm ON tracks(bpm);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
CREATE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
"#;

/// 老库升级用：只列可空列（NOT NULL 列没法 ALTER ADD，而它们从 v1 起就存在）。
/// 名字是模块常量、不来自外部输入，拼进 DDL 是安全的。
const MIGRATION_COLUMNS: &[(&str, &str)] = &[
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
];

#[derive(Clone)]
pub struct Database {
    pool: Pool<SqliteConnectionManager>,
    path: PathBuf,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let manager = SqliteConnectionManager::file(path).with_init(|conn| {
            // WAL：默认的 rollback journal 下读会阻塞写、写会阻塞读，
            // 边扫描边查列表必然报 "database is locked"。WAL 允许一写多读。
            conn.pragma_update(None, "journal_mode", "WAL")?;
            // WAL 下写-写仍然互斥，扫描线程和分析线程同时提交时后来者要等；
            // 不设 busy_timeout 会立刻抛错而不是排队。
            conn.pragma_update(None, "busy_timeout", 5000)?;
            // WAL 下 NORMAL 已经足够安全（崩溃最多丢最后一个事务，曲库可重扫）
            conn.pragma_update(None, "synchronous", "NORMAL")?;
            conn.pragma_update(None, "foreign_keys", "ON")?;
            Ok(())
        });
        let pool = Pool::builder()
            .max_size(8)
            .build(manager)
            .with_context(|| format!("打开曲库失败：{}", path.display()))?;
        let db = Database {
            pool,
            path: path.to_path_buf(),
        };
        db.init_schema()?;
        Ok(db)
    }

    /// 测试用的内存库。
    pub fn open_in_memory() -> Result<Self> {
        let manager = SqliteConnectionManager::memory();
        // 内存库每条连接是独立的，池必须锁成 1 条，否则建表和查询看到的不是同一个库
        let pool = Pool::builder().max_size(1).build(manager)?;
        let db = Database {
            pool,
            path: PathBuf::from(":memory:"),
        };
        db.init_schema()?;
        Ok(db)
    }

    pub fn conn(&self) -> Result<Conn> {
        self.pool.get().context("获取曲库连接失败")
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 幂等：全部 `CREATE ... IF NOT EXISTS`，外加缺列补齐。
    pub fn init_schema(&self) -> Result<()> {
        let conn = self.conn()?;
        conn.execute_batch(SCHEMA_SQL).context("建表失败")?;

        let existing: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(tracks)")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        for (name, decl) in MIGRATION_COLUMNS {
            if !existing.iter().any(|column| column == name) {
                conn.execute_batch(&format!("ALTER TABLE tracks ADD COLUMN {name} {decl}"))
                    .with_context(|| format!("补列 {name} 失败"))?;
            }
        }

        conn.execute_batch(INDEX_SQL).context("建索引失败")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_idempotent() {
        let db = Database::open_in_memory().unwrap();
        // 重复建表不能报错
        db.init_schema().unwrap();
        db.init_schema().unwrap();
    }

    #[test]
    fn an_old_database_missing_columns_gets_them_added() {
        // 模拟 v1 的库：只有 NOT NULL 的几列
        let dir = std::env::temp_dir().join(format!("kumodeck-db-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE tracks (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   path TEXT NOT NULL UNIQUE,
                   filename TEXT NOT NULL,
                   added_at TEXT NOT NULL,
                   modified_at TEXT NOT NULL
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO tracks (path, filename, added_at, modified_at)
                 VALUES ('/a/b.mp3', 'b.mp3', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }

        let db = Database::open(&path).unwrap();
        let conn = db.conn().unwrap();
        // 补齐之后新列可读，老数据还在
        let (camelot, filename): (Option<String>, String) = conn
            .query_row("SELECT camelot, filename FROM tracks", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(camelot, None);
        assert_eq!(filename, "b.mp3");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_is_unique() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        let insert = "INSERT INTO tracks (path, filename, added_at, modified_at)
                      VALUES ('/a.mp3', 'a.mp3', 'now', 'now')";
        conn.execute(insert, []).unwrap();
        // 第二次必须被 UNIQUE 拦下（扫描线程并发撞到同一个文件时靠这个兜底）
        assert!(conn.execute(insert, []).is_err());
    }
}
