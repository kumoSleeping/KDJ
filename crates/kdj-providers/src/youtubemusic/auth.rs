//! YouTube / YouTube Music 浏览器会话认证；两种来源分别实例化、分别落盘。
//!
//! 社区客户端（ytmusicapi、YouTube.js、yt-dlp）现在普遍复用已经登录的
//! youtube.com Cookie，而不是申请 Google OAuth client。请求 InnerTube 时从
//! SAPISID 类 Cookie 动态生成 `SAPISIDHASH`；KDJ 不接触 Google 密码，也不把
//! Cookie 暴露给 settings.json 或 WebView 的普通读取接口。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

pub use crate::browser::BrowserCatalog;
use kdj_core::models::Platform;

use crate::provider::ProviderContext;

const YTM_SESSION_FILE: &str = "youtube-music-browser.json";
const YOUTUBE_SESSION_FILE: &str = "youtube-video-browser.json";

const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
                                  AppleWebKit/537.36 (KHTML, like Gecko) \
                                  Chrome/131.0.0.0 Safari/537.36";
const MAX_HEADERS_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrowserSession {
    pub cookie: String,
    #[serde(default = "default_auth_user")]
    pub x_goog_authuser: String,
    #[serde(default = "default_user_agent")]
    pub user_agent: String,
    #[serde(default)]
    pub visitor_data: String,
    #[serde(default)]
    pub imported_from: String,
    #[serde(default)]
    pub created_at: i64,
}

fn default_auth_user() -> String {
    "0".into()
}

fn default_user_agent() -> String {
    DEFAULT_USER_AGENT.into()
}

impl BrowserSession {
    /// WebView / 原生 cookie manager 读到的 Cookie 头；不经过前端。
    pub fn from_cookie_header(cookie: &str, imported_from: impl Into<String>) -> Result<Self> {
        let mut session = BrowserSession {
            cookie: normalize_cookie(cookie),
            x_goog_authuser: default_auth_user(),
            user_agent: default_user_agent(),
            visitor_data: String::new(),
            imported_from: imported_from.into(),
            created_at: unix_now(),
        };
        session.validate()?;
        Ok(session)
    }

    pub fn from_headers(raw: &str) -> Result<Self> {
        let raw = raw.trim();
        anyhow::ensure!(!raw.is_empty(), "请粘贴 YouTube 请求头");
        anyhow::ensure!(
            raw.len() <= MAX_HEADERS_BYTES,
            "请求头内容过大，请只粘贴对应 YouTube 站点的请求头"
        );

        let headers = parse_headers(raw)?;
        let cookie = headers
            .get("cookie")
            .cloned()
            .or_else(|| looks_like_cookie(raw).then(|| raw.to_string()))
            .unwrap_or_default();
        let mut session = BrowserSession {
            cookie: normalize_cookie(&cookie),
            x_goog_authuser: headers
                .get("x-goog-authuser")
                .cloned()
                .unwrap_or_else(default_auth_user),
            user_agent: headers
                .get("user-agent")
                .cloned()
                .unwrap_or_else(default_user_agent),
            visitor_data: headers
                .get("x-goog-visitor-id")
                .cloned()
                .unwrap_or_default(),
            imported_from: "粘贴的浏览器请求头".into(),
            created_at: unix_now(),
        };
        session.validate()?;
        Ok(session)
    }

    pub fn validate(&mut self) -> Result<()> {
        self.cookie = normalize_cookie(&self.cookie);
        self.x_goog_authuser = self.x_goog_authuser.trim().to_string();
        if self.x_goog_authuser.is_empty() {
            self.x_goog_authuser = default_auth_user();
        }
        self.user_agent = self.user_agent.trim().to_string();
        if self.user_agent.is_empty() {
            self.user_agent = default_user_agent();
        }
        anyhow::ensure!(
            !self.cookie.contains(['\r', '\n']) && !self.user_agent.contains(['\r', '\n']),
            "请求头包含非法换行"
        );
        let cookies = cookie_map(&self.cookie);
        anyhow::ensure!(
            cookies.contains_key("SAPISID")
                || cookies.contains_key("__Secure-3PAPISID")
                || cookies.contains_key("__Secure-1PAPISID"),
            "没有找到 SAPISID 登录 Cookie；请从已登录的 YouTube 站点复制 browse 请求头"
        );
        Ok(())
    }

    pub fn sid(&self) -> Option<String> {
        let cookies = cookie_map(&self.cookie);
        cookies
            .get("SAPISID")
            .or_else(|| cookies.get("__Secure-3PAPISID"))
            .or_else(|| cookies.get("__Secure-1PAPISID"))
            .cloned()
    }

    pub fn authorization(&self, origin: &str) -> Option<String> {
        let sid = self.sid()?;
        let timestamp = unix_now();
        let digest = Sha1::digest(format!("{timestamp} {sid} {origin}").as_bytes());
        Some(format!("SAPISIDHASH {timestamp}_{}", hex::encode(digest)))
    }

    pub fn request_headers(&self, origin: &str) -> Vec<(String, String)> {
        let mut headers = vec![
            ("Cookie".into(), self.cookie.clone()),
            ("X-Goog-AuthUser".into(), self.x_goog_authuser.clone()),
            ("Origin".into(), origin.to_string()),
            ("X-Origin".into(), origin.to_string()),
            ("User-Agent".into(), self.user_agent.clone()),
        ];
        if let Some(authorization) = self.authorization(origin) {
            headers.push(("Authorization".into(), authorization));
        }
        if !self.visitor_data.is_empty() {
            headers.push(("X-Goog-Visitor-Id".into(), self.visitor_data.clone()));
        }
        headers
    }
}

/// 单个平台独占的一份浏览器会话。YouTube Music 与 YouTube 视频即使来源于
/// 同一个浏览器 Profile，也分别落盘、登录和退出，不能互相改变账号状态。
pub struct YoutubeAuth {
    platform: Platform,
    path: PathBuf,
    session: RwLock<Option<BrowserSession>>,
}

impl YoutubeAuth {
    pub fn new(ctx: &ProviderContext, platform: Platform) -> Result<Self> {
        let file = match platform {
            Platform::Ytm => YTM_SESSION_FILE,
            Platform::Youtube => YOUTUBE_SESSION_FILE,
            _ => anyhow::bail!("YouTubeAuth 只支持 YouTube Music 或 YouTube 视频"),
        };
        let path = ctx.session_file(file);
        if let Some(parent) = path.parent() {
            crate::session_fs::ensure_private_dir(parent)?;
        }
        crate::session_fs::protect_existing_private_file(&path)?;
        let session =
            std::fs::read_to_string(&path).ok().and_then(|text| {
                match serde_json::from_str::<BrowserSession>(&text) {
                    Ok(mut session) => match session.validate() {
                        Ok(()) => Some(session),
                        Err(err) => {
                            tracing::warn!("YouTube 浏览器会话已失效：{err}");
                            None
                        }
                    },
                    Err(err) => {
                        tracing::warn!("解析 YouTube 浏览器会话失败：{err}");
                        None
                    }
                }
            });
        Ok(Self {
            platform,
            path,
            session: RwLock::new(session),
        })
    }

    pub fn snapshot(&self) -> Option<BrowserSession> {
        self.session
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn is_logged_in(&self) -> bool {
        self.snapshot().is_some()
    }

    pub fn save(&self, mut session: BrowserSession) -> Result<()> {
        session.validate()?;
        if session.created_at == 0 {
            session.created_at = unix_now();
        }
        let mut current = self
            .session
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        write_session_file(&self.path, &session)?;
        *current = Some(session);
        // 只由 YouTube Music 清理它自己的退休 OAuth token；普通 YouTube 不碰。
        if self.platform == Platform::Ytm {
            if let Some(parent) = self.path.parent() {
                let _ = std::fs::remove_file(parent.join("ytmusic.json"));
            }
        }
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        let mut current = self
            .session
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        crate::session_fs::remove_private_file(&self.path)?;
        if self.platform == Platform::Ytm {
            if let Some(parent) = self.path.parent() {
                crate::session_fs::remove_private_file(&parent.join("ytmusic.json"))?;
            }
        }
        *current = None;
        Ok(())
    }

    pub fn request_headers(&self, origin: &str) -> Vec<(String, String)> {
        self.snapshot()
            .map(|session| session.request_headers(origin))
            .unwrap_or_default()
    }

    pub fn browser_catalog() -> BrowserCatalog {
        crate::browser::catalog()
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn import_browser(
        &self,
        browser: &str,
        profile_id: Option<&str>,
    ) -> Result<BrowserSession> {
        let imported =
            crate::browser::profile_cookies(browser, profile_id, vec!["youtube.com".to_string()])?;
        let cookie = imported
            .cookies
            .into_iter()
            .filter(|item| item.domain == "youtube.com" || item.domain.ends_with(".youtube.com"))
            .map(|item| format!("{}={}", item.name, item.value))
            .collect::<Vec<_>>()
            .join("; ");
        let imported_from = imported.imported_from;
        let mut session = BrowserSession {
            cookie,
            x_goog_authuser: default_auth_user(),
            user_agent: default_user_agent(),
            visitor_data: String::new(),
            imported_from: imported_from.clone(),
            created_at: unix_now(),
        };
        let label = if self.platform == Platform::Ytm {
            "YouTube Music"
        } else {
            "YouTube"
        };
        session.validate().with_context(|| {
            format!(
                "没有从{imported_from}读取到已登录的 {label} 会话；请确认该 Profile 已登录 {label}，或在高级选项导入请求头"
            )
        })?;
        Ok(session)
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    pub fn import_browser(
        &self,
        _browser: &str,
        _profile_id: Option<&str>,
    ) -> Result<BrowserSession> {
        let label = if self.platform == Platform::Ytm {
            "YouTube Music"
        } else {
            "YouTube"
        };
        anyhow::bail!("移动端无法读取其它应用的浏览器会话；{label} 继续使用匿名访问")
    }
}

fn parse_headers(raw: &str) -> Result<BTreeMap<String, String>> {
    if raw.starts_with('{') {
        let value: serde_json::Value =
            serde_json::from_str(raw).context("请求头 JSON 格式不正确")?;
        let object = value.as_object().context("请求头 JSON 必须是对象")?;
        return Ok(object
            .iter()
            .filter_map(|(key, value)| {
                value
                    .as_str()
                    .map(|value| (key.to_ascii_lowercase(), value.into()))
            })
            .collect());
    }

    let mut headers = BTreeMap::new();
    for line in raw.lines() {
        let line = line.trim().trim_end_matches('\\');
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key
                .trim()
                .trim_matches(|ch| matches!(ch, '\'' | '"'))
                .trim_start_matches("-H ")
                .trim_matches(|ch| matches!(ch, '\'' | '"'))
                .to_ascii_lowercase();
            if !key.is_empty() {
                headers.insert(
                    key,
                    value
                        .trim()
                        .trim_matches(|ch| matches!(ch, '\'' | '"'))
                        .to_string(),
                );
            }
        }
    }
    Ok(headers)
}

fn looks_like_cookie(raw: &str) -> bool {
    !raw.contains('\n') && raw.contains('=') && raw.contains(';')
}

fn normalize_cookie(raw: &str) -> String {
    let mut values = BTreeMap::new();
    for part in raw.split(';') {
        let Some((name, value)) = part.trim().split_once('=') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if !name.is_empty() && !value.is_empty() {
            values.insert(name.to_string(), value.to_string());
        }
    }
    values
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn write_session_file(path: &std::path::Path, session: &BrowserSession) -> Result<()> {
    let body = serde_json::to_vec_pretty(session).context("序列化 YouTube 会话失败")?;
    crate::session_fs::write_private_atomic(path, &body).context("提交 YouTube 会话失败")
}

fn cookie_map(raw: &str) -> BTreeMap<String, String> {
    raw.split(';')
        .filter_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_cookie() -> &'static str {
        "LOGIN_INFO=x; SAPISID=secret; __Secure-3PAPISID=backup"
    }

    #[test]
    fn raw_and_json_headers_are_accepted() {
        let raw = format!(
            "cookie: {}\nx-goog-authuser: 1\nuser-agent: Test",
            sample_cookie()
        );
        let session = BrowserSession::from_headers(&raw).unwrap();
        assert_eq!(session.x_goog_authuser, "1");
        assert_eq!(session.user_agent, "Test");

        let json = serde_json::json!({"cookie": sample_cookie(), "x-goog-authuser": "0"});
        assert!(BrowserSession::from_headers(&json.to_string()).is_ok());
    }

    #[test]
    fn missing_sapisid_is_rejected() {
        let error = BrowserSession::from_headers("cookie: SID=x; LOGIN_INFO=y").unwrap_err();
        assert!(error.to_string().contains("SAPISID"));
    }

    #[test]
    fn cookie_header_import_accepts_sapisid() {
        let session =
            BrowserSession::from_cookie_header(sample_cookie(), "WebView 登录 · music.youtube.com")
                .unwrap();
        assert!(session.sid().is_some());
        assert_eq!(session.imported_from, "WebView 登录 · music.youtube.com");
    }

    #[test]
    fn sapisidhash_uses_origin_and_timestamp_shape() {
        let session =
            BrowserSession::from_headers(&format!("cookie: {}", sample_cookie())).unwrap();
        let value = session.authorization("https://music.youtube.com").unwrap();
        assert!(value.starts_with("SAPISIDHASH "));
        assert_eq!(value.split('_').nth(1).unwrap().len(), 40);
    }

    #[test]
    fn cookie_normalization_deduplicates_names_without_exposing_headers() {
        assert_eq!(normalize_cookie(" A=1; B=2; A=3 "), "A=3; B=2");
    }

    #[test]
    fn music_and_video_sessions_change_independently() {
        use crate::provider::ProviderLiveSettings;

        let root = std::env::temp_dir().join(format!(
            "kdj-youtube-auth-split-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let ctx = ProviderContext::new(
            root.clone(),
            ProviderLiveSettings {
                download_dir: root.join("downloads"),
                filename_template: "{title}".into(),
                default_quality: kdj_core::models::Quality::Q128,
                netease_use_download_api: false,
                soundcloud_enabled: false,
                soundcloud_client_id: String::new(),
                soundcloud_client_secret: String::new(),
                ytm_enabled: true,
                youtube_enabled: true,
                video_dir: None,
                video_format: "mp4".into(),
            },
        );
        let music = YoutubeAuth::new(&ctx, Platform::Ytm).unwrap();
        let video = YoutubeAuth::new(&ctx, Platform::Youtube).unwrap();
        let session = |cookie: &str| BrowserSession {
            cookie: format!("SAPISID={cookie}"),
            x_goog_authuser: "0".into(),
            user_agent: "Test".into(),
            visitor_data: String::new(),
            imported_from: "测试会话".into(),
            created_at: 1,
        };

        music.save(session("music-session")).unwrap();
        assert!(music.is_logged_in());
        assert!(!video.is_logged_in());

        video.save(session("video-session")).unwrap();
        music.clear().unwrap();
        assert!(!music.is_logged_in());
        assert!(video.is_logged_in());
        assert!(!ctx.session_file(YTM_SESSION_FILE).exists());
        assert!(ctx.session_file(YOUTUBE_SESSION_FILE).exists());

        let _ = std::fs::remove_dir_all(root);
    }
}
