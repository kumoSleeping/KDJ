//! 桌面二进制的第二种 argv：子命令走 HTTP 客户端，无子命令走 GUI / --no-gui 驻留。

mod args;
mod commands;
mod http;
pub(crate) mod install;
mod runtime;

/// 无子命令、或只有 `--no-gui`/`--hidden`：继续进 Tauri。
/// 其余 argv 当 CLI 客户端处理并退出。
pub enum Launch {
    App { no_gui: bool },
    Client,
}

pub fn launch_mode() -> Launch {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        return Launch::App { no_gui: false };
    }
    let daemon_only = args
        .iter()
        .all(|arg| arg == "--no-gui" || arg == "--hidden");
    if daemon_only {
        return Launch::App { no_gui: true };
    }
    Launch::Client
}

pub fn run_client() -> i32 {
    commands::run()
}

pub fn write_runtime(
    data_dir: &std::path::Path,
    base_url: &str,
    auth_token: &str,
    gui: bool,
) -> anyhow::Result<()> {
    runtime::write_runtime(
        data_dir,
        &runtime::RuntimeInfo {
            pid: std::process::id(),
            version: kdj_core::VERSION.to_string(),
            base_url: base_url.to_string(),
            auth_token: auth_token.to_string(),
            started_at: iso_now(),
            gui,
        },
    )
}

pub fn remove_runtime(data_dir: &std::path::Path) {
    runtime::remove_runtime(data_dir);
}

pub fn maybe_handoff_gui() -> bool {
    if matches!(launch_mode(), Launch::App { no_gui: true }) {
        return false;
    }
    let Some((_, info)) = runtime::read_runtime(None) else {
        return false;
    };
    if runtime::probe_health(&info).is_none() {
        return false;
    }
    let client = http::HttpClient::new(&info.base_url, &info.auth_token);
    client
        .post_json("/api/control/show", &serde_json::json!({}))
        .is_ok()
}

fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{now}")
}
