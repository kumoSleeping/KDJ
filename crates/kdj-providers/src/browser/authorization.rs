//! Browser authorization uses existing opt-in CDP/Arc sessions or a temporary real-browser
//! login window. Gecko reads an existing profile only after explicit KDJ consent.
//! Never modify the user's browser profile or debugging preferences.

use super::login_trace::LoginTrace;
use crate::youtubemusic::auth::BrowserSession;
use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use kdj_core::models::Platform;
use serde::Serialize;
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tokio::{
    io::AsyncReadExt,
    net::TcpStream,
    time::{timeout, Instant},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Error as WebSocketError, Message},
    MaybeTlsStream, WebSocketStream,
};

#[cfg(target_os = "macos")]
#[path = "arc_automation.rs"]
mod arc_automation;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[path = "gecko_rdp.rs"]
mod gecko_rdp;
#[path = "process_ports.rs"]
mod process_ports;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[path = "isolated_login.rs"]
mod isolated_login;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const AUTH_TIMEOUT: Duration = Duration::from_secs(180);
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

#[derive(Debug, Clone, Serialize)]
pub struct BrowserAuthorizationOption {
    pub id: String,
    pub label: String,
    pub method: &'static str,
    pub profiles: Vec<super::BrowserProfileOption>,
}

struct Browser {
    label: String,
    root: PathBuf,
    executable: PathBuf,
    setup_url: &'static str,
}

/// This is an adapter capability, never evidence that a connection succeeded.
pub(crate) fn supports(id: &str) -> bool {
    setup_url(id).is_some()
}

fn setup_url(id: &str) -> Option<&'static str> {
    match id {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        "chrome" => Some("chrome://inspect/#remote-debugging"),
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        "edge" => Some("edge://inspect/#remote-debugging"),
        #[cfg(target_os = "macos")]
        "arc" => Some("arc://inspect/#remote-debugging"),
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        "firefox" | "zen" | "librewolf" => Some("about:debugging#/setup"),
        _ => None,
    }
}

fn installed_browser(id: &str) -> Option<Browser> {
    let installations = super::discovery::installed();
    // Accept old vendor ids for existing callers, but new UI selections identify the installation.
    let installation = installations
        .iter()
        .find(|browser| browser.id == id)
        .or_else(|| {
            installations
                .iter()
                .find(|browser| browser.adapter_id.as_deref() == Some(id))
        })?;
    browser_for_installation(installation)
}

fn browser_for_installation(installation: &super::discovery::InstalledBrowser) -> Option<Browser> {
    let id = installation.adapter_id.as_deref().unwrap_or("");
    let isolated = match installation.engine {
        Some(super::discovery::BrowserEngine::Gecko) => Some("kdj:isolated-gecko"),
        Some(super::discovery::BrowserEngine::Chromium) => Some("kdj:isolated-chromium"),
        None => None,
    };
    // Known Chrome/Edge installations attach on both operating systems. Unknown Chromium
    // forks keep the isolated fallback; a shared engine alone does not prove opt-in support.
    let setup_url = match installation.engine {
        Some(super::discovery::BrowserEngine::Gecko) => Some("kdj:gecko-toolbox"),
        _ => setup_url(id).or(isolated),
    }?;
    #[cfg(target_os = "macos")]
    let root = {
        let home = PathBuf::from(std::env::var_os("HOME")?);
        let folder = match id {
            "chrome" => "Google/Chrome",
            "edge" => "Microsoft Edge",
            "arc" => "Arc/User Data",
            "firefox" | "zen" | "librewolf" => "",
            _ => "",
        };
        home.join("Library/Application Support").join(folder)
    };
    #[cfg(target_os = "windows")]
    let root = {
        let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
        let folder = match id {
            "chrome" => "Google/Chrome",
            "edge" => "Microsoft/Edge",
            "firefox" | "zen" | "librewolf" => "",
            _ => "",
        };
        local.join(folder).join("User Data")
    };
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        Some(Browser {
            label: installation.label.clone(),
            root,
            executable: installation.executable.clone(),
            setup_url,
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = setup_url;
        None
    }
}

pub(super) fn catalog(
    installations: &[super::discovery::InstalledBrowser],
) -> Vec<BrowserAuthorizationOption> {
    installations
        .iter()
        .filter(|browser| browser.authorization_supported)
        .map(|browser| BrowserAuthorizationOption {
            id: browser.id.clone(),
            label: browser.label.clone(),
            profiles: {
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                { if browser.engine == Some(super::discovery::BrowserEngine::Gecko) {
                    super::gecko_profiles::options(browser)
                } else { Vec::new() } }
                #[cfg(any(target_os = "android", target_os = "ios"))]
                { Vec::new() }
            },
            method: if browser.engine == Some(super::discovery::BrowserEngine::Gecko) {
                "gecko_rdp"
            } else if cfg!(target_os = "macos") && browser.adapter_id.as_deref() == Some("arc") {
                "system_automation"
            } else if browser_for_installation(browser).is_some_and(|b| matches!(b.setup_url, "kdj:isolated-gecko" | "kdj:isolated-chromium")) {
                "isolated_window"
            } else {
                "remote_debugging"
            },
        })
        .collect()
}

impl Browser {
    fn use_isolated(&mut self) {
        self.setup_url = if self.setup_url == "kdj:gecko-toolbox" { "kdj:isolated-gecko" } else { "kdj:isolated-chromium" };
    }
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

    async fn open_setup(&self) -> Result<()> {
        self.open_url(self.setup_url).await
    }

    async fn open_url(&self, url: &str) -> Result<()> {
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = tokio::process::Command::new("/usr/bin/open");
            command.arg("-a").arg(&self.executable).arg(url);
            command
        };
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = tokio::process::Command::new(&self.executable);
            command.arg(url);
            command
        };
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            command
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            let mut child = command.spawn().context("无法打开浏览器授权页")?;
            // Chrome can stay alive if this is its first process. Reap it without blocking login.
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            Ok(())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        bail!("当前系统不支持浏览器授权连接")
    }

    async fn endpoint(&self) -> Result<Option<String>> {
        let file = match tokio::fs::File::open(self.root.join("DevToolsActivePort")).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => bail!("无法读取浏览器授权状态"),
        };
        let mut data = String::new();
        file.take(4097)
            .read_to_string(&mut data)
            .await
            .context("无法读取浏览器授权状态")?;
        Ok(Some(parse_endpoint(&data)?))
    }

    #[cfg(target_os = "windows")]
    fn has_window(&self) -> bool {
        use std::ffi::c_void;
        struct Search<'a> { browser: &'a Browser, found: bool }
        #[link(name = "user32")]
        unsafe extern "system" {
            fn EnumWindows(callback: unsafe extern "system" fn(*mut c_void, isize) -> i32, data: isize) -> i32;
            fn IsWindowVisible(window: *mut c_void) -> i32;
            fn GetWindowThreadProcessId(window: *mut c_void, pid: *mut u32) -> u32;
        }
        unsafe extern "system" fn visit(window: *mut c_void, data: isize) -> i32 {
            let search = unsafe { &mut *(data as *mut Search<'_>) };
            let mut pid = 0;
            if unsafe { IsWindowVisible(window) } != 0 {
                unsafe { GetWindowThreadProcessId(window, &mut pid); }
                if search.browser.owns_process(pid) {
                    search.found = true;
                    return 0;
                }
            }
            1
        }
        let mut search = Search { browser: self, found: false };
        unsafe { EnumWindows(visit, &mut search as *mut Search<'_> as isize); }
        search.found
    }

    async fn wait_closed(&self) {
        #[cfg(target_os = "windows")]
        {
            let opened = Instant::now();
            let mut seen = false;
            loop {
                let visible = self.has_window();
                if visible { seen = true; }
                // Edge's background process can survive every browser window being closed.
                if !visible && (seen || opened.elapsed() > Duration::from_secs(10)) { return; }
                tokio::time::sleep(RETRY_INTERVAL).await;
            }
        }
        #[cfg(not(target_os = "windows"))]
        std::future::pending::<()>().await;
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
    anyhow::ensure!(text.len() <= 4096, "浏览器授权地址无效");
    let mut lines = text.lines();
    let port: u16 = lines
        .next()
        .unwrap_or_default()
        .trim()
        .parse()
        .context("浏览器授权端口无效")?;
    let path = lines.next().unwrap_or_default().trim();
    let suffix = path.strip_prefix("/devtools/browser/").unwrap_or_default();
    anyhow::ensure!(
        port != 0
            && !suffix.is_empty()
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && lines.all(|line| line.trim().is_empty()),
        "浏览器授权地址无效"
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
        // Chrome and Arc both default to port 9222 and retain their discovery file when disabled.
        // Approval-mode Chromium ignores the UUID in that file. Verify the browser process before
        // asking for any tabs/cookies so a stale file can never import another browser's account.
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
            "连接端口属于其他浏览器或无法核实；请关闭其他浏览器的远程调试，再在 {} 中重新开启。",
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
                    Message::Close(_) => bail!("浏览器已结束授权连接"),
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
    trace: &LoginTrace,
    profile: Option<&str>,
    confirmed: bool,
    new_window: bool,
    mut finish: F,
) -> Result<T>
where F: FnMut(AuthorizedSession) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    // One explicit user action owns one connection/prompt. Don't stack browser permission dialogs.
    let _active = ACTIVE.try_lock().context("已有浏览器授权正在进行")?;
    if let Some((cookies, source)) = read_confirmed_gecko(browser_id, profile, confirmed, LoginSite::Soundcloud, trace).await? {
        let mut session = cookie_from_response(&cookies)?;
        session.imported_from = source;
        return finish(session).await;
    }
    let mut browser = installed_browser(browser_id).context("请选择支持授权连接的已安装浏览器")?;
    if new_window { browser.use_isolated(); }
    trace.browser(&browser.label);
    // Arc exposes Chromium's opt-in page but rejects the approval handshake without a dialog.
    // Its supported macOS automation interface has a separate, visible system permission.
    #[cfg(target_os = "macos")]
    if browser.setup_url == "arc://inspect/#remote-debugging" {
        return finish(arc_automation::read_soundcloud(&browser.executable, trace).await?).await;
    }
    read_authorized(&browser, LoginSite::Soundcloud, trace, |cookies, _| {
        let session = cookie_from_response(&cookies).map(|mut session| {
            session.imported_from = format!("{} · 浏览器授权", browser.label);
            session
        });
        let future = session.map(&mut finish);
        async move { future?.await }
    }).await
}

pub async fn read_youtube<T, F, Fut>(
    browser_id: &str,
    platform: Platform,
    trace: &LoginTrace,
    profile: Option<&str>,
    confirmed: bool,
    new_window: bool,
    mut finish: F,
) -> Result<T>
where F: FnMut(BrowserSession) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    let site = match platform {
        Platform::Ytm => LoginSite::Ytm,
        Platform::Youtube => LoginSite::Youtube,
        _ => bail!("不支持的登录站点"),
    };
    let _active = ACTIVE.try_lock().context("已有浏览器授权正在进行")?;
    if let Some((cookies, source)) = read_confirmed_gecko(browser_id, profile, confirmed, site, trace).await? {
        return finish(youtube_session(&cookies, &Value::Null, source, site)?).await;
    }
    let mut browser = installed_browser(browser_id).context("请选择支持授权登录的已安装浏览器")?;
    if new_window { browser.use_isolated(); }
    trace.browser(&browser.label);
    #[cfg(target_os = "macos")]
    if browser.setup_url == "arc://inspect/#remote-debugging" {
        return finish(arc_automation::read_youtube(&browser.executable, site, trace).await?).await;
    }
    read_authorized(&browser, site, trace, |cookies, metadata| {
        let session = youtube_session(&cookies, &metadata,
            format!("{} · 浏览器授权", browser.label), site);
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

// Rediscover the exact installation on every request. A consent flag never turns an arbitrary
// renderer path/browser id into a cookie database, nor silently falls back to a new window.
async fn read_confirmed_gecko(browser_id: &str, profile: Option<&str>, confirmed: bool, site: LoginSite, trace: &LoginTrace) -> Result<Option<(Value, String)>> {
    if !confirmed && profile.is_none() { return Ok(None); }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let installation = super::discovery::installed().into_iter()
            .find(|b| b.id == browser_id || b.adapter_id.as_deref() == Some(browser_id))
            .context("所选浏览器已不可用，请重新检测")?;
        if installation.engine != Some(super::discovery::BrowserEngine::Gecko) { return Ok(None); }
        anyhow::ensure!(confirmed, "请先允许 KDJ 读取所选浏览器的站点登录状态");
        trace.browser(&installation.label);
        trace.step("read_profile");
        let profile = profile.map(str::to_owned);
        let domain = if site == LoginSite::Soundcloud { "soundcloud.com" } else { "youtube.com" };
        let imported = tokio::task::spawn_blocking(move || {
            super::gecko_profiles::read(&installation, profile.as_deref(), confirmed, vec![domain.into()])
        }).await.context("读取浏览器登录状态任务失败")??;
        let cookies: Vec<_> = imported.cookies.into_iter()
            .filter(|c| c.path == "/" && if site == LoginSite::Soundcloud { c.name == "oauth_token" } else { youtube_cookie_name(&c.name) })
            .map(|c| json!({"name": c.name, "value": c.value, "domain": c.domain, "path": c.path, "expires": c.expires.unwrap_or(0)}))
            .collect();
        Ok(Some((json!({"cookies": cookies}), imported.imported_from)))
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    { let _ = (browser_id, profile, confirmed, site, trace); Ok(None) }
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
async fn read_authorized<T, F, Fut>(browser: &Browser, site: LoginSite, trace: &LoginTrace, finish: F) -> Result<T>
where F: FnMut(Value, Value) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    if browser.setup_url == "kdj:gecko-toolbox" {
        gecko_rdp::read(browser, site, trace, finish).await
    } else if browser.setup_url == "kdj:isolated-gecko" {
        isolated_login::read(browser, site, true, trace, finish).await
    } else if browser.setup_url == "kdj:isolated-chromium" {
        isolated_login::read(browser, site, false, trace, finish).await
    } else {
        read_cdp(browser, site, trace, finish).await
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
async fn read_authorized<T, F, Fut>(_browser: &Browser, _site: LoginSite, _trace: &LoginTrace, _finish: F) -> Result<T>
where F: FnMut(Value, Value) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    bail!("当前系统不支持浏览器授权")
}

async fn read_cdp<T, F, Fut>(
    browser: &Browser,
    site: LoginSite,
    trace: &LoginTrace,
    finish: F,
) -> Result<T>
where F: FnMut(Value, Value) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    // Every explicit retry must return the user to the opt-in page. The discovery file survives
    // disabling debugging/exiting the browser; its existence is not proof that the bridge is live.
    trace.step("open_authorization");
    browser.open_setup().await?;
    trace.step("wait_browser_permission");
    tokio::select! {
        biased;
        _ = browser.wait_closed() => {
            trace.detail("wait_browser_permission", "browser_closed");
            bail!("浏览器窗口已关闭或未能打开；本次授权已停止，可重新登录");
        }
        result = read_open_cdp(browser, site, trace, finish) => result,
    }
}

async fn read_open_cdp<T, F, Fut>(browser: &Browser, site: LoginSite, trace: &LoginTrace, finish: F) -> Result<T>
where F: FnMut(Value, Value) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    let mut connection = wait_for_connection(&browser, AUTH_TIMEOUT).await?;
    let result = async {
        trace.step("verify_browser");
        connection.verify_browser(browser).await?;
        if let Ok(version) = connection.call("Browser.getVersion", json!({}), None).await {
            // Version characters only; never log the arbitrary browser response or user agent.
            if let Some(product) = version["product"].as_str() {
                let version: String = product.chars().filter(|c| c.is_ascii_digit() || *c == '.').take(32).collect();
                tracing::info!(target: "kdj::login", browser = browser.label, browser_version = version, "login browser version");
            }
        }
        let mut target = None;
        let mut validator = CandidateValidator::new(finish);
        timeout(LOGIN_TIMEOUT, async {
            loop {
                let (cookies, metadata) = connection.site_cookies(site, trace, &mut target).await?;
                if let Some(value) = validator.check(cookies, metadata, site, trace).await? { return Ok(value); }
                trace.step("wait_browser_login");
                tokio::time::sleep(RETRY_INTERVAL).await;
            }
        }).await.context("等待站点登录超时，请重试")?
    }
    .await;
    // Explicitly disconnect on success AND failure; never close the browser or user's tabs.
    let _ = timeout(Duration::from_secs(2), connection.socket.close(None)).await;
    trace.detail(
        "disconnect",
        if result.is_ok() {
            "complete"
        } else {
            "after_failure"
        },
    );
    result
}

#[derive(Debug, PartialEq, Eq)]
enum HandshakeFailure {
    NotReady,
    Rejected,
    Http(u16),
    Protocol,
}

fn classify_handshake(error: &WebSocketError) -> HandshakeFailure {
    match error {
        WebSocketError::Http(response) => match response.status().as_u16() {
            403 => HandshakeFailure::Rejected,
            404 | 410 => HandshakeFailure::NotReady, // endpoint rotated while enabling
            status => HandshakeFailure::Http(status),
        },
        WebSocketError::Io(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionRefused
                    | std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::NotConnected
                    | std::io::ErrorKind::UnexpectedEof
            ) =>
        {
            HandshakeFailure::NotReady
        }
        _ => HandshakeFailure::Protocol,
    }
}

impl HandshakeFailure {
    fn message(&self, browser: &str) -> String {
        match self {
            Self::Rejected if browser == "Arc" => "Arc 拒绝了授权连接（403）。若没有出现确认弹窗，当前 Arc 无法完成此授权流程；可使用钥匙串读取。".into(),
            Self::Rejected => format!("{browser} 拒绝了本次连接（403）；再次点击连接可重新打开授权页。"),
            Self::Http(status) => format!("{browser} 连接失败（HTTP {status}）；可重新点击连接。"),
            Self::NotReady => format!("{browser} 的授权连接尚未就绪；请开启授权页中的远程调试后重试。"),
            Self::Protocol => format!("{browser} 的连接响应不兼容；请更新浏览器后重试。"),
        }
    }
}

async fn wait_for_connection(browser: &Browser, duration: Duration) -> Result<Connection> {
    let deadline = Instant::now() + duration;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        anyhow::ensure!(
            !remaining.is_zero(),
            "等待浏览器授权超时；开启远程调试后可重新点击连接。"
        );
        if let Some(endpoint) = browser.endpoint().await? {
            let config = WebSocketConfig::default()
                .max_message_size(Some(1024 * 1024))
                .max_frame_size(Some(1024 * 1024));
            match timeout(
                remaining,
                connect_async_with_config(&endpoint, Some(config), true),
            )
            .await
            {
                Ok(Ok((socket, _))) => return Ok(Connection { socket, next_id: 0 }),
                Ok(Err(error)) => {
                    let failure = classify_handshake(&error);
                    // An explicit browser refusal is final for this click. Do not spam permission
                    // requests, reinterpret a denial as a stale endpoint, or bypass browser policy.
                    if failure != HandshakeFailure::NotReady {
                        bail!("{}", failure.message(&browser.label));
                    }
                }
                Err(_) => bail!("等待浏览器确认超时；请重新点击连接，并在浏览器中允许本次连接。"),
            }
        }
        // Re-read discovery every time; enabling the switch can rotate the port AND socket path.
        tokio::time::sleep(RETRY_INTERVAL.min(deadline.saturating_duration_since(Instant::now())))
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn test_browser(root: PathBuf) -> Browser {
        Browser {
            label: "Test".into(),
            root,
            executable: PathBuf::new(),
            setup_url: "",
        }
    }

    #[tokio::test]
    async fn retries_stale_discovery_until_switch_publishes_new_endpoint() {
        let directory = tempfile::tempdir().unwrap();
        let stale = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stale_port = stale.local_addr().unwrap().port();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let path = directory.path().join("DevToolsActivePort");
        tokio::fs::write(&path, format!("{stale_port}\n/devtools/browser/old"))
            .await
            .unwrap();
        drop(stale);
        let server = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            tokio::fs::write(&path, format!("{port}\n/devtools/browser/new"))
                .await
                .unwrap();
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            assert!(matches!(
                socket.next().await.unwrap().unwrap(),
                Message::Close(_)
            ));
        });
        let mut connection = wait_for_connection(
            &test_browser(directory.path().into()),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
        connection.socket.close(None).await.unwrap();
        timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn rejection_is_reported_once_without_permission_retry_loop() {
        let directory = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::fs::write(
            directory.path().join("DevToolsActivePort"),
            format!("{port}\n/devtools/browser/denied"),
        )
        .await
        .unwrap();
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 19\r\n\r\nConnection rejected",
                )
                .await
                .unwrap();
            assert!(timeout(Duration::from_millis(600), listener.accept())
                .await
                .is_err());
        });
        let result = wait_for_connection(
            &test_browser(directory.path().into()),
            Duration::from_secs(3),
        )
        .await;
        assert!(result.err().unwrap().to_string().contains("403"));
        server.await.unwrap();
    }

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

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn existing_browser_routes_match_on_both_desktops() {
        for (id, engine, expected) in [
            ("chrome", super::super::discovery::BrowserEngine::Chromium, "chrome://inspect/#remote-debugging"),
            ("edge", super::super::discovery::BrowserEngine::Chromium, "edge://inspect/#remote-debugging"),
            ("firefox", super::super::discovery::BrowserEngine::Gecko, "kdj:gecko-toolbox"),
            ("zen", super::super::discovery::BrowserEngine::Gecko, "kdj:gecko-toolbox"),
        ] {
            let installation = super::super::discovery::InstalledBrowser {
                id: id.into(), label: id.into(), adapter_id: Some(id.into()),
                engine: Some(engine), executable: PathBuf::from("browser"),
                authorization_supported: true, direct_read_supported: true,
            };
            let mut browser = browser_for_installation(&installation).unwrap();
            assert_eq!(browser.setup_url, expected);
            let options = catalog(&[installation]);
            assert_eq!(options[0].method, if engine == super::super::discovery::BrowserEngine::Gecko { "gecko_rdp" } else { "remote_debugging" });
            browser.use_isolated();
            assert_eq!(browser.setup_url, if engine == super::super::discovery::BrowserEngine::Gecko { "kdj:isolated-gecko" } else { "kdj:isolated-chromium" });
        }
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

    #[tokio::test]
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[ignore = "explicitly selected existing Gecko profile; no browser launch, saving, or credential output"]
    async fn live_confirmed_gecko_youtube() {
        let id = std::env::var("KDJ_TEST_AUTHORIZATION_BROWSER").expect("select a browser");
        let browser = super::super::discovery::installed().into_iter()
            .find(|b| b.id == id || b.adapter_id.as_deref() == Some(&id)).expect("installed browser");
        let profiles = super::super::gecko_profiles::options(&browser);
        let profile = match std::env::var("KDJ_TEST_AUTHORIZATION_PROFILE") {
            Ok(id) => profiles.iter().find(|p| p.id == id).expect("selected profile"),
            Err(_) => { assert_eq!(profiles.len(), 1, "select a profile explicitly when there are several"); &profiles[0] }
        };
        let trace = LoginTrace::new("youtube", "profile_confirmation_test");
        assert!(read_youtube(&browser.id, Platform::Youtube, &trace, Some(&profile.id), false, false, |s| async { Ok(s) }).await.is_err());
        let mut session = read_youtube(&browser.id, Platform::Youtube, &trace, Some(&profile.id), true, false, |s| async { Ok(s) }).await
            .expect("confirmed profile read");
        session.validate().expect("valid YouTube session structure");
        assert!(session.imported_from.contains("KDJ 确认读取"));
    }

    #[tokio::test]
    #[ignore = "requires a running browser and explicit user approval; never prints credentials"]
    async fn live_browser_authorization() {
        let browser = std::env::var("KDJ_TEST_AUTHORIZATION_BROWSER")
            .expect("select the explicitly authorized browser");
        let trace = LoginTrace::new("soundcloud", "authorization_test");
        let session = trace
            .run(read_soundcloud(&browser, &trace, None, false, false, |s| async { Ok(s) }))
            .await
            .expect("browser authorization failed");
        assert!(!session.token.is_empty());
        eprintln!("SoundCloud session received through browser authorization (token omitted)");
    }
}
