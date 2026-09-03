//! YouTube WebPO / player runners.
//!
//! - **macOS**: BotGuard binds the homepage challenge to a real network-created YouTube security
//!   origin. A local HTML string with a YouTube base URL looks correct to JavaScript but GVS
//!   rejects proofs minted from that synthetic document. We therefore navigate a non-persistent
//!   hidden WKWebView to YouTube's inert `robots.txt` document. Before navigation, all Tauri user
//!   scripts and the Wry IPC message handler are removed. The local proof bundle then installs a
//!   restrictive CSP before any further request; the realm receives no login cookies or upstream
//!   media URL.
//! - **Linux / Windows**: `youtube_proof_v8` mints via the `rustypipe-botguard` Deno/V8 library and
//!   runs player transforms in a bare `deno_core` isolate with DOM stubs. BotGuard stays out of
//!   the main Tauri renderer (SEC-005).

#[cfg(target_os = "macos")]
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(target_os = "macos")]
use tauri::Manager;

const PROOF_WINDOW_LABEL: &str = "youtube-proof-runtime";
const PROOF_DOCUMENT_URL: &str = "https://www.youtube.com/robots.txt";
const MAIN_WEBVIEW_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
                                       AppleWebKit/605.1.15 (KHTML, like Gecko) \
                                       Version/18.5 Safari/605.1.15";
pub(crate) const PROOF_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
                                AppleWebKit/537.36(KHTML, like Gecko)";
const PROOF_CSP: &str = "default-src 'none'; \
                         script-src 'unsafe-eval' https://www.google.com; \
                         connect-src https://www.youtube.com https://jnn-pa.googleapis.com; \
                         img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; \
                         object-src 'none'; frame-src 'none'; worker-src 'none'; \
                         base-uri 'none'; form-action 'none'";
const MAX_BUNDLE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_PLAYER_SCRIPT_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const PROOF_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct YoutubeProofState {
    /// Read guards are active native evaluations and may run concurrently. Window creation and
    /// realm replacement take the write guard, so a failed operation cannot tear down another
    /// request that is still in flight.
    #[cfg(target_os = "macos")]
    lifecycle: tokio::sync::RwLock<()>,
    /// Linux/Windows Deno/V8 BotGuard + player isolate (see `youtube_proof_v8`).
    #[cfg(all(not(target_os = "macos"), not(target_os = "android"), not(target_os = "ios")))]
    pub(crate) v8: crate::youtube_proof_v8::V8ProofState,
}

#[cfg(target_os = "macos")]
pub fn apply_main_webview_user_agent(window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2_foundation::NSString;
    use objc2_web_kit::WKWebView;

    window
        .with_webview(|webview| unsafe {
            let view: &WKWebView = &*webview.inner().cast();
            view.setCustomUserAgent(Some(&NSString::from_str(MAIN_WEBVIEW_USER_AGENT)));
        })
        .map_err(|error| format!("无法固定 YouTube 播放浏览器标识：{error}"))
}

#[cfg(not(target_os = "macos"))]
pub fn apply_main_webview_user_agent(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

pub(crate) fn valid_user_agent(value: &str) -> bool {
    value == PROOF_USER_AGENT
}

pub(crate) fn valid_binding(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4_096
        && value.is_ascii()
        && value.bytes().all(|byte| !byte.is_ascii_control())
}

pub(crate) fn valid_bundle(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_BUNDLE_BYTES
        && value.contains("__KDJ_YOUTUBE_NATIVE_PO__")
        && !value.contains('\0')
}

pub(crate) fn valid_proof_token(value: &str) -> bool {
    (20..=4_096).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'='))
}

pub(crate) fn valid_player_url(value: &str) -> bool {
    if value.is_empty() || value.len() > 4_096 || value.contains(['\r', '\n']) {
        return false;
    }
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = url.path();
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && (host == "youtube.com" || host.ends_with(".youtube.com"))
        && path.starts_with("/s/player/")
        && path.ends_with("/base.js")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

pub(crate) fn valid_n_value(value: &str) -> bool {
    (1..=512).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(crate) fn valid_googlevideo_url(value: &str) -> bool {
    if value.is_empty() || value.len() > 16 * 1024 || value.contains(['\r', '\n']) {
        return false;
    }
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && (host == "googlevideo.com" || host.ends_with(".googlevideo.com"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn proof_document_prelude() -> Result<String, String> {
    let document_url = serde_json::to_string(PROOF_DOCUMENT_URL)
        .map_err(|_| "YouTube proof 文档地址序列化失败".to_string())?;
    let policy = serde_json::to_string(PROOF_CSP)
        .map_err(|_| "YouTube proof 安全策略序列化失败".to_string())?;
    Ok(format!(
        r#"
const expectedDocumentUrl = {document_url};
const expectedPolicy = {policy};
if (location.href !== expectedDocumentUrl) {{
  throw new Error("YouTube proof 网络文档不匹配");
}}
if (
  globalThis.__TAURI_INTERNALS__ !== undefined
  || globalThis.ipc !== undefined
  || globalThis.webkit?.messageHandlers?.ipc !== undefined
) {{
  throw new Error("YouTube proof 原生隔离边界无效");
}}
let policyMeta = document.querySelector('meta[data-kdj-youtube-proof-csp="1"]');
if (policyMeta && policyMeta.content !== expectedPolicy) {{
  throw new Error("YouTube proof 安全策略被修改");
}}
if (!policyMeta) {{
  policyMeta = document.createElement("meta");
  policyMeta.httpEquiv = "Content-Security-Policy";
  policyMeta.content = expectedPolicy;
  policyMeta.dataset.kdjYoutubeProofCsp = "1";
  if (!document.head) throw new Error("YouTube proof 网络文档结构无效");
  document.head.prepend(policyMeta);
}}
document.body?.replaceChildren();
document.title = "KDJ YouTube proof runtime";
"#
    ))
}

#[cfg(target_os = "macos")]
async fn ensure_proof_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    use std::sync::atomic::{AtomicBool, Ordering};

    use objc2_foundation::{NSString, NSURLRequest, NSURL};
    use objc2_web_kit::{WKUserContentController, WKWebView};
    use tauri::{webview::PageLoadEvent, WebviewUrl, WebviewWindowBuilder};

    if let Some(window) = app.get_webview_window(PROOF_WINDOW_LABEL) {
        return Ok(window);
    }

    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let ready_tx = Arc::new(Mutex::new(Some(ready_tx)));
    let page_ready_tx = Arc::clone(&ready_tx);
    let navigation_locked = Arc::new(AtomicBool::new(false));
    let navigation_guard = Arc::clone(&navigation_locked);
    let window = WebviewWindowBuilder::new(
        app,
        PROOF_WINDOW_LABEL,
        WebviewUrl::App("__youtube_proof_blank__.html".into()),
    )
    .title("KDJ YouTube proof runtime")
    .visible(false)
    .skip_taskbar(true)
    .decorations(false)
    .resizable(false)
    .inner_size(1.0, 1.0)
    .incognito(true)
    .user_agent(PROOF_USER_AGENT)
    .on_navigation(move |url| {
        !navigation_guard.load(Ordering::SeqCst) || url.as_str() == PROOF_DOCUMENT_URL
    })
    .on_page_load(move |_window, payload| {
        if payload.event() != PageLoadEvent::Finished
            || payload.url().as_str() != PROOF_DOCUMENT_URL
        {
            return;
        }
        if let Ok(mut sender) = page_ready_tx.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(());
            }
        }
    })
    .build()
    .map_err(|error| format!("无法创建 YouTube proof 隔离窗口：{error}"))?;

    let locked = Arc::clone(&navigation_locked);
    window
        .with_webview(move |webview| unsafe {
            let view: &WKWebView = &*webview.inner().cast();
            let controller: &WKUserContentController = &*webview.controller().cast();
            // Removing both pieces is essential: a hidden remote-origin WebView must not inherit
            // the main app's invoke bridge, even if current capability rules would reject it.
            controller.removeAllUserScripts();
            controller.removeScriptMessageHandlerForName(&NSString::from_str("ipc"));
            locked.store(true, Ordering::SeqCst);
            let url = NSURL::URLWithString(&NSString::from_str(PROOF_DOCUMENT_URL))
                .expect("constant YouTube proof document URL is valid");
            let request = NSURLRequest::requestWithURL(&url);
            let _ = view.loadRequest(&request);
        })
        .map_err(|error| format!("无法初始化 YouTube proof 隔离窗口：{error}"))?;

    tokio::time::timeout(Duration::from_secs(10), ready_rx)
        .await
        .map_err(|_| "YouTube proof 隔离窗口启动超时".to_string())?
        .map_err(|_| "YouTube proof 隔离窗口启动状态丢失".to_string())?;
    Ok(window)
}

#[cfg(target_os = "macos")]
async fn active_proof_window<'a>(
    app: &tauri::AppHandle,
    state: &'a YoutubeProofState,
) -> Result<(tauri::WebviewWindow, tokio::sync::RwLockReadGuard<'a, ()>), String> {
    let active = state.lifecycle.read().await;
    if let Some(window) = app.get_webview_window(PROOF_WINDOW_LABEL) {
        return Ok((window, active));
    }
    drop(active);
    let exclusive = state.lifecycle.write().await;
    let window = match ensure_proof_window(app).await {
        Ok(window) => window,
        Err(error) => {
            if let Some(window) = app.get_webview_window(PROOF_WINDOW_LABEL) {
                let _ = window.destroy();
            }
            return Err(error);
        }
    };
    Ok((window, exclusive.downgrade()))
}

#[cfg(target_os = "macos")]
async fn replace_failed_realm(
    app: &tauri::AppHandle,
    active: tokio::sync::RwLockReadGuard<'_, ()>,
    state: &YoutubeProofState,
) {
    drop(active);
    let _exclusive = state.lifecycle.write().await;
    if let Some(window) = app.get_webview_window(PROOF_WINDOW_LABEL) {
        let _ = window.destroy();
    }
}

#[cfg(target_os = "macos")]
async fn evaluate_javascript(
    window: &tauri::WebviewWindow,
    javascript: String,
    failure: &'static str,
) -> Result<String, String> {
    use block2::RcBlock;
    use objc2::{runtime::AnyObject, MainThreadMarker};
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::{WKContentWorld, WKWebView};

    let (result_tx, result_rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let result_tx = Arc::new(Mutex::new(Some(result_tx)));
    let callback_tx = Arc::clone(&result_tx);
    window
        .with_webview(move |webview| unsafe {
            let view: &WKWebView = &*webview.inner().cast();
            let Some(main_thread) = MainThreadMarker::new() else {
                if let Ok(mut sender) = callback_tx.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(Err("YouTube proof 没有运行在窗口线程".into()));
                    }
                }
                return;
            };
            let world = WKContentWorld::pageWorld(main_thread);
            let handler = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                let result = if !error.is_null() || value.is_null() {
                    Err(failure.to_string())
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
        .map_err(|error| format!("无法进入 YouTube proof 窗口线程：{error}"))?;

    let raw = tokio::time::timeout(PROOF_TIMEOUT, result_rx)
        .await
        .map_err(|_| "YouTube proof 原生运算超时".to_string())?
        .map_err(|_| "YouTube proof 原生运算状态丢失".to_string())??;
    Ok(raw)
}

#[cfg(target_os = "macos")]
async fn evaluate_proof(
    window: &tauri::WebviewWindow,
    bundle: String,
    binding: String,
    force_fresh: bool,
) -> Result<String, String> {
    let prelude = proof_document_prelude()?;
    let bundle_json = serde_json::to_string(&bundle)
        .map_err(|_| "YouTube proof 本地代码序列化失败".to_string())?;
    let binding_json =
        serde_json::to_string(&binding).map_err(|_| "YouTube GVS 绑定值序列化失败".to_string())?;
    let javascript = format!(
        r#"
{prelude}
const source = {bundle_json};
if (!globalThis.__KDJ_YOUTUBE_NATIVE_PO__) (0, eval)(source);
const token = await globalThis.__KDJ_YOUTUBE_NATIVE_PO__.mint({binding_json}, {force_fresh});
return JSON.stringify({{ token }});
"#
    );
    let raw = evaluate_javascript(window, javascript, "YouTube proof 原生运算失败").await?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "YouTube proof 原生响应无效".to_string())?;
    let token = value
        .get("token")
        .and_then(serde_json::Value::as_str)
        .filter(|value| valid_proof_token(value))
        .ok_or_else(|| "YouTube proof 没有返回合法 GVS token".to_string())?;
    Ok(token.to_string())
}

#[tauri::command]
pub async fn youtube_mint_gvs_po_token(
    app: tauri::AppHandle,
    state: tauri::State<'_, YoutubeProofState>,
    bundle: String,
    binding: String,
    force_fresh: bool,
    user_agent: String,
) -> Result<String, String> {
    if !valid_bundle(&bundle) {
        return Err("YouTube proof 本地代码无效".into());
    }
    if !valid_binding(&binding) {
        return Err("YouTube GVS 绑定值无效".into());
    }
    if !valid_user_agent(&user_agent) {
        return Err("YouTube proof 浏览器标识不匹配".into());
    }

    #[cfg(target_os = "macos")]
    {
        let (window, active) = active_proof_window(&app, &state).await?;
        let result = evaluate_proof(&window, bundle, binding, force_fresh).await;
        return match result {
            Ok(token) => Ok(token),
            Err(error) => {
                // Do not try another proof implementation. Destroy the possibly modified realm;
                // this request fails visibly, and a later user action starts the same path cleanly.
                replace_failed_realm(&app, active, &state).await;
                Err(error)
            }
        };
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "android"), not(target_os = "ios")))]
    {
        let _ = app;
        crate::youtube_proof_v8::mint_gvs_po_token(
            &state.v8,
            bundle,
            binding,
            force_fresh,
            user_agent,
        )
        .await
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, bundle, binding, force_fresh, user_agent);
        Err("当前桌面系统没有可用的 YouTube 原生 proof 运行器".into())
    }
}

#[cfg(target_os = "macos")]
async fn evaluate_player(
    window: &tauri::WebviewWindow,
    bundle: String,
    player_url: String,
    javascript: String,
    operation: String,
    input: String,
) -> Result<String, String> {
    let prelude = proof_document_prelude()?;
    let bundle_json = serde_json::to_string(&bundle)
        .map_err(|_| "YouTube player 本地代码序列化失败".to_string())?;
    let player_url_json = serde_json::to_string(&player_url)
        .map_err(|_| "YouTube player 地址序列化失败".to_string())?;
    let player_javascript_json = serde_json::to_string(&javascript)
        .map_err(|_| "YouTube player 脚本序列化失败".to_string())?;
    let operation_json = serde_json::to_string(&operation)
        .map_err(|_| "YouTube player 操作序列化失败".to_string())?;
    let input_json =
        serde_json::to_string(&input).map_err(|_| "YouTube player 输入序列化失败".to_string())?;
    let source = format!(
        r#"
{prelude}
const source = {bundle_json};
if (!globalThis.__KDJ_YOUTUBE_NATIVE_PO__) (0, eval)(source);
const value = await globalThis.__KDJ_YOUTUBE_NATIVE_PO__.player(
  {operation_json}, {player_url_json}, {player_javascript_json}, {input_json}
);
return JSON.stringify({{ value }});
"#
    );
    let raw = evaluate_javascript(window, source, "YouTube player 原生运算失败").await?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "YouTube player 原生响应无效".to_string())?;
    value
        .get("value")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "YouTube player 没有返回结果".to_string())
}

#[tauri::command]
pub async fn youtube_run_player(
    app: tauri::AppHandle,
    state: tauri::State<'_, YoutubeProofState>,
    bundle: String,
    player_url: String,
    javascript: String,
    operation: String,
    value: String,
) -> Result<String, String> {
    if !valid_bundle(&bundle) {
        return Err("YouTube player 本地代码无效".into());
    }
    if !valid_player_url(&player_url)
        || javascript.is_empty()
        || javascript.len() > MAX_PLAYER_SCRIPT_BYTES
        || javascript.contains('\0')
    {
        return Err("YouTube player 脚本无效".into());
    }
    match operation.as_str() {
        "config" if value.is_empty() => {}
        "transform_n" if valid_n_value(&value) => {}
        "decipher"
            if !value.is_empty() && value.len() <= 16 * 1024 && !value.contains(['\r', '\n']) => {}
        _ => return Err("YouTube player 操作无效".into()),
    }

    #[cfg(target_os = "macos")]
    {
        let (window, active) = active_proof_window(&app, &state).await?;
        let result = evaluate_player(
            &window,
            bundle,
            player_url,
            javascript,
            operation.clone(),
            value,
        )
        .await;
        let validated = match result {
            Ok(output)
                if operation == "config"
                    && output
                        .parse::<u64>()
                        .is_ok_and(|value| (10_000..=100_000).contains(&value)) =>
            {
                Ok(output)
            }
            Ok(output) if operation == "transform_n" && valid_n_value(&output) => Ok(output),
            Ok(output) if operation == "decipher" && valid_googlevideo_url(&output) => Ok(output),
            Ok(_) => Err("YouTube player 返回结果无效".into()),
            Err(error) => Err(error),
        };
        return match validated {
            Ok(output) => Ok(output),
            Err(error) => {
                // A new official player script can change its runtime shape. Do not keep a realm
                // that may have been partially modified, and do not try another implementation.
                replace_failed_realm(&app, active, &state).await;
                Err(error)
            }
        };
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "android"), not(target_os = "ios")))]
    {
        let _ = app;
        crate::youtube_proof_v8::run_player(
            &state.v8,
            bundle,
            player_url,
            javascript,
            operation,
            value,
        )
        .await
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, bundle, player_url, javascript, operation, value);
        Err("当前桌面系统没有可用的 YouTube 原生 player 运行器".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_only_the_fixed_runtime_contract() {
        assert!(valid_user_agent(PROOF_USER_AGENT));
        assert!(!valid_user_agent("Mozilla/5.0 attacker"));
        assert!(valid_binding("aqz-KE-bpKQ"));
        assert!(!valid_binding(""));
        assert!(!valid_binding("bad\nvalue"));
        assert!(valid_bundle("/* __KDJ_YOUTUBE_NATIVE_PO__ */"));
        assert!(!valid_bundle("console.log('remote')"));
        assert!(valid_player_url(
            "https://www.youtube.com/s/player/abc/player_ias.vflset/en_US/base.js"
        ));
        assert!(!valid_player_url(
            "https://attacker.example/s/player/abc/base.js"
        ));
        assert!(valid_n_value("abc_DEF-123"));
        assert!(!valid_n_value("bad/value"));
        let prelude = proof_document_prelude().expect("proof prelude");
        assert!(prelude.contains(PROOF_DOCUMENT_URL));
        assert!(prelude.contains(PROOF_CSP));
        assert!(prelude.contains("__TAURI_INTERNALS__"));
    }

    #[test]
    fn validates_websafe_proof_without_logging_it() {
        assert!(valid_proof_token(&format!("{}-_=.0", "A".repeat(100))));
        assert!(!valid_proof_token("short"));
        assert!(!valid_proof_token(&format!("{}+", "A".repeat(100))));
    }
}
