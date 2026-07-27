//! 网易云音乐 provider。
//!
//! 直译自 `sidecar/kdj/providers/netease.py`。行为上要一模一样的几处：
//! - 音质按 flac → 320 → 128 逐级降级，全空之后再退一次 legacy player 接口；
//! - "试听片段"检测（文件太小 / 时长明显短于应有时长）要把文件删掉并报错，
//!   否则曲库里会混进 30 秒的残次品；
//! - 短链只有 host 确实是 163cn.tv 时才展开（盲 SSRF）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt as _;
use kdj_core::models::{
    Account, AccountState, Platform, Quality, QrSession, QrStateValue, ResolveKind, ResolveResponse,
    SongSource,
};
use kdj_core::paths::render_filename;
use serde_json::{json, Map, Value};
use tokio::io::AsyncWriteExt as _;

use super::client::{expect_ok, payload, NeteaseClient};
use crate::net::{host_is, AtomicDownload};
use crate::provider::{
    effective_limit, first_truthy, is_truthy, loose_int, qr_data_url_from_text, remove_existing,
    str_field, Capabilities, DownloadJob, MusicProvider, ProviderContext,
};
use crate::tags;

const LABEL: &str = "网易云音乐";
const QR_SESSION_TTL_SECS: u64 = 15 * 60;

/// 契约音质 → (网易云 level, 期望容器)
fn level_of(quality: Quality) -> (&'static str, &'static str) {
    match quality {
        Quality::Flac => ("lossless", "flac"),
        Quality::Q320 => ("exhigh", "mp3"),
        Quality::Q128 => ("standard", "mp3"),
    }
}

pub struct NeteaseProvider {
    ctx: ProviderContext,
    client: NeteaseClient,
    qr_sessions: Mutex<HashMap<String, (String, Instant)>>,
}

impl NeteaseProvider {
    pub fn new(ctx: ProviderContext) -> Result<Self> {
        let session_dir = ctx.session_dir();
        std::fs::create_dir_all(&session_dir).ok();
        let client = NeteaseClient::new(&session_dir)?;
        Ok(NeteaseProvider {
            ctx,
            client,
            qr_sessions: Mutex::new(HashMap::new()),
        })
    }

    // ------------------------------------------------------------ 链接解析

    /// 从分享文本里抠出 (kind, id)；不是网易云链接返回 None。
    async fn parse_url(&self, text: &str) -> Option<(ResolveKind, String)> {
        let mut text = html_unescape(text.trim());

        // 只有 host 确实是 163cn.tv 时才展开短链——此前用子串判断，
        // 任意 URL 只要带上 ?ref=163cn.tv 就会让我们去请求它（盲 SSRF）。
        if host_is(&text, "163cn.tv") && !host_is(&text, "music.163.com") {
            if let Ok(resolved) = crate::net::expand_short_link(
                self.client.http(),
                &text,
                4,
                &|host| {
                    let host = host.to_ascii_lowercase();
                    host == "163cn.tv" || host == "music.163.com" || host.ends_with(".163.com")
                },
            )
            .await
            {
                if host_is(&resolved, "music.163.com") {
                    text = resolved;
                }
            }
        }
        if !host_is(&text, "music.163.com") && !text.contains("music.163.com") {
            return None;
        }
        parse_netease_path(&text)
    }

    // ------------------------------------------------------------ API 封装

    async fn track_detail(&self, song_ids: &[String]) -> Result<Vec<Value>> {
        let ids: Vec<Value> = song_ids.iter().map(|id| json!({ "id": id })).collect();
        let body = self
            .client
            .weapi(
                "/weapi/v3/song/detail",
                payload([("c", Value::String(serde_json::to_string(&ids)?))]),
            )
            .await?;
        if body.get("code").and_then(Value::as_i64) != Some(200) {
            return Ok(Vec::new());
        }
        Ok(body
            .get("songs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// 歌单三级回退：trackIds 反查 → playlist.tracks → 报错。
    ///
    /// 大歌单的 detail 接口只回前若干首完整曲目，但 `trackIds` 永远是完整的，
    /// 所以主路径是"拿 trackIds 分批查详情"。
    async fn playlist_tracks(&self, playlist_id: &str, limit: usize) -> Result<(String, Vec<Value>)> {
        let body = self
            .client
            .weapi(
                "/weapi/v6/playlist/detail",
                payload([
                    ("id", Value::String(playlist_id.to_string())),
                    ("offset", Value::String("0".into())),
                    ("total", Value::String("true".into())),
                    ("limit", Value::String("1000".into())),
                    ("n", Value::String("1000".into())),
                ]),
            )
            .await?;
        expect_ok(&body, "读取网易云歌单")?;

        let playlist = body.get("playlist").cloned().unwrap_or(Value::Null);
        // 空的 name 要退回默认标题（Python 是 `str(playlist.get("name") or default)`），
        // 否则歌单卡片上会出现一个没有名字的标题栏。
        let title = str_field(&playlist, "name")
            .map(str::to_string)
            .unwrap_or_else(|| format!("网易云歌单 {playlist_id}"));

        let track_ids: Vec<String> = playlist
            .get("trackIds")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|item| item.get("id"))
                    .map(stringify_id)
                    .filter(|id| !id.is_empty())
                    .take(limit)
                    .collect()
            })
            .unwrap_or_default();

        if !track_ids.is_empty() {
            let mut songs = Vec::with_capacity(track_ids.len());
            // 详情接口一次最多 1000 首，大歌单要分批
            for chunk in track_ids.chunks(500) {
                songs.extend(self.track_detail(chunk).await?);
            }
            if !songs.is_empty() {
                return Ok((title, songs));
            }
        }

        let songs = playlist
            .get("tracks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok((title, songs.into_iter().take(limit).collect()))
    }

    /// 拿播放直链。返回 (url, 实际容器扩展名, 文件大小)。
    async fn resolve_audio(&self, key: &str, quality: Quality) -> Result<(String, String, u64)> {
        let mut last_code = None;
        for step in quality.gradient() {
            let (level, _) = level_of(*step);
            let body = if self.ctx.netease_use_download_api {
                self.client
                    .eapi(
                        "/eapi/song/enhance/download/url/v1",
                        payload([
                            ("id", Value::String(format!("{key}_0"))),
                            ("level", Value::String(level.into())),
                        ]),
                    )
                    .await?
            } else {
                self.client
                    .eapi(
                        "/eapi/song/enhance/player/url/v1",
                        payload([
                            ("ids", json!([key])),
                            ("encodeType", Value::String("flac".into())),
                            ("level", Value::String(level.into())),
                        ]),
                    )
                    .await?
            };
            last_code = body.get("code").and_then(Value::as_i64);
            if last_code == Some(200) {
                if let Some(found) = first_audio_data(&body) {
                    tracing::info!(
                        "netease audio song={key} level={level} type={} br={:?}",
                        found.1,
                        found.2
                    );
                    return Ok(found);
                }
            }
        }

        // player-v1 全梯度都空时退回 legacy 接口，老账号/老曲目还能捞一把
        if !self.ctx.netease_use_download_api {
            let body = self
                .client
                .eapi(
                    "/eapi/song/enhance/player/url",
                    payload([
                        ("ids", json!([key])),
                        ("encodeType", Value::String("aac".into())),
                        ("br", Value::String("320000".into())),
                    ]),
                )
                .await?;
            if body.get("code").and_then(Value::as_i64) == Some(200) {
                if let Some(found) = first_audio_data(&body) {
                    tracing::info!("netease audio song={key} api=player-legacy");
                    return Ok(found);
                }
            }
        }
        bail!(
            "网易云没有返回可用下载地址（可能是版权受限或需要会员），code={:?}",
            last_code
        )
    }

    async fn fetch_cover(&self, url: &str) -> Option<Vec<u8>> {
        if url.is_empty() {
            return None;
        }
        let response = self.client.http().get(url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.bytes().await.ok().map(|b| b.to_vec())
    }

    fn prune_qr_sessions(&self) {
        let mut sessions = self.qr_sessions.lock().unwrap();
        sessions.retain(|_, (_, born)| born.elapsed().as_secs() <= QR_SESSION_TTL_SECS);
    }

    /// 扫码成功后拉一次登录态写进会话，重启后不用发请求就能显示昵称。
    async fn finish_login(&self) {
        match self
            .client
            .weapi("/weapi/w/nuser/account/get", Map::new())
            .await
        {
            Ok(status) => self.client.set_profile(Some(status)),
            Err(err) => tracing::warn!("写入网易云登录信息失败：{err}"),
        }
        self.client.save_session();
    }
}

#[async_trait]
impl MusicProvider for NeteaseProvider {
    fn platform(&self) -> Platform {
        Platform::Wyy
    }

    fn label(&self) -> &str {
        LABEL
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::MUSIC
    }

    async fn account(&self) -> Account {
        if !self.client.logged_in() {
            return Account::new(Platform::Wyy, LABEL, AccountState::Missing, "未登录");
        }
        let status = match self
            .client
            .weapi("/weapi/w/nuser/account/get", Map::new())
            .await
        {
            Ok(status) => status,
            Err(err) => {
                // 网络抖动不能把"已登录"误报成掉线，降级成 unknown 让前端保持原样
                let mut account =
                    Account::new(Platform::Wyy, LABEL, AccountState::Unknown, "");
                account.detail = truncate(&format!("登录态检查失败：{err}"), 160);
                if let Some(nickname) = cached_nickname(&self.client.profile()) {
                    account.nickname = nickname;
                }
                return account;
            }
        };

        let data = status.get("data").unwrap_or(&status);
        let profile = data.get("profile");
        let account_id = data.get("account").and_then(|a| a.get("id"));
        if let (Some(profile), Some(_)) = (profile, account_id) {
            if !profile.is_null() {
                self.client.set_profile(Some(status.clone()));
                let vip_type = profile.get("vipType").and_then(Value::as_i64).unwrap_or(0);
                let mut account = Account::new(
                    Platform::Wyy,
                    LABEL,
                    AccountState::Valid,
                    if vip_type != 0 { "黑胶会员" } else { "普通用户" },
                );
                account.nickname = profile
                    .get("nickname")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                account.avatar = profile
                    .get("avatarUrl")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                return account;
            }
        }
        Account::new(
            Platform::Wyy,
            LABEL,
            AccountState::Expired,
            "登录态已失效，请重新扫码",
        )
    }

    async fn create_qr(&self) -> Result<QrSession> {
        let body = self
            .client
            .weapi(
                "/weapi/login/qrcode/unikey",
                payload([
                    ("type", Value::String("1".into())),
                    ("noCheckToken", Value::Bool(true)),
                ]),
            )
            .await?;
        let unikey = body
            .get("unikey")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        anyhow::ensure!(!unikey.is_empty(), "网易云二维码获取失败：{body}");

        let url = format!("https://music.163.com/login?codekey={unikey}");
        let session_id = new_session_id();
        self.prune_qr_sessions();
        self.qr_sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), (unikey, Instant::now()));
        Ok(QrSession {
            platform: Platform::Wyy,
            session_id,
            image: qr_data_url_from_text(&url)?,
            url,
            expires_in: 180,
        })
    }

    async fn poll_qr(&self, session_id: &str) -> Result<(QrStateValue, String)> {
        let unikey = {
            let sessions = self.qr_sessions.lock().unwrap();
            sessions.get(session_id).map(|(key, _)| key.clone())
        };
        let Some(unikey) = unikey else {
            return Ok((
                QrStateValue::Error,
                "二维码会话不存在或已过期，请重新获取".into(),
            ));
        };

        let body = match self
            .client
            .weapi(
                "/weapi/login/qrcode/client/login",
                payload([
                    ("type", Value::from(1)),
                    ("noCheckToken", Value::Bool(true)),
                    ("key", Value::String(unikey)),
                ]),
            )
            .await
        {
            Ok(body) => body,
            Err(err) => {
                return Ok((
                    QrStateValue::Error,
                    truncate(&format!("检查二维码状态失败：{err}"), 160),
                ))
            }
        };

        let code = body.get("code").and_then(Value::as_i64).unwrap_or(0);
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        // 800 过期 / 801 待扫 / 802 已扫待确认 / 803 登录成功
        match code {
            800 => {
                self.qr_sessions.lock().unwrap().remove(session_id);
                Ok((
                    QrStateValue::Expired,
                    or_default(message, "二维码已过期，请重新获取"),
                ))
            }
            801 => Ok((QrStateValue::Waiting, or_default(message, "等待手机扫码"))),
            802 => {
                let nickname = body
                    .get("nickname")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let fallback = if nickname.is_empty() {
                    "已扫码，请在手机上确认".to_string()
                } else {
                    format!("{nickname} 已扫码，请在手机上确认")
                };
                Ok((QrStateValue::Scanned, or_default(message, &fallback)))
            }
            803 => {
                self.qr_sessions.lock().unwrap().remove(session_id);
                self.finish_login().await;
                Ok((QrStateValue::Done, or_default(message, "登录成功")))
            }
            _ => Ok((QrStateValue::Waiting, message)),
        }
    }

    async fn logout(&self) -> Result<()> {
        let _ = self.client.weapi("/weapi/logout", Map::new()).await;
        self.client.clear_session();
        self.qr_sessions.lock().unwrap().clear();
        Ok(())
    }

    async fn search(&self, keyword: &str, limit: usize) -> Result<Vec<SongSource>> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(Vec::new());
        }
        let limit = effective_limit(limit, 20);
        let body = self
            .client
            .eapi(
                "/eapi/cloudsearch/pc",
                payload([
                    ("s", Value::String(keyword.to_string())),
                    ("type", Value::String("1".into())),
                    ("limit", Value::String(limit.to_string())),
                    ("offset", Value::String("0".into())),
                ]),
            )
            .await?;
        expect_ok(&body, "网易云搜索")?;
        let songs = body
            .get("result")
            .and_then(|r| r.get("songs"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(songs.iter().take(limit).map(to_source).collect())
    }

    async fn resolve(&self, url: &str, limit: usize) -> Result<Option<ResolveResponse>> {
        let Some((kind, key)) = self.parse_url(url).await else {
            return Ok(None);
        };
        let limit = effective_limit(limit, 500);
        if kind == ResolveKind::Song {
            let songs = self.track_detail(std::slice::from_ref(&key)).await?;
            let Some(song) = songs.first() else {
                bail!("没有读取到这首网易云歌曲（id={key}）");
            };
            let source = to_source(song);
            return Ok(Some(ResolveResponse {
                kind: ResolveKind::Song,
                platform: Platform::Wyy,
                title: source.title.clone(),
                sources: vec![source],
            }));
        }

        let (title, songs) = self.playlist_tracks(&key, limit).await?;
        if songs.is_empty() {
            bail!("没有读取到这个网易云歌单（id={key}）");
        }
        Ok(Some(ResolveResponse {
            kind: ResolveKind::Playlist,
            platform: Platform::Wyy,
            title,
            sources: songs.iter().take(limit).map(to_source).collect(),
        }))
    }

    /// 试听走 128K 档：`Q128.gradient()` 只有一级，天然就是"最低码率"。
    async fn preview_url(&self, source: &SongSource) -> Result<Option<String>> {
        let (url, _ext, _size) = self.resolve_audio(&source.key, Quality::Q128).await?;
        Ok(Some(url))
    }

    async fn download(&self, job: DownloadJob<'_>) -> Result<PathBuf> {
        job.check_canceled()?;
        let source = job.source;
        let output_dir = self.ctx.platform_dir(Platform::Wyy)?;
        let (url, ext, declared_size) = self.resolve_audio(&source.key, job.quality).await?;
        job.check_canceled()?;

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
            .client
            .http()
            .get(&url)
            .send()
            .await
            .context("网易云音频下载失败")?
            .error_for_status()
            .context("网易云音频下载失败")?;
        let total = response.content_length().unwrap_or(declared_size);
        job.report(0, total);

        let mut file = tokio::fs::File::create(guard.partial())
            .await
            .context("创建下载临时文件失败")?;
        let mut downloaded = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            job.check_canceled()?;
            let chunk = chunk.context("网易云音频流中断")?;
            file.write_all(&chunk).await.context("写入下载文件失败")?;
            downloaded += chunk.len() as u64;
            job.report(downloaded, total.max(downloaded));
        }
        file.flush().await.ok();
        drop(file);

        // 试听片段检测必须在 commit 之前：半成品一旦落到最终路径，
        // 曲库扫描就会把 30 秒的残次品当成正常曲目收进去。
        if looks_like_preview_clip(guard.partial(), source) {
            bail!("网易云只返回了试听片段（需要会员或版权受限）");
        }
        let path = guard.commit()?;

        // Python 在下载前会做一次 `if not song_info.get("al"): 回查详情`——那次回查
        // **只为封面**。payload 里没有 al 时（前端手搓的请求、老版本存下来的队列条目）
        // 直接跳过等于下下来的文件没有专辑封面，所以这一步不能省。
        let mut cover_url = source.cover.clone();
        if cover_url.is_empty() && needs_detail_for_cover(source) {
            if let Ok(songs) = self.track_detail(std::slice::from_ref(&source.key)).await {
                if let Some(found) = songs.first().and_then(cover_from_detail) {
                    cover_url = found;
                }
            }
        }
        if cover_url.is_empty() {
            cover_url = cover_from_detail(&Value::Object(source.payload.clone())).unwrap_or_default();
        }
        let cover = self.fetch_cover(&cover_url).await;
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
            tracing::warn!("网易云写标签失败 song={}: {err}", source.key);
        }
        Ok(path)
    }
}

// ---------------------------------------------------------------- 纯函数

/// `/song?id=1` `/playlist?id=1` `#/song?id=1` 三种形状都要认。
fn parse_netease_path(text: &str) -> Option<(ResolveKind, String)> {
    let parsed = url::Url::parse(text).ok()?;
    let mut params: HashMap<String, String> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let mut path = parsed.path().to_string();

    // 网页版链接的真身在 fragment 里：/#/song?id=xxx
    if let Some(fragment) = parsed.fragment() {
        let (frag_path, frag_query) = match fragment.split_once('?') {
            Some((p, q)) => (p, Some(q)),
            None => (fragment, None),
        };
        if let Some(query) = frag_query {
            for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
                params.entry(key.into_owned()).or_insert(value.into_owned());
            }
        }
        if path.is_empty() || path == "/" {
            path = if frag_path.starts_with('/') {
                frag_path.to_string()
            } else {
                format!("/{frag_path}")
            };
        }
    }

    let path_lower = path.to_ascii_lowercase();
    if let Some(id) = params.get("id").filter(|id| !id.is_empty()) {
        if path_lower.contains("/song") {
            return Some((ResolveKind::Song, id.clone()));
        }
        if path_lower.contains("/playlist") {
            return Some((ResolveKind::Playlist, id.clone()));
        }
    }
    for (kind, marker) in [(ResolveKind::Song, "song"), (ResolveKind::Playlist, "playlist")] {
        if let Some(id) = digits_after(&path_lower, marker) {
            return Some((kind, id));
        }
    }
    if let Some(id) = params.get("id").filter(|id| !id.is_empty()) {
        if text.contains("song") && !path_lower.contains("playlist") {
            return Some((ResolveKind::Song, id.clone()));
        }
        if text.contains("playlist") {
            return Some((ResolveKind::Playlist, id.clone()));
        }
    }
    None
}

/// 找 `/song/12345` `/playlist12345` 这种"关键字后面第一串数字"。
fn digits_after(haystack: &str, marker: &str) -> Option<String> {
    let start = haystack.find(marker)? + marker.len();
    let rest = &haystack[start..];
    let digits: String = rest
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    // 关键字和数字之间只允许非数字分隔符，别把 "/song" 后面很远处的数字算进来
    let gap = rest.chars().take_while(|c| !c.is_ascii_digit()).count();
    if digits.is_empty() || gap > 2 {
        None
    } else {
        Some(digits)
    }
}

/// 要不要为了封面回查一次详情。
///
/// 对应 Python 的 `if not song_info.get("al")`：`al` 缺失/为 null/为空对象都算"没有"。
fn needs_detail_for_cover(source: &SongSource) -> bool {
    !is_truthy(source.payload.get("al"))
}

/// 从一条曲目详情里取封面地址（`al.picUrl`）。
fn cover_from_detail(song: &Value) -> Option<String> {
    song.get("al")
        .and_then(|album| str_field(album, "picUrl"))
        .map(str::to_string)
}

fn first_audio_data(body: &Value) -> Option<(String, String, u64)> {
    let data = body.get("data")?;
    let entry = match data {
        Value::Array(list) => list.first()?,
        Value::Object(_) => data,
        _ => return None,
    };
    let url = entry.get("url").and_then(Value::as_str)?;
    if url.is_empty() {
        return None;
    }
    let ext = entry
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("mp3")
        .to_string();
    let size = entry.get("size").and_then(Value::as_u64).unwrap_or(0);
    Some((url.to_string(), ext, size))
}

/// 试听片段检测：文件过小、或时长明显短于应有时长，就当失败。
fn looks_like_preview_clip(path: &std::path::Path, source: &SongSource) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return true;
    };
    if meta.len() < 100 * 1024 {
        return true;
    }
    let Some(duration) = tags::read_duration_secs(path) else {
        return false;
    };
    let expected = expected_duration(source);
    if let Some(expected) = expected {
        if expected > 60.0 && duration < 45.0_f64.min(expected * 0.5) {
            return true;
        }
    }
    duration <= 35.0 && expected.is_none_or(|value| value > 60.0)
}

fn expected_duration(source: &SongSource) -> Option<f64> {
    if let Some(duration) = source.duration.filter(|d| *d > 0.0) {
        return Some(duration);
    }
    let payload = Value::Object(source.payload.clone());
    let raw = first_truthy(&payload, &["dt", "duration"])
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)?;
    // dt 是毫秒；老接口的 duration 偶尔直接给秒
    Some(if raw > 1000.0 { raw / 1000.0 } else { raw })
}

fn to_source(song: &Value) -> SongSource {
    // `ar` / `al` / `dt` 是新接口，`artists` / `album` / `duration` 是老接口。
    // 这里必须用真值链：新字段是 null 或空数组时要真的退回老字段（Python 的 `or`）。
    let artists = first_truthy(song, &["ar", "artists"])
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|artist| artist.get("name").and_then(Value::as_str))
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let album = first_truthy(song, &["al", "album"]).filter(|value| value.is_object());

    // dt 是毫秒；老接口的 duration 偶尔直接给秒
    let duration = first_truthy(song, &["dt", "duration"])
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
        .map(|raw| if raw > 1000.0 { raw / 1000.0 } else { raw });

    let (max_quality, vip) = quality_and_vip(song);
    SongSource {
        platform: Platform::Wyy,
        key: song.get("id").map(stringify_id).unwrap_or_default(),
        title: str_field(song, "name").unwrap_or("Unknown").to_string(),
        artists,
        album: album
            .and_then(|al| str_field(al, "name"))
            .unwrap_or_default()
            .to_string(),
        duration,
        cover: album
            .and_then(|al| str_field(al, "picUrl"))
            .unwrap_or_default()
            .to_string(),
        max_quality,
        vip,
        payload: song.as_object().cloned().unwrap_or_default(),
    }
}

fn quality_and_vip(song: &Value) -> (Option<Quality>, bool) {
    let privilege = song.get("privilege").filter(|value| value.is_object());
    // 详情接口给的是 sq/hr/h/m/l 五档音质对象，搜索接口只给 privilege.maxbr。
    // 判断要和 Python 的 `if song.get("sq")` 一致：空对象也算"没有这一档"。
    let has = |key: &str| is_truthy(song.get(key));
    let max_quality = if has("sq") || has("hr") {
        Some(Quality::Flac)
    } else if has("h") {
        Some(Quality::Q320)
    } else if has("m") || has("l") {
        Some(Quality::Q128)
    } else {
        // Python 是 `privilege.get("maxbr") or song.get("maxbr") or 0`——**真值链**：
        // privilege 里的 maxbr 是 0 时要真的退到顶层 maxbr。
        // 写成 `.or_else()` 会停在 `Some(0)` 上，于是顶层带着 999000 的曲目
        // 被判成"没有音质信息"，前端连音质角标都不显示。
        let maxbr = loose_int(
            privilege
                .and_then(|p| p.get("maxbr"))
                .filter(|value| is_truthy(Some(value)))
                .or_else(|| song.get("maxbr")),
        );
        if maxbr >= 999_000 {
            Some(Quality::Flac)
        } else if maxbr >= 320_000 {
            Some(Quality::Q320)
        } else if maxbr > 0 {
            Some(Quality::Q128)
        } else {
            None
        }
    };
    // fee 这条**不是**真值链：Python 写的是 `privilege.get("fee", song.get("fee"))`，
    // 带默认值的 get——privilege 里有 fee=0 就用 0，不往顶层退。
    let fee = loose_int(privilege.and_then(|p| p.get("fee")).or_else(|| song.get("fee")));
    // fee: 1=VIP 专享 4=专辑付费 8=低音质免费（非会员只能听低码率）
    (max_quality, fee == 1 || fee == 4)
}

fn stringify_id(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

fn html_unescape(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn or_default(message: String, fallback: &str) -> String {
    if message.is_empty() {
        fallback.to_string()
    } else {
        message
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

fn cached_nickname(profile: &Option<Value>) -> Option<String> {
    profile
        .as_ref()?
        .get("data")
        .or(profile.as_ref())?
        .get("profile")?
        .get("nickname")?
        .as_str()
        .map(str::to_string)
}

fn new_session_id() -> String {
    // 只用来做本进程内的会话键，不需要密码学强度
    format!("{:032x}", rand::random::<u128>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_share_link_shape_we_have_seen() {
        assert_eq!(
            parse_netease_path("https://music.163.com/song?id=347230"),
            Some((ResolveKind::Song, "347230".into()))
        );
        assert_eq!(
            parse_netease_path("https://music.163.com/#/song?id=347230"),
            Some((ResolveKind::Song, "347230".into()))
        );
        assert_eq!(
            parse_netease_path("https://music.163.com/#/playlist?id=123456"),
            Some((ResolveKind::Playlist, "123456".into()))
        );
        assert_eq!(
            parse_netease_path("https://music.163.com/song/347230"),
            Some((ResolveKind::Song, "347230".into()))
        );
        assert_eq!(
            parse_netease_path("https://music.163.com/m/playlist?id=999&userid=1"),
            Some((ResolveKind::Playlist, "999".into()))
        );
    }

    #[test]
    fn non_netease_links_are_not_claimed() {
        assert_eq!(parse_netease_path("https://y.qq.com/n/ryqq/songDetail/x"), None);
        assert_eq!(parse_netease_path("not a url"), None);
    }

    #[test]
    fn quality_comes_from_detail_objects_first_then_maxbr() {
        let detail = json!({"sq": {"br": 1000000}, "privilege": {"fee": 1}});
        assert_eq!(
            quality_and_vip(&detail),
            (Some(Quality::Flac), true),
            "详情接口有 sq 就是无损"
        );

        let search = json!({"privilege": {"maxbr": 320000, "fee": 0}});
        assert_eq!(quality_and_vip(&search), (Some(Quality::Q320), false));

        let free = json!({"privilege": {"maxbr": 128000, "fee": 8}});
        assert_eq!(
            quality_and_vip(&free),
            (Some(Quality::Q128), false),
            "fee=8 是低音质免费，不算 VIP 专享"
        );

        assert_eq!(quality_and_vip(&json!({})), (None, false));
    }

    #[test]
    fn zero_maxbr_in_privilege_falls_through_to_the_top_level_one() {
        // Python 是 `privilege.get("maxbr") or song.get("maxbr") or 0`（真值链）。
        // 停在 `Some(0)` 上会让这首歌的音质角标整个消失。
        let song = json!({"privilege": {"maxbr": 0, "fee": 0}, "maxbr": 999000});
        assert_eq!(quality_and_vip(&song).0, Some(Quality::Flac));

        // privilege 里有真值时不许被顶层覆盖
        let both = json!({"privilege": {"maxbr": 128000}, "maxbr": 999000});
        assert_eq!(quality_and_vip(&both).0, Some(Quality::Q128));
    }

    #[test]
    fn maxbr_and_fee_accept_the_string_shapes_python_coerced() {
        // Python 是 `int(maxbr)`：字符串码率照样能转
        let song = json!({"privilege": {"maxbr": "999000", "fee": "1"}});
        assert_eq!(quality_and_vip(&song), (Some(Quality::Flac), true));
        assert_eq!(quality_and_vip(&json!({"privilege": {"maxbr": "x"}})).0, None);
    }

    #[test]
    fn fee_is_a_default_get_not_a_truthy_chain() {
        // Python 写的是 `privilege.get("fee", song.get("fee"))`：
        // privilege 里 fee=0 就是 0，不能退到顶层的 fee=1
        let song = json!({"privilege": {"maxbr": 320000, "fee": 0}, "fee": 1});
        assert!(!quality_and_vip(&song).1);
        // privilege 里压根没有 fee 时才用顶层的
        let fallback = json!({"privilege": {"maxbr": 320000}, "fee": 1});
        assert!(quality_and_vip(&fallback).1);
    }

    #[test]
    fn cover_lookup_only_refetches_when_the_payload_has_no_album() {
        let mut source = SongSource {
            platform: Platform::Wyy,
            key: "1".into(),
            title: "t".into(),
            artists: vec![],
            album: String::new(),
            duration: None,
            cover: String::new(),
            max_quality: None,
            vip: false,
            payload: Default::default(),
        };
        // payload 里没有 al：Python 会回查一次详情，只为拿封面
        assert!(needs_detail_for_cover(&source));
        // 空对象占位也算"没有"（Python 的 `if not song_info.get("al")`）
        source.payload.insert("al".into(), json!({}));
        assert!(needs_detail_for_cover(&source));

        source
            .payload
            .insert("al".into(), json!({"picUrl": "https://p/x.jpg"}));
        assert!(!needs_detail_for_cover(&source));
        assert_eq!(
            cover_from_detail(&Value::Object(source.payload.clone())).as_deref(),
            Some("https://p/x.jpg")
        );
        assert_eq!(cover_from_detail(&json!({"al": {"picUrl": ""}})), None);
    }

    #[test]
    fn empty_placeholder_quality_objects_do_not_claim_lossless() {
        // 接口偶尔用空对象占位，Python 的 `if song.get("sq")` 判成假
        let placeholder = json!({"sq": {}, "hr": null, "h": {"br": 320000}});
        assert_eq!(quality_and_vip(&placeholder).0, Some(Quality::Q320));
    }

    #[test]
    fn legacy_aliases_are_used_when_the_new_fields_are_null() {
        // Python 是 `song.get("ar") or song.get("artists")`：新字段是 null/空要真的往后退
        let legacy = json!({
            "id": 5, "name": "老接口",
            "ar": null, "artists": [{"name": "旧艺人"}],
            "al": null, "album": {"name": "旧专辑", "picUrl": "https://p/x.jpg"},
            "dt": 0, "duration": 210
        });
        let source = to_source(&legacy);
        assert_eq!(source.artists, vec!["旧艺人"]);
        assert_eq!(source.album, "旧专辑");
        assert_eq!(source.cover, "https://p/x.jpg");
        assert_eq!(source.duration, Some(210.0));
    }

    #[test]
    fn empty_title_falls_back_to_unknown() {
        assert_eq!(to_source(&json!({"id": 1, "name": ""})).title, "Unknown");
    }

    #[test]
    fn duration_handles_both_milliseconds_and_seconds() {
        let ms = to_source(&json!({"id": 1, "name": "x", "dt": 245000}));
        assert_eq!(ms.duration, Some(245.0));
        // 老接口偶尔直接给秒
        let secs = to_source(&json!({"id": 1, "name": "x", "duration": 245}));
        assert_eq!(secs.duration, Some(245.0));
    }

    #[test]
    fn source_normalization_keeps_the_raw_payload_for_the_download_call() {
        let song = json!({
            "id": 347230,
            "name": "Supernova",
            "ar": [{"name": "Mr.Kitty"}, {"name": "Guest"}],
            "al": {"name": "Time", "picUrl": "https://p.example/cover.jpg"},
            "dt": 245000
        });
        let source = to_source(&song);
        assert_eq!(source.key, "347230");
        assert_eq!(source.artists, vec!["Mr.Kitty", "Guest"]);
        assert_eq!(source.artist_text(), "Mr.Kitty, Guest");
        assert_eq!(source.album, "Time");
        assert_eq!(source.cover, "https://p.example/cover.jpg");
        // payload 要原样回传给下载接口
        assert_eq!(source.payload.get("dt").unwrap(), 245000);
    }

    #[test]
    fn audio_data_is_read_from_both_list_and_object_shapes() {
        let list = json!({"data": [{"url": "https://a/x.flac", "type": "flac", "size": 42}]});
        assert_eq!(
            first_audio_data(&list),
            Some(("https://a/x.flac".into(), "flac".into(), 42))
        );
        let object = json!({"data": {"url": "https://a/x.mp3", "type": "mp3"}});
        assert_eq!(
            first_audio_data(&object),
            Some(("https://a/x.mp3".into(), "mp3".into(), 0))
        );
        // 空 url 等于没拿到，必须继续降级
        assert_eq!(first_audio_data(&json!({"data": [{"url": ""}]})), None);
        assert_eq!(first_audio_data(&json!({"data": []})), None);
    }

    #[test]
    fn expected_duration_prefers_the_source_field_then_the_payload() {
        let mut source = SongSource {
            platform: Platform::Wyy,
            key: "1".into(),
            title: "t".into(),
            artists: vec![],
            album: String::new(),
            duration: Some(200.0),
            cover: String::new(),
            max_quality: None,
            vip: false,
            payload: Default::default(),
        };
        assert_eq!(expected_duration(&source), Some(200.0));

        source.duration = None;
        source.payload.insert("dt".into(), json!(245000));
        assert_eq!(expected_duration(&source), Some(245.0));
    }

    #[test]
    fn a_thirty_second_preview_is_rejected_even_before_commit() {
        // 这条盯的是真实回归：检测跑在 `.partial` 上，如果时长读不出来
        // 就只剩"小于 100KB"这一个判据，30 秒的 VIP 试听片段（1MB 以上）会直接入库。
        let dir =
            std::env::temp_dir().join(format!("kdj-preview-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let partial = dir.join("试听.flac.partial");
        // 30 秒 8kHz 单声道 = 240KB，稳稳越过 100KB 的体积闸门
        std::fs::write(&partial, crate::tags::tests::silent_wav(30)).unwrap();

        let mut source = SongSource {
            platform: Platform::Wyy,
            key: "1".into(),
            title: "t".into(),
            artists: vec![],
            album: String::new(),
            duration: Some(245.0),
            cover: String::new(),
            max_quality: None,
            vip: false,
            payload: Default::default(),
        };
        assert!(
            looks_like_preview_clip(&partial, &source),
            "应有 245 秒却只有 30 秒，必须判成试听片段"
        );

        // 完整曲目不能误杀
        let full = dir.join("完整.flac.partial");
        std::fs::write(&full, crate::tags::tests::silent_wav(240)).unwrap();
        assert!(!looks_like_preview_clip(&full, &source));

        // 不知道应有时长时，只有短到 35 秒以内才算失败
        source.duration = None;
        assert!(!looks_like_preview_clip(&full, &source));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn level_map_matches_the_python_contract() {
        assert_eq!(level_of(Quality::Flac).0, "lossless");
        assert_eq!(level_of(Quality::Q320).0, "exhigh");
        assert_eq!(level_of(Quality::Q128).0, "standard");
    }
}
