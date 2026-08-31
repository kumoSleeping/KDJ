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
mod bilibili_embed;
#[cfg(desktop)]
pub mod cli;
#[cfg(desktop)]
mod data_recovery;
#[cfg(desktop)]
mod desktop_media;
/// 桌面 + Android 共用 playback_* 命令；iOS 仍走 native-audio 插件。
#[cfg(any(desktop, target_os = "android"))]
mod desktop_player;
#[cfg(desktop)]
mod midi;
#[cfg(desktop)]
mod share_clipboard;
#[cfg(desktop)]
mod youtube_embed;
#[cfg(desktop)]
mod youtube_proof;
#[cfg(desktop)]
#[cfg(desktop)]
pub use cli::Launch;

#[cfg(desktop)]
static NO_GUI: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(desktop)]
static EXIT_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(desktop)]
pub fn set_no_gui(value: bool) {
    NO_GUI.store(value, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(desktop)]
struct RuntimeDir(PathBuf);

#[cfg(desktop)]
struct ServerTask(Mutex<Option<tokio::task::JoinHandle<()>>>);

#[cfg(desktop)]
impl ServerTask {
    fn shutdown(&self) {
        if let Some(task) = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            task.abort();
        }
    }
}

#[cfg(desktop)]
const MAIN_WINDOW_STATE_FILE: &str = "main-window-state.json";
#[cfg(desktop)]
const MAIN_WINDOW_STATE_VERSION: u8 = 1;

#[cfg(desktop)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MainWindowState {
    version: u8,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

#[cfg(desktop)]
struct MainWindowStateCache {
    data_dir: PathBuf,
    state: Mutex<Option<MainWindowState>>,
}

use std::collections::HashSet;
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
    auth_token: String,
    media_token: String,
    config: Arc<AppConfig>,
    activity_log: kdj_server::activity_log::ActivityLog,
    picker_grants: Mutex<HashSet<PathBuf>>,
}

impl Bridge {
    fn grant_picked_path(&self, path: &Path) {
        if let Ok(canonical) = path.canonicalize() {
            if let Ok(mut grants) = self.picker_grants.lock() {
                grants.insert(canonical);
            }
        }
    }

    fn authorize_existing_path(&self, raw: &str, auxiliary_roots: bool) -> Result<PathBuf, String> {
        let requested = PathBuf::from(raw.trim());
        if !requested.is_absolute() {
            return Err("路径必须是绝对路径".into());
        }
        let canonical = requested
            .canonicalize()
            .map_err(|err| format!("无法解析路径 {}：{err}", requested.display()))?;

        let settings = self.config.to_settings();
        let mut roots = vec![self.config.download_dir()];
        roots.extend(
            settings
                .library_dirs
                .iter()
                .map(|path| kdj_core::config::expand_user(path)),
        );
        if auxiliary_roots {
            roots.extend([
                self.config.data_dir.clone(),
                kdj_core::config::system_download_dir(),
            ]);
            if let Ok(grants) = self.picker_grants.lock() {
                roots.extend(grants.iter().cloned());
            }
        }

        let allowed = roots
            .into_iter()
            .filter_map(|root| root.canonicalize().ok())
            .any(|root| canonical == root || canonical.starts_with(&root));
        if !allowed {
            return Err("路径不在 KDJ 管理范围或本次原生选择范围内".into());
        }
        Ok(canonical)
    }
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

fn no_desktop_update(current: String) -> DesktopUpdateInfo {
    DesktopUpdateInfo {
        latest: current.clone(),
        current,
        newer: false,
        url: RELEASE_PAGE.into(),
        name: "KDJ".into(),
        published_at: String::new(),
        notes: String::new(),
    }
}

/// 字段名对齐 `src/types.ts::KdjBridge`，所以要 camelCase。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub base_url: String,
    pub auth_token: String,
    pub media_token: String,
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
        auth_token: bridge.auth_token.clone(),
        media_token: bridge.media_token.clone(),
        platform: node_platform().to_string(),
    }
}

#[cfg(desktop)]
#[tauri::command]
fn cli_install_status() -> Result<cli::install::CliInstallStatus, String> {
    cli::install::status().map_err(|error| format!("{error:#}"))
}

#[cfg(desktop)]
#[tauri::command]
fn install_cli(bridge: tauri::State<'_, Bridge>) -> Result<cli::install::CliInstallStatus, String> {
    let result = cli::install::install().map_err(|error| format!("{error:#}"));
    match &result {
        Ok(_) => bridge.activity_log.record_level(
            kdj_server::activity_log::ActivityCategory::User,
            kdj_server::activity_log::ActivityLevel::Info,
            "安装命令行工具",
            "",
        ),
        Err(error) => bridge.activity_log.record_level(
            kdj_server::activity_log::ActivityCategory::User,
            kdj_server::activity_log::ActivityLevel::Error,
            "安装命令行工具失败",
            error,
        ),
    }
    result
}

/// 对应 `shell.openPath`：用系统默认程序打开（曲库里是「打开所在文件夹」）。
#[tauri::command]
fn open_path(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Bridge>,
    path: String,
) -> Result<(), String> {
    let path = bridge.authorize_existing_path(&path, true)?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|err| err.to_string())
}

/// 对应 `shell.showItemInFolder`：在文件管理器里选中这个文件本身。
#[tauri::command]
fn reveal_path(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Bridge>,
    path: String,
) -> Result<(), String> {
    let path = bridge.authorize_existing_path(&path, true)?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|err| err.to_string())
}

/// 把已有本地文件作为真正的系统拖放载荷交给 Finder / Explorer。
///
/// 只声明 Copy：外部播放器仍会直接打开原文件，文件管理器则复制它；绝不能让一次
/// “拖出去试听”把曲库源文件搬走，导致数据库里的路径立刻失效。
#[cfg(desktop)]
#[tauri::command]
async fn start_native_file_drag(
    app: tauri::AppHandle,
    window: tauri::Window,
    bridge: tauri::State<'_, Bridge>,
    paths: Vec<String>,
    drag_image: Option<String>,
) -> Result<(), String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        if paths.is_empty() {
            return Err("没有可拖动的文件".into());
        }
        if paths.len() > 2_000 {
            return Err("一次最多拖动 2000 个文件".into());
        }

        let mut files = Vec::with_capacity(paths.len());
        for raw in paths {
            // 拖出文件是数据离开应用的边界：只允许曲库根/下载根，不接受 app data、
            // skill preset 或仅由 picker 临时授权的辅助路径。
            let path = bridge.authorize_existing_path(&raw, false)?;
            let metadata = std::fs::metadata(&path)
                .map_err(|err| format!("无法读取拖动文件 {}：{err}", path.display()))?;
            if !metadata.is_file() {
                return Err(format!("拖动目标不是文件：{}", path.display()));
            }
            if !files.contains(&path) {
                files.push(path);
            }
        }
        if files.is_empty() {
            return Err("没有可拖动的文件".into());
        }

        // 前端已把首首曲目的封面裁成 128×128 PNG。只接受小体积 PNG/JPEG，
        // 避免损坏或伪造的数据让原生图片解码器崩掉；旧前端未传时才退回应用图标。
        let preview = drag_image
            .filter(|encoded| encoded.len() <= 4 * 1024 * 1024)
            .and_then(|encoded| {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .ok()
            })
            .filter(|bytes| {
                bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(&[0xff, 0xd8, 0xff])
            })
            .unwrap_or_else(|| include_bytes!("../icons/128x128.png").to_vec());

        // 命令要等到用户真正松手（成功放下或取消）才结束。前端会在这段时间冻结
        // 曲库滚动；如果这里只回报“已启动”，指针停在窗口边缘时 WebView 仍会
        // 在系统拖动期间不断自动滚动源列表。
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let pending = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let main_thread_pending = std::sync::Arc::clone(&pending);
        app.run_on_main_thread(move || {
            let drop_pending = std::sync::Arc::clone(&main_thread_pending);
            let started = drag::start_drag(
                &window,
                drag::DragItem::Files(files),
                drag::Image::Raw(preview),
                move |result, cursor| {
                    tracing::debug!(?result, x = cursor.x, y = cursor.y, "系统文件拖动结束");
                    if let Ok(mut sender) = drop_pending.lock() {
                        if let Some(sender) = sender.take() {
                            let _ = sender.send(Ok(()));
                        }
                    }
                },
                drag::Options {
                    mode: drag::DragMode::Copy,
                    ..Default::default()
                },
            )
            .map_err(|err| format!("无法启动系统文件拖动：{err}"));
            if let Err(error) = started {
                if let Ok(mut sender) = main_thread_pending.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(Err(error));
                    }
                }
            }
        })
        .map_err(|err| format!("无法进入窗口线程：{err}"))?;

        return rx
            .await
            .map_err(|_| "系统文件拖动结束状态丢失".to_string())?;
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, window, bridge, paths, drag_image);
        Err("当前桌面系统尚不支持把文件拖出 KDJ".into())
    }
}

/// 把公开歌曲链接作为系统 URL 拖放载荷交给浏览器、聊天或笔记应用。
///
/// drag 2.1 的数据载荷目前只在 macOS 原生实现；Windows 由 WebView2 的
/// text/uri-list HTML5 拖放接管，避免伪装成一个 `.url` 文件改变用户拿到的内容。
#[cfg(desktop)]
#[tauri::command]
async fn start_native_link_drag(
    app: tauri::AppHandle,
    window: tauri::Window,
    url: String,
    text: Option<String>,
    drag_image: Option<String>,
    include_artwork: Option<bool>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = url.trim().to_string();
        if url.len() > 4_096 || !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("分享链接无效".into());
        }
        let share_text = text
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && value.len() <= 16 * 1024)
            .unwrap_or_else(|| url.clone());
        let preview = drag_image
            .filter(|encoded| encoded.len() <= 4 * 1024 * 1024)
            .and_then(|encoded| {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .ok()
            })
            .filter(|bytes| {
                bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(&[0xff, 0xd8, 0xff])
            })
            .unwrap_or_else(|| include_bytes!("../icons/128x128.png").to_vec());
        let include_artwork = include_artwork.unwrap_or(false);

        let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let pending = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let main_thread_pending = std::sync::Arc::clone(&pending);
        app.run_on_main_thread(move || {
            let rtfd = if include_artwork {
                match share_clipboard::build_share_rtfd(&share_text, &preview) {
                    Ok(rich) => Some(rich),
                    Err(error) => {
                        tracing::warn!(%error, "无法为系统链接拖动准备图文载荷，退回 URL/纯文本");
                        None
                    }
                }
            } else {
                None
            };
            let url_bytes = url.into_bytes();
            let text_bytes = share_text.into_bytes();
            let mut data_types = vec!["public.url".into(), "public.utf8-plain-text".into()];
            if rtfd.is_some() {
                data_types.insert(0, share_clipboard::SHARE_RTFD_DRAG_TYPE.into());
            }
            let drop_pending = std::sync::Arc::clone(&main_thread_pending);
            let started = drag::start_drag(
                &window,
                drag::DragItem::Data {
                    provider: Box::new(move |data_type| match data_type {
                        share_clipboard::SHARE_RTFD_DRAG_TYPE => rtfd.as_ref().cloned(),
                        "public.url" => Some(url_bytes.clone()),
                        "public.utf8-plain-text" => Some(text_bytes.clone()),
                        _ => None,
                    }),
                    types: data_types,
                },
                drag::Image::Raw(preview),
                move |result, cursor| {
                    tracing::debug!(?result, x = cursor.x, y = cursor.y, "系统链接拖动结束");
                    if let Ok(mut sender) = drop_pending.lock() {
                        if let Some(sender) = sender.take() {
                            let _ = sender.send(Ok(()));
                        }
                    }
                },
                drag::Options {
                    mode: drag::DragMode::Copy,
                    ..Default::default()
                },
            )
            .map_err(|err| format!("无法启动系统链接拖动：{err}"));
            if let Err(error) = started {
                if let Ok(mut sender) = main_thread_pending.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(Err(error));
                    }
                }
            }
        })
        .map_err(|err| format!("无法进入窗口线程：{err}"))?;

        return rx
            .await
            .map_err(|_| "系统链接拖动结束状态丢失".to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, url, text, drag_image, include_artwork);
        Err("当前桌面系统由浏览器原生链接拖动接管".into())
    }
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
    const MAX_QR_PNG_BYTES: usize = 2 * 1024 * 1024;
    const MAX_QR_BASE64_BYTES: usize = MAX_QR_PNG_BYTES.div_ceil(3) * 4;

    let payload = image
        .strip_prefix("data:image/png;base64,")
        .or_else(|| image.strip_prefix("data:image/PNG;base64,"))
        .ok_or_else(|| "二维码不是 PNG 图片".to_string())?;
    if payload.len() > MAX_QR_BASE64_BYTES {
        return Err("二维码图片超过 2 MiB 限制".into());
    }
    let png = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|err| format!("解码二维码失败：{err}"))?;
    if png.len() > MAX_QR_PNG_BYTES {
        return Err("二维码图片超过 2 MiB 限制".into());
    }
    validate_png(&png)?;
    Ok(png)
}

#[cfg(not(target_os = "android"))]
fn validate_png(png: &[u8]) -> Result<(), String> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    const MAX_SIDE: u32 = 4_096;
    const MAX_PIXELS: u64 = 16_777_216;

    if !png.starts_with(SIGNATURE) {
        return Err("二维码内容不是 PNG".into());
    }
    let mut offset = SIGNATURE.len();
    let mut saw_ihdr = false;
    let mut saw_idat = false;
    let mut saw_iend = false;
    while offset < png.len() {
        let header_end = offset
            .checked_add(8)
            .filter(|end| *end <= png.len())
            .ok_or_else(|| "PNG chunk 头不完整".to_string())?;
        let length = u32::from_be_bytes(png[offset..offset + 4].try_into().unwrap()) as usize;
        let kind = &png[offset + 4..header_end];
        if !kind.iter().all(u8::is_ascii_alphabetic) {
            return Err("PNG chunk 类型无效".into());
        }
        let data_end = header_end
            .checked_add(length)
            .ok_or_else(|| "PNG chunk 长度溢出".to_string())?;
        let chunk_end = data_end
            .checked_add(4)
            .filter(|end| *end <= png.len())
            .ok_or_else(|| "PNG chunk 数据不完整".to_string())?;
        let expected_crc = u32::from_be_bytes(png[data_end..chunk_end].try_into().unwrap());
        if png_crc32(&png[offset + 4..data_end]) != expected_crc {
            return Err("PNG chunk 校验失败".into());
        }

        match kind {
            b"IHDR" => {
                if saw_ihdr || offset != SIGNATURE.len() || length != 13 {
                    return Err("PNG IHDR 无效".into());
                }
                let data = &png[header_end..data_end];
                let width = u32::from_be_bytes(data[0..4].try_into().unwrap());
                let height = u32::from_be_bytes(data[4..8].try_into().unwrap());
                let valid_depth = matches!(
                    (data[9], data[8]),
                    (0, 1 | 2 | 4 | 8 | 16)
                        | (2, 8 | 16)
                        | (3, 1 | 2 | 4 | 8)
                        | (4, 8 | 16)
                        | (6, 8 | 16)
                );
                if width == 0
                    || height == 0
                    || width > MAX_SIDE
                    || height > MAX_SIDE
                    || u64::from(width) * u64::from(height) > MAX_PIXELS
                    || !valid_depth
                    || data[10] != 0
                    || data[11] != 0
                    || data[12] > 1
                {
                    return Err("PNG 尺寸或编码参数无效".into());
                }
                saw_ihdr = true;
            }
            b"IDAT" => {
                if !saw_ihdr || length == 0 || saw_iend {
                    return Err("PNG IDAT 无效".into());
                }
                saw_idat = true;
            }
            b"IEND" => {
                if !saw_ihdr || !saw_idat || saw_iend || length != 0 || chunk_end != png.len() {
                    return Err("PNG IEND 无效".into());
                }
                saw_iend = true;
            }
            _ if !saw_ihdr || saw_iend => return Err("PNG chunk 顺序无效".into()),
            _ => {}
        }
        offset = chunk_end;
    }
    if !saw_iend {
        return Err("PNG 缺少结束标记".into());
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn png_crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
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

#[cfg(desktop)]
fn soundcloud_oauth_callback_request(
    client: &reqwest::Client,
    endpoint: &str,
    auth_token: &str,
    state: &str,
    code: &str,
) -> reqwest::RequestBuilder {
    client
        .post(endpoint)
        .bearer_auth(auth_token)
        .json(&serde_json::json!({ "state": state, "code": code }))
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

    let (base_url, auth_token) = {
        let bridge = app.state::<Bridge>();
        (bridge.base_url.clone(), bridge.auth_token.clone())
    };
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
        let auth_token = auth_token.clone();

        tauri::async_runtime::spawn(async move {
            let result = if !oauth_error.is_empty() {
                Err(oauth_error)
            } else if state.is_empty() || code.is_empty() {
                Err("SoundCloud 授权回调不完整".into())
            } else {
                let client = reqwest::Client::new();
                match soundcloud_oauth_callback_request(
                    &client,
                    &endpoint,
                    &auth_token,
                    &state,
                    &code,
                )
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

#[cfg(desktop)]
const SOUNDCLOUD_WEB_LOGIN_WINDOW: &str = "soundcloud-web-login";
#[cfg(desktop)]
const SOUNDCLOUD_WEB_LOGIN_EVENT: &str = "soundcloud-web-login://result";

#[cfg(desktop)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct SoundCloudWebSession {
    access_token: String,
    expires_at: i64,
}

#[cfg(desktop)]
fn domain_matches(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// 登录窗口没有地址栏，因此顶层导航只允许 SoundCloud 与它明确支持的身份提供商。
/// 远端窗口不匹配任何 Tauri capability，即使页面被攻破也不能调用 KDJ IPC。
#[cfg(desktop)]
fn soundcloud_web_login_navigation_allowed(url: &tauri::Url) -> bool {
    if url.scheme() == "about" && url.path() == "blank" {
        return true;
    }
    if url.scheme() != "https" {
        return false;
    }
    url.host_str().is_some_and(|host| {
        ["soundcloud.com", "google.com", "facebook.com", "apple.com"]
            .iter()
            .any(|domain| domain_matches(host, domain))
    })
}

#[cfg(desktop)]
fn soundcloud_web_session(
    cookies: &[tauri::webview::Cookie<'static>],
) -> Option<SoundCloudWebSession> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64;
    cookies
        .iter()
        .filter(|cookie| cookie.name() == "oauth_token" && !cookie.value().trim().is_empty())
        .filter(|cookie| {
            cookie
                .domain()
                .map(|domain| domain_matches(domain.trim_start_matches('.'), "soundcloud.com"))
                .unwrap_or(false)
        })
        .filter_map(|cookie| {
            let expires_at = match cookie.expires_datetime() {
                Some(expires) => {
                    let expires_at = expires.unix_timestamp();
                    if expires_at <= now {
                        return None;
                    }
                    expires_at
                }
                None => 0,
            };
            Some(SoundCloudWebSession {
                access_token: cookie.value().trim().to_string(),
                expires_at,
            })
        })
        .max_by_key(|session| {
            if session.expires_at <= 0 {
                i64::MAX
            } else {
                session.expires_at
            }
        })
}

#[cfg(desktop)]
fn soundcloud_web_login_request(
    client: &reqwest::Client,
    endpoint: &str,
    auth_token: &str,
    session: &SoundCloudWebSession,
) -> reqwest::RequestBuilder {
    client
        .post(endpoint)
        .bearer_auth(auth_token)
        .json(&serde_json::json!({
            "access_token": session.access_token,
            "expires_at": session.expires_at,
        }))
}

#[cfg(desktop)]
async fn soundcloud_web_login_response(response: reqwest::Response) -> Result<(), String> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let text = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| {
            value
                .get("detail")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
    Err(format!(
        "SoundCloud 登录失败：{}",
        detail.chars().take(320).collect::<String>()
    ))
}

#[cfg(desktop)]
fn finish_soundcloud_web_login(
    app: &tauri::AppHandle,
    completed: &std::sync::atomic::AtomicBool,
    status: &'static str,
    message: String,
) {
    use std::sync::atomic::Ordering;

    if completed.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit(
        SOUNDCLOUD_WEB_LOGIN_EVENT,
        SoundCloudOAuthWindowResult { status, message },
    );
    if let Some(window) = app.get_webview_window(SOUNDCLOUD_WEB_LOGIN_WINDOW) {
        let _ = window.close();
    }
}

/// Windows Chromium 130+ 会用 App-Bound Encryption 保护 Cookie。KDJ 不再要求
/// 整个播放器提权去绕过它，而是在一次性 WebView 中打开真正的 soundcloud.com；
/// 登录产生的 `oauth_token` 由原生 cookie manager 读取并直接交给本机后端验证。
#[cfg(desktop)]
#[tauri::command]
fn open_soundcloud_web_login_window(app: tauri::AppHandle) -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    if let Some(existing) = app.get_webview_window(SOUNDCLOUD_WEB_LOGIN_WINDOW) {
        let _ = existing.show();
        existing
            .set_focus()
            .map_err(|error| format!("聚焦 SoundCloud 登录窗口失败：{error}"))?;
        return Ok(());
    }

    let login_url =
        tauri::Url::parse("https://soundcloud.com/signin?redirect_url=%2Fyou%2Flibrary")
            .map_err(|error| format!("构建 SoundCloud 登录地址失败：{error}"))?;
    let cookie_url = tauri::Url::parse("https://soundcloud.com/")
        .map_err(|error| format!("构建 SoundCloud 会话地址失败：{error}"))?;
    let (base_url, auth_token) = {
        let bridge = app.state::<Bridge>();
        (bridge.base_url.clone(), bridge.auth_token.clone())
    };
    let completed = Arc::new(AtomicBool::new(false));
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        SOUNDCLOUD_WEB_LOGIN_WINDOW,
        tauri::WebviewUrl::External(login_url),
    )
    .title("SoundCloud 登录 · soundcloud.com")
    .inner_size(520.0, 720.0)
    .min_inner_size(360.0, 520.0)
    .center()
    .resizable(true)
    // 登录凭证只在这个窗口的生命周期内存在；验证后的最小会话由 provider 单独保存。
    .incognito(true)
    .on_navigation(soundcloud_web_login_navigation_allowed)
    .build()
    .map_err(|error| format!("打开 SoundCloud 登录窗口失败：{error}"))?;

    let app_on_close = app.clone();
    let completed_on_close = Arc::clone(&completed);
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. })
            && !completed_on_close.swap(true, Ordering::SeqCst)
        {
            let _ = app_on_close.emit(
                SOUNDCLOUD_WEB_LOGIN_EVENT,
                SoundCloudOAuthWindowResult {
                    status: "cancelled",
                    message: "已取消 SoundCloud 登录".into(),
                },
            );
        }
    });

    let app_on_poll = app.clone();
    let completed_on_poll = Arc::clone(&completed);
    tauri::async_runtime::spawn(async move {
        let endpoint = format!("{base_url}/api/accounts/soundcloud/login/webview");
        let client = reqwest::Client::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10 * 60);
        loop {
            tokio::time::sleep(Duration::from_millis(600)).await;
            if completed_on_poll.load(Ordering::SeqCst) {
                return;
            }
            if tokio::time::Instant::now() >= deadline {
                finish_soundcloud_web_login(
                    &app_on_poll,
                    &completed_on_poll,
                    "error",
                    "SoundCloud 登录已超时，请重试".into(),
                );
                return;
            }
            let Some(window) = app_on_poll.get_webview_window(SOUNDCLOUD_WEB_LOGIN_WINDOW) else {
                return;
            };
            // Windows WebView2 的 cookie API 不能从同步 command/event handler 调用；
            // 此轮询运行在 Tauri 异步线程上，再由 dispatcher 安全切回 UI 线程。
            let Ok(cookies) = window.cookies_for_url(cookie_url.clone()) else {
                continue;
            };
            let Some(session) = soundcloud_web_session(&cookies) else {
                continue;
            };
            let result =
                match soundcloud_web_login_request(&client, &endpoint, &auth_token, &session)
                    .send()
                    .await
                {
                    Ok(response) => soundcloud_web_login_response(response).await,
                    Err(error) => Err(format!("处理 SoundCloud 登录失败：{error}")),
                };
            match result {
                Ok(()) => finish_soundcloud_web_login(
                    &app_on_poll,
                    &completed_on_poll,
                    "done",
                    String::new(),
                ),
                Err(message) => {
                    finish_soundcloud_web_login(&app_on_poll, &completed_on_poll, "error", message)
                }
            }
            return;
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
    let current = app.package_info().version.to_string();

    // `npm run tauri:dev` 通过 `/tmp/KDJ Dev.app` 中的符号链接启动当前二进制。
    // Tauri updater 会在访问更新清单前主动拒绝这种路径；开发态本来也不能原地
    // 覆盖安装，因此直接返回正常的“无可安装更新”，避免后台轮询持续制造假错误。
    if cfg!(debug_assertions) {
        return Ok(no_desktop_update(current));
    }

    use tauri_plugin_updater::UpdaterExt;

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
        None => no_desktop_update(current),
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
    let started = std::time::Instant::now();
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
    let activity_log = app.state::<Bridge>().activity_log.clone();
    activity_log.record(kdj_server::activity_log::ActivityLogDraft {
        category: kdj_server::activity_log::ActivityCategory::Network,
        level: kdj_server::activity_log::ActivityLevel::Info,
        action: "软件更新下载".into(),
        detail: String::new(),
        target: "GitHub · github.com".into(),
        status: Some(200),
        duration_ms: Some(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)),
        count: 1,
    });
    // restart 会立即终止进程；这一个边界必须等此前的非阻塞记录真正落盘。
    let _ = activity_log.flush();
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
        let selected = rx
            .await
            .ok()
            .flatten()
            .and_then(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned());
        if let Some(path) = selected.as_deref() {
            app.state::<Bridge>().grant_picked_path(Path::new(path));
        }
        return selected;
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
        let selected: Vec<String> = rx
            .await
            .ok()
            .flatten()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        for path in &selected {
            app.state::<Bridge>().grant_picked_path(Path::new(path));
        }
        return selected;
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
#[cfg(desktop)]
fn shutdown_desktop_runtime(app: &tauri::AppHandle) {
    if let Some(player) = app.try_state::<desktop_player::DesktopPlayerHandle>() {
        player.shutdown();
    }
    if let Some(server) = app.try_state::<ServerTask>() {
        server.shutdown();
    }
    if let Some(dir) = app.try_state::<RuntimeDir>() {
        cli::remove_runtime(&dir.0);
    }
}

/// 用户已经明确要求退出后，先同步保存状态并释放媒体/HTTP 资源。Windows 的
/// WebView2 偶尔会在媒体管线异常后拖住正常析构；原生看门狗保证这次退出不会再次
/// 变成“窗口点不掉”。正常退出会在看门狗触发前结束进程。
#[cfg(desktop)]
pub(crate) fn request_desktop_exit(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;

    if EXIT_STARTED.swap(true, Ordering::SeqCst) {
        app.exit(0);
        return;
    }
    capture_main_window_state(app);
    persist_main_window_state(app);
    shutdown_desktop_runtime(app);
    let _ = std::thread::Builder::new()
        .name("kdj-exit-watchdog".into())
        .spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(5));
            std::process::exit(0);
        });
    app.exit(0);
}

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
                if _window.label() == "main" {
                    // 主窗口就是当前桌面应用的生命周期：关闭时连同播放、分析和
                    // 其他辅助窗口一起直接结束，不再无状态栏地驻留后台。
                    request_desktop_exit(&_app);
                    return Ok(());
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DesktopMonitorBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn clamp_desktop_lyrics_coordinates(
    monitors: &[DesktopMonitorBounds],
    window_width: u32,
    window_height: u32,
    x: i32,
    y: i32,
) -> (i32, i32) {
    let Some(target) = monitors.iter().max_by_key(|monitor| {
        let left = i64::from(x).max(i64::from(monitor.x));
        let top = i64::from(y).max(i64::from(monitor.y));
        let right = (i64::from(x) + i64::from(window_width))
            .min(i64::from(monitor.x) + i64::from(monitor.width));
        let bottom = (i64::from(y) + i64::from(window_height))
            .min(i64::from(monitor.y) + i64::from(monitor.height));
        (right - left).max(0) * (bottom - top).max(0)
    }) else {
        return (x, y);
    };
    let min_x = i64::from(target.x);
    let min_y = i64::from(target.y);
    let max_x = (min_x + i64::from(target.width) - i64::from(window_width)).max(min_x);
    let max_y = (min_y + i64::from(target.height) - i64::from(window_height)).max(min_y);
    (
        i64::from(x).clamp(min_x, max_x) as i32,
        i64::from(y).clamp(min_y, max_y) as i32,
    )
}

#[cfg(desktop)]
const MAIN_WINDOW_MIN_WIDTH: u32 = 360;
#[cfg(desktop)]
const MAIN_WINDOW_MIN_HEIGHT: u32 = 480;
#[cfg(desktop)]
const MAIN_WINDOW_MAX_DIMENSION: u32 = 32_768;
#[cfg(desktop)]
const MAIN_WINDOW_STATE_MAX_BYTES: u64 = 64 * 1024;

#[cfg(desktop)]
fn valid_main_window_state(state: MainWindowState) -> bool {
    state.version == MAIN_WINDOW_STATE_VERSION
        && (MAIN_WINDOW_MIN_WIDTH..=MAIN_WINDOW_MAX_DIMENSION).contains(&state.width)
        && (MAIN_WINDOW_MIN_HEIGHT..=MAIN_WINDOW_MAX_DIMENSION).contains(&state.height)
}

#[cfg(desktop)]
fn main_window_overlap_area(state: MainWindowState, monitor: &DesktopMonitorBounds) -> i64 {
    let left = i64::from(state.x).max(i64::from(monitor.x));
    let top = i64::from(state.y).max(i64::from(monitor.y));
    let right = (i64::from(state.x) + i64::from(state.width))
        .min(i64::from(monitor.x) + i64::from(monitor.width));
    let bottom = (i64::from(state.y) + i64::from(state.height))
        .min(i64::from(monitor.y) + i64::from(monitor.height));
    (right - left).max(0) * (bottom - top).max(0)
}

#[cfg(desktop)]
fn main_window_center_distance(state: MainWindowState, monitor: &DesktopMonitorBounds) -> i128 {
    // 全程使用两倍坐标，避免多屏缩放下的浮点取整使“最近显示器”来回跳。
    let window_x2 = i128::from(state.x) * 2 + i128::from(state.width);
    let window_y2 = i128::from(state.y) * 2 + i128::from(state.height);
    let monitor_x2 = i128::from(monitor.x) * 2 + i128::from(monitor.width);
    let monitor_y2 = i128::from(monitor.y) * 2 + i128::from(monitor.height);
    let dx = window_x2 - monitor_x2;
    let dy = window_y2 - monitor_y2;
    dx * dx + dy * dy
}

/// 屏幕拔掉、分辨率变化或缩放变化后，旧坐标仍需完整落在最相近的可用屏幕中。
#[cfg(desktop)]
fn clamp_main_window_state(
    state: MainWindowState,
    monitors: &[DesktopMonitorBounds],
) -> MainWindowState {
    let Some(target) = monitors
        .iter()
        .filter(|monitor| monitor.width > 0 && monitor.height > 0)
        .max_by_key(|monitor| {
            (
                main_window_overlap_area(state, monitor),
                std::cmp::Reverse(main_window_center_distance(state, monitor)),
            )
        })
    else {
        return state;
    };

    let min_width = MAIN_WINDOW_MIN_WIDTH.min(target.width);
    let min_height = MAIN_WINDOW_MIN_HEIGHT.min(target.height);
    let width = state.width.clamp(min_width, target.width);
    let height = state.height.clamp(min_height, target.height);
    let (x, y) = clamp_desktop_lyrics_coordinates(
        std::slice::from_ref(target),
        width,
        height,
        state.x,
        state.y,
    );
    MainWindowState {
        x,
        y,
        width,
        height,
        ..state
    }
}

#[cfg(desktop)]
fn quarantine_main_window_state(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    for _ in 0..16 {
        let target = parent.join(format!(
            "{MAIN_WINDOW_STATE_FILE}.corrupt-{:016x}",
            rand::random::<u64>()
        ));
        if target.exists() {
            continue;
        }
        if std::fs::rename(path, &target).is_ok() {
            return Some(target);
        }
    }
    None
}

#[cfg(desktop)]
fn load_main_window_state(data_dir: &Path) -> Option<MainWindowState> {
    let path = data_dir.join(MAIN_WINDOW_STATE_FILE);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!("读取主窗口状态失败：{error}");
            return None;
        }
    };
    let invalid_file = !metadata.file_type().is_file()
        || metadata.len() == 0
        || metadata.len() > MAIN_WINDOW_STATE_MAX_BYTES;
    let bytes = if invalid_file {
        None
    } else {
        match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) => {
                // 权限/瞬时 I/O 错误不等于内容损坏，不能擅自移动用户仍可修复的文件。
                tracing::warn!("读取主窗口状态失败：{error}");
                return None;
            }
        }
    };
    let parsed = bytes
        .as_deref()
        .and_then(|bytes| serde_json::from_slice::<MainWindowState>(bytes).ok())
        .filter(|state| valid_main_window_state(*state));
    if parsed.is_none() {
        match quarantine_main_window_state(&path) {
            Some(quarantine) => {
                tracing::warn!("主窗口状态已损坏，已隔离到 {}", quarantine.display())
            }
            None => tracing::warn!("主窗口状态已损坏，且无法隔离 {}", path.display()),
        }
    }
    parsed
}

#[cfg(desktop)]
fn write_main_window_state(data_dir: &Path, state: MainWindowState) -> std::io::Result<()> {
    use std::io::Write as _;

    if !valid_main_window_state(state) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid main window state",
        ));
    }
    std::fs::create_dir_all(data_dir)?;
    let bytes = serde_json::to_vec_pretty(&state)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let target = data_dir.join(MAIN_WINDOW_STATE_FILE);
    let mut temp = None;
    for _ in 0..32 {
        let path = data_dir.join(format!(
            ".{MAIN_WINDOW_STATE_FILE}.tmp-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => {
                temp = Some((path, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    let Some((temp_path, mut file)) = temp else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "cannot allocate main window state temp file",
        ));
    };
    let commit = (|| -> std::io::Result<()> {
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        commit_main_window_temp(&temp_path, &target, data_dir)?;
        #[cfg(unix)]
        if let Ok(directory) = std::fs::File::open(data_dir) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if commit.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    commit
}

#[cfg(all(desktop, not(windows)))]
fn commit_main_window_temp(tmp: &Path, target: &Path, _parent: &Path) -> std::io::Result<()> {
    std::fs::rename(tmp, target)
}

#[cfg(all(desktop, windows))]
fn commit_main_window_temp(tmp: &Path, target: &Path, parent: &Path) -> std::io::Result<()> {
    if !target.exists() {
        return std::fs::rename(tmp, target);
    }
    let backup = parent.join(format!(
        ".{MAIN_WINDOW_STATE_FILE}.backup-{}-{:016x}",
        std::process::id(),
        rand::random::<u64>()
    ));
    std::fs::rename(target, &backup)?;
    if let Err(commit_error) = std::fs::rename(tmp, target) {
        if let Err(restore_error) = std::fs::rename(&backup, target) {
            return Err(std::io::Error::other(format!(
                "commit failed: {commit_error}; restore failed: {restore_error}; backup: {}",
                backup.display()
            )));
        }
        return Err(commit_error);
    }
    if let Err(error) = std::fs::remove_file(&backup) {
        tracing::warn!("清理旧主窗口状态备份失败 {}：{error}", backup.display());
    }
    Ok(())
}

#[cfg(desktop)]
fn restore_main_window_state(window: &tauri::WebviewWindow, state: MainWindowState) {
    let monitors = window
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|monitor| DesktopMonitorBounds {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect::<Vec<_>>();
    let state = clamp_main_window_state(state, &monitors);
    if let Some(cache) = window.app_handle().try_state::<MainWindowStateCache>() {
        if let Ok(mut cached) = cache.state.lock() {
            *cached = Some(state);
        }
    }
    if let Err(error) = window.set_size(tauri::PhysicalSize::new(state.width, state.height)) {
        tracing::warn!("恢复主窗口大小失败：{error}");
    }
    if let Err(error) = window.set_position(tauri::PhysicalPosition::new(state.x, state.y)) {
        tracing::warn!("恢复主窗口位置失败：{error}");
    }
    if state.maximized {
        if let Err(error) = window.maximize() {
            tracing::warn!("恢复主窗口最大化状态失败：{error}");
        }
    }
}

#[cfg(desktop)]
fn capture_main_window_state(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(cache) = app.try_state::<MainWindowStateCache>() else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let Ok(mut cached) = cache.state.lock() else {
        return;
    };
    if maximized || minimized || fullscreen {
        // 最大化/最小化/全屏事件报告的是瞬时占屏尺寸，不能覆盖最后的普通窗口边界。
        if maximized {
            if let Some(state) = cached.as_mut() {
                state.maximized = true;
            }
        }
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let state = MainWindowState {
        version: MAIN_WINDOW_STATE_VERSION,
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: false,
    };
    if valid_main_window_state(state) {
        *cached = Some(state);
    }
}

#[cfg(desktop)]
fn persist_main_window_state(app: &tauri::AppHandle) {
    let Some(cache) = app.try_state::<MainWindowStateCache>() else {
        return;
    };
    let state = cache.state.lock().ok().and_then(|state| *state);
    if let Some(state) = state {
        if let Err(error) = write_main_window_state(&cache.data_dir, state) {
            tracing::warn!("保存主窗口状态失败：{error}");
        }
    }
}

#[cfg(desktop)]
fn restore_desktop_lyrics_position(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
) -> Result<(), String> {
    let monitors = window
        .available_monitors()
        .map_err(|err| err.to_string())?
        .into_iter()
        .map(|monitor| DesktopMonitorBounds {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect::<Vec<_>>();
    let size = window.outer_size().map_err(|err| err.to_string())?;
    let (x, y) = clamp_desktop_lyrics_coordinates(&monitors, size.width, size.height, x, y);
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|err| err.to_string())
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
                            "main",
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
                restore_desktop_lyrics_position(&window, x, y)?;
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

/// 历史 KDJ 数据目录不会因为迁移完成就自动消失。旧版曾以 0644 写入 QQ/网易云
/// 会话，因此启动时也要收紧这些遗留副本；只处理真实的 sessions 目录和其中的
/// 普通文件，不跟随符号链接，也不删除或改写凭证内容。
#[cfg(unix)]
fn harden_session_permissions(data_dir: &Path) {
    use std::os::unix::fs::PermissionsExt as _;

    let sessions = data_dir.join("sessions");
    let Ok(metadata) = std::fs::symlink_metadata(&sessions) else {
        return;
    };
    if !metadata.file_type().is_dir() {
        return;
    }
    let _ = std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o700));
    let Ok(entries) = std::fs::read_dir(&sessions) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_file()) {
            let _ = std::fs::set_permissions(entry.path(), std::fs::Permissions::from_mode(0o600));
        }
    }
}

#[cfg(not(unix))]
fn harden_session_permissions(_data_dir: &Path) {}

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

        // 历史版本同时出现过 Electron productName、Tauri identifier、正式版/Labs
        // 等目录名。恢复器按真实内容合并、按路径身份去重，不把 Labs 当成唯一解释。
        let legacy_candidates = [
            base.join("kumodeck").join("data"),
            base.join("KumoDeck").join("data"),
            base.join("kdj").join("data"),
            base.join("KDJ").join("data"),
            base.join("com.kumodeck.app").join("data"),
            base.join("com.kdj.app.labs").join("data"),
        ];
        for historical in &legacy_candidates {
            harden_session_permissions(historical);
        }
        let report = data_recovery::recover_desktop_data(&current, &legacy_candidates);
        if report.sources > 0 {
            eprintln!(
                "KDJ: 历史数据自愈完成：sources={} databases={} sessions={} settings={} files={}",
                report.sources, report.databases, report.sessions, report.settings, report.files
            );
        }
        for error in report.errors {
            eprintln!("KDJ: 历史数据自愈将在下次重试：{error}");
        }
        harden_session_permissions(&current);
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
    // 调试覆盖目录同样可能来自出过问题的版本，不能绕过凭证权限收紧或数据库别名修复。
    harden_session_permissions(&data_dir);
    reconcile_database_alias(&data_dir);
    let download_dir = resolve_download_dir(app, &data_dir);

    // 端口传 0 让内核挑：Electron 版是先 listen(0) 探一个再关掉再交给 Python，
    // 那中间有一段「探到的端口被别人抢走」的竞态窗口，这里直接没有。
    let config = Arc::new(AppConfig::create(data_dir, download_dir, 0));
    #[cfg(desktop)]
    match data_recovery::repair_library_roots(&config) {
        Ok(restored) if restored > 0 => {
            eprintln!("KDJ: 已从现有曲库记录补回 {restored} 个曲库文件夹");
        }
        Ok(_) => {}
        Err(error) => eprintln!("KDJ: 曲库文件夹自愈失败，将在下次启动重试：{error:#}"),
    }
    // show() 前要用这份主题垫原生底色，否则浅色用户会先看到配置默认底闪一下。
    let theme = config.to_settings().theme;
    let data_dir_for_runtime = config.data_dir.clone();
    let (port, auth_token, media_token, activity_log, serve_task, control_rx) =
        tauri::async_runtime::block_on(kdj_server::serve(config.clone()))?;
    #[cfg(desktop)]
    data_recovery::finalize_recovery_cleanup(&data_dir_for_runtime);
    let base_url = format!("http://127.0.0.1:{port}");
    let auth_token = auth_token.expose().to_string();
    let media_token = media_token.expose().to_string();

    #[cfg(desktop)]
    {
        let gui = !NO_GUI.load(std::sync::atomic::Ordering::SeqCst);
        if let Err(err) = cli::write_runtime(&data_dir_for_runtime, &base_url, &auth_token, gui) {
            tracing::warn!("写 runtime.json 失败：{err:#}");
        }
        app.manage(RuntimeDir(data_dir_for_runtime.clone()));
        app.manage(ServerTask(Mutex::new(Some(serve_task))));
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut rx = control_rx;
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    kdj_server::state::UiControl::Show => {
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    kdj_server::state::UiControl::Quit => {
                        request_desktop_exit(&handle);
                    }
                }
            }
        });
    }
    #[cfg(not(desktop))]
    {
        let _ = serve_task;
        let _ = control_rx;
        let _ = data_dir_for_runtime;
    }

    Ok((
        Bridge {
            base_url,
            auth_token,
            media_token,
            config,
            activity_log,
            picker_grants: Mutex::new(HashSet::new()),
        },
        theme,
    ))
}

/// Application Context 的全局 JNI 引用。Activity 会重建，不能把它的生命周期当成
/// 进程生命周期；ndk-context 又明确只允许初始化一次，所以保存稳定的 Application。
#[cfg(target_os = "android")]
static ANDROID_APPLICATION_GLOBAL: std::sync::OnceLock<jni::objects::GlobalRef> =
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
) -> jni::sys::jboolean {
    if ANDROID_APPLICATION_GLOBAL.get().is_some() {
        return jni::sys::JNI_TRUE;
    }
    let vm = match env.get_java_vm() {
        Ok(vm) => vm,
        Err(err) => {
            tracing::error!("KDJ: 拿不到 JavaVM，ndk-context 初始化失败：{err}");
            return jni::sys::JNI_FALSE;
        }
    };
    let application = match env
        .call_method(
            &activity,
            "getApplicationContext",
            "()Landroid/content/Context;",
            &[],
        )
        .and_then(|value| value.l())
    {
        Ok(context) if !context.is_null() => context,
        Ok(_) => {
            tracing::error!("KDJ: Application Context 为空，ndk-context 初始化失败");
            return jni::sys::JNI_FALSE;
        }
        Err(err) => {
            tracing::error!("KDJ: 拿不到 Application Context，ndk-context 初始化失败：{err}");
            return jni::sys::JNI_FALSE;
        }
    };
    let global = match env.new_global_ref(application) {
        Ok(g) => g,
        Err(err) => {
            tracing::error!("KDJ: 转全局引用失败，ndk-context 初始化失败：{err}");
            return jni::sys::JNI_FALSE;
        }
    };
    let vm_ptr = vm.get_java_vm_pointer() as *mut std::ffi::c_void;
    let context_ptr = global.as_obj().as_raw() as *mut std::ffi::c_void;
    // `get_or_init` 是最终进程级门禁：即使未来有别的 Java 入口绕过 Kotlin 的
    // AtomicBoolean 并发调用，依赖的 unsafe 初始化也仍然只会执行一次。
    ANDROID_APPLICATION_GLOBAL.get_or_init(|| {
        unsafe {
            ndk_context::initialize_android_context(vm_ptr, context_ptr);
        }
        global
    });
    tracing::info!("KDJ: ndk-context 已用 Application Context 初始化");
    jni::sys::JNI_TRUE
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
    kdj_core::ensure_rustls_ring();
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,kdj=debug".into()))
        .init();

    #[cfg(desktop)]
    if cli::maybe_handoff_gui() {
        return;
    }

    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(target_os = "macos")]
    let builder = builder.register_uri_scheme_protocol("kdj-youtube", |_context, request| {
        youtube_embed::blank_protocol_response(request.uri().path())
    });
    #[cfg(target_os = "macos")]
    let builder = builder.register_uri_scheme_protocol("kdj-bilibili", |_context, request| {
        bilibili_embed::blank_protocol_response(request.uri().path())
    });
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder.plugin(tauri_plugin_deep_link::init());
    // Android：出声已切共享 coordinator（CPAL/AAudio）；native-audio 插件仍入包，
    // 负责前台保活、歌词 overlay、相册等。iOS 仍由插件内 AVPlayer 出声。
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder.plugin(tauri_plugin_native_audio::init());
    // updater 只在桌面注册：安卓的更新走 Release 页下 APK；重启使用 Tauri 核心能力。
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    let builder = builder.setup(|app| {
        #[cfg(all(desktop, debug_assertions))]
        let youtube_playback_e2e = std::env::var_os("VITE_KDJ_YOUTUBE_E2E")
            .is_some_and(|value| value.as_os_str() == std::ffi::OsStr::new("1"));
        #[cfg(all(target_os = "macos", debug_assertions))]
        if youtube_playback_e2e {
            // The acceptance video must stay visibly composited, but its diagnostic app must not
            // activate over the user's current work or appear as another normal Dock app.
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
        app.manage(UpdateProgressState::default());
        #[cfg(desktop)]
        app.manage(youtube_proof::YoutubeProofState::default());
        #[cfg(desktop)]
        app.manage(youtube_embed::YoutubeEmbedState::default());
        #[cfg(desktop)]
        app.manage(bilibili_embed::BilibiliEmbedState::default());
        #[cfg(desktop)]
        app.manage(midi::MidiHub::spawn(app.handle().clone()));
        #[cfg(any(desktop, target_os = "android"))]
        app.manage(
            desktop_player::DesktopPlayerHandle::spawn(app.handle().clone())
                .map_err(anyhow::Error::msg)?,
        );
        let (bridge, theme) = start_server(app.handle())?;
        tracing::info!("KDJ 后端就绪：{}", bridge.base_url);
        #[cfg(desktop)]
        {
            let data_dir = bridge.config.data_dir.clone();
            let state = load_main_window_state(&data_dir);
            app.manage(MainWindowStateCache {
                data_dir,
                state: Mutex::new(state),
            });
        }
        app.manage(bridge);
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
                let restored_window_state = app
                    .state::<MainWindowStateCache>()
                    .state
                    .lock()
                    .ok()
                    .and_then(|state| *state);
                if let Some(state) = restored_window_state {
                    restore_main_window_state(&window, state);
                }
                if let Err(err) = youtube_proof::apply_main_webview_user_agent(&window) {
                    tracing::warn!("{err}");
                }
                let resolved = resolve_startup_theme(theme, &window);
                if let Err(err) = apply_main_window_background(&window, resolved) {
                    tracing::warn!("启动时设置窗口底色失败：{err}");
                }
                #[cfg(not(target_os = "macos"))]
                if let Err(err) = window.set_decorations(false) {
                    tracing::warn!("关闭系统标题栏失败：{err}");
                }
                #[cfg(debug_assertions)]
                if youtube_playback_e2e {
                    if let Err(err) = window.set_focusable(false) {
                        tracing::warn!("YouTube E2E 窗口无法设为不可聚焦：{err}");
                    }
                    if let Err(err) = window.set_skip_taskbar(true) {
                        tracing::warn!("YouTube E2E 窗口无法隐藏任务栏入口：{err}");
                    }
                }
                if !NO_GUI.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = window.show();
                }
                capture_main_window_state(app.handle());
            }
            #[cfg(not(desktop))]
            {
                let _ = theme;
                let _ = window.show();
            }
        }
        Ok(())
    });

    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_bridge_info,
        cli_install_status,
        install_cli,
        open_path,
        reveal_path,
        share_clipboard::write_share_clipboard,
        start_native_file_drag,
        start_native_link_drag,
        save_login_qr,
        open_external,
        open_soundcloud_oauth_window,
        open_soundcloud_web_login_window,
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
        desktop_player::playback_waveform_window,
        midi::midi_devices,
        midi::midi_send,
        youtube_proof::youtube_mint_gvs_po_token,
        youtube_proof::youtube_run_player,
        youtube_embed::youtube_embed_prewarm,
        youtube_embed::youtube_embed_open,
        youtube_embed::youtube_embed_set_bounds,
        youtube_embed::youtube_embed_status,
        youtube_embed::youtube_embed_control,
        youtube_embed::youtube_embed_close,
        bilibili_embed::bilibili_embed_open,
        bilibili_embed::bilibili_embed_set_bounds,
        bilibili_embed::bilibili_embed_status,
        bilibili_embed::bilibili_embed_control,
        bilibili_embed::bilibili_embed_close
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
        desktop_player::playback_waveform_window,
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

    // macOS 原生红灯和 Windows/Linux 原生关闭路径都必须结束整个应用；
    // 即使桌面歌词等辅助窗口仍存在，也不能让播放或后台任务继续驻留。
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if window.label() != "main" {
            return;
        }
        match event {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                capture_main_window_state(window.app_handle());
            }
            tauri::WindowEvent::CloseRequested { .. } => {
                request_desktop_exit(window.app_handle());
            }
            _ => {}
        }
    });

    #[cfg(desktop)]
    {
        let app = builder
            .build(tauri::generate_context!())
            .expect("KDJ 启动失败");
        app.run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = &event {
                capture_main_window_state(app_handle);
                persist_main_window_state(app_handle);
                shutdown_desktop_runtime(app_handle);
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

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};

    use base64::Engine as _;

    use super::{
        clamp_desktop_lyrics_coordinates, clamp_main_window_state, decode_png_data_url,
        harden_session_permissions, load_main_window_state, write_main_window_state, Bridge,
        DesktopMonitorBounds, MainWindowState, MAIN_WINDOW_STATE_FILE, MAIN_WINDOW_STATE_VERSION,
    };
    #[cfg(desktop)]
    use super::{
        soundcloud_oauth_callback_request, soundcloud_web_login_navigation_allowed,
        soundcloud_web_login_request, soundcloud_web_session, SoundCloudWebSession,
    };

    #[cfg(desktop)]
    #[test]
    fn soundcloud_oauth_callback_carries_the_control_bearer() {
        kdj_core::ensure_rustls_ring();
        let request = soundcloud_oauth_callback_request(
            &reqwest::Client::new(),
            "http://127.0.0.1:5274/api/accounts/soundcloud/login/oauth/callback",
            "control-secret",
            "oauth-state",
            "authorization-code",
        )
        .build()
        .unwrap();
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .unwrap(),
            "Bearer control-secret"
        );
    }

    #[cfg(desktop)]
    #[test]
    fn soundcloud_web_login_only_accepts_expected_navigation_hosts() {
        assert!(soundcloud_web_login_navigation_allowed(
            &tauri::Url::parse("https://soundcloud.com/signin").unwrap()
        ));
        assert!(soundcloud_web_login_navigation_allowed(
            &tauri::Url::parse("https://accounts.google.com/o/oauth2/auth").unwrap()
        ));
        assert!(!soundcloud_web_login_navigation_allowed(
            &tauri::Url::parse("http://soundcloud.com/signin").unwrap()
        ));
        assert!(!soundcloud_web_login_navigation_allowed(
            &tauri::Url::parse("https://soundcloud.com.evil.example/signin").unwrap()
        ));
    }

    #[cfg(desktop)]
    #[test]
    fn soundcloud_web_login_selects_a_live_scoped_cookie() {
        let future = tauri::webview::Cookie::build(("oauth_token", "web-token"))
            .domain(".soundcloud.com")
            .build();
        let unrelated = tauri::webview::Cookie::build(("oauth_token", "other-token"))
            .domain("example.com")
            .build();
        let session = soundcloud_web_session(&[unrelated, future]).unwrap();
        assert_eq!(session.access_token, "web-token");
        assert_eq!(session.expires_at, 0);
    }

    #[cfg(desktop)]
    #[test]
    fn soundcloud_web_login_request_carries_the_control_bearer() {
        kdj_core::ensure_rustls_ring();
        let request = soundcloud_web_login_request(
            &reqwest::Client::new(),
            "http://127.0.0.1:5274/api/accounts/soundcloud/login/webview",
            "control-secret",
            &SoundCloudWebSession {
                access_token: "web-token".into(),
                expires_at: 123,
            },
        )
        .build()
        .unwrap();
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .unwrap(),
            "Bearer control-secret"
        );
    }

    #[cfg(unix)]
    #[test]
    fn legacy_session_files_are_hardened_without_changing_contents() {
        use std::os::unix::fs::PermissionsExt as _;

        let root = std::env::temp_dir().join(format!(
            "kdj-session-permissions-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o755)).unwrap();
        let credential = sessions.join("qqmusic.json");
        std::fs::write(&credential, b"unchanged").unwrap();
        std::fs::set_permissions(&credential, std::fs::Permissions::from_mode(0o644)).unwrap();

        harden_session_permissions(&root);

        assert_eq!(std::fs::read(&credential).unwrap(), b"unchanged");
        assert_eq!(
            std::fs::metadata(&sessions).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&credential).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn desktop_lyrics_restore_stays_on_an_available_monitor() {
        let monitors = [
            DesktopMonitorBounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            DesktopMonitorBounds {
                x: 1920,
                y: 0,
                width: 2560,
                height: 1440,
            },
        ];
        assert_eq!(
            clamp_desktop_lyrics_coordinates(&monitors, 900, 100, 2500, 1200),
            (2500, 1200),
        );
        assert_eq!(
            clamp_desktop_lyrics_coordinates(&monitors[..1], 900, 100, 2500, 1200),
            (1020, 980),
        );
    }

    #[test]
    fn main_window_state_round_trips_and_moves_back_onto_an_available_monitor() {
        let root = std::env::temp_dir().join(format!(
            "kdj-main-window-state-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let state = MainWindowState {
            version: MAIN_WINDOW_STATE_VERSION,
            x: 2400,
            y: 1200,
            width: 1360,
            height: 880,
            maximized: true,
        };
        write_main_window_state(&root, state).unwrap();
        assert_eq!(load_main_window_state(&root), Some(state));

        let monitor = DesktopMonitorBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert_eq!(
            clamp_main_window_state(state, &[monitor]),
            MainWindowState {
                x: 560,
                y: 200,
                ..state
            }
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_main_window_state_is_quarantined_without_blocking_startup() {
        let root = std::env::temp_dir().join(format!(
            "kdj-corrupt-main-window-state-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(MAIN_WINDOW_STATE_FILE), b"{ definitely not json").unwrap();

        assert_eq!(load_main_window_state(&root), None);
        assert!(!root.join(MAIN_WINDOW_STATE_FILE).exists());
        assert!(std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("main-window-state.json.corrupt-")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn login_qr_accepts_a_real_bounded_png_and_rejects_spoofed_bytes() {
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(include_bytes!("../icons/128x128.png"));
        let decoded = decode_png_data_url(&format!("data:image/png;base64,{encoded}")).unwrap();
        assert!(decoded.starts_with(b"\x89PNG\r\n\x1a\n"));

        let spoofed = base64::engine::general_purpose::STANDARD.encode(b"not a png");
        assert!(decode_png_data_url(&format!("data:image/png;base64,{spoofed}")).is_err());
        let oversized = "A".repeat(2 * 1024 * 1024 / 3 * 4 + 16);
        assert!(decode_png_data_url(&format!("data:image/png;base64,{oversized}")).is_err());
    }

    #[test]
    fn ipc_paths_require_managed_roots_or_a_native_picker_grant() {
        let root = std::env::temp_dir().join(format!(
            "kdj-ipc-paths-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let download = root.join("downloads");
        let outside = root.join("outside");
        std::fs::create_dir_all(&download).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let managed_file = download.join("track.mp3");
        let outside_file = outside.join("secret.txt");
        std::fs::write(&managed_file, b"audio").unwrap();
        std::fs::write(&outside_file, b"secret").unwrap();

        let config = Arc::new(kdj_core::AppConfig::create(root.join("data"), download, 0));
        let bridge = Bridge {
            base_url: "http://127.0.0.1:1".into(),
            auth_token: "test".into(),
            media_token: "media-test".into(),
            activity_log: kdj_server::activity_log::ActivityLog::new(config.data_dir.clone())
                .unwrap(),
            config,
            picker_grants: Mutex::new(HashSet::new()),
        };
        assert!(bridge
            .authorize_existing_path(&managed_file.to_string_lossy(), false)
            .is_ok());
        assert!(bridge
            .authorize_existing_path(&outside_file.to_string_lossy(), true)
            .is_err());
        bridge.grant_picked_path(&outside);
        assert!(bridge
            .authorize_existing_path(&outside_file.to_string_lossy(), true)
            .is_ok());
        assert!(bridge
            .authorize_existing_path(&outside_file.to_string_lossy(), false)
            .is_err());

        let _ = std::fs::remove_dir_all(root);
    }
}
