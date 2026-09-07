use crate::common::{date, enums::*, utils};
use eyre::{anyhow, bail, Result};
use ini::Ini;
use lz4_flex::block::decompress_size_prepended;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Returns cookies from mozilla based browsers
pub fn firefox_based(db_path: PathBuf, domains: Option<Vec<String>>) -> Result<Vec<Cookie>> {
    // Firefox keeps recent logins in the WAL while it is running. immutable=1 ignores
    // that WAL and can return an old/empty session even though the browser is signed in.
    // Use SQLite's read-only snapshot/locking instead; never alter the browser database.
    let connection = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    connection.busy_timeout(std::time::Duration::from_secs(2))?;
    let mut query = "
        SELECT host, path, isSecure, expiry, name, value, isHttpOnly, sameSite from moz_cookies 
    "
    .to_string();

    if let Some(domains) = domains.clone() {
        let domain_queries: Vec<String> = domains
            .iter()
            .map(|domain| format!("host LIKE '%{}%'", domain))
            .collect();

        if !domain_queries.is_empty() {
            let joined_queries = domain_queries.join(" OR ");
            query += &format!("WHERE ({})", joined_queries);
        }
    }

    query += ";";

    let mut cookies: Vec<Cookie> = vec![];
    let mut stmt = connection.prepare(query.as_str())?;
    let mut rows = stmt.query([])?;

    while let Some(row) = rows.next()? {
        let host: Result<String, _> = row.get(0);
        if host.is_err() {
            // ignore null rows
            log::warn!("host is NULL in row");
            continue;
        }
        let host = host?;
        let path: String = row.get(1)?;
        let is_secure: bool = row.get(2)?;
        let expires: u64 = row.get(3)?;
        let expires = date::mozilla_timestamp(expires);

        let name: String = row.get(4)?;

        let value: String = row.get(5)?;
        let http_only: bool = row.get(6)?;

        let same_site: i64 = row.get(7)?;
        let cookie = Cookie {
            domain: host.to_string(),
            path: path.to_string(),
            secure: is_secure,
            expires,
            name: name.to_string(),
            value,
            http_only,
            same_site,
        };
        cookies.push(cookie);
    }

    let parent_path = db_path.parent().unwrap_or(&PathBuf::from("")).to_path_buf();
    if let Ok(session_cookies) = get_session_cookies_lz4(domains.to_owned(), parent_path.to_owned())
    {
        cookies.extend(session_cookies);
    }

    if let Ok(session_cookies) = get_session_cookies(domains, parent_path) {
        cookies.extend(session_cookies);
    }
    Ok(cookies)
}

pub fn get_session_cookies(
    domains: Option<Vec<String>>,
    cookies_dir: PathBuf,
) -> Result<Vec<Cookie>> {
    let mut cookies: Vec<Cookie> = vec![];
    let session_file = cookies_dir.join("sessionstore.js");
    let plain = fs::read_to_string(session_file)?;
    let json: Value = serde_json::from_str(&plain)?;
    let windows = json
        .get("windows")
        .ok_or(anyhow!("no windows in json"))?
        .as_array()
        .ok_or(anyhow!("windows are not array"))?;
    for window in windows {
        let may_cookies_json = window.get("cookies");
        if let Some(cookies_json) = may_cookies_json {
            let cookies_json = cookies_json.as_array();
            if let Some(cookies_json) = cookies_json {
                for json_cookie in cookies_json {
                    let domain = json_cookie
                        .get("host")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let should_add = domains.is_none() || // add every domain
                        domains.is_some() && utils::some_domain_in_host(domains.to_owned(), domain); // only if some domain in host
                    if !should_add {
                        continue;
                    }
                    if let Ok(cookie) = create_cookie(json_cookie) {
                        cookies.push(cookie);
                    }
                }
            }
        }
    }
    Ok(cookies)
}

pub fn get_session_cookies_lz4(
    domains: Option<Vec<String>>,
    cookies_dir: PathBuf,
) -> Result<Vec<Cookie>> {
    let mut cookies: Vec<Cookie> = vec![];
    let session_file_lz4 = cookies_dir.join("sessionstore-backups/recovery.jsonlz4");
    let compressed = fs::read(session_file_lz4)?;
    let compressed = compressed.strip_prefix(b"mozLz40\0")
        .ok_or_else(|| anyhow!("Invalid Mozilla session header"))?;
    let decompressed = decompress_size_prepended(compressed)?;
    let plain = String::from_utf8(decompressed)?;
    let json: Value = serde_json::from_str(&plain)?;
    let cookies_json = json.get("cookies").ok_or(anyhow!("no cookies in json"))?;
    let cookies_json = cookies_json
        .as_array()
        .ok_or(anyhow!("cookies is not list"))?;
    for json_cookie in cookies_json {
        let domain = json_cookie
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let should_add = domains.is_none() || // add every domain
                        utils::some_domain_in_host(domains.to_owned(), domain); // only if some domain in host
        if !should_add {
            continue;
        }
        if let Ok(cookie) = create_cookie(json_cookie) {
            cookies.push(cookie);
        }
    }
    Ok(cookies)
}

pub fn create_cookie(json_cookie: &Value) -> Result<Cookie> {
    let host = json_cookie
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let path = json_cookie
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let secure = json_cookie
        .get("secure")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let name = json_cookie
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let value = json_cookie
        .get("value")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let http_only = json_cookie
        .get("httponly")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let expires = json_cookie
        .get("expiry")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let expires = date::mozilla_timestamp(expires);

    let same_site = json_cookie
        .get("sameSite")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let cookie = Cookie {
        domain: host.to_string(),
        expires,
        http_only,
        name: name.to_string(),
        value: value.to_string(),
        path: path.to_string(),
        same_site,
        secure,
    };
    Ok(cookie)
}

pub fn get_default_profile(profiles_path: &Path) -> Result<String> {
    let conf = Ini::load_from_file(profiles_path)?;
    let installs: Vec<_> = conf
        .iter()
        .filter(|(name_option, _)| name_option.unwrap_or_default().starts_with("Install"))
        .collect();
    if !installs.is_empty() {
        let (_, props) = installs.first().unwrap();
        return Ok(props.get("Default").unwrap_or_default().into());
    } else {
        let profiles: Vec<_> = conf
            .iter()
            .filter(|(name_option, _)| name_option.unwrap_or_default().starts_with("Profile"))
            .collect();
        for (_, props) in &profiles {
            if props.get("Default").unwrap_or_default() == "1" {
                return Ok(props.get("Path").unwrap_or_default().into());
            }
        }

        // still not found? last time try to get any Profile with Path.
        for (_, props) in &profiles {
            if let Some(path) = props.get("Path") {
                return Ok(path.into());
            }
        }
    }
    bail!("Can't find any profile")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn firefox_reads_live_wal_login_without_changing_database() {
        let root = std::env::temp_dir().join(format!("kdj-firefox-wal-{}-{}",
            std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        let fixture = Fixture(root);
        let db = fixture.0.join("cookies.sqlite");
        let writer = rusqlite::Connection::open(&db).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE moz_cookies (host TEXT, path TEXT, isSecure INTEGER, expiry INTEGER,
                name TEXT, value TEXT, isHttpOnly INTEGER, sameSite INTEGER);
            PRAGMA wal_checkpoint(TRUNCATE);
            INSERT INTO moz_cookies VALUES ('.youtube.com', '/', 1, 4102444800,
                'SAPISID', 'test-only-session', 1, 0);").unwrap();
        let before = fs::read(&db).unwrap();
        let cookies = firefox_based(db.clone(), Some(vec!["youtube.com".into()])).unwrap();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].name, "SAPISID");
        assert_eq!(cookies[0].value, "test-only-session");
        assert_eq!(fs::read(&db).unwrap(), before);
        fs::create_dir(fixture.0.join("sessionstore-backups")).unwrap();
        fs::write(fixture.0.join("sessionstore-backups/recovery.jsonlz4"), b"bad").unwrap();
        // A partially written recovery file must not panic or hide the valid SQL session.
        assert_eq!(firefox_based(db, None).unwrap().len(), 1);
        drop(writer);
    }
}
