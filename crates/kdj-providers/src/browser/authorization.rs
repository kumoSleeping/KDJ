//! Logins that are not a profile on disk: Arc's own macOS automation, which reads what the
//! SoundCloud / YouTube page itself can see in the browser the user already has open. Reading an
//! existing profile is `super::profile_cookies`. Never modify the user's browser profile or its
//! preferences, and never open a login window of KDJ's own.
#![cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]

use super::login_trace::LoginTrace;
use crate::youtubemusic::auth::BrowserSession;
use anyhow::{bail, Context, Result};
use kdj_core::models::Platform;
use serde_json::Value;

#[cfg(target_os = "macos")]
#[path = "arc_automation.rs"]
mod arc_automation;

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

// No Debug/Serialize: an access token must never enter logs or the renderer.
pub(crate) struct AuthorizedSession {
    pub token: String,
    pub expires_at: i64,
    pub imported_from: String,
}

pub(crate) async fn read_soundcloud<T, F, Fut>(
    browser_id: &str,
    trace: &LoginTrace,
    mut finish: F,
) -> Result<T>
where F: FnMut(AuthorizedSession) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    // One click owns one system prompt.
    let _active = ACTIVE.try_lock().context("已有浏览器登录正在进行")?;
    let arc = automated_browser(browser_id).context("这个浏览器的登录要从它的配置读取")?;
    trace.browser(&arc.label);
    #[cfg(target_os = "macos")]
    return finish(arc_automation::read_soundcloud(&arc.executable, trace).await?).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &mut finish;
        bail!("当前系统不支持此浏览器登录")
    }
}

pub async fn read_youtube<T, F, Fut>(
    browser_id: &str,
    platform: Platform,
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
    let arc = automated_browser(browser_id).context("这个浏览器的登录要从它的配置读取")?;
    trace.browser(&arc.label);
    #[cfg(target_os = "macos")]
    return finish(arc_automation::read_youtube(&arc.executable, site, trace).await?).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&mut finish, site);
        bail!("当前系统不支持此浏览器登录")
    }
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
