//! Google OAuth 设备码登录（ytmusicapi 同款流程）。
//!
//! 为什么是设备码而不是扫码/浏览器回调：
//! - YouTube Music 没有自己的扫码登录，走的是 Google OAuth；
//! - 设备码流程（RFC 8628）天生为电视/CLI 设计：后端拿到 `user_code`，
//!   用户在任何设备的浏览器里打开 youtube.com/activate 输入即可，
//!   不需要回调 URL、不需要注册自定义协议——桌面和安卓壳都能用；
//! - 这就是 ytmusicapi `setup_oauth()` 与 yt-dlp `--username oauth` 的做法。
//!
//! OAuth client 凭据由开发/打包环境提供（和 SoundCloud 同一条规则）：
//! 应用凭据不是用户偏好，不能写进 settings.json，更不能跟着
//! GET /api/settings 回到 WebView。发布构建可在打包时注入
//! `KDJ_YTM_OAUTH_CLIENT_ID` / `KDJ_YTM_OAUTH_CLIENT_SECRET`
//! 烧进二进制作为默认值（见 provider 的 `oauth_credentials`），
//! 运行时环境变量仍可覆盖。

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// OAuth 要申请的权限。ytmusicapi 用同一个 scope。
pub const OAUTH_SCOPE: &str = "https://www.googleapis.com/auth/youtube";
const DEVICE_CODE_URL: &str = "https://www.youtube.com/o/oauth2/device/code";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

/// 登录态落盘文件里的形状（access + refresh 两个 token）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthSession {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub expires_at: i64,
}

impl OAuthSession {
    /// access token 是否临近过期（还剩不到一分钟）。
    pub fn expiring(&self) -> bool {
        self.expires_at <= unix_now() + 60
    }
}

/// 一次设备码登录会话（内存态，进程内有效）。
#[derive(Debug, Clone)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub expires_in: u64,
    pub created_at: Instant,
}

impl DeviceCode {
    pub fn expired(&self) -> bool {
        self.created_at.elapsed() >= Duration::from_secs(self.expires_in.max(1))
    }
}

/// 轮询设备码的结果。
#[derive(Debug)]
pub enum DevicePoll {
    /// 用户还没完成授权（或 Google 还没感知到），继续等。
    Pending,
    /// 服务端嫌轮询太快，下次间隔加长。
    SlowDown,
    /// 授权成功，拿到 token。
    Done(OAuthSession),
    /// 用户拒绝 / 会话过期。
    Failed(String),
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// 第一步：向 Google 申请一个设备码。
pub async fn begin_device_code(
    http: &reqwest::Client,
    client_id: &str,
) -> Result<DeviceCode> {
    let response = http
        .post(DEVICE_CODE_URL)
        .form(&[("client_id", client_id), ("scope", OAUTH_SCOPE)])
        .send()
        .await
        .context("申请 YouTube Music 登录码失败")?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .context("解析 YouTube Music 登录码响应失败")?;
    if !status.is_success() {
        bail!(
            "申请 YouTube Music 登录码失败：{}",
            oauth_error(&body)
        );
    }
    let device_code = required_str(&body, "device_code", "device_code")?;
    let user_code = required_str(&body, "user_code", "user_code")?;
    let verification_url = required_str(&body, "verification_url", "verification_url")?;
    let expires_in = body
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(15 * 60);
    Ok(DeviceCode {
        device_code,
        user_code,
        verification_url,
        expires_in,
        created_at: Instant::now(),
    })
}

/// 第二步起：用设备码轮询/兑换 token。
pub async fn poll_device_code(
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    device_code: &str,
) -> Result<DevicePoll> {
    let response = http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("grant_type", "http://oauth.net/grant_type/device/1.0"),
            ("code", device_code),
        ])
        .send()
        .await
        .context("检查 YouTube Music 登录状态失败")?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .context("解析 YouTube Music 登录状态响应失败")?;
    if status.is_success() {
        let access_token = required_str(&body, "access_token", "access_token")?;
        let refresh_token = body
            .get("refresh_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let expires_in = body
            .get("expires_in")
            .and_then(Value::as_i64)
            .unwrap_or(3600);
        return Ok(DevicePoll::Done(OAuthSession {
            access_token,
            refresh_token,
            expires_at: unix_now() + expires_in,
        }));
    }
    match body.get("error").and_then(Value::as_str).unwrap_or_default() {
        // 还没授权完，继续等；Google 建议按 interval 轮询
        "authorization_pending" => Ok(DevicePoll::Pending),
        "slow_down" => Ok(DevicePoll::SlowDown),
        "access_denied" => Ok(DevicePoll::Failed("已拒绝授权".into())),
        "expired_token" => Ok(DevicePoll::Failed("登录码已过期，请重新发起".into())),
        other => Ok(DevicePoll::Failed(format!(
            "登录状态检查失败：{}",
            oauth_error_hint(other, &body)
        ))),
    }
}

/// 刷新 access token（refresh token 通常长期有效）。
pub async fn refresh_token(
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<OAuthSession> {
    let response = http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .context("刷新 YouTube Music 登录态失败")?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .context("解析 YouTube Music 刷新响应失败")?;
    if !status.is_success() {
        bail!(
            "YouTube Music 登录已过期：{}",
            oauth_error(&body)
        );
    }
    let access_token = required_str(&body, "access_token", "access_token")?;
    let expires_in = body
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);
    Ok(OAuthSession {
        access_token,
        // 部分 Google 客户端 refresh 时也回新的 refresh token
        refresh_token: body
            .get("refresh_token")
            .and_then(Value::as_str)
            .unwrap_or(refresh_token)
            .to_string(),
        expires_at: unix_now() + expires_in,
    })
}

fn required_str(body: &Value, key: &str, what: &str) -> Result<String> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .with_context(|| format!("登录响应缺少 {what}"))
}

fn oauth_error(body: &Value) -> String {
    body.get("error_description")
        .or_else(|| body.get("error"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("未知错误")
        .to_string()
}

fn oauth_error_hint(code: &str, body: &Value) -> String {
    if code.is_empty() {
        oauth_error(body)
    } else {
        format!("{code}（{}）", oauth_error(body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_expiry_is_checked_against_the_clock() {
        let fresh = OAuthSession {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: unix_now() + 600,
        };
        assert!(!fresh.expiring());
        let dying = OAuthSession {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: unix_now() + 10,
        };
        assert!(dying.expiring());
    }

    #[test]
    fn device_code_expiry_uses_its_own_clock() {
        let code = DeviceCode {
            device_code: "d".into(),
            user_code: "ABCD-EFGH".into(),
            verification_url: "https://www.youtube.com/activate".into(),
            expires_in: 900,
            created_at: Instant::now(),
        };
        assert!(!code.expired());
    }

    #[test]
    fn session_roundtrips_through_json_with_defaults() {
        // 老版本文件没有 refresh_token 时也要能读
        let parsed: OAuthSession = serde_json::from_str(r#"{"access_token":"a","expires_at":1}"#).unwrap();
        assert_eq!(parsed.refresh_token, "");
    }
}
