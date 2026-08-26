//! Lightweight ordinary-YouTube InnerTube client.
//!
//! This deliberately implements only KDJ's contract: search, metadata and downloadable stream
//! discovery. It does not embed a JavaScript VM or a general YouTube page parser. The iOS player
//! client is preferred because it returns range-capable direct URLs; authenticated WEB is a
//! fallback for restricted metadata and legacy signatureCipher responses.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::net::http_timeouts;
use crate::youtubemusic::auth::YoutubeAuth;
use crate::youtubemusic::client::extract_player_url;
use crate::youtubemusic::decipher::PlayerScript;

const BASE: &str = "https://www.youtube.com/youtubei/v1";
const DEFAULT_INNERTUBE_KEY: &str = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const IOS_VERSION: &str = "20.11.6";
const IOS_USER_AGENT: &str =
    "com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)";
pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const VIDEO_CACHE_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Default)]
pub struct Thumbnail {
    pub url: String,
    pub width: u64,
    pub height: u64,
}

#[derive(Debug, Clone, Default)]
pub struct VideoDetails {
    pub video_id: String,
    pub title: String,
    pub owner_channel_name: String,
    pub length_seconds: String,
    pub thumbnails: Vec<Thumbnail>,
}

#[derive(Debug, Clone, Default)]
pub struct MediaMime {
    pub container: String,
    pub video_codec: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct VideoFormat {
    pub itag: u64,
    pub mime_type: MediaMime,
    pub bitrate: u64,
    pub height: Option<u64>,
    pub quality_label: Option<String>,
    pub audio_bitrate: Option<u64>,
    pub content_length: Option<u64>,
    pub url: String,
    pub has_video: bool,
    pub has_audio: bool,
    pub is_live: bool,
}

#[derive(Debug, Clone, Default)]
pub struct VideoInfo {
    pub video_details: VideoDetails,
    pub formats: Vec<VideoFormat>,
    pub hls_manifest_url: Option<String>,
}

enum ScriptState {
    None,
    Pending(String),
    Ready(String, Arc<PlayerScript>),
}

pub struct YoutubeClient {
    http: reqwest::Client,
    key: String,
    auth: Arc<YoutubeAuth>,
    script: RwLock<ScriptState>,
    videos: RwLock<HashMap<String, (Instant, VideoInfo)>>,
}

impl YoutubeClient {
    pub fn new(auth: Arc<YoutubeAuth>) -> Result<Self> {
        let http = http_timeouts(reqwest::Client::builder().user_agent(USER_AGENT))
            .build()
            .context("构建 YouTube InnerTube 客户端失败")?;
        Ok(Self {
            http,
            key: env_or("KDJ_YOUTUBE_INNERTUBE_KEY", DEFAULT_INNERTUBE_KEY),
            auth,
            script: RwLock::new(ScriptState::None),
            videos: RwLock::new(HashMap::new()),
        })
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub fn web_context() -> Value {
        json!({
            "context": {
                "client": {
                    "clientName": "WEB",
                    "clientVersion": web_client_version(),
                    "hl": "zh-CN",
                    "gl": "US"
                },
                "user": { "lockedSafetyMode": false }
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
                    "gl": "US"
                }
            },
            "contentCheckOk": true,
            "racyCheckOk": true
        })
    }

    pub async fn post_web(&self, endpoint: &str, body: &Value) -> Result<Value> {
        let url = format!("{BASE}/{endpoint}?key={}&prettyPrint=false", self.key);
        let mut request = self.http.post(url).json(body);
        for (name, value) in self.auth.request_headers("https://www.youtube.com") {
            request = request.header(name, value);
        }
        read_json(request, endpoint).await
    }

    pub async fn search(&self, query: &str) -> Result<Value> {
        let mut body = Self::web_context();
        let map = body.as_object_mut().expect("WEB context is an object");
        map.insert("query".into(), Value::String(query.to_string()));
        // Video-only filter. Parsing remains defensive because YouTube occasionally injects
        // shelves and promoted results around the filtered rows.
        map.insert("params".into(), Value::String("EgIQAQ%3D%3D".into()));
        self.post_web("search", &body).await
    }

    pub async fn video_info(&self, video_id: &str) -> Result<VideoInfo> {
        if let Some(info) = self.cached_video(video_id) {
            return Ok(info);
        }
        let ios = self.player_ios(video_id).await;
        let mut ios_error = None;
        if let Ok(payload) = ios {
            match self.parse_player(&payload).await {
                Ok(info) if !info.formats.is_empty() || info.hls_manifest_url.is_some() => {
                    return Ok(self.remember_video(video_id, info));
                }
                Ok(_) => ios_error = Some("iOS player 没有返回下载流".to_string()),
                Err(error) => ios_error = Some(format!("{error:#}")),
            }
        } else if let Err(error) = ios {
            ios_error = Some(format!("{error:#}"));
        }

        // WEB is mainly an authenticated/restricted-content fallback. Its cipher path is handled
        // by the existing small Rust operation interpreter, never by an embedded JS engine.
        let mut body = Self::web_context();
        let map = body.as_object_mut().expect("WEB context is an object");
        map.insert("videoId".into(), Value::String(video_id.to_string()));
        map.insert("contentCheckOk".into(), Value::Bool(true));
        map.insert("racyCheckOk".into(), Value::Bool(true));
        let payload = self.post_web("player", &body).await?;
        let info = self.parse_player(&payload).await.map_err(|error| {
            anyhow::anyhow!(
                "YouTube 播放信息不可用：{}；WEB 回退：{error:#}",
                ios_error.unwrap_or_else(|| "iOS player 未返回结果".into())
            )
        })?;
        Ok(self.remember_video(video_id, info))
    }

    fn cached_video(&self, video_id: &str) -> Option<VideoInfo> {
        let mut videos = self.videos.write().unwrap_or_else(|lock| lock.into_inner());
        videos.retain(|_, (created, _)| created.elapsed() < VIDEO_CACHE_TTL);
        videos.get(video_id).map(|(_, info)| info.clone())
    }

    fn remember_video(&self, video_id: &str, info: VideoInfo) -> VideoInfo {
        let mut videos = self.videos.write().unwrap_or_else(|lock| lock.into_inner());
        if videos.len() >= 128 {
            if let Some(oldest) = videos
                .iter()
                .min_by_key(|(_, (created, _))| *created)
                .map(|(key, _)| key.clone())
            {
                videos.remove(&oldest);
            }
        }
        videos.insert(video_id.to_string(), (Instant::now(), info.clone()));
        info
    }

    async fn player_ios(&self, video_id: &str) -> Result<Value> {
        let mut body = Self::ios_context();
        body.as_object_mut()
            .expect("iOS context is an object")
            .insert("videoId".into(), Value::String(video_id.to_string()));
        let request = self
            .http
            .post(format!("{BASE}/player?key={}&prettyPrint=false", self.key))
            .header(reqwest::header::USER_AGENT, IOS_USER_AGENT)
            .header("X-Youtube-Client-Name", "5")
            .header("X-Youtube-Client-Version", IOS_VERSION)
            .json(&body);
        read_json(request, "player/ios").await
    }

    async fn parse_player(&self, player: &Value) -> Result<VideoInfo> {
        ensure_playable(player)?;
        if let Some(url) = player.pointer("/assets/js").and_then(Value::as_str) {
            self.refresh_script_url(url);
        }
        let details_value = player
            .get("videoDetails")
            .context("YouTube player 缺少 videoDetails")?;
        let details = video_details(details_value);
        anyhow::ensure!(!details.video_id.is_empty(), "YouTube player 缺少视频 ID");
        let is_live = details_value
            .get("isLiveContent")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let rows = player
            .pointer("/streamingData/formats")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .chain(
                player
                    .pointer("/streamingData/adaptiveFormats")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten(),
            );
        let mut formats = Vec::new();
        for row in rows {
            if let Some(format) = self.video_format(row, is_live).await {
                formats.push(format);
            }
        }
        formats.sort_by_key(|format| format.itag);
        formats.dedup_by_key(|format| format.itag);
        Ok(VideoInfo {
            video_details: details,
            formats,
            hls_manifest_url: player
                .pointer("/streamingData/hlsManifestUrl")
                .and_then(Value::as_str)
                .filter(|url| !url.is_empty())
                .map(str::to_string),
        })
    }

    async fn video_format(&self, row: &Value, is_live: bool) -> Option<VideoFormat> {
        let mime = row.get("mimeType")?.as_str()?;
        let (kind, rest) = mime.split_once('/')?;
        let container = rest.split(';').next()?.trim().to_string();
        let codecs = mime
            .split(r#"codecs=""#)
            .nth(1)
            .and_then(|value| value.split('"').next())
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|codec| !codec.is_empty())
            .collect::<Vec<_>>();
        let has_video = kind == "video";
        let has_audio = kind == "audio"
            || codecs.iter().any(|codec| {
                codec.starts_with("mp4a")
                    || codec.starts_with("opus")
                    || codec.starts_with("vorbis")
                    || codec.starts_with("aac")
            });
        let video_codec = codecs
            .iter()
            .find(|codec| {
                codec.starts_with("avc")
                    || codec.starts_with("h26")
                    || codec.starts_with("vp")
                    || codec.starts_with("av01")
            })
            .map(|codec| (*codec).to_string());
        let url = match row.get("url").and_then(Value::as_str) {
            Some(url) if !url.is_empty() => url.to_string(),
            _ => {
                let cipher = row
                    .get("signatureCipher")
                    .or_else(|| row.get("cipher"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match self.decipher_url(cipher).await {
                    Ok(url) => url,
                    Err(error) => {
                        tracing::debug!("跳过无法还原的 YouTube itag：{error:#}");
                        String::new()
                    }
                }
            }
        };
        Some(VideoFormat {
            itag: row.get("itag").and_then(Value::as_u64).unwrap_or(0),
            mime_type: MediaMime {
                container,
                video_codec,
            },
            bitrate: row.get("bitrate").and_then(Value::as_u64).unwrap_or(0),
            height: row.get("height").and_then(Value::as_u64),
            quality_label: row
                .get("qualityLabel")
                .and_then(Value::as_str)
                .map(str::to_string),
            audio_bitrate: has_audio
                .then(|| row.get("averageBitrate").and_then(Value::as_u64))
                .flatten()
                .or_else(|| {
                    has_audio
                        .then_some(row.get("bitrate").and_then(Value::as_u64))
                        .flatten()
                }),
            content_length: row.get("contentLength").and_then(|value| {
                value
                    .as_str()
                    .and_then(|text| text.parse().ok())
                    .or_else(|| value.as_u64())
            }),
            url,
            has_video,
            has_audio,
            is_live,
        })
    }

    async fn decipher_url(&self, cipher: &str) -> Result<String> {
        anyhow::ensure!(
            !cipher.is_empty(),
            "stream has neither url nor signatureCipher"
        );
        let params: std::collections::HashMap<String, String> =
            url::form_urlencoded::parse(cipher.as_bytes())
                .into_owned()
                .collect();
        let mut url = params
            .get("url")
            .filter(|url| !url.is_empty())
            .cloned()
            .context("signatureCipher 缺少 url")?;
        if let Some(scrambled) = params.get("s").filter(|value| !value.is_empty()) {
            let signature = self
                .player_script()
                .await?
                .decipher(scrambled)
                .context("还原 YouTube 视频签名失败")?;
            let key = params
                .get("sp")
                .filter(|value| !value.is_empty())
                .map(String::as_str)
                .unwrap_or("signature");
            let separator = if url.contains('?') { '&' } else { '?' };
            url.push(separator);
            url.push_str(key);
            url.push('=');
            url.push_str(
                &url::form_urlencoded::byte_serialize(signature.as_bytes()).collect::<String>(),
            );
        }
        Ok(url)
    }

    fn refresh_script_url(&self, value: &str) {
        let Ok(url) = trusted_player_url(value) else {
            return;
        };
        let mut state = self.script.write().unwrap_or_else(|lock| lock.into_inner());
        match &*state {
            ScriptState::Ready(cached, _) | ScriptState::Pending(cached) if cached == &url => {}
            _ => *state = ScriptState::Pending(url),
        }
    }

    async fn player_script(&self) -> Result<Arc<PlayerScript>> {
        let pending = {
            let state = self.script.read().unwrap_or_else(|lock| lock.into_inner());
            if let ScriptState::Ready(_, script) = &*state {
                return Ok(script.clone());
            }
            match &*state {
                ScriptState::Pending(url) => Some(url.clone()),
                _ => None,
            }
        };
        let (url, javascript) = match pending {
            Some(url) => match self.fetch_text(&url).await {
                Ok(javascript) => (url, javascript),
                Err(_) => self.player_script_from_homepage().await?,
            },
            None => self.player_script_from_homepage().await?,
        };
        let script = Arc::new(PlayerScript::parse(&javascript)?);
        *self.script.write().unwrap_or_else(|lock| lock.into_inner()) =
            ScriptState::Ready(url, script.clone());
        Ok(script)
    }

    async fn player_script_from_homepage(&self) -> Result<(String, String)> {
        let mut request = self.http.get("https://www.youtube.com/");
        for (name, value) in self.auth.request_headers("https://www.youtube.com") {
            request = request.header(name, value);
        }
        let html = request
            .send()
            .await
            .context("打开 YouTube 首页失败")?
            .error_for_status()
            .context("YouTube 首页返回错误")?
            .text()
            .await
            .context("读取 YouTube 首页失败")?;
        let url = extract_player_url(&html).context("YouTube 首页没有播放器脚本地址")?;
        let url = trusted_player_url(&url)?;
        let javascript = self.fetch_text(&url).await?;
        Ok((url, javascript))
    }

    async fn fetch_text(&self, url: &str) -> Result<String> {
        self.http
            .get(url)
            .send()
            .await
            .context("下载 YouTube 播放器脚本失败")?
            .error_for_status()
            .context("YouTube 播放器脚本返回错误")?
            .text()
            .await
            .context("读取 YouTube 播放器脚本失败")
    }
}

async fn read_json(request: reqwest::RequestBuilder, endpoint: &str) -> Result<Value> {
    let response = request
        .send()
        .await
        .with_context(|| format!("YouTube 请求失败：{endpoint}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .with_context(|| format!("YouTube 响应不是合法 JSON：{endpoint}"))?;
    if !status.is_success() {
        let detail = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        bail!("YouTube 接口返回 {status}：{endpoint} {detail}");
    }
    Ok(payload)
}

fn ensure_playable(player: &Value) -> Result<()> {
    let status = player
        .pointer("/playabilityStatus/status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if status == "OK" {
        return Ok(());
    }
    let reason = player
        .pointer("/playabilityStatus/reason")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if reason.is_empty() {
        bail!("YouTube 视频不可播放（{status}）")
    }
    bail!("YouTube 视频不可播放：{reason}")
}

fn video_details(value: &Value) -> VideoDetails {
    VideoDetails {
        video_id: value
            .get("videoId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        title: value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        owner_channel_name: value
            .get("author")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        length_seconds: value
            .get("lengthSeconds")
            .and_then(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| value.as_u64().map(|v| v.to_string()))
            })
            .unwrap_or_default(),
        thumbnails: value
            .get("thumbnail")
            .and_then(|value| value.get("thumbnails"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some(Thumbnail {
                            url: item.get("url")?.as_str()?.to_string(),
                            width: item.get("width").and_then(Value::as_u64).unwrap_or(0),
                            height: item.get("height").and_then(Value::as_u64).unwrap_or(0),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
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

fn web_client_version() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("2.{year:04}{month:02}{day:02}.00.00")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_parser_keeps_only_kdj_fields() {
        let details = video_details(&json!({
            "videoId": "abcDEF12345",
            "title": "Title",
            "author": "Channel",
            "lengthSeconds": "62",
            "thumbnail": { "thumbnails": [
                { "url": "small", "width": 120, "height": 90 },
                { "url": "large", "width": 480, "height": 360 }
            ]}
        }));
        assert_eq!(details.video_id, "abcDEF12345");
        assert_eq!(details.owner_channel_name, "Channel");
        assert_eq!(details.length_seconds, "62");
        assert_eq!(details.thumbnails.len(), 2);
    }

    #[test]
    fn only_official_player_scripts_are_trusted() {
        assert!(trusted_player_url("/s/player/abc/player_ias.vflset/en_US/base.js").is_ok());
        assert!(trusted_player_url("https://example.test/s/player/x/base.js").is_err());
        assert!(trusted_player_url("https://www.youtube.com/watch?v=x").is_err());
    }
}
