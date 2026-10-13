//! Logins that are not a profile on disk: Arc's own macOS automation, and a temporary window of
//! the chosen browser on a fresh profile that is removed afterwards. Reading an existing profile
//! is `super::profile_cookies`. Never modify the user's browser profile or its preferences.
#![cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]

use super::login_trace::LoginTrace;
use crate::youtubemusic::auth::BrowserSession;
use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use kdj_core::models::Platform;
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

#[cfg(target_os = "macos")]
#[path = "arc_automation.rs"]
mod arc_automation;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[path = "isolated_login.rs"]
mod isolated_login;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[path = "process_ports.rs"]
mod process_ports;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const RETRY_INTERVAL: Duration = Duration::from_millis(500);
static ACTIVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum LoginSite {
    Soundcloud,
    Youtube,
    Ytm,
}

impl LoginSite {
    pub(super) fn origin(self) -> &'static str {
        match self {
            Self::Soundcloud => "https://soundcloud.com",
            Self::Youtube => "https://www.youtube.com",
            Self::Ytm => "https://music.youtube.com",
        }
    }
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Soundcloud => "SoundCloud",
            Self::Youtube => "YouTube",
            Self::Ytm => "YouTube Music",
        }
    }
    fn matches(self, value: &str) -> bool {
        url::Url::parse(value).is_ok_and(|url| url.origin().ascii_serialization() == self.origin())
    }
}

struct Browser {
    label: String,
    /// The vendor it is known as, for the trace; an installation's label is the user's data.
    adapter: Option<String>,
    executable: PathBuf,
    gecko: bool,
}

/// A browser whose engine is known can show a login window on a fresh profile.
fn installed_browser(id: &str) -> Option<Browser> {
    let installations = super::discovery::installed();
    // The catalog hands out installation ids; the vendor id is what the tests select by.
    let installation = installations
        .iter()
        .find(|browser| browser.id == id)
        .or_else(|| {
            installations
                .iter()
                .find(|browser| browser.adapter_id.as_deref() == Some(id))
        })?;
    installation.window_supported.then(|| Browser {
        label: installation.label.clone(),
        adapter: installation.adapter_id.clone(),
        executable: installation.executable.clone(),
        gecko: installation.engine == Some(super::discovery::BrowserEngine::Gecko),
    })
}

/// Arc answers through its own macOS automation interface instead of a profile KDJ reads.
/// Its scripts read what the page itself can see, which is enough for SoundCloud and YouTube only.
pub(super) fn automated(installation: &super::discovery::InstalledBrowser) -> bool {
    cfg!(target_os = "macos") && installation.adapter_id.as_deref() == Some("arc")
}

fn automated_browser(id: &str) -> Option<super::discovery::InstalledBrowser> {
    super::discovery::installed()
        .into_iter()
        .find(|browser| browser.id == id && automated(browser))
}

/// Whether this browser's existing SoundCloud / YouTube login is read here, not from its profile.
pub fn reads_existing(id: &str) -> bool {
    automated_browser(id).is_some()
}

impl Browser {
    fn owns_process(&self, pid: u32) -> bool {
        let Some(actual) = process_executable(pid).and_then(|path| path.canonicalize().ok()) else {
            return false;
        };
        #[cfg(target_os = "macos")]
        {
            actual.starts_with(self.executable.join("Contents/MacOS"))
        }
        #[cfg(target_os = "windows")]
        {
            let Ok(expected) = self.executable.canonicalize() else {
                return false;
            };
            actual
                .to_string_lossy()
                .eq_ignore_ascii_case(&expected.to_string_lossy())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = actual;
            false
        }
    }
}

#[cfg(target_os = "macos")]
fn process_executable(pid: u32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let mut bytes = vec![0u8; 4096];
    // Read-only OS process identity; never inspect browser memory or open its credential store.
    let count = unsafe {
        libc::proc_pidpath(
            i32::try_from(pid).ok()?,
            bytes.as_mut_ptr().cast(),
            bytes.len() as u32,
        )
    };
    if count <= 0 {
        return None;
    }
    bytes.truncate(bytes.iter().position(|byte| *byte == 0)?);
    Some(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
}

#[cfg(target_os = "windows")]
fn process_executable(pid: u32) -> Option<PathBuf> {
    use std::{ffi::c_void, os::windows::ffi::OsStringExt};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(
            process: *mut c_void,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    let mut name = vec![0u16; 32768];
    let mut size = name.len() as u32;
    unsafe {
        let handle = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, pid);
        if handle.is_null() {
            return None;
        }
        let ok = QueryFullProcessImageNameW(handle, 0, name.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
    }
    Some(PathBuf::from(std::ffi::OsString::from_wide(
        &name[..size as usize],
    )))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn process_executable(_pid: u32) -> Option<PathBuf> {
    None
}

fn parse_endpoint(text: &str) -> Result<String> {
    anyhow::ensure!(text.len() <= 4096, "浏览器登录地址无效");
    let mut lines = text.lines();
    let port: u16 = lines
        .next()
        .unwrap_or_default()
        .trim()
        .parse()
        .context("浏览器登录端口无效")?;
    let path = lines.next().unwrap_or_default().trim();
    let suffix = path.strip_prefix("/devtools/browser/").unwrap_or_default();
    anyhow::ensure!(
        port != 0
            && !suffix.is_empty()
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && lines.all(|line| line.trim().is_empty()),
        "浏览器登录地址无效"
    );
    // The file cannot supply a host, scheme, credentials, query, or redirect.
    Ok(format!("ws://127.0.0.1:{port}{path}"))
}

struct Connection {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl Connection {
    async fn verify_browser(&mut self, browser: &Browser) -> Result<()> {
        // Verify the browser process before asking for any tabs or cookies, so the endpoint of
        // another browser can never import that browser's account.
        let info = self
            .call("SystemInfo.getProcessInfo", json!({}), None)
            .await?;
        let pid = info["processInfo"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|process| process["type"] == "browser")
            .and_then(|process| process["id"].as_u64())
            .and_then(|pid| u32::try_from(pid).ok());
        anyhow::ensure!(
            pid.is_some_and(|pid| browser.owns_process(pid)),
            "无法核实登录窗口属于 {}，请重试",
            browser.label
        );
        Ok(())
    }

    async fn call(&mut self, method: &str, params: Value, session: Option<&str>) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        let mut request = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            request["sessionId"] = session.into();
        }
        timeout(COMMAND_TIMEOUT, async {
            self.socket
                .send(Message::Text(request.to_string().into()))
                .await
                .context("浏览器连接已断开")?;
            while let Some(message) = self.socket.next().await {
                let message = message.context("浏览器连接已断开")?;
                match message {
                    Message::Text(text) => {
                        let response: Value =
                            serde_json::from_str(&text).context("浏览器返回了无效响应")?;
                        if response.get("id").and_then(Value::as_u64) != Some(id) {
                            continue;
                        }
                        // Never include the response/error body: it may contain session data.
                        anyhow::ensure!(
                            response.get("error").is_none(),
                            "浏览器拒绝了 {method}；请更新浏览器后重试"
                        );
                        return response
                            .get("result")
                            .cloned()
                            .context("浏览器没有返回结果");
                    }
                    Message::Ping(data) => {
                        self.socket
                            .send(Message::Pong(data))
                            .await
                            .context("浏览器连接已断开")?;
                    }
                    Message::Close(_) => bail!("浏览器已结束登录连接"),
                    _ => {}
                }
            }
            bail!("浏览器连接已断开")
        })
        .await
        .context("浏览器响应超时，请重试连接")?
    }

    async fn site_cookies(
        &mut self,
        site: LoginSite,
        trace: &LoginTrace,
        selected: &mut Option<String>,
    ) -> Result<(Value, Value)> {
        trace.step("select_page");
        let targets = self.call("Target.getTargets", json!({}), None).await?;
        let pages: Vec<&Value> = targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .context("浏览器没有返回标签页信息")?
            .iter()
            .filter(|target| {
                target["type"] == "page"
                    && target["url"].as_str().is_some_and(|url| site.matches(url))
            })
            .collect();
        let contexts: std::collections::HashSet<&str> = pages
            .iter()
            .map(|page| page["browserContextId"].as_str().unwrap_or_default())
            .collect();
        anyhow::ensure!(
            contexts.len() <= 1,
            "多个浏览器账号打开了 {}，请只在要登录的账号中保留该站点标签页后重试",
            site.label()
        );
        let target = if let Some(target) = selected.as_ref() {
            let page = targets["targetInfos"].as_array().into_iter().flatten()
                .find(|page| page["targetId"].as_str() == Some(target))
                .context("登录标签页已关闭")?;
            if !page["url"].as_str().is_some_and(|url| site.matches(url)) {
                return Ok((json!({"cookies":[]}), Value::Null));
            }
            target.clone()
        } else if let Some(page) = pages.first() {
            page["targetId"]
                .as_str()
                .context("登录标签页不可用")?
                .to_owned()
        } else {
            let page = self
                .call(
                    "Target.createTarget",
                    json!({"url": format!("{}/", site.origin())}),
                    None,
                )
                .await?;
            page["targetId"]
                .as_str()
                .context("无法打开登录标签页")?
                .to_owned()
        };
        *selected = Some(target.clone());
        let attached = self
            .call(
                "Target.attachToTarget",
                json!({"targetId": target, "flatten": true}),
                None,
            )
            .await?;
        let session_id = attached["sessionId"]
            .as_str()
            .context("无法连接登录标签页")?;
        trace.step("read_cookies");
        // This is deliberately URL-scoped. Do not replace it with Storage.getCookies or getAllCookies.
        let response = self
            .call(
                "Network.getCookies",
                json!({"urls": [format!("{}/", site.origin())]}),
                Some(session_id),
            )
            .await;
        // Only non-secret account selection metadata. Cookies use Network, including HttpOnly.
        let metadata = if site != LoginSite::Soundcloud && response.is_ok() {
            self.call("Runtime.evaluate", json!({
                "expression": format!("location.origin === '{}' ? ({{authUser: String(globalThis.ytcfg?.get?.('SESSION_INDEX') ?? ''), userAgent: navigator.userAgent}}) : null", site.origin()),
                "returnByValue": true,
            }), Some(session_id)).await.ok()
                .and_then(|v| v.pointer("/result/value").cloned()).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let _ = self
            .call(
                "Target.detachFromTarget",
                json!({"sessionId": session_id}),
                None,
            )
            .await;
        Ok((response?, metadata))
    }
}

#[cfg(test)]
fn is_soundcloud_url(value: &str) -> bool {
    LoginSite::Soundcloud.matches(value)
}

// No Debug/Serialize: an access token must never enter logs or the renderer.
pub(crate) struct AuthorizedSession {
    pub token: String,
    pub expires_at: i64,
    pub imported_from: String,
}

fn cookie_from_response(response: &Value) -> Result<AuthorizedSession> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as f64;
    let cookie = response["cookies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|cookie| {
            cookie["name"] == "oauth_token"
                && cookie["domain"]
                    .as_str()
                    .is_some_and(|domain| domain.trim_start_matches('.') == "soundcloud.com")
                && cookie["value"]
                    .as_str()
                    .is_some_and(|token| !token.trim().is_empty() && token.len() <= 4096)
                && cookie["expires"]
                    .as_f64()
                    .is_some_and(|expires| expires <= 0.0 || expires > now)
        })
        .max_by_key(|cookie| {
            (
                cookie["path"] == "/",
                cookie["expires"].as_i64().unwrap_or(0),
            )
        })
        .context("浏览器已连接，但 SoundCloud 尚未登录；请在该浏览器登录 SoundCloud 后重试")?;
    Ok(AuthorizedSession {
        token: cookie["value"].as_str().unwrap().to_owned(),
        expires_at: cookie["expires"].as_f64().unwrap_or(0.0).max(0.0) as i64,
        imported_from: String::new(),
    })
}


pub(crate) async fn read_soundcloud<T, F, Fut>(
    browser_id: &str,
    window: bool,
    trace: &LoginTrace,
    mut finish: F,
) -> Result<T>
where F: FnMut(AuthorizedSession) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    // One click owns one system prompt or one window.
    let _active = ACTIVE.try_lock().context("已有浏览器登录正在进行")?;
    if !window {
        let arc = automated_browser(browser_id).context("这个浏览器的登录要从它的配置读取")?;
        trace.browser(&arc.label);
        #[cfg(target_os = "macos")]
        return finish(arc_automation::read_soundcloud(&arc.executable, trace).await?).await;
        #[cfg(not(target_os = "macos"))]
        bail!("当前系统不支持此浏览器登录");
    }
    let browser = installed_browser(browser_id).context("这个浏览器不能打开登录窗口")?;
    trace.browser(browser.adapter.as_deref().unwrap_or("other"));
    open_window(&browser, LoginSite::Soundcloud, trace, |cookies, _| {
        let session = cookie_from_response(&cookies).map(|mut session| {
            session.imported_from = format!("{} · 新窗口", browser.label);
            session
        });
        let future = session.map(&mut finish);
        async move { future?.await }
    }).await
}

pub async fn read_youtube<T, F, Fut>(
    browser_id: &str,
    platform: Platform,
    window: bool,
    trace: &LoginTrace,
    mut finish: F,
) -> Result<T>
where F: FnMut(BrowserSession) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    let site = match platform {
        Platform::Ytm => LoginSite::Ytm,
        Platform::Youtube => LoginSite::Youtube,
        _ => bail!("不支持的登录站点"),
    };
    let _active = ACTIVE.try_lock().context("已有浏览器登录正在进行")?;
    if !window {
        let arc = automated_browser(browser_id).context("这个浏览器的登录要从它的配置读取")?;
        trace.browser(&arc.label);
        #[cfg(target_os = "macos")]
        return finish(arc_automation::read_youtube(&arc.executable, site, trace).await?).await;
        #[cfg(not(target_os = "macos"))]
        bail!("当前系统不支持此浏览器登录");
    }
    let browser = installed_browser(browser_id).context("这个浏览器不能打开登录窗口")?;
    trace.browser(browser.adapter.as_deref().unwrap_or("other"));
    open_window(&browser, site, trace, |cookies, metadata| {
        let session = youtube_session(&cookies, &metadata,
            format!("{} · 新窗口", browser.label), site);
        let future = session.map(&mut finish);
        async move { future?.await }
    }).await
}

// A candidate is not a completed login. Keep the browser alive while the provider validates it.
// Retry a small number of times for cookie-store/account-metadata propagation, never reconnect.
struct CandidateValidator<F> { finish: F, failures: u8 }
impl<F> CandidateValidator<F> {
    fn new(finish: F) -> Self { Self { finish, failures: 0 } }
    async fn check<T, Fut>(&mut self, cookies: Value, metadata: Value, site: LoginSite, trace: &LoginTrace) -> Result<Option<T>>
    where F: FnMut(Value, Value) -> Fut, Fut: std::future::Future<Output = Result<T>> {
        if !candidate_ready(&cookies, &metadata, site) { return Ok(None); }
        trace.step("validate_account");
        match (self.finish)(cookies, metadata).await {
            Ok(value) => Ok(Some(value)),
            Err(error) => {
                self.failures += 1;
                if self.failures >= 3 { return Err(error); }
                trace.detail("validate_account", "candidate_retry");
                tokio::time::sleep(Duration::from_secs(1)).await;
                Ok(None)
            }
        }
    }
}

fn candidate_ready(cookies: &Value, metadata: &Value, site: LoginSite) -> bool {
    if site == LoginSite::Soundcloud { cookie_from_response(cookies).is_ok() }
    else { metadata["authUser"].as_str().is_some_and(|s| !s.is_empty() && s.len() <= 3 && s.bytes().all(|b| b.is_ascii_digit())) && youtube_session(cookies, metadata, String::new(), site).is_ok() }
}

fn youtube_session(
    cookies: &Value,
    metadata: &Value,
    source: String,
    site: LoginSite,
) -> Result<BrowserSession> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as f64;
    let host = site.origin().trim_start_matches("https://");
    let mut values = std::collections::BTreeMap::new();
    for cookie in cookies["cookies"].as_array().into_iter().flatten() {
        let Some(domain) = cookie["domain"].as_str().map(|v| v.trim_start_matches('.')) else {
            continue;
        };
        if domain != "youtube.com" && domain != host {
            continue;
        }
        if !cookie["expires"]
            .as_f64()
            .is_some_and(|v| v <= 0.0 || v > now)
        {
            continue;
        }
        let (Some(name), Some(value)) = (cookie["name"].as_str(), cookie["value"].as_str()) else {
            continue;
        };
        if !youtube_cookie_name(name) {
            continue;
        }
        anyhow::ensure!(
            !value.contains(['\r', '\n', ';']) && value.len() <= 16384,
            "浏览器返回的 YouTube 登录状态无效"
        );
        if let Some(previous) = values.insert(name, value) {
            anyhow::ensure!(
                previous == value,
                "当前页面存在多个 YouTube 登录状态，请重新登录浏览器后重试"
            );
        }
    }
    let header = values
        .into_iter()
        .map(|(n, v)| format!("{n}={v}"))
        .collect::<Vec<_>>()
        .join("; ");
    let mut session = BrowserSession::from_cookie_header(&header, source)?;
    apply_youtube_metadata(&mut session, metadata);
    Ok(session)
}

pub(super) const YOUTUBE_COOKIE_NAMES: &[&str] = &[
    "SAPISID",
    "APISID",
    "SID",
    "HSID",
    "SSID",
    "SIDCC",
    "LOGIN_INFO",
    "__Secure-1PAPISID",
    "__Secure-3PAPISID",
    "__Secure-1PSID",
    "__Secure-3PSID",
    "__Secure-1PSIDTS",
    "__Secure-3PSIDTS",
    "__Secure-1PSIDCC",
    "__Secure-3PSIDCC",
    "PREF",
    "VISITOR_INFO1_LIVE",
    "VISITOR_PRIVACY_METADATA",
    "YSC",
    "CONSENT",
    "SOCS",
];

pub(super) fn youtube_cookie_name(name: &str) -> bool {
    YOUTUBE_COOKIE_NAMES.contains(&name)
}

pub(super) fn apply_youtube_metadata(session: &mut BrowserSession, metadata: &Value) {
    if let Some(user) = metadata["authUser"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 3 && s.bytes().all(|b| b.is_ascii_digit()))
    {
        session.x_goog_authuser = user.to_string();
    }
    if let Some(agent) = metadata["userAgent"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 2048 && !s.chars().any(char::is_control))
    {
        session.user_agent = agent.to_string();
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn open_window<T, F, Fut>(browser: &Browser, site: LoginSite, trace: &LoginTrace, finish: F) -> Result<T>
where F: FnMut(Value, Value) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    isolated_login::read(browser, site, browser.gecko, trace, finish).await
}

#[cfg(any(target_os = "android", target_os = "ios"))]
async fn open_window<T, F, Fut>(_browser: &Browser, _site: LoginSite, _trace: &LoginTrace, _finish: F) -> Result<T>
where F: FnMut(Value, Value) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    bail!("当前系统不支持浏览器登录窗口")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn process_identity_is_checked_without_reading_credentials() {
        assert_eq!(
            process_executable(std::process::id()).unwrap(),
            std::env::current_exe().unwrap()
        );
        assert!(process_executable(u32::MAX).is_none());
    }

    #[test]
    fn discovery_file_cannot_redirect_connection() {
        assert_eq!(
            parse_endpoint("12345\n/devtools/browser/abc-123\n").unwrap(),
            "ws://127.0.0.1:12345/devtools/browser/abc-123"
        );
        for value in [
            "0\n/devtools/browser/abc",
            "65536\n/devtools/browser/abc",
            "80\n//evil.com",
            "80\n/devtools/browser/../abc",
            "80\n/devtools/browser/abc?x=secret",
            "80\n/devtools/browser/abc\nextra",
        ] {
            assert!(parse_endpoint(value).is_err());
        }
    }

    #[test]
    fn reads_only_the_soundcloud_login_cookie() {
        let response = json!({"cookies": [
            {"name":"oauth_token", "domain":"evil-soundcloud.com", "value":"wrong-site", "expires":-1},
            {"name":"oauth_token", "domain":".soundcloud.com", "value":"expired", "expires":1},
            {"name":"other", "domain":".soundcloud.com", "value":"wrong-cookie", "expires":-1},
            {"name":"oauth_token", "domain":".soundcloud.com", "value":"test-only", "expires":-1, "path":"/"}
        ]});
        assert_eq!(cookie_from_response(&response).unwrap().token, "test-only");
        assert!(cookie_from_response(&json!({"cookies":[]})).is_err());
        assert!(is_soundcloud_url("https://soundcloud.com/you/likes"));
        for url in [
            "http://soundcloud.com",
            "https://soundcloud.com.evil.test",
            "https://soundcloud.com@evil.test",
        ] {
            assert!(!is_soundcloud_url(url));
        }
    }

    #[test]
    fn youtube_import_filters_site_expiry_and_ambiguity_and_preserves_account_index() {
        let cookies = json!({"cookies": [
            {"name":"SAPISID", "value":"test-only", "domain":".youtube.com", "expires":-1, "httpOnly":true},
            {"name":"SID", "value":"wrong-origin", "domain":".google.com", "expires":-1},
            {"name":"HSID", "value":"expired", "domain":".youtube.com", "expires":1},
            {"name":"unrelated", "value":"ignored", "domain":".youtube.com", "expires":-1},
            {"name":"SID", "value":"video-only", "domain":"www.youtube.com", "expires":-1}
        ]});
        let session = youtube_session(
            &cookies,
            &json!({"authUser":"2", "userAgent":"Test"}),
            "test".into(),
            LoginSite::Ytm,
        )
        .unwrap();
        assert_eq!(session.cookie, "SAPISID=test-only");
        assert_eq!(session.x_goog_authuser, "2");
        let mut duplicated = cookies;
        duplicated["cookies"].as_array_mut().unwrap().push(json!({"name":"SAPISID", "value":"different", "domain":"music.youtube.com", "expires":-1}));
        assert!(youtube_session(&duplicated, &Value::Null, "test".into(), LoginSite::Ytm).is_err());
        assert!(!LoginSite::Ytm.matches("https://music.youtube.com.evil.test/"));
        assert!(!LoginSite::Youtube.matches("https://music.youtube.com/"));
    }

    #[tokio::test]
    async fn candidate_waits_for_metadata_and_retries_before_returning_verified_session() {
        let cookies = json!({"cookies":[{"name":"SAPISID","value":"test-only","domain":".youtube.com","expires":-1}]});
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let mut validator = CandidateValidator::new(move |_, _| {
            let call = count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move { if call == 0 { bail!("candidate not yet usable"); } Ok("verified") }
        });
        let trace = LoginTrace::new("youtube", "test");
        assert!(validator.check(cookies.clone(), json!({"authUser":""}), LoginSite::Youtube, &trace).await.unwrap().is_none());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(validator.check(cookies.clone(), json!({"authUser":"2"}), LoginSite::Youtube, &trace).await.unwrap().is_none());
        assert_eq!(validator.check(cookies, json!({"authUser":"2"}), LoginSite::Youtube, &trace).await.unwrap(), Some("verified"));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalid_candidates_have_a_bounded_validation_budget() {
        let mut validator = CandidateValidator::new(|_, _| async { Err::<(), _>(anyhow::anyhow!("invalid account")) });
        let trace = LoginTrace::new("soundcloud", "test");
        for attempt in 1..=3 {
            let result = validator.check(json!({"cookies":[{"name":"oauth_token","value":"test-only","domain":".soundcloud.com","expires":-1}]}), Value::Null, LoginSite::Soundcloud, &trace).await;
            assert_eq!(result.is_err(), attempt == 3);
        }
    }

    #[tokio::test]
    async fn pinned_cdp_target_waits_through_redirect_instead_of_switching_accounts() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let request = socket.next().await.unwrap().unwrap();
            let request: Value = serde_json::from_str(request.to_text().unwrap()).unwrap();
            assert_eq!(request["method"], "Target.getTargets");
            socket.send(Message::Text(json!({"id":request["id"], "result":{"targetInfos":[
                {"type":"page","targetId":"selected","url":"https://accounts.google.com/"},
                {"type":"page","targetId":"other","url":"https://www.youtube.com/"}
            ]}}).to_string().into())).await.unwrap();
            assert!(matches!(socket.next().await.unwrap().unwrap(), Message::Close(_)));
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}")).await.unwrap();
        let mut connection = Connection { socket, next_id: 0 };
        let mut selected = Some("selected".into());
        let (cookies, metadata) = connection.site_cookies(LoginSite::Youtube, &LoginTrace::new("youtube", "test"), &mut selected).await.unwrap();
        assert!(!candidate_ready(&cookies, &metadata, LoginSite::Youtube));
        assert_eq!(selected.as_deref(), Some("selected"));
        connection.socket.close(None).await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn authorized_youtube_queries_only_selected_site_and_detaches() {
        for site in [LoginSite::Youtube, LoginSite::Ytm] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                for (method, response) in [
                    (
                        "Target.getTargets",
                        json!({"targetInfos":[{"type":"page", "url":format!("{}/",site.origin()), "targetId":"site", "browserContextId":"profile"}]}),
                    ),
                    ("Target.attachToTarget", json!({"sessionId":"test-session"})),
                    (
                        "Network.getCookies",
                        json!({"cookies":[{"name":"SAPISID", "domain":".youtube.com", "expires":-1,"value":"test-only", "httpOnly":true}]}),
                    ),
                    (
                        "Runtime.evaluate",
                        json!({"result":{"value":{"authUser":"1"}}}),
                    ),
                    ("Target.detachFromTarget", json!({})),
                ] {
                    let request = socket.next().await.unwrap().unwrap();
                    let request: Value = serde_json::from_str(request.to_text().unwrap()).unwrap();
                    assert_eq!(request["method"], method);
                    if method == "Network.getCookies" {
                        assert_eq!(
                            request["params"]["urls"],
                            json!([format!("{}/", site.origin())])
                        );
                    }
                    socket
                        .send(Message::Text(
                            json!({"id": request["id"], "result":response})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
            });
            let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
                .await
                .unwrap();
            let mut connection = Connection { socket, next_id: 0 };
            let trace = LoginTrace::new("test", "authorize");
            let (cookies, metadata) = trace
                .run(connection.site_cookies(site, &trace, &mut None))
                .await
                .unwrap();
            assert_eq!(
                youtube_session(&cookies, &metadata, "test".into(), site)
                    .unwrap()
                    .x_goog_authuser,
                "1"
            );
            server.await.unwrap();
        }
    }
}
