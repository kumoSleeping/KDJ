//! Isolated official Bilibili video player for macOS.
//!
//! The remote player lives in a non-persistent sibling WKWebView. Before the first remote
//! navigation KDJ removes Tauri's user scripts and IPC handler, so the platform page receives
//! neither the app bridge nor KDJ's loopback credentials.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;

const EMBED_WEBVIEW_LABEL: &str = "bilibili-video-embed";
const BLANK_DOCUMENT_URL: &str = "kdj-bilibili://localhost/blank";
const EMBED_APP_REFERRER: &str = "https://www.bilibili.com/";
const EVALUATION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct CurrentEmbed {
    bvid: String,
    page: u32,
}

#[derive(Default)]
pub struct BilibiliEmbedState {
    lifecycle: tokio::sync::Mutex<()>,
    current: Mutex<Option<CurrentEmbed>>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilibiliEmbedStatus {
    ready: bool,
    playing: bool,
    buffering: bool,
    ended: bool,
    position: f64,
    duration: f64,
    has_error: bool,
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
            .expect("fixed Bilibili blank response is valid");
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
        .expect("fixed Bilibili blank response is valid")
}

fn valid_bvid(value: &str) -> bool {
    value.len() == 12
        && value.starts_with("BV")
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn valid_page(value: &str) -> bool {
    value
        .parse::<u32>()
        .is_ok_and(|page| (1..=10_000).contains(&page))
}

fn valid_embed_url(url: &tauri::Url) -> bool {
    if url.as_str() == BLANK_DOCUMENT_URL {
        return true;
    }
    if url.scheme() != "https"
        || url.host_str() != Some("player.bilibili.com")
        || url.port_or_known_default() != Some(443)
        || url.path() != "/player.html"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let mut bvid = None;
    let mut page = None;
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "bvid" if bvid.is_none() => bvid = Some(value.into_owned()),
            "page" if page.is_none() => page = Some(value.into_owned()),
            "bvid" | "page" => return false,
            _ => {}
        }
    }
    bvid.as_deref().is_some_and(valid_bvid) && page.as_deref().is_some_and(valid_page)
}

fn require_main(caller: &tauri::Webview) -> Result<(), String> {
    if caller.label() == "main" {
        Ok(())
    } else {
        Err("B站播放器命令只允许主界面调用".into())
    }
}

fn valid_bounds(x: f64, y: f64, width: f64, height: f64) -> bool {
    [x, y, width, height].into_iter().all(f64::is_finite)
        && x >= 0.0
        && y >= 0.0
        && width >= 200.0
        && height >= 120.0
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
        return Err("B站播放器位置无效".into());
    }
    webview
        .set_bounds(tauri::Rect {
            position: tauri::Position::Logical(tauri::LogicalPosition::new(x, y)),
            size: tauri::Size::Logical(tauri::LogicalSize::new(width, height)),
        })
        .map_err(|error| format!("无法调整 B站播放器：{error}"))
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
    let blank =
        tauri::Url::parse(BLANK_DOCUMENT_URL).map_err(|_| "B站隔离空白页地址无效".to_string())?;
    let builder = WebviewBuilder::new(EMBED_WEBVIEW_LABEL, WebviewUrl::CustomProtocol(blank))
        .incognito(true)
        .focused(false)
        .disable_drag_drop_handler()
        .on_navigation(valid_embed_url)
        .on_new_window(|_, _| NewWindowResponse::Deny);
    let webview = parent
        .add_child(
            builder,
            tauri::LogicalPosition::new(-10_000.0, -10_000.0),
            tauri::LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| format!("无法创建隔离的 B站播放器：{error}"))?;
    webview
        .hide()
        .map_err(|error| format!("无法隐藏 B站播放器初始化页：{error}"))?;
    webview
        .with_webview(|native| unsafe {
            let controller: &WKUserContentController = &*native.controller().cast();
            controller.removeAllUserScripts();
            controller.removeScriptMessageHandlerForName(&NSString::from_str("ipc"));
        })
        .map_err(|error| format!("无法隔离 B站播放器权限：{error}"))?;
    Ok(webview)
}

#[cfg(not(target_os = "macos"))]
fn ensure_embed_webview(_app: &tauri::AppHandle) -> Result<tauri::Webview, String> {
    Err("当前桌面系统尚未启用隔离的 B站官方播放器".into())
}

fn current_matches(state: &BilibiliEmbedState, bvid: &str, page: u32) -> bool {
    state
        .current
        .lock()
        .ok()
        .and_then(|current| {
            current
                .as_ref()
                .map(|item| item.bvid == bvid && item.page == page)
        })
        .unwrap_or(false)
}

fn embed_url(bvid: &str, page: u32) -> String {
    let platform_page = page.saturating_add(1);
    format!(
        "https://player.bilibili.com/player.html?bvid={bvid}&page={platform_page}&high_quality=1&danmaku=0&autoplay=0"
    )
}

#[cfg(target_os = "macos")]
fn navigate_embed(webview: &tauri::Webview, bvid: &str, page: u32) -> Result<(), String> {
    use objc2_foundation::{NSMutableURLRequest, NSString, NSURL};
    use objc2_web_kit::WKWebView;

    let url = embed_url(bvid, page);
    webview
        .with_webview(move |native| unsafe {
            let view: &WKWebView = &*native.inner().cast();
            let ns_url = NSURL::URLWithString(&NSString::from_str(&url))
                .expect("validated Bilibili embed URL is valid");
            let request = NSMutableURLRequest::requestWithURL(&ns_url);
            request.setValue_forHTTPHeaderField(
                Some(&NSString::from_str(EMBED_APP_REFERRER)),
                &NSString::from_str("Referer"),
            );
            let _ = view.loadRequest(&request);
        })
        .map_err(|error| format!("无法打开 B站官方播放器：{error}"))
}

#[cfg(not(target_os = "macos"))]
fn navigate_embed(_webview: &tauri::Webview, _bvid: &str, _page: u32) -> Result<(), String> {
    Err("当前桌面系统尚未启用隔离的 B站官方播放器".into())
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
                        let _ = sender.send(Err("B站播放器没有运行在窗口线程".into()));
                    }
                }
                return;
            };
            let world = WKContentWorld::pageWorld(main_thread);
            let handler = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                let result = if !error.is_null() || value.is_null() {
                    Err("B站播放器控制失败".to_string())
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
        .map_err(|error| format!("无法进入 B站播放器窗口线程：{error}"))?;
    tokio::time::timeout(EVALUATION_TIMEOUT, result_rx)
        .await
        .map_err(|_| "B站播放器响应超时".to_string())?
        .map_err(|_| "B站播放器响应状态丢失".to_string())?
}

#[cfg(not(target_os = "macos"))]
async fn evaluate_string(_webview: &tauri::Webview, _javascript: String) -> Result<String, String> {
    Err("当前桌面系统尚未启用隔离的 B站官方播放器".into())
}

fn finite_media_value(value: Option<f64>) -> f64 {
    value
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 31_536_000.0)
        .unwrap_or(0.0)
}

#[tauri::command]
pub async fn bilibili_embed_open(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    state: tauri::State<'_, BilibiliEmbedState>,
    bvid: String,
    page: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    require_main(&caller)?;
    if !valid_bvid(&bvid) || page >= 10_000 || !valid_bounds(x, y, width, height) {
        return Err("B站视频或播放器位置无效".into());
    }
    let _active = state.lifecycle.lock().await;
    let webview = ensure_embed_webview(&app)?;
    set_bounds(&webview, x, y, width, height)?;
    {
        let mut current = state
            .current
            .lock()
            .map_err(|_| "B站播放器状态不可用".to_string())?;
        *current = Some(CurrentEmbed {
            bvid: bvid.clone(),
            page,
        });
    }
    if let Err(error) = navigate_embed(&webview, &bvid, page) {
        if let Ok(mut current) = state.current.lock() {
            *current = None;
        }
        return Err(error);
    }
    webview
        .show()
        .map_err(|error| format!("无法显示 B站播放器：{error}"))
}

#[tauri::command]
pub async fn bilibili_embed_set_bounds(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    state: tauri::State<'_, BilibiliEmbedState>,
    bvid: String,
    page: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    require_main(&caller)?;
    if !valid_bvid(&bvid) || page >= 10_000 || !valid_bounds(x, y, width, height) {
        return Err("B站播放器位置无效".into());
    }
    let _active = state.lifecycle.lock().await;
    if !current_matches(&state, &bvid, page) {
        return Ok(());
    }
    let webview = app
        .get_webview(EMBED_WEBVIEW_LABEL)
        .ok_or_else(|| "B站播放器尚未创建".to_string())?;
    set_bounds(&webview, x, y, width, height)
}

#[tauri::command]
pub async fn bilibili_embed_status(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    state: tauri::State<'_, BilibiliEmbedState>,
    bvid: String,
    page: u32,
) -> Result<BilibiliEmbedStatus, String> {
    require_main(&caller)?;
    if !valid_bvid(&bvid) || page >= 10_000 {
        return Err("B站视频编号无效".into());
    }
    let _active = state.lifecycle.lock().await;
    if !current_matches(&state, &bvid, page) {
        return Ok(BilibiliEmbedStatus::default());
    }
    let webview = app
        .get_webview(EMBED_WEBVIEW_LABEL)
        .ok_or_else(|| "B站播放器尚未创建".to_string())?;
    let bvid_json =
        serde_json::to_string(&bvid).map_err(|_| "B站视频编号序列化失败".to_string())?;
    let platform_page = page.saturating_add(1);
    let raw = evaluate_string(
        &webview,
        format!(
            r#"
const expectedBvid = {bvid_json};
const expectedPage = "{platform_page}";
const params = new URL(location.href).searchParams;
const video = document.querySelector("video");
const ready = location.hostname === "player.bilibili.com"
  && location.pathname === "/player.html"
  && params.get("bvid") === expectedBvid
  && params.get("page") === expectedPage
  && video
  && video.readyState >= 1;
if (!ready) return JSON.stringify({{ ready: false }});
return JSON.stringify({{
  ready: true,
  playing: !video.paused && !video.ended,
  buffering: !video.paused && video.readyState < 3,
  ended: video.ended,
  position: Number(video.currentTime),
  duration: Number(video.duration),
  hasError: Boolean(video.error || document.querySelector(".bpx-player-error, .error-panel")),
}});
"#,
        ),
    )
    .await?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "B站播放器状态无效".to_string())?;
    if !value
        .get("ready")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(BilibiliEmbedStatus::default());
    }
    Ok(BilibiliEmbedStatus {
        ready: true,
        playing: value
            .get("playing")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        buffering: value
            .get("buffering")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        ended: value
            .get("ended")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        position: finite_media_value(value.get("position").and_then(serde_json::Value::as_f64)),
        duration: finite_media_value(value.get("duration").and_then(serde_json::Value::as_f64)),
        has_error: value
            .get("hasError")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

#[tauri::command]
pub async fn bilibili_embed_control(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    state: tauri::State<'_, BilibiliEmbedState>,
    bvid: String,
    page: u32,
    action: String,
    value: Option<f64>,
) -> Result<(), String> {
    require_main(&caller)?;
    if !valid_bvid(&bvid) || page >= 10_000 {
        return Err("B站视频编号无效".into());
    }
    let operation = match action.as_str() {
        "play" => "void video.play();".to_string(),
        "pause" => "video.pause();".to_string(),
        "mute" => "video.muted = true;".to_string(),
        "unmute" => "video.muted = false;".to_string(),
        "volume" => {
            let target = value
                .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 1.0)
                .ok_or_else(|| "B站播放器音量无效".to_string())?;
            format!("video.volume = {target}; video.muted = {target} <= 0;")
        }
        "seek" => {
            let target = value
                .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 31_536_000.0)
                .ok_or_else(|| "B站跳转位置无效".to_string())?;
            return bilibili_embed_seek(&app, &state, &bvid, page, target).await;
        }
        _ => return Err("B站播放器操作无效".into()),
    };
    let _active = state.lifecycle.lock().await;
    if !current_matches(&state, &bvid, page) {
        return Err("B站播放会话已经变化".into());
    }
    let webview = app
        .get_webview(EMBED_WEBVIEW_LABEL)
        .ok_or_else(|| "B站播放器尚未创建".to_string())?;
    let result = evaluate_string(
        &webview,
        format!(
            r#"const video = document.querySelector("video"); if (!video) return "not-ready"; {operation} return "ok";"#
        ),
    )
    .await?;
    if result == "ok" {
        Ok(())
    } else {
        Err("B站官方播放器尚未就绪".into())
    }
}

async fn bilibili_embed_seek(
    app: &tauri::AppHandle,
    state: &BilibiliEmbedState,
    bvid: &str,
    page: u32,
    target: f64,
) -> Result<(), String> {
    let _active = state.lifecycle.lock().await;
    if !current_matches(state, bvid, page) {
        return Err("B站播放会话已经变化".into());
    }
    let webview = app
        .get_webview(EMBED_WEBVIEW_LABEL)
        .ok_or_else(|| "B站播放器尚未创建".to_string())?;
    let result = evaluate_string(
        &webview,
        format!(r#"const video = document.querySelector("video"); if (!video) return "not-ready"; video.currentTime = {target}; return "ok";"#),
    )
    .await?;
    if result == "ok" {
        Ok(())
    } else {
        Err("B站官方播放器尚未就绪".into())
    }
}

#[tauri::command]
pub async fn bilibili_embed_close(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    state: tauri::State<'_, BilibiliEmbedState>,
    bvid: String,
    page: u32,
) -> Result<(), String> {
    require_main(&caller)?;
    if !valid_bvid(&bvid) || page >= 10_000 {
        return Err("B站视频编号无效".into());
    }
    let _active = state.lifecycle.lock().await;
    if !current_matches(&state, &bvid, page) {
        return Ok(());
    }
    if let Some(webview) = app.get_webview(EMBED_WEBVIEW_LABEL) {
        let _ = evaluate_string(
            &webview,
            "const video = document.querySelector(\"video\"); if (video) video.pause(); return \"ok\";".into(),
        )
        .await;
        webview
            .hide()
            .map_err(|error| format!("无法隐藏 B站播放器：{error}"))?;
    }
    let mut current = state
        .current
        .lock()
        .map_err(|_| "B站播放器状态不可用".to_string())?;
    *current = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_canonical_bvids_and_embed_navigation() {
        assert!(valid_bvid("BV1xx411c7mD"));
        assert!(!valid_bvid("av170001"));
        assert!(!valid_bvid("BV1xx411c7m/"));
        assert!(valid_embed_url(
            &tauri::Url::parse(
                "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&page=1&danmaku=0"
            )
            .unwrap()
        ));
        assert!(!valid_embed_url(
            &tauri::Url::parse("https://evil.example/player.html?bvid=BV1xx411c7mD&page=1")
                .unwrap()
        ));
        assert!(!valid_embed_url(
            &tauri::Url::parse("https://player.bilibili.com/player.html?bvid=bad&page=1").unwrap()
        ));
        assert!(!valid_embed_url(
            &tauri::Url::parse(
                "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&bvid=BV1xx411c7mE&page=1"
            )
            .unwrap()
        ));
    }

    #[test]
    fn validates_window_bounds() {
        assert!(valid_bounds(10.0, 20.0, 640.0, 360.0));
        assert!(!valid_bounds(-1.0, 20.0, 640.0, 360.0));
        assert!(!valid_bounds(10.0, 20.0, 199.0, 360.0));
        assert!(!valid_bounds(10.0, 20.0, f64::NAN, 360.0));
    }

    #[test]
    fn converts_kdj_zero_based_pages_to_the_official_one_based_query() {
        assert!(embed_url("BV1xx411c7mD", 2).contains("bvid=BV1xx411c7mD&page=3&"));
    }
}
