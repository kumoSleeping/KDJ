//! SQLite 连接池 + 建表 / 迁移。
//!
//! 本地曲库只由 `tracks` 文件记录组成；旧版本的 `stream_library` 表不再读取或创建。
//!
//! 核心表结构和 v0.1.x **逐字一致**——用户手上已经有一个 `kdj.db`，
//! 里面躺着 1379 首歌的分析结果，schema 对不上就等于让人从头再扫一遍。

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use kdj_core::musical_key::parse_musical_key;
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
  end_ms INTEGER,
  cue_points_json TEXT NOT NULL DEFAULT '[]',
  cue_points_managed INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS waveform_assets (
  track_id INTEGER PRIMARY KEY,
  profile TEXT NOT NULL,
  revision INTEGER NOT NULL,
  file_mtime INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS track_bpm_key_analysis_v2 (
  track_id INTEGER PRIMARY KEY,
  analyzer_revision TEXT NOT NULL,
  bpm REAL,
  bpm_raw REAL,
  bpm_confidence REAL,
  first_beat REAL,
  beat_origin REAL,
  beat_times_json TEXT NOT NULL DEFAULT '[]',
  downbeat_origin REAL,
  downbeats_json TEXT NOT NULL DEFAULT '[]',
  downbeat_confidence REAL,
  music_key TEXT,
  key_short TEXT,
  camelot TEXT,
  open_key TEXT,
  key_confidence REAL,
  chroma_json TEXT NOT NULL DEFAULT '[]',
  analyzed_at TEXT NOT NULL,
  analysis_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS kdj_schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS cleanup_waveform_asset
AFTER DELETE ON tracks BEGIN
  DELETE FROM waveform_assets WHERE track_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS cleanup_track_bpm_key_analysis_v2
AFTER DELETE ON tracks BEGIN
  DELETE FROM track_bpm_key_analysis_v2 WHERE track_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS cleanup_playlist_track_reference
AFTER DELETE ON tracks BEGIN
  DELETE FROM playlist_items WHERE track_id = OLD.id;
END;
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
CREATE INDEX IF NOT EXISTS idx_playlists_name ON playlists(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_playlist_items_position
  ON playlist_items(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_waveform_assets_profile ON waveform_assets(profile, revision);
CREATE INDEX IF NOT EXISTS idx_track_bpm_key_analysis_v2_revision
  ON track_bpm_key_analysis_v2(analyzer_revision, analyzed_at);
"#;

/// 老库升级用：只列可空列，或带常量默认值、可安全补入旧行的 NOT NULL 列。
/// 没有默认值的 NOT NULL 列没法 ALTER ADD，而它们从 v1 起就存在。
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
    ("end_ms", "INTEGER"),
    ("cue_points_json", "TEXT NOT NULL DEFAULT '[]'"),
    ("cue_points_managed", "INTEGER NOT NULL DEFAULT 0"),
    ("source_platform", "TEXT"),
    ("source_key", "TEXT"),
    ("analyzed_at", "TEXT"),
    ("file_mtime", "REAL"),
    ("analysis_error", "TEXT"),
];

/// 撞锁时排队等多久再放弃。扫描线程和分析线程都会写，5 秒够它们让开。
const BUSY_TIMEOUT_MS: u32 = 5000;

#[derive(Clone)]
pub struct Database {
    pool: Pool<SqliteConnectionManager>,
    path: PathBuf,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with_error_handler(path, None)
    }

    /// `error_handler` 只有测试会传（用来数建池阶段吞掉的错误）；
    /// 传 None 就是 r2d2 默认的 `LoggingErrorHandler`。
    fn open_with_error_handler(
        path: &Path,
        error_handler: Option<Box<dyn r2d2::HandleError<rusqlite::Error>>>,
    ) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        // WAL 必须在建池**之前**、用一条独立连接串行地切一次。
        //
        // 原本 `journal_mode=WAL` 是写在 `with_init` 里的，于是每条池连接都要切一次；
        // 而 r2d2 建池是拿内部线程池把 8 条连接**并发**建起来的。并发切 WAL 会撞车：
        // 实测 50 轮 × 8 线程，约 12% 的轮次有连接吃到 SQLITE_BUSY。
        //
        // 关键是 **busy_timeout 救不了它**——把 busy_timeout 挪到 journal_mode 前面，
        // 失败率纹丝不动（6/50 vs 5/50）。`PRAGMA journal_mode` 撞上并发的同类操作是
        // 直接返回 BUSY，不走 busy handler。r2d2 记一条 error 再退避重试，
        // 所以现象才是"启动刷两条 ERROR r2d2: database is locked，然后自己好了"
        // ——外加白等一轮退避（实测 ~400ms）。机器越忙越容易撞。
        //
        // journal_mode 是写进文件头的**持久**属性，设一次就跟着这个库文件走。
        // 建池前串行切好，池里的连接就永远不用再碰它，竞态从根上没了。
        prepare_journal_mode(path)?;

        let manager = SqliteConnectionManager::file(path).with_init(init_pooled_connection);
        let mut builder = Pool::builder().max_size(8);
        if let Some(handler) = error_handler {
            builder = builder.error_handler(handler);
        }
        let pool = builder
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
    ///
    /// 池必须锁成 1 条：`SqliteConnectionManager::memory()` 每次都是
    /// `Connection::open_in_memory()`，连接之间**不共享**同一个库，
    /// 第二条连接看到的是空库。
    ///
    /// 这个约束现在依然成立，但**代价**要记住：池只有 1 条连接，
    /// 内存库测试里所有访问都被串行化，**照不出任何锁竞争问题**——
    /// 上面那个 "database is locked" 就是这么躲过全部单测的。
    /// 所以凡是要验并发/锁行为的测试，一律用文件库（见 `pooled_connection_init_*`）。
    pub fn open_in_memory() -> Result<Self> {
        let manager = SqliteConnectionManager::memory();
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
        let mut conn = self.conn()?;
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

        let analysis_columns: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(track_bpm_key_analysis_v2)")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        for (name, decl) in [
            ("beat_origin", "REAL"),
            ("downbeat_origin", "REAL"),
            ("downbeats_json", "TEXT NOT NULL DEFAULT '[]'"),
            ("downbeat_confidence", "REAL"),
        ] {
            if !analysis_columns.iter().any(|column| column == name) {
                conn.execute_batch(&format!(
                    "ALTER TABLE track_bpm_key_analysis_v2 ADD COLUMN {name} {decl}"
                ))
                .with_context(|| format!("补分析列 {name} 失败"))?;
            }
        }

        conn.execute_batch(INDEX_SQL).context("建索引失败")?;
        migrate_key_notations(&mut conn)?;
        Ok(())
    }
}

/// 旧库和 OneLibrary 导入曾可能只保存自由文本 `music_key`。这里只补空的派生列，
/// 绝不改原调名、也不覆盖已有 Camelot/Open Key；重复启动执行结果相同。
fn migrate_key_notations(conn: &mut rusqlite::Connection) -> Result<()> {
    const MIGRATION: &str = "key-notations-v1";
    if conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM kdj_schema_migrations WHERE name = ?)",
        [MIGRATION],
        |row| row.get::<_, bool>(0),
    )? {
        return Ok(());
    }
    fn candidates(
        conn: &rusqlite::Connection,
        table: &str,
    ) -> Result<Vec<(i64, String, String, String)>> {
        let sql = format!(
            "SELECT track_id, COALESCE(music_key, ''), COALESCE(camelot, ''), \
             COALESCE(open_key, '') FROM {table} \
             WHERE TRIM(COALESCE(music_key, '')) != '' \
             AND (TRIM(COALESCE(camelot, '')) = '' OR TRIM(COALESCE(open_key, '')) = '')"
        );
        let id_column = if table == "tracks" { "id" } else { "track_id" };
        let sql = sql.replacen("SELECT track_id", &format!("SELECT {id_column}"), 1);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    let legacy = candidates(conn, "tracks")?;
    let v2 = candidates(conn, "track_bpm_key_analysis_v2")?;
    let tx = conn.transaction().context("开始调性表示迁移失败")?;
    for (table, rows) in [("tracks", legacy), ("track_bpm_key_analysis_v2", v2)] {
        let id_column = if table == "tracks" { "id" } else { "track_id" };
        let sql = format!(
            "UPDATE {table} SET \
             camelot = CASE WHEN TRIM(COALESCE(camelot, '')) = '' THEN ? ELSE camelot END, \
             open_key = CASE WHEN TRIM(COALESCE(open_key, '')) = '' THEN ? ELSE open_key END \
             WHERE {id_column} = ?"
        );
        for (track_id, music_key, camelot, open_key) in rows {
            let Some(key) = parse_musical_key(&music_key) else {
                continue;
            };
            tx.execute(
                &sql,
                rusqlite::params![
                    if camelot.trim().is_empty() {
                        key.camelot.as_str()
                    } else {
                        camelot.as_str()
                    },
                    if open_key.trim().is_empty() {
                        key.open_key.as_str()
                    } else {
                        open_key.as_str()
                    },
                    track_id,
                ],
            )?;
        }
    }
    tx.execute(
        "INSERT INTO kdj_schema_migrations (name, applied_at) VALUES (?, ?)",
        rusqlite::params![MIGRATION, chrono::Utc::now().to_rfc3339()],
    )?;
    tx.commit().context("提交调性表示迁移失败")?;
    Ok(())
}

/// 池连接的初始化。
///
/// **这里只许放连接级、不碰数据库文件的 pragma。** 凡是要改文件头（journal_mode
/// 之类）的，都得挪到 `prepare_journal_mode` 里串行做一次——r2d2 是并发建连接的，
/// 放在这里就是一个每次启动都可能中奖的竞态。
/// `pooled_connection_init_does_not_touch_journal_mode` 盯着这条。
fn init_pooled_connection(conn: &mut rusqlite::Connection) -> rusqlite::Result<()> {
    // 撞锁时排队而不是当场报错。扫描线程和分析线程会同时写，靠它把后来者挡住等一等。
    conn.pragma_update(None, "busy_timeout", BUSY_TIMEOUT_MS)?;
    // WAL 下 NORMAL 已经足够安全（崩溃最多丢最后一个事务，曲库可重扫）
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

/// 把库文件切到 WAL：一次 `open` 只做一遍，且必须在建池之前。
///
/// 为什么非要 WAL：默认的 rollback journal 下读会阻塞写、写会阻塞读，
/// 边扫描边查列表必然报 "database is locked"。WAL 允许一写多读。
///
/// 先设 busy_timeout 再切：并发切 WAL 那种撞车它管不了（见 `open_with_error_handler`
/// 的注释），但"库正被别的进程拿着写事务"这种普通占用它是管用的——
/// 开发时 Tauri 壳和独立 `kdj-server` 指着同一个库就是这种情况。
fn prepare_journal_mode(path: &Path) -> Result<()> {
    let conn = rusqlite::Connection::open(path)
        .with_context(|| format!("打开曲库失败：{}", path.display()))?;
    conn.pragma_update(None, "busy_timeout", BUSY_TIMEOUT_MS)
        .context("设置 busy_timeout 失败")?;
    let current: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .context("读取 journal_mode 失败")?;
    // journal_mode 是持久属性。绝大多数启动只需读一次；重复执行切换会在 Windows
    // 上额外获取文件锁，也可能触碰数据库头，低速盘上没有任何收益。
    if !current.eq_ignore_ascii_case("wal") {
        conn.pragma_update(None, "journal_mode", "WAL")
            .context("切换 WAL 失败")?;
    }
    Ok(())
}

/// 某一版桌面迁移曾把历史 `kumodeck.db` 复制成 `kdj.db`，但运行期仍打开
/// `kumodeck.db`，于是同一 data_dir 会分叉成两份曲库。这里做**只增不改**合并：
/// 当前库已有路径绝不覆盖；旧库独有曲目、标签和歌单按路径映射后补进来。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DatabaseMergeReport {
    pub tracks: usize,
    pub tags: usize,
    pub playlists: usize,
    pub playlist_items: usize,
}

pub fn merge_legacy_database(canonical: &Path, legacy: &Path) -> Result<DatabaseMergeReport> {
    anyhow::ensure!(canonical != legacy, "不能把数据库合并进自己");
    anyhow::ensure!(legacy.is_file(), "旧数据库不存在：{}", legacy.display());

    // 先用正常入口把当前库 schema 补齐；旧库只读 attach，不对它做任何改动。
    let database = Database::open(canonical)?;
    let mut conn = database.conn()?;
    conn.execute(
        "ATTACH DATABASE ? AS legacy",
        [legacy.to_string_lossy().as_ref()],
    )
    .with_context(|| format!("挂载旧数据库失败：{}", legacy.display()))?;

    let result = (|| -> Result<DatabaseMergeReport> {
        let columns = |schema: &str| -> Result<Vec<String>> {
            let mut stmt = conn.prepare(&format!("PRAGMA {schema}.table_info(tracks)"))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        };
        let main_columns = columns("main")?;
        let legacy_columns = columns("legacy")?;
        anyhow::ensure!(!legacy_columns.is_empty(), "旧数据库没有 tracks 表");
        let common: Vec<String> = main_columns
            .into_iter()
            .filter(|name| legacy_columns.contains(name))
            .collect();
        for required in ["id", "path", "filename", "added_at", "modified_at"] {
            anyhow::ensure!(
                common.iter().any(|name| name == required),
                "旧库缺少 {required} 列"
            );
        }
        let quoted = |names: &[String]| {
            names
                .iter()
                .map(|name| format!("\"{}\"", name.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(", ")
        };

        let tx = conn.transaction().context("开始数据库合并事务失败")?;
        // 先尽量保留旧 id，旧波形缓存便能继续命中；id 冲突但 path 不同的行
        // 再走第二轮自动分配新 id，不能因为编号撞车漏掉整首歌。
        let all = quoted(&common);
        let mut report = DatabaseMergeReport::default();
        report.tracks += tx.execute(
            &format!("INSERT OR IGNORE INTO tracks ({all}) SELECT {all} FROM legacy.tracks"),
            [],
        )?;
        let without_id: Vec<String> = common.into_iter().filter(|name| name != "id").collect();
        let body = quoted(&without_id);
        report.tracks += tx.execute(
            &format!("INSERT OR IGNORE INTO tracks ({body}) SELECT {body} FROM legacy.tracks"),
            [],
        )?;

        let legacy_has = |table: &str| -> Result<bool> {
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM legacy.sqlite_master WHERE type = 'table' AND name = ?",
                [table],
                |row| row.get(0),
            )?;
            Ok(count > 0)
        };
        if legacy_has("tags")? {
            report.tags = tx.execute(
                "INSERT OR IGNORE INTO tags (track_id, tag) \
                 SELECT current.id, source_tag.tag FROM legacy.tags source_tag \
                 JOIN legacy.tracks source ON source.id = source_tag.track_id \
                 JOIN tracks current ON current.path = source.path",
                [],
            )?;
        }

        if legacy_has("playlists")? && legacy_has("playlist_items")? {
            let source_playlists: Vec<(i64, String, String, String)> = {
                let mut stmt = tx.prepare(
                    "SELECT id, name, COALESCE(note, ''), created_at FROM legacy.playlists ORDER BY id",
                )?;
                let rows = stmt
                    .query_map([], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                rows
            };
            for (source_id, name, note, created_at) in source_playlists {
                let target_id: i64 = match tx.query_row(
                    "SELECT id FROM playlists WHERE name = ? ORDER BY id LIMIT 1",
                    [&name],
                    |row| row.get(0),
                ) {
                    Ok(id) => id,
                    Err(rusqlite::Error::QueryReturnedNoRows) => {
                        tx.execute(
                            "INSERT INTO playlists (name, note, created_at) VALUES (?, ?, ?)",
                            rusqlite::params![name, note, created_at],
                        )?;
                        report.playlists += 1;
                        tx.last_insert_rowid()
                    }
                    Err(err) => return Err(err.into()),
                };
                report.playlist_items += tx.execute(
                    "INSERT OR IGNORE INTO playlist_items (playlist_id, track_id, position) \
                     SELECT ?, current.id, source_item.position \
                     FROM legacy.playlist_items source_item \
                     JOIN legacy.tracks source ON source.id = source_item.track_id \
                     JOIN tracks current ON current.path = source.path \
                     WHERE source_item.playlist_id = ?",
                    rusqlite::params![target_id, source_id],
                )?;
            }
        }
        tx.commit().context("提交数据库合并失败")?;
        Ok(report)
    })();

    // DETACH 失败不应掩盖已经成功提交的结果；连接归还池时 SQLite 也会收掉 attach。
    let _ = conn.execute_batch("DETACH DATABASE legacy");
    result
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
        let dir = std::env::temp_dir().join(format!("kdj-db-{}", std::process::id()));
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
        let (camelot, filename, cue_points, cue_points_managed): (
            Option<String>,
            String,
            String,
            bool,
        ) = conn
            .query_row(
                "SELECT camelot, filename, cue_points_json, cue_points_managed FROM tracks",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(camelot, None);
        assert_eq!(filename, "b.mp3");
        assert_eq!(cue_points, "[]");
        assert!(!cue_points_managed);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_free_text_keys_gain_only_missing_derived_notations() {
        let dir = temp_dir("key-notation-migration");
        let path = dir.join("old.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE tracks (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   path TEXT NOT NULL UNIQUE,
                   filename TEXT NOT NULL,
                   music_key TEXT,
                   camelot TEXT,
                   open_key TEXT,
                   added_at TEXT NOT NULL,
                   modified_at TEXT NOT NULL
                 );
                 INSERT INTO tracks
                   (path, filename, music_key, camelot, open_key, added_at, modified_at)
                 VALUES
                   ('/a.mp3', 'a.mp3', 'F# M', '', NULL, '2020-01-01', '2020-01-01'),
                   ('/b.mp3', 'b.mp3', 'F# m', 'CUSTOM', '', '2020-01-01', '2020-01-01');",
            )
            .unwrap();
        }

        let db = Database::open(&path).unwrap();
        // 再跑一次，证明迁移幂等且不会把已有值重写。
        db.init_schema().unwrap();
        let conn = db.conn().unwrap();
        let first: (String, String, String) = conn
            .query_row(
                "SELECT music_key, camelot, open_key FROM tracks WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(first, ("F# M".into(), "2B".into(), "7d".into()));
        let second: (String, String) = conn
            .query_row(
                "SELECT camelot, open_key FROM tracks WHERE id = 2",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(second, ("CUSTOM".into(), "4m".into()));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// r2d2 建池阶段的错误只会进日志（默认 `LoggingErrorHandler`），
    /// 测试里得自己接住才能断言"一条都没有"。
    #[derive(Debug, Clone, Default)]
    struct CollectedPoolErrors(std::sync::Arc<std::sync::Mutex<Vec<String>>>);

    impl CollectedPoolErrors {
        fn take(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    impl r2d2::HandleError<rusqlite::Error> for CollectedPoolErrors {
        fn handle_error(&self, error: rusqlite::Error) {
            self.0.lock().unwrap().push(error.to_string());
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        // 同一进程里多个测试并行跑，光靠 pid 会撞名
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("kdj-{tag}-{}-{nonce}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 回归（确定性）：**池连接的初始化不许改 journal_mode**。
    ///
    /// 这是启动时那两条 `ERROR r2d2: database is locked` 的真因。
    /// `journal_mode=WAL` 曾经在 `with_init` 里，r2d2 并发建 8 条连接一起切，撞车。
    /// 直接断言"跑完 init 之后模式没变"，不依赖线程调度，一次就能钉死。
    #[test]
    fn pooled_connection_init_does_not_touch_journal_mode() {
        let dir = temp_dir("init");
        let path = dir.join("delete-mode.db");
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "DELETE").unwrap();

        init_pooled_connection(&mut conn).unwrap();

        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            mode, "delete",
            "池连接初始化改了 journal_mode——切它要独占文件、且不认 busy_timeout，\
             8 条连接并发建池时会撞出 database is locked。要切就去 prepare_journal_mode"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 上一条的压力版：50 轮 × 8 线程，每轮一个全新的库文件，一起跑 init。
    ///
    /// 老代码（init 里带 journal_mode）实测约 12% 的轮次会有线程吃到 SQLITE_BUSY，
    /// 50 轮基本必挂；现在 init 只剩连接级 pragma，压根不碰文件，一条都不该有。
    #[test]
    fn pooled_connection_init_is_safe_to_run_concurrently() {
        let dir = temp_dir("initrace");
        for round in 0..50 {
            let path = dir.join(format!("r{round}.db"));
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    let path = path.clone();
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        let mut conn = rusqlite::Connection::open(&path).unwrap();
                        barrier.wait();
                        init_pooled_connection(&mut conn).map_err(|err| err.to_string())
                    })
                })
                .collect();
            for handle in handles {
                handle
                    .join()
                    .unwrap()
                    .unwrap_or_else(|err| panic!("第 {round} 轮：并发初始化连接不该报错：{err}"));
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端：`open` 一个全新的库，r2d2 建池阶段一条错误都不许有，且确实切成了 WAL。
    #[test]
    fn opening_a_fresh_library_logs_no_pool_error() {
        let dir = temp_dir("fresh");
        let path = dir.join("new.db");

        // 冷启动：库文件还不存在
        let errors = CollectedPoolErrors::default();
        let db = Database::open_with_error_handler(&path, Some(Box::new(errors.clone()))).unwrap();
        assert!(
            errors.take().is_empty(),
            "建池阶段不该有错误：{:?}",
            errors.take()
        );

        // WAL 确实切上了——不然"没报错"可能只是因为压根没切
        let mode: String = db
            .conn()
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        drop(db);

        // 热启动：库已存在、-wal 还留着（应用被 kill 之后就是这个状态）
        let errors = CollectedPoolErrors::default();
        let _db = Database::open_with_error_handler(&path, Some(Box::new(errors.clone()))).unwrap();
        assert!(
            errors.take().is_empty(),
            "热启动也不该有错误：{:?}",
            errors.take()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 库正被别人拿着写事务时，`open` 应该排队等它，而不是打不开或者刷错误日志。
    /// 对应"开发时 Tauri 壳和独立 `kdj-server` 指着同一个库"。
    #[test]
    fn opening_a_library_someone_else_holds_waits_instead_of_erroring() {
        let dir = temp_dir("locked");
        let path = dir.join("held.db");

        // 造一个**非 WAL** 的库：这样 open 才真的需要去改文件头
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.pragma_update(None, "journal_mode", "DELETE").unwrap();
            conn.execute_batch("CREATE TABLE IF NOT EXISTS zz (a INTEGER);")
                .unwrap();
        }

        let holder = rusqlite::Connection::open(&path).unwrap();
        holder.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let released = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let releaser = {
            let released = released.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                released.store(true, std::sync::atomic::Ordering::SeqCst);
                holder.execute_batch("COMMIT").unwrap();
            })
        };

        let errors = CollectedPoolErrors::default();
        let db = Database::open_with_error_handler(&path, Some(Box::new(errors.clone())))
            .expect("被别人占着也应该等到锁放开，而不是打不开");
        releaser.join().unwrap();

        assert!(
            released.load(std::sync::atomic::Ordering::SeqCst),
            "open 应该一直等到锁被释放才返回"
        );
        assert!(
            errors.take().is_empty(),
            "撞锁时应该排队，不该冒出 database is locked：{:?}",
            errors.take()
        );
        let mode: String = db
            .conn()
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_database_merge_adds_missing_paths_without_overwriting_current_rows() {
        let dir = temp_dir("merge");
        let current = dir.join("kumodeck.db");
        let legacy = dir.join("kdj.db");
        {
            let db = Database::open(&current).unwrap();
            let conn = db.conn().unwrap();
            conn.execute(
                "INSERT INTO tracks (id, path, filename, title, rating, added_at, modified_at) \
                 VALUES (1, '/current.mp3', 'current.mp3', 'Current', 5, 'now', 'new'), \
                        (2, '/shared.mp3', 'shared.mp3', 'New title', 4, 'now', 'new')",
                [],
            )
            .unwrap();
        }
        {
            let db = Database::open(&legacy).unwrap();
            let conn = db.conn().unwrap();
            conn.execute(
                "INSERT INTO tracks (id, path, filename, title, rating, added_at, modified_at) \
                 VALUES (1, '/legacy-only.mp3', 'legacy.mp3', 'Legacy', 3, 'old', 'old'), \
                        (2, '/shared.mp3', 'shared.mp3', 'Stale title', 1, 'old', 'old')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO tags (track_id, tag) VALUES (1, 'old-only'), (2, 'shared-tag')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO playlists (id, name, note, created_at) VALUES (7, 'Set', 'legacy', 'old')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (7, 1, 0), (7, 2, 1)",
                [],
            )
            .unwrap();
        }

        let report = merge_legacy_database(&current, &legacy).unwrap();
        assert_eq!(report.tracks, 1, "id 撞了也必须把旧库独有路径补进来");
        assert_eq!(report.tags, 2);
        assert_eq!(report.playlists, 1);
        assert_eq!(report.playlist_items, 2);

        let db = Database::open(&current).unwrap();
        let conn = db.conn().unwrap();
        let shared: (String, i64) = conn
            .query_row(
                "SELECT title, rating FROM tracks WHERE path = '/shared.mp3'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            shared,
            ("New title".into(), 4),
            "当前库已有编辑绝不能被旧库盖掉"
        );
        let legacy_id: i64 = conn
            .query_row(
                "SELECT id FROM tracks WHERE path = '/legacy-only.mp3'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(legacy_id, 1, "编号撞车时应分配新 id");
        let playlist_paths: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT tracks.path FROM playlist_items \
                     JOIN tracks ON tracks.id = playlist_items.track_id \
                     JOIN playlists ON playlists.id = playlist_items.playlist_id \
                     WHERE playlists.name = 'Set' ORDER BY playlist_items.position",
                )
                .unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(playlist_paths, vec!["/legacy-only.mp3", "/shared.mp3"]);
        drop(conn);
        drop(db);

        assert_eq!(
            merge_legacy_database(&current, &legacy).unwrap(),
            DatabaseMergeReport::default(),
            "重复启动必须幂等"
        );
        let _ = std::fs::remove_dir_all(dir);
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
