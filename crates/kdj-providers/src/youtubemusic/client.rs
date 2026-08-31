//! YouTube Music 的 InnerTube API 封装。
//!
//! YouTube 没有公开 API；网页/App 用的都是同一个 `youtubei/v1` 端点，
//! 客户端身份由 body 里的 `context.client.clientName` 决定：
//! - `WEB_REMIX`：music.youtube.com 网页端，搜索和歌单浏览用它；
//! - `IOS`：取播放信息/音频流。Web 已迁到 WASM 签名器、Android 已逐步只给
//!   SABR；iOS 仍返回原生播放器可直接 Range 读取的 HTTPS 音频 URL。
//!
//! API key、客户端版本、搜索 filter 参数都与 ytmusicapi（社区维护的
//! YouTube Music 客户端库）保持一致；key 是刻在网页端里的公开常量，
//! 允许用 `KDJ_YTM_INNERTUBE_KEY` 覆盖，key 轮换时不用等发版。

use std::sync::{Arc, RwLock};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::auth::YoutubeAuth;
use super::decipher::PlayerScript;
use crate::net::http_timeouts;
use crate::provider::{ProtectedPoTokenBinding, ProtectedPreviewIdentity};

pub const BASE: &str = "https://music.youtube.com/youtubei/v1";
/// music.youtube.com 网页端的公开 InnerTube key（ytmusicapi 同款）。
const DEFAULT_INNERTUBE_KEY: &str = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";

/// iOS 主客户端当前仍返回可直接 Range 读取的音频 URL；Web/Android 已逐步只给
/// signatureCipher 或 SABR，前者依赖易变的播放器脚本，后者不适合原生解码器。
const IOS_VERSION: &str = "20.11.6";
const IOS_USER_AGENT: &str =
    "com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)";
// Keep these in lock-step with Metrolist's working WEB_REMIX playback path.
const PLAYBACK_WEB_VERSION: &str = "1.20260707.12.00";
pub const PLAYBACK_WEB_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
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
    protected_identity: RwLock<Option<(std::time::Instant, ProtectedPreviewIdentity)>>,
    /// YouTube Music provider 独占的浏览器 Cookie 会话。
    auth: Arc<YoutubeAuth>,
}

impl YtmClient {
    pub fn new(auth: Arc<YoutubeAuth>) -> Result<Self> {
        let http = http_timeouts(reqwest::Client::builder().user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        ))
        .build()
        .context("构建 YouTube Music HTTP 客户端失败")?;
        Ok(YtmClient {
            http,
            innertube_key: env_or("KDJ_YTM_INNERTUBE_KEY", DEFAULT_INNERTUBE_KEY),
            script: RwLock::new(ScriptState::None),
            protected_identity: RwLock::new(None),
            auth,
        })
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

    fn ios_context() -> Value {
        json!({
            "context": {
                "client": {
                    "clientName": "IOS",
                    "clientVersion": IOS_VERSION,
                    "deviceModel": "iPhone10,4",
                    "osName": "iPhone",
                    "osVersion": "16.7.7.20H330",
                    "hl": "en",
                    "gl": "US",
                },
            },
            "contentCheckOk": true,
            "racyCheckOk": true,
        })
    }

    async fn post(&self, endpoint: &str, body: Value) -> Result<Value> {
        self.post_with_auth(endpoint, body, true).await
    }

    async fn post_with_auth(&self, endpoint: &str, body: Value, with_auth: bool) -> Result<Value> {
        let url = format!(
            "{BASE}/{endpoint}?key={}&prettyPrint=false",
            self.innertube_key
        );
        let mut request = self.http.post(&url).json(&body);
        if with_auth {
            for (name, value) in self.auth.request_headers("https://music.youtube.com") {
                request = request.header(name, value);
            }
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
        map.insert(
            "params".into(),
            Value::String(SONG_FILTER_PARAMS.to_string()),
        );
        self.post("search", body).await
    }

    /// 取视频的播放信息。这里故意不带浏览器 Cookie：登录 Web player 现在返回
    /// signatureCipher，当前网页签名器已经迁到 WASM；iOS 客户端仍给可直接 Range
    /// 读取的 HTTPS URL。试听时同时带内容绑定 PO Token，解除 GVS 的冷启动字节上限。
    pub async fn player(&self, video_id: &str, po_token: Option<&str>) -> Result<Value> {
        let mut body = Self::ios_context();
        let map = body.as_object_mut().expect("context 一定是对象");
        map.insert("videoId".into(), Value::String(video_id.to_string()));
        if let Some(token) = po_token.filter(|token| !token.is_empty()) {
            map.insert(
                "serviceIntegrityDimensions".into(),
                json!({ "poToken": token }),
            );
        }
        let url = format!("{BASE}/player?key={}&prettyPrint=false", self.innertube_key);
        let response = self
            .http
            .post(&url)
            .header(reqwest::header::USER_AGENT, IOS_USER_AGENT)
            .header("X-Youtube-Client-Name", "5")
            .header("X-Youtube-Client-Version", IOS_VERSION)
            .json(&body)
            .send()
            .await
            .context("YouTube Music 请求失败：player")?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .context("YouTube Music 响应不是合法 JSON：player")?;
        if !status.is_success() {
            let detail = payload
                .pointer("/error/message")
                .or_else(|| payload.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("");
            bail!("YouTube Music 接口返回 {status}：player {detail}");
        }
        if let Some(url) = payload.pointer("/assets/js").and_then(Value::as_str) {
            self.refresh_script_url(url);
        }
        Ok(payload)
    }

    /// Metrolist 的 WEB_REMIX 播放路径：Music origin、登录头、同一登录页的
    /// Visitor/DataSync，以及 session-bound player POT。
    fn protected_web_player_body(
        video_id: &str,
        po_token: Option<&str>,
        visitor_data: &str,
        data_sync_id: &str,
        signature_timestamp: u64,
    ) -> Value {
        let mut user = json!({ "lockedSafetyMode": false });
        if let Some(delegated) = delegated_session_id(data_sync_id) {
            user["onBehalfOfUser"] = Value::String(delegated.to_string());
        }
        let mut body = json!({
            "context": {
                "client": {
                    "clientName": "WEB_REMIX",
                    "clientVersion": PLAYBACK_WEB_VERSION,
                    "hl": "zh-CN",
                    "gl": "US",
                    "visitorData": visitor_data,
                },
                "user": user,
            },
            "videoId": video_id,
            "playbackContext": { "contentPlaybackContext": {
                "html5Preference": "HTML5_PREF_WANTS",
                "signatureTimestamp": signature_timestamp,
            }},
            "contentCheckOk": true,
            "racyCheckOk": true,
            "videoCheckOk": true,
        });
        // Current WEB_REMIX requires a GVS token, but not a player-request token. Supplying a
        // token with the wrong binding can opt the response into an incompatible experiment, so
        // omit this object unless the selected client policy explicitly asks for one.
        if let Some(po_token) = po_token {
            body["serviceIntegrityDimensions"] = json!({ "poToken": po_token });
        }
        body
    }

    pub async fn protected_web_player(
        &self,
        video_id: &str,
        po_token: Option<&str>,
        visitor_data: &str,
        data_sync_id: &str,
        signature_timestamp: u64,
    ) -> Result<Value> {
        let body = Self::protected_web_player_body(
            video_id,
            po_token,
            visitor_data,
            data_sync_id,
            signature_timestamp,
        );
        let url = format!("{BASE}/player?prettyPrint=false");
        let mut request = self
            .http
            .post(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9")
            .header(reqwest::header::REFERER, "https://music.youtube.com/")
            .header(reqwest::header::USER_AGENT, PLAYBACK_WEB_USER_AGENT)
            .header("X-Goog-Api-Format-Version", "1")
            .header("X-Goog-Visitor-Id", visitor_data)
            .header("X-Youtube-Client-Name", "67")
            .header("X-Youtube-Client-Version", PLAYBACK_WEB_VERSION)
            .json(&body);
        for (name, value) in self.auth.request_headers("https://music.youtube.com") {
            if name.eq_ignore_ascii_case("user-agent")
                || name.eq_ignore_ascii_case("x-goog-visitor-id")
            {
                continue;
            }
            request = request.header(name, value);
        }
        let response = request
            .send()
            .await
            .context("YouTube Music 请求失败：受保护 player")?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .context("YouTube Music 响应不是合法 JSON：受保护 player")?;
        if !status.is_success() {
            let detail = payload
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("");
            bail!("YouTube Music 接口返回 {status}：受保护 player {detail}");
        }
        if let Some(url) = payload.pointer("/assets/js").and_then(Value::as_str) {
            self.refresh_script_url(url);
        }
        Ok(payload)
    }

    pub async fn protected_web_identity(&self) -> Result<ProtectedPreviewIdentity> {
        if let Some((created_at, identity)) = self.protected_identity.read().unwrap().as_ref() {
            if created_at.elapsed() < std::time::Duration::from_secs(5 * 60) {
                return Ok(identity.clone());
            }
        }
        let mut request = self.http.get("https://music.youtube.com/");
        for (name, value) in self.auth.request_headers("https://music.youtube.com") {
            request = request.header(name, value);
        }
        let html = request
            .send()
            .await
            .context("打开 YouTube Music 首页失败")?
            .error_for_status()
            .context("YouTube Music 首页返回错误")?
            .text()
            .await
            .context("读取 YouTube Music 首页失败")?;
        let visitor_data = extract_ytcfg_value(&html, "VISITOR_DATA")
            .context("YouTube Music 首页没有返回 Visitor Data")?;
        let data_sync_id = extract_ytcfg_value(&html, "DATASYNC_ID").unwrap_or_default();
        // yt-dlp detects this page experiment before selecting the WebPO content binding. Outside
        // that experiment an authenticated web session binds GVS to DATASYNC_ID; logged-out web
        // sessions bind it to Visitor Data.
        let gvs_binding = select_gvs_binding(&html, &data_sync_id);
        let identity = ProtectedPreviewIdentity {
            visitor_data,
            data_sync_id,
            gvs_binding,
        };
        *self.protected_identity.write().unwrap() =
            Some((std::time::Instant::now(), identity.clone()));
        Ok(identity)
    }

    /// player 响应偶尔省略 assets.js；此时从已登录音乐首页读取当前脚本版本。
    pub async fn protected_player_url(&self, preferred: Option<&str>) -> Result<String> {
        if let Some(value) = preferred.filter(|value| !value.is_empty()) {
            return trusted_player_url(value);
        }
        let (url, _) = self.script_url_from_homepage().await?;
        trusted_player_url(&url)
    }

    /// 只代理 player 响应或官方首页明确给出的 base.js；不接受任意远程 URL。
    pub async fn protected_player_script(&self, value: &str) -> Result<String> {
        let url = trusted_player_url(value)?;
        let javascript = self.fetch_text(&url).await?;
        anyhow::ensure!(
            javascript.len() <= 8 * 1024 * 1024,
            "YouTube 播放器脚本异常过大"
        );
        Ok(javascript)
    }

    /// 浏览歌单（browseId 是 `VL` + 歌单 id）。
    pub async fn browse(&self, browse_id: &str) -> Result<Value> {
        let mut body = Self::web_remix_context();
        let map = body.as_object_mut().expect("context 一定是对象");
        map.insert("browseId".into(), Value::String(browse_id.to_string()));
        self.post("browse", body).await
    }

    /// 打开一首歌的「下一首 / 相关」面板（`next`），用来拿歌词 browseId（`MPLYt…`）。
    /// 与 ytmusicapi `get_watch_playlist` 同款请求体；不拉续页曲目。
    pub async fn next_watch(&self, video_id: &str) -> Result<Value> {
        let mut body = Self::web_remix_context();
        let map = body.as_object_mut().expect("context 一定是对象");
        map.insert("enablePersistentPlaylistPanel".into(), json!(true));
        map.insert("isAudioOnly".into(), json!(true));
        map.insert(
            "tunerSettingValue".into(),
            Value::String("AUTOMIX_SETTING_NORMAL".into()),
        );
        map.insert("videoId".into(), Value::String(video_id.to_string()));
        map.insert(
            "playlistId".into(),
            Value::String(format!("RDAMVM{video_id}")),
        );
        map.insert(
            "watchEndpointMusicSupportedConfigs".into(),
            json!({
                "watchEndpointMusicConfig": {
                    "hasPersistentPlaylistPanel": true,
                    "musicVideoType": "MUSIC_VIDEO_TYPE_ATV",
                }
            }),
        );
        self.post("next", body).await
    }

    /// 用 Android Music 客户端 browse 歌词页：只有移动端会返回 `timedLyricsData`。
    /// 版本号与 ytmusicapi `as_mobile()` 保持一致。
    ///
    /// 故意不带浏览器 Cookie / SAPISIDHASH：WEB 会话的 Authorization 会让
    /// `ANDROID_MUSIC` browse 直接 400，只能落到无时间轴的网页歌词。
    pub async fn browse_android_music(&self, browse_id: &str) -> Result<Value> {
        let body = json!({
            "context": {
                "client": {
                    "clientName": "ANDROID_MUSIC",
                    "clientVersion": "7.21.50",
                    "hl": "zh-CN",
                    "gl": "US",
                }
            },
            "browseId": browse_id,
        });
        self.post_with_auth("browse", body, false).await
    }

    /// 登录账号的 YouTube Music 播放列表目录；与 ytmusicapi 使用同一 browseId。
    pub async fn library_playlists(&self) -> Result<Value> {
        self.browse("FEmusic_liked_playlists").await
    }

    /// 取消歌曲的 Like；`LM`（赞过的音乐）就是由这份评分状态实时生成的。
    pub async fn remove_song_like(&self, video_id: &str) -> Result<Value> {
        let mut body = Self::web_remix_context();
        body.as_object_mut()
            .expect("context 一定是对象")
            .insert("target".into(), json!({"videoId": video_id}));
        self.post("like/removelike", body).await
    }

    /// 从本人歌单移除一个具体条目。`setVideoId` 是歌单项实例 ID；同一首歌即使
    /// 重复出现，也只会删掉用户右键点中的那一项。
    pub async fn remove_playlist_item(
        &self,
        playlist_id: &str,
        video_id: &str,
        set_video_id: &str,
    ) -> Result<Value> {
        let mut body = Self::web_remix_context();
        let map = body.as_object_mut().expect("context 一定是对象");
        map.insert("playlistId".into(), Value::String(playlist_id.to_string()));
        map.insert(
            "actions".into(),
            json!([{
                "setVideoId": set_video_id,
                "removedVideoId": video_id,
                "action": "ACTION_REMOVE_VIDEO",
            }]),
        );
        self.post("browse/edit_playlist", body).await
    }

    /// 登录账号菜单。成功返回就说明 Cookie + SAPISIDHASH 仍然有效。
    pub async fn account_menu(&self) -> Result<Value> {
        self.post("account/account_menu", Self::web_remix_context())
            .await
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
        let mut request = self.http.get("https://music.youtube.com/");
        for (name, value) in self.auth.request_headers("https://music.youtube.com") {
            request = request.header(name, value);
        }
        let html = {
            request
                .send()
                .await
                .context("打开 YouTube Music 首页失败")?
                .error_for_status()
                .context("YouTube Music 首页返回错误")?
                .text()
                .await
                .context("读取 YouTube Music 首页失败")?
        };
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

fn delegated_session_id(data_sync_id: &str) -> Option<&str> {
    let (delegated, user) = data_sync_id.split_once("||")?;
    (!delegated.is_empty() && !user.is_empty()).then_some(delegated)
}

fn generates_content_po_token(html: &str) -> bool {
    [
        "html5_generate_content_po_token=true",
        "html5_generate_content_po_token%3Dtrue",
        r"html5_generate_content_po_token\u003dtrue",
    ]
    .iter()
    .any(|marker| html.contains(marker))
}

fn select_gvs_binding(html: &str, data_sync_id: &str) -> ProtectedPoTokenBinding {
    if generates_content_po_token(html) {
        ProtectedPoTokenBinding::VideoId
    } else if !data_sync_id.is_empty() {
        ProtectedPoTokenBinding::DataSyncId
    } else {
        ProtectedPoTokenBinding::VisitorData
    }
}

fn extract_ytcfg_value(html: &str, key: &str) -> Option<String> {
    let marker = format!("\"{key}\":\"");
    let start = html.find(&marker)? + marker.len();
    let value = html[start..].split('"').next()?.trim();
    (!value.is_empty()
        && value.len() <= 4096
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'\\'))
    .then(|| value.to_string())
}

fn trusted_player_url(value: &str) -> Result<String> {
    let absolute = if value.starts_with('/') {
        format!("https://www.youtube.com{value}")
    } else {
        value.to_string()
    };
    let url = url::Url::parse(&absolute).context("YouTube 播放器脚本 URL 无效")?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    anyhow::ensure!(
        url.scheme() == "https"
            && (host == "youtube.com" || host.ends_with(".youtube.com"))
            && url.path().starts_with("/s/player/")
            && url.path().ends_with("/base.js"),
        "YouTube 播放器脚本 URL 不受信任"
    );
    Ok(url.into())
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
    fn native_player_context_uses_range_capable_ios_client() {
        let body = YtmClient::ios_context();
        assert_eq!(
            body.pointer("/context/client/clientName")
                .and_then(Value::as_str),
            Some("IOS")
        );
        assert_eq!(
            body.pointer("/context/client/clientVersion")
                .and_then(Value::as_str),
            Some(IOS_VERSION)
        );
        assert_eq!(
            body.get("contentCheckOk").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(body.get("racyCheckOk").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn protected_player_uses_the_timestamp_from_the_same_player_script() {
        let body = YtmClient::protected_web_player_body(
            "abcDEF12345",
            Some("pot"),
            "visitor",
            "sync",
            20_777,
        );
        assert_eq!(
            body.pointer("/playbackContext/contentPlaybackContext/signatureTimestamp")
                .and_then(Value::as_u64),
            Some(20_777)
        );
        assert_eq!(
            body.pointer("/serviceIntegrityDimensions/poToken")
                .and_then(Value::as_str),
            Some("pot")
        );
    }

    #[test]
    fn web_remix_player_omits_an_unrequired_player_token_and_primary_delegation() {
        let body = YtmClient::protected_web_player_body(
            "abcDEF12345",
            None,
            "visitor",
            "primary-user||",
            20_777,
        );
        assert!(body.get("serviceIntegrityDimensions").is_none());
        assert!(body.pointer("/context/user/onBehalfOfUser").is_none());
        let secondary = YtmClient::protected_web_player_body(
            "abcDEF12345",
            None,
            "visitor",
            "delegated||user",
            20_777,
        );
        assert_eq!(
            secondary
                .pointer("/context/user/onBehalfOfUser")
                .and_then(Value::as_str),
            Some("delegated")
        );
    }

    #[test]
    fn page_experiment_selects_video_bound_gvs_proofs() {
        assert!(generates_content_po_token(
            r#"{"serializedExperimentFlags":"x=1&html5_generate_content_po_token=true"}"#
        ));
        assert!(generates_content_po_token(
            r#"{"serializedExperimentFlags":"html5_generate_content_po_token%3Dtrue"}"#
        ));
        assert!(!generates_content_po_token(
            "html5_generate_content_po_token=false"
        ));
        assert_eq!(
            select_gvs_binding("html5_generate_content_po_token=true", "delegated||user"),
            ProtectedPoTokenBinding::VideoId
        );
        assert_eq!(
            select_gvs_binding("", "primary-user||"),
            ProtectedPoTokenBinding::DataSyncId
        );
        assert_eq!(
            select_gvs_binding("", ""),
            ProtectedPoTokenBinding::VisitorData
        );
    }

    #[test]
    fn login_identity_is_read_from_ytcfg_without_accepting_escaped_values() {
        let html = r#"{"VISITOR_DATA":"visitor%3D","DATASYNC_ID":"117234||abc"}"#;
        assert_eq!(
            extract_ytcfg_value(html, "VISITOR_DATA").as_deref(),
            Some("visitor%3D")
        );
        assert_eq!(
            extract_ytcfg_value(html, "DATASYNC_ID").as_deref(),
            Some("117234||abc")
        );
        assert!(extract_ytcfg_value(r#"{"VISITOR_DATA":"bad\\nvalue"}"#, "VISITOR_DATA").is_none());
    }

    #[test]
    fn protected_player_script_url_is_strictly_scoped() {
        assert_eq!(
            trusted_player_url("/s/player/abc/player_es6.vflset/en_US/base.js").unwrap(),
            "https://www.youtube.com/s/player/abc/player_es6.vflset/en_US/base.js"
        );
        assert!(trusted_player_url("https://example.test/s/player/x/base.js").is_err());
        assert!(trusted_player_url("https://www.youtube.com/watch?v=x").is_err());
    }

    #[test]
    fn player_url_is_extracted_from_escaped_ytcfg() {
        let html =
            r#"{"XSRF_TOKEN":"x","jsUrl":"\/s\/player\/abc\/player_ias.vflset\/zh_CN\/base.js"}"#;
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
