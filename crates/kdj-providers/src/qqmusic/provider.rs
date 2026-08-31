//! QQ 音乐 provider。
//!
//! 直译自 `sidecar/kdj/providers/qqmusic.py`，两处必须保留的行为：
//! - 音质降级：flac → 320 → 128，每一档都真的去要一次 vkey，拿到哪个用哪个；
//! - `url.cn` 短链只有 host 精确匹配时才展开（和网易云同源的盲 SSRF 修复）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use base64::Engine as _;
use futures_util::StreamExt as _;
use kdj_core::models::{
    Account, AccountState, CollectionResolveResponse, CollectionResult, LyricText, Platform,
    QrSession, QrStateValue, QrVariant, Quality, ResolveKind, ResolveResponse, SearchKind,
    SongSource, StreamPlaylist, StreamPlaylistResponse,
};
use kdj_core::paths::render_filename;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt as _;

use super::client::{new_search_id, Credential, QqClient, QqPlatform};
use super::login;
use crate::net::{create_download_writer, host_is, AtomicDownload};
use crate::provider::{
    effective_limit, first_truthy, full_listing, is_truthy, loose_int, qr_data_url_from_png,
    str_field, unique_download_path, Capabilities, DownloadJob, MusicProvider, ProviderContext,
};
use crate::tags;

const LABEL: &str = "QQ 音乐";
/// `isure` 是 QQ 音乐网页和主流开源实现使用的通用音频域名；只有动态调度
/// 没给出可用 HTTPS 节点时才落到这里，避免把所有用户锁死在某个 `sjyN` 机房。
const CDN_FALLBACK: &str = "https://isure.stream.qqmusic.qq.com/";
const QR_SESSION_TTL: Duration = Duration::from_secs(15 * 60);
const PROFILE_TTL: Duration = Duration::from_secs(300);
const SEARCH_KINDS: &[SearchKind] = &[
    SearchKind::Song,
    SearchKind::Playlist,
    SearchKind::Artist,
    SearchKind::Album,
];

fn qq_value_id(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_i64().map(|number| number.to_string()))
        .or_else(|| value.as_u64().map(|number| number.to_string()))
        .unwrap_or_default()
}

fn is_qq_audio_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    parsed.scheme() == "https"
        && (host == "stream.qqmusic.qq.com" || host.ends_with(".stream.qqmusic.qq.com"))
}

/// 按 QQ 返回的顺序选择动态 CDN。vkey 和 cdnDispatch 都可能带 `sip`；顺序
/// 本身就是腾讯按当前网络给出的调度结果，不能再硬编码某个 `sjyN` 节点。
/// 只接受 QQ 音乐自己的 HTTPS 音频域名，避免把服务端回包直接变成任意 SSRF。
fn pick_cdn_base(data: &Value) -> Option<String> {
    data.get("sip")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_str)
        .find(|base| is_qq_audio_url(base))
        .map(|base| format!("{}/", base.trim_end_matches('/')))
}

/// 主页接口的字段在 QQ 音乐不同版本之间变过几次：现行官方回包是
/// `Info.BaseInfo.Name` / `Info.BaseInfo.Avatar`（qqmusic-api-python 的
/// `get_homepage` 原样返回这一层）；旧回包还有 `Info.Pic`、以及某些中间
/// 版本的 `base_info.*`。头像字段本身也有时是 URL 字符串、有时包在
/// `{ url: ... }` 里，所以这里集中做兼容，不让 account() 再绑定某一个
/// 客户端版本的回包形状。
fn profile_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
        return Some(text.to_string());
    }
    let object = value.as_object()?;
    [
        "url",
        "avatar",
        "avatarUrl",
        "pic",
        "headPicUrl",
        "frontPicUrl",
    ]
    .iter()
    .find_map(|key| object.get(*key).and_then(Value::as_str))
    .filter(|text| !text.is_empty())
    .map(str::to_string)
}

fn profile_path<'a>(data: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(data, |value, key| value.get(*key))
}

fn homepage_nickname(data: &Value) -> String {
    [
        profile_path(data, &["Info", "BaseInfo", "Name"]),
        profile_path(data, &["Info", "BaseInfo", "name"]),
        profile_path(data, &["base_info", "name"]),
        profile_path(data, &["base_info", "nick"]),
        profile_path(data, &["Info", "Nick"]),
        data.get("nickname"),
    ]
    .into_iter()
    .find_map(|value| {
        value
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
    })
    .unwrap_or_default()
    .to_string()
}

fn homepage_avatar(data: &Value) -> String {
    [
        profile_path(data, &["Info", "BaseInfo", "Avatar"]),
        profile_path(data, &["Info", "BaseInfo", "avatar"]),
        profile_path(data, &["base_info", "avatar"]),
        profile_path(data, &["base_info", "avatarUrl"]),
        profile_path(data, &["Info", "Pic"]),
        data.get("avatar"),
        data.get("avatarUrl"),
        data.get("headPicUrl"),
        data.get("frontPicUrl"),
    ]
    .into_iter()
    .find_map(profile_text)
    .map(https_avatar)
    .unwrap_or_default()
}

fn profile_report_nickname(data: &Value) -> String {
    [
        profile_path(data, &["UserInfoCard", "NickName"]),
        profile_path(data, &["UserInfoCard", "Nickname"]),
        profile_path(data, &["UserInfoCard", "nick"]),
        profile_path(data, &["UserInfoCard", "name"]),
    ]
    .into_iter()
    .find_map(|value| {
        value
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
    })
    .unwrap_or_default()
    .to_string()
}

fn profile_report_avatar(data: &Value) -> String {
    [
        profile_path(data, &["UserInfoCard", "HeadUrl"]),
        profile_path(data, &["UserInfoCard", "Avatar"]),
        profile_path(data, &["UserInfoCard", "avatar"]),
    ]
    .into_iter()
    .find_map(profile_text)
    .map(https_avatar)
    .unwrap_or_default()
}

fn https_avatar(url: String) -> String {
    url.replacen("http://", "https://", 1)
}

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
    qr_sessions: Mutex<HashMap<String, (login::DualQrSession, Instant)>>,
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

    async fn search_songs(&self, keyword: &str, limit: usize) -> Result<Vec<SongSource>> {
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

    async fn search_collection_rows(
        &self,
        keyword: &str,
        kind: SearchKind,
        limit: usize,
    ) -> Result<Vec<CollectionResult>> {
        let search_type = match kind {
            SearchKind::Artist => 1,
            SearchKind::Album => 2,
            SearchKind::Playlist => 3,
            // 播客/电台只有网易云支持
            SearchKind::Radio | SearchKind::Song => return Ok(Vec::new()),
        };
        let data = self
            .client
            .call(
                "music.search.SearchCgiService",
                "DoSearchForQQMusicMobile",
                json!({
                    "searchid": new_search_id(),
                    "query": keyword,
                    "search_type": search_type,
                    "num_per_page": limit,
                    "page_num": 1,
                    "highlight": false,
                    "grp": true
                }),
                QqPlatform::Mobile,
            )
            .await?;
        Ok(qq_collection_results(&data, kind, limit))
    }

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

    async fn editable_playlist_target(&self, key: &str) -> Result<(i64, i64)> {
        if key == "__qq_favorite__" {
            return Ok((201, 0));
        }
        let credential = self.client.credential();
        anyhow::ensure!(credential.is_present(), "请先登录 QQ 音乐");
        let data = self
            .client
            .call(
                "music.musicasset.PlaylistBaseRead",
                "GetPlaylistByUin",
                json!({ "uin": credential.str_musicid() }),
                QqPlatform::Desktop,
            )
            .await
            .context("重新核验 QQ 音乐歌单归属失败")?;
        let target = playlist_entries(&data)
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| qq_playlist_key(entry).is_some_and(|candidate| candidate == key))
            })
            .context("当前账号的歌单目录里没有这个 QQ 音乐歌单")?;
        anyhow::ensure!(
            qq_playlist_origin(target) == "created",
            "收藏的他人歌单不能移除其中的歌曲"
        );
        let dir_id = loose_int(target.get("dirid").or_else(|| target.get("dirId")));
        let tid = loose_int(target.get("tid"));
        anyhow::ensure!(dir_id > 0, "QQ 音乐歌单缺少可写目录 ID");
        Ok((dir_id, tid.max(0)))
    }

    async fn song_write_identity(&self, source: &SongSource) -> Result<(i64, i64)> {
        let mut raw = Value::Object(source.payload.clone());
        let mut song_id = loose_int(first_truthy(&raw, &["id", "songid", "songId"]));
        if song_id <= 0 {
            raw = self
                .query_song(&source.key)
                .await
                .context("补全 QQ 音乐歌曲写操作标识失败")?;
            song_id = loose_int(first_truthy(&raw, &["id", "songid", "songId"]));
        }
        anyhow::ensure!(song_id > 0, "QQ 音乐歌曲缺少数字 songId");
        let song_type = loose_int(first_truthy(&raw, &["type", "songtype", "songType"])).max(0);
        Ok((song_id, song_type))
    }

    /// 歌单分页拉取：hasmore 与 total 双终止条件，任一到头就停。
    async fn playlist_tracks(
        &self,
        playlist_id: &str,
        limit: usize,
    ) -> Result<(String, Vec<Value>)> {
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

    async fn album_tracks(&self, album_key: &str, limit: usize) -> Result<(String, Vec<Value>)> {
        const PAGE_SIZE: usize = 100;
        const MAX_PAGES: usize = 50;

        let mut tracks = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut title = String::new();
        let mut begin = 0usize;

        for _ in 0..MAX_PAGES {
            let page_size = PAGE_SIZE.min(limit.saturating_sub(tracks.len())).max(1);
            let mut param = serde_json::Map::from_iter([
                ("begin".into(), json!(begin)),
                ("num".into(), json!(page_size)),
            ]);
            if album_key.chars().all(|ch| ch.is_ascii_digit()) {
                param.insert(
                    "albumId".into(),
                    json!(album_key.parse::<i64>().unwrap_or(0)),
                );
            } else {
                param.insert("albumMid".into(), json!(album_key));
            }
            let data = self
                .client
                .call(
                    "music.musichallAlbum.AlbumSongList",
                    "GetAlbumSongList",
                    Value::Object(param),
                    QqPlatform::Mobile,
                )
                .await?;
            let page = qq_song_entries(&data);
            if page.is_empty() {
                break;
            }
            if title.is_empty() {
                title = page
                    .iter()
                    .find_map(qq_song_album_name)
                    .unwrap_or_default()
                    .to_string();
            }
            let fetched = page.len();
            append_unique_qq_songs(&mut tracks, &mut seen, page, limit);
            begin = begin.saturating_add(fetched);
            if tracks.len() >= limit || qq_page_finished(&data, begin, fetched, page_size) {
                break;
            }
        }

        if title.is_empty() {
            title = format!("QQ 音乐专辑 {album_key}");
        }
        Ok((title, tracks))
    }

    async fn artist_tracks(&self, artist_mid: &str, limit: usize) -> Result<(String, Vec<Value>)> {
        const PAGE_SIZE: usize = 30;
        const MAX_PAGES: usize = 100;

        let mut tracks = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut title = String::new();
        let mut begin = 0usize;

        for _ in 0..MAX_PAGES {
            let page_size = PAGE_SIZE.min(limit.saturating_sub(tracks.len())).max(1);
            let data = self
                .client
                .call(
                    "musichall.song_list_server",
                    "GetSingerSongList",
                    json!({
                        "singerMid": artist_mid,
                        "order": 1,
                        "number": page_size,
                        "begin": begin
                    }),
                    QqPlatform::Mobile,
                )
                .await?;
            let page = qq_song_entries(&data);
            if page.is_empty() {
                break;
            }
            if title.is_empty() {
                title = page
                    .iter()
                    .find_map(qq_song_primary_artist)
                    .unwrap_or_default()
                    .to_string();
            }
            let fetched = page.len();
            append_unique_qq_songs(&mut tracks, &mut seen, page, limit);
            begin = begin.saturating_add(fetched);
            if tracks.len() >= limit || qq_page_finished(&data, begin, fetched, page_size) {
                break;
            }
        }

        if title.is_empty() {
            title = format!("QQ 音乐艺术家 {artist_mid}");
        }
        Ok((title, tracks))
    }

    async fn favorite_tracks(&self, limit: usize) -> Result<(String, Vec<Value>)> {
        const PAGE_SIZE: usize = 100;
        const MAX_PAGES: usize = 100;

        let credential = self.client.credential();
        if !credential.is_present() {
            return Ok(("我的收藏".into(), Vec::new()));
        }
        let mut tracks = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut title = "我的收藏".to_string();
        let mut begin = 0usize;

        for _ in 0..MAX_PAGES {
            let page_size = PAGE_SIZE.min(limit.saturating_sub(tracks.len())).max(1);
            let data = self
                .client
                .call(
                    "music.srfDissInfo.DissInfo",
                    "CgiGetDiss",
                    json!({
                        "disstid": 0,
                        "dirid": 201,
                        "tag": true,
                        "song_begin": begin,
                        "song_num": page_size,
                        "userinfo": true,
                        "orderlist": true,
                        "onlysonglist": false,
                        "enc_host_uin": credential.encrypt_uin.clone(),
                    }),
                    QqPlatform::Desktop,
                )
                .await?;
            if begin == 0 {
                if let Some(found) = data.get("dirinfo").and_then(qq_playlist_title) {
                    title = found.to_string();
                }
            }
            let page = qq_song_entries(&data);
            if page.is_empty() {
                break;
            }
            let fetched = page.len();
            append_unique_qq_songs(&mut tracks, &mut seen, page, limit);
            begin = begin.saturating_add(fetched);
            if tracks.len() >= limit || qq_page_finished(&data, begin, fetched, page_size) {
                break;
            }
        }
        Ok((title, tracks))
    }

    /// QQ 把“自己创建的歌单”和“收藏的外部歌单”拆在两套接口里；
    /// `GetPlaylistByUin` 只会返回前者，收藏目录必须单独分页读取。
    async fn collected_playlists(&self) -> Result<Vec<Value>> {
        const PAGE_SIZE: usize = 100;
        const MAX_PAGES: usize = 100;

        let credential = self.client.credential();
        if !credential.is_present() {
            return Ok(Vec::new());
        }
        let mut playlists = Vec::new();
        let mut offset = 0usize;

        for _ in 0..MAX_PAGES {
            let data = self
                .client
                .call(
                    "music.musicasset.PlaylistFavRead",
                    "CgiGetPlaylistFavInfo",
                    json!({
                        "uin": credential.encrypt_uin.clone(),
                        "offset": offset,
                        "size": PAGE_SIZE,
                    }),
                    QqPlatform::Desktop,
                )
                .await
                .context("读取 QQ 音乐收藏歌单失败")?;
            let page = favorite_playlist_entries(&data)
                .cloned()
                .unwrap_or_default();
            let fetched = page.len();
            playlists.extend(page);

            let next_offset = offset.saturating_add(fetched);
            let total = loose_int(data.get("total")).max(0) as usize;
            let has_more = data
                .get("hasmore")
                .or_else(|| data.get("hasMore"))
                .map(|value| {
                    value
                        .as_bool()
                        .unwrap_or_else(|| loose_int(Some(value)) != 0)
                });
            if fetched == 0
                || has_more == Some(false)
                || (total > 0 && next_offset >= total)
                || (has_more.is_none() && fetched < PAGE_SIZE)
            {
                break;
            }
            offset = next_offset;
        }
        Ok(playlists)
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
                // vkey 回包里的 sip 与这张 vkey 同源，优先级高于另打一遍 dispatch。
                let base = match pick_cdn_base(&data) {
                    Some(base) => base,
                    None => self.cdn_base().await,
                };
                format!("{base}{purl}")
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
                let picked = pick_cdn_base(&data).unwrap_or_else(|| CDN_FALLBACK.to_string());
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
        let credential = self.client.credential();
        let euin = credential.encrypt_uin.clone();
        let musicid = credential.str_musicid();
        let mut profile = (String::new(), String::new());
        if !musicid.is_empty() || !euin.is_empty() {
            // Desktop/Web 的 GetHomepageHeader 常回空 Name（官方 Python SDK
            // 默认走 Android+QIMEI 才拿得到）。GetProfileReport 在 Desktop
            // 下就能给出 UserInfoCard.NickName / HeadUrl——账号面板要的正是这个。
            let visit = if !euin.is_empty() {
                euin.clone()
            } else {
                musicid.clone()
            };
            if let Ok(data) = self
                .client
                .call(
                    "music.recommend.UserProfileSettingSvr",
                    "GetProfileReport",
                    json!({ "VisitAccount": visit }),
                    QqPlatform::Desktop,
                )
                .await
            {
                profile = (profile_report_nickname(&data), profile_report_avatar(&data));
            }
            // 主页接口作兜底：万一报告接口挂了，旧/新主页字段形状仍试一遍。
            if profile.0.is_empty() && profile.1.is_empty() {
                let uin = visit;
                if let Ok(data) = self
                    .client
                    .call(
                        "music.UnifiedHomepage.UnifiedHomepageSrv",
                        "GetHomepageHeader",
                        json!({
                            "IsQueryTabDetail": 1,
                            "uin": uin,
                            "hostuin": musicid,
                            "encrypt_uin": euin,
                        }),
                        QqPlatform::Desktop,
                    )
                    .await
                {
                    profile = (homepage_nickname(&data), homepage_avatar(&data));
                }
            }
        }
        // 主页接口偶尔只返回昵称、不返回头像。musicid 是登录凭证里的普通 QQ
        // 标识，不把 encrypt_uin 当 QQ 号；qlogo 是最后的公开头像兜底，不需要把
        // Cookie 暴露给前端，也能避开 QQ 主页接口的字段漂移。
        if profile.1.is_empty() && !musicid.is_empty() {
            let qlogo_uin = musicid.strip_prefix('o').unwrap_or(&musicid);
            profile.1 = format!("https://q.qlogo.cn/headimg_dl?dst_uin={qlogo_uin}&spec=100");
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
        Capabilities {
            search_kinds: SEARCH_KINDS,
            ..Capabilities::MUSIC
        }
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
        let mut account = Account::new(Platform::Qqm, LABEL, AccountState::Valid, "");
        account.account_key = credential.str_musicid();
        account.nickname = nickname;
        account.avatar = avatar;
        account
    }

    async fn cached_account(&self) -> Account {
        let credential = self.client.credential();
        if !credential.is_present() {
            return Account::new(Platform::Qqm, LABEL, AccountState::Missing, "未登录");
        }
        if self.client.credential_invalid() || credential.is_expired() {
            return Account::new(
                Platform::Qqm,
                LABEL,
                AccountState::Expired,
                "登录凭证已过期，请刷新或重新扫码",
            );
        }
        let cached_profile = self
            .profile
            .lock()
            .unwrap()
            .as_ref()
            .map(|(profile, _)| profile.clone())
            .unwrap_or_default();
        let mut account = Account::new(
            Platform::Qqm,
            LABEL,
            AccountState::Valid,
            "登录状态尚未联网核验",
        );
        account.account_key = credential.str_musicid();
        account.nickname = cached_profile.0;
        account.avatar = cached_profile.1;
        account
    }

    async fn create_qr(&self) -> Result<QrSession> {
        // 同时下发 QQ 音乐 App 码 + QQ 互联码；用户扫任意一张即可。
        // 单路失败时仍返回成功的那一路，避免整次登录不可用。
        let session = login::create_dual_qr(self.client.http()).await?;
        // 顺序与主图都优先 QQ 互联（用 QQ 扫）；QQ 音乐 App 码作补充。
        let mut variants = Vec::new();
        if let Some(qq) = &session.qq {
            variants.push(QrVariant {
                id: "qq".into(),
                label: "QQ".into(),
                image: qr_data_url_from_png(&qq.png),
            });
        }
        if let Some(mobile) = &session.mobile {
            variants.push(QrVariant {
                id: "qqmusic".into(),
                label: "QQ音乐".into(),
                image: qr_data_url_from_png(&mobile.png),
            });
        }
        anyhow::ensure!(!variants.is_empty(), "没有可用的 QQ 登录二维码");
        let image = variants
            .iter()
            .find(|item| item.id == "qq")
            .or_else(|| variants.first())
            .map(|item| item.image.clone())
            .unwrap_or_default();
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
            variants,
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

        match login::poll_dual_qr(self.client.http(), &session).await {
            Ok(login::DualQrOutcome::Waiting) => {
                Ok((QrStateValue::Waiting, "等待手机扫码（QQ 音乐或 QQ）".into()))
            }
            Ok(login::DualQrOutcome::Scanned) => {
                Ok((QrStateValue::Scanned, "已扫码，请在手机上确认".into()))
            }
            Ok(login::DualQrOutcome::Refused) => {
                self.qr_sessions.lock().unwrap().remove(session_id);
                if let Some(mobile) = &session.mobile {
                    mobile.abort();
                }
                Ok((QrStateValue::Refused, "已在手机上拒绝登录".into()))
            }
            Ok(login::DualQrOutcome::Expired) => {
                self.qr_sessions.lock().unwrap().remove(session_id);
                if let Some(mobile) = &session.mobile {
                    mobile.abort();
                }
                Ok((QrStateValue::Expired, "二维码已过期，请重新获取".into()))
            }
            Ok(login::DualQrOutcome::Done(credential)) => {
                if let Err(error) = self.client.store_credential(credential) {
                    return Ok((
                        QrStateValue::Error,
                        truncate(&format!("保存 QQ 音乐登录态失败：{error:#}"), 160),
                    ));
                }
                self.qr_sessions.lock().unwrap().remove(session_id);
                if let Some(mobile) = &session.mobile {
                    mobile.abort();
                }
                *self.profile.lock().unwrap() = None;
                Ok((QrStateValue::Done, "登录成功".into()))
            }
            Ok(login::DualQrOutcome::Error(message)) => Ok((QrStateValue::Error, message)),
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
        self.client.clear_credential()?;
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
        // QQ 搜索对书名号/直角引号很脆：`「拉海洛」之心` 会直接空结果（code=0），
        // 去掉装饰引号后的 `拉海洛之心` 又能命中。先原样搜，空了再 stripped 兜底。
        let mut songs = self.search_songs(keyword, limit).await?;
        if songs.is_empty() {
            let stripped = strip_qq_search_decorations(keyword);
            if stripped != keyword && !stripped.is_empty() {
                songs = self.search_songs(&stripped, limit).await?;
            }
        }
        Ok(songs)
    }

    async fn search_collections(
        &self,
        keyword: &str,
        kind: SearchKind,
        limit: usize,
    ) -> Result<Vec<CollectionResult>> {
        let keyword = keyword.trim();
        if keyword.is_empty()
            || !matches!(
                kind,
                SearchKind::Playlist | SearchKind::Artist | SearchKind::Album
            )
        {
            return Ok(Vec::new());
        }
        let limit = effective_limit(limit, 20);
        let mut rows = self.search_collection_rows(keyword, kind, limit).await?;
        if rows.is_empty() {
            let stripped = strip_qq_search_decorations(keyword);
            if stripped != keyword && !stripped.is_empty() {
                rows = self.search_collection_rows(&stripped, kind, limit).await?;
            }
        }
        Ok(rows)
    }

    async fn stream_playlists(&self) -> Result<Vec<StreamPlaylist>> {
        let credential = self.client.credential();
        if !credential.is_present() {
            return Ok(Vec::new());
        }
        let mut playlists = vec![StreamPlaylist {
            platform: Platform::Qqm,
            key: "__qq_favorite__".into(),
            title: "我的收藏".into(),
            cover: String::new(),
            count: 0,
            is_favorite: true,
            origin: "favorite".into(),
        }];
        let mut seen_keys = std::collections::HashSet::new();
        if let Ok(data) = self
            .client
            .call(
                "music.musicasset.PlaylistBaseRead",
                "GetPlaylistByUin",
                json!({ "uin": credential.str_musicid() }),
                QqPlatform::Desktop,
            )
            .await
        {
            if let Some(entries) = playlist_entries(&data) {
                for entry in entries {
                    let Some(key) = qq_playlist_key(entry) else {
                        continue;
                    };
                    let fallback_title = "QQ 音乐歌单";
                    let title = qq_playlist_title(entry)
                        .unwrap_or(fallback_title)
                        .to_string();
                    // `dirid=201` 就是“我喜欢/我的收藏”。上面已经放了稳定的
                    // `__qq_favorite__` 虚拟 key，再保留这条会在侧栏出现两个同义节点。
                    if is_qq_favorite_playlist(entry) || !seen_keys.insert(key.clone()) {
                        continue;
                    }
                    playlists.push(StreamPlaylist {
                        platform: Platform::Qqm,
                        key,
                        title,
                        cover: qq_playlist_cover(entry),
                        count: qq_playlist_count(entry),
                        is_favorite: false,
                        origin: qq_playlist_origin(entry).to_string(),
                    });
                }
            }
        }

        for entry in self.collected_playlists().await? {
            let Some(key) = qq_playlist_key(&entry) else {
                continue;
            };
            if !seen_keys.insert(key.clone()) {
                continue;
            }
            playlists.push(StreamPlaylist {
                platform: Platform::Qqm,
                key,
                title: qq_playlist_title(&entry)
                    .unwrap_or("QQ 音乐歌单")
                    .to_string(),
                cover: qq_playlist_cover(&entry),
                count: qq_playlist_count(&entry),
                is_favorite: false,
                origin: "collected".into(),
            });
        }
        Ok(playlists)
    }

    async fn stream_playlist_tracks(
        &self,
        key: &str,
        limit: usize,
    ) -> Result<Option<StreamPlaylistResponse>> {
        let key = key.trim();
        if key.is_empty() {
            return Ok(None);
        }
        let credential = self.client.credential();
        if !credential.is_present() {
            return Ok(None);
        }
        let limit = full_listing(limit);
        let (title, entries) = if key == "__qq_favorite__" {
            self.favorite_tracks(limit).await?
        } else {
            self.playlist_tracks(key, limit).await?
        };
        let sources: Vec<SongSource> = entries
            .iter()
            .map(|entry| to_source(entry.get("songInfo").unwrap_or(entry)))
            .filter(|source| !source.key.is_empty())
            .collect();
        Ok(Some(StreamPlaylistResponse {
            platform: Platform::Qqm,
            key: key.to_string(),
            title,
            sources,
        }))
    }

    async fn remove_stream_playlist_track(&self, key: &str, source: &SongSource) -> Result<()> {
        anyhow::ensure!(source.platform == Platform::Qqm, "歌曲来源不是 QQ 音乐");
        let key = key.trim();
        anyhow::ensure!(!key.is_empty(), "QQ 音乐歌单 ID 为空");
        let (dir_id, tid) = self.editable_playlist_target(key).await?;
        let (song_id, song_type) = self.song_write_identity(source).await?;
        let data = self
            .client
            .call(
                "music.musicasset.PlaylistDetailWrite",
                "DelSonglist",
                json!({
                    "dirId": dir_id,
                    "tid": tid,
                    "bFmtUtf8": true,
                    "v_songInfo": [{"songId": song_id, "songType": song_type}],
                }),
                QqPlatform::Desktop,
            )
            .await
            .context("请求 QQ 音乐移除歌曲失败")?;
        let ret_code = data
            .get("retCode")
            .or_else(|| data.get("ret_code"))
            .map(|value| loose_int(Some(value)))
            .context("QQ 音乐移除响应缺少 retCode")?;
        anyhow::ensure!(ret_code == 0, "QQ 音乐移除歌曲失败：retCode={ret_code}");
        Ok(())
    }

    async fn resolve_collection(
        &self,
        kind: SearchKind,
        key: &str,
        limit: usize,
    ) -> Result<Option<CollectionResolveResponse>> {
        let key = key.trim();
        if key.is_empty()
            || !matches!(
                kind,
                SearchKind::Playlist | SearchKind::Artist | SearchKind::Album
            )
        {
            return Ok(None);
        }
        let limit = full_listing(limit);
        let (title, entries) = match kind {
            SearchKind::Playlist => self.playlist_tracks(key, limit).await?,
            SearchKind::Album => self.album_tracks(key, limit).await?,
            SearchKind::Artist => self.artist_tracks(key, limit).await?,
            SearchKind::Radio | SearchKind::Song => return Ok(None),
        };
        if entries.is_empty() {
            bail!("QQ 音乐集合没有可用歌曲（{key}）");
        }
        Ok(Some(CollectionResolveResponse {
            kind,
            platform: Platform::Qqm,
            title,
            sources: entries.iter().take(limit).map(to_source).collect(),
        }))
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
        if let Some(album_key) = parse_album(&text) {
            let (title, songs) = self.album_tracks(&album_key, limit).await?;
            if songs.is_empty() {
                bail!("没有读取到这个 QQ 音乐专辑（{album_key}）");
            }
            return Ok(Some(ResolveResponse {
                kind: ResolveKind::Album,
                platform: Platform::Qqm,
                title,
                sources: songs.iter().take(limit).map(to_source).collect(),
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

    /// 试听走 128K（M500）档。media_mid 的取法和补救和 download 一致：
    /// 搜索结果里它偶尔是空的，回查一次详情再试。
    async fn preview_url(&self, source: &SongSource) -> Result<Option<String>> {
        self.preview_url_at_quality(source, Quality::Q128).await
    }

    async fn preview_url_at_quality(
        &self,
        source: &SongSource,
        quality: Quality,
    ) -> Result<Option<String>> {
        let raw = Value::Object(source.payload.clone());
        let mut media_mid = media_mid_of(&raw, &source.key);
        let mut resolved = self.resolve_url(&source.key, &media_mid, quality).await?;
        if resolved.is_none() {
            let detail = self.query_song(&source.key).await?;
            if !detail.is_null() {
                media_mid = media_mid_of(&detail, &source.key);
                resolved = self
                    .resolve_url(&source.key, &media_mid, Quality::Q128)
                    .await?;
            }
        }
        let Some((url, _ext)) = resolved else {
            bail!("QQ 音乐没有返回可用试听地址（可能是版权受限或需要绿钻）");
        };
        Ok(Some(url))
    }

    async fn lyric(&self, key: &str) -> Result<Option<LyricText>> {
        let key = key.trim();
        if key.is_empty() {
            return Ok(None);
        }
        // 老的 fcg_query_lyric_new 只回主歌词，即使歌曲明明有 trans 也始终是空串。
        // 现行播放歌词接口在 qrc=0、crypt=0 时回 Base64 LRC：仍是前端需要的
        // 逐行时间轴，不必引入 QRC 的私有 3DES 解码，同时可以一并请求翻译。
        let body = self
            .client
            .call(
                "music.musichallSong.PlayLyricInfo",
                "GetPlayLyricInfo",
                qq_lyric_param(key),
                QqPlatform::Desktop,
            )
            .await
            .context("请求 QQ 音乐歌词失败")?;
        Ok(qq_lyric_text(&body))
    }

    async fn download(&self, job: DownloadJob<'_>) -> Result<PathBuf> {
        job.check_canceled()?;
        let source = job.source;
        let output_dir = self.ctx.platform_dir(Platform::Qqm)?;

        let mut raw = Value::Object(source.payload.clone());
        let mut media_mid = media_mid_of(&raw, &source.key);
        let mut album_mid = album_mid_of(&raw);
        let mut resolved = self
            .resolve_url(&source.key, &media_mid, job.quality)
            .await?;
        if resolved.is_none() {
            // 搜索结果里的 media_mid 偶尔是空的，回查一次详情再试
            let detail = self.query_song(&source.key).await?;
            if !detail.is_null() {
                media_mid = media_mid_of(&detail, &source.key);
                if album_mid.is_empty() {
                    album_mid = album_mid_of(&detail);
                }
                raw = detail;
                resolved = self
                    .resolve_url(&source.key, &media_mid, job.quality)
                    .await?;
            }
        }
        let _ = &raw;
        let Some((url, ext)) = resolved else {
            bail!("QQ 音乐没有返回可用下载地址（可能是版权受限或需要绿钻）");
        };
        job.check_canceled()?;

        let filename = render_filename(
            &self.ctx.filename_template(),
            &source.title,
            &source.artist_text(),
            &source.album,
            &source.key,
            ext,
        );
        let final_path = unique_download_path(&output_dir, &filename);

        let guard = AtomicDownload::new(&final_path);
        // QQ 网页端下载会带来源页；部分 CDN 对裸 GET 的缓存/防盗链策略不同。
        // 登录态只传给腾讯自己的音频域名，使最终 GET 与取得 vkey 的账号一致。
        let mut request = self
            .client
            .http()
            .get(&url)
            .header(reqwest::header::REFERER, "http://y.qq.com");
        let cookie = self.client.cookie_header();
        if !cookie.is_empty() && is_qq_audio_url(&url) {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        let response = request
            .send()
            .await
            .context("QQ 音乐音频下载失败")?
            .error_for_status()
            .context("QQ 音乐音频下载失败")?;
        let total = response.content_length().unwrap_or(0);
        job.report(0, total);

        let mut file = create_download_writer(guard.partial())
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
        file.flush().await.context("提交下载缓冲失败")?;
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

fn array_value(value: &Value) -> Option<&Vec<Value>> {
    value.as_array().or_else(|| {
        ["items", "list", "v_item", "itemlist", "data"]
            .into_iter()
            .find_map(|key| value.get(key).and_then(Value::as_array))
    })
}

fn qq_collection_entries(data: &Value, kind: SearchKind) -> Option<&Vec<Value>> {
    let pointers: &[&str] = match kind {
        SearchKind::Playlist => &[
            "/body/item_songlist",
            "/body/songlist",
            "/item_songlist",
            "/songlist",
        ],
        SearchKind::Artist => &["/body/singer", "/body/item_singer", "/singer"],
        SearchKind::Album => &["/body/item_album", "/body/album", "/item_album"],
        SearchKind::Radio | SearchKind::Song => return None,
    };
    pointers
        .iter()
        .find_map(|pointer| data.pointer(pointer).and_then(array_value))
}

fn qq_alias_text<'a>(entry: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| str_field(entry, key))
}

fn qq_alias_id(entry: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| entry.get(*key).filter(|value| is_truthy(Some(value))))
        .map(qq_value_id)
        .unwrap_or_default()
}

fn qq_alias_count(entry: &Value, keys: &[&str]) -> usize {
    keys.iter()
        .find_map(|key| entry.get(*key))
        .map(|value| loose_int(Some(value)).max(0) as usize)
        .unwrap_or(0)
}

fn qq_collection_results(data: &Value, kind: SearchKind, limit: usize) -> Vec<CollectionResult> {
    qq_collection_entries(data, kind)
        .into_iter()
        .flatten()
        .take(limit)
        .filter_map(|entry| {
            let (key, title, subtitle, cover, count) = match kind {
                SearchKind::Playlist => {
                    let key = qq_alias_id(entry, &["id", "tid", "dissid", "dirid"]);
                    if key.is_empty() || key == "0" {
                        return None;
                    }
                    let title = qq_playlist_title(entry)?.to_string();
                    let count = qq_alias_count(
                        entry,
                        &["songnum", "songNum", "song_num", "song_cnt", "song_count"],
                    );
                    let creator = qq_alias_text(
                        entry,
                        &["nickname", "creatorName", "creator_name", "ownerName"],
                    )
                    .unwrap_or("未知创建者");
                    (
                        key,
                        title,
                        format!("{count} 首 · {creator}"),
                        qq_alias_text(entry, &["picurl", "picUrl", "cover", "logo"])
                            .unwrap_or_default()
                            .to_string(),
                        count,
                    )
                }
                SearchKind::Artist => {
                    let key = qq_alias_id(
                        entry,
                        &["singerMID", "singerMid", "singer_mid", "singermid", "mid"],
                    );
                    if key.is_empty() {
                        return None;
                    }
                    let title =
                        qq_alias_text(entry, &["singerName", "singer_name", "name"])?.to_string();
                    let count = qq_alias_count(entry, &["songNum", "song_num", "songnum"]);
                    let albums = qq_alias_count(entry, &["albumNum", "album_num", "albumnum"]);
                    (
                        key,
                        title,
                        format!("{count} 首 · {albums} 张专辑"),
                        qq_alias_text(entry, &["singerPic", "pic", "picUrl", "picurl"])
                            .unwrap_or_default()
                            .to_string(),
                        count,
                    )
                }
                SearchKind::Album => {
                    let key = qq_alias_id(
                        entry,
                        &[
                            "albummid",
                            "albumMid",
                            "album_mid",
                            "mid",
                            "albumid",
                            "albumId",
                        ],
                    );
                    if key.is_empty() {
                        return None;
                    }
                    let title = qq_alias_text(entry, &["name", "albumname", "albumName", "title"])?
                        .to_string();
                    let artist = entry
                        .get("singer")
                        .and_then(Value::as_array)
                        .and_then(|list| list.first())
                        .and_then(|singer| qq_alias_text(singer, &["name", "singerName"]))
                        .or_else(|| qq_alias_text(entry, &["singerName", "singer_name"]))
                        .unwrap_or("未知艺人");
                    let count = qq_alias_count(entry, &["song_num", "songNum", "songnum"]);
                    let cover = qq_alias_text(entry, &["pic", "picUrl", "picurl", "cover"])
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            format!("https://y.gtimg.cn/music/photo_new/T002R300x300M000{key}.jpg")
                        });
                    (key, title, format!("{count} 首 · {artist}"), cover, count)
                }
                SearchKind::Radio | SearchKind::Song => return None,
            };
            Some(CollectionResult {
                kind,
                platform: Platform::Qqm,
                key,
                title,
                subtitle,
                cover,
                count,
            })
        })
        .collect()
}

fn qq_song_entries(data: &Value) -> Vec<Value> {
    data.get("songList")
        .or_else(|| data.get("songlist"))
        .or_else(|| data.pointer("/body/songList"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|entry| entry.get("songInfo").unwrap_or(entry))
        .filter(|entry| has_song_key(entry))
        .cloned()
        .collect()
}

fn qq_song_wire_key(song: &Value) -> String {
    first_truthy(song, &["mid", "songmid", "id"])
        .map(qq_value_id)
        .unwrap_or_default()
}

fn append_unique_qq_songs(
    target: &mut Vec<Value>,
    seen: &mut std::collections::HashSet<String>,
    page: Vec<Value>,
    limit: usize,
) {
    for song in page {
        let key = qq_song_wire_key(&song);
        if !key.is_empty() && seen.insert(key) {
            target.push(song);
            if target.len() >= limit {
                break;
            }
        }
    }
}

fn qq_page_finished(data: &Value, next_begin: usize, fetched: usize, requested: usize) -> bool {
    let total = ["totalNum", "total_num", "total"]
        .into_iter()
        .find_map(|key| data.get(key))
        .map(|value| loose_int(Some(value)).max(0) as usize)
        .unwrap_or(0);
    if total > 0 {
        next_begin >= total
    } else if let Some(has_more) = data
        .get("hasmore")
        .or_else(|| data.get("hasMore"))
        .and_then(|value| {
            value
                .as_bool()
                .or_else(|| value.as_i64().map(|value| value != 0))
        })
    {
        !has_more
    } else {
        fetched < requested
    }
}

fn qq_song_album_name(song: &Value) -> Option<&str> {
    song.get("album")
        .and_then(|album| qq_alias_text(album, &["name", "title"]))
}

fn qq_song_primary_artist(song: &Value) -> Option<&str> {
    song.get("singer")
        .and_then(Value::as_array)
        .and_then(|artists| artists.first())
        .and_then(|artist| qq_alias_text(artist, &["name", "singerName"]))
}

fn qq_playlist_key(entry: &Value) -> Option<String> {
    first_truthy(entry, &["tid", "dissid", "dirid", "dirId", "id"])
        .map(qq_value_id)
        .filter(|value| !value.is_empty() && value != "0")
}

fn qq_playlist_cover(entry: &Value) -> String {
    [
        "picurl",
        "picUrl",
        "bigpicUrl",
        "albumPicUrl",
        "logo",
        "cover",
    ]
    .into_iter()
    .find_map(|key| str_field(entry, key))
    .unwrap_or_default()
    .to_string()
}

fn qq_playlist_count(entry: &Value) -> usize {
    loose_int(first_truthy(
        entry,
        &["songnum", "songNum", "song_num", "song_count", "song_cnt"],
    ))
    .max(0) as usize
}

fn is_qq_favorite_playlist(entry: &Value) -> bool {
    loose_int(entry.get("dirid").or_else(|| entry.get("dirId"))) == 201
}

/// 创建的歌单带正 dirid；收藏来的歌单只有 tid/dissid（dirid 为 0 或缺失）。
/// 与网易云侧的 origin 取值对齐：前端 FolderTree 按 created/collected 分组。
fn qq_playlist_origin(entry: &Value) -> &'static str {
    if loose_int(entry.get("dirid").or_else(|| entry.get("dirId"))) > 0 {
        "created"
    } else {
        "collected"
    }
}

/// `GetPlaylistByUin` 的返回字段在桌面端和移动端版本间漂移过：有的版本把
/// 列表放在 `v_playlist`，有的包在 `playlist` / `data` 下。只取最外层会得到
/// 一个空的“我的歌单”节点，前端看起来就像 QQ 没有返回歌单名称。
fn playlist_entries(data: &Value) -> Option<&Vec<Value>> {
    data.get("v_playlist")
        .or_else(|| data.get("playlist"))
        .or_else(|| data.get("playlists"))
        .and_then(Value::as_array)
        .or_else(|| data.get("data").and_then(|nested| playlist_entries(nested)))
}

fn favorite_playlist_entries(data: &Value) -> Option<&Vec<Value>> {
    data.get("v_list")
        .or_else(|| data.get("v_playlist"))
        .or_else(|| data.get("playlist"))
        .or_else(|| data.get("playlists"))
        .and_then(Value::as_array)
        .or_else(|| {
            data.get("data")
                .and_then(|nested| favorite_playlist_entries(nested))
        })
}

/// QQ 个人歌单名称也有 `dirname` / `dissname` / `title` 等多套命名，且
/// 部分回包会把名称放进 `dirinfo`。空字符串必须继续向后回退。
fn qq_playlist_title(entry: &Value) -> Option<&str> {
    str_field(entry, "dirname")
        .or_else(|| str_field(entry, "dirName"))
        .or_else(|| str_field(entry, "dissname"))
        .or_else(|| str_field(entry, "diss_name"))
        .or_else(|| str_field(entry, "name"))
        .or_else(|| str_field(entry, "title"))
        .or_else(|| str_field(entry, "playlist_name"))
        .or_else(|| entry.get("dirinfo").and_then(qq_playlist_title))
}

fn qq_path_key_after(path: &str, marker: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let index = parts
        .iter()
        .position(|part| part.eq_ignore_ascii_case(marker))?;
    let value = parts.get(index + 1)?.trim_end_matches(".html");
    if !value.is_empty() && value.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        Some(value.to_string())
    } else {
        None
    }
}

fn parse_album(text: &str) -> Option<String> {
    let parsed = url::Url::parse(text).ok()?;
    let path = parsed.path();
    let path_lower = path.to_ascii_lowercase();
    let mut params: HashMap<String, String> = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let mut fragment_path = String::new();
    if let Some(fragment) = parsed.fragment() {
        let (path, query) = fragment.split_once('?').unwrap_or((fragment, ""));
        fragment_path = path.to_string();
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            params.entry(key.into_owned()).or_insert(value.into_owned());
        }
    }

    for key in ["albummid", "albumMid", "album_mid", "albumid", "albumId"] {
        if let Some(value) = params.get(key).filter(|value| !value.is_empty()) {
            return Some(value.clone());
        }
    }
    if path_lower.contains("album") || fragment_path.to_ascii_lowercase().contains("album") {
        if let Some(value) = params.get("id").filter(|value| !value.is_empty()) {
            return Some(value.clone());
        }
    }
    let found = [path, fragment_path.as_str()]
        .into_iter()
        .find_map(|candidate| {
            qq_path_key_after(candidate, "albumDetail")
                .or_else(|| qq_path_key_after(candidate, "album"))
        });
    found
}

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

/// 去掉 QQ 搜索不吃的装饰性引号/书名号。
///
/// 实测 `DoSearchForQQMusicMobile`：
/// - `「拉海洛」之心` / `『…』` / `《…》` → `item_song=[]`（仍 code=0）
/// - `拉海洛之心` / `拉海洛` → 正常命中
/// 网易云同一关键词能搜到，所以问题在 QQ 侧查询解析，不在曲库本身。
fn strip_qq_search_decorations(keyword: &str) -> String {
    keyword
        .chars()
        .filter(|ch| {
            !matches!(
                ch,
                '「' | '」'
                    | '『'
                    | '』'
                    | '《'
                    | '》'
                    | '〈'
                    | '〉'
                    | '“'
                    | '”'
                    | '‘'
                    | '’'
                    | '"'
                    | '\''
            )
        })
        .collect::<String>()
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn qq_lyric_param(key: &str) -> Value {
    let mut param = serde_json::Map::from_iter([
        ("crypt".into(), json!(0)),
        ("lrc_t".into(), json!(0)),
        // 这里明确取逐行 LRC。QRC 是逐字密文；展示层目前只消费逐行时间轴。
        ("qrc".into(), json!(0)),
        ("qrc_t".into(), json!(0)),
        ("trans".into(), json!(1)),
        ("trans_t".into(), json!(0)),
        ("roma".into(), json!(1)),
        ("roma_t".into(), json!(0)),
    ]);
    if let Ok(song_id) = key.parse::<u64>() {
        param.insert("songID".into(), json!(song_id));
    } else {
        param.insert("songMid".into(), json!(key));
    }
    Value::Object(param)
}

/// QQ 的两个歌词接口分别可能回明文 LRC 或 Base64 LRC。QRC/罗马音还可能是
/// 十六进制密文；不能把那串密文当歌词落盘，所以只接收确实含 LRC 标签的文本。
fn decode_qq_lyric_field(value: Option<&Value>) -> String {
    let raw = value.and_then(Value::as_str).unwrap_or("").trim();
    if raw.is_empty() {
        return String::new();
    }
    if raw.contains('[') {
        return raw.to_string();
    }
    for engine in [
        &base64::engine::general_purpose::STANDARD,
        &base64::engine::general_purpose::STANDARD_NO_PAD,
    ] {
        let Ok(bytes) = engine.decode(raw) else {
            continue;
        };
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        if text.contains('[') {
            return text.trim().to_string();
        }
    }
    String::new()
}

/// QQ 用 `//` 表示“这一行没有译文”。保留它会让面板显示一排斜杠，且让只有
/// 占位符的歌曲误判为“有翻译”；只移除这些带时间戳的占位行，元数据照常保留。
fn clean_qq_translation(lrc: String) -> String {
    lrc.lines()
        .filter(|line| {
            let mut text = line.trim();
            while let Some(rest) = text.strip_prefix('[') {
                let Some(end) = rest.find(']') else {
                    break;
                };
                text = rest[end + 1..].trim_start();
            }
            text.trim() != "//"
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn qq_lyric_text(body: &Value) -> Option<LyricText> {
    let lrc = decode_qq_lyric_field(body.get("lyric"));
    if lrc.trim().is_empty() {
        return None;
    }
    Some(LyricText {
        lrc,
        word_lrc: String::new(),
        translated_lrc: clean_qq_translation(decode_qq_lyric_field(body.get("trans"))),
        // crypt=0 下主词/翻译是 Base64 LRC；QQ 偶尔仍把 roma 作为 QRC 密文回传。
        // decode_qq_lyric_field 会拒绝密文，避免生成一个不可解析的 .roma.lrc。
        romaji_lrc: decode_qq_lyric_field(body.get("roma")),
    })
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
    first_truthy(song, &["mid", "songmid", "id"]).is_some()
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
    fn cdn_picker_keeps_dispatch_order_without_locking_to_one_pop() {
        let data = json!({"sip": [
            "http://insecure.stream.qqmusic.qq.com/",
            "https://shj2.stream.qqmusic.qq.com/",
            "https://sjy6.stream.qqmusic.qq.com/"
        ]});
        assert_eq!(
            pick_cdn_base(&data),
            Some("https://shj2.stream.qqmusic.qq.com/".into())
        );
    }

    #[test]
    fn cdn_picker_rejects_non_qq_hosts() {
        let data = json!({"sip": [
            "https://attacker.example/",
            "https://stream.qqmusic.qq.com.evil.example/"
        ]});
        assert_eq!(pick_cdn_base(&data), None);
        assert!(is_qq_audio_url(
            "https://isure.stream.qqmusic.qq.com/file.mp3"
        ));
        assert!(!is_qq_audio_url(
            "https://stream.qqmusic.qq.com.evil.example/file.mp3"
        ));
    }

    #[test]
    fn profile_avatar_accepts_new_and_legacy_homepage_shapes() {
        // Desktop 可用的报告接口：UserInfoCard.{NickName,HeadUrl}
        let report = json!({
            "UserInfoCard": {
                "NickName": "kumo",
                "HeadUrl": "http://thirdqq.qlogo.cn/g?b=sdk&s=140"
            }
        });
        // 现行官方 GetHomepageHeader（Android+QIMEI 下才常有值）
        let official = json!({
            "Info": {
                "BaseInfo": {
                    "Name": "kumo",
                    "Avatar": "http://thirdqq.qlogo.cn/g?b=sdk&s=140"
                }
            }
        });
        // 旧 Python sidecar / 中间版本曾见过的映射后形状
        let mapped = json!({"base_info": {"name": "DJ", "avatar": "http://avatar/new.jpg"}});
        let legacy = json!({"Info": {"Nick": "旧昵称", "Pic": {"url": "http://avatar/old.jpg"}}});
        assert_eq!(profile_report_nickname(&report), "kumo");
        assert_eq!(
            profile_report_avatar(&report),
            "https://thirdqq.qlogo.cn/g?b=sdk&s=140"
        );
        assert_eq!(homepage_nickname(&official), "kumo");
        assert_eq!(
            homepage_avatar(&official),
            "https://thirdqq.qlogo.cn/g?b=sdk&s=140"
        );
        assert_eq!(homepage_nickname(&mapped), "DJ");
        assert_eq!(homepage_avatar(&mapped), "https://avatar/new.jpg");
        assert_eq!(homepage_nickname(&legacy), "旧昵称");
        assert_eq!(homepage_avatar(&legacy), "https://avatar/old.jpg");
        assert_eq!(
            https_avatar("http://avatar/new.jpg".into()),
            "https://avatar/new.jpg"
        );
    }

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
    fn album_links_of_every_shape_are_parsed() {
        assert_eq!(
            parse_album("https://y.qq.com/n/ryqq/albumDetail/0024bjiL2aocxT"),
            Some("0024bjiL2aocxT".into())
        );
        assert_eq!(
            parse_album("https://y.qq.com/n/yqq/album/0024bjiL2aocxT.html"),
            Some("0024bjiL2aocxT".into())
        );
        assert_eq!(
            parse_album("https://i.y.qq.com/n2/m/share/details/album.html?albummid=0024bjiL2aocxT"),
            Some("0024bjiL2aocxT".into())
        );
        assert_eq!(
            parse_album("https://y.qq.com/#/albumDetail/0024bjiL2aocxT"),
            Some("0024bjiL2aocxT".into())
        );
        assert_eq!(
            parse_album("https://y.qq.com/n/ryqq/songDetail/003Y1vTt3fRAsW"),
            None
        );
    }

    #[test]
    fn lyric_request_uses_current_line_synced_api_contract() {
        let by_mid = qq_lyric_param("000akynZ2Rbro5");
        assert_eq!(by_mid.get("songMid"), Some(&json!("000akynZ2Rbro5")));
        assert_eq!(by_mid.get("songID"), None);
        assert_eq!(by_mid.get("qrc"), Some(&json!(0)));
        assert_eq!(by_mid.get("crypt"), Some(&json!(0)));
        assert_eq!(by_mid.get("trans"), Some(&json!(1)));

        let by_id = qq_lyric_param("213086592");
        assert_eq!(by_id.get("songID"), Some(&json!(213086592_u64)));
        assert_eq!(by_id.get("songMid"), None);
    }

    #[test]
    fn current_qq_response_decodes_main_and_translated_lrc() {
        let main = "[offset:+250]\n[00:01.00]夢ならば";
        let trans = "[offset:+250]\n[00:01.00]如果这一切都是梦境\n[00:02.00]//";
        let body = json!({
            "lyric": base64::engine::general_purpose::STANDARD.encode(main),
            "trans": base64::engine::general_purpose::STANDARD.encode(trans),
            // 现行接口即使 crypt=0，也可能把 roma 作为十六进制 QRC 密文返回。
            "roma": "7A4CB1F38D775BE3042ABC5228FC7240"
        });
        let lyric = qq_lyric_text(&body).expect("主歌词应可解码");
        assert_eq!(lyric.lrc, main);
        assert_eq!(
            lyric.translated_lrc,
            "[offset:+250]\n[00:01.00]如果这一切都是梦境"
        );
        assert_eq!(lyric.romaji_lrc, "", "不能把 QRC 密文当成罗马音 LRC");
    }

    #[test]
    fn qq_lyric_decoder_accepts_plain_text_and_rejects_unparseable_payloads() {
        let plain = json!("[00:01.00]明文歌词");
        assert_eq!(decode_qq_lyric_field(Some(&plain)), plain.as_str().unwrap());
        let encrypted = json!("CD5392CF38FCA9531CBA64A1D6E159DE");
        assert_eq!(decode_qq_lyric_field(Some(&encrypted)), "");
        assert!(qq_lyric_text(&json!({"lyric": ""})).is_none());
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
        assert_eq!(
            digits_after_separator("/n/ryqq/playlist_v2/x", "playlist"),
            None
        );
    }

    #[test]
    fn playlist_search_rows_accept_qq_schema_aliases() {
        let data = json!({
            "body": {
                "item_songlist": [{
                    "tid": 8674642290_u64,
                    "dissname": "夜间 Set",
                    "songNum": "42",
                    "picUrl": "https://qpic.cn/cover.jpg",
                    "nickname": "DJ Kumo"
                }]
            }
        });
        let rows = qq_collection_results(&data, SearchKind::Playlist, 10);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, SearchKind::Playlist);
        assert_eq!(rows[0].key, "8674642290");
        assert_eq!(rows[0].title, "夜间 Set");
        assert_eq!(rows[0].subtitle, "42 首 · DJ Kumo");
        assert_eq!(rows[0].count, 42);
    }

    #[test]
    fn collection_pagination_stops_at_total_or_a_short_unknown_page() {
        assert!(!qq_page_finished(&json!({"totalNum": 250}), 100, 100, 100));
        assert!(qq_page_finished(&json!({"totalNum": 250}), 250, 50, 100));
        assert!(!qq_page_finished(&json!({}), 100, 100, 100));
        assert!(qq_page_finished(&json!({}), 40, 40, 100));
    }

    #[test]
    fn favorite_directory_is_not_exposed_as_a_second_real_playlist() {
        assert!(is_qq_favorite_playlist(&json!({"dirid": 201, "tid": 88})));
        assert!(is_qq_favorite_playlist(&json!({"dirId": "201"})));
        assert!(!is_qq_favorite_playlist(&json!({"dirid": 202, "tid": 88})));
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
    fn playlist_origin_separates_created_from_collected() {
        // 创建的歌单带正 dirid；收藏来的只有 tid（dirid 为 0 或缺失）。
        assert_eq!(
            qq_playlist_origin(&json!({"tid": "1", "dirid": 201})),
            "created"
        );
        assert_eq!(
            qq_playlist_origin(&json!({"tid": "2", "dirid": 0})),
            "collected"
        );
        assert_eq!(qq_playlist_origin(&json!({"dissid": "3"})), "collected");
    }

    #[test]
    fn favorite_playlist_directory_accepts_the_live_schema() {
        let data = json!({
            "v_list": [{
                "tid": 8674642290_u64,
                "title": "收藏的外部歌单",
                "picurl": "https://qpic.cn/cover.jpg",
                "songnum": "42"
            }],
            "total": 1,
            "hasmore": 0
        });
        let entry = &favorite_playlist_entries(&data).unwrap()[0];
        assert_eq!(qq_playlist_key(entry).as_deref(), Some("8674642290"));
        assert_eq!(qq_playlist_title(entry), Some("收藏的外部歌单"));
        assert_eq!(qq_playlist_cover(entry), "https://qpic.cn/cover.jpg");
        assert_eq!(qq_playlist_count(entry), 42);
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
        assert_eq!(
            media_mid_of(&json!({"file": {"media_mid": ""}}), "mid1"),
            "mid1"
        );
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

    #[test]
    fn qq_search_decorations_are_stripped_for_the_fallback_query() {
        assert_eq!(strip_qq_search_decorations("「拉海洛」之心"), "拉海洛之心");
        assert_eq!(strip_qq_search_decorations("『拉海洛』之心"), "拉海洛之心");
        assert_eq!(strip_qq_search_decorations("《拉海洛》之心"), "拉海洛之心");
        assert_eq!(strip_qq_search_decorations("拉海洛之心"), "拉海洛之心");
        assert_eq!(strip_qq_search_decorations("  「定玄」  "), "定玄");
    }
}
