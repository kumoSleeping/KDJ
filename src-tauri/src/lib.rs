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
//! 服务只绑回环地址，Tauri 与本机浏览器调试都可以直接访问。
//!
//! 这里实现的 6 条命令是 `electron/preload.ts` 的一比一替代品，
//! 名字和参数由 `src/lib/bridge.ts` 固定，改名等于把前端按钮变哑巴。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use kdj_core::AppConfig;
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
}

const RELEASE_PAGE: &str = "https://github.com/kumoSleeping/KDJ/releases/latest";

/// Updater 下载在 Rust 里执行，前端用一个很轻的 IPC 轮询读这里。
/// 不用全局事件：更新开始后窗口很快会退出，轮询没有订阅/退订竞态，也不会把
/// tauri-plugin-updater 的 JS 绑定和 ACL 暴露给页面。
#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    pub stage: &'static str,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub message: String,
}

impl Default for UpdateProgress {
    fn default() -> Self {
        Self {
            stage: "idle",
            downloaded: 0,
            total: None,
            message: String::new(),
        }
    }
}

#[derive(Default)]
pub struct UpdateProgressState(Mutex<UpdateProgress>);

impl UpdateProgressState {
    fn replace(&self, progress: UpdateProgress) {
        // 更新进度不是值得让整个应用 panic 的状态；上次持锁线程若异常退出，
        // 仍取回 inner 继续写，最多丢一帧进度。
        *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = progress;
    }

    fn get(&self) -> UpdateProgress {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DesktopUpdateInfo {
    pub current: String,
    pub latest: String,
    pub newer: bool,
    pub url: String,
    pub name: String,
    pub published_at: String,
    pub notes: String,
}

/// 字段名对齐 `src/types.ts::KdjBridge`，所以要 camelCase。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub base_url: String,
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

/// 前端 bootstrap 的第一次调用：拿到动态分配的 baseUrl。
#[tauri::command]
fn get_bridge_info(bridge: tauri::State<'_, Bridge>) -> BridgeInfo {
    BridgeInfo {
        base_url: bridge.base_url.clone(),
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

/// 用系统浏览器开外链（Release 下载页）。只放行 http(s)——
/// opener 什么 scheme 都肯开，file:// 之类的从网页侧透进来就是提权。
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("拒绝打开非 http(s) 链接：{url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| err.to_string())
}

/// 桌面检查必须直接问 updater 清单，而不是只问 GitHub 最新 Release。
/// Release 是先建空壳、各平台包后上传的；只有 updater.check() 找得到当前
/// OS/架构/安装格式对应的签名包，按钮才应该告诉用户「可以更新」。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn check_desktop_update(app: tauri::AppHandle) -> Result<DesktopUpdateInfo, String> {
    use tauri_plugin_updater::UpdaterExt;

    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|err| err.to_string())?;
    let update = updater.check().await.map_err(|err| err.to_string())?;
    Ok(match update {
        Some(update) => DesktopUpdateInfo {
            current,
            latest: update.version.clone(),
            newer: true,
            url: RELEASE_PAGE.into(),
            name: format!("KDJ v{}", update.version),
            published_at: update.date.map(|date| date.to_string()).unwrap_or_default(),
            notes: update.body.unwrap_or_default(),
        },
        None => DesktopUpdateInfo {
            latest: current.clone(),
            current,
            newer: false,
            url: RELEASE_PAGE.into(),
            name: "KDJ".into(),
            published_at: String::new(),
            notes: String::new(),
        },
    })
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
async fn check_desktop_update() -> Result<DesktopUpdateInfo, String> {
    Err("这个平台由系统应用商店或安装器负责更新".into())
}

#[tauri::command]
fn get_update_progress(progress: tauri::State<'_, UpdateProgressState>) -> UpdateProgress {
    progress.get()
}

fn fail_update(app: &tauri::AppHandle, error: impl ToString) -> String {
    let message = error.to_string();
    app.state::<UpdateProgressState>().replace(UpdateProgress {
        stage: "failed",
        downloaded: 0,
        total: None,
        message: message.clone(),
    });
    message
}

/// 一键更新：查 → 下载（minisign 校验）→ 原地替换 → 重启。
/// 全托管在 Rust 侧，前端一次 invoke 到底；错误原样带回去就地显示。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn apply_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    app.state::<UpdateProgressState>().replace(UpdateProgress {
        stage: "checking",
        downloaded: 0,
        total: None,
        message: "正在确认当前平台的签名更新包".into(),
    });
    let updater = app.updater().map_err(|err| fail_update(&app, err))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|err| fail_update(&app, err))?
    else {
        return Err(fail_update(&app, "已经是最新版本"));
    };

    let progress_app = app.clone();
    let install_app = app.clone();
    let mut downloaded_bytes = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded_bytes = downloaded_bytes.saturating_add(chunk as u64);
                progress_app.state::<UpdateProgressState>().replace(UpdateProgress {
                    stage: "downloading",
                    downloaded: downloaded_bytes,
                    total,
                    message: "正在下载并校验更新包".into(),
                });
                tracing::info!("更新下载中：{downloaded_bytes}/{total:?}");
            },
            move || {
                let current = install_app.state::<UpdateProgressState>().get();
                install_app.state::<UpdateProgressState>().replace(UpdateProgress {
                    stage: "installing",
                    downloaded: current.downloaded,
                    total: current.total.or(Some(current.downloaded)),
                    message: "签名校验通过，正在安装".into(),
                });
                tracing::info!("更新下载完成，开始安装");
            },
        )
        .await
        .map_err(|err| fail_update(&app, err))?;
    let completed = app.state::<UpdateProgressState>().get();
    app.state::<UpdateProgressState>().replace(UpdateProgress {
        stage: "restarting",
        downloaded: completed.downloaded,
        total: completed.total.or(Some(completed.downloaded)),
        message: "安装完成，正在重启".into(),
    });
    // 替换完的二进制要重启才生效；不重启的话用户看着"更新完了"但跑的还是旧版
    app.restart();
}

/// 移动端同名占位：generate_handler 不接受按 cfg 缺席的命令，
/// 这里直接把"按平台该怎么办"说给前端听。
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
async fn apply_update() -> Result<(), String> {
    Err("这个平台不支持一键更新，请去 Release 页下载最新安装包".into())
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
/// 落在 `.../com.kdj.app/data`，而 Electron 版按 productName 落在
/// `.../kdj/data`。换目录 = 老用户打开新版本看到的是一个空应用：
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
/// 所以这里取它的父目录再拼死 `kdj`，就等价于 Electron 的落点。
fn has_file_bytes(path: &Path) -> bool {
    std::fs::metadata(path).map(|meta| meta.len() > 0).unwrap_or(false)
}

/// 把旧应用数据逐项迁移到新的 KDJ 数据目录。
///
/// 不能只迁移 settings.json：曲库数据库、封面和 providers 的 sessions 都是
/// 用户数据。数据库文件名也随项目改名了，所以 kumodeck.db 需要映射成 kdj.db，
/// WAL/SHM 同样要映射，否则 SQLite 会只看到一个空库。
fn migrate_legacy_data(current: &Path, legacy: &Path, force: bool) -> anyhow::Result<bool> {
    if !legacy.exists() {
        return Ok(false);
    }
    std::fs::create_dir_all(current)?;
    let mut copied = false;

    fn copy_tree(source: &Path, root: &Path, copied: &mut bool, force: bool) -> anyhow::Result<()> {
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            let source_path = entry.path();
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            let target_name = match name.as_ref() {
                "kumodeck.db" => "kdj.db".to_string(),
                "kumodeck.db-wal" => "kdj.db-wal".to_string(),
                "kumodeck.db-shm" => "kdj.db-shm".to_string(),
                _ => name.to_string(),
            };
            let target_path = root.join(target_name);
            if source_path.is_dir() {
                std::fs::create_dir_all(&target_path)?;
                copy_tree(&source_path, &target_path, copied, force)?;
                continue;
            }
            let source_size = std::fs::metadata(&source_path)?.len();
            let target_size = std::fs::metadata(&target_path).map(|meta| meta.len()).unwrap_or(0);
            // 目标已经有更新的数据时不覆盖；首次启动的空数据库/默认设置则由旧数据补齐。
            if force || !target_path.exists() || source_size > target_size {
                // 错误版本可能已在新目录写过少量数据。旧数据优先恢复，但覆盖前
                // 给每个现有文件留一份副本，任何迁移判断失误都能人工找回。
                if force && target_path.exists() {
                    let backup_name = format!("{}.before-legacy-migration", target_path.file_name().unwrap_or_default().to_string_lossy());
                    let backup = target_path.with_file_name(backup_name);
                    if !backup.exists() {
                        std::fs::copy(&target_path, backup)?;
                    }
                }
                std::fs::copy(&source_path, &target_path)?;
                *copied = true;
            }
        }
        Ok(())
    }

    copy_tree(legacy, current, &mut copied, force)?;
    Ok(copied)
}

fn default_data_dir(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let current = app.path().app_config_dir()?.join("data");
    let base = app
        .path()
        .app_config_dir()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow::anyhow!("拿不到配置目录的父目录"))?;

    // 旧版本实际使用过 kumodeck，也有一版迁移代码预期 kdj；两处都认，
    // 但不会把当前 com.kdj.app/data 当成旧目录再次拷贝。
    let legacy_candidates = [base.join("kumodeck").join("data"), base.join("kdj").join("data")];
    let current_has_sessions = current.join("sessions").exists();
    let marker = current.join(".legacy-data-migrated");
    for legacy in legacy_candidates {
        let legacy_has_database = has_file_bytes(&legacy.join("kumodeck.db"))
            || has_file_bytes(&legacy.join("kdj.db"));
        let legacy_has_sessions = legacy.join("sessions").exists();
        if legacy_has_database && !marker.exists() && (!current_has_sessions || legacy_has_sessions)
        {
            // 当前目录可能已经被错误版本创建过空库，首次发现旧会话时以旧数据为准，
            // 强制整体替换数据库及 WAL，避免新旧 WAL 混在一起造成 SQLite 不一致。
            if migrate_legacy_data(&current, &legacy, true)? {
                std::fs::write(&marker, b"migrated\n")?;
                eprintln!("KDJ: 已从 {} 迁移曲库、封面和登录凭证", legacy.display());
            }
            break;
        }
    }
    Ok(current)
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

/// 起进程内的 axum server，返回前端要的 baseUrl / token。
fn start_server(app: &tauri::AppHandle) -> anyhow::Result<Bridge> {
    // 环境变量只是给调试留的后门；正常启动走带旧数据迁移的 default_data_dir。
    let data_dir = env_path("KDJ_DATA_DIR")
        .map(Ok)
        .unwrap_or_else(|| default_data_dir(app))?;
    // 默认落到系统的「下载」目录（本地化的那个）+ KDJ 子目录。
    // 这只是全新安装的默认值：settings.json 里存过的目录永远优先。
    // 安卓上 Tauri 的 download_dir() 会报错，退回 core 里同一套解析。
    let download_dir = match env_path("KDJ_DOWNLOAD_DIR") {
        Some(raw) => raw,
        None => app
            .path()
            .download_dir()
            .map(|dir| dir.join("KDJ"))
            .unwrap_or_else(|_| kdj_core::config::default_download_root()),
    };

    // 端口传 0 让内核挑：Electron 版是先 listen(0) 探一个再关掉再交给 Python，
    // 那中间有一段「探到的端口被别人抢走」的竞态窗口，这里直接没有。
    let config = Arc::new(AppConfig::create(data_dir, download_dir, 0));
    // serve() 内部 tokio::spawn，需要运行时上下文；Tauri 的全局运行时就是 tokio。
    // 返回的 JoinHandle 故意丢掉——tokio 里 drop JoinHandle 不会取消任务，
    // 服务的生命周期跟着进程走，和 Electron 版 sidecar 跟着主进程走是一个意思。
    let (port, _serve_task) = tauri::async_runtime::block_on(kdj_server::serve(config))?;

    Ok(Bridge {
        base_url: format!("http://127.0.0.1:{port}"),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,kdj=debug".into()))
        .init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // updater/process 只在桌面注册：安卓的更新走 Release 页下 APK
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .setup(|app| {
            app.manage(UpdateProgressState::default());
            let bridge = start_server(app.handle())?;
            tracing::info!("KDJ 后端就绪：{}", bridge.base_url);
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
            open_external,
            check_desktop_update,
            get_update_progress,
            apply_update,
            pick_folder,
            pick_folders,
            window_control
        ])
        .run(tauri::generate_context!())
        .expect("KDJ 启动失败");
}
