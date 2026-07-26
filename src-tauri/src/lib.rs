//! Tauri 桌面壳。
//!
//! 和 v0.1.0 的 Electron 版结构上只差一处，但那一处就是全部理由：那边
//! `electron/main.ts` 把 Python sidecar **spawn 成独立进程**，这边 axum server
//! 就在同一个进程里跑一个 tokio 任务。安卓上应用根本没法 spawn 任意可执行文件，
//! 所以「没有 sidecar 进程」是能出 APK 的前提，而不是省事
//! （见 `docs/rust-port/00-architecture.md` §1）。
//!
//! 传输层仍然是 127.0.0.1 上的 HTTP + WS，没有换成 Tauri IPC：前端
//! `src/lib/api.ts` 因此一行不用改，播放器也要靠 Range 请求才能拖进度条。
//! 这一层的安全模型和 Python 版完全一样——只绑回环、每次启动换 token。
//!
//! 这里实现的 6 条命令是 `electron/preload.ts` 的一比一替代品，
//! 名字和参数由 `src/lib/bridge.ts` 固定，改名等于把前端按钮变哑巴。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kumodeck_core::AppConfig;
use serde::Serialize;
use tauri::Manager;
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// 前端连本地 server 需要的两件东西，放进 Tauri 的全局状态。
///
/// Electron 版是通过 `additionalArguments` 把它们塞进渲染进程的 argv，
/// preload 一读就有。Tauri 没有对应机制，所以改成「前端主动来问一次」。
/// 不用事件推送：窗口很可能在 `emit` 之前就跑完了 bootstrap，那是竞态。
pub struct Bridge {
    base_url: String,
    token: String,
}

/// 字段名对齐 `src/types.ts::KumoDeckBridge`，所以要 camelCase。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub base_url: String,
    pub token: String,
    /// 取值和 Electron 的 `process.platform` 对齐（darwin / win32 / linux / android…），
    /// 前端按它区分桌面专属功能，见 `docs/rust-port/00-architecture.md` §8。
    pub platform: String,
}

/// `std::env::consts::OS` 用的是 Rust 的叫法，前端契约用的是 Node 的叫法。
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

// ------------------------------------------------------------------ 命令

/// 前端 bootstrap 的第一次调用：拿到 baseUrl / token 才能发任何请求。
#[tauri::command]
fn get_bridge_info(bridge: tauri::State<'_, Bridge>) -> BridgeInfo {
    BridgeInfo {
        base_url: bridge.base_url.clone(),
        token: bridge.token.clone(),
        platform: node_platform().to_string(),
    }
}

/// 对应 `shell.openPath`：用系统默认程序打开（曲库里是「打开所在文件夹」）。
#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|err| err.to_string())
}

/// 对应 `shell.showItemInFolder`：在文件管理器里选中这个文件本身。
#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(PathBuf::from(path))
        .map_err(|err| err.to_string())
}

/// 选一个目录，取消返回 `null`（和 Electron 的 `canceled → null` 一致）。
///
/// 用回调版而不是 `blocking_pick_folder`：命令有可能落在事件循环所在的线程上，
/// 阻塞式对话框在那里会和事件循环互等死锁。oneshot 把回调转回 async。
#[tauri::command]
async fn pick_folder(_app: tauri::AppHandle) -> Option<String> {
    #[cfg(desktop)]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        _app.dialog().file().pick_folder(move |picked| {
            // 接收端只有在整个命令被取消时才会没了，忽略即可
            let _ = tx.send(picked);
        });
        rx.await
            .ok()
            .flatten()
            .and_then(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
    }
    // 安卓是 scoped storage，没有「任意目录」这回事，前端也不会显示这些入口
    #[cfg(not(desktop))]
    None
}

/// 选多个目录，取消返回 `[]`（Electron 版同样返回空数组而不是 null）。
#[tauri::command]
async fn pick_folders(_app: tauri::AppHandle) -> Vec<String> {
    #[cfg(desktop)]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        _app.dialog().file().pick_folders(move |picked| {
            let _ = tx.send(picked);
        });
        rx.await
            .ok()
            .flatten()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
            .collect()
    }
    #[cfg(not(desktop))]
    Vec::new()
}

/// 自绘标题栏的三个按钮。`maximize` 是**切换**，和 Electron 版一致。
#[tauri::command]
fn window_control(_window: tauri::Window, action: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let result = match action.as_str() {
            "minimize" => _window.minimize(),
            "maximize" => match _window.is_maximized() {
                Ok(true) => _window.unmaximize(),
                Ok(false) => _window.maximize(),
                Err(err) => Err(err),
            },
            "close" => _window.close(),
            other => return Err(format!("未知的窗口动作：{other}")),
        };
        return result.map_err(|err| err.to_string());
    }
    #[cfg(not(desktop))]
    {
        let _ = action;
        Ok(())
    }
}

// ------------------------------------------------------------------ 启动

/// v0.1.0（Electron）用的数据目录。
///
/// **必须沿用它，不能用 Tauri 的 `app_data_dir()`。** 后者会按 bundle identifier
/// 落在 `.../com.kumodeck.app/data`，而 Electron 版按 productName 落在
/// `.../kumodeck/data`。换目录 = 老用户打开新版本看到的是一个空应用：
///
/// - 曲库里 1379 首的记录、评分、备注、cue 点全都读不到；
/// - 更糟的是 `data/sessions/` 下网易云 / QQ / B 站三家的登录态一起失效，
///   得重新扫三次码。provider 层特意为老会话文件写的迁移逻辑也就白写了。
///
/// 用户说过"本地清理重算没问题"，那指的是**分析结果**，不包括重新登录。
///
/// Electron 的 `app.getPath("userData")` 各平台落点：
/// - macOS   `~/Library/Application Support/<productName>`
/// - Windows `%APPDATA%\<productName>`
/// - Linux   `~/.config/<productName>`
///
/// Tauri 的 `app_config_dir()` 是同样的三个基目录（只是拼的是 identifier），
/// 所以这里取它的父目录再拼死 `kumodeck`，就等价于 Electron 的落点。
fn legacy_data_dir(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let base = app
        .path()
        .app_config_dir()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow::anyhow!("拿不到配置目录的父目录"))?;
    Ok(base.join("kumodeck").join("data"))
}

/// 起进程内的 axum server，返回前端要的 baseUrl / token。
fn start_server(app: &tauri::AppHandle) -> anyhow::Result<Bridge> {
    // 每次启动重新生成：token 固定就等于把整个曲库开放给同机任意进程。
    // 32 字节走 `rand::random::<u128>()`，和 providers 里生成会话 id 的写法一致。
    let token = format!(
        "{:032x}{:032x}",
        rand::random::<u128>(),
        rand::random::<u128>()
    );

    // 环境变量只是给调试留的后门；正常启动走 `legacy_data_dir`。
    let data_dir = match std::env::var_os("KUMODECK_DATA_DIR") {
        Some(raw) => PathBuf::from(raw),
        None => legacy_data_dir(app)?,
    };
    // 和 v0.1.0 一致：`~/Music/KumoDeck`。Tauri 的 audio_dir 在 macOS 上就是
    // `~/Music`，等价于 Electron 的 `app.getPath("music")`。
    let download_dir = match std::env::var_os("KUMODECK_DOWNLOAD_DIR") {
        Some(raw) => PathBuf::from(raw),
        None => app
            .path()
            .audio_dir()
            .unwrap_or_else(|_| kumodeck_core::config::home_dir().join("Music"))
            .join("KumoDeck"),
    };

    // 端口传 0 让内核挑：Electron 版是先 listen(0) 探一个再关掉再交给 Python，
    // 那中间有一段「探到的端口被别人抢走」的竞态窗口，这里直接没有。
    let config = Arc::new(AppConfig::create(data_dir, download_dir, token.clone(), 0));
    // serve() 内部 tokio::spawn，需要运行时上下文；Tauri 的全局运行时就是 tokio。
    // 返回的 JoinHandle 故意丢掉——tokio 里 drop JoinHandle 不会取消任务，
    // 服务的生命周期跟着进程走，和 Electron 版 sidecar 跟着主进程走是一个意思。
    let (port, _serve_task) = tauri::async_runtime::block_on(kumodeck_server::serve(config))?;

    Ok(Bridge {
        base_url: format!("http://127.0.0.1:{port}"),
        token,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,kumodeck=debug".into()))
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let bridge = start_server(app.handle())?;
            tracing::info!("KumoDeck 后端就绪：{}", bridge.base_url);
            app.manage(bridge);
            // 服务起好再显示窗口。窗口在配置里是 visible:false，这里补一次 show()——
            // Electron 版靠 `ready-to-show` 做同样的事，为的是不让用户看见
            // 「空窗口 → 内容」的跳变。start_server 失败时直接返回 Err，
            // 窗口不会露面，也就不会出现一个连不上后端的空壳。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_bridge_info,
            open_path,
            reveal_path,
            pick_folder,
            pick_folders,
            window_control
        ])
        .run(tauri::generate_context!())
        .expect("KumoDeck 启动失败");
}
