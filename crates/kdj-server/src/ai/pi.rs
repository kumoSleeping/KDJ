//! Finding the user's pi (docs/ai-dock.md): KDJ does not bundle it. A pi on PATH, or in the places
//! a GUI app does not see (Homebrew, npm's global prefix, nvm), is used as it is; KDJ only tells
//! when a newer version is published.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

const PACKAGE: &str = "@earendil-works/pi-coding-agent";
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const LATEST_TTL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PiState {
    Missing,
    Broken,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
pub struct PiStatus {
    pub state: PiState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The newest published version, only when it is newer than `version`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Where a pi may be that a GUI app's PATH does not reach. On macOS an app started from Finder
/// inherits launchd's minimal PATH, so Homebrew and npm's global bin are invisible to it.
fn blind_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"]
        .iter()
        .map(PathBuf::from)
        .collect();
    if let Some(home) = home() {
        for dir in [".npm-global/bin", ".local/bin", ".bun/bin", ".volta/bin", ".pi/bin"] {
            dirs.push(home.join(dir));
        }
        // nvm keeps one bin per Node version; the newest first.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|entry| entry.path().join("bin")).collect();
            versions.sort();
            dirs.extend(versions.into_iter().rev());
        }
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&local).join("pi"));
            dirs.push(PathBuf::from(local).join("Programs").join("pi"));
        }
    }
    dirs
}

fn candidates(dir: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        ["pi.cmd", "pi.exe", "pi.bat"].iter().map(|name| dir.join(name)).collect()
    } else {
        vec![dir.join("pi")]
    }
}

/// `KDJ_PI`, then PATH, then the places a GUI app does not see.
pub fn locate() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("KDJ_PI").map(PathBuf::from) {
        return path.is_file().then_some(path);
    }
    let path_dirs = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    path_dirs
        .into_iter()
        .chain(blind_dirs())
        .flat_map(|dir| candidates(&dir))
        .find(|candidate| candidate.is_file())
}

/// The PATH pi runs with: its own directory first (an npm or nvm install keeps `node` beside it,
/// and pi starts through `#!/usr/bin/env node`), then the blind places, then the inherited PATH.
pub fn child_path(pi: &Path) -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = pi.parent().map(Path::to_path_buf).into_iter().collect();
    dirs.extend(blind_dirs());
    if let Some(value) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&value));
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

pub fn command(pi: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(pi);
    command.env("PATH", child_path(pi)).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

/// The first `x.y.z` in pi's `--version` output.
fn parse_version(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == 'v')
        .find(|word| {
            let parts: Vec<&str> = word.split('.').collect();
            parts.len() >= 3 && parts[..3].iter().all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        })
        .map(str::to_string)
}

fn numbers(version: &str) -> Vec<u64> {
    version
        .split(['.', '-'])
        .take(3)
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

fn newer(latest: &str, current: &str) -> bool {
    numbers(latest) > numbers(current)
}

pub async fn inspect() -> PiStatus {
    let Some(path) = locate() else {
        return PiStatus { state: PiState::Missing, path: None, version: None, latest: None, error: None };
    };
    let shown = Some(path.display().to_string());
    let mut command = command(&path);
    command.arg("--version").stdin(Stdio::null()).env("PI_SKIP_VERSION_CHECK", "1").env("PI_OFFLINE", "1");
    let broken = |error: String| PiStatus {
        state: PiState::Broken,
        path: shown.clone(),
        version: None,
        latest: None,
        error: Some(error),
    };
    let output = match tokio::time::timeout(VERSION_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return broken(error.to_string()),
        Err(_) => return broken("pi --version 超时".into()),
    };
    let text = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    match (output.status.success(), parse_version(&text)) {
        (true, Some(version)) => {
            let latest = latest_version().await.filter(|latest| newer(latest, &version));
            PiStatus { state: PiState::Ready, path: shown, version: Some(version), latest, error: None }
        }
        _ => broken(text.trim().lines().last().unwrap_or("pi 无法运行").to_string()),
    }
}

/// The newest published version, asked of the npm registry at most every few hours.
async fn latest_version() -> Option<String> {
    static CACHE: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);
    if let Some((at, value)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        if at.elapsed() < LATEST_TTL {
            return value;
        }
    }
    let url = format!("https://registry.npmjs.org/{PACKAGE}/latest");
    let fetched = async {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().ok()?;
        let body: serde_json::Value = client.get(url).send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
        body["version"].as_str().map(str::to_string)
    }
    .await;
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), fetched.clone()));
    fetched
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_from_any_banner() {
        assert_eq!(parse_version("0.71.2\n").as_deref(), Some("0.71.2"));
        assert_eq!(parse_version("pi v1.2.3 (node 22)").as_deref(), Some("1.2.3"));
        assert_eq!(parse_version("error: no such flag"), None);
    }

    #[test]
    fn only_a_higher_release_is_newer() {
        assert!(newer("0.72.0", "0.71.9"));
        assert!(newer("1.0.0", "0.99.99"));
        assert!(!newer("0.71.2", "0.71.2"));
        assert!(!newer("0.70.0", "0.71.0"));
    }
}
