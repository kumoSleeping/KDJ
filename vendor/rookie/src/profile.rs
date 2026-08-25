//! Profile-aware browser discovery used by KDJ's explicit account connection flow.
//!
//! Upstream rookie's convenience functions stop at the first matching cookie database.
//! Desktop applications need to show the user which browser profile will be read instead of
//! silently choosing one, so this module enumerates every supported profile and reloads only the
//! selected database.

use std::collections::{hash_map::DefaultHasher, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use eyre::{anyhow, bail, Result};
use ini::Ini;

#[cfg(target_os = "macos")]
use crate::browser::safari::safari_based;
use crate::browser::{chromium::chromium_based, mozilla::firefox_based};
use crate::common::paths::expand_path;
use crate::config::{get_browser_config, Browser};
use crate::Cookie;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowserFamily {
    Chromium,
    Mozilla,
    Safari,
}

/// One installed browser profile. `id` is an opaque, path-derived identifier suitable for a
/// short-lived UI selection; filesystem paths remain private to the Rust process.
#[derive(Debug, Clone)]
pub struct BrowserProfile {
    pub id: String,
    pub name: String,
    pub last_modified: u64,
    /// Modern Chromium profiles on Windows use App-Bound Encryption and need elevation in rookie.
    pub requires_elevation: bool,
    family: BrowserFamily,
    db_path: PathBuf,
    // Chromium uses this only on Windows; macOS/Linux derive keys from the browser config.
    #[allow(dead_code)]
    key_path: Option<PathBuf>,
}

/// Enumerate every installed profile for a browser supported by rookie on this platform.
pub fn browser_profiles(browser: &str) -> Result<Vec<BrowserProfile>> {
    let browser = browser.trim().to_ascii_lowercase();
    let family = browser_family(&browser)?;
    let config = get_browser_config(&browser);
    let mut profiles = match family {
        BrowserFamily::Chromium => chromium_profiles(&browser, config)?,
        BrowserFamily::Mozilla => mozilla_profiles(&browser, config)?,
        BrowserFamily::Safari => safari_profiles(&browser, config)?,
    };
    profiles.sort_by(|left, right| {
        right
            .last_modified
            .cmp(&left.last_modified)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(profiles)
}

/// Read cookies from exactly one previously discovered profile.
pub fn browser_profile_cookies(
    browser: &str,
    profile_id: &str,
    domains: Option<Vec<String>>,
) -> Result<(BrowserProfile, Vec<Cookie>)> {
    let browser = browser.trim().to_ascii_lowercase();
    let profile = browser_profiles(&browser)?
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| anyhow!("browser profile is no longer available"))?;
    let cookies = match profile.family {
        BrowserFamily::Chromium => {
            #[cfg(target_os = "windows")]
            {
                let key_path = profile
                    .key_path
                    .clone()
                    .ok_or_else(|| anyhow!("can't find browser Local State"))?;
                chromium_based(key_path, profile.db_path.clone(), domains)?
            }
            #[cfg(unix)]
            {
                chromium_based(
                    get_browser_config(&browser),
                    profile.db_path.clone(),
                    domains,
                )?
            }
        }
        BrowserFamily::Mozilla => firefox_based(profile.db_path.clone(), domains)?,
        BrowserFamily::Safari => {
            #[cfg(target_os = "macos")]
            {
                safari_based(profile.db_path.clone(), domains)?
            }
            #[cfg(not(target_os = "macos"))]
            {
                bail!("Safari profiles are only available on macOS")
            }
        }
    };
    Ok((profile, cookies))
}

fn browser_family(browser: &str) -> Result<BrowserFamily> {
    match browser {
        "chrome" | "chromium" | "brave" | "arc" | "edge" | "vivaldi" | "opera" | "opera_gx" => {
            Ok(BrowserFamily::Chromium)
        }
        #[cfg(target_os = "windows")]
        "octo_browser" => Ok(BrowserFamily::Chromium),
        "firefox" | "librewolf" | "zen" => Ok(BrowserFamily::Mozilla),
        #[cfg(target_os = "linux")]
        "cachy" => Ok(BrowserFamily::Mozilla),
        #[cfg(target_os = "macos")]
        "safari" => Ok(BrowserFamily::Safari),
        _ => bail!("unsupported browser: {browser}"),
    }
}

fn expanded_config_paths(config: &Browser) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let channels = config.channels.as_deref().unwrap_or(&[]);
    if channels.is_empty() {
        for path in &config.paths {
            paths.extend(expand_glob(expand_path(path)?)?);
        }
    } else {
        for path in &config.paths {
            for channel in channels {
                paths.extend(expand_glob(expand_path(
                    &path.replace("{channel}", channel),
                )?)?);
            }
        }
    }
    Ok(paths)
}

fn expand_glob(path: PathBuf) -> Result<Vec<PathBuf>> {
    let Some(pattern) = path.to_str() else {
        return Ok(Vec::new());
    };
    let mut paths = Vec::new();
    for entry in glob::glob(pattern)? {
        if let Ok(path) = entry {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn chromium_profiles(browser: &str, config: &Browser) -> Result<Vec<BrowserProfile>> {
    let mut profiles = Vec::new();
    let mut seen = HashSet::new();
    for db_path in expanded_config_paths(config)? {
        if !db_path.is_file() {
            continue;
        }
        let db_path = db_path.canonicalize().unwrap_or(db_path);
        if !seen.insert(db_path.clone()) {
            continue;
        }
        let profile_dir = chromium_profile_dir(&db_path);
        let key_path = chromium_key_path(&db_path);
        let name = chromium_profile_name(&profile_dir, key_path.as_deref());
        profiles.push(profile(
            browser,
            name,
            BrowserFamily::Chromium,
            db_path,
            key_path,
        ));
    }
    Ok(profiles)
}

fn chromium_profile_dir(db_path: &Path) -> PathBuf {
    let parent = db_path.parent().unwrap_or(db_path);
    if parent.file_name().and_then(|name| name.to_str()) == Some("Network") {
        parent.parent().unwrap_or(parent).to_path_buf()
    } else {
        parent.to_path_buf()
    }
}

fn chromium_key_path(db_path: &Path) -> Option<PathBuf> {
    let parent = db_path.parent()?;
    ["../../Local State", "../Local State", "Local State"]
        .iter()
        .map(|relative| parent.join(relative))
        .find(|path| path.exists())
        .map(|path| path.canonicalize().unwrap_or(path))
}

fn chromium_profile_name(profile_dir: &Path, key_path: Option<&Path>) -> String {
    let directory_name = profile_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Default");
    if let Some(key_path) = key_path {
        if let Ok(text) = fs::read_to_string(key_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(name) = value
                    .pointer(&format!("/profile/info_cache/{directory_name}/name"))
                    .and_then(|value| value.as_str())
                    .filter(|name| !name.trim().is_empty())
                {
                    return name.to_string();
                }
            }
        }
    }
    match directory_name {
        "Default" => "默认 Profile".into(),
        name if name.starts_with("Profile ") => name.into(),
        _ => "默认 Profile".into(),
    }
}

fn mozilla_profiles(browser: &str, config: &Browser) -> Result<Vec<BrowserProfile>> {
    let mut profiles = Vec::new();
    let mut seen = HashSet::new();
    for root in expanded_config_paths(config)? {
        if !root.is_dir() {
            continue;
        }
        let ini_path = root.join("profiles.ini");
        if let Ok(ini) = Ini::load_from_file(&ini_path) {
            for (section, properties) in ini.iter() {
                if !section.unwrap_or_default().starts_with("Profile") {
                    continue;
                }
                let Some(relative) = properties.get("Path") else {
                    continue;
                };
                let directory = if properties.get("IsRelative").unwrap_or("1") == "1" {
                    root.join(relative)
                } else {
                    PathBuf::from(relative)
                };
                let name = properties
                    .get("Name")
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| {
                        directory
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("默认 Profile")
                    })
                    .to_string();
                push_mozilla_profile(browser, &mut profiles, &mut seen, directory, name);
            }
        }
        // Some portable/Flatpak profiles have no usable profiles.ini. Keep a shallow fallback.
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let directory = entry.path();
                if !directory.is_dir() {
                    continue;
                }
                let name = directory
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("默认 Profile")
                    .to_string();
                push_mozilla_profile(browser, &mut profiles, &mut seen, directory, name);
            }
        }
    }
    Ok(profiles)
}

fn push_mozilla_profile(
    browser: &str,
    profiles: &mut Vec<BrowserProfile>,
    seen: &mut HashSet<PathBuf>,
    directory: PathBuf,
    name: String,
) {
    let db_path = directory.join("cookies.sqlite");
    if !db_path.is_file() {
        return;
    }
    let db_path = db_path.canonicalize().unwrap_or(db_path);
    if seen.insert(db_path.clone()) {
        profiles.push(profile(
            browser,
            name,
            BrowserFamily::Mozilla,
            db_path,
            None,
        ));
    }
}

fn safari_profiles(browser: &str, config: &Browser) -> Result<Vec<BrowserProfile>> {
    let mut profiles = Vec::new();
    let mut seen = HashSet::new();
    for db_path in expanded_config_paths(config)? {
        if !db_path.is_file() {
            continue;
        }
        let db_path = db_path.canonicalize().unwrap_or(db_path);
        if seen.insert(db_path.clone()) {
            profiles.push(profile(
                browser,
                "默认 Profile".into(),
                BrowserFamily::Safari,
                db_path,
                None,
            ));
        }
    }
    Ok(profiles)
}

fn profile(
    browser: &str,
    name: String,
    family: BrowserFamily,
    db_path: PathBuf,
    key_path: Option<PathBuf>,
) -> BrowserProfile {
    let mut hasher = DefaultHasher::new();
    browser.hash(&mut hasher);
    db_path.hash(&mut hasher);
    let id = format!("{:016x}", hasher.finish());
    let last_modified = fs::metadata(&db_path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let requires_elevation = profile_requires_elevation(key_path.as_deref());
    BrowserProfile {
        id,
        name,
        last_modified,
        requires_elevation,
        family,
        db_path,
        key_path,
    }
}

#[cfg(target_os = "windows")]
fn profile_requires_elevation(key_path: Option<&Path>) -> bool {
    key_path
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| {
            value
                .pointer("/os_crypt/app_bound_encrypted_key")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .is_some_and(|key| !key.is_empty())
}

#[cfg(not(target_os = "windows"))]
fn profile_requires_elevation(_key_path: Option<&Path>) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_profile_directory_skips_network_component() {
        let path = Path::new("/tmp/Browser/User Data/Profile 2/Network/Cookies");
        assert_eq!(
            chromium_profile_dir(path),
            Path::new("/tmp/Browser/User Data/Profile 2")
        );
    }

    #[test]
    fn profile_identifier_does_not_expose_filesystem_path() {
        let row = profile(
            "arc",
            "Work".into(),
            BrowserFamily::Chromium,
            PathBuf::from("/Users/example/Library/Application Support/Arc/Cookies"),
            None,
        );
        assert!(!row.id.contains("Users"));
        assert_eq!(row.id.len(), 16);
    }
}
