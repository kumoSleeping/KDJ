use eyre::{anyhow, Result};
use rusqlite::{Connection, OpenFlags};
use std::path::PathBuf;
use url::Url;

/// A lock-free copy is only usable when the database and WAL are unchanged across
/// the entire capture. SQLite reconstructs the WAL index in this private directory.
/// Never copy shm, change locking on the source, or silently drop its WAL.
pub(crate) fn wal_snapshot(path: &std::path::Path) -> Result<tempfile::TempDir> {
    use std::{fs, io::Read};
    const LIMIT: u64 = 128 * 1024 * 1024;
    fn read(path: &std::path::Path, optional: bool) -> Result<Option<Vec<u8>>> {
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(error) if optional && error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None)
            }
            Err(error) => return Err(error.into()),
        };
        let mut bytes = Vec::new();
        file.take(LIMIT + 1).read_to_end(&mut bytes)?;
        eyre::ensure!(
            bytes.len() as u64 <= LIMIT,
            "浏览器数据库过大，请退出浏览器后重新读取"
        );
        Ok(Some(bytes))
    }
    let sidecar = |suffix: &str| {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        PathBuf::from(name)
    };
    let wal = sidecar("-wal");
    let journal = sidecar("-journal");
    let stamps = || -> Result<Vec<Option<(u64, std::time::SystemTime)>>> {
        [path, wal.as_path(), journal.as_path()]
            .into_iter()
            .map(|path| match fs::metadata(path) {
                Ok(metadata) => Ok(Some((metadata.len(), metadata.modified()?))),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error.into()),
            })
            .collect()
    };
    for _ in 0..3 {
        let before = stamps()?;
        let database = read(path, false)?.unwrap();
        // Rollback-journal locks need recovery, not an unlocked view of dirty pages.
        eyre::ensure!(
            database.starts_with(b"SQLite format 3\0") && database.get(18..20) == Some(&[2, 2]),
            "浏览器数据库正在使用，请退出浏览器后重新读取"
        );
        let log = read(&wal, true)?;
        let rollback = read(&journal, true)?;
        if rollback
            .as_ref()
            .is_some_and(|bytes| bytes.iter().any(|byte| *byte != 0))
        {
            eyre::bail!("浏览器数据库正在恢复，请稍后重新读取");
        }
        if read(path, false)?.as_deref() != Some(database.as_slice())
            || read(&wal, true)? != log
            || read(&journal, true)? != rollback
            || stamps()? != before
        {
            continue;
        }
        let directory = tempfile::Builder::new().prefix("kdj-browser-").tempdir()?;
        let copy = directory.path().join("cookies.sqlite");
        fs::write(&copy, database)?;
        if let Some(log) = log {
            fs::write(directory.path().join("cookies.sqlite-wal"), log)?;
        }
        // Only the private copy may be written/recovered. Closing checkpoints it so
        // the ordinary read-only reader can consume it, and TempDir erases it on exit.
        let connection = Connection::open(&copy)?;
        let check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        eyre::ensure!(check == "ok", "浏览器数据库快照不完整，请稍后重新读取");
        connection.close().map_err(|(_, error)| error)?;
        return Ok(directory);
    }
    eyre::bail!("浏览器登录数据正在更新，请稍后重新读取")
}

pub fn connect(path: PathBuf) -> Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
    let conn_str = format!(
        "{}?mode=ro&immutable=1",
        Url::from_file_path(path.canonicalize()?).or(Err(anyhow!("Error opening connection")))?
    );
    let connection = rusqlite::Connection::open_with_flags(conn_str, flags)?;
    Ok(connection)
}
