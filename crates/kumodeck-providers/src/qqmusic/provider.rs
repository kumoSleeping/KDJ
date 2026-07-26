//! QQ 音乐 provider。
//!
//! 直译自 `sidecar/kumodeck/providers/qqmusic.py`，两处必须保留的行为：
//! - 音质降级：flac → 320 → 128，每一档都真的去要一次 vkey，拿到哪个用哪个；
//! - `url.cn` 短链只有 host 精确匹配时才展开（和网易云同源的盲 SSRF 修复）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt as _;
use kumodeck_core::models::{
    Account, AccountState, Platform, Quality, QrSession, QrStateValue, ResolveKind, ResolveResponse,
    SongSource,
};
use kumodeck_core::paths::render_filename;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt as _;

use super::client::{new_search_id, Credential, QqClient, QqPlatform};
use super::login;
use crate::net::{host_is, AtomicDownload};
use crate::provider::{
    effective_limit, first_truthy, is_truthy, loose_int, qr_data_url_from_png, remove_existing,
    str_field, Capabilities, DownloadJob, MusicProvider, ProviderContext,
};
use crate::tags;

const LABEL: &str = "QQ 音乐";
const CDN_FALLBACK: &str = "https://dl.stream.qqmusic.qq.com/";
const QR_SESSION_TTL: Duration = Duration::from_secs(15 * 60);
const PROFILE_TTL: Duration = Duration::from_secs(300);

/// 契约音质 → (文件名前缀, 扩展名)。前缀是 QQ 侧的文件类型编码，不能改。
fn file_type(quality: Quality) -> (&'static str, &'static str) {
    match quality {
        Quality::Flac => ("F000", "flac"),
        Quality::Q320 => ("M800", "mp3"),
        Quality::Q128 => ("M500", "mp3"),
    }
}

pub struct QqMusicProvider {
    ctx: ProviderContext,
    client: QqClient,
    qr_sessions: Mutex<HashMap<String, (login::QqQrSession, Instant)>>,
    cdn: Mutex<Option<(String, Instant)>>,
    profile: Mutex<Option<((String, String), Instant)>>,
}

impl QqMusicProvider {
    pub fn new(ctx: ProviderContext) -> Result<Self> {
        let session_dir = ctx.session_dir();
        std::fs::create_dir_all(&session_dir).ok();
        Ok(QqMusicProvider {
            client: QqClient::new(&session_dir)?,
            ctx,
            qr_sessions: Mutex::new(HashMap::new()),
            cdn: Mutex::new(None),
            profile: Mutex::new(None),
        })
    }

    // ------------------------------------------------------------ 链接

    fn is_qq_link(text: &str) -> bool {
        host_is(text, "qq.com") || host_is(text, "qqmusic.com")
    }

    /// 展开 `url.cn` 短链。
    ///
    /// 和网易云的 163cn.tv 一样：**必须**用 host 精确判断再发请求，
    /// 子串判断会让任意带 `?x=url.cn` 的链接把我们变成 SSRF 跳板。
    async fn expand_short_link(&self, text: &str) -> String {
        let text = text.trim().to_string();
        if !host_is(&text, "url.cn") {
            return text;
        }
        match crate::net::expand_short_link(self.client.http(), &text, 4, &|host| {
            let host = host.to_ascii_lowercase();
            host == "url.cn" || host == "qq.com" || host.ends_with(".qq.com")
        })
        .await
        {
            Ok(resolved) if host_is(&resolved, "qq.com") => resolved,
            _ => text,
        }
    }

    // ------------------------------------------------------------ API

    async fn query_song(&self, key: &str) -> Result<Value> {
        let param = if key.chars().all(|c| c.is_ascii_digit()) {
            json!({"ctx": 0, "client": 1, "ids": [key.parse::<i64>().unwrap_or(0)],
                   "types": [0], "modify_stamp": [0]})
        } else {
            json!({"ctx": 0, "client": 1, "mids": [key],
                   "types": [0], "modify_stamp": [0]})
        };
        let data = self
            .client
            .call(
                "music.trackInfo.UniformRuleCtrl",
                "CgiGetTrackInfo",
                param,
                QqPlatform::Desktop,
            )
            .await?;
        Ok(data
            .get("tracks")
            .and_then(Value::as_array)
            .and_then(|list| list.first())
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// 歌单分页拉取：hasmore 与 total 双终止条件，任一到头就停。
    async fn playlist_tracks(&self, playlist_id: &str, limit: usize) -> Result<(String, Vec<Value>)> {
        let id: i64 = playlist_id.parse().context("QQ 音乐歌单 ID 不是数字")?;
        let mut tracks: Vec<Value> = Vec::new();
        let mut title = format!("QQ 音乐歌单 {playlist_id}");
        let mut total: Option<usize> = None;
        let mut page = 0usize;

        loop {
            let data = self
                .client
                .call(
                    "music.srfDissInfo.DissInfo",
                    "CgiGetDiss",
                    json!({
                        "disstid": id, "dirid": 0, "tag": true,
                        "song_begin": page * 100, "song_num": 100,
                        "userinfo": true, "orderlist": true, "onlysonglist": false
                    }),
                    QqPlatform::Desktop,
                )
                .await?;

            let songs = data
                .get("songlist")
                .or_else(|| data.get("songs"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if page == 0 {
                // Python 是 `info.title or info.dirname or info.dissname or 默认`：
                // 空串要继续往后退，不能停在第一个存在的键上。
                if let Some(found) = data.get("dirinfo").and_then(|info| {
                    str_field(info, "title")
                        .or_else(|| str_field(info, "dirname"))
                        .or_else(|| str_field(info, "dissname"))
                }) {
                    title = found.to_string();
                }
            }
            // Python 每翻一页都刷新 total（`total = int(raw_total) if raw_total > 0 else total`）：
            // 首页偶尔不带总数，只在 page==0 读会让"够了就停"这条终止条件永远失效。
            let page_total = data
                .get("total_song_num")
                .or_else(|| data.get("total"))
                .map(|value| loose_int(Some(value)))
                .filter(|value| *value > 0)
                .map(|value| value as usize);
            if page_total.is_some() {
                total = page_total;
            }
            let empty = songs.is_empty();
            // Python 是 `if song.get("mid") or song.get("id")`——**真值判断**。
            // 用 `is_some()` 的话 `{"mid": ""}` 这种占位条目会被留下，
            // 归一化后 key 是空串，那首歌点下载必然失败。
            tracks.extend(songs.into_iter().filter(has_song_key));

            let hasmore = data
                .get("hasmore")
                .and_then(|value| value.as_u64().or(value.as_bool().map(u64::from)))
                .unwrap_or(0)
                != 0;
            if !hasmore || empty || tracks.len() >= limit {
                break;
            }
            if total.is_some_and(|total| tracks.len() >= total) {
                break;
            }
            page += 1;
            // 挡住接口一直回 hasmore=1 的病态情况
            if page > 50 {
                break;
            }
        }
        Ok((title, tracks))
    }

    /// 按 flac → 320 → 128 依次要链接，拿到哪个就用哪个。
    async fn resolve_url(
        &self,
        song_mid: &str,
        media_mid: &str,
        quality: Quality,
    ) -> Result<Option<(String, &'static str)>> {
        for step in quality.gradient() {
            let (prefix, ext) = file_type(*step);
            // media_mid 空的时候要用 mid 拼两遍，这是 QQ 的文件名约定
            let filename = if media_mid.is_empty() {
                format!("{prefix}{song_mid}{song_mid}.{ext}")
            } else {
                format!("{prefix}{media_mid}.{ext}")
            };
            let credential = self.client.credential();
            let data = match self
                .client
                .call(
                    "music.vkey.GetVkey",
                    "UrlGetVkey",
                    json!({
                        "uin": credential.str_musicid(),
                        "filename": [filename],
                        "guid": self.client.guid(),
                        "songmid": [song_mid],
                        "songtype": [0],
                        "ctx": 0
                    }),
                    QqPlatform::Desktop,
                )
                .await
            {
                Ok(data) => data,
                Err(err) => {
                    tracing::debug!("QQ 音乐 vkey 失败 {song_mid} {ext}：{err}");
                    continue;
                }
            };
            let Some(purl) = data
                .get("midurlinfo")
                .and_then(Value::as_array)
                .and_then(|list| list.first())
                .and_then(|item| item.get("purl"))
                .and_then(Value::as_str)
                .filter(|purl| !purl.is_empty())
            else {
                continue;
            };
            let url = if purl.starts_with("http://") || purl.starts_with("https://") {
                purl.to_string()
            } else {
                format!("{}{purl}", self.cdn_base().await)
            };
            return Ok(Some((url, ext)));
        }
        Ok(None)
    }

    /// CDN 域名缓存：dispatch 给的 refresh_time 可能很大，硬压到 30 分钟以内。
    async fn cdn_base(&self) -> String {
        if let Some((base, expires)) = self.cdn.lock().unwrap().as_ref() {
            if Instant::now() < *expires {
                return base.clone();
            }
        }
        let (base, ttl) = match self
            .client
            .call(
                "music.audioCdnDispatch.cdnDispatch",
                "GetCdnDispatch",
                json!({"guid": self.client.guid(), "uid": "0", "use_new_domain": 1, "use_ipv6": 1}),
                QqPlatform::Desktop,
            )
            .await
        {
            Ok(data) => {
                let picked = data
                    .get("sip")
                    .and_then(Value::as_array)
                    .and_then(|list| {
                        list.iter()
                            .filter_map(Value::as_str)
                            .find(|base| {
                                base.starts_with("https://")
                                    && base.contains("sjy6.stream.qqmusic.qq.com")
                            })
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| CDN_FALLBACK.to_string());
                let refresh = data
                    .get("refresh_time")
                    .and_then(Value::as_u64)
                    .unwrap_or(1800)
                    .clamp(60, 1800);
                (
                    format!("{}/", picked.trim_end_matches('/')),
                    Duration::from_secs(refresh),
                )
            }
            Err(_) => (CDN_FALLBACK.to_string(), Duration::from_secs(60)),
        };
        *self.cdn.lock().unwrap() = Some((base.clone(), Instant::now() + ttl));
        base
    }

    /// 昵称/头像，带 5 分钟缓存——account() 会被前端轮询，不能每次都打网络。
    async fn fetch_profile(&self) -> (String, String) {
        if let Some((profile, at)) = self.profile.lock().unwrap().as_ref() {
            if at.elapsed() < PROFILE_TTL {
                return profile.clone();
            }
        }
        let euin = self.client.credential().encrypt_uin;
        let mut profile = (String::new(), String::new());
        if !euin.is_empty() {
            if let Ok(data) = self
                .client
                .call(
                    "music.UnifiedHomepage.UnifiedHomepageSrv",
                    "GetHomepageHeader",
                    json!({"IsQueryTabDetail": 1, "uin": euin}),
                    QqPlatform::Desktop,
                )
                .await
            {
                profile = (
                    data.get("Info")
                        .and_then(|info| info.get("Nick"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    data.get("Info")
                        .and_then(|info| info.get("Pic"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        // qlogo 的头像接口给的是 http://——前端 CSP 只放行 https 的图，
                        // 原样透传的结果是头像被拦、onError 把 <img> 藏掉，
                        // 看起来就是"QQ 音乐没有头像"。qlogo 全域支持 https，直接升。
                        .replacen("http://", "https://", 1),
                );
            }
        }
        *self.profile.lock().unwrap() = Some((profile.clone(), Instant::now()));
        profile
    }

    async fn fetch_cover(&self, album_mid_or_url: &str) -> Option<Vec<u8>> {
        if album_mid_or_url.is_empty() {
            return None;
        }
        let url = if album_mid_or_url.starts_with("http") {
            album_mid_or_url.to_string()
        } else {
            format!(
                "https://y.qq.com/music/photo_new/T002R300x300M000{album_mid_or_url}.jpg?max_age=2592000"
            )
        };
        let response = self.client.http().get(url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.bytes().await.ok().map(|bytes| bytes.to_vec())
    }

    fn prune_qr_sessions(&self) {
        self.qr_sessions
            .lock()
            .unwrap()
            .retain(|_, (_, born)| born.elapsed() <= QR_SESSION_TTL);
    }
}

#[async_trait]
impl MusicProvider for QqMusicProvider {
    fn platform(&self) -> Platform {
        Platform::Qqm
    }

    fn label(&self) -> &str {
        LABEL
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::MUSIC
    }

    async fn account(&self) -> Account {
        let mut credential = self.client.credential();
        if !credential.is_present() {
            return Account::new(Platform::Qqm, LABEL, AccountState::Missing, "未登录");
        }
        // 接口已经明说过这份凭证死了，别再显示"已登录"
        if self.client.credential_invalid() {
            return Account::new(
                Platform::Qqm,
                LABEL,
                AccountState::Expired,
                "登录凭证已失效，请重新扫码",
            );
        }
        if credential.is_expired() {
            // 本地判断过期先静默刷一次，刷不动才算真掉线
            match self.client.refresh_credential().await {
                Ok(refreshed) => {
                    *self.profile.lock().unwrap() = None;
                    credential = refreshed;
                }
                Err(err) => {
                    tracing::warn!("刷新 QQ 音乐凭证失败：{err:#}");
                    return Account::new(
                        Platform::Qqm,
                        LABEL,
                        AccountState::Expired,
                        "登录凭证已过期，请重新扫码",
                    );
                }
            }
        }
        let (nickname, avatar) = self.fetch_profile().await;
        let mut account = Account::new(
            Platform::Qqm,
            LABEL,
            AccountState::Valid,
            &format!("musicid={}", credential.musicid),
        );
        account.nickname = nickname;
        account.avatar = avatar;
        account
    }

    async fn create_qr(&self) -> Result<QrSession> {
        let session = login::create_qq_qr(self.client.http()).await?;
        let image = qr_data_url_from_png(&session.png);
        let session_id = format!("{:032x}", rand::random::<u128>());
        self.prune_qr_sessions();
        self.qr_sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), (session, Instant::now()));
        Ok(QrSession {
            platform: Platform::Qqm,
            session_id,
            image,
            url: String::new(),
            expires_in: 180,
        })
    }

    async fn poll_qr(&self, session_id: &str) -> Result<(QrStateValue, String)> {
        let session = {
            let sessions = self.qr_sessions.lock().unwrap();
            sessions.get(session_id).map(|(session, _)| session.clone())
        };
        let Some(session) = session else {
            return Ok((
                QrStateValue::Error,
                "二维码会话不存在或已过期，请重新获取".into(),
            ));
        };

        match login::check_qq_qr(self.client.http(), &session).await {
            Ok(login::QrOutcome::Waiting) => Ok((QrStateValue::Waiting, "等待手机扫码".into())),
            Ok(login::QrOutcome::Scanned) => {
                Ok((QrStateValue::Scanned, "已扫码，请在手机上确认".into()))
            }
            Ok(login::QrOutcome::Refused) => {
                self.qr_sessions.lock().unwrap().remove(session_id);
                Ok((QrStateValue::Refused, "已在手机上拒绝登录".into()))
            }
            Ok(login::QrOutcome::Expired) => {
                self.qr_sessions.lock().unwrap().remove(session_id);
                Ok((QrStateValue::Expired, "二维码已过期，请重新获取".into()))
            }
            Ok(login::QrOutcome::Done { uin, sigx }) => {
                self.qr_sessions.lock().unwrap().remove(session_id);
                match login::authorize(self.client.http(), &uin, &sigx).await {
                    Ok(credential) => {
                        self.client.store_credential(credential);
                        *self.profile.lock().unwrap() = None;
                        Ok((QrStateValue::Done, "登录成功".into()))
                    }
                    Err(err) => Ok((
                        QrStateValue::Error,
                        truncate(&format!("换取登录凭证失败：{err:#}"), 160),
                    )),
                }
            }
            Err(err) => Ok((
                QrStateValue::Error,
                truncate(&format!("检查二维码状态失败：{err:#}"), 160),
            )),
        }
    }

    async fn logout(&self) -> Result<()> {
        if self.client.has_credential() {
            let _ = self
                .client
                .call(
                    "music.login.LoginServer",
                    "Logout",
                    json!({}),
                    QqPlatform::Desktop,
                )
                .await;
        }
        self.client.clear_credential();
        *self.profile.lock().unwrap() = None;
        self.qr_sessions.lock().unwrap().clear();
        Ok(())
    }

    async fn search(&self, keyword: &str, limit: usize) -> Result<Vec<SongSource>> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(Vec::new());
        }
        let limit = effective_limit(limit, 20);
        let data = self
            .client
            .call(
                "music.search.SearchCgiService",
                "DoSearchForQQMusicMobile",
                json!({
                    // searchid 必须是 18~19 位的大数，短值会让接口回空结果却依然 code=0
                    "searchid": new_search_id(),
                    "query": keyword,
                    "search_type": 0,
                    "num_per_page": limit,
                    "page_num": 1,
                    "highlight": false,
                    "grp": true
                }),
                QqPlatform::Desktop,
            )
            .await?;
        let songs = data
            .pointer("/body/item_song")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(songs.iter().take(limit).map(to_source).collect())
    }

    async fn resolve(&self, url: &str, limit: usize) -> Result<Option<ResolveResponse>> {
        let text = self.expand_short_link(url).await;
        if !Self::is_qq_link(&text) {
            return Ok(None);
        }
        let limit = effective_limit(limit, 500);

        if let Some(song_key) = parse_song(&text) {
            let song = self.query_song(&song_key).await?;
            if song.is_null() {
                bail!("没有读取到这首 QQ 音乐歌曲（{song_key}）");
            }
            let source = to_source(&song);
            return Ok(Some(ResolveResponse {
                kind: ResolveKind::Song,
                platform: Platform::Qqm,
                title: source.title.clone(),
                sources: vec![source],
            }));
        }
        if let Some(playlist_id) = parse_playlist(&text) {
            let (title, songs) = self.playlist_tracks(&playlist_id, limit).await?;
            if songs.is_empty() {
                bail!("没有读取到这个 QQ 音乐歌单（{playlist_id}）");
            }
            return Ok(Some(ResolveResponse {
                kind: ResolveKind::Playlist,
                platform: Platform::Qqm,
                title,
                sources: songs.iter().take(limit).map(to_source).collect(),
            }));
        }
        Ok(None)
    }

    async fn download(&self, job: DownloadJob<'_>) -> Result<PathBuf> {
        job.check_canceled()?;
        let source = job.source;
        let output_dir = self.ctx.platform_dir(Platform::Qqm)?;

        let mut raw = Value::Object(source.payload.clone());
        let mut media_mid = media_mid_of(&raw, &source.key);
        let mut album_mid = album_mid_of(&raw);
        let mut resolved = self.resolve_url(&source.key, &media_mid, job.quality).await?;
        if resolved.is_none() {
            // 搜索结果里的 media_mid 偶尔是空的，回查一次详情再试
            let detail = self.query_song(&source.key).await?;
            if !detail.is_null() {
                media_mid = media_mid_of(&detail, &source.key);
                if album_mid.is_empty() {
                    album_mid = album_mid_of(&detail);
                }
                raw = detail;
                resolved = self.resolve_url(&source.key, &media_mid, job.quality).await?;
            }
        }
        let _ = &raw;
        let Some((url, ext)) = resolved else {
            bail!("QQ 音乐没有返回可用下载地址（可能是版权受限或需要绿钻）");
        };
        job.check_canceled()?;

        let filename = render_filename(
            &self.ctx.filename_template,
            &source.title,
            &source.artist_text(),
            &source.album,
            &source.key,
            ext,
        );
        let final_path = output_dir.join(filename);
        remove_existing(&final_path);

        let guard = AtomicDownload::new(&final_path);
        let response = self
            .client
            .http()
            .get(&url)
            .send()
            .await
            .context("QQ 音乐音频下载失败")?
            .error_for_status()
            .context("QQ 音乐音频下载失败")?;
        let total = response.content_length().unwrap_or(0);
        job.report(0, total);

        let mut file = tokio::fs::File::create(guard.partial())
            .await
            .context("创建下载临时文件失败")?;
        let mut downloaded = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            job.check_canceled()?;
            let chunk = chunk.context("QQ 音乐音频流中断")?;
            file.write_all(&chunk).await.context("写入下载文件失败")?;
            downloaded += chunk.len() as u64;
            job.report(downloaded, total.max(downloaded));
        }
        file.flush().await.ok();
        drop(file);
        let path = guard.commit()?;

        let cover_key = if album_mid.is_empty() {
            source.cover.clone()
        } else {
            album_mid
        };
        let cover = self.fetch_cover(&cover_key).await;
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
            tracing::warn!("QQ 音乐写标签失败 song={}: {err}", source.key);
        }
        Ok(path)
    }
}

// ---------------------------------------------------------------- 纯函数

fn parse_playlist(text: &str) -> Option<String> {
    let parsed = url::Url::parse(text).ok()?;
    let path = parsed.path().to_string();
    if path.contains("playsong") {
        return None;
    }
    let params: HashMap<String, String> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    // taoge.html 是 QQ 音乐 App 分享歌单的经典落地页
    if let Some(id) = params.get("id") {
        if ["playlist", "songlist", "details/playlist", "taoge"]
            .iter()
            .any(|marker| path.contains(marker))
        {
            return Some(id.clone());
        }
    }
    let blob = format!("{path}#{}", parsed.fragment().unwrap_or_default());
    for marker in ["playlist", "songlist"] {
        if let Some(id) = digits_after_separator(&blob, marker) {
            return Some(id);
        }
    }
    None
}

fn parse_song(text: &str) -> Option<String> {
    let parsed = url::Url::parse(text).ok()?;
    let params: HashMap<String, String> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    for key in ["songmid", "mid"] {
        if let Some(value) = params.get(key).filter(|value| !value.is_empty()) {
            return Some(value.clone());
        }
    }
    let path = parsed.path();
    if let Some(id) = params
        .get("songid")
        .or_else(|| params.get("id"))
        .filter(|value| !value.is_empty())
    {
        if path.contains("playsong") || path.contains("song") {
            return Some(id.clone());
        }
    }
    if let Some(value) = params.get("media_mid").filter(|value| !value.is_empty()) {
        return Some(value.clone());
    }
    if path.contains("song") || path.contains("playsong") {
        if let Some(last) = path.split('/').filter(|part| !part.is_empty()).next_back() {
            if !last.is_empty() && last.chars().all(|c| c.is_ascii_alphanumeric()) {
                return Some(last.to_string());
            }
        }
    }
    None
}

/// 找 `playlist/12345` 或 `playlist=12345`。
///
/// 要扫过 **所有** `marker` 出现的位置，不能只看第一处：Python 那边是
/// `re.search(r"playlist[/=](\d+)", blob)`，正则会一路往后找。只看第一处的话，
/// `/n/ryqq/playlist_v2/playlist/123` 这种路径会卡在 `playlist_v2` 上直接放弃。
fn digits_after_separator(haystack: &str, marker: &str) -> Option<String> {
    let mut offset = 0usize;
    while let Some(found) = haystack.get(offset..)?.find(marker) {
        offset = offset + found + marker.len();
        let rest = haystack.get(offset..)?;
        let mut chars = rest.chars();
        if !matches!(chars.next(), Some('/') | Some('=')) {
            continue;
        }
        let digits: String = chars.take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            return Some(digits);
        }
    }
    None
}

/// 歌单条目里有没有可用的下载键。
///
/// Python 是 `if song.get("mid") or song.get("id")`——**真值判断**。
/// 写成 `song.get("mid").is_some()` 的话 `{"mid": ""}` 这种占位条目会被留下，
/// 归一化后 `key` 是空串，那首歌在列表里看得见、点下载必然失败。
fn has_song_key(song: &Value) -> bool {
    is_truthy(song.get("mid")) || is_truthy(song.get("id"))
}

fn media_mid_of(raw: &Value, fallback: &str) -> String {
    raw.get("file")
        .and_then(|file| file.get("media_mid"))
        .or_else(|| raw.get("media_mid"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn album_mid_of(raw: &Value) -> String {
    let album = raw.get("album").filter(|value| value.is_object());
    if let Some(mid) = album
        .and_then(|album| album.get("mid"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return mid.to_string();
    }
    if let Some(mid) = raw
        .get("album_mid")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return mid.to_string();
    }
    album
        .and_then(|album| album.get("pmid"))
        .and_then(Value::as_str)
        .and_then(|pmid| pmid.split('_').next())
        .unwrap_or_default()
        .to_string()
}

fn to_source(song: &Value) -> SongSource {
    // 三组别名来自不同年代的接口，空串要继续往后退（Python 的 `or` 链）：
    // 歌单接口的条目常常同时有 `name`（空）和 `songname`（真值）。
    let title = str_field(song, "name")
        .or_else(|| str_field(song, "title"))
        .or_else(|| str_field(song, "songname"))
        .unwrap_or("Unknown")
        .to_string();
    // mid 是下载用的 key，退化链断在空串上会让整首歌下不下来
    let mid = first_truthy(song, &["mid", "songmid", "id"])
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    let artists = song
        .get("singer")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|singer| singer.get("name").and_then(Value::as_str))
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let album = song.get("album").filter(|value| value.is_object());
    let album_mid = album_mid_of(song);
    let duration = song
        .get("interval")
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0);

    let file = song.get("file");
    // Python 是 `int(file_info.get("size_flac") or 0)`：字符串体积也要能转
    let size_of = |key: &str| loose_int(file.and_then(|file| file.get(key)));
    let max_quality = if size_of("size_flac") > 0 {
        Some(Quality::Flac)
    } else if size_of("size_320mp3") > 0 {
        Some(Quality::Q320)
    } else if size_of("size_128mp3") > 0 {
        Some(Quality::Q128)
    } else {
        None
    };
    let pay = song.get("pay");
    let vip = ["pay_play", "pay_down", "pay_month"]
        .iter()
        .any(|key| loose_int(pay.and_then(|pay| pay.get(*key))) == 1);

    SongSource {
        platform: Platform::Qqm,
        key: mid,
        title,
        artists,
        album: album
            .and_then(|album| str_field(album, "name").or_else(|| str_field(album, "title")))
            .unwrap_or_default()
            .to_string(),
        duration,
        cover: if album_mid.is_empty() {
            String::new()
        } else {
            format!("https://y.qq.com/music/photo_new/T002R300x300M000{album_mid}.jpg")
        },
        max_quality,
        vip,
        payload: song.as_object().cloned().unwrap_or_default(),
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// 让 `Credential` 在外部可见（server 层组装账号信息时会用到）。
pub use super::client::Credential as QqCredential;
const _: fn() -> Credential = Credential::default;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn song_links_of_every_shape_are_parsed() {
        assert_eq!(
            parse_song("https://y.qq.com/n/ryqq/songDetail/003Y1vTt3fRAsW"),
            Some("003Y1vTt3fRAsW".into())
        );
        assert_eq!(
            parse_song("https://y.qq.com/n/yqq/song/003Y1vTt3fRAsW.html?songmid=003Y1vTt3fRAsW"),
            Some("003Y1vTt3fRAsW".into())
        );
        assert_eq!(
            parse_song("https://i.y.qq.com/v8/playsong.html?songid=123456"),
            Some("123456".into())
        );
    }

    #[test]
    fn playlist_links_of_every_shape_are_parsed() {
        assert_eq!(
            parse_playlist("https://y.qq.com/n/ryqq/playlist/8674642290"),
            Some("8674642290".into())
        );
        assert_eq!(
            parse_playlist("https://i.y.qq.com/n2/m/share/details/taoge.html?id=8674642290"),
            Some("8674642290".into())
        );
        // 单曲链接不能被当成歌单
        assert_eq!(
            parse_playlist("https://i.y.qq.com/v8/playsong.html?songid=1&id=2"),
            None
        );
    }

    #[test]
    fn playlist_marker_is_searched_past_the_first_occurrence() {
        // Python 用 `re.search`，会一路往后找；只看第一处会卡在 `playlist_v2` 上
        assert_eq!(
            digits_after_separator("/n/ryqq/playlist_v2/playlist/8674642290", "playlist"),
            Some("8674642290".into())
        );
        assert_eq!(
            parse_playlist("https://y.qq.com/n/ryqq/playlist_v2/playlist/8674642290"),
            Some("8674642290".into())
        );
        assert_eq!(digits_after_separator("/n/ryqq/playlist_v2/x", "playlist"), None);
    }

    #[test]
    fn empty_aliases_fall_through_like_the_python_or_chain() {
        // 歌单接口的条目常常 name 为空、真名在 songname 上；mid 为空时要退到 id
        let song = json!({
            "name": "", "title": "", "songname": "真名",
            "mid": "", "songmid": "", "id": 4321,
            "album": {"name": "", "title": "专辑别名"}
        });
        let source = to_source(&song);
        assert_eq!(source.title, "真名");
        assert_eq!(source.key, "4321", "空 mid 必须退到 id，否则这首歌下不下来");
        assert_eq!(source.album, "专辑别名");
    }

    #[test]
    fn playlist_entries_without_a_usable_key_are_dropped() {
        // Python 的过滤是真值判断，空串占位条目要丢掉——留下来的话
        // 前端能看见这一行、点下载必然失败
        assert!(has_song_key(&json!({"mid": "001abc"})));
        assert!(has_song_key(&json!({"id": 4321})));
        assert!(!has_song_key(&json!({"mid": ""})));
        assert!(!has_song_key(&json!({"mid": "", "id": 0})));
        assert!(!has_song_key(&json!({"mid": null, "id": null})));
        assert!(!has_song_key(&json!({})));
        // 空 mid + 真 id 仍然可用（to_source 会退到 id）
        assert!(has_song_key(&json!({"mid": "", "id": 4321})));
    }

    #[test]
    fn file_sizes_and_pay_flags_accept_string_numbers() {
        // Python 是 `int(file_info.get("size_flac") or 0)` / `int(pay.get(k) or 0)`
        let song = json!({"file": {"size_flac": "30000000"}, "pay": {"pay_play": "1"}});
        let source = to_source(&song);
        assert_eq!(source.max_quality, Some(Quality::Flac));
        assert!(source.vip);
    }

    #[test]
    fn file_type_prefixes_match_the_qq_encoding() {
        assert_eq!(file_type(Quality::Flac), ("F000", "flac"));
        assert_eq!(file_type(Quality::Q320), ("M800", "mp3"));
        assert_eq!(file_type(Quality::Q128), ("M500", "mp3"));
    }

    #[test]
    fn media_mid_falls_back_to_the_song_mid() {
        let with_file = json!({"file": {"media_mid": "001abc"}});
        assert_eq!(media_mid_of(&with_file, "mid1"), "001abc");
        // 搜索结果里 media_mid 偶尔缺失
        assert_eq!(media_mid_of(&json!({}), "mid1"), "mid1");
        assert_eq!(media_mid_of(&json!({"file": {"media_mid": ""}}), "mid1"), "mid1");
    }

    #[test]
    fn album_mid_prefers_mid_then_album_mid_then_pmid_prefix() {
        assert_eq!(album_mid_of(&json!({"album": {"mid": "A1"}})), "A1");
        assert_eq!(album_mid_of(&json!({"album_mid": "A2"})), "A2");
        assert_eq!(album_mid_of(&json!({"album": {"pmid": "A3_1"}})), "A3");
        assert_eq!(album_mid_of(&json!({})), "");
    }

    #[test]
    fn max_quality_reads_the_file_size_table() {
        let flac = json!({"file": {"size_flac": 30000000, "size_320mp3": 9000000}});
        assert_eq!(to_source(&flac).max_quality, Some(Quality::Flac));
        let mp3 = json!({"file": {"size_flac": 0, "size_320mp3": 9000000}});
        assert_eq!(to_source(&mp3).max_quality, Some(Quality::Q320));
        let low = json!({"file": {"size_128mp3": 3000000}});
        assert_eq!(to_source(&low).max_quality, Some(Quality::Q128));
        assert_eq!(to_source(&json!({})).max_quality, None);
    }

    #[test]
    fn vip_flag_comes_from_the_pay_block() {
        assert!(to_source(&json!({"pay": {"pay_play": 1}})).vip);
        assert!(to_source(&json!({"pay": {"pay_down": 1}})).vip);
        assert!(!to_source(&json!({"pay": {"pay_play": 0, "pay_down": 0}})).vip);
    }

    #[test]
    fn cover_url_is_built_from_the_album_mid() {
        let source = to_source(&json!({"name": "x", "mid": "m", "album": {"mid": "A1"}}));
        assert_eq!(
            source.cover,
            "https://y.qq.com/music/photo_new/T002R300x300M000A1.jpg"
        );
        // 没有专辑 mid 就不要拼出一个必然 404 的地址
        assert_eq!(to_source(&json!({"name": "x", "mid": "m"})).cover, "");
    }
}
