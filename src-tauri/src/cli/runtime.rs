//! 驻留进程发现：`data_dir/runtime.json`。藏窗 / `--no-gui` 都不删这份文件。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use kdj_core::config::home_dir;
use serde::{Deserialize, Serialize};

use super::http::HttpClient;

pub const RUNTIME_FILENAME: &str = "runtime.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeInfo {
    pub pid: u32,
    pub version: String,
    pub base_url: String,
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
    let path = runtime_path(data_dir);
    let tmp = path.with_extension("json.partial");
    fs::write(&tmp, serde_json::to_vec_pretty(info)?)
        .with_context(|| format!("写 runtime 临时文件失败：{}", tmp.display()))?;
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

pub fn probe_health(base_url: &str) -> Option<serde_json::Value> {
    HttpClient::new(base_url).get_value("/api/health").ok()
}

/// 找到活着的驻留进程；没有则拉起 `--no-gui` 再等 health。
pub fn ensure_running(explicit: Option<&Path>, url_override: Option<&str>) -> Result<String> {
    if let Some(url) = url_override {
        if probe_health(url).is_some() {
            return Ok(url.to_string());
        }
        bail!("指定的 --url 没有响应");
    }
    if let Some((_, info)) = read_runtime(explicit) {
        if probe_health(&info.base_url).is_some() {
            return Ok(info.base_url);
        }
        if let Some((dir, _)) = read_runtime(explicit) {
            remove_runtime(&dir);
        }
    }
    spawn_daemon()?;
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if let Some((_, info)) = read_runtime(explicit) {
            if probe_health(&info.base_url).is_some() {
                return Ok(info.base_url);
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    bail!("KDJ 未能在 45 秒内就绪")
}

fn spawn_daemon() -> Result<()> {
    let exe = std::env::current_exe().context("拿不到当前可执行文件路径")?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--no-gui")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.spawn().context("拉起 KDJ --no-gui 失败")?;
    Ok(())
}
