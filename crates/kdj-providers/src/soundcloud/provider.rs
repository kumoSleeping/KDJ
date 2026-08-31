//! SoundCloud provider 实现。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use base64::Engine as _;
use futures_util::StreamExt as _;
use kdj_core::models::{
    Account, AccountState, Platform, QrSession, QrStateValue, Quality, ResolveKind,
    ResolveResponse, SongSource,
};
use kdj_core::paths::render_filename;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt as _;

use crate::net::{
    create_download_writer, guarded_media_get, guarded_media_get_with_host, host_is,
    parse_guarded_media_url, response_bytes_limited, AtomicDownload, GuardedMediaPolicy,
};
use crate::provider::{
    effective_limit, no_login, str_field, unique_download_path, Capabilities, DownloadJob,
    MusicProvider, ProviderContext,
};
use crate::tags;

const LABEL: &str = "SoundCloud";
const DISABLED_MESSAGE: &str = "未启用，在「下载」里打开开关";
const API: &str = "https://api-v2.soundcloud.com";
const SOUNDCLOUD_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/// SoundCloud 在部分网络下首包和 CDN 分片都明显慢于其它来源。
/// 这里只放宽 SoundCloud，避免把四个平台共同的故障发现时间一起拖长。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(120);
const STREAM_AUTH_MAX_BYTES: usize = 256 * 1024;
const COVER_MAX_BYTES: usize = 8 * 1024 * 1024;
/// client_id 大约每几周换一次，缓存半天足够。
const CLIENT_ID_TTL: Duration = Duration::from_secs(12 * 3600);
const OAUTH_STATE_TTL: Duration = Duration::from_secs(10 * 60);
const OAUTH_API: &str = "https://api.soundcloud.com";
const CREDENTIAL_OAUTH: &str = "oauth";
const CREDENTIAL_BROWSER: &str = "browser_session";

fn default_credential_kind() -> String {
    CREDENTIAL_OAUTH.into()
}

fn soundcloud_media_policy() -> GuardedMediaPolicy {
    GuardedMediaPolicy {
        max_redirects: 5,
        connect_timeout: CONNECT_TIMEOUT,
        read_timeout: READ_TIMEOUT,
    }
}

fn soundcloud_media_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(SOUNDCLOUD_USER_AGENT));
    headers
}

fn soundcloud_transcoding_target(url: &url::Url) -> bool {
    matches!(
        url.host_str(),
        Some("api-v2.soundcloud.com") | Some("api.soundcloud.com")
    )
}

fn soundcloud_cover_target(url: &url::Url) -> bool {
    url.host_str().is_some_and(|host| {
        let host = host.trim_end_matches('.');
        host == "sndcdn.com" || host.ends_with(".sndcdn.com")
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SoundCloudSession {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    expires_at: i64,
    #[serde(default)]
    user_urn: String,
    #[serde(default)]
    nickname: String,
    #[serde(default)]
    avatar: String,
    /// `oauth` 是 KDJ 自己申请的可刷新授权；`browser_session` 是从用户明确选择的
    /// 浏览器 Profile 读取到的 `oauth_token` Cookie。
    #[serde(default = "default_credential_kind")]
    credential_kind: String,
    #[serde(default)]
    imported_from: String,
}

#[derive(Debug, Clone)]
struct OAuthAttempt {
    verifier: String,
    created_at: Instant,
    status: OAuthStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct OAuthStatus {
    pub state: String,
    pub status: String,
    pub message: String,
}

pub struct SoundCloudProvider {
    ctx: ProviderContext,
    http: reqwest::Client,
    client_id: RwLock<Option<(String, Instant)>>,
    session: RwLock<Option<SoundCloudSession>>,
    oauth: Mutex<HashMap<String, OAuthAttempt>>,
    /// SoundCloud refresh token 是 single-use；所有账户/歌单并发请求必须共用一次刷新。
    refresh: tokio::sync::Mutex<()>,
}

impl SoundCloudProvider {
    pub fn new(ctx: ProviderContext) -> Result<Self> {
        kdj_core::ensure_rustls_ring();
        // 不设全程 timeout：歌曲一直有数据就允许下多久都行。read_timeout
        // 只限制相邻两次读取的空窗，给慢速 SoundCloud CDN 留足恢复时间。
        let http = reqwest::Client::builder()
            .user_agent(SOUNDCLOUD_USER_AGENT)
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .build()
            .context("构建 SoundCloud HTTP 客户端失败")?;
        let session_path = ctx.session_file("soundcloud.json");
        if let Some(parent) = session_path.parent() {
            crate::session_fs::ensure_private_dir(parent)?;
        }
        crate::session_fs::protect_existing_private_file(&session_path)?;
        let session =
            std::fs::read_to_string(&session_path).ok().and_then(
                |text| match serde_json::from_str::<SoundCloudSession>(&text) {
                    Ok(session) if !session.access_token.is_empty() => Some(session),
                    Ok(_) => None,
                    Err(err) => {
                        tracing::warn!("解析 SoundCloud 登录态失败：{err}");
                        None
                    }
                },
            );
        Ok(SoundCloudProvider {
            ctx,
            http,
            client_id: RwLock::new(None),
            session: RwLock::new(session),
            oauth: Mutex::new(HashMap::new()),
            refresh: tokio::sync::Mutex::new(()),
        })
    }

    fn ensure_enabled(&self) -> Result<()> {
        anyhow::ensure!(self.ctx.soundcloud_enabled(), "{DISABLED_MESSAGE}");
        Ok(())
    }

    fn oauth_credentials(&self) -> Result<(String, String)> {
        let client_id = self.ctx.soundcloud_client_id().trim().to_string();
        let client_secret = self.ctx.soundcloud_client_secret().trim().to_string();
        anyhow::ensure!(
            !client_id.is_empty() && !client_secret.is_empty(),
            "KDJ 尚未配置 SoundCloud 登录服务"
        );
        Ok((client_id, client_secret))
    }

    fn session_path(&self) -> PathBuf {
        self.ctx.session_file("soundcloud.json")
    }

    /// 从桌面浏览器的指定 Profile 导入 SoundCloud 网页端 `oauth_token`。读取发生在
    /// blocking 线程；验证通过后才落盘，不会用无效 Cookie 覆盖现有登录态。
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub async fn import_browser(&self, browser: String, profile_id: Option<String>) -> Result<()> {
        self.ensure_enabled()?;
        let session = tokio::task::spawn_blocking(move || {
            read_browser_session(&browser, profile_id.as_deref())
        })
        .await
        .context("读取 SoundCloud 浏览器会话任务失败")??;
        self.import_browser_session(session).await
    }

    /// 导入 KDJ 隔离登录窗口取得的 SoundCloud 网页会话。窗口本身只打开
    /// `soundcloud.com`，凭证不经过前端；这里仍联网验证后才落盘。
    pub async fn import_webview_session(&self, token: String, expires_at: i64) -> Result<()> {
        self.ensure_enabled()?;
        let session =
            browser_session_from_token(token, expires_at, "KDJ · SoundCloud 登录窗口".into())?;
        self.import_browser_session(session).await
    }

    async fn import_browser_session(&self, session: SoundCloudSession) -> Result<()> {
        let (status, profile) = self
            .authenticated_get_once(&session.access_token, "/me", &[], true)
            .await?;
        anyhow::ensure!(
            status.is_success(),
            "浏览器里的 SoundCloud 登录态无效：{}",
            oauth_error(&profile)
        );
        self.set_session(session_with_profile(session, &profile))
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    pub async fn import_browser(
        &self,
        _browser: String,
        _profile_id: Option<String>,
    ) -> Result<()> {
        bail!("移动端无法读取其它应用的浏览器会话；SoundCloud 继续使用匿名访问")
    }

    fn save_session(&self, session: &SoundCloudSession) -> Result<()> {
        let path = self.session_path();
        let body = serde_json::to_vec_pretty(session).context("序列化 SoundCloud 登录态失败")?;
        crate::session_fs::write_private_atomic(&path, &body).context("写入 SoundCloud 登录态失败")
    }

    fn session_snapshot(&self) -> Option<SoundCloudSession> {
        self.session.read().unwrap().clone()
    }

    fn set_session(&self, session: SoundCloudSession) -> Result<()> {
        let mut current = self.session.write().unwrap();
        self.save_session(&session)?;
        *current = Some(session);
        Ok(())
    }

    fn clear_session(&self) -> Result<()> {
        let mut current = self.session.write().unwrap();
        crate::session_fs::remove_private_file(&self.session_path())?;
        *current = None;
        Ok(())
    }

    fn prune_oauth(&self) {
        self.oauth
            .lock()
            .unwrap()
            .retain(|_, attempt| attempt.created_at.elapsed() <= OAUTH_STATE_TTL);
    }

    /// 创建 OAuth 2.1 + PKCE 登录地址。桌面弹窗会在同一进程拦截自定义协议，
    /// 再把 code 交给本机 HTTP API；移动发行包则由 deep-link 回到前端。
    pub fn begin_oauth(&self, redirect_uri: &str) -> Result<(String, String)> {
        self.ensure_enabled()?;
        let (client_id, _) = self.oauth_credentials()?;
        let state = random_token();
        let verifier = random_token();
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        self.prune_oauth();
        self.oauth.lock().unwrap().insert(
            state.clone(),
            OAuthAttempt {
                verifier,
                created_at: Instant::now(),
                status: OAuthStatus {
                    state: state.clone(),
                    status: "pending".into(),
                    message: "等待 SoundCloud 授权".into(),
                },
            },
        );

        let mut url = url::Url::parse("https://secure.soundcloud.com/authorize")
            .context("构建 SoundCloud 登录地址失败")?;
        url.query_pairs_mut()
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("display", "popup");
        Ok((state, url.to_string()))
    }

    pub fn oauth_status(&self, state: &str) -> OAuthStatus {
        self.prune_oauth();
        self.oauth
            .lock()
            .unwrap()
            .get(state)
            .map(|attempt| attempt.status.clone())
            .unwrap_or_else(|| OAuthStatus {
                state: state.to_string(),
                status: "error".into(),
                message: "登录会话不存在或已过期".into(),
            })
    }

    pub fn fail_oauth(&self, state: &str, message: impl Into<String>) {
        if let Some(attempt) = self.oauth.lock().unwrap().get_mut(state) {
            attempt.status = OAuthStatus {
                state: state.to_string(),
                status: "error".into(),
                message: message.into(),
            };
        }
    }

    pub async fn finish_oauth(&self, state: &str, code: &str, redirect_uri: &str) -> Result<()> {
        self.prune_oauth();
        let verifier = self
            .oauth
            .lock()
            .unwrap()
            .get(state)
            .map(|attempt| attempt.verifier.clone())
            .context("SoundCloud 登录会话不存在或已过期")?;
        let result = self
            .exchange_oauth_code(code, &verifier, redirect_uri)
            .await;
        match result {
            Ok(session) => {
                self.set_session(session)?;
                if let Some(attempt) = self.oauth.lock().unwrap().get_mut(state) {
                    attempt.status = OAuthStatus {
                        state: state.to_string(),
                        status: "done".into(),
                        message: "SoundCloud 登录成功".into(),
                    };
                }
                Ok(())
            }
            Err(error) => {
                self.fail_oauth(state, error.to_string());
                Err(error)
            }
        }
    }

    async fn exchange_oauth_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<SoundCloudSession> {
        let (client_id, client_secret) = self.oauth_credentials()?;
        let response = self
            .http
            .post("https://secure.soundcloud.com/oauth/token")
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
                ("redirect_uri", redirect_uri),
                ("code_verifier", verifier),
                ("code", code),
            ])
            .send()
            .await
            .context("SoundCloud 登录换取令牌失败")?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .context("解析 SoundCloud 登录响应失败")?;
        anyhow::ensure!(
            status.is_success(),
            "SoundCloud 登录失败：{}",
            oauth_error(&body)
        );
        let access_token = body
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .context("SoundCloud 登录响应缺少 access_token")?;
        let expires_in = body
            .get("expires_in")
            .and_then(Value::as_i64)
            .unwrap_or(3600);
        Ok(SoundCloudSession {
            access_token: access_token.to_string(),
            refresh_token: body
                .get("refresh_token")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            expires_at: unix_now() + expires_in,
            user_urn: String::new(),
            nickname: String::new(),
            avatar: String::new(),
            credential_kind: CREDENTIAL_OAUTH.into(),
            imported_from: String::new(),
        })
    }

    /// 从首页引用的 JS bundle 里抓 `client_id`。
    ///
    /// SoundCloud 不发官方 key，网页端就是把它硬编码在 bundle 里。
    /// bundle 的文件名带 hash、每次发版都变，所以只能先取首页再逐个扫。
    async fn client_id(&self) -> Result<String> {
        if let Some((id, at)) = self.client_id.read().unwrap().as_ref() {
            if at.elapsed() < CLIENT_ID_TTL {
                return Ok(id.clone());
            }
        }
        let home = {
            self.http
                .get("https://soundcloud.com/")
                .send()
                .await
                .context("打开 SoundCloud 首页失败")?
                .text()
                .await
                .context("读取 SoundCloud 首页失败")?
        };

        // 越靠后的 bundle 越可能带 client_id，倒着扫命中更快
        let mut scripts = extract_script_urls(&home);
        scripts.reverse();
        for url in scripts.into_iter().take(12) {
            let response = self.http.get(&url).send().await;
            let Ok(response) = response else {
                continue;
            };
            let Ok(body) = response.text().await else {
                continue;
            };
            if let Some(found) = extract_client_id(&body) {
                *self.client_id.write().unwrap() = Some((found.clone(), Instant::now()));
                return Ok(found);
            }
        }
        bail!("没能从 SoundCloud 页面里找到 client_id")
    }

    /// client_id 过期时接口回 401，清掉缓存重来一次。
    fn invalidate_client_id(&self) {
        *self.client_id.write().unwrap() = None;
    }

    async fn api_get(&self, path: &str, params: &[(&str, String)]) -> Result<Value> {
        for attempt in 0..2 {
            let client_id = self.client_id().await?;
            let mut query: Vec<(&str, String)> = params.to_vec();
            query.push(("client_id", client_id));
            let response = self
                .http
                .get(format!("{API}{path}"))
                .query(&query)
                .send()
                .await
                .with_context(|| format!("SoundCloud 请求失败：{path}"))?;
            if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                self.invalidate_client_id();
                continue;
            }
            anyhow::ensure!(
                response.status().is_success(),
                "SoundCloud 接口返回 {}",
                response.status()
            );
            return response
                .json()
                .await
                .with_context(|| format!("SoundCloud 响应不是合法 JSON：{path}"));
        }
        bail!("SoundCloud client_id 失效且刷新后仍被拒绝")
    }

    async fn refresh_access_token(&self, rejected_access_token: Option<&str>) -> Result<String> {
        let _single_flight = self.refresh.lock().await;
        let current = self.session_snapshot().context("SoundCloud 尚未登录")?;
        // 等锁期间另一条请求可能已经完成刷新。普通过期检查只要新 token 仍有效就复用；
        // 401 重试则比较刚被拒绝的 token，避免把 single-use refresh token 再消费一次。
        if rejected_access_token
            .map(|rejected| rejected != current.access_token.as_str())
            .unwrap_or(current.expires_at > unix_now() + 60)
        {
            return Ok(current.access_token);
        }
        anyhow::ensure!(
            !current.refresh_token.is_empty(),
            "SoundCloud 登录已过期，请重新登录"
        );
        let (client_id, client_secret) = self.oauth_credentials()?;
        let response = self
            .http
            .post("https://secure.soundcloud.com/oauth/token")
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
                ("refresh_token", current.refresh_token.as_str()),
            ])
            .send()
            .await
            .context("SoundCloud 刷新登录态失败")?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .context("解析 SoundCloud 刷新响应失败")?;
        anyhow::ensure!(
            status.is_success(),
            "SoundCloud 登录已过期：{}",
            oauth_error(&body)
        );
        let access_token = body
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .context("SoundCloud 刷新响应缺少 access_token")?
            .to_string();
        let mut next = current;
        next.access_token = access_token;
        if let Some(refresh) = body.get("refresh_token").and_then(Value::as_str) {
            next.refresh_token = refresh.to_string();
        }
        next.expires_at = unix_now()
            + body
                .get("expires_in")
                .and_then(Value::as_i64)
                .unwrap_or(3600);
        let token = next.access_token.clone();
        self.set_session(next)?;
        Ok(token)
    }

    async fn authenticated_get_once(
        &self,
        token: &str,
        path: &str,
        params: &[(&str, String)],
        browser_session: bool,
    ) -> Result<(reqwest::StatusCode, Value)> {
        let mut query = params.to_vec();
        let base = if browser_session {
            // SoundCloud 网页的 oauth_token 属于网页 client。官方 v1 `/me` 会对它回
            // 403；网页自己使用的 api-v2 + 同一份公开 client_id 才接受这枚 token。
            query.push(("client_id", self.client_id().await?));
            API
        } else {
            OAUTH_API
        };
        let response = self
            .http
            .get(format!("{base}{path}"))
            .header(reqwest::header::AUTHORIZATION, format!("OAuth {token}"))
            .query(&query)
            .send()
            .await
            .with_context(|| format!("SoundCloud 登录接口请求失败：{path}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .with_context(|| format!("读取 SoundCloud 登录接口响应失败：{path}"))?;
        let body = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text)
                .with_context(|| format!("解析 SoundCloud 登录接口响应失败：{path}"))?
        };
        Ok((status, body))
    }

    async fn api_get_authenticated(&self, path: &str, params: &[(&str, String)]) -> Result<Value> {
        let current = self.session_snapshot().context("SoundCloud 尚未登录")?;
        anyhow::ensure!(
            !browser_session_expired(&current),
            "SoundCloud 浏览器会话已过期，请重新连接浏览器"
        );
        let token = if oauth_session_needs_refresh(&current) {
            self.refresh_access_token(None).await?
        } else {
            current.access_token.clone()
        };
        let browser_session = current.credential_kind == CREDENTIAL_BROWSER;
        let (status, body) = self
            .authenticated_get_once(&token, path, params, browser_session)
            .await?;
        if status == reqwest::StatusCode::UNAUTHORIZED {
            if current.refresh_token.is_empty() {
                if current.credential_kind == CREDENTIAL_BROWSER {
                    bail!("SoundCloud 浏览器会话已失效，请重新连接浏览器");
                }
                bail!("SoundCloud 登录已失效，请重新登录");
            }
            let refreshed = self.refresh_access_token(Some(&token)).await?;
            let (retry_status, retry_body) = self
                .authenticated_get_once(&refreshed, path, params, false)
                .await?;
            anyhow::ensure!(
                retry_status.is_success(),
                "SoundCloud 登录接口返回 {}：{}",
                retry_status,
                oauth_error(&retry_body)
            );
            return Ok(retry_body);
        }
        anyhow::ensure!(
            status.is_success(),
            "SoundCloud 登录接口返回 {}：{}",
            status,
            oauth_error(&body)
        );
        Ok(body)
    }

    async fn authenticated_write_once(
        &self,
        token: &str,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<(reqwest::StatusCode, Value)> {
        let mut request = self
            .http
            .request(method, format!("{OAUTH_API}{path}"))
            .header(reqwest::header::AUTHORIZATION, format!("OAuth {token}"))
            .header(reqwest::header::ACCEPT, "application/json; charset=utf-8");
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("SoundCloud 写接口请求失败：{path}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .with_context(|| format!("读取 SoundCloud 写接口响应失败：{path}"))?;
        let body = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text)
                .with_context(|| format!("解析 SoundCloud 写接口响应失败：{path}"))?
        };
        Ok((status, body))
    }

    /// SoundCloud 官方写接口只接受 KDJ 自己完成的 OAuth 授权。浏览器 Cookie
    /// 属于网页私有 client，不能拿去冒充公开 API access token。
    async fn api_write_authenticated(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        let current = self.session_snapshot().context("SoundCloud 尚未登录")?;
        anyhow::ensure!(
            current.credential_kind == CREDENTIAL_OAUTH,
            "修改 SoundCloud 收藏或歌单需要改用官方 OAuth 登录"
        );
        let token = if oauth_session_needs_refresh(&current) {
            self.refresh_access_token(None).await?
        } else {
            current.access_token.clone()
        };
        let (status, response) = self
            .authenticated_write_once(&token, method.clone(), path, body)
            .await?;
        if status == reqwest::StatusCode::UNAUTHORIZED {
            let refreshed = self.refresh_access_token(Some(&token)).await?;
            let (retry_status, retry_body) = self
                .authenticated_write_once(&refreshed, method, path, body)
                .await?;
            anyhow::ensure!(
                retry_status.is_success(),
                "SoundCloud 写接口返回 {}：{}",
                retry_status,
                oauth_error(&retry_body)
            );
            return Ok(retry_body);
        }
        anyhow::ensure!(
            status.is_success(),
            "SoundCloud 写接口返回 {}：{}",
            status,
            oauth_error(&response)
        );
        Ok(response)
    }

    /// 把 transcoding 的授权地址换成真正的 CDN 直链。
    async fn authorize_stream(&self, transcoding_url: &str) -> Result<String> {
        let client_id = self.client_id().await?;
        let mut transcoding =
            parse_guarded_media_url(transcoding_url).context("SoundCloud 音频授权地址无效")?;
        anyhow::ensure!(
            soundcloud_transcoding_target(&transcoding),
            "SoundCloud 音频授权地址不受信任"
        );
        transcoding
            .query_pairs_mut()
            .append_pair("client_id", &client_id);
        let response = guarded_media_get_with_host(
            transcoding.as_str(),
            &soundcloud_media_headers(),
            soundcloud_media_policy(),
            &soundcloud_transcoding_target,
        )
        .await
        .context("获取 SoundCloud 音频地址失败")?
        .error_for_status()
        .context("获取 SoundCloud 音频地址失败")?;
        let bytes = response_bytes_limited(response, STREAM_AUTH_MAX_BYTES)
            .await
            .context("SoundCloud 音频地址响应过大或读取失败")?;
        let body: Value =
            serde_json::from_slice(&bytes).context("SoundCloud 音频地址响应不是合法 JSON")?;
        let url = body
            .get("url")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
            .map(str::to_string)
            .context("SoundCloud 没有返回音频地址")?;
        parse_guarded_media_url(&url).context("SoundCloud 返回了不安全的音频地址")?;
        Ok(url)
    }

    async fn fetch_cover(&self, url: &str) -> Option<Vec<u8>> {
        if url.is_empty() {
            return None;
        }
        // `-large` 是 100x100 的缩略图，`-t500x500` 才是能看的封面
        let full = url.replace("-large.", "-t500x500.");
        let response = guarded_media_get_with_host(
            &full,
            &soundcloud_media_headers(),
            soundcloud_media_policy(),
            &soundcloud_cover_target,
        )
        .await
        .ok()?;
        if !response.status().is_success() {
            return None;
        }
        response_bytes_limited(response, COVER_MAX_BYTES).await.ok()
    }
}

#[async_trait]
impl MusicProvider for SoundCloudProvider {
    fn platform(&self) -> Platform {
        Platform::Soundcloud
    }

    fn label(&self) -> &str {
        LABEL
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::MUSIC
    }

    async fn account(&self) -> Account {
        let mut account =
            Account::new(Platform::Soundcloud, LABEL, AccountState::Missing, "未登录");
        account.login_method = "browser".into();
        account.credential_kind = "anonymous".into();
        if !self.ctx.soundcloud_enabled() {
            account.detail = DISABLED_MESSAGE.into();
            return account;
        }
        let Some(cached) = self.session_snapshot() else {
            // AccountRow 已经单独显示了「未登录」状态，这里只提供补充说明，
            // 避免界面出现「未登录 · 未登录 · …」的重复文案。
            account.detail = "可先搜索公开内容".into();
            return account;
        };
        match self.api_get_authenticated("/me", &[]).await {
            Ok(profile) => {
                // `/me` 期间 OAuth 可能刚完成刷新；资料要合并到刷新后的会话，不能拿
                // 调用前的 cached 把新 access/refresh token 覆盖回去。
                let current = self.session_snapshot().unwrap_or(cached);
                let nickname = str_field(&profile, "username")
                    .or_else(|| str_field(&profile, "full_name"))
                    .unwrap_or(&current.nickname)
                    .to_string();
                let avatar = soundcloud_avatar(&profile, &current.avatar);
                let user_urn = str_field(&profile, "urn")
                    .map(str::to_string)
                    .or_else(|| profile.get("id").map(value_id))
                    .filter(|value| !value.is_empty())
                    .unwrap_or(current.user_urn.clone());
                let credential_kind = current.credential_kind.clone();
                let imported_from = current.imported_from.clone();
                let mut next = current;
                next.nickname = nickname.clone();
                next.avatar = avatar.clone();
                next.user_urn = user_urn.clone();
                if let Err(error) = self.set_session(next) {
                    tracing::warn!("保存 SoundCloud 用户资料失败：{error}");
                }
                account.state = AccountState::Valid;
                account.account_key = user_urn;
                account.credential_kind = credential_kind;
                account.detail = if imported_from.is_empty() {
                    "已登录".into()
                } else {
                    imported_from
                };
                account.nickname = nickname;
                account.avatar = avatar;
            }
            Err(error) => {
                account.state = if session_expired(&cached) {
                    AccountState::Expired
                } else {
                    AccountState::Unknown
                };
                account.detail = truncate(&format!("登录态检查失败：{error}"), 160);
                account.credential_kind = cached.credential_kind;
                account.nickname = cached.nickname;
                account.avatar = cached.avatar;
            }
        }
        account
    }

    async fn cached_account(&self) -> Account {
        let mut account =
            Account::new(Platform::Soundcloud, LABEL, AccountState::Missing, "未登录");
        account.login_method = "browser".into();
        account.credential_kind = "anonymous".into();
        if !self.ctx.soundcloud_enabled() {
            account.detail = DISABLED_MESSAGE.into();
            return account;
        }
        let Some(session) = self.session_snapshot() else {
            account.detail = "可先搜索公开内容".into();
            return account;
        };
        let expired = browser_session_expired(&session);
        account.state = if expired {
            AccountState::Expired
        } else {
            AccountState::Valid
        };
        account.detail = if expired {
            "浏览器会话已过期，请重新连接".into()
        } else if session.imported_from.is_empty() {
            "登录状态尚未联网核验".into()
        } else {
            session.imported_from.clone()
        };
        account.account_key = session.user_urn;
        account.credential_kind = session.credential_kind;
        account.nickname = session.nickname;
        account.avatar = session.avatar;
        account
    }

    async fn create_qr(&self) -> Result<QrSession> {
        no_login::create_qr(LABEL)
    }

    async fn poll_qr(&self, _session_id: &str) -> Result<(QrStateValue, String)> {
        Ok(no_login::poll_qr(LABEL))
    }

    async fn logout(&self) -> Result<()> {
        if let Some(session) = self
            .session_snapshot()
            .filter(|session| session.credential_kind != CREDENTIAL_BROWSER)
        {
            let _ = self
                .http
                .post("https://secure.soundcloud.com/sign-out")
                .json(&serde_json::json!({ "access_token": session.access_token }))
                .send()
                .await;
        }
        self.clear_session()?;
        self.oauth.lock().unwrap().clear();
        Ok(())
    }

    async fn search(&self, keyword: &str, limit: usize) -> Result<Vec<SongSource>> {
        let keyword = keyword.trim();
        if !self.ctx.soundcloud_enabled() || keyword.is_empty() {
            return Ok(Vec::new());
        }
        let limit = effective_limit(limit, 20);
        let body = self
            .api_get(
                "/search/tracks",
                &[
                    ("q", keyword.to_string()),
                    ("limit", limit.to_string()),
                    ("offset", "0".to_string()),
                ],
            )
            .await?;
        Ok(body
            .get("collection")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(to_source).take(limit).collect())
            .unwrap_or_default())
    }

    async fn stream_playlists(&self) -> Result<Vec<kdj_core::models::StreamPlaylist>> {
        let Some(session) = self.session_snapshot() else {
            return Ok(Vec::new());
        };
        let browser_session = session.credential_kind == CREDENTIAL_BROWSER;
        let cached_user_id = if browser_session {
            soundcloud_legacy_id(&session.user_urn)
        } else {
            (!session.user_urn.is_empty()).then(|| session.user_urn.clone())
        };
        let user_id = if let Some(user_id) = cached_user_id.filter(|value| !value.is_empty()) {
            user_id
        } else {
            // 旧版登录文件可能没有 user_urn；只为这种一次性迁移情况补查 /me。
            let me = self.api_get_authenticated("/me", &[]).await?;
            (if browser_session {
                me.get("id").map(value_id)
            } else {
                me.get("urn")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| me.get("id").map(value_id))
            })
            .filter(|value| !value.is_empty())
            .context("SoundCloud 登录资料缺少用户 ID")?
        };

        // 收藏数量不是目录功能的必要数据；展开“我的收藏”时再读取内容，不能只为
        // 显示一个数字提前扫一遍 likes。
        let mut playlists = vec![kdj_core::models::StreamPlaylist {
            platform: Platform::Soundcloud,
            key: "__soundcloud_favorites__".into(),
            title: "我的收藏".into(),
            cover: String::new(),
            count: 0,
            is_favorite: true,
            origin: "favorite".into(),
        }];

        if browser_session {
            // api-v2 没有 `/me/playlists`（会回 404）。网页的「Playlists」页走这条
            // 聚合目录，响应再用 `{ playlist: ... }` 包一层；它同时包含自己创建和
            // 收藏的列表，正好避免只扫混合 likes 首页时漏掉排在后面的 playlist。
            let directory = self
                .api_get_authenticated(
                    &format!("/users/{user_id}/playlists/liked_and_owned"),
                    &[
                        ("limit", "200".into()),
                        ("linked_partitioning", "true".into()),
                    ],
                )
                .await?;
            playlists.extend(collection(&directory).iter().filter_map(|entry| {
                let playlist = soundcloud_like_playlist(entry)?;
                let origin = if soundcloud_playlist_owned_by(playlist, &user_id) {
                    "created"
                } else {
                    "collected"
                };
                soundcloud_playlist(playlist, origin)
            }));
        } else {
            if let Ok(created) = self
                .api_get_authenticated(
                    "/me/playlists",
                    &[
                        ("show_tracks", "false".into()),
                        ("limit", "200".into()),
                        ("linked_partitioning", "true".into()),
                    ],
                )
                .await
            {
                playlists.extend(
                    collection(&created)
                        .iter()
                        .filter_map(|entry| soundcloud_playlist(entry, "created")),
                );
            }
            if let Ok(collected) = self
                .api_get_authenticated(
                    &format!("/users/{user_id}/likes/playlists"),
                    &[
                        ("limit", "200".into()),
                        ("linked_partitioning", "true".into()),
                    ],
                )
                .await
            {
                playlists.extend(collection(&collected).iter().filter_map(|entry| {
                    let playlist = entry.get("playlist").unwrap_or(entry);
                    soundcloud_playlist(playlist, "collected")
                }));
            }
        }
        Ok(dedup_playlists(playlists))
    }

    async fn stream_playlist_tracks(
        &self,
        key: &str,
        limit: usize,
    ) -> Result<Option<kdj_core::models::StreamPlaylistResponse>> {
        let key = key.trim();
        let Some(session) = self.session_snapshot() else {
            return Ok(None);
        };
        if key.is_empty() {
            return Ok(None);
        }
        let limit = effective_limit(limit, 500).min(200);
        let (title, entries) = if key == "__soundcloud_favorites__" {
            let browser_session = session.credential_kind == CREDENTIAL_BROWSER;
            let cached_user_id = if browser_session {
                soundcloud_legacy_id(&session.user_urn)
            } else {
                (!session.user_urn.is_empty()).then(|| session.user_urn.clone())
            };
            let user_id = if let Some(user_id) = cached_user_id.filter(|value| !value.is_empty()) {
                user_id
            } else {
                // 仅兼容没有 user_urn 的旧会话；新会话不重复请求 /me。
                let me = self.api_get_authenticated("/me", &[]).await?;
                (if browser_session {
                    me.get("id").map(value_id)
                } else {
                    me.get("urn")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| me.get("id").map(value_id))
                })
                .filter(|value| !value.is_empty())
                .context("SoundCloud 登录资料缺少用户 ID")?
            };
            let likes_path = if browser_session {
                format!("/users/{user_id}/likes")
            } else {
                format!("/users/{user_id}/likes/tracks")
            };
            let body = self
                .api_get_authenticated(
                    &likes_path,
                    &[
                        ("limit", limit.to_string()),
                        ("linked_partitioning", "true".into()),
                    ],
                )
                .await?;
            ("我的收藏".to_string(), collection(&body).to_vec())
        } else {
            let request_key = if session.credential_kind == CREDENTIAL_BROWSER {
                soundcloud_legacy_id(key).unwrap_or_else(|| key.to_string())
            } else {
                key.to_string()
            };
            let body = self
                .api_get_authenticated(
                    &format!("/playlists/{request_key}"),
                    &[("show_tracks", "true".into())],
                )
                .await?;
            (
                str_field(&body, "title")
                    .unwrap_or("SoundCloud 歌单")
                    .to_string(),
                body.get("tracks")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            )
        };
        let sources: Vec<SongSource> = entries
            .iter()
            .filter_map(|entry| soundcloud_like_track(entry).and_then(to_source))
            .take(limit)
            .collect();
        Ok(Some(kdj_core::models::StreamPlaylistResponse {
            platform: Platform::Soundcloud,
            key: key.to_string(),
            title,
            sources,
        }))
    }

    async fn remove_stream_playlist_track(&self, key: &str, source: &SongSource) -> Result<()> {
        anyhow::ensure!(
            source.platform == Platform::Soundcloud,
            "歌曲来源不是 SoundCloud"
        );
        let session = self.session_snapshot().context("SoundCloud 尚未登录")?;
        anyhow::ensure!(
            session.credential_kind == CREDENTIAL_OAUTH,
            "修改 SoundCloud 收藏或歌单需要改用官方 OAuth 登录"
        );
        let track_urn =
            soundcloud_source_urn(source).context("SoundCloud 歌曲缺少 URN，请刷新歌单后重试")?;
        if key.trim() == "__soundcloud_favorites__" {
            self.api_write_authenticated(
                reqwest::Method::DELETE,
                &format!("/likes/tracks/{track_urn}"),
                None,
            )
            .await?;
            return Ok(());
        }

        let playlist_urn = normalize_soundcloud_urn(key, "playlists")
            .context("SoundCloud 歌单缺少 URN，请刷新目录后重试")?;
        let me = self.api_get_authenticated("/me", &[]).await?;
        let me_urn = me
            .get("urn")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| me.get("id").map(value_id))
            .or_else(|| (!session.user_urn.is_empty()).then(|| session.user_urn.clone()))
            .context("SoundCloud 登录资料缺少用户 URN")?;
        let playlist = self
            .api_get_authenticated(
                &format!("/playlists/{playlist_urn}"),
                &[("show_tracks", "true".into())],
            )
            .await?;
        anyhow::ensure!(
            soundcloud_playlist_owned_by(&playlist, &me_urn),
            "收藏的他人 SoundCloud 歌单不能移除其中的歌曲"
        );
        let tracks = playlist
            .get("tracks")
            .and_then(Value::as_array)
            .context("SoundCloud 歌单响应缺少 tracks")?;
        let mut removed = false;
        let mut remaining = Vec::with_capacity(tracks.len().saturating_sub(1));
        for track in tracks {
            let urn = soundcloud_value_urn(track, "tracks")
                .context("SoundCloud 歌单中有曲目缺少 URN，已拒绝覆盖歌单")?;
            if !removed && soundcloud_same_resource(&urn, &track_urn) {
                removed = true;
                continue;
            }
            remaining.push(json!({"urn": urn}));
        }
        anyhow::ensure!(removed, "这首歌已不在 SoundCloud 歌单中，请刷新后重试");
        let body = json!({"playlist": {"tracks": remaining}});
        self.api_write_authenticated(
            reqwest::Method::PUT,
            &format!("/playlists/{playlist_urn}"),
            Some(&body),
        )
        .await?;
        Ok(())
    }

    async fn resolve(&self, url: &str, limit: usize) -> Result<Option<ResolveResponse>> {
        let text = url.trim();
        // on.soundcloud.com 是 soundcloud.com 的子域，host_is 已覆盖
        if !host_is(text, "soundcloud.com") && !host_is(text, "snd.sc") {
            return Ok(None);
        }
        self.ensure_enabled()?;
        let limit = effective_limit(limit, 500);

        let body = self
            .api_get("/resolve", &[("url", text.to_string())])
            .await?;
        let kind = body.get("kind").and_then(Value::as_str).unwrap_or_default();

        match kind {
            "track" => {
                let source = to_source(&body).context("SoundCloud 音轨缺少必要字段")?;
                Ok(Some(ResolveResponse {
                    kind: ResolveKind::Song,
                    platform: Platform::Soundcloud,
                    title: source.title.clone(),
                    sources: vec![source],
                }))
            }
            "playlist" | "system-playlist" => {
                let sources: Vec<SongSource> = body
                    .get("tracks")
                    .and_then(Value::as_array)
                    .map(|list| list.iter().filter_map(to_source).take(limit).collect())
                    .unwrap_or_default();
                if sources.is_empty() {
                    bail!("SoundCloud 结果里没有可用音轨。");
                }
                Ok(Some(ResolveResponse {
                    // `/albums/` 路径下的是专辑，其余按歌单
                    kind: if text.to_ascii_lowercase().contains("/albums/") {
                        ResolveKind::Album
                    } else {
                        ResolveKind::Playlist
                    },
                    platform: Platform::Soundcloud,
                    title: str_field(&body, "title")
                        .unwrap_or("SoundCloud 歌单")
                        .to_string(),
                    sources,
                }))
            }
            _ => bail!("没有读取到 SoundCloud 内容。"),
        }
    }

    /// SoundCloud 的 progressive 流本来就只有一档（128K 上下的 mp3），
    /// 拿到授权直链就是"最低码率"。
    async fn preview_url(&self, source: &SongSource) -> Result<Option<String>> {
        self.ensure_enabled()?;
        let transcoding = source.payload_str("transcoding_url");
        let transcoding = if transcoding.is_empty() {
            // 和 download 同一套补救：payload 是老版本存的就回查一次详情
            let permalink = source.payload_str("permalink_url");
            anyhow::ensure!(!permalink.is_empty(), "SoundCloud 音轨缺少试听链接");
            let body = self.api_get("/resolve", &[("url", permalink)]).await?;
            pick_transcoding(&body)
                .context("SoundCloud 没有可用的音频流")?
                .0
        } else {
            transcoding
        };
        Ok(Some(self.authorize_stream(&transcoding).await?))
    }

    async fn download(&self, job: DownloadJob<'_>) -> Result<PathBuf> {
        self.ensure_enabled()?;
        job.check_canceled()?;
        let source = job.source;

        let transcoding = source.payload_str("transcoding_url");
        let (transcoding, ext) = if transcoding.is_empty() {
            // 搜索结果里的 payload 可能是别的版本存下来的，回查一次详情
            let permalink = source.payload_str("permalink_url");
            anyhow::ensure!(!permalink.is_empty(), "SoundCloud 音轨缺少下载链接。");
            let body = self.api_get("/resolve", &[("url", permalink)]).await?;
            let picked = pick_transcoding(&body).context("SoundCloud 没有可用的音频流")?;
            picked
        } else {
            (transcoding, source.payload_str("transcoding_ext"))
        };
        let ext = if ext.is_empty() {
            "mp3".to_string()
        } else {
            ext
        };

        let url = self.authorize_stream(&transcoding).await?;
        job.check_canceled()?;

        let output_dir = self.ctx.platform_dir(Platform::Soundcloud)?;
        let filename = render_filename(
            &self.ctx.filename_template(),
            &source.title,
            &source.artist_text(),
            &source.album,
            &source.key,
            &ext,
        );
        let final_path = unique_download_path(&output_dir, &filename);

        let guard = AtomicDownload::new(&final_path);
        let response =
            guarded_media_get(&url, &soundcloud_media_headers(), soundcloud_media_policy())
                .await
                .context("SoundCloud 音频下载失败")?
                .error_for_status()
                .context("SoundCloud 音频下载失败")?;
        let total = response.content_length().unwrap_or(0);
        job.report(0, total);

        let mut file = create_download_writer(guard.partial())
            .await
            .context("创建下载临时文件失败")?;
        let mut downloaded = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            job.check_canceled()?;
            let chunk = chunk.context("SoundCloud 音频流中断")?;
            file.write_all(&chunk).await.context("写入下载文件失败")?;
            downloaded += chunk.len() as u64;
            job.report(downloaded, total.max(downloaded));
        }
        file.flush().await.context("提交下载缓冲失败")?;
        drop(file);
        let path = guard.commit()?;

        let cover = self.fetch_cover(&source.cover).await;
        let artists = if source.artists.is_empty() {
            vec!["Unknown".to_string()]
        } else {
            source.artists.clone()
        };
        if let Err(err) = tags::embed_metadata(
            &path,
            &source.title,
            &artists,
            &source.album,
            cover.as_deref(),
        ) {
            tracing::warn!("SoundCloud 写标签失败 song={}: {err}", source.key);
        }
        Ok(path)
    }
}

// ---------------------------------------------------------------- 纯函数

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn read_browser_session(browser: &str, profile_id: Option<&str>) -> Result<SoundCloudSession> {
    let imported =
        crate::browser::profile_cookies(browser, profile_id, vec!["soundcloud.com".to_string()])?;
    browser_session_from_profile(imported)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn browser_session_from_profile(
    imported: crate::browser::BrowserProfileCookies,
) -> Result<SoundCloudSession> {
    let now = unix_now().max(0) as u64;
    let cookie = imported
        .cookies
        .into_iter()
        .filter(|cookie| cookie.name == "oauth_token" && !cookie.value.trim().is_empty())
        .filter(|cookie| {
            let domain = cookie.domain.trim_start_matches('.');
            domain == "soundcloud.com" || domain.ends_with(".soundcloud.com")
        })
        .filter(|cookie| cookie.expires.map(|expires| expires > now).unwrap_or(true))
        .max_by_key(|cookie| {
            let exact_domain = cookie.domain.trim_start_matches('.') == "soundcloud.com";
            (exact_domain, cookie.expires.unwrap_or(u64::MAX))
        })
        .with_context(|| {
            format!(
                "没有从{}读取到已登录的 SoundCloud 会话；请确认该 Profile 已登录 SoundCloud",
                imported.imported_from
            )
        })?;
    browser_session_from_token(
        cookie.value,
        cookie
            .expires
            .map(|expires| expires.min(i64::MAX as u64) as i64)
            .unwrap_or(0),
        imported.imported_from,
    )
}

fn browser_session_from_token(
    token: String,
    expires_at: i64,
    imported_from: String,
) -> Result<SoundCloudSession> {
    let token = token.trim().to_string();
    anyhow::ensure!(
        !token.is_empty() && token.len() <= 4096,
        "SoundCloud 登录窗口没有返回有效会话"
    );
    anyhow::ensure!(
        expires_at <= 0 || expires_at > unix_now(),
        "SoundCloud 登录窗口返回的会话已过期"
    );
    Ok(SoundCloudSession {
        access_token: token,
        refresh_token: String::new(),
        expires_at,
        user_urn: String::new(),
        nickname: String::new(),
        avatar: String::new(),
        credential_kind: CREDENTIAL_BROWSER.into(),
        imported_from,
    })
}

fn session_with_profile(mut session: SoundCloudSession, profile: &Value) -> SoundCloudSession {
    session.nickname = str_field(profile, "username")
        .or_else(|| str_field(profile, "full_name"))
        .unwrap_or_default()
        .to_string();
    session.avatar = soundcloud_avatar(profile, "");
    session.user_urn = str_field(profile, "urn")
        .map(str::to_string)
        .or_else(|| profile.get("id").map(value_id))
        .unwrap_or_default();
    session
}

fn soundcloud_avatar(profile: &Value, fallback: &str) -> String {
    str_field(profile, "avatar_url")
        .filter(|url| !url.contains("/default_avatar_"))
        .or_else(|| (!fallback.contains("/default_avatar_")).then_some(fallback))
        .unwrap_or_default()
        .to_string()
}

fn session_expired(session: &SoundCloudSession) -> bool {
    session.expires_at > 0 && session.expires_at <= unix_now()
}

fn browser_session_expired(session: &SoundCloudSession) -> bool {
    session.credential_kind == CREDENTIAL_BROWSER && session_expired(session)
}

fn oauth_session_needs_refresh(session: &SoundCloudSession) -> bool {
    session.credential_kind != CREDENTIAL_BROWSER
        && !session.refresh_token.is_empty()
        && session.expires_at > 0
        && session.expires_at <= unix_now() + 60
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn random_token() -> String {
    format!(
        "{:032x}{:032x}",
        rand::random::<u128>(),
        rand::random::<u128>()
    )
}

fn oauth_error(body: &Value) -> String {
    body.get("error_description")
        .or_else(|| body.get("error"))
        .or_else(|| body.get("message"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            body.get("errors")
                .and_then(Value::as_array)
                .and_then(|errors| errors.first())
                .and_then(|error| error.get("error_message").or_else(|| error.get("message")))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "登录态已被 SoundCloud 拒绝".into())
}

fn value_id(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_i64().map(|number| number.to_string()))
        .or_else(|| value.as_u64().map(|number| number.to_string()))
        .unwrap_or_default()
}

fn collection(body: &Value) -> &[Value] {
    body.as_array()
        .map(Vec::as_slice)
        .or_else(|| {
            body.get("collection")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
        })
        .unwrap_or(&[])
}

fn soundcloud_like_track(entry: &Value) -> Option<&Value> {
    entry
        .get("track")
        .or_else(|| (entry.get("kind").and_then(Value::as_str) == Some("track")).then_some(entry))
}

fn soundcloud_like_playlist(entry: &Value) -> Option<&Value> {
    entry.get("playlist").or_else(|| {
        matches!(
            entry.get("kind").and_then(Value::as_str),
            Some("playlist" | "system-playlist")
        )
        .then_some(entry)
    })
}

fn soundcloud_playlist_owned_by(entry: &Value, user_id: &str) -> bool {
    let owner_id = entry
        .get("user_id")
        .map(value_id)
        .filter(|value| !value.is_empty())
        .or_else(|| entry.pointer("/user/id").map(value_id))
        .or_else(|| {
            entry
                .pointer("/user/urn")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    owner_id
        .map(|owner| {
            owner.trim_start_matches("soundcloud:users:")
                == user_id.trim_start_matches("soundcloud:users:")
        })
        .unwrap_or(false)
}

fn normalize_soundcloud_urn(value: &str, resource: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let prefix = format!("soundcloud:{resource}:");
    if value.starts_with(&prefix) {
        return Some(value.to_string());
    }
    if value.starts_with("soundcloud:") || !value.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some(format!("{prefix}{value}"))
}

fn soundcloud_legacy_id(value: &str) -> Option<String> {
    value
        .trim()
        .rsplit(':')
        .next()
        .filter(|id| !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()))
        .map(str::to_string)
}

fn soundcloud_value_urn(value: &Value, resource: &str) -> Option<String> {
    let legacy_field = match resource {
        "tracks" => "track_id",
        "playlists" => "playlist_id",
        "users" => "user_id",
        _ => "id",
    };
    value
        .get("urn")
        .and_then(Value::as_str)
        .and_then(|urn| normalize_soundcloud_urn(urn, resource))
        .or_else(|| {
            value
                .get("id")
                .or_else(|| value.get(legacy_field))
                .map(value_id)
                .and_then(|id| normalize_soundcloud_urn(&id, resource))
        })
}

fn soundcloud_source_urn(source: &SongSource) -> Option<String> {
    source
        .payload
        .get("urn")
        .and_then(Value::as_str)
        .and_then(|urn| normalize_soundcloud_urn(urn, "tracks"))
        .or_else(|| normalize_soundcloud_urn(&source.key, "tracks"))
}

fn soundcloud_same_resource(left: &str, right: &str) -> bool {
    left == right
        || left.rsplit(':').next().filter(|value| !value.is_empty())
            == right.rsplit(':').next().filter(|value| !value.is_empty())
}

fn soundcloud_playlist(entry: &Value, origin: &str) -> Option<kdj_core::models::StreamPlaylist> {
    let key = soundcloud_value_urn(entry, "playlists")?;
    let tracks = entry.get("tracks").and_then(Value::as_array);
    Some(kdj_core::models::StreamPlaylist {
        platform: Platform::Soundcloud,
        key,
        title: str_field(entry, "title")
            .unwrap_or("SoundCloud 歌单")
            .to_string(),
        cover: str_field(entry, "artwork_url")
            .or_else(|| str_field(entry, "artwork_url_large"))
            .unwrap_or_default()
            .to_string(),
        count: entry
            .get("track_count")
            .map(|value| value_id(value).parse::<usize>().unwrap_or(0))
            .filter(|count| *count > 0)
            .or_else(|| tracks.map(|items| items.len()))
            .unwrap_or(0),
        is_favorite: false,
        origin: origin.to_string(),
    })
}

fn dedup_playlists(
    playlists: Vec<kdj_core::models::StreamPlaylist>,
) -> Vec<kdj_core::models::StreamPlaylist> {
    let mut out = Vec::with_capacity(playlists.len());
    for playlist in playlists {
        if out.iter().any(|item: &kdj_core::models::StreamPlaylist| {
            item.key == playlist.key && item.platform == playlist.platform
        }) {
            continue;
        }
        out.push(playlist);
    }
    out
}

fn truncate(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let result: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{result}…")
    } else {
        result
    }
}

/// 抓出 `<script ... src="https://a-v2.sndcdn.com/assets/xxx.js">` 里的地址。
fn extract_script_urls(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find("<script") {
        rest = &rest[start..];
        let Some(tag_end) = rest.find('>') else { break };
        let tag = &rest[..tag_end];
        if let Some(src_at) = tag.find("src=\"") {
            let after = &tag[src_at + 5..];
            if let Some(quote) = after.find('"') {
                let url = &after[..quote];
                if url.starts_with("https://") && url.ends_with(".js") {
                    out.push(url.to_string());
                }
            }
        }
        rest = &rest[tag_end..];
    }
    out
}

/// 从 JS bundle 里抠 `client_id:"xxxx"` / `client_id=xxxx`。
fn extract_client_id(js: &str) -> Option<String> {
    for marker in ["client_id:\"", "client_id=\"", "clientId:\""] {
        if let Some(at) = js.find(marker) {
            let after = &js[at + marker.len()..];
            let id: String = after
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            if id.len() >= 16 {
                return Some(id);
            }
        }
    }
    // `client_id=abc123&` 这种拼在 query 里的写法
    let mut rest = js;
    while let Some(at) = rest.find("client_id=") {
        let after = &rest[at + "client_id=".len()..];
        let id: String = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        if id.len() >= 16 {
            return Some(id);
        }
        rest = &after[id.len().max(1)..];
    }
    None
}

/// 从 `media.transcodings[]` 里挑一个能直接流式下载的。
///
/// 优先 progressive（就是一个 MP3 直链）。HLS 要自己拼分片，
/// 而 SoundCloud 免费流基本都提供 progressive，所以先不实现 HLS。
fn pick_transcoding(track: &Value) -> Option<(String, String)> {
    let list = track
        .pointer("/media/transcodings")
        .and_then(Value::as_array)?;
    let mut fallback = None;
    for item in list {
        // 缺 url 的条目要**跳过**而不是让整个函数返回 None：
        // transcodings 数组里偶尔混进没有 url 的占位项，`?` 会连后面的
        // progressive 直链一起丢掉，表现成"没有可用的音频流"。
        let Some(url) = item
            .get("url")
            .and_then(Value::as_str)
            .filter(|u| !u.is_empty())
        else {
            continue;
        };
        let protocol = item
            .pointer("/format/protocol")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mime = item
            .pointer("/format/mime_type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let ext = if mime.contains("ogg") || mime.contains("opus") {
            "opus"
        } else {
            "mp3"
        };
        if protocol == "progressive" {
            return Some((url.to_string(), ext.to_string()));
        }
        fallback.get_or_insert((url.to_string(), ext.to_string()));
    }
    fallback
}

fn to_source(track: &Value) -> Option<SongSource> {
    if track.get("kind").and_then(Value::as_str) == Some("playlist") {
        return None;
    }
    let permalink = str_field(track, "permalink_url").unwrap_or_default();
    let id = soundcloud_value_urn(track, "tracks").unwrap_or_else(|| permalink.to_string());
    if id.is_empty() {
        return None;
    }

    let uploader = track
        .pointer("/user/username")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let artist = track
        .get("publisher_metadata")
        .and_then(|meta| str_field(meta, "artist"))
        .unwrap_or(uploader);

    let cover = str_field(track, "artwork_url")
        .or_else(|| track.pointer("/user/avatar_url").and_then(Value::as_str))
        .unwrap_or_default();

    let mut payload = Map::new();
    payload.insert("permalink_url".into(), Value::String(permalink.to_string()));
    if let Some(urn) = soundcloud_value_urn(track, "tracks") {
        payload.insert("urn".into(), Value::String(urn));
    }
    if let Some((transcoding, ext)) = pick_transcoding(track) {
        payload.insert("transcoding_url".into(), Value::String(transcoding));
        payload.insert("transcoding_ext".into(), Value::String(ext));
    }

    Some(SongSource {
        platform: Platform::Soundcloud,
        key: id,
        title: str_field(track, "title").unwrap_or("Unknown").to_string(),
        artists: if artist.is_empty() {
            vec!["Unknown".to_string()]
        } else {
            vec![artist.to_string()]
        },
        album: track
            .get("publisher_metadata")
            .and_then(|meta| str_field(meta, "album_title"))
            .unwrap_or_default()
            .to_string(),
        // duration 是毫秒
        duration: track
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|value| *value > 0.0)
            .map(|ms| ms / 1000.0),
        cover: cover.to_string(),
        // SoundCloud 免费流最高就是 128kbps mp3 / opus
        max_quality: Some(Quality::Q128),
        vip: false,
        payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn guarded_soundcloud_targets_stay_on_official_hosts() {
        let transcoding = url::Url::parse(
            "https://api-v2.soundcloud.com/media/soundcloud:tracks:1/stream/progressive",
        )
        .unwrap();
        let oauth_api = url::Url::parse("https://api.soundcloud.com/tracks/1/stream").unwrap();
        let disguised =
            url::Url::parse("https://api-v2.soundcloud.com.evil.example/stream").unwrap();
        let cover = url::Url::parse("https://i1.sndcdn.com/artworks-test-t500x500.jpg").unwrap();
        let disguised_cover = url::Url::parse("https://sndcdn.com.evil.example/cover.jpg").unwrap();

        assert!(soundcloud_transcoding_target(&transcoding));
        assert!(soundcloud_transcoding_target(&oauth_api));
        assert!(!soundcloud_transcoding_target(&disguised));
        assert!(soundcloud_cover_target(&cover));
        assert!(!soundcloud_cover_target(&disguised_cover));
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn browser_cookie(
        domain: &str,
        name: &str,
        value: &str,
        expires: u64,
    ) -> rookie::enums::Cookie {
        rookie::enums::Cookie {
            domain: domain.into(),
            path: "/".into(),
            secure: true,
            expires: Some(expires),
            name: name.into(),
            value: value.into(),
            http_only: false,
            same_site: 0,
        }
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn browser_profile_import_keeps_only_a_live_soundcloud_oauth_cookie() {
        let now = unix_now() as u64;
        let session = browser_session_from_profile(crate::browser::BrowserProfileCookies {
            imported_from: "Arc · Default".into(),
            cookies: vec![
                browser_cookie(".soundcloud.com", "oauth_token", "expired", now - 1),
                browser_cookie(".soundcloud.com", "other", "ignored", now + 600),
                browser_cookie(".soundcloud.com", "oauth_token", "live-token", now + 600),
            ],
        })
        .unwrap();
        assert_eq!(session.access_token, "live-token");
        assert_eq!(session.credential_kind, CREDENTIAL_BROWSER);
        assert_eq!(session.imported_from, "Arc · Default");
        assert!(!oauth_session_needs_refresh(&session));
    }

    #[test]
    fn isolated_webview_session_rejects_blank_or_expired_tokens() {
        assert!(browser_session_from_token(String::new(), 0, "登录窗口".into()).is_err());
        assert!(browser_session_from_token(
            "expired-token".into(),
            unix_now() - 1,
            "登录窗口".into(),
        )
        .is_err());

        let session = browser_session_from_token(
            "  live-token  ".into(),
            unix_now() + 600,
            "登录窗口".into(),
        )
        .unwrap();
        assert_eq!(session.access_token, "live-token");
        assert_eq!(session.credential_kind, CREDENTIAL_BROWSER);
        assert_eq!(session.imported_from, "登录窗口");
    }

    #[test]
    fn legacy_saved_sessions_remain_oauth_credentials() {
        let session: SoundCloudSession = serde_json::from_value(json!({
            "access_token": "token",
            "refresh_token": "refresh",
            "expires_at": unix_now() + 30
        }))
        .unwrap();
        assert_eq!(session.credential_kind, CREDENTIAL_OAUTH);
        assert!(oauth_session_needs_refresh(&session));
    }

    #[test]
    fn default_soundcloud_avatar_falls_back_to_the_platform_mark() {
        let profile =
            json!({"avatar_url": "https://a1.sndcdn.com/images/default_avatar_large.png"});
        assert_eq!(soundcloud_avatar(&profile, ""), "");
        assert_eq!(
            soundcloud_avatar(&json!({}), "https://i1.sndcdn.com/avatars-real-large.jpg"),
            "https://i1.sndcdn.com/avatars-real-large.jpg"
        );
    }

    #[test]
    fn web_likes_split_tracks_from_playlists() {
        let track = json!({"track": {"kind": "track", "id": 1}});
        let playlist = json!({"playlist": {"kind": "playlist", "id": 2}});
        assert_eq!(
            soundcloud_like_track(&track)
                .and_then(|item| item.get("id"))
                .and_then(Value::as_i64),
            Some(1)
        );
        assert!(soundcloud_like_playlist(&track).is_none());
        assert_eq!(
            soundcloud_like_playlist(&playlist)
                .and_then(|item| item.get("id"))
                .and_then(Value::as_i64),
            Some(2)
        );
    }

    #[test]
    fn web_playlist_directory_unwraps_and_classifies_owned_sets() {
        let owned = json!({
            "type": "playlist",
            "playlist": {
                "kind": "playlist",
                "id": 2,
                "title": "自己的列表",
                "user_id": 1669723679,
                "track_count": 4
            }
        });
        let collected = json!({
            "type": "playlist",
            "playlist": {
                "kind": "playlist",
                "id": 3,
                "title": "收藏的列表",
                "user": {"urn": "soundcloud:users:42"},
                "track_count": 8
            }
        });
        let owned_playlist = soundcloud_like_playlist(&owned).unwrap();
        let collected_playlist = soundcloud_like_playlist(&collected).unwrap();
        assert!(soundcloud_playlist_owned_by(
            owned_playlist,
            "soundcloud:users:1669723679"
        ));
        assert!(!soundcloud_playlist_owned_by(
            collected_playlist,
            "1669723679"
        ));
        assert_eq!(
            soundcloud_playlist(owned_playlist, "created")
                .unwrap()
                .title,
            "自己的列表"
        );
    }

    #[test]
    fn script_urls_are_pulled_out_of_the_homepage() {
        let html = r#"
            <script src="https://a-v2.sndcdn.com/assets/0-abc.js"></script>
            <script>inline()</script>
            <script src="/relative.js"></script>
            <script src="https://a-v2.sndcdn.com/assets/9-zzz.js" crossorigin></script>
        "#;
        assert_eq!(
            extract_script_urls(html),
            vec![
                "https://a-v2.sndcdn.com/assets/0-abc.js",
                "https://a-v2.sndcdn.com/assets/9-zzz.js"
            ]
        );
    }

    #[test]
    fn client_id_is_found_in_every_shape_we_have_seen() {
        assert_eq!(
            extract_client_id(r#"o={client_id:"iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX"}"#).as_deref(),
            Some("iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX")
        );
        assert_eq!(
            extract_client_id(r#"url+"?client_id=abcdefghij0123456789&x=1""#).as_deref(),
            Some("abcdefghij0123456789")
        );
        // 太短的不是 client_id，别误抓
        assert_eq!(extract_client_id(r#"client_id="short""#), None);
        assert_eq!(extract_client_id("no id here"), None);
    }

    #[test]
    fn progressive_transcoding_wins_over_hls() {
        let track = json!({"media": {"transcodings": [
            {"url": "https://api/hls", "format": {"protocol": "hls", "mime_type": "audio/mpeg"}},
            {"url": "https://api/prog", "format": {"protocol": "progressive", "mime_type": "audio/mpeg"}}
        ]}});
        assert_eq!(
            pick_transcoding(&track),
            Some(("https://api/prog".into(), "mp3".into()))
        );
    }

    #[test]
    fn hls_is_kept_as_a_fallback_rather_than_failing() {
        let track = json!({"media": {"transcodings": [
            {"url": "https://api/hls", "format": {"protocol": "hls", "mime_type": "audio/ogg"}}
        ]}});
        assert_eq!(
            pick_transcoding(&track),
            Some(("https://api/hls".into(), "opus".into()))
        );
        assert_eq!(pick_transcoding(&json!({})), None);
    }

    #[test]
    fn track_normalization_prefers_publisher_artist_over_uploader() {
        let track = json!({
            "kind": "track",
            "id": 12345,
            "title": "Nightdrive",
            "permalink_url": "https://soundcloud.com/dj/nightdrive",
            "duration": 245000,
            "artwork_url": "https://i1.sndcdn.com/artworks-abc-large.jpg",
            "user": {"username": "uploader-account"},
            "publisher_metadata": {"artist": "Real Artist", "album_title": "Night"},
            "media": {"transcodings": [
                {"url": "https://api/prog", "format": {"protocol": "progressive", "mime_type": "audio/mpeg"}}
            ]}
        });
        let source = to_source(&track).unwrap();
        assert_eq!(source.key, "soundcloud:tracks:12345");
        assert_eq!(
            source.payload.get("urn").and_then(Value::as_str),
            Some("soundcloud:tracks:12345")
        );
        assert_eq!(source.artists, vec!["Real Artist"]);
        assert_eq!(source.album, "Night");
        assert_eq!(source.duration, Some(245.0), "duration 是毫秒");
        assert_eq!(source.max_quality, Some(Quality::Q128));
        assert_eq!(
            source.payload.get("transcoding_url").unwrap(),
            "https://api/prog"
        );
    }

    #[test]
    fn soundcloud_write_identifiers_use_urns_but_accept_legacy_numeric_ids() {
        assert_eq!(
            normalize_soundcloud_urn("123", "tracks").as_deref(),
            Some("soundcloud:tracks:123")
        );
        assert_eq!(
            normalize_soundcloud_urn("soundcloud:playlists:456", "playlists").as_deref(),
            Some("soundcloud:playlists:456")
        );
        assert!(normalize_soundcloud_urn("https://soundcloud.com/x", "tracks").is_none());
        assert!(soundcloud_same_resource(
            "soundcloud:tracks:123",
            "soundcloud:tracks:123"
        ));
    }

    #[test]
    fn uploader_is_used_when_there_is_no_publisher_metadata() {
        let track = json!({
            "kind": "track", "id": 1, "title": "x",
            "user": {"username": "uploader-account"}
        });
        assert_eq!(to_source(&track).unwrap().artists, vec!["uploader-account"]);
    }

    #[test]
    fn a_transcoding_without_a_url_does_not_kill_the_whole_list() {
        // 真实响应里偶尔混进没有 url 的占位条目。以前 `?` 会让整个函数返回 None，
        // 后面的 progressive 直链一起丢掉，表现成"没有可用的音频流"。
        let track = json!({"media": {"transcodings": [
            {"format": {"protocol": "progressive", "mime_type": "audio/mpeg"}},
            {"url": "", "format": {"protocol": "hls", "mime_type": "audio/mpeg"}},
            {"url": "https://api/prog", "format": {"protocol": "progressive", "mime_type": "audio/mpeg"}}
        ]}});
        assert_eq!(
            pick_transcoding(&track),
            Some(("https://api/prog".into(), "mp3".into()))
        );
    }

    #[test]
    fn empty_strings_fall_through_like_the_python_or_chain() {
        let track = json!({
            "kind": "track", "id": 7, "title": "",
            "artwork_url": "",
            "user": {"username": "uploader", "avatar_url": "https://i/avatar.jpg"},
            "publisher_metadata": {"artist": "", "album_title": ""}
        });
        let source = to_source(&track).unwrap();
        assert_eq!(source.title, "Unknown", "空标题要退回 Unknown");
        assert_eq!(source.artists, vec!["uploader"], "空 artist 要退回上传者");
        assert_eq!(source.album, "");
        assert_eq!(source.cover, "https://i/avatar.jpg", "空封面要退回头像");
    }

    #[test]
    fn playlists_are_not_mistaken_for_tracks() {
        assert!(to_source(&json!({"kind": "playlist", "id": 1, "title": "set"})).is_none());
    }
}
