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
/// 开发时 Tauri 壳和独立 `kumodeck-server` 指着同一个库就是这种情况。
fn prepare_journal_mode(path: &Path) -> Result<()> {
    let conn = rusqlite::Connection::open(path)
        .with_context(|| format!("打开曲库失败：{}", path.display()))?;
    conn.pragma_update(None, "busy_timeout", BUSY_TIMEOUT_MS)
        .context("设置 busy_timeout 失败")?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .context("切换 WAL 失败")?;
    Ok(())
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
        let dir =
            std::env::temp_dir().join(format!("kumodeck-{tag}-{}-{nonce}", std::process::id()));
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
    /// 对应"开发时 Tauri 壳和独立 `kumodeck-server` 指着同一个库"。
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
