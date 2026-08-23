//! YouTube Music 的 InnerTube API 封装。
//!
//! YouTube 没有公开 API；网页/App 用的都是同一个 `youtubei/v1` 端点，
//! 客户端身份由 body 里的 `context.client.clientName` 决定：
//! - `WEB_REMIX`：music.youtube.com 网页端，搜索和歌单浏览用它；
//! - `ANDROID`：安卓主客户端，取播放信息/音频流用它（`ANDROID_MUSIC`
//!   已和 yt-dlp 一样弃用——实测它现在只回 LOGIN_REQUIRED）。
//!
//! API key、客户端版本、搜索 filter 参数都与 ytmusicapi（社区维护的
//! YouTube Music 客户端库）保持一致；key 是刻在网页端里的公开常量，
//! 允许用 `KDJ_YTM_INNERTUBE_KEY` 覆盖，key 轮换时不用等发版。

use std::sync::{Arc, RwLock};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::net::http_timeouts;
use super::decipher::PlayerScript;

pub const BASE: &str = "https://music.youtube.com/youtubei/v1";
/// music.youtube.com 网页端的公开 InnerTube key（ytmusicapi 同款）。
const DEFAULT_INNERTUBE_KEY: &str = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";

/// 安卓主客户端的版本（yt-dlp 当前使用的 ANDROID 客户端同款）。
const ANDROID_VERSION: &str = "21.26.364";

/// 只搜单曲的 filter 参数（ytmusicapi 的 songs filter 同款）。
pub const SONG_FILTER_PARAMS: &str = "EgWKAQIIAWoMEA4QChADEAQQCRAF";

/// 网页端版本号跟着日期走（ytmusicapi 的做法）：YouTube 会拒绝过老的
/// 客户端版本，写死一个版本号迟早失效，`1.YYYYMMDD.01.00` 永远"够新"。
fn web_remix_version() -> String {
    format!("1.{}.01.00", current_date_yyyymmdd())
}

/// 从系统时钟算今天的 `YYYYMMDD`。只有版本号用，允许时钟拨错年份。
fn current_date_yyyymmdd() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    format!("{year:04}{month:02}{day:02}")
}

/// Howard Hinnant 的 `civil_from_days` 公历算法：天序数 → 年月日。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// 播放器脚本缓存：没有 / 只知道地址 / 已经解析好。URL 变了（发版）重新拉取。
enum ScriptState {
    None,
    Pending(String),
    Ready(String, Arc<PlayerScript>),
}

type ScriptCache = RwLock<ScriptState>;

pub struct YtmClient {
    http: reqwest::Client,
    innertube_key: String,
    script: ScriptCache,
    /// 登录后的 access token；有值时所有请求都带 `Authorization: Bearer`。
    /// YouTube 对登录态客户端放宽播放流限制（会员直接放行自适应流）。
    access_token: RwLock<Option<String>>,
}

impl YtmClient {
    pub fn new() -> Result<Self> {
        let http = http_timeouts(
            reqwest::Client::builder().user_agent(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            ),
        )
        .build()
        .context("构建 YouTube Music HTTP 客户端失败")?;
        Ok(YtmClient {
            http,
            innertube_key: env_or("KDJ_YTM_INNERTUBE_KEY", DEFAULT_INNERTUBE_KEY),
            script: RwLock::new(ScriptState::None),
            access_token: RwLock::new(None),
        })
    }

    /// provider 登录/登出后同步登录态到这里。
    pub fn set_access_token(&self, token: Option<String>) {
        *self.access_token.write().unwrap() = token;
    }

    fn web_remix_context() -> Value {
        json!({
            "context": {
                "client": {
                    "clientName": "WEB_REMIX",
                    "clientVersion": web_remix_version(),
                    // 界面语言要中文；地区不能写 CN——YouTube Music 不在大陆服务，
                    // 写成 CN 只会平白少内容（实际生效地区仍由出口 IP 决定）。
                    "hl": "zh-CN",
                    "gl": "US",
                },
                "user": { "lockedSafetyMode": false },
            }
        })
    }

    fn android_context() -> Value {
        json!({
            "context": {
                "client": {
                    "clientName": "ANDROID",
                    "clientVersion": ANDROID_VERSION,
                    "androidSdkVersion": 30,
                    "hl": "en",
                    "gl": "US",
                },
            }
        })
    }

    async fn post(&self, endpoint: &str, body: Value) -> Result<Value> {
        let url = format!(
            "{BASE}/{endpoint}?key={}&prettyPrint=false",
            self.innertube_key
        );
        let mut request = self.http.post(&url).json(&body);
        if let Some(token) = self.access_token.read().unwrap().clone() {
            // ytmusicapi 的 OAuth 模式同款：Bearer 之外还要带请求时刻，
            // Google 用它校验 token 新鲜度，缺了会被当成可疑客户端。
            request = request
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
                .header("X-Goog-Request-Time", unix_now().to_string());
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("YouTube Music 请求失败：{endpoint}"))?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .with_context(|| format!("YouTube Music 响应不是合法 JSON：{endpoint}"))?;
        if !status.is_success() {
            let detail = payload
                .pointer("/error/message")
                .or_else(|| payload.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("");
            bail!("YouTube Music 接口返回 {status}：{endpoint} {detail}");
        }
        Ok(payload)
    }

    /// provider 下载流 / 拉封面要用同一个 client（共享连接池与超时配置）。
    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// 搜单曲。返回原始 JSON，解析在 provider 里做。
    pub async fn search_songs(&self, query: &str) -> Result<Value> {
        let mut body = Self::web_remix_context();
        let map = body.as_object_mut().expect("context 一定是对象");
        map.insert("query".into(), Value::String(query.to_string()));
        map.insert("params".into(), Value::String(SONG_FILTER_PARAMS.to_string()));
        self.post("search", body).await
    }

    /// 取视频的播放信息（流、标题、艺人、封面）。
    /// 未登录时用 ANDROID（匿名也能拿元数据和播放状态）；登录后用
    /// `WEB_REMIX`（YouTube 对带登录态的网页客户端放宽播放流限制）。
    pub async fn player(&self, video_id: &str, use_web: bool) -> Result<Value> {
        let mut body = if use_web {
            Self::web_remix_context()
        } else {
            Self::android_context()
        };
        let map = body.as_object_mut().expect("context 一定是对象");
        map.insert("videoId".into(), Value::String(video_id.to_string()));
        let payload = self.post("player", body).await?;
        // player 响应里顺路给播放器脚本地址；URL 变了（发版）就作废缓存
        if let Some(url) = payload.pointer("/assets/js").and_then(Value::as_str) {
            self.refresh_script_url(url);
        }
        Ok(payload)
    }

    /// 浏览歌单（browseId 是 `VL` + 歌单 id）。
    pub async fn browse(&self, browse_id: &str) -> Result<Value> {
        let mut body = Self::web_remix_context();
        let map = body.as_object_mut().expect("context 一定是对象");
        map.insert("browseId".into(), Value::String(browse_id.to_string()));
        self.post("browse", body).await
    }

    /// 取（并缓存）播放器脚本，供签名解密用。解析成功前不缓存，下次重试。
    pub async fn player_script(&self) -> Result<Arc<PlayerScript>> {
        let url = {
            let guard = self.script.read().unwrap();
            if let ScriptState::Ready(_, script) = &*guard {
                return Ok(script.clone());
            }
            match &*guard {
                ScriptState::Pending(url) => Some(url.clone()),
                _ => None,
            }
        };
        let (url, js) = match url {
            Some(url) => match self.fetch_text(&url).await {
                Ok(js) => (url, js),
                Err(err) => {
                    tracing::warn!("拉取记录的播放器脚本失败，改从首页找：{err:#}");
                    self.script_url_from_homepage().await?
                }
            },
            None => self.script_url_from_homepage().await?,
        };
        let script = Arc::new(PlayerScript::parse(&js)?);
        *self.script.write().unwrap() = ScriptState::Ready(url, script.clone());
        Ok(script)
    }

    /// 首页 ytcfg 里的 jsUrl；读不到时把整段首页 HTML 扫一遍。
    async fn script_url_from_homepage(&self) -> Result<(String, String)> {
        let html = self
            .http
            .get("https://music.youtube.com/")
            .send()
            .await
            .context("打开 YouTube Music 首页失败")?
            .error_for_status()
            .context("YouTube Music 首页返回错误")?
            .text()
            .await
            .context("读取 YouTube Music 首页失败")?;
        let url = extract_player_url(&html).context("从首页找不到播放器脚本地址")?;
        let js = self.fetch_text(&url).await?;
        Ok((url, js))
    }

    async fn fetch_text(&self, url: &str) -> Result<String> {
        Ok(self
            .http
            .get(url)
            .send()
            .await
            .context("下载播放器脚本失败")?
            .error_for_status()
            .context("播放器脚本返回错误")?
            .text()
            .await
            .context("读取播放器脚本失败")?)
    }

    /// player 响应里的 `assets.js`。URL 变了说明发版：作废旧缓存。
    pub fn refresh_script_url(&self, url: &str) {
        if url.is_empty() {
            return;
        }
        let mut state = self.script.write().unwrap();
        match &*state {
            ScriptState::Ready(cached, _) | ScriptState::Pending(cached) if cached == url => {}
            _ => *state = ScriptState::Pending(url.to_string()),
        }
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// 从首页 HTML 里抠播放器脚本地址。两种写法都要认：
/// - `"jsUrl":"https://www.youtube.com/s/player/.../base.js"`
/// - `"jsUrl":"\/s\/player\/...\/base.js"`（JSON 转义过的）
pub fn extract_player_url(html: &str) -> Option<String> {
    let marker = "\"jsUrl\":\"";
    let start = html.find(marker)? + marker.len();
    let rest = &html[start..];
    let end = rest.find('"')?;
    let raw = &rest[..end];
    let unescaped = raw.replace("\\/", "/");
    if !unescaped.starts_with("https://") && !unescaped.starts_with("http://") {
        return Some(format!("https://www.youtube.com{unescaped}"));
    }
    Some(unescaped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_url_is_extracted_from_escaped_ytcfg() {
        let html = r#"{"XSRF_TOKEN":"x","jsUrl":"\/s\/player\/abc\/player_ias.vflset\/zh_CN\/base.js"}"#;
        assert_eq!(
            extract_player_url(html).as_deref(),
            Some("https://www.youtube.com/s/player/abc/player_ias.vflset/zh_CN/base.js")
        );
    }

    #[test]
    fn player_url_is_extracted_from_full_url_ytcfg() {
        let html = r#"{"jsUrl":"https://www.youtube.com/s/player/xyz/base.js","other":1}"#;
        assert_eq!(
            extract_player_url(html).as_deref(),
            Some("https://www.youtube.com/s/player/xyz/base.js")
        );
    }

    #[test]
    fn missing_js_url_yields_none() {
        assert_eq!(extract_player_url("<html>no cfg</html>"), None);
    }

    #[test]
    fn civil_date_algorithm_matches_known_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1), "UNIX 纪元");
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(19_723 + 365), (2024, 12, 31), "2024 是闰年");
        assert_eq!(civil_from_days(-1), (1969, 12, 31), "纪元前一天");
    }
}
