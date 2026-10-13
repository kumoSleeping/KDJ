//! Installed applications are discovered independently of credential adapters.
//! Discovery never opens a browser, a cookie database, or a keychain.
use serde::Serialize;
#[cfg(any(target_os = "macos", target_os = "windows", test))]
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[derive(Debug, Clone, Serialize)]
pub struct InstalledBrowser {
    /// Identifies an installation, not a vendor or a successful connection.
    pub id: String,
    pub label: String,
    pub adapter_id: Option<String>,
    pub direct_read_supported: bool,
    pub authorization_supported: bool,
    #[serde(skip)]
    pub(crate) executable: PathBuf,
}

pub fn installed() -> Vec<InstalledBrowser> {
    #[cfg(target_os = "macos")]
    let candidates = macos::discover();
    #[cfg(target_os = "windows")]
    let candidates = windows::discover();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let candidates = Vec::new();
    normalize(candidates)
}

fn normalize(mut candidates: Vec<InstalledBrowser>) -> Vec<InstalledBrowser> {
    candidates.sort_by(|a, b| a.executable.cmp(&b.executable));
    candidates.dedup_by(|a, b| a.id == b.id);
    candidates.sort_by(|a, b| a.label.cmp(&b.label).then(a.id.cmp(&b.id)));
    // Keep multiple installations selectable without exposing their paths to the frontend.
    let mut previous = String::new();
    let mut count = 0;
    for browser in &mut candidates {
        if previous == browser.label {
            count += 1;
            browser.label = format!("{} ({count})", browser.label);
        } else {
            previous = browser.label.clone();
            count = 1;
        }
    }
    candidates
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn candidate(
    label: String,
    executable: PathBuf,
    adapter: Option<&str>,
) -> Option<InstalledBrowser> {
    let executable = executable.canonicalize().ok()?;
    #[cfg(target_os = "macos")]
    if !executable.is_dir() {
        return None;
    }
    #[cfg(not(target_os = "macos"))]
    if !executable.is_file() {
        return None;
    }
    let mut identity = executable.to_string_lossy().into_owned();
    if cfg!(target_os = "windows") {
        identity.make_ascii_lowercase();
    }
    let id = format!(
        "installed-{}",
        hex::encode(Sha256::digest(identity.as_bytes()))
    );
    Some(InstalledBrowser {
        id,
        label,
        adapter_id: adapter.map(str::to_owned),
        direct_read_supported: adapter.is_some_and(|id| super::browser_label(id).is_some()),
        authorization_supported: adapter.is_some_and(super::authorization::supports),
        executable,
    })
}

// Windows registration commands are data, never shell scripts. Return only the executable;
// never execute the registry's argument tail. Unquoted paths with spaces are common in installers.
#[cfg(any(target_os = "windows", test))]
fn command_executable(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    let path = if let Some(rest) = command.strip_prefix('"') {
        &rest[..rest.find('"')?]
    } else {
        let end = command
            .to_ascii_lowercase()
            .match_indices(".exe")
            .find(|(i, _)| {
                command
                    .get(i + 4..)
                    .is_some_and(|tail| tail.is_empty() || tail.starts_with(char::is_whitespace))
            })?
            .0
            + 4;
        &command[..end]
    };
    if !path.to_ascii_lowercase().ends_with(".exe") {
        return None;
    }
    Some(PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_command_keeps_spaces_but_never_arguments() {
        for command in [
            r#""C:\Program Files\Browser\browser.exe" -- "%1""#,
            r#"C:\Program Files\Browser\browser.exe --single-argument %1"#,
        ] {
            assert_eq!(
                command_executable(command),
                Some(PathBuf::from(r"C:\Program Files\Browser\browser.exe"))
            );
        }
        for invalid in [
            "",
            "cmd /c start chrome",
            r#""C:\broken.exe"#,
            "C:\\browser.exe.backup %1",
        ] {
            assert!(command_executable(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn missing_installation_is_not_offered() {
        assert!(candidate(
            "Removed".into(),
            PathBuf::from("/kdj-missing-browser/app"),
            None
        )
        .is_none());
    }

    #[test]
    fn installations_deduplicate_without_merging_distinct_paths() {
        let browser = |id: &str, path: &str| InstalledBrowser {
            id: id.into(),
            label: "Browser".into(),
            adapter_id: None,
            direct_read_supported: false,
            authorization_supported: false,
            executable: PathBuf::from(path),
        };
        let result = normalize(vec![
            browser("a", "/a"),
            browser("b", "/b"),
            browser("a", "/a"),
        ]);
        assert_eq!(result.len(), 2);
        assert_eq!(result[1].label, "Browser (2)");
        assert!(!result[0].authorization_supported);
        let json = serde_json::to_value(&result[0]).unwrap();
        assert!(json.get("executable").is_none());
        assert!(json.get("connected").is_none());
    }
}
