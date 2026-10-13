use super::{candidate, command_executable, InstalledBrowser};
use std::path::Path;
use winreg::{enums::*, RegKey};

pub(super) fn discover() -> Vec<InstalledBrowser> {
    let mut browsers = Vec::new();
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let access = KEY_READ | view;
            if let Ok(clients) =
                root.open_subkey_with_flags(r"Software\Clients\StartMenuInternet", access)
            {
                for name in clients.enum_keys().filter_map(Result::ok) {
                    let Ok(client) = clients.open_subkey_with_flags(&name, access) else {
                        continue;
                    };
                    let label: String = client.get_value("").unwrap_or(name);
                    if let Some(command) = value(&client, r"shell\open\command", "", access) {
                        push(&mut browsers, &label, &command);
                    }
                }
            }
            let Ok(registered) =
                root.open_subkey_with_flags(r"Software\RegisteredApplications", access)
            else {
                continue;
            };
            for (name, _) in registered.enum_values().filter_map(Result::ok) {
                let Ok(capability_path) = registered.get_value::<String, _>(&name) else {
                    continue;
                };
                let Ok(capabilities) = root.open_subkey_with_flags(capability_path, access) else {
                    continue;
                };
                let label: String = capabilities.get_value("ApplicationName").unwrap_or(name);
                for scheme in ["https", "http"] {
                    let Some(prog_id) = value(&capabilities, "URLAssociations", scheme, access)
                    else {
                        continue;
                    };
                    let path = format!(r"Software\Classes\{prog_id}\shell\open\command");
                    // Honor per-user class registrations before machine-wide registrations.
                    let command = value(&RegKey::predef(HKEY_CURRENT_USER), &path, "", access)
                        .or_else(|| value(&RegKey::predef(HKEY_LOCAL_MACHINE), &path, "", access));
                    if let Some(command) = command {
                        push(&mut browsers, &label, &command);
                    }
                }
            }
        }
    }
    browsers
}

fn value(root: &RegKey, path: &str, name: &str, access: u32) -> Option<String> {
    root.open_subkey_with_flags(path, access)
        .ok()?
        .get_value(name)
        .ok()
}

fn push(browsers: &mut Vec<InstalledBrowser>, label: &str, command: &str) {
    let Some(executable) = command_executable(command) else {
        return;
    };
    let Some(expanded) = executable.to_str().and_then(expand_environment) else {
        return;
    };
    let executable = std::path::PathBuf::from(expanded);
    if !executable.is_absolute() {
        return;
    }
    let adapter = adapter(label, &executable);
    // Indirect resource labels are not user-facing text; retain a useful executable name.
    let label = if label.starts_with('@') || label.trim().is_empty() {
        executable
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    } else {
        label.to_string()
    };
    if let Some(browser) = candidate(label, executable, adapter) {
        browsers.push(browser);
    }
}

fn expand_environment(command: &str) -> Option<String> {
    let mut result = String::new();
    let mut remaining = command;
    while let Some(start) = remaining.find('%') {
        result.push_str(&remaining[..start]);
        remaining = &remaining[start..];
        let end = remaining[1..].find('%')? + 1;
        result.push_str(&std::env::var(&remaining[1..end]).ok()?);
        remaining = &remaining[end + 1..];
    }
    result.push_str(remaining);
    Some(result)
}

fn adapter(label: &str, path: &Path) -> Option<&'static str> {
    // Channel-specific installations have different profile roots. Leave them discoverable
    // without pretending that the stable-channel authorization endpoint belongs to them.
    let label = label.to_ascii_lowercase();
    if ["beta", "dev", "canary", "nightly", "portable"]
        .iter()
        .any(|channel| label.contains(channel))
    {
        return None;
    }
    Some(
        match path.file_name()?.to_str()?.to_ascii_lowercase().as_str() {
            "chrome.exe" if matches!(label.as_str(), "chrome" | "google chrome") => "chrome",
            "chrome.exe" if label == "chromium" => "chromium",
            "msedge.exe" if matches!(label.as_str(), "edge" | "microsoft edge") => "edge",
            "brave.exe" if matches!(label.as_str(), "brave" | "brave browser") => "brave",
            "vivaldi.exe" if label == "vivaldi" => "vivaldi",
            "firefox.exe" if matches!(label.as_str(), "firefox" | "mozilla firefox") => "firefox",
            "zen.exe" if matches!(label.as_str(), "zen" | "zen browser") => "zen",
            "librewolf.exe" if label == "librewolf" => "librewolf",
            "arc.exe" if label == "arc" => "arc",
            "opera.exe" | "launcher.exe" if label.contains("opera gx") => "opera_gx",
            "opera.exe" | "launcher.exe" if label.contains("opera") => "opera",
            _ => return None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expands_only_executable_environment_variables() {
        let path = command_executable(r#""%LOCALAPPDATA%\browser.exe" "%1""#).unwrap();
        let command = expand_environment(path.to_str().unwrap()).unwrap();
        assert!(command.ends_with(r"\browser.exe"));
        assert!(!command.contains("%LOCALAPPDATA%"));
        assert!(!command.contains("%SystemRoot%"));
    }
    #[test]
    fn unknown_and_channel_browsers_remain_unadapted() {
        assert_eq!(
            adapter("Chrome", Path::new(r"C:\Custom\chrome.exe")),
            Some("chrome")
        );
        assert_eq!(
            adapter("Chrome Beta", Path::new(r"C:\Custom\chrome.exe")),
            None
        );
        assert_eq!(
            adapter("Unknown", Path::new(r"C:\Custom\launcher.exe")),
            None
        );
        assert_eq!(adapter("Unknown", Path::new(r"C:\Custom\chrome.exe")), None);
        assert_eq!(
            adapter("Chromium", Path::new(r"C:\Custom\chrome.exe")),
            Some("chromium")
        );
    }
}
