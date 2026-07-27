//! SoundCloud provider 实现。

use std::path::PathBuf;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt as _;
use kumodeck_core::models::{
    Account, AccountState, Platform, Quality, QrSession, QrStateValue, ResolveKind, ResolveResponse,
    SongSource,
};
use kumodeck_core::paths::render_filename;
use serde_json::{Map, Value};
use tokio::io::AsyncWriteExt as _;

use crate::net::{host_is, AtomicDownload};
use crate::provider::{
    effective_limit, no_login, remove_existing, str_field, Capabilities, DownloadJob, MusicProvider,
    ProviderContext,
};
use crate::tags;

const LABEL: &str = "SoundCloud";
const DISABLED_MESSAGE: &str = "未启用，在「下载」里打开开关";
const API: &str = "https://api-v2.soundcloud.com";
/// client_id 大约每几周换一次，缓存半天足够。
const CLIENT_ID_TTL: Duration = Duration::from_secs(12 * 3600);

pub struct SoundCloudProvider {
    ctx: ProviderContext,
    http: reqwest::Client,
    client_id: RwLock<Option<(String, Instant)>>,
}

impl SoundCloudProvider {
    pub fn new(ctx: ProviderContext) -> Result<Self> {
        let http = crate::net::http_timeouts(reqwest::Client::builder().user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        ))
        .build()
        .context("构建 SoundCloud HTTP 客户端失败")?;
        Ok(SoundCloudProvider {
            ctx,
            http,
            client_id: RwLock::new(None),
        })
    }

    fn ensure_enabled(&self) -> Result<()> {
        anyhow::ensure!(self.ctx.soundcloud_enabled, "{DISABLED_MESSAGE}");
        Ok(())
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
        let home = self
            .http
            .get("https://soundcloud.com/")
            .send()
            .await
            .context("打开 SoundCloud 首页失败")?
            .text()
            .await
            .context("读取 SoundCloud 首页失败")?;

        // 越靠后的 bundle 越可能带 client_id，倒着扫命中更快
        let mut scripts = extract_script_urls(&home);
        scripts.reverse();
        for url in scripts {
            let Ok(response) = self.http.get(&url).send().await else {
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

    /// 把 transcoding 的授权地址换成真正的 CDN 直链。
    async fn authorize_stream(&self, transcoding_url: &str) -> Result<String> {
        let client_id = self.client_id().await?;
        let body: Value = self
            .http
            .get(transcoding_url)
            .query(&[("client_id", client_id)])
            .send()
            .await
            .context("获取 SoundCloud 音频地址失败")?
            .error_for_status()
            .context("获取 SoundCloud 音频地址失败")?
            .json()
            .await
            .context("SoundCloud 音频地址响应不是合法 JSON")?;
        body.get("url")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
            .map(str::to_string)
            .context("SoundCloud 没有返回音频地址")
    }

    async fn fetch_cover(&self, url: &str) -> Option<Vec<u8>> {
        if url.is_empty() {
            return None;
        }
        // `-large` 是 100x100 的缩略图，`-t500x500` 才是能看的封面
        let full = url.replace("-large.", "-t500x500.");
        let response = self.http.get(&full).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.bytes().await.ok().map(|bytes| bytes.to_vec())
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
        Capabilities::ANONYMOUS_MUSIC
    }

    async fn account(&self) -> Account {
        let mut account = if self.ctx.soundcloud_enabled {
            Account::new(Platform::Soundcloud, LABEL, AccountState::Valid, "已启用")
        } else {
            Account::new(
                Platform::Soundcloud,
                LABEL,
                AccountState::Missing,
                DISABLED_MESSAGE,
            )
        };
        account.supports_login = false;
        account
    }

    async fn create_qr(&self) -> Result<QrSession> {
        no_login::create_qr(LABEL)
    }

    async fn poll_qr(&self, _session_id: &str) -> Result<(QrStateValue, String)> {
        Ok(no_login::poll_qr(LABEL))
    }

    async fn logout(&self) -> Result<()> {
        // 无登录态可清
        Ok(())
    }

    async fn search(&self, keyword: &str, limit: usize) -> Result<Vec<SongSource>> {
        let keyword = keyword.trim();
        if !self.ctx.soundcloud_enabled || keyword.is_empty() {
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
            pick_transcoding(&body).context("SoundCloud 没有可用的音频流")?.0
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
        let ext = if ext.is_empty() { "mp3".to_string() } else { ext };

        let url = self.authorize_stream(&transcoding).await?;
        job.check_canceled()?;

        let output_dir = self.ctx.platform_dir(Platform::Soundcloud)?;
        let filename = render_filename(
            &self.ctx.filename_template,
            &source.title,
            &source.artist_text(),
            &source.album,
            &source.key,
            &ext,
        );
        let final_path = output_dir.join(filename);
        remove_existing(&final_path);

        let guard = AtomicDownload::new(&final_path);
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .context("SoundCloud 音频下载失败")?
            .error_for_status()
            .context("SoundCloud 音频下载失败")?;
        let total = response.content_length().unwrap_or(0);
        job.report(0, total);

        let mut file = tokio::fs::File::create(guard.partial())
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
        file.flush().await.ok();
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
            let id: String = after.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            if id.len() >= 16 {
                return Some(id);
            }
        }
    }
    // `client_id=abc123&` 这种拼在 query 里的写法
    let mut rest = js;
    while let Some(at) = rest.find("client_id=") {
        let after = &rest[at + "client_id=".len()..];
        let id: String = after.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
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
        let Some(url) = item.get("url").and_then(Value::as_str).filter(|u| !u.is_empty()) else {
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
    let id = track
        .get("id")
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| permalink.to_string());
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
        assert_eq!(source.key, "12345");
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
