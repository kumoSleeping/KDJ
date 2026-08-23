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

#[cfg(target_os = "android")]
mod android_media;
#[cfg(desktop)]
mod desktop_media;
/// 桌面 + Android 共用 playback_* 命令；iOS 仍走 native-audio 插件。
#[cfg(any(desktop, target_os = "android"))]
mod desktop_player;
#[cfg(desktop)]
mod midi;
#[cfg(desktop)]
mod virtual_disk;

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
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = progress;
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
/// - 安卓：不走这条命令（scoped storage 直写进不了相册），前端调
///   `plugin:native-audio|save_png_to_gallery` 走 MediaStore
#[tauri::command]
fn save_login_qr(platform: String, label: String, image: String) -> Result<SavedLoginQr, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (platform, label, image);
        return Err(
            "安卓请通过相册接口保存登录二维码（MediaStore），不要直写 Pictures 目录".into(),
        );
    }
    #[cfg(not(target_os = "android"))]
    {
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
}

#[cfg(not(target_os = "android"))]
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
#[cfg(not(target_os = "android"))]
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

#[cfg(not(target_os = "android"))]
fn login_qr_save_dir() -> Result<(PathBuf, &'static str), String> {
    // iOS 沙盒写不进系统相册；先落到下载目录。桌面进系统下载，最容易找到。
    // 安卓正式路径走 native-audio 的 MediaStore，不经过这里。
    Ok((kdj_core::config::system_download_dir(), "downloads"))
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

#[cfg(desktop)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SoundCloudOAuthWindowResult {
    status: &'static str,
    message: String,
}

#[cfg(desktop)]
fn is_soundcloud_callback(url: &tauri::Url) -> bool {
    url.scheme() == "kdj" && url.host_str() == Some("soundcloud") && url.path() == "/callback"
}

/// 在独立原生窗口里完成 SoundCloud OAuth，并在导航发生前截住自定义协议回调。
///
/// 这条路径不依赖操作系统注册 `kdj://`：macOS 的裸 `tauri dev`、Windows/Linux
/// 的第二实例问题都不会再截走回调。远端页面没有 Tauri capability，只承担登录页。
#[cfg(desktop)]
#[tauri::command]
fn open_soundcloud_oauth_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, Ordering};

    let authorization_url = tauri::Url::parse(&url).map_err(|err| err.to_string())?;
    if authorization_url.scheme() != "https"
        || authorization_url.host_str() != Some("secure.soundcloud.com")
        || authorization_url.path() != "/authorize"
    {
        return Err("拒绝打开非 SoundCloud OAuth 地址".into());
    }

    if let Some(existing) = app.get_webview_window("soundcloud-oauth") {
        let _ = existing.close();
    }

    let base_url = app.state::<Bridge>().base_url.clone();
    let completed = Arc::new(AtomicBool::new(false));
    let completed_on_navigation = completed.clone();
    let app_on_navigation = app.clone();
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "soundcloud-oauth",
        tauri::WebviewUrl::External(authorization_url),
    )
    .title("SoundCloud 登录")
    .inner_size(520.0, 720.0)
    .min_inner_size(360.0, 520.0)
    .center()
    .resizable(true)
    .on_navigation(move |callback_url| {
        if !is_soundcloud_callback(callback_url) {
            return true;
        }

        // 只认本窗口第一次回调，避免重复导航导致 authorization code 被交换两次。
        if completed_on_navigation.swap(true, Ordering::SeqCst) {
            return false;
        }

        let state = callback_url
            .query_pairs()
            .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
            .unwrap_or_default();
        let code = callback_url
            .query_pairs()
            .find_map(|(key, value)| (key == "code").then(|| value.into_owned()))
            .unwrap_or_default();
        let oauth_error = callback_url
            .query_pairs()
            .find_map(|(key, value)| {
                (key == "error_description" || key == "error").then(|| value.into_owned())
            })
            .unwrap_or_default();
        let app = app_on_navigation.clone();
        let endpoint = format!("{base_url}/api/accounts/soundcloud/login/oauth/callback");

        tauri::async_runtime::spawn(async move {
            let result = if !oauth_error.is_empty() {
                Err(oauth_error)
            } else if state.is_empty() || code.is_empty() {
                Err("SoundCloud 授权回调不完整".into())
            } else {
                match reqwest::Client::new()
                    .post(endpoint)
                    .json(&serde_json::json!({ "state": state, "code": code }))
                    .send()
                    .await
                {
                    Ok(response) if response.status().is_success() => Ok(()),
                    Ok(response) => {
                        let status = response.status();
                        let detail = response.text().await.unwrap_or_default();
                        Err(if detail.trim().is_empty() {
                            format!("SoundCloud 登录失败：{status}")
                        } else {
                            format!("SoundCloud 登录失败：{detail}")
                        })
                    }
                    Err(error) => Err(format!("处理 SoundCloud 授权失败：{error}")),
                }
            };

            let payload = match result {
                Ok(()) => SoundCloudOAuthWindowResult {
                    status: "done",
                    message: String::new(),
                },
                Err(message) => SoundCloudOAuthWindowResult {
                    status: "error",
                    message,
                },
            };
            let _ = app.emit("soundcloud-oauth://result", payload);
            if let Some(window) = app.get_webview_window("soundcloud-oauth") {
                let _ = window.close();
            }
        });
        false
    })
    .build()
    .map_err(|err| format!("打开 SoundCloud 登录窗口失败：{err}"))?;

    let app_on_close = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. })
            && !completed.swap(true, Ordering::SeqCst)
        {
            let _ = app_on_close.emit(
                "soundcloud-oauth://result",
                SoundCloudOAuthWindowResult {
                    status: "cancelled",
                    message: "已取消 SoundCloud 登录".into(),
                },
            );
        }
    });
    Ok(())
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
                progress_app
                    .state::<UpdateProgressState>()
                    .replace(UpdateProgress {
                        stage: "downloading",
                        downloaded: downloaded_bytes,
                        total,
                        message: "正在下载并校验更新包".into(),
                    });
                tracing::info!("更新下载中：{downloaded_bytes}/{total:?}");
            },
            move || {
                let current = install_app.state::<UpdateProgressState>().get();
                install_app
                    .state::<UpdateProgressState>()
                    .replace(UpdateProgress {
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
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    #[cfg(desktop)]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog().file().pick_folder(move |picked| {
            // 接收端只有在整个命令被取消时才会没了，忽略即可
            let _ = tx.send(picked);
        });
        return rx
            .await
            .ok()
            .flatten()
            .and_then(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned());
    }
    // 安卓正式选目录走前端 bridge → native-audio；这里只作兼容空实现。
    // iOS 仍回落应用可扫音乐目录。
    #[cfg(all(not(desktop), target_os = "android"))]
    {
        let _ = app;
        None
    }
    #[cfg(all(not(desktop), target_os = "ios"))]
    {
        mobile_library_roots(&app).into_iter().next()
    }
}

/// 选多个目录，取消返回 `[]`（Electron 版同样返回空数组而不是 null）。
#[tauri::command]
async fn pick_folders(app: tauri::AppHandle) -> Vec<String> {
    #[cfg(desktop)]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog().file().pick_folders(move |picked| {
            let _ = tx.send(picked);
        });
        return rx
            .await
            .ok()
            .flatten()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
    }
    // 安卓正式入口在前端 bridge → native-audio `pick_library_folder`
    //（ACTION_OPEN_DOCUMENT_TREE）；这里返回空，避免再整包塞入 Music/Download。
    // iOS：系统 folder picker 仍未接上，继续回落应用可扫目录。
    #[cfg(all(not(desktop), target_os = "android"))]
    {
        let _ = app;
        Vec::new()
    }
    #[cfg(all(not(desktop), target_os = "ios"))]
    {
        mobile_library_roots(&app)
    }
}

/// 移动端可写、可扫的曲库候选根目录。
#[cfg(any(target_os = "android", target_os = "ios"))]
fn mobile_library_roots(app: &tauri::AppHandle) -> Vec<String> {
    let mut roots = Vec::new();
    // 用规范化后的真实路径去重：/sdcard 与 /storage/emulated/0 是同一目录的
    // 两个写法，字符串比较认不出，会导致同一文件夹被扫两遍。
    let mut seen = std::collections::HashSet::new();
    let mut push_dir = |dir: PathBuf| {
        if std::fs::create_dir_all(&dir).is_ok() {
            let key = dir.canonicalize().unwrap_or_else(|_| dir.clone());
            let text = dir.to_string_lossy().into_owned();
            if seen.insert(key) {
                roots.push(text);
            }
        }
    };

    // 1) 应用专属外部 Music（无需整盘存储权限，Android 10+ 可写）
    if let Ok(audio) = app.path().audio_dir() {
        push_dir(audio.join("KDJ"));
    }
    // 2) 应用文档/数据目录兜底
    if let Ok(docs) = app.path().document_dir() {
        push_dir(docs.join("KDJ-Music"));
    }
    if let Ok(data) = app.path().app_data_dir() {
        push_dir(data.join("music"));
    }
    // 3) 常见公共 Music 路径（有权限时 scan 能读到用户已有文件）
    #[cfg(target_os = "android")]
    {
        for candidate in [
            "/storage/emulated/0/Music",
            "/storage/emulated/0/Download/Music",
            "/sdcard/Music",
        ] {
            let path = PathBuf::from(candidate);
            if path.is_dir() {
                push_dir(path);
            }
        }
    }
    roots
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
                // macOS：红灯/自绘关闭 = 藏到程序坞，播放继续；真退出走 Cmd+Q / 程序坞「退出」。
                // 其它平台仍是关窗退出。
                #[cfg(target_os = "macos")]
                if _window.label() == "main" {
                    return _window.hide().map_err(|err| err.to_string());
                }
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

/// 主窗原生底色：与 design.css 的 `--kd-bg` 对齐。
#[cfg(desktop)]
fn window_theme_color(theme: &str) -> Result<tauri::window::Color, String> {
    match theme {
        "dark" => Ok(tauri::window::Color(0x11, 0x11, 0x13, 0xff)),
        "light" => Ok(tauri::window::Color(0xf2, 0xf2, 0xf2, 0xff)),
        other => Err(format!("未知的窗口主题：{other}")),
    }
}

/// 把主窗原生底色改成与 Web 主题一致。歌词窗必须保持透明，这里直接跳过。
#[cfg(desktop)]
fn apply_main_window_background(window: &tauri::WebviewWindow, theme: &str) -> Result<(), String> {
    if window.label() != "main" {
        return Ok(());
    }
    let color = window_theme_color(theme)?;
    window
        .set_background_color(Some(color))
        .map_err(|err| err.to_string())
}

/// settings 里的 system 要落到具体深/浅；读不到系统偏好时按浅色（与 default_theme 一致）。
#[cfg(desktop)]
fn resolve_startup_theme(theme: kdj_core::Theme, window: &tauri::WebviewWindow) -> &'static str {
    match theme {
        kdj_core::Theme::Dark => "dark",
        kdj_core::Theme::Light => "light",
        kdj_core::Theme::System => match window.theme() {
            Ok(tauri::Theme::Dark) => "dark",
            _ => "light",
        },
    }
}

/// 让原生窗口底色跟随 Web 主题。macOS 快速拖窗时系统会短暂直接合成窗口底层；
/// 若浅色页面仍垫着配置中的深色底色，右缘就会露出一块黑影。
#[tauri::command]
fn set_window_background(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        return apply_main_window_background(&window, &theme);
    }
    #[cfg(not(desktop))]
    {
        let _ = (window, theme);
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
    std::fs::metadata(path)
        .map(|meta| meta.len() > 0)
        .unwrap_or(false)
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
            let target_size = std::fs::metadata(&target_path)
                .map(|meta| meta.len())
                .unwrap_or(0);
            // 目标已经有更新的数据时不覆盖；首次启动的空数据库/默认设置则由旧数据补齐。
            if force || !target_path.exists() || source_size > target_size {
                // 错误版本可能已在新目录写过少量数据。旧数据优先恢复，但覆盖前
                // 给每个现有文件留一份副本，任何迁移判断失误都能人工找回。
                if force && target_path.exists() {
                    let backup_name = format!(
                        "{}.before-legacy-migration",
                        target_path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                    );
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
    // 移动端：只使用应用沙箱目录。不要做桌面 Electron 那套 parent()/kdj 迁移——
    // 那是为 macOS/Windows/Linux 的 productName 布局写的；在安卓上乱翻父目录
    // 既无意义，也更容易在 Path/JNI 未就绪时踩坑。
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let current = app
            .path()
            .app_config_dir()
            .or_else(|_| app.path().app_data_dir())
            .map_err(|err| anyhow::anyhow!("移动端拿不到应用数据目录：{err}"))?
            .join("data");
        std::fs::create_dir_all(&current)?;
        reconcile_database_alias(&current);
        return Ok(current);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let current = app.path().app_config_dir()?.join("data");
        let base = app
            .path()
            .app_config_dir()?
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| anyhow::anyhow!("拿不到配置目录的父目录"))?;

        // 旧版本实际使用过 kumodeck，也有一版迁移代码预期 kdj；两处都认，
        // 但不会把当前 com.kdj.app/data 当成旧目录再次拷贝。
        let legacy_candidates = [
            base.join("kumodeck").join("data"),
            base.join("kdj").join("data"),
        ];
        let current_has_sessions = current.join("sessions").exists();
        let marker = current.join(".legacy-data-migrated");
        for legacy in legacy_candidates {
            let legacy_has_database = has_file_bytes(&legacy.join("kumodeck.db"))
                || has_file_bytes(&legacy.join("kdj.db"));
            let legacy_has_sessions = legacy.join("sessions").exists();
            if legacy_has_database
                && !marker.exists()
                && (!current_has_sessions || legacy_has_sessions)
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
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

/// 解析默认下载目录。移动端**禁止**回落到 `directories`/`ndk-context` 链路。
fn resolve_download_dir(app: &tauri::AppHandle, data_dir: &Path) -> PathBuf {
    if let Some(raw) = env_path("KDJ_DOWNLOAD_DIR") {
        return raw;
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        // 优先系统 Download（Tauri Path 插件，走 Activity，不经 ndk-context）；
        // 再退 app 数据目录；最后 data_dir/downloads——保证总能起服。
        if let Ok(dir) = app.path().download_dir() {
            let target = dir.join("KDJ");
            let _ = std::fs::create_dir_all(&target);
            return target;
        }
        if let Ok(dir) = app.path().app_data_dir() {
            let target = dir.join("KDJ-downloads");
            let _ = std::fs::create_dir_all(&target);
            return target;
        }
        let target = data_dir.join("downloads");
        let _ = std::fs::create_dir_all(&target);
        return target;
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = data_dir;
        app.path()
            .download_dir()
            .map(|dir| dir.join("KDJ"))
            .unwrap_or_else(|_| kdj_core::config::default_download_root())
    }
}

/// 起进程内的 axum server，返回前端要的 baseUrl / token。
fn start_server(app: &tauri::AppHandle) -> anyhow::Result<(Bridge, kdj_core::Theme)> {
    // 环境变量只是给调试留的后门；正常启动走带旧数据迁移的 default_data_dir。
    let data_dir = env_path("KDJ_DATA_DIR")
        .map(Ok)
        .unwrap_or_else(|| default_data_dir(app))?;
    // 调试覆盖目录同样可能来自出过问题的版本，不能绕过数据库别名修复。
    reconcile_database_alias(&data_dir);
    let download_dir = resolve_download_dir(app, &data_dir);

    // 端口传 0 让内核挑：Electron 版是先 listen(0) 探一个再关掉再交给 Python，
    // 那中间有一段「探到的端口被别人抢走」的竞态窗口，这里直接没有。
    let config = Arc::new(AppConfig::create(data_dir, download_dir, 0));
    // show() 前要用这份主题垫原生底色，否则浅色用户会先看到配置默认底闪一下。
    let theme = config.to_settings().theme;
    // serve() 内部 tokio::spawn，需要运行时上下文；Tauri 的全局运行时就是 tokio。
    // 返回的 JoinHandle 故意丢掉——tokio 里 drop JoinHandle 不会取消任务，
    // 服务的生命周期跟着进程走，和 Electron 版 sidecar 跟着主进程走是一个意思。
    let (port, _serve_task) = tauri::async_runtime::block_on(kdj_server::serve(config))?;

    Ok((
        Bridge {
            base_url: format!("http://127.0.0.1:{port}"),
        },
        theme,
    ))
}

/// Activity 的全局 JNI 引用。局部引用只在创建它的 Java 线程内有效，
/// 而播放器线程 / IPC 线程都要拿它调 JNI（cpal AAudio、权限检查），
/// 所以必须转全局引用并保活——直接存局部引用会导致 CheckJNI SIGABRT。
#[cfg(target_os = "android")]
static ANDROID_ACTIVITY_GLOBAL: std::sync::OnceLock<jni::objects::GlobalRef> =
    std::sync::OnceLock::new();

/// 安卓 JNI 入口：Tauri 的 `mobile_entry_point` 不会初始化 `ndk-context`，
/// 而 cpal 的 AAudio host 在第一次打开输出时就要用 JNI 上下文（
/// `ndk_context::android_context()`，拿不到就 panic `android context was not initialized`）。
/// Kotlin 侧 `MainActivity.onCreate` 最先调用本函数（在 Tauri setup 启动播放器线程之前），
/// 把 JavaVM 与 Activity 存进 ndk-context 全局，CPAL/AAudio 才能工作。
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_kdj_app_MainActivity_initNdkContext(
    mut env: jni::JNIEnv,
    activity: jni::objects::JObject,
) {
    let vm = match env.get_java_vm() {
        Ok(vm) => vm,
        Err(err) => {
            tracing::error!("KDJ: 拿不到 JavaVM，ndk-context 初始化失败：{err}");
            return;
        }
    };
    let global = match env.new_global_ref(&activity) {
        Ok(g) => g,
        Err(err) => {
            tracing::error!("KDJ: 转全局引用失败，ndk-context 初始化失败：{err}");
            return;
        }
    };
    let vm_ptr = vm.get_java_vm_pointer() as *mut std::ffi::c_void;
    let context_ptr = global.as_obj().as_raw() as *mut std::ffi::c_void;
    unsafe {
        ndk_context::initialize_android_context(vm_ptr, context_ptr);
    }
    let _ = ANDROID_ACTIVITY_GLOBAL.set(global);
    tracing::info!("KDJ: ndk-context 已初始化（全局引用保活）");
}

/// 安卓：查询是否已授予媒体读取权限（READ_MEDIA_AUDIO / READ_EXTERNAL_STORAGE）。
/// 前端在「添加文件夹后扫到 0 首」时调用，区分「没权限」和「目录里真没歌」。
#[cfg(target_os = "android")]
#[tauri::command]
fn media_permission_granted() -> bool {
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;

    let ctx = ndk_context::android_context();
    if ctx.vm().is_null() || ctx.context().is_null() {
        return false;
    }
    let Ok(vm) = (unsafe { JavaVM::from_raw(ctx.vm().cast()) }) else {
        return false;
    };
    let Ok(mut env) = vm.attach_current_thread() else {
        return false;
    };
    let activity = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };
    // API 33+ 用 READ_MEDIA_AUDIO，≤32 用 READ_EXTERNAL_STORAGE；任一授予即可读媒体。
    for permission in [
        "android.permission.READ_MEDIA_AUDIO",
        "android.permission.READ_EXTERNAL_STORAGE",
    ] {
        let Ok(perm) = env.new_string(permission) else {
            continue;
        };
        let Ok(result) = env.call_method(
            &activity,
            "checkSelfPermission",
            "(Ljava/lang/String;)I",
            &[JValue::Object(&perm)],
        ) else {
            // checkSelfPermission 是 API 23+ 才有的方法；更老的系统权限安装时已授予，
            // 查不了就当作已授予，避免误报。
            return true;
        };
        if result
            .i()
            .map(|code| code == 0 /* PERMISSION_GRANTED */)
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,kdj=debug".into()))
        .init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init());
    // Android：出声已切共享 coordinator（CPAL/AAudio）；native-audio 插件仍入包，
    // 负责前台保活、歌词 overlay、相册等。iOS 仍由插件内 AVPlayer 出声。
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
        app.manage(virtual_disk::VirtualDiskManager::default());
        #[cfg(desktop)]
        app.manage(midi::MidiHub::spawn(app.handle().clone()));
        #[cfg(any(desktop, target_os = "android"))]
        app.manage(
            desktop_player::DesktopPlayerHandle::spawn(app.handle().clone())
                .map_err(anyhow::Error::msg)?,
        );
        let (bridge, theme) = start_server(app.handle())?;
        tracing::info!("KDJ 后端就绪：{}", bridge.base_url);
        app.manage(bridge);
        #[cfg(desktop)]
        virtual_disk::sync_existing(app.handle());
        // 服务起好再显示窗口。窗口在配置里是 visible:false，这里补一次 show()——
        // Electron 版靠 `ready-to-show` 做同样的事，为的是不让用户看见
        // 「空窗口 → 内容」的跳变。start_server 失败时直接返回 Err，
        // 窗口不会露面，也就不会出现一个连不上后端的空壳。
        //
        // show 之前必须先按 settings 垫好原生底色：WebView 首帧前用户看到的是
        // 原生背景；若仍是配置默认色，浅色主题会先闪一块深色大面板。
        if let Some(window) = app.get_webview_window("main") {
            #[cfg(desktop)]
            {
                let resolved = resolve_startup_theme(theme, &window);
                if let Err(err) = apply_main_window_background(&window, resolved) {
                    tracing::warn!("启动时设置窗口底色失败：{err}");
                }
                // Mac 用 Overlay + 红绿灯即可；Windows / Linux 的 Overlay/hiddenTitle
                // 无效，系统标题栏会画出图标和「KDJ」。关掉 decorations，由前端自绘三键。
                #[cfg(not(target_os = "macos"))]
                if let Err(err) = window.set_decorations(false) {
                    tracing::warn!("关闭系统标题栏失败：{err}");
                }
            }
            #[cfg(not(desktop))]
            let _ = theme;
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
        open_soundcloud_oauth_window,
        check_desktop_update,
        get_update_progress,
        apply_update,
        pick_folder,
        pick_folders,
        window_control,
        set_window_background,
        set_desktop_lyrics,
        virtual_disk::virtual_disk_status,
        virtual_disk::virtual_disk_mount,
        virtual_disk::virtual_disk_ensure_capacity,
        virtual_disk::virtual_disk_grow,
        virtual_disk::virtual_disk_eject,
        virtual_disk::virtual_disk_delete,
        desktop_player::playback_initialize,
        desktop_player::playback_command,
        desktop_player::playback_control,
        desktop_player::playback_state,
        midi::midi_devices,
        midi::midi_send
    ]);
    #[cfg(all(mobile, target_os = "android"))]
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
        set_window_background,
        set_desktop_lyrics,
        desktop_player::playback_initialize,
        desktop_player::playback_command,
        desktop_player::playback_control,
        desktop_player::playback_state,
        media_permission_granted
    ]);
    #[cfg(all(mobile, target_os = "ios"))]
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
        set_window_background,
        set_desktop_lyrics
    ]);

    // macOS：点红灯只藏主窗，别拆 WebView——否则桌面播放/歌词还在跑、进程却半死不活。
    #[cfg(all(desktop, target_os = "macos"))]
    let builder = builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if window.label() == "main" {
                let _ = window.hide();
                api.prevent_close();
            }
        }
    });

    #[cfg(desktop)]
    {
        let app = builder
            .build(tauri::generate_context!())
            .expect("KDJ 启动失败");
        app.run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = &event {
                virtual_disk::eject_on_exit(app_handle);
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                // 程序坞图标再点一下：唤回被红灯藏起的主窗。
                // 桌面歌词可能仍可见，所以不能只看 has_visible_windows。
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            let _ = (app_handle, event);
        });
        return;
    }

    #[cfg(not(desktop))]
    builder
        .run(tauri::generate_context!())
        .expect("KDJ 启动失败");
}
