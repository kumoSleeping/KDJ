//! 桌面 CLI 入口的检测、安装与版本校验。
//!
//! KDJ 的 CLI 与桌面应用是同一个二进制。这里不复制一份会随更新变旧的程序：
//! macOS 安装 `/usr/local/bin/kdj` 软链接，Windows 安装用户级 `kdj.cmd`
//! 启动器并把它所在目录加入用户 PATH。

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CliInstallState {
    Missing,
    Current,
    Outdated,
    Broken,
    Conflict,
    #[allow(dead_code)]
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallStatus {
    pub state: CliInstallState,
    pub current_version: String,
    pub installed_version: Option<String>,
    pub install_path: String,
    /// 复制给 AI 的完整入口。它不依赖当前 AI 进程是否已刷新 PATH。
    pub invocation: String,
}

pub fn status() -> Result<CliInstallStatus> {
    platform::status()
}

pub fn install() -> Result<CliInstallStatus> {
    platform::install()?;
    let status = platform::status()?;
    if status.state != CliInstallState::Current {
        bail!("CLI 安装后校验失败，当前状态为 {:?}", status.state);
    }
    Ok(status)
}

fn probe_version(executable: &Path) -> Result<String> {
    let output = Command::new(executable)
        .arg("spec")
        .output()
        .with_context(|| format!("无法运行 CLI：{}", executable.display()))?;
    if !output.status.success() {
        bail!("CLI 版本检测失败：{}", executable.display());
    }
    let payload: serde_json::Value = serde_json::from_slice(&output.stdout)
        .with_context(|| format!("CLI 没有返回 JSON：{}", executable.display()))?;
    if payload.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        bail!("CLI 版本检测返回失败：{}", executable.display());
    }
    payload
        .pointer("/data/version")
        .and_then(|value| value.as_str())
        .filter(|version| !version.trim().is_empty())
        .map(str::to_string)
        .context("CLI spec 缺少 data.version")
}

fn state_for_version(version: Option<&str>) -> CliInstallState {
    match version {
        Some(version) if version == kdj_core::VERSION => CliInstallState::Current,
        Some(_) => CliInstallState::Outdated,
        None => CliInstallState::Broken,
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::fs;
    use std::io::ErrorKind;
    use std::os::unix::fs::symlink;

    use super::*;

    const DEFAULT_INSTALL_PATH: &str = "/usr/local/bin/kdj";

    #[derive(Debug)]
    enum AliasState {
        Missing,
        Owned,
        Conflict,
    }

    pub fn status() -> Result<CliInstallStatus> {
        let source = std::env::current_exe().context("无法取得 KDJ 可执行文件路径")?;
        let install_path =
            find_owned_alias(&source).unwrap_or_else(|| PathBuf::from(DEFAULT_INSTALL_PATH));
        let alias_state = alias_state(&install_path, &source)?;
        let installed_version = if matches!(alias_state, AliasState::Owned) {
            probe_version(&install_path).ok()
        } else {
            None
        };
        let state = match alias_state {
            AliasState::Missing => CliInstallState::Missing,
            AliasState::Conflict => CliInstallState::Conflict,
            AliasState::Owned => state_for_version(installed_version.as_deref()),
        };
        let invocation_path = if installed_version.is_some() {
            &install_path
        } else {
            &source
        };
        Ok(CliInstallStatus {
            state,
            current_version: kdj_core::VERSION.to_string(),
            installed_version,
            install_path: install_path.to_string_lossy().into_owned(),
            invocation: shell_quote(invocation_path),
        })
    }

    pub fn install() -> Result<()> {
        let source = std::env::current_exe().context("无法取得 KDJ 可执行文件路径")?;
        let current = status()?;
        let install_path = PathBuf::from(&current.install_path);
        match alias_state(&install_path, &source)? {
            AliasState::Conflict => {
                bail!("{} 已被非 KDJ 命令占用，未覆盖", install_path.display())
            }
            AliasState::Missing | AliasState::Owned => {}
        }

        match install_link(&source, &install_path) {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error
                        .downcast_ref::<std::io::Error>()
                        .map(std::io::Error::kind),
                    Some(ErrorKind::PermissionDenied)
                ) =>
            {
                install_link_with_admin(&source, &install_path)
            }
            Err(error) => Err(error),
        }
    }

    fn candidate_aliases() -> Vec<PathBuf> {
        let mut candidates = Vec::new();
        if let Some(path) = std::env::var_os("PATH") {
            candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("kdj")));
        }
        candidates.extend([
            PathBuf::from(DEFAULT_INSTALL_PATH),
            PathBuf::from("/opt/homebrew/bin/kdj"),
            kdj_core::config::home_dir().join(".local/bin/kdj"),
            kdj_core::config::home_dir().join("bin/kdj"),
        ]);
        candidates.sort();
        candidates.dedup();
        candidates
    }

    fn find_owned_alias(source: &Path) -> Option<PathBuf> {
        candidate_aliases()
            .into_iter()
            .find(|candidate| matches!(alias_state(candidate, source), Ok(AliasState::Owned)))
    }

    fn alias_state(path: &Path, source: &Path) -> Result<AliasState> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(AliasState::Missing),
            Err(error) => {
                return Err(error).with_context(|| format!("无法检查 {}", path.display()))
            }
        };
        if !metadata.file_type().is_symlink() {
            return Ok(AliasState::Conflict);
        }
        let target = fs::read_link(path)
            .with_context(|| format!("无法读取 CLI 链接：{}", path.display()))?;
        let resolved = if target.is_absolute() {
            target.clone()
        } else {
            path.parent()
                .unwrap_or_else(|| Path::new("/"))
                .join(&target)
        };
        let same_target = resolved.canonicalize().ok() == source.canonicalize().ok();
        if same_target || looks_like_kdj_bundle_executable(&resolved) {
            Ok(AliasState::Owned)
        } else {
            Ok(AliasState::Conflict)
        }
    }

    fn looks_like_kdj_bundle_executable(path: &Path) -> bool {
        let parts = path
            .components()
            .rev()
            .take(4)
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        matches!(
            parts.as_slice(),
            [binary, macos, contents, bundle]
                if binary == "kdj-app"
                    && macos == "MacOS"
                    && contents == "Contents"
                    && bundle.to_ascii_lowercase().ends_with(".app")
        )
    }

    fn install_link(source: &Path, destination: &Path) -> Result<()> {
        let parent = destination.parent().context("CLI 安装路径没有父目录")?;
        fs::create_dir_all(parent)
            .with_context(|| format!("无法创建 CLI 目录：{}", parent.display()))?;
        match fs::symlink_metadata(destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                fs::remove_file(destination)
                    .with_context(|| format!("无法更新 CLI 链接：{}", destination.display()))?;
            }
            Ok(_) => bail!("{} 已存在且不是软链接，未覆盖", destination.display()),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        symlink(source, destination)
            .with_context(|| format!("无法安装 CLI：{}", destination.display()))
    }

    fn install_link_with_admin(source: &Path, destination: &Path) -> Result<()> {
        let parent = destination.parent().context("CLI 安装路径没有父目录")?;
        let script = concat!(
            "on run argv\n",
            "set sourcePath to quoted form of item 1 of argv\n",
            "set destinationPath to quoted form of item 2 of argv\n",
            "set parentPath to quoted form of item 3 of argv\n",
            "do shell script \"/bin/mkdir -p \" & parentPath & ",
            " \" && /bin/ln -sfn \" & sourcePath & \" \" & destinationPath ",
            "with administrator privileges\n",
            "end run"
        );
        let output = Command::new("/usr/bin/osascript")
            .args(["-e", script, "--"])
            .arg(source)
            .arg(destination)
            .arg(parent)
            .output()
            .context("无法启动 macOS CLI 安装授权")?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            bail!(
                "CLI 安装未完成{}",
                if message.is_empty() {
                    String::new()
                } else {
                    format!("：{message}")
                }
            );
        }
        Ok(())
    }

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn scratch(name: &str) -> PathBuf {
            std::env::temp_dir().join(format!(
                "kdj-cli-install-{name}-{}-{:016x}",
                std::process::id(),
                rand::random::<u64>()
            ))
        }

        #[test]
        fn installs_and_updates_only_symlinks() {
            let dir = scratch("link");
            fs::create_dir_all(&dir).unwrap();
            let first = dir.join("KDJ.app/Contents/MacOS/kdj-app");
            let second = dir.join("KDJ 2.app/Contents/MacOS/kdj-app");
            fs::create_dir_all(first.parent().unwrap()).unwrap();
            fs::create_dir_all(second.parent().unwrap()).unwrap();
            fs::write(&first, b"first").unwrap();
            fs::write(&second, b"second").unwrap();
            let alias = dir.join("bin/kdj");

            install_link(&first, &alias).unwrap();
            assert_eq!(fs::read_link(&alias).unwrap(), first);
            install_link(&second, &alias).unwrap();
            assert_eq!(fs::read_link(&alias).unwrap(), second);

            let _ = fs::remove_dir_all(dir);
        }

        #[test]
        fn refuses_to_replace_a_regular_file() {
            let dir = scratch("conflict");
            fs::create_dir_all(&dir).unwrap();
            let source = dir.join("kdj-app");
            let alias = dir.join("kdj");
            fs::write(&source, b"app").unwrap();
            fs::write(&alias, b"mine").unwrap();
            let error = install_link(&source, &alias).unwrap_err().to_string();
            assert!(error.contains("不是软链接"));
            assert_eq!(fs::read(&alias).unwrap(), b"mine");
            let _ = fs::remove_dir_all(dir);
        }

        #[test]
        fn quotes_apostrophes_for_a_shell_invocation() {
            assert_eq!(
                shell_quote(Path::new("/Applications/KDJ user's.app/kdj-app")),
                "'/Applications/KDJ user'\"'\"'s.app/kdj-app'"
            );
        }

        #[test]
        fn probes_the_version_from_machine_readable_spec_output() {
            let dir = scratch("probe");
            fs::create_dir_all(&dir).unwrap();
            let executable = dir.join("kdj-app");
            fs::write(
                &executable,
                b"#!/bin/sh\nprintf '%s\\n' '{\"ok\":true,\"data\":{\"version\":\"7.8.9\"}}'\n",
            )
            .unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(probe_version(&executable).unwrap(), "7.8.9");
            let _ = fs::remove_dir_all(dir);
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::fs;
    use std::io::ErrorKind;

    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_EXPAND_SZ, REG_SZ};
    use winreg::types::{FromRegValue, ToRegValue};
    use winreg::{RegKey, RegValue};

    const LAUNCHER_MARKER: &str = "@rem KDJ_CLI_LAUNCHER_V1";

    pub fn status() -> Result<CliInstallStatus> {
        let source = std::env::current_exe().context("无法取得 KDJ 可执行文件路径")?;
        let install_path = launcher_path();
        let path_ready = user_path_contains(install_path.parent().unwrap_or(Path::new("")))?;
        let (state, installed_version) = match read_launcher_target(&install_path)? {
            LauncherState::Missing => (CliInstallState::Missing, None),
            LauncherState::Conflict => (CliInstallState::Conflict, None),
            LauncherState::Owned(target) => {
                let version = probe_version(&target).ok();
                let state = if !path_ready {
                    CliInstallState::Broken
                } else {
                    state_for_version(version.as_deref())
                };
                (state, version)
            }
        };
        let invocation = powershell_invocation(if installed_version.is_some() {
            &install_path
        } else {
            &source
        });
        Ok(CliInstallStatus {
            state,
            current_version: kdj_core::VERSION.to_string(),
            installed_version,
            install_path: install_path.to_string_lossy().into_owned(),
            invocation,
        })
    }

    pub fn install() -> Result<()> {
        let source = std::env::current_exe().context("无法取得 KDJ 可执行文件路径")?;
        let install_path = launcher_path();
        if matches!(
            read_launcher_target(&install_path)?,
            LauncherState::Conflict
        ) {
            bail!("{} 已被非 KDJ 命令占用，未覆盖", install_path.display());
        }
        let parent = install_path.parent().context("CLI 安装路径没有父目录")?;
        fs::create_dir_all(parent)
            .with_context(|| format!("无法创建 CLI 目录：{}", parent.display()))?;
        fs::write(&install_path, launcher_contents(&source)?)
            .with_context(|| format!("无法写入 CLI 启动器：{}", install_path.display()))?;
        ensure_user_path(parent)?;
        broadcast_environment_change();
        Ok(())
    }

    enum LauncherState {
        Missing,
        Owned(PathBuf),
        Conflict,
    }

    fn launcher_path() -> PathBuf {
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| kdj_core::config::home_dir().join("AppData/Local"));
        local.join("KDJ/bin/kdj.cmd")
    }

    fn launcher_contents(target: &Path) -> Result<String> {
        let target = target.to_string_lossy();
        if target.contains(['\r', '\n', '"']) {
            bail!("KDJ 可执行文件路径不能写入 Windows CLI 启动器");
        }
        let escaped = target.replace('%', "%%");
        Ok(format!(
            "@echo off\r\n{LAUNCHER_MARKER}\r\n\"{escaped}\" %*\r\n"
        ))
    }

    fn read_launcher_target(path: &Path) -> Result<LauncherState> {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(LauncherState::Missing),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("无法读取 CLI 启动器：{}", path.display()))
            }
        };
        if !text.lines().any(|line| line.trim() == LAUNCHER_MARKER) {
            return Ok(LauncherState::Conflict);
        }
        let Some(command) = text.lines().find(|line| {
            let line = line.trim();
            line.starts_with('"') && line.ends_with("\" %*")
        }) else {
            return Ok(LauncherState::Owned(PathBuf::new()));
        };
        let raw = command
            .trim()
            .strip_prefix('"')
            .and_then(|line| line.strip_suffix("\" %*"))
            .unwrap_or_default()
            .replace("%%", "%");
        Ok(LauncherState::Owned(PathBuf::from(raw)))
    }

    fn read_user_path() -> Result<(String, Option<RegValue>)> {
        let environment = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Environment", KEY_READ)
            .context("无法读取 Windows 用户环境变量")?;
        match environment.get_raw_value("Path") {
            Ok(raw) => Ok((String::from_reg_value(&raw)?, Some(raw))),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok((String::new(), None)),
            Err(error) => Err(error).context("无法读取 Windows 用户 PATH"),
        }
    }

    fn normalized_windows_path(path: &str) -> String {
        path.trim()
            .trim_matches('"')
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase()
    }

    fn user_path_entry_matches(entry: &str, directory: &Path) -> bool {
        let entry = normalized_windows_path(entry);
        entry == normalized_windows_path(&directory.to_string_lossy())
            || entry == normalized_windows_path(r"%LOCALAPPDATA%\KDJ\bin")
    }

    fn user_path_contains(directory: &Path) -> Result<bool> {
        let (path, _) = read_user_path()?;
        Ok(path
            .split(';')
            .any(|entry| user_path_entry_matches(entry, directory)))
    }

    fn ensure_user_path(directory: &Path) -> Result<()> {
        let (path, previous) = read_user_path()?;
        if path
            .split(';')
            .any(|entry| user_path_entry_matches(entry, directory))
        {
            return Ok(());
        }
        let mut next = path.trim_end_matches(';').to_string();
        if !next.is_empty() {
            next.push(';');
        }
        next.push_str(&directory.to_string_lossy());

        let environment = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
            .context("无法打开 Windows 用户环境变量")?
            .0;
        let mut raw = next.to_reg_value();
        raw.vtype = match previous.as_ref().map(|value| value.vtype.clone()) {
            Some(REG_EXPAND_SZ) => REG_EXPAND_SZ,
            Some(REG_SZ) => REG_SZ,
            _ => REG_EXPAND_SZ,
        };
        environment
            .set_raw_value("Path", &raw)
            .context("无法更新 Windows 用户 PATH")
    }

    fn broadcast_environment_change() {
        let environment = "Environment\0".encode_utf16().collect::<Vec<_>>();
        let mut result = 0usize;
        unsafe {
            let _ = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                environment.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5_000,
                &mut result,
            );
        }
    }

    fn powershell_invocation(path: &Path) -> String {
        format!("& '{}'", path.to_string_lossy().replace('\'', "''"))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::*;

    pub fn status() -> Result<CliInstallStatus> {
        Ok(CliInstallStatus {
            state: CliInstallState::Unsupported,
            current_version: kdj_core::VERSION.to_string(),
            installed_version: None,
            install_path: String::new(),
            invocation: "kdj".into(),
        })
    }

    pub fn install() -> Result<()> {
        bail!("当前平台不支持安装 KDJ CLI")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_state_distinguishes_current_and_outdated() {
        assert_eq!(
            state_for_version(Some(kdj_core::VERSION)),
            CliInstallState::Current
        );
        assert_eq!(
            state_for_version(Some("0.0.0-test")),
            CliInstallState::Outdated
        );
        assert_eq!(state_for_version(None), CliInstallState::Broken);
    }
}
