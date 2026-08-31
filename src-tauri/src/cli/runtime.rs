//! 驻留进程发现：`data_dir/runtime.json`。藏窗 / `--no-gui` 都不删这份文件。

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use kdj_core::config::home_dir;
use serde::{Deserialize, Serialize};

use super::http::HttpClient;

pub const RUNTIME_FILENAME: &str = "runtime.json";

#[derive(Clone, Serialize, Deserialize)]
pub struct RuntimeInfo {
    pub pid: u32,
    pub version: String,
    pub base_url: String,
    #[serde(default)]
    pub auth_token: String,
    pub started_at: String,
    #[serde(default)]
    pub gui: bool,
}

pub fn runtime_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RUNTIME_FILENAME)
}

pub fn write_runtime(data_dir: &Path, info: &RuntimeInfo) -> Result<()> {
    fs::create_dir_all(data_dir)
        .with_context(|| format!("创建数据目录失败：{}", data_dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("保护数据目录失败：{}", data_dir.display()))?;
    }
    let path = runtime_path(data_dir);
    let tmp = data_dir.join(format!(
        ".runtime.json.partial-{:016x}",
        rand::random::<u64>()
    ));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .with_context(|| format!("打开 runtime 临时文件失败：{}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .with_context(|| format!("保护 runtime 临时文件失败：{}", tmp.display()))?;
    }
    serde_json::to_writer_pretty(&mut file, info)
        .with_context(|| format!("写 runtime 临时文件失败：{}", tmp.display()))?;
    file.write_all(b"\n")
        .with_context(|| format!("写 runtime 临时文件失败：{}", tmp.display()))?;
    file.sync_all()
        .with_context(|| format!("同步 runtime 临时文件失败：{}", tmp.display()))?;
    drop(file);
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("替换旧 runtime 失败：{}", path.display()))?;
    }
    fs::rename(&tmp, &path).with_context(|| format!("提交 runtime 失败：{}", path.display()))
}

pub fn remove_runtime(data_dir: &Path) {
    let _ = fs::remove_file(runtime_path(data_dir));
}

pub fn candidate_data_dirs(explicit: Option<&Path>) -> Vec<PathBuf> {
    if let Some(dir) = explicit {
        return vec![dir.to_path_buf()];
    }
    if let Some(dir) = std::env::var_os("KDJ_DATA_DIR") {
        return vec![PathBuf::from(dir)];
    }
    let support = {
        #[cfg(target_os = "macos")]
        {
            home_dir().join("Library").join("Application Support")
        }
        #[cfg(target_os = "windows")]
        {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(home_dir)
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home_dir().join(".config"))
        }
    };
    vec![
        support.join("kdj").join("data"),
        support.join("com.kdj.app").join("data"),
        support.join("kumodeck").join("data"),
    ]
}

pub fn read_runtime(explicit: Option<&Path>) -> Option<(PathBuf, RuntimeInfo)> {
    for dir in candidate_data_dirs(explicit) {
        let path = runtime_path(&dir);
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        if let Ok(info) = serde_json::from_slice::<RuntimeInfo>(&bytes) {
            return Some((dir, info));
        }
    }
    None
}

pub fn probe_health(info: &RuntimeInfo) -> Option<serde_json::Value> {
    if info.auth_token.is_empty() {
        return None;
    }
    HttpClient::new(&info.base_url, &info.auth_token)
        .get_value("/api/health")
        .ok()
}

/// 找到活着的驻留进程；没有则拉起 `--no-gui` 再等 health。
pub fn ensure_running(explicit: Option<&Path>, url_override: Option<&str>) -> Result<RuntimeInfo> {
    if let Some(url) = url_override {
        let normalized = url.trim_end_matches('/');
        if let Some((_, info)) = read_runtime(explicit) {
            if info.base_url.trim_end_matches('/') == normalized && probe_health(&info).is_some() {
                return Ok(info);
            }
        }
        if let Ok(auth_token) = std::env::var("KDJ_AUTH_TOKEN") {
            let info = RuntimeInfo {
                pid: 0,
                version: String::new(),
                base_url: normalized.to_string(),
                auth_token,
                started_at: String::new(),
                gui: false,
            };
            if probe_health(&info).is_some() {
                return Ok(info);
            }
        }
        bail!("指定的 --url 没有通过认证；请同时指定 data_dir 或 KDJ_AUTH_TOKEN");
    }
    if let Some((_, info)) = read_runtime(explicit) {
        if probe_health(&info).is_some() {
            return Ok(info);
        }
        if let Some((dir, _)) = read_runtime(explicit) {
            remove_runtime(&dir);
        }
    }
    spawn_daemon(explicit)?;
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if let Some((_, info)) = read_runtime(explicit) {
            if probe_health(&info).is_some() {
                return Ok(info);
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    bail!("KDJ 未能在 45 秒内就绪")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    #[test]
    fn runtime_secret_is_written_private() {
        let dir = std::env::temp_dir().join(format!(
            "kdj-runtime-permissions-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let info = RuntimeInfo {
            pid: 7,
            version: "test".into(),
            base_url: "http://127.0.0.1:1234".into(),
            auth_token: "secret".into(),
            started_at: "now".into(),
            gui: true,
        };
        write_runtime(&dir, &info).unwrap();
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(runtime_path(&dir))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let loaded = read_runtime(Some(&dir)).unwrap().1;
        assert_eq!(loaded.auth_token, "secret");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn explicit_data_dir_is_forwarded_to_the_daemon_as_environment() {
        let data_dir = Path::new("/tmp/kdj-cli-explicit-data");
        let command = daemon_command(Path::new("/tmp/kdj-app"), Some(data_dir));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new("--no-gui")]
        );
        let forwarded = command
            .get_envs()
            .find(|(name, _)| *name == std::ffi::OsStr::new("KDJ_DATA_DIR"))
            .and_then(|(_, value)| value);
        assert_eq!(forwarded, Some(data_dir.as_os_str()));
    }
}

fn spawn_daemon(data_dir: Option<&Path>) -> Result<()> {
    let exe = std::env::current_exe().context("拿不到当前可执行文件路径")?;
    daemon_command(&exe, data_dir)
        .spawn()
        .context("拉起 KDJ --no-gui 失败")?;
    Ok(())
}

fn daemon_command(exe: &Path, data_dir: Option<&Path>) -> std::process::Command {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--no-gui")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(data_dir) = data_dir {
        // `--data-dir` 是 CLI 客户端参数，直接传给守护进程会让
        // launch_mode 把它再次当成 CLI。用同一个配置环境变量才能让
        // 新进程把 runtime.json 写回客户端指定的位置。
        cmd.env("KDJ_DATA_DIR", data_dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd
}
