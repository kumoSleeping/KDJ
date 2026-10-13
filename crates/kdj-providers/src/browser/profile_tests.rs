use rusqlite::Connection;
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

#[test]
fn confirmed_gecko_profile_does_not_merge_containers_or_other_profiles() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("personal")).unwrap();
    fs::create_dir(root.path().join("work")).unwrap();
    fs::write(root.path().join("profiles.ini"), "[Profile0]\nName=Personal\nIsRelative=1\nPath=personal\n[Profile1]\nName=Work\nIsRelative=1\nPath=work\n").unwrap();
    for name in ["personal", "work"] {
        let db = Connection::open(root.path().join(name).join("cookies.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE moz_cookies (host TEXT, path TEXT, isSecure INTEGER, expiry INTEGER,
            name TEXT, value TEXT, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT);
            INSERT INTO moz_cookies VALUES ('.youtube.com', '/', 1, 4102444800, 'SAPISID', 'ordinary', 1, 0, '');
            INSERT INTO moz_cookies VALUES ('.youtube.com', '/', 1, 4102444800, 'SAPISID', 'container', 1, 0, '^userContextId=2');
            INSERT INTO moz_cookies VALUES ('.youtube.com', '/', 1, 4102444800, 'SAPISID', 'partition', 1, 0, '^partitionKey=test');
            INSERT INTO moz_cookies VALUES ('.soundcloud.com', '/', 1, 4102444800, 'oauth_token', 'unrelated', 1, 0, '');").unwrap();
        db.execute("UPDATE moz_cookies SET value=? WHERE originAttributes='';", [name]).unwrap();
    }
    fs::write(root.path().join("personal/sessionstore.js"), r#"{"windows":[{"cookies":[
        {"host":".youtube.com","name":"SID","value":"session","path":"/","originAttributes":""},
        {"host":".youtube.com","name":"SID","value":"private","path":"/","originAttributes":"^privateBrowsingId=1"}
    ]}]}"#).unwrap();
    let profiles = rookie::mozilla_profiles_from_roots("unknown-installation", &[root.path().to_owned()]).unwrap();
    assert_eq!(profiles.len(), 2);
    let profile = profiles.iter().find(|p| p.name == "Personal").unwrap();
    let before = fs::read(root.path().join("personal/cookies.sqlite")).unwrap();
    let cookies = rookie::mozilla_profile_cookies(profile, vec!["youtube.com".into()]).unwrap();
    assert_eq!(cookies.len(), 2);
    assert!(cookies.iter().all(|c| ["personal", "session"].contains(&c.value.as_str())));
    assert_eq!(fs::read(root.path().join("personal/cookies.sqlite")).unwrap(), before);
    let other = rookie::mozilla_profiles_from_roots("other-installation", &[root.path().to_owned()]).unwrap();
    assert!(other.iter().all(|p| p.id != profile.id), "profile ids are bound to their installation");
}

#[test]
fn mozilla_reads_committed_wal_under_normal_and_exclusive_locks() {
    for exclusive in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cookies.sqlite");
        let _writer = Writer::start(
            directory.path(),
            if exclusive { "exclusive" } else { "normal" },
        );
        let database = fs::read(&path).unwrap();
        let wal_path = directory.path().join("cookies.sqlite-wal");
        let wal = fs::read(&wal_path).unwrap();
        let cookies =
            rookie::firefox_based(path.clone(), Some(vec!["youtube.com".into()])).unwrap();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].value, "committed-test-session");
        assert_eq!(fs::read(&path).unwrap(), database);
        assert_eq!(fs::read(&wal_path).unwrap(), wal);
        assert!(
            rookie::firefox_based(path, Some(vec!["soundcloud.com".into()]))
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn mozilla_rejects_locked_rollback_database_instead_of_reading_dirty_pages() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cookies.sqlite");
    let _writer = Writer::start(directory.path(), "rollback");
    let before = fs::read(&path).unwrap();
    assert!(rookie::firefox_based(path.clone(), None).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
#[ignore = "reads only selected site's cookies from an explicitly selected local browser; prints no credentials"]
fn selected_live_browser_profile_is_readable() {
    let browser = std::env::var("KDJ_TEST_PROFILE_BROWSER").expect("select a browser");
    let profiles = rookie::browser_profiles(&browser).unwrap();
    assert!(!profiles.is_empty());
    for profile in profiles {
        rookie::browser_profile_cookies(&browser, &profile.id, Some(vec!["youtube.com".into()]))
            .map(|(_, cookies)| cookies.len())
            .unwrap();
    }
}

// A different process is essential: closing a raw file descriptor in the writer's
// own process can release its POSIX SQLite locks and make this regression test lie.
struct Writer(Child);
impl Drop for Writer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Writer {
    fn start(root: &Path, mode: &str) -> Self {
        let mut child = Self(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "browser::profile_tests::hold_browser_database",
                    "--ignored",
                ])
                .env("KDJ_SQLITE_FIXTURE_ROOT", root)
                .env("KDJ_SQLITE_FIXTURE_MODE", mode)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("ready").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "fixture writer exited"
            );
            assert!(Instant::now() < deadline, "fixture writer timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
        child
    }
}

#[test]
#[ignore = "subprocess fixture for SQLite lock tests"]
fn hold_browser_database() {
    let Some(root) = std::env::var_os("KDJ_SQLITE_FIXTURE_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let mode = std::env::var("KDJ_SQLITE_FIXTURE_MODE").unwrap();
    let writer = Connection::open(root.join("cookies.sqlite")).unwrap();
    if mode == "rollback" {
        writer
            .execute_batch("CREATE TABLE moz_cookies (host TEXT); BEGIN EXCLUSIVE;")
            .unwrap();
    } else {
        if mode == "exclusive" {
            writer
                .execute_batch("PRAGMA locking_mode=EXCLUSIVE;")
                .unwrap();
        }
        writer
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE moz_cookies (host TEXT, path TEXT, isSecure INTEGER, expiry INTEGER,
                name TEXT, value TEXT, isHttpOnly INTEGER, sameSite INTEGER);
            PRAGMA wal_checkpoint(TRUNCATE);
            INSERT INTO moz_cookies VALUES ('.youtube.com', '/', 1, 4102444800,
                'SAPISID', 'committed-test-session', 1, 0);
            BEGIN; UPDATE moz_cookies SET value='uncommitted-test-session';",
            )
            .unwrap();
    }
    fs::write(root.join("ready"), []).unwrap();
    // Parent kills/waits this process before TempDir removes the fixture.
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}
