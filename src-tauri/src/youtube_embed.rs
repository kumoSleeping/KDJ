//! Isolated official YouTube video player for macOS.
//!
//! The app's main WebView must never host YouTube JavaScript: it owns the Tauri invoke key and
//! authenticated loopback bearer. This module attaches a second, non-persistent WKWebView to the
//! main native window, removes every Tauri user script and the `ipc` message handler while it is
//! still displaying a local inert page, and only then navigates it to one validated official
//! `/embed/<video id>` document. KDJ controls the player through narrow native evaluations; the
//! remote page receives neither browser-login cookies nor a general application bridge.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;

const EMBED_WEBVIEW_LABEL: &str = "youtube-video-embed";
const BLANK_DOCUMENT_URL: &str = "kdj-youtube://localhost/blank";
const EMBED_APP_REFERRER: &str = "https://github.com/kumoSleeping/KDJ";
const EVALUATION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct CurrentEmbed {
    video_id: String,
}

#[derive(Default)]
pub struct YoutubeEmbedState {
    /// Serializes navigation, control, status, and disposal so a late command from the previous
    /// React session cannot act on the next video.
    lifecycle: tokio::sync::Mutex<()>,
    current: Mutex<Option<CurrentEmbed>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeEmbedStatus {
    ready: bool,
    playing: bool,
    buffering: bool,
    ended: bool,
    position: f64,
    duration: f64,
    has_error: bool,
}

impl Default for YoutubeEmbedStatus {
    fn default() -> Self {
        Self {
            ready: false,
            playing: false,
            buffering: false,
            ended: false,
            position: 0.0,
            duration: 0.0,
            has_error: false,
        }
    }
}

pub fn blank_protocol_response(path: &str) -> tauri::http::Response<Vec<u8>> {
    if path != "/blank" {
        return tauri::http::Response::builder()
            .status(404)
            .header(
                tauri::http::header::CONTENT_TYPE,
                "text/plain; charset=utf-8",
            )
            .body(Vec::new())
            .expect("fixed YouTube blank response is valid");
    }
    let html = br#"<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;width:100%;height:100%;background:#000}</style>"#;
    tauri::http::Response::builder()
        .status(200)
        .header(
            tauri::http::header::CONTENT_TYPE,
            "text/html; charset=utf-8",
        )
        .header(tauri::http::header::CACHE_CONTROL, "no-store")
        .header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'",
        )
        .body(html.to_vec())
        .expect("fixed YouTube blank response is valid")
}

fn valid_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_embed_url(url: &tauri::Url) -> bool {
    if url.as_str() == BLANK_DOCUMENT_URL {
        return true;
    }
    if url.scheme() != "https"
        || url.host_str() != Some("www.youtube.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    url.path()
        .strip_prefix("/embed/")
        .is_some_and(valid_video_id)
}

fn require_main(caller: &tauri::Webview) -> Result<(), String> {
    if caller.label() == "main" {
        Ok(())
    } else {
        Err("YouTube 播放器命令只允许主界面调用".into())
    }
}

fn valid_bounds(x: f64, y: f64, width: f64, height: f64) -> bool {
    [x, y, width, height].into_iter().all(f64::is_finite)
        && x >= 0.0
        && y >= 0.0
        // YouTube's official player contract requires at least a 200×200 viewport.
        && width >= 200.0
        && height >= 200.0
        && x <= 20_000.0
        && y <= 20_000.0
        && width <= 20_000.0
        && height <= 20_000.0
}

fn set_bounds(
    webview: &tauri::Webview,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if !valid_bounds(x, y, width, height) {
        return Err("YouTube 播放器位置无效".into());
    }
    webview
        .set_bounds(tauri::Rect {
            position: tauri::Position::Logical(tauri::LogicalPosition::new(x, y)),
            size: tauri::Size::Logical(tauri::LogicalSize::new(width, height)),
        })
        .map_err(|error| format!("无法调整 YouTube 播放器：{error}"))
}

#[cfg(target_os = "macos")]
fn ensure_embed_webview(app: &tauri::AppHandle) -> Result<tauri::Webview, String> {
    use objc2_foundation::NSString;
    use objc2_web_kit::WKUserContentController;
    use tauri::webview::{NewWindowResponse, WebviewBuilder};
    use tauri::WebviewUrl;

    if let Some(webview) = app.get_webview(EMBED_WEBVIEW_LABEL) {
        return Ok(webview);
    }
    let parent = app
        .get_window("main")
        .ok_or_else(|| "KDJ 主窗口尚未就绪".to_string())?;
    let blank = tauri::Url::parse(BLANK_DOCUMENT_URL)
        .map_err(|_| "YouTube 隔离空白页地址无效".to_string())?;
    let builder = WebviewBuilder::new(EMBED_WEBVIEW_LABEL, WebviewUrl::CustomProtocol(blank))
        .incognito(true)
        .focused(false)
        .disable_drag_drop_handler()
        .on_navigation(valid_embed_url)
        .on_new_window(|_, _| NewWindowResponse::Deny);
    // Start outside the visible content. The view is hidden immediately after creation and does
    // not move over the React window until `youtube_embed_open` has validated explicit bounds.
    let webview = parent
        .add_child(
            builder,
            tauri::LogicalPosition::new(-10_000.0, -10_000.0),
            tauri::LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| format!("无法创建隔离的 YouTube 播放器：{error}"))?;
    webview
        .hide()
        .map_err(|error| format!("无法隐藏 YouTube 播放器预热页：{error}"))?;
    webview
        .with_webview(|native| unsafe {
            let controller: &WKUserContentController = &*native.controller().cast();
            // The blank document is local and inert. Removing both registrations before the first
            // remote navigation means YouTube never sees the invoke key or an `ipc` transport.
            controller.removeAllUserScripts();
            controller.removeScriptMessageHandlerForName(&NSString::from_str("ipc"));
        })
        .map_err(|error| format!("无法隔离 YouTube 播放器权限：{error}"))?;
    Ok(webview)
}

#[cfg(not(target_os = "macos"))]
fn ensure_embed_webview(_app: &tauri::AppHandle) -> Result<tauri::Webview, String> {
    Err("当前桌面系统尚未启用隔离的 YouTube 官方播放器".into())
}

fn current_matches(state: &YoutubeEmbedState, video_id: &str) -> bool {
    state
        .current
        .lock()
        .ok()
        .and_then(|current| current.as_ref().map(|item| item.video_id == video_id))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn navigate_embed(webview: &tauri::Webview, video_id: &str) -> Result<(), String> {
    use objc2_foundation::{NSMutableURLRequest, NSString, NSURL};
    use objc2_web_kit::WKWebView;

    let url = format!(
        "https://www.youtube.com/embed/{video_id}?enablejsapi=1&autoplay=0&playsinline=1&controls=1&fs=1&rel=0&hl=zh-CN&origin=https%3A%2F%2Fgithub.com&widget_referrer=https%3A%2F%2Fgithub.com%2FkumoSleeping%2FKDJ"
    );
    webview
        .with_webview(move |native| unsafe {
            let view: &WKWebView = &*native.inner().cast();
            let ns_url = NSURL::URLWithString(&NSString::from_str(&url))
                .expect("validated YouTube embed URL is valid");
            let request = NSMutableURLRequest::requestWithURL(&ns_url);
            request.setValue_forHTTPHeaderField(
                Some(&NSString::from_str(EMBED_APP_REFERRER)),
                &NSString::from_str("Referer"),
            );
            let _ = view.loadRequest(&request);
        })
        .map_err(|error| format!("无法打开 YouTube 官方播放器：{error}"))
}

#[cfg(not(target_os = "macos"))]
fn navigate_embed(_webview: &tauri::Webview, _video_id: &str) -> Result<(), String> {
    Err("当前桌面系统尚未启用隔离的 YouTube 官方播放器".into())
}

#[cfg(target_os = "macos")]
async fn evaluate_string(webview: &tauri::Webview, javascript: String) -> Result<String, String> {
    use block2::RcBlock;
    use objc2::{runtime::AnyObject, MainThreadMarker};
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::{WKContentWorld, WKWebView};

    let (result_tx, result_rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let result_tx = Arc::new(Mutex::new(Some(result_tx)));
    let callback_tx = Arc::clone(&result_tx);
    webview
        .with_webview(move |native| unsafe {
            let view: &WKWebView = &*native.inner().cast();
            let Some(main_thread) = MainThreadMarker::new() else {
                if let Ok(mut sender) = callback_tx.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(Err("YouTube 播放器没有运行在窗口线程".into()));
                    }
                }
                return;
            };
            let world = WKContentWorld::pageWorld(main_thread);
            let handler = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                let result = if !error.is_null() || value.is_null() {
                    Err("YouTube 播放器控制失败".to_string())
                } else {
                    let text: &NSString = &*value.cast();
                    Ok(text.to_string())
                };
                if let Ok(mut sender) = result_tx.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(result);
                    }
                }
            });
            view.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                &NSString::from_str(&javascript),
                None,
                None,
                &world,
                Some(&handler),
            );
        })
        .map_err(|error| format!("无法进入 YouTube 播放器窗口线程：{error}"))?;
    tokio::time::timeout(EVALUATION_TIMEOUT, result_rx)
        .await
        .map_err(|_| "YouTube 播放器响应超时".to_string())?
        .map_err(|_| "YouTube 播放器响应状态丢失".to_string())?
}

#[cfg(not(target_os = "macos"))]
async fn evaluate_string(_webview: &tauri::Webview, _javascript: String) -> Result<String, String> {
    Err("当前桌面系统尚未启用隔离的 YouTube 官方播放器".into())
}

fn finite_media_value(value: Option<f64>) -> f64 {
    value
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 31_536_000.0)
        .unwrap_or(0.0)
}

#[tauri::command]
pub async fn youtube_embed_prewarm(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    state: tauri::State<'_, YoutubeEmbedState>,
) -> Result<(), String> {
    require_main(&caller)?;
    let _active = state.lifecycle.lock().await;
    let _ = ensure_embed_webview(&app)?;
    Ok(())
}

#[tauri::command]
pub async fn youtube_embed_open(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    state: tauri::State<'_, YoutubeEmbedState>,
    video_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    require_main(&caller)?;
    if !valid_video_id(&video_id) || !valid_bounds(x, y, width, height) {
        return Err("YouTube 视频或播放器位置无效".into());
    }
    let _active = state.lifecycle.lock().await;
    let webview = ensure_embed_webview(&app)?;
    set_bounds(&webview, x, y, width, height)?;
    {
        let mut current = state
            .current
            .lock()
            .map_err(|_| "YouTube 播放器状态不可用".to_string())?;
        *current = Some(CurrentEmbed {
            video_id: video_id.clone(),
        });
    }
    if let Err(error) = navigate_embed(&webview, &video_id) {
        if let Ok(mut current) = state.current.lock() {
            *current = None;
        }
        return Err(error);
    }
    webview
        .show()
        .map_err(|error| format!("无法显示 YouTube 播放器：{error}"))
}

#[tauri::command]
pub async fn youtube_embed_set_bounds(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    state: tauri::State<'_, YoutubeEmbedState>,
    video_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    require_main(&caller)?;
    if !valid_video_id(&video_id) || !valid_bounds(x, y, width, height) {
        return Err("YouTube 播放器位置无效".into());
    }
    let _active = state.lifecycle.lock().await;
    if !current_matches(&state, &video_id) {
        return Ok(());
    }
    let webview = app
        .get_webview(EMBED_WEBVIEW_LABEL)
        .ok_or_else(|| "YouTube 播放器尚未创建".to_string())?;
    set_bounds(&webview, x, y, width, height)
}

#[tauri::command]
pub async fn youtube_embed_status(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    state: tauri::State<'_, YoutubeEmbedState>,
    video_id: String,
) -> Result<YoutubeEmbedStatus, String> {
    require_main(&caller)?;
    if !valid_video_id(&video_id) {
        return Err("YouTube 视频编号无效".into());
    }
    let _active = state.lifecycle.lock().await;
    if !current_matches(&state, &video_id) {
        return Ok(YoutubeEmbedStatus::default());
    }
    let webview = app
        .get_webview(EMBED_WEBVIEW_LABEL)
        .ok_or_else(|| "YouTube 播放器尚未创建".to_string())?;
    let video_json =
        serde_json::to_string(&video_id).map_err(|_| "YouTube 视频编号序列化失败".to_string())?;
    let raw = evaluate_string(
        &webview,
        format!(
            r#"
const expected = {video_json};
const player = document.getElementById("movie_player");
const expectedPath = `/embed/${{expected}}`;
const ready = location.pathname === expectedPath
  && player
  && typeof player.getPlayerState === "function"
  && typeof player.getCurrentTime === "function"
  && typeof player.getDuration === "function";
if (!ready) return JSON.stringify({{ ready: false }});
const errorNode = document.querySelector(".ytp-error-content-wrap");
return JSON.stringify({{
  ready: true,
  state: Number(player.getPlayerState()),
  position: Number(player.getCurrentTime()),
  duration: Number(player.getDuration()),
  hasError: Boolean(errorNode && errorNode.offsetParent !== null),
}});
"#,
        ),
    )
    .await?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "YouTube 播放器状态无效".to_string())?;
    let ready = value
        .get("ready")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !ready {
        return Ok(YoutubeEmbedStatus::default());
    }
    let player_state = value
        .get("state")
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(-1.0) as i32;
    Ok(YoutubeEmbedStatus {
        ready: true,
        playing: player_state == 1,
        buffering: player_state == 3,
        ended: player_state == 0,
        position: finite_media_value(value.get("position").and_then(serde_json::Value::as_f64)),
        duration: finite_media_value(value.get("duration").and_then(serde_json::Value::as_f64)),
        has_error: value
            .get("hasError")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

#[tauri::command]
pub async fn youtube_embed_control(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    state: tauri::State<'_, YoutubeEmbedState>,
    video_id: String,
    action: String,
    value: Option<f64>,
) -> Result<(), String> {
    require_main(&caller)?;
    if !valid_video_id(&video_id) {
        return Err("YouTube 视频编号无效".into());
    }
    let operation = match action.as_str() {
        "play" => "player.playVideo();".to_string(),
        "pause" => "player.pauseVideo();".to_string(),
        "mute" => "player.mute();".to_string(),
        "unmute" => "player.unMute();".to_string(),
        "volume" => {
            let target = value
                .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 1.0)
                .ok_or_else(|| "YouTube 播放器音量无效".to_string())?;
            let percent = target * 100.0;
            format!(
                "player.setVolume({percent}); if ({target} <= 0) player.mute(); else player.unMute();"
            )
        }
        "seek" => {
            let target = value
                .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 31_536_000.0)
                .ok_or_else(|| "YouTube 跳转位置无效".to_string())?;
            return youtube_embed_seek(&app, &state, &video_id, target).await;
        }
        _ => return Err("YouTube 播放器操作无效".into()),
    };
    let _active = state.lifecycle.lock().await;
    if !current_matches(&state, &video_id) {
        return Err("YouTube 播放会话已经变化".into());
    }
    let webview = app
        .get_webview(EMBED_WEBVIEW_LABEL)
        .ok_or_else(|| "YouTube 播放器尚未创建".to_string())?;
    let video_json =
        serde_json::to_string(&video_id).map_err(|_| "YouTube 视频编号序列化失败".to_string())?;
    let result = evaluate_string(
        &webview,
        format!(
            r#"
const expected = {video_json};
const player = document.getElementById("movie_player");
if (location.pathname !== `/embed/${{expected}}` || !player) return "not-ready";
{operation}
return "ok";
"#,
        ),
    )
    .await?;
    if result == "ok" {
        Ok(())
    } else {
        Err("YouTube 官方播放器尚未就绪".into())
    }
}

async fn youtube_embed_seek(
    app: &tauri::AppHandle,
    state: &YoutubeEmbedState,
    video_id: &str,
    target: f64,
) -> Result<(), String> {
    let _active = state.lifecycle.lock().await;
    if !current_matches(state, video_id) {
        return Err("YouTube 播放会话已经变化".into());
    }
    let webview = app
        .get_webview(EMBED_WEBVIEW_LABEL)
        .ok_or_else(|| "YouTube 播放器尚未创建".to_string())?;
    let video_json =
        serde_json::to_string(video_id).map_err(|_| "YouTube 视频编号序列化失败".to_string())?;
    let result = evaluate_string(
        &webview,
        format!(
            r#"
const expected = {video_json};
const player = document.getElementById("movie_player");
if (location.pathname !== `/embed/${{expected}}` || !player) return "not-ready";
player.seekTo({target}, true);
return "ok";
"#,
        ),
    )
    .await?;
    if result == "ok" {
        Ok(())
    } else {
        Err("YouTube 官方播放器尚未就绪".into())
    }
}

#[tauri::command]
pub async fn youtube_embed_close(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    state: tauri::State<'_, YoutubeEmbedState>,
    video_id: String,
) -> Result<(), String> {
    require_main(&caller)?;
    if !valid_video_id(&video_id) {
        return Err("YouTube 视频编号无效".into());
    }
    let _active = state.lifecycle.lock().await;
    if !current_matches(&state, &video_id) {
        return Ok(());
    }
    if let Some(webview) = app.get_webview(EMBED_WEBVIEW_LABEL) {
        let _ = evaluate_string(
            &webview,
            "const player = document.getElementById(\"movie_player\"); if (player && typeof player.stopVideo === \"function\") player.stopVideo(); return \"ok\";".into(),
        )
        .await;
        webview
            .hide()
            .map_err(|error| format!("无法隐藏 YouTube 播放器：{error}"))?;
    }
    let mut current = state
        .current
        .lock()
        .map_err(|_| "YouTube 播放器状态不可用".to_string())?;
    *current = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_canonical_video_ids_and_embed_navigation() {
        assert!(valid_video_id("dQw4w9WgXcQ"));
        assert!(!valid_video_id("short"));
        assert!(!valid_video_id("bad/video!"));
        assert!(valid_embed_url(
            &tauri::Url::parse("https://www.youtube.com/embed/dQw4w9WgXcQ?controls=1").unwrap()
        ));
        assert!(!valid_embed_url(
            &tauri::Url::parse("https://evil.example/embed/dQw4w9WgXcQ").unwrap()
        ));
        assert!(!valid_embed_url(
            &tauri::Url::parse("https://www.youtube.com/watch?v=dQw4w9WgXcQ").unwrap()
        ));
    }

    #[test]
    fn rejects_bounds_that_can_escape_the_expected_window_scale() {
        assert!(valid_bounds(10.0, 20.0, 640.0, 360.0));
        assert!(!valid_bounds(-1.0, 20.0, 640.0, 360.0));
        assert!(!valid_bounds(10.0, 20.0, 199.0, 200.0));
        assert!(!valid_bounds(10.0, 20.0, f64::NAN, 360.0));
    }
}
