//! `kdj` CLI 专用接口。AI 只经过这里：搜索与界面搜索框走同一条路径，结果给出短引用；
//! 下载立即开始、跟着这条 HTTP 连接走，连接断开（命令被中断）就取消。

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::header,
    response::Response,
    Json,
};
use kdj_core::models::{
    DownloadRequest, DownloadTask, IntakeKind, IntakeRequest, MergedGroup, Platform, Quality,
    SearchKind, SongSource, TaskState, VideoInfo,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::downloads::{start_tasks, DownloadManager};
use crate::error::{ApiError, ApiResult};
use crate::routes::{enqueue_sources, intake_one, normalize_dest_dir, Ctx};
use crate::state::{AppState, PLATFORMS};

/// 引用只活在内存里：重启后旧引用失效，AI 重新 search 即可。视频引用不依赖缓存。
const REF_CAPACITY: usize = 4000;
const COLLECTION_KINDS: [&str; 5] = ["playlist", "album", "artist", "radio", "mine"];
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone)]
enum Cached {
    Song(SongSource),
    Collection {
        platform: Platform,
        kind: SearchKind,
        key: String,
    },
    /// 账号侧歌单，走 `stream_playlist_tracks`。
    Mine { platform: Platform, key: String },
}

#[derive(Default)]
struct RefCache {
    map: HashMap<String, Cached>,
    order: VecDeque<String>,
}

fn refs() -> &'static Mutex<RefCache> {
    static REFS: OnceLock<Mutex<RefCache>> = OnceLock::new();
    REFS.get_or_init(Default::default)
}

fn remember(reference: &str, value: Cached) {
    let mut cache = refs().lock().unwrap();
    if cache.map.insert(reference.to_string(), value).is_none() {
        cache.order.push_back(reference.to_string());
    }
    while cache.order.len() > REF_CAPACITY {
        if let Some(oldest) = cache.order.pop_front() {
            cache.map.remove(&oldest);
        }
    }
}

fn recall(reference: &str) -> Option<Cached> {
    refs().lock().unwrap().map.get(reference).cloned()
}

fn song_ref(source: &SongSource) -> String {
    let page = source
        .payload
        .get("page_index")
        .and_then(Value::as_u64)
        .filter(|page| *page > 0);
    match page {
        Some(page) => format!("{}:{}:p{}", source.platform, source.key, page + 1),
        None => format!("{}:{}", source.platform, source.key),
    }
}

fn kind_name(kind: SearchKind) -> &'static str {
    match kind {
        SearchKind::Song => "song",
        SearchKind::Playlist => "playlist",
        SearchKind::Artist => "artist",
        SearchKind::Album => "album",
        SearchKind::Radio => "radio",
    }
}

fn is_video(platform: Platform) -> bool {
    matches!(platform, Platform::Bilibili | Platform::Youtube)
}

/// 视频引用即使不在缓存里也能下载：`bilibili:BV…[:pN]`、`youtube:<id>`。
fn video_ref_source(reference: &str) -> Option<SongSource> {
    let (platform, rest) = reference.split_once(':')?;
    let platform = Platform::parse(platform).filter(|p| is_video(*p))?;
    let (key, page) = match rest.rsplit_once(":p") {
        Some((key, page)) => (key, page.parse::<u64>().ok()?.checked_sub(1)?),
        None => (rest, 0),
    };
    if key.is_empty() || key.contains(':') {
        return None;
    }
    let mut payload = Map::new();
    if page > 0 {
        payload.insert("page_index".into(), json!(page));
    }
    Some(SongSource {
        platform,
        key: key.to_string(),
        title: String::new(),
        artists: Vec::new(),
        album: String::new(),
        duration: None,
        cover: String::new(),
        max_quality: None,
        vip: false,
        payload,
    })
}

fn project_song(source: &SongSource) -> Value {
    let reference = song_ref(source);
    remember(&reference, Cached::Song(source.clone()));
    json!({
        "ref": reference,
        "type": if is_video(source.platform) { "video" } else { "song" },
        "platform": source.platform,
        "title": source.title,
        "artists": source.artists,
        "album": source.album,
        "duration": source.duration,
        "max_quality": source.max_quality,
        "vip": source.vip,
    })
}

fn project_group(group: &MergedGroup) -> Option<Value> {
    let best = group
        .sources
        .get(group.best_source_index)
        .or(group.sources.first())?;
    let mut item = project_song(best);
    let others: Vec<Value> = group
        .sources
        .iter()
        .filter(|source| !std::ptr::eq(*source, best))
        .map(|source| {
            let projected = project_song(source);
            json!({ "ref": projected["ref"], "platform": source.platform, "max_quality": source.max_quality })
        })
        .collect();
    if !others.is_empty() {
        item["alternatives"] = Value::Array(others);
    }
    Some(item)
}

fn project_video(info: &VideoInfo) -> Vec<Value> {
    let pages = if info.pages.is_empty() {
        vec![(0usize, String::new(), info.duration)]
    } else {
        info.pages
            .iter()
            .map(|page| (page.index, page.title.clone(), page.duration))
            .collect()
    };
    let count = pages.len();
    pages
        .into_iter()
        .map(|(index, page_title, duration)| {
            let mut payload = Map::new();
            payload.insert("bvid".into(), json!(info.bvid));
            payload.insert("page_index".into(), json!(index));
            payload.insert("page_count".into(), json!(count));
            payload.insert("page_title".into(), json!(page_title));
            let source = SongSource {
                platform: info.platform,
                key: info.bvid.clone(),
                title: info.title.clone(),
                artists: vec![info.author.clone()].into_iter().filter(|a| !a.is_empty()).collect(),
                album: String::new(),
                duration: Some(duration as f64),
                cover: info.cover.clone(),
                max_quality: None,
                vip: false,
                payload,
            };
            let mut item = project_song(&source);
            if count > 1 {
                item["page"] = json!(index + 1);
                item["page_title"] = json!(page_title);
            }
            if !info.options.is_empty() {
                item["heights"] = json!(info.options.iter().map(|o| o.height).collect::<Vec<_>>());
            }
            item
        })
        .collect()
}

/// 和搜索框一致：B 站单视频走视频解析，收藏夹和其余输入走 intake。
fn bilibili_video_input(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let link = lower.contains("bilibili.com") || lower.contains("b23.tv");
    let id = (text.len() == 12 && text.starts_with("BV"))
        || (lower.len() > 2 && lower.starts_with("av") && lower[2..].bytes().all(|b| b.is_ascii_digit()));
    let favlist = lower.contains("/favlist") && lower.contains("fid=");
    (link || id) && !favlist
}

fn search_platforms(state: &AppState, kind: SearchKind, requested: &[Platform], link: bool) -> Vec<Platform> {
    let settings = state.config.to_settings();
    let enabled: Vec<Platform> = settings
        .enabled_platforms
        .iter()
        .filter_map(|p| Platform::parse(p))
        .collect();
    let mut platforms: Vec<Platform> = if requested.is_empty() {
        settings
            .search_platforms
            .iter()
            .filter_map(|p| Platform::parse(p))
            .filter(|p| enabled.is_empty() || enabled.contains(p))
            .collect()
    } else {
        requested.to_vec()
    };
    platforms.retain(|p| *p != Platform::Local);
    let priority = |p: &Platform| {
        settings
            .platform_priority
            .iter()
            .position(|name| name == p.as_str())
            .unwrap_or(usize::MAX)
    };
    platforms.sort_by_key(priority);
    if link {
        // 链接按域名补上唯一归属平台，和界面一样不让用户没勾的源挡住解析。
        for platform in [Platform::Bilibili, Platform::Youtube, Platform::Ytm] {
            if !platforms.contains(&platform) {
                platforms.push(platform);
            }
        }
        return platforms;
    }
    platforms
        .into_iter()
        .filter(|p| {
            state
                .provider(*p)
                .is_some_and(|provider| provider.capabilities().search_kinds.contains(&kind))
        })
        .collect()
}

#[derive(Deserialize)]
pub struct SearchBody {
    text: String,
    #[serde(default)]
    kind: SearchKind,
    #[serde(default)]
    platforms: Vec<Platform>,
    #[serde(default)]
    limit: Option<usize>,
}

/// 一次查找的结果：可下载的条目 + 可展开的集合。
struct Lookup {
    title: String,
    items: Vec<Value>,
    sources: Vec<SongSource>,
    collections: Vec<Value>,
    errors: Value,
    /// 单曲 / 单视频链接。YouTube 单视频会同时带回对应的 Music 音频，下载只取第一行。
    single: bool,
}

async fn expand_collection(state: &Arc<AppState>, cached: &Cached) -> ApiResult<(String, Vec<SongSource>)> {
    match cached {
        Cached::Collection { platform, kind, key } => {
            let provider = state.provider(*platform).ok_or_else(|| ApiError::not_found("平台不可用"))?;
            let response = provider
                .resolve_collection(*kind, key, 0)
                .await?
                .ok_or_else(|| ApiError::bad_request("该集合暂时无法展开"))?;
            Ok((response.title, response.sources))
        }
        Cached::Mine { platform, key } => {
            let provider = state.provider(*platform).ok_or_else(|| ApiError::not_found("平台不可用"))?;
            let response = provider
                .stream_playlist_tracks(key, 0)
                .await?
                .ok_or_else(|| ApiError::bad_request("该平台暂不支持歌单展开"))?;
            Ok((response.title, response.sources))
        }
        Cached::Song(source) => Ok((source.title.clone(), vec![source.clone()])),
    }
}

fn collection_ref(reference: &str) -> Option<Cached> {
    if let Some(cached) = recall(reference) {
        return Some(cached);
    }
    let mut parts = reference.splitn(3, ':');
    let platform = Platform::parse(parts.next()?)?;
    let kind = parts.next()?;
    let key = parts.next()?.to_string();
    if key.is_empty() || !COLLECTION_KINDS.contains(&kind) {
        return None;
    }
    Some(match kind {
        "mine" => Cached::Mine { platform, key },
        "playlist" => Cached::Collection { platform, kind: SearchKind::Playlist, key },
        "album" => Cached::Collection { platform, kind: SearchKind::Album, key },
        "artist" => Cached::Collection { platform, kind: SearchKind::Artist, key },
        _ => Cached::Collection { platform, kind: SearchKind::Radio, key },
    })
}

async fn lookup(state: &Arc<AppState>, body: &SearchBody) -> ApiResult<Lookup> {
    let text = body.text.trim();
    if text.is_empty() {
        return Err(ApiError::bad_request("search 需要关键词、链接或引用"));
    }
    let mut lookup = Lookup {
        title: String::new(),
        items: Vec::new(),
        sources: Vec::new(),
        collections: Vec::new(),
        errors: json!({}),
        single: false,
    };
    // 引用：集合与账号歌单直接展开；歌曲引用原样返回。
    if let Some(cached) = collection_ref(text) {
        let (title, sources) = expand_collection(state, &cached).await?;
        lookup.title = title;
        lookup.items = sources.iter().map(project_song).collect();
        lookup.sources = sources;
        return Ok(lookup);
    }
    if bilibili_video_input(text) {
        let provider = state
            .video_provider(Platform::Bilibili)
            .ok_or_else(|| ApiError::bad_request("哔哩哔哩不可用"))?;
        let info = provider.resolve_video(text).await?;
        lookup.title = info.title.clone();
        lookup.items = project_video(&info);
        return Ok(lookup);
    }
    let link = crate::aggregate::is_url(text);
    let platforms = search_platforms(state, body.kind, &body.platforms, link);
    if platforms.is_empty() {
        return Err(ApiError::bad_request("当前启用的来源都不支持这种搜索类型"));
    }
    let request = IntakeRequest {
        text: text.to_string(),
        platforms,
        limit: body.limit.unwrap_or(20).clamp(1, 100),
        merge: true,
        max_entries: 1,
        kind: body.kind,
    };
    let item = intake_one(state, text, &request).await;
    if item.kind == IntakeKind::Error {
        return Err(ApiError::bad_request(item.error));
    }
    lookup.title = item.title;
    lookup.single = item.kind == IntakeKind::Song;
    for group in &item.groups {
        if let Some(projected) = project_group(group) {
            lookup.items.push(projected);
        }
        if let Some(best) = group.sources.get(group.best_source_index).or(group.sources.first()) {
            lookup.sources.push(best.clone());
        }
    }
    lookup.collections = item
        .collections
        .iter()
        .map(|collection| {
            let reference = format!("{}:{}:{}", collection.platform, kind_name(collection.kind), collection.key);
            remember(
                &reference,
                Cached::Collection { platform: collection.platform, kind: collection.kind, key: collection.key.clone() },
            );
            json!({
                "ref": reference,
                "type": kind_name(collection.kind),
                "platform": collection.platform,
                "title": collection.title,
                "subtitle": collection.subtitle,
                "count": collection.count,
            })
        })
        .collect();
    lookup.errors = json!(item.errors);
    Ok(lookup)
}

pub async fn search(State(state): State<Arc<AppState>>, Json(body): Json<SearchBody>) -> ApiResult<Json<Value>> {
    let found = lookup(&state, &body).await?;
    let mut result = json!({ "items": found.items });
    if !found.title.is_empty() && found.title != body.text.trim() {
        result["title"] = json!(found.title);
    }
    if !found.collections.is_empty() {
        result["collections"] = json!(found.collections);
    }
    if found.errors.as_object().is_some_and(|errors| !errors.is_empty()) {
        result["errors"] = found.errors;
    }
    Ok(Json(result))
}

/// 一个 ref、链接或集合引用展开成要下载的来源。
async fn sources_for(state: &Arc<AppState>, input: &str) -> ApiResult<Vec<SongSource>> {
    if let Some(Cached::Song(source)) = recall(input) {
        return Ok(vec![source]);
    }
    if let Some(source) = video_ref_source(input) {
        return Ok(vec![source]);
    }
    let body = SearchBody { text: input.to_string(), kind: SearchKind::Song, platforms: Vec::new(), limit: None };
    let is_reference = collection_ref(input).is_some();
    if !is_reference && !crate::aggregate::is_url(input) && !bilibili_video_input(input) {
        return Err(ApiError::not_found(format!("引用不存在或已过期：{input}，请重新 search")));
    }
    let found = lookup(state, &body).await?;
    if found.sources.is_empty() {
        // B 站视频解析出的分 P 只在 items 里，以它们的引用重新取来源。
        let sources: Vec<SongSource> = found
            .items
            .iter()
            .filter_map(|item| item["ref"].as_str())
            .filter_map(|reference| match recall(reference) {
                Some(Cached::Song(source)) => Some(source),
                _ => None,
            })
            .collect();
        if sources.is_empty() {
            return Err(ApiError::bad_request(format!("没有可下载的内容：{input}")));
        }
        return Ok(sources);
    }
    let mut sources = found.sources;
    if found.single {
        sources.truncate(1);
    }
    Ok(sources)
}

#[derive(Deserialize)]
pub struct DownloadBody {
    refs: Vec<String>,
    #[serde(default)]
    to: String,
    #[serde(default)]
    quality: Option<Quality>,
    /// `audio` 只要视频的音轨；`video`（默认）保留完整视频。
    #[serde(default)]
    r#as: Option<String>,
    #[serde(default)]
    height: Option<i64>,
}

/// 连接结束（完成或被中断）时交还 CLI 通道；还没结束的任务一并取消。
struct LaneGuard {
    downloads: Arc<DownloadManager>,
    ids: Vec<String>,
}

impl Drop for LaneGuard {
    fn drop(&mut self) {
        for id in &self.ids {
            if self.downloads.get(id).is_some_and(|task| !stopped(task.state)) {
                self.downloads.cancel(id);
            }
        }
        self.downloads.leave_cli_lane(&self.ids);
    }
}

/// 暂停也算停：用户在界面里暂停了，CLI 不再干等。
fn stopped(state: TaskState) -> bool {
    matches!(state, TaskState::Done | TaskState::Failed | TaskState::Canceled | TaskState::Paused)
}

fn task_result(reference: &str, task: Option<&DownloadTask>) -> Value {
    let Some(task) = task else {
        return json!({ "ref": reference, "state": "canceled" });
    };
    let mut item = json!({
        "ref": reference,
        "title": task.title,
        "state": task.state,
    });
    if !task.path.is_empty() {
        item["path"] = json!(task.path);
    }
    if let Some(track_id) = task.track_id {
        item["track_id"] = json!(track_id);
    }
    if !task.error.is_empty() && task.state != TaskState::Done {
        item["error"] = json!(task.error);
    }
    item
}

fn line(value: Value) -> Result<Bytes, Infallible> {
    let mut text = value.to_string();
    text.push('\n');
    Ok(Bytes::from(text))
}

pub async fn download(
    State(state): State<Arc<AppState>>,
    axum::Extension(ctx): axum::Extension<Ctx>,
    Json(body): Json<DownloadBody>,
) -> ApiResult<Response> {
    if body.refs.is_empty() {
        return Err(ApiError::bad_request("download 需要至少一个引用或链接"));
    }
    let audio_only = match body.r#as.as_deref() {
        None | Some("video") => false,
        Some("audio") => true,
        Some(other) => return Err(ApiError::bad_request(format!("--as 只能是 audio 或 video：{other}"))),
    };
    let dest_dir = normalize_dest_dir(&state, &body.to)?;
    let mut planned: Vec<(String, SongSource)> = Vec::new();
    for input in &body.refs {
        let input = input.trim();
        for mut source in sources_for(&state, input).await? {
            if is_video(source.platform) {
                if audio_only {
                    source.payload.insert("audio_only".into(), json!(true));
                }
                if let Some(height) = body.height {
                    source.payload.insert("max_height".into(), json!(height));
                }
            }
            let reference = if collection_ref(input).is_some() || crate::aggregate::is_url(input) {
                song_ref(&source)
            } else {
                input.to_string()
            };
            planned.push((reference, source));
        }
    }
    let tasks = enqueue_sources(
        &state,
        &ctx.downloads,
        DownloadRequest {
            sources: planned.iter().map(|(_, source)| source.clone()).collect(),
            quality: body.quality,
            analyze: None,
            dest_dir,
            follow_default_dir: false,
            hold: true,
        },
    )?;
    let ids: Vec<String> = tasks.iter().map(|task| task.id.clone()).collect();
    let refs: Vec<String> = planned.into_iter().map(|(reference, _)| reference).collect();
    ctx.downloads.join_cli_lane(&ids);
    start_tasks(state.clone(), ctx.downloads.clone(), &ids);
    let guard = LaneGuard { downloads: ctx.downloads.clone(), ids };

    // 每秒一行进度，同时充当心跳：CLI 进程一退出，下一次写入失败，guard 随响应体释放。
    let stream = futures_util::stream::unfold(Some((guard, refs)), |held| async move {
        let (guard, refs) = held?;
        tokio::time::sleep(PROGRESS_INTERVAL).await;
        let tasks: Vec<Option<DownloadTask>> = guard.ids.iter().map(|id| guard.downloads.get(id)).collect();
        let finished = tasks.iter().all(|task| task.as_ref().is_none_or(|task| stopped(task.state)));
        if finished {
            let results: Vec<Value> = refs
                .iter()
                .zip(&tasks)
                .map(|(reference, task)| task_result(reference, task.as_ref()))
                .collect();
            let complete = tasks.iter().all(|task| task.as_ref().is_some_and(|t| t.state == TaskState::Done));
            return Some((line(json!({ "event": "result", "complete": complete, "items": results })), None));
        }
        let done = tasks.iter().filter(|task| task.as_ref().is_none_or(|t| stopped(t.state))).count();
        let progress = json!({ "event": "progress", "done": done, "total": tasks.len() });
        Some((line(progress), Some((guard, refs))))
    });
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream))
        .map_err(|error| ApiError::bad_request(error.to_string()))?)
}

fn login_methods(platform: Platform) -> &'static [&'static str] {
    match platform {
        Platform::Wyy | Platform::Qqm | Platform::Bilibili => &["qr"],
        Platform::Youtube | Platform::Ytm | Platform::Soundcloud => &["browser"],
        Platform::Local => &[],
    }
}

/// `kdj status` 的运行时部分：账号、可导入的浏览器、账号歌单、搜索与下载设置。
pub async fn status(State(state): State<Arc<AppState>>) -> Json<Value> {
    let providers: Vec<_> = PLATFORMS.into_iter().filter_map(|platform| state.provider(platform).cloned()).collect();
    let accounts = futures_util::future::join_all(providers.iter().map(|provider| provider.account())).await;
    let playlists = futures_util::future::join_all(
        providers
            .iter()
            .zip(&accounts)
            .filter(|(_, account)| account.state == kdj_core::models::AccountState::Valid)
            .map(|(provider, _)| async move {
                tokio::time::timeout(Duration::from_secs(10), provider.stream_playlists())
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_default()
            }),
    )
    .await;
    let playlists: Vec<Value> = playlists
        .into_iter()
        .flatten()
        .map(|playlist| {
            let reference = format!("{}:mine:{}", playlist.platform, playlist.key);
            remember(&reference, Cached::Mine { platform: playlist.platform, key: playlist.key.clone() });
            json!({ "ref": reference, "platform": playlist.platform, "title": playlist.title, "count": playlist.count })
        })
        .collect();
    let accounts: Vec<Value> = accounts
        .iter()
        .filter(|account| account.supports_login)
        .map(|account| {
            json!({
                "platform": account.platform,
                "label": account.label,
                "state": account.state,
                "nickname": account.nickname,
                "login": login_methods(account.platform),
            })
        })
        .collect();
    let browsers = tokio::task::spawn_blocking(kdj_providers::browser::catalog)
        .await
        .map(|catalog| {
            catalog
                .browsers
                .into_iter()
                .map(|browser| {
                    json!({
                        "id": browser.id,
                        "label": browser.label,
                        "profiles": browser.profiles.iter().map(|p| json!({ "id": p.id, "label": p.label })).collect::<Vec<_>>(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let kinds: Map<String, Value> = providers
        .iter()
        .map(|provider| {
            let caps = provider.capabilities();
            (
                provider.platform().to_string(),
                json!(caps.search_kinds.iter().map(|kind| kind_name(*kind)).collect::<Vec<_>>()),
            )
        })
        .collect();
    let settings = state.config.to_settings();
    Json(json!({
        "accounts": accounts,
        "browsers": browsers,
        "playlists": playlists,
        "search": {
            "default_platforms": search_platforms(&state, SearchKind::Song, &[], false),
            "kinds": kinds,
        },
        "download": {
            "default_dir": state.config.download_dir(),
            "library_roots": settings.library_dirs,
            "quality": settings.default_quality,
            "video_max_height": settings.video_max_height,
        },
        "auto_analysis": settings.auto_analysis_mode,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_refs_download_without_a_prior_search() {
        let source = video_ref_source("bilibili:BV1xx411c7mD:p3").unwrap();
        assert_eq!(source.platform, Platform::Bilibili);
        assert_eq!(source.key, "BV1xx411c7mD");
        assert_eq!(source.payload["page_index"], json!(2));
        assert_eq!(song_ref(&source), "bilibili:BV1xx411c7mD:p3");
        assert!(video_ref_source("youtube:dQw4w9WgXcQ").is_some());
        assert!(video_ref_source("wyy:123").is_none());
        assert!(video_ref_source("bilibili:BV1xx411c7mD:p0").is_none());
    }

    #[test]
    fn collection_refs_parse_without_cache() {
        assert!(matches!(
            collection_ref("wyy:playlist:42"),
            Some(Cached::Collection { platform: Platform::Wyy, kind: SearchKind::Playlist, .. })
        ));
        assert!(matches!(collection_ref("qqm:mine:7"), Some(Cached::Mine { platform: Platform::Qqm, .. })));
        assert!(collection_ref("wyy:12345").is_none());
        assert!(collection_ref("wyy:song:1").is_none());
    }

    #[test]
    fn bilibili_single_videos_match_the_search_box() {
        assert!(bilibili_video_input("https://www.bilibili.com/video/BV1xx411c7mD"));
        assert!(bilibili_video_input("BV1xx411c7mD"));
        assert!(bilibili_video_input("av170001"));
        assert!(!bilibili_video_input("https://space.bilibili.com/1/favlist?fid=123"));
        assert!(!bilibili_video_input("Around the World"));
    }
}
