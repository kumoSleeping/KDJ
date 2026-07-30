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

#[cfg(desktop)]
mod desktop_player;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use kdj_core::AppConfig;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
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

/// 登录二维码落盘结果。电脑进「下载」，手机进「图片/相册」目录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedLoginQr {
    path: String,
    /// `downloads` | `pictures`
    location: &'static str,
}

/// 把登录二维码 PNG（data URL）写到本机，方便用另一台设备扫。
///
/// - 桌面：系统「下载」目录
/// - 手机：系统「图片」目录（相册里能直接挑到）
#[tauri::command]
fn save_login_qr(platform: String, label: String, image: String) -> Result<SavedLoginQr, String> {
    let png = decode_png_data_url(&image)?;
    let (dir, location) = login_qr_save_dir()?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建目录失败：{err}"))?;

    let safe_label = sanitize_filename(if label.trim().is_empty() {
        platform.as_str()
    } else {
        label.trim()
    });
    // 固定文件名：换一张就覆盖，下载/相册里不会堆一堆过期码。
    let path = dir.join(format!("KDJ-登录二维码-{safe_label}.png"));
    std::fs::write(&path, png).map_err(|err| format!("写入二维码失败：{err}"))?;

    Ok(SavedLoginQr {
        path: path.to_string_lossy().into_owned(),
        location,
    })
}

fn decode_png_data_url(image: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    let payload = image
        .strip_prefix("data:image/png;base64,")
        .or_else(|| image.strip_prefix("data:image/PNG;base64,"))
        .ok_or_else(|| "二维码不是 PNG 图片".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|err| format!("解码二维码失败：{err}"))
}

/// 文件名里去掉路径分隔符和明显的非法字符，避免写到奇怪位置。
fn sanitize_filename(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "login".into()
    } else {
        trimmed.to_string()
    }
}

fn login_qr_save_dir() -> Result<(PathBuf, &'static str), String> {
    // 手机：进图片目录，相册/图库一般能直接扫到；桌面：进下载，最容易找到。
    #[cfg(target_os = "android")]
    {
        Ok((PathBuf::from("/storage/emulated/0/Pictures/KDJ"), "pictures"))
    }
    #[cfg(target_os = "ios")]
    {
        // iOS 沙盒写不进系统相册；先落到下载目录，仍可用「打开」定位文件。
        Ok((kdj_core::config::system_download_dir(), "downloads"))
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        Ok((kdj_core::config::system_download_dir(), "downloads"))
    }
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
    let update = updater
        .check()
        .await
        .map_err(|err| format!("读取更新清单失败（发行包可能仍在构建中）：{err}"))?;
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

/// 自绘标题栏的窗口动作。`maximize` 是切换；`drag` 用于 Overlay 顶栏拖动。
#[tauri::command]
fn window_control(
    _window: tauri::Window,
    _app: tauri::AppHandle,
    action: String,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let result = match action.as_str() {
            "minimize" => _window.minimize(),
            "maximize" => match _window.is_maximized() {
                Ok(true) => _window.unmaximize(),
                Ok(false) => _window.maximize(),
                Err(err) => Err(err),
            },
            "close" => {
                // 主窗口关闭时不能把透明歌词窗留成一个看不见入口的孤儿进程。
                if _window.label() == "main" {
                    if let Some(lyrics) = _app.get_webview_window("lyrics-overlay") {
                        let _ = lyrics.close();
                    }
                }
                _window.close()
            }
            // data-tauri-drag-region 在 macOS Overlay 下经常失灵；顶栏 mousedown 显式开拖。
            "drag" => _window.start_dragging(),
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

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DesktopLyricsPosition {
    Top,
    Bottom,
}

#[derive(Debug, Clone, Copy, Serialize)]
struct DesktopLyricsCoordinates {
    x: i32,
    y: i32,
}

#[cfg(desktop)]
fn position_desktop_lyrics(
    window: &tauri::WebviewWindow,
    position: DesktopLyricsPosition,
) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "找不到主显示器".to_string())?;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let window_size = window.outer_size().map_err(|err| err.to_string())?;
    let margin = (24.0 * monitor.scale_factor()).round() as i32;
    let x =
        monitor_position.x + ((monitor_size.width as i64 - window_size.width as i64) / 2) as i32;
    let y = match position {
        DesktopLyricsPosition::Top => monitor_position.y + margin,
        DesktopLyricsPosition::Bottom => {
            monitor_position.y + monitor_size.height as i32 - window_size.height as i32 - margin
        }
    };
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|err| err.to_string())
}

fn desktop_lyrics_inner_size(font_scale: f64) -> (f64, f64) {
    let scale = font_scale.clamp(1.0, 3.0);
    // 基准 900×92；宽度比旧 680 更充裕，避免长歌词（尤其是 CJK）被省略号截断。
    let width = (900.0 * (0.92 + 0.08 * scale)).clamp(520.0, 1200.0);
    let height = (48.0 + 44.0 * scale).clamp(76.0, 220.0);
    (width, height)
}

/// 创建/更新桌面歌词窗口。窗口由 Rust 持有原生层级和鼠标穿透，页面只负责绘字。
#[tauri::command]
fn set_desktop_lyrics(
    app: tauri::AppHandle,
    visible: bool,
    position: DesktopLyricsPosition,
    locked: bool,
    font_scale: Option<f64>,
    reposition: bool,
    x: Option<i32>,
    y: Option<i32>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if !visible {
            if let Some(window) = app.get_webview_window("lyrics-overlay") {
                window.hide().map_err(|err| err.to_string())?;
            }
            return Ok(());
        }

        let scale = font_scale.unwrap_or(1.0).clamp(1.0, 3.0);
        let (width, height) = desktop_lyrics_inner_size(scale);

        let window = match app.get_webview_window("lyrics-overlay") {
            Some(window) => window,
            None => {
                let window = tauri::WebviewWindowBuilder::new(
                    &app,
                    "lyrics-overlay",
                    tauri::WebviewUrl::App("index.html?window=lyrics".into()),
                )
                .title("KDJ 桌面歌词")
                .inner_size(width, height)
                .min_inner_size(420.0, 76.0)
                .resizable(true)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .build()
                .map_err(|err| err.to_string())?;
                let moved_app = app.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Moved(position) = event {
                        let _ = moved_app.emit_to(
                            "lyrics-overlay",
                            "desktop-lyrics-moved",
                            DesktopLyricsCoordinates {
                                x: position.x,
                                y: position.y,
                            },
                        );
                    }
                });
                window
            }
        };

        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|err| err.to_string())?;
        window
            .set_always_on_top(true)
            .map_err(|err| err.to_string())?;
        window
            .set_ignore_cursor_events(locked)
            .map_err(|err| err.to_string())?;
        if reposition {
            if let (Some(x), Some(y)) = (x, y) {
                window
                    .set_position(tauri::PhysicalPosition::new(x, y))
                    .map_err(|err| err.to_string())?;
            } else {
                position_desktop_lyrics(&window, position)?;
            }
        }
        window.show().map_err(|err| err.to_string())?;
        return Ok(());
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, visible, position, locked, font_scale, reposition, x, y);
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
/// 用户数据。运行期的规范数据库名始终由 `DB_FILENAME` 决定；历史上出现过的
/// `kdj.db` / `kumodeck.db` 都映射到它，WAL/SHM 必须同步。
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
            // 同一个旧目录同时有两种名字时，规范名那份优先；否则 read_dir 顺序
            // 会决定最后覆盖成哪一库。那正是升级后“少几首歌”的来源。
            if name.starts_with("kdj.db") && source.join(kdj_core::config::DB_FILENAME).is_file() {
                continue;
            }
            let target_name = match name.as_ref() {
                "kdj.db" | "kumodeck.db" => kdj_core::config::DB_FILENAME.to_string(),
                "kdj.db-wal" | "kumodeck.db-wal" => {
                    format!("{}-wal", kdj_core::config::DB_FILENAME)
                }
                "kdj.db-shm" | "kumodeck.db-shm" => {
                    format!("{}-shm", kdj_core::config::DB_FILENAME)
                }
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

const DB_ALIAS_MERGE_MARKER: &str = ".kdj-db-alias-merged-v1";

/// 修复曾发布过的分叉布局：迁移器写了 `kdj.db`，运行期却继续打开
/// `kumodeck.db`。合并只补当前库没有的 path，绝不覆盖评分、备注和 Cue 等现有编辑。
fn reconcile_database_alias(data_dir: &Path) {
    let canonical = data_dir.join(kdj_core::config::DB_FILENAME);
    let alias = data_dir.join("kdj.db");
    let marker = data_dir.join(DB_ALIAS_MERGE_MARKER);
    if marker.is_file() || !has_file_bytes(&alias) || alias == canonical {
        return;
    }
    match kdj_library::db::merge_legacy_database(&canonical, &alias) {
        Ok(report) => {
            let summary = format!(
                "tracks={} tags={} playlists={} playlist_items={}\n",
                report.tracks, report.tags, report.playlists, report.playlist_items
            );
            if let Err(err) = std::fs::write(&marker, &summary) {
                eprintln!("KDJ: 数据库已合并，但写不下迁移标记：{err}");
            }
            eprintln!("KDJ: 已合并历史 kdj.db：{}", summary.trim());
        }
        Err(err) => {
            // 当前规范库仍原样可用，旧 alias 也一字未改；不能因一份旁路旧库损坏
            // 让整个应用起不来。下次启动还会重试，错误留在启动日志供排查。
            eprintln!("KDJ: 合并历史 kdj.db 失败，将在下次启动重试：{err:#}");
        }
    }
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
    reconcile_database_alias(&current);
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
    // 调试覆盖目录同样可能来自出过问题的版本，不能绕过数据库别名修复。
    reconcile_database_alias(&data_dir);
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
    // 移动端由 MediaSessionService / AVPlayer 承载；桌面由进程内 kdj-player +
    // CPAL 承载。两边最终声音都不再依赖 WebView 生命周期，移动插件仍只在手机入包。
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder.plugin(tauri_plugin_native_audio::init());
    // updater/process 只在桌面注册：安卓的更新走 Release 页下 APK
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    let builder = builder.setup(|app| {
        app.manage(UpdateProgressState::default());
        #[cfg(desktop)]
        app.manage(
            desktop_player::DesktopPlayerHandle::spawn(app.handle().clone())
                .map_err(anyhow::Error::msg)?,
        );
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
    });

    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_bridge_info,
        open_path,
        reveal_path,
        save_login_qr,
        open_external,
        check_desktop_update,
        get_update_progress,
        apply_update,
        pick_folder,
        pick_folders,
        window_control,
        set_desktop_lyrics,
        desktop_player::playback_initialize,
        desktop_player::playback_command,
        desktop_player::playback_state
    ]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_bridge_info,
        open_path,
        reveal_path,
        save_login_qr,
        open_external,
        check_desktop_update,
        get_update_progress,
        apply_update,
        pick_folder,
        pick_folders,
        window_control,
        set_desktop_lyrics
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("KDJ 启动失败");
}
