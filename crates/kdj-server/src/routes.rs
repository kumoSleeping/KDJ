//! HTTP 路由。路径和响应形状必须和 `sidecar/kdj/app.py` 一一对应——
//! 前端 `src/lib/api.ts` 是照着旧契约写的。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use kdj_core::models::*;
use kdj_core::Settings;
use kdj_library::service::{DeletedTrack, FileDisposal, TrackQuery};
use kdj_providers::MusicProvider;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::downloads::{
    enqueue_audio, enqueue_video, enqueue_vj_export, retry_audio, retry_failed_audio,
    DownloadManager,
};
use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, FolderUndoBatch, FolderUndoItem, SongPreviewTicket, PLATFORMS};

#[derive(Clone)]
pub struct Ctx {
    pub state: Arc<AppState>,
    pub downloads: Arc<DownloadManager>,
}

pub fn router(ctx: Ctx) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/accounts", get(list_accounts))
        .route("/api/accounts/{platform}/login/qr", post(login_qr))
        .route(
            "/api/accounts/{platform}/login/qr/{session_id}",
            get(login_qr_state),
        )
        .route("/api/accounts/{platform}/logout", post(logout))
        .route(
            "/api/accounts/soundcloud/login/oauth",
            get(soundcloud_oauth_start),
        )
        .route(
            "/api/accounts/soundcloud/login/oauth/{state}",
            get(soundcloud_oauth_status),
        )
        .route(
            "/api/accounts/soundcloud/login/oauth/callback",
            post(soundcloud_oauth_callback),
        )
        .route(
            "/api/accounts/ytm/login/device",
            get(ytm_device_start),
        )
        .route(
            "/api/accounts/ytm/login/device/{device_code}",
            get(ytm_device_status),
        )
        .route("/api/search", post(search))
        .route("/api/search/cover", post(search_cover))
        .route("/api/search/capabilities", get(search_capabilities))
        .route("/api/search/collection", post(resolve_collection))
        .route("/api/lyrics", post(lyrics))
        .route("/api/song/preview", post(song_preview))
        .route(
            "/api/song/preview/{token}/waveform",
            get(song_preview_waveform),
        )
        .route("/api/song/preview/{token}", get(song_preview_stream))
        .route(
            "/api/song/cache",
            get(song_cache_stats).delete(clear_song_cache),
        )
        .route("/api/resolve", post(resolve))
        .route("/api/intake", post(intake))
        .route("/api/downloads", get(list_downloads).post(enqueue))
        .route("/api/downloads/{id}", delete(remove_download))
        .route("/api/downloads/start", post(start_downloads))
        .route("/api/downloads/{id}/cancel", post(cancel_download))
        .route("/api/downloads/{id}/retry", post(retry_download))
        .route("/api/downloads/clear", post(clear_downloads))
        .route("/api/video/resolve", post(video_resolve))
        .route("/api/video/download", post(video_download))
        .route("/api/video/preview", get(video_preview))
        .route("/api/video/calibrate", post(video_calibrate))
        .route("/api/vj/export", post(vj_export))
        .route("/api/library/tracks", get(library_tracks))
        .route(
            "/api/library/onelibrary/playlists",
            get(one_library_playlists).post(one_library_playlist_create),
        )
        .route(
            "/api/library/onelibrary/playlists/{id}",
            patch(one_library_playlist_patch).delete(one_library_playlist_delete),
        )
        .route(
            "/api/library/onelibrary/playlists/{id}/move",
            post(one_library_playlist_move),
        )
        .route(
            "/api/library/onelibrary/playlists/{id}/tracks/add",
            post(one_library_playlist_tracks_add),
        )
        .route(
            "/api/library/onelibrary/playlists/{id}/tracks",
            get(one_library_playlist_tracks).put(one_library_playlist_tracks_reorder),
        )
        .route(
            "/api/library/onelibrary/playlists/{id}/tracks/remove",
            post(one_library_playlist_tracks_remove),
        )
        .route(
            "/api/library/onelibrary/tracks/copy",
            post(one_library_playlist_tracks_copy),
        )
        .route(
            "/api/library/onelibrary/tracks/{id}/rating",
            patch(one_library_track_rating),
        )
        .route(
            "/api/library/onelibrary/capacity",
            post(one_library_capacity),
        )
        .route(
            "/api/library/onelibrary/import",
            post(one_library_import_tracks),
        )
        .route(
            "/api/library/onelibrary/cover",
            get(one_library_cover)
                .put(one_library_set_cover)
                .layer(axum::extract::DefaultBodyLimit::max(COVER_MAX_BYTES)),
        )
        .route(
            "/api/library/onelibrary/waveform",
            get(one_library_waveform),
        )
        .route("/api/library/devices", get(library_devices))
        .route(
            "/api/library/devices/authorize",
            post(library_device_authorize),
        )
        .route("/api/stream/playlists/{platform}", get(stream_playlists))
        .route("/api/stream/playlist", post(stream_playlist))
        .route("/api/library/tracks/{id}", get(library_track))
        .route("/api/library/lyrics/{id}", get(library_lyrics))
        .route("/api/library/tracks/{id}", patch(library_patch))
        .route("/api/library/tracks/{id}", delete(library_delete))
        // 静态段和 {id} 同位并存：axum 的 matchit 保证静态优先，
        // 且 "delete" 本来也解析不成 i64，不会被吞进单条路由
        .route("/api/library/tracks/delete", post(library_delete_batch))
        .route("/api/library/tracks/{id}/write-tags", post(write_tags))
        .route("/api/library/tracks/{id}/reread-tags", post(reread_tags))
        .route("/api/library/stats", get(library_stats))
        .route("/api/update/check", get(update_check))
        .route("/api/library/harmonic/{id}", get(library_harmonic))
        .route("/api/library/folders", get(library_folders))
        .route("/api/library/folders/create", post(folder_create))
        .route("/api/library/folders/rename", post(folder_rename))
        .route("/api/library/folders/delete", post(folder_delete))
        .route("/api/library/folders/forget", post(folder_forget))
        .route("/api/library/folders/init", post(folder_init))
        .route("/api/library/folders/upgrade", post(folder_upgrade))
        .route("/api/library/waveforms/upgrade", post(waveform_upgrade))
        .route("/api/library/folders/move", post(folder_move))
        .route("/api/library/folders/order", post(folder_order))
        .route(
            "/api/library/folders/undo",
            get(folder_undo_status).post(folder_undo),
        )
        .route("/api/library/folders/apply", post(folder_apply))
        .route("/api/library/scan", post(library_scan))
        .route("/api/library/analyze", post(library_analyze))
        .route("/api/library/analyze/cancel", post(library_analyze_cancel))
        .route("/api/library/audio/{id}", get(library_audio))
        .route("/api/library/video/{id}", get(library_video))
        .route(
            "/api/library/cover/{id}",
            get(library_cover)
                .put(library_set_cover)
                // axum 默认只收 2MB body，而随手挑的一张专辑封面动辄三五 MB，
                // 超了返回的是 413 而不是我们的 detail，用户只会看到"换封面失败"
                .layer(axum::extract::DefaultBodyLimit::max(COVER_MAX_BYTES)),
        )
        .route("/api/library/waveform/{id}", get(library_waveform))
        .layer(axum::Extension(ctx))
}

// ---------------------------------------------------------------- 基础

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    Json(Health {
        ok: true,
        version: kdj_core::VERSION.to_string(),
        ffmpeg: kdj_providers::ffmpeg::available(),
        data_dir: state.config.data_dir.to_string_lossy().into_owned(),
        download_dir: state.config.download_dir().to_string_lossy().into_owned(),
        // 前端据此隐藏安卓上做不了的桌面专属入口
        platform: std::env::consts::OS.to_string(),
    })
}

/// Settings 加一个**只读**的派生字段：前端「保存到」菜单里的「系统下载」
/// 选项需要知道默认落点的绝对路径（系统「下载」目录是本地化的，前端算不出来）。
/// 不进 Settings 本体：它不该被持久化，PUT 回来也会被 serde 直接忽略。
#[derive(Serialize)]
struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    default_download_dir: String,
}

fn settings_view(settings: Settings) -> SettingsView {
    SettingsView {
        settings,
        default_download_dir: kdj_core::config::default_download_root()
            .to_string_lossy()
            .into_owned(),
    }
}

async fn get_settings(State(state): State<Arc<AppState>>) -> Json<SettingsView> {
    Json(settings_view(state.config.to_settings()))
}

async fn put_settings(
    State(state): State<Arc<AppState>>,
    axum::Extension(ctx): axum::Extension<Ctx>,
    Json(payload): Json<Settings>,
) -> Json<SettingsView> {
    let previous_download_dir = state.config.download_dir();
    let settings = state.config.apply_settings(payload);
    if state.config.download_dir() != previous_download_dir {
        // 已完成的旧目录缓存保留给用户自行处理；但所有 pending/writer 必须失效，
        // 否则它们会在设置切换后继续写进统计/清理看不到的旧目录。
        state.stream_cache.cancel_writes();
        state.stream_waveforms.clear();
    }
    state
        .stream_cache
        .set_enabled(settings.stream_cache_enabled);
    if !settings.stream_cache_enabled {
        state.stream_waveforms.clear();
    }
    state.sync_provider_context();
    ctx.downloads.set_concurrency(settings.concurrent_downloads);
    // auto_start_downloads 保留在配置契约中兼容旧 settings.json，但下载队列现在
    // 使用一次性 generation 放行，避免点击「开始下载」后把未来新任务也自动启动。
    Json(settings_view(settings))
}

// ---------------------------------------------------------------- 账号

fn parse_platform(name: &str) -> ApiResult<Platform> {
    Platform::parse(name).ok_or_else(|| ApiError::not_found(format!("平台不可用：{name}")))
}

async fn list_accounts(State(state): State<Arc<AppState>>) -> Json<Vec<Account>> {
    let mut accounts = Vec::new();
    for platform in PLATFORMS {
        let Some(provider) = state.provider(platform) else {
            continue;
        };
        // 一个平台挂了不能让整页空白——`account()` 契约上就不返回 Err
        accounts.push(provider.account().await);
    }
    Json(accounts)
}

async fn login_qr(
    State(state): State<Arc<AppState>>,
    AxumPath(platform): AxumPath<String>,
) -> ApiResult<Json<QrSession>> {
    let platform = parse_platform(&platform)?;
    let provider = state
        .provider(platform)
        .ok_or_else(|| ApiError::not_found("平台不可用"))?;
    Ok(Json(provider.create_qr().await?))
}

async fn login_qr_state(
    State(state): State<Arc<AppState>>,
    AxumPath((platform, session_id)): AxumPath<(String, String)>,
) -> ApiResult<Json<QrState>> {
    let platform = parse_platform(&platform)?;
    let provider = state
        .provider(platform)
        .ok_or_else(|| ApiError::not_found("平台不可用"))?;
    let (value, message) = provider.poll_qr(&session_id).await?;

    let mut account = None;
    if value == QrStateValue::Done {
        let fresh = provider.account().await;
        state.hub.publish("account.changed", &fresh);
        account = Some(fresh);
    }
    Ok(Json(QrState {
        session_id,
        state: value,
        message,
        account,
    }))
}

async fn logout(
    State(state): State<Arc<AppState>>,
    AxumPath(platform): AxumPath<String>,
) -> ApiResult<Json<Account>> {
    let platform = parse_platform(&platform)?;
    let provider = state
        .provider(platform)
        .ok_or_else(|| ApiError::not_found("平台不可用"))?;
    provider.logout().await?;
    let account = provider.account().await;
    state.hub.publish("account.changed", &account);
    Ok(Json(account))
}

#[derive(Debug, Clone, Serialize)]
struct SoundCloudOAuthStart {
    state: String,
    authorization_url: String,
    expires_in: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct SoundCloudOAuthFinish {
    state: String,
    code: String,
}

const SOUNDCLOUD_REDIRECT_URI: &str = "kdj://soundcloud/callback";

async fn soundcloud_oauth_start(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<SoundCloudOAuthStart>> {
    let (oauth_state, authorization_url) = state.soundcloud.begin_oauth(SOUNDCLOUD_REDIRECT_URI)?;
    Ok(Json(SoundCloudOAuthStart {
        state: oauth_state,
        authorization_url,
        expires_in: 600,
    }))
}

async fn soundcloud_oauth_status(
    State(state): State<Arc<AppState>>,
    AxumPath(oauth_state): AxumPath<String>,
) -> Json<kdj_providers::soundcloud::OAuthStatus> {
    Json(state.soundcloud.oauth_status(&oauth_state))
}

async fn soundcloud_oauth_callback(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SoundCloudOAuthFinish>,
) -> ApiResult<Json<Account>> {
    let oauth_state = payload.state.trim();
    let code = payload.code.trim();
    if oauth_state.is_empty() || code.is_empty() {
        return Err(ApiError::bad_request(
            "SoundCloud OAuth 回调缺少 state 或 code",
        ));
    }
    state
        .soundcloud
        .finish_oauth(oauth_state, code, SOUNDCLOUD_REDIRECT_URI)
        .await?;
    let account = state.soundcloud.account().await;
    state.hub.publish("account.changed", &account);
    Ok(Json(account))
}

/// 发起一次 YouTube Music 设备码登录：返回 user_code / 激活地址 / 有效期。
async fn ytm_device_start(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(state.youtubemusic.begin_device_login().await?))
}

/// 查一次设备码登录状态；成功时登录态已落盘，响应里带上新账号。
async fn ytm_device_status(
    State(state): State<Arc<AppState>>,
    AxumPath(device_code): AxumPath<String>,
) -> Json<serde_json::Value> {
    Json(state.youtubemusic.poll_device_login(&device_code).await)
}

// ---------------------------------------------------------------- 搜索

async fn search(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SearchRequest>,
) -> Json<SearchResponse> {
    Json(crate::aggregate::search(&state, &payload).await)
}

#[derive(Debug, Deserialize)]
struct SearchCoverRequest {
    platform: Platform,
    url: String,
}

/// 从网易云 / QQ 搜索结果的封面 URL 取回图片字节。
///
/// 浏览器里的 `<img>` 可以直接显示跨域图片，但把它再 PUT 回本地音频时，
/// WebView 的 CORS 会挡住 `fetch`。这条窄代理只接受两个已启用音乐平台的
/// 图片域名，并在服务端先校验魔数，前端拿到的就是可写入标签的 JPEG / PNG。
async fn search_cover(Json(payload): Json<SearchCoverRequest>) -> ApiResult<Response> {
    let url = reqwest::Url::parse(payload.url.trim())
        .map_err(|_| ApiError::bad_request("封面地址无效"))?;
    if !matches!(url.scheme(), "http" | "https") || !cover_host_allowed(payload.platform, &url) {
        return Err(ApiError::bad_request(
            "封面地址不是允许的网易云 / QQ 图片地址",
        ));
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("KDJ cover matcher")
        .build()
        .map_err(|error| ApiError::bad_request(format!("封面代理不可用：{error}")))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| ApiError::bad_request(format!("封面下载失败：{error}")))?;
    if !response.status().is_success() {
        return Err(ApiError::bad_request(format!(
            "封面下载失败：HTTP {}",
            response.status()
        )));
    }
    if !cover_host_allowed(payload.platform, response.url()) {
        return Err(ApiError::bad_request("封面重定向到了不允许的地址"));
    }

    let mut data = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream
        .next()
        .await
        .transpose()
        .map_err(|error| ApiError::bad_request(format!("封面下载失败：{error}")))?
    {
        if data.len().saturating_add(chunk.len()) > COVER_MAX_BYTES {
            return Err(ApiError::bad_request("封面图片不能超过 16 MB"));
        }
        data.extend_from_slice(&chunk);
    }
    let mime = sniff_remote_cover(&data)
        .ok_or_else(|| ApiError::bad_request("在线封面不是 JPEG / PNG 图片"))?;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        data,
    )
        .into_response())
}

fn cover_host_allowed(platform: Platform, url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    match platform {
        Platform::Wyy => {
            host == "163.com" || host.ends_with(".163.com") || host.ends_with(".126.net")
        }
        Platform::Qqm => {
            host == "qq.com"
                || host.ends_with(".qq.com")
                || host == "gtimg.cn"
                || host.ends_with(".gtimg.cn")
                || host == "qpic.cn"
                || host.ends_with(".qpic.cn")
        }
        _ => false,
    }
}

fn sniff_remote_cover(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else {
        None
    }
}

async fn search_capabilities(
    State(state): State<Arc<AppState>>,
) -> Json<BTreeMap<String, Vec<kdj_core::models::SearchKind>>> {
    let mut result = BTreeMap::new();
    for platform in PLATFORMS {
        if let Some(provider) = state.provider(platform) {
            result.insert(
                platform.to_string(),
                provider.capabilities().search_kinds.to_vec(),
            );
        }
    }
    Json(result)
}

fn in_library_source_keys(state: &AppState, sources: &[SongSource]) -> Vec<String> {
    let known = crate::aggregate::library_source_keys(state);
    sources
        .iter()
        .filter_map(|source| {
            let token = format!("{}:{}", source.platform, source.key);
            known.contains(&token).then_some(token)
        })
        .collect()
}

#[derive(Serialize)]
struct CollectionResolveApiResponse {
    #[serde(flatten)]
    response: CollectionResolveResponse,
    in_library_source_keys: Vec<String>,
}

#[derive(Serialize)]
struct StreamPlaylistApiResponse {
    #[serde(flatten)]
    response: StreamPlaylistResponse,
    in_library_source_keys: Vec<String>,
}

async fn resolve_collection(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CollectionResolveRequest>,
) -> ApiResult<Json<CollectionResolveApiResponse>> {
    if payload.key.trim().is_empty() || !payload.kind.is_collection() {
        return Err(ApiError::bad_request("集合来源参数不完整"));
    }
    let provider = state
        .provider(payload.platform)
        .ok_or_else(|| ApiError::not_found("平台不可用"))?;
    if !provider.capabilities().search_kinds.contains(&payload.kind) {
        return Err(ApiError::bad_request("这个平台不支持该集合搜索"));
    }
    let response = provider
        .resolve_collection(payload.kind, &payload.key, payload.limit)
        .await?
        .ok_or_else(|| ApiError::bad_request("该集合暂时无法展开"))?;
    let in_library_source_keys = in_library_source_keys(&state, &response.sources);
    Ok(Json(CollectionResolveApiResponse {
        response,
        in_library_source_keys,
    }))
}

/// 按曲名 / 艺人自动搜歌词（网易云 + QQ）。有 source_platform/key 时优先直取。
async fn lyrics(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LyricsRequest>,
) -> ApiResult<Json<LyricsResponse>> {
    Ok(Json(crate::lyrics::lookup(&state, payload).await?))
}

#[derive(Deserialize)]
struct SongPreviewBody {
    source: SongSource,
    #[serde(default)]
    quality: Option<Quality>,
    /// 播放器解码失败后的重试会主动绕过并清掉旧缓存，再从平台刷新。
    #[serde(default)]
    bypass_cache: bool,
}

async fn song_cache_stats(
    State(state): State<Arc<AppState>>,
) -> Json<crate::stream_cache::StreamCacheStats> {
    Json(state.stream_cache.stats(&state.config).await)
}

async fn clear_song_cache(
    State(state): State<Arc<AppState>>,
) -> Json<crate::stream_cache::StreamCacheStats> {
    state.stream_waveforms.clear();
    Json(state.stream_cache.clear(&state.config).await)
}

fn schedule_stream_cache_verification(
    cache: crate::stream_cache::StreamCache,
    waveforms: crate::stream_waveform::StreamWaveformCoordinator,
    root: PathBuf,
    key: String,
) {
    tokio::spawn(async move {
        if !cache.verify(&root, &key).await {
            // 校验淘汰的 media 不能继续拿旧的完整波形冒充当前缓存。
            waveforms.remove(&key);
        }
    });
}

fn insert_song_preview_ticket(
    state: &AppState,
    ticket: SongPreviewTicket,
) -> Json<serde_json::Value> {
    let token = format!(
        "{:016x}{:016x}",
        rand::random::<u64>(),
        rand::random::<u64>()
    );
    let cached = ticket.cached;
    state
        .song_previews
        .lock()
        .unwrap()
        .insert(token.clone(), ticket);
    Json(json!({
        "url": format!("/api/song/preview/{token}"),
        "cached": cached,
        // 前端只拿到随机 ticket，波形端点在服务端据此查缓存键；绝不把磁盘
        // 路径或可推断来源的缓存键暴露给 WebView。
        "waveform_token": token,
    }))
}

#[derive(Serialize)]
struct SongPreviewWaveformResponse {
    /// 当前后端支持代理流旁路分析。它不再等同于“持久缓存设置已开启”：关闭磁盘
    /// 缓存时，同一份媒体响应也会进入短生命周期临时前缀，不能让前端提前停轮询。
    enabled: bool,
    #[serde(flatten)]
    progress: crate::stream_waveform::StreamWaveformProgress,
}

const SONG_PREVIEW_SESSION_WAVEFORM_ENABLED: bool = true;

/// 读取当前试听 token 对应的**已落盘/可读**缓存前缀波形。
///
/// 路由不接受 cache key / 文件路径，随机 ticket 也会照常续租；这样本机 WebView
/// 只拥有正在播放的会话能力，不能枚举用户的缓存目录。
async fn song_preview_waveform(
    State(state): State<Arc<AppState>>,
    AxumPath(token): AxumPath<String>,
) -> ApiResult<Response> {
    let ticket = {
        let mut previews = state.song_previews.lock().unwrap();
        previews
            .get_and_touch(&token)
            .ok_or_else(|| ApiError::not_found("试听地址已过期，请重新播放"))?
    };
    let cache_key = ticket
        .cache_key
        .clone()
        .unwrap_or_else(|| crate::stream_cache::StreamCache::key(&ticket.source, ticket.quality));
    let persistent_cache_enabled = state.config.to_settings().stream_cache_enabled;
    if persistent_cache_enabled {
        let cache_root = crate::stream_cache::StreamCache::cache_dir(&state.config);
        if let Some(cached) = state
            .stream_cache
            .lookup(&cache_root, &cache_key, &ticket.source, ticket.quality)
            .await
        {
            // 进程刚重启或本曲一开始就命中完整缓存时，这里首次把 final media
            // 交给渐进波形协调器；它仍要等前端真正轮询后才解码。
            state
                .stream_waveforms
                .observe(cache_key.clone(), cached.path, cached.bytes, true);
        }
    }
    let progress = state.stream_waveforms.request_with_analysis_duration(
        cache_key.clone(),
        state.config.to_settings().analysis_duration,
    );
    let progress = crate::stream_waveform::StreamWaveformProgress {
        active: progress.active
            || (persistent_cache_enabled && state.stream_cache.is_writing(&cache_key)),
        ..progress
    };
    // 这不是静态资源：同一个 token 的覆盖秒数和 revision 会变。明确 no-store，
    // 否则部分 WebView/HTTP 缓存会把第一次的空快照一直复用。
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(SongPreviewWaveformResponse {
            enabled: SONG_PREVIEW_SESSION_WAVEFORM_ENABLED,
            progress,
        }),
    )
        .into_response())
}

/// 搜索结果里的「试听」：按设置的试听音质拿播放直链，不下载不入库。
///
/// 前端把整个 SongSource 发过来而不是只发 key：QQ 的 media_mid、SoundCloud
/// 的 transcoding_url 都躺在 payload 里，只发 key 等于逼着后端把详情再查一遍。
async fn song_preview(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SongPreviewBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let Some(provider) = state.provider(body.source.platform) else {
        return Err(ApiError::bad_request("不认识的平台"));
    };
    let quality = body
        .quality
        .unwrap_or_else(|| state.config.to_settings().stream_quality);
    let cache_key = crate::stream_cache::StreamCache::key(&body.source, quality);
    let cache_root = crate::stream_cache::StreamCache::cache_dir(&state.config);
    if body.bypass_cache {
        state.stream_cache.invalidate(&cache_root, &cache_key).await;
        state.stream_waveforms.remove(&cache_key);
    } else if state.config.to_settings().stream_cache_enabled {
        if let Some(cached) = state
            .stream_cache
            .lookup(&cache_root, &cache_key, &body.source, quality)
            .await
        {
            state
                .stream_waveforms
                .observe(cache_key.clone(), cached.path, cached.bytes, true);
            schedule_stream_cache_verification(
                state.stream_cache.clone(),
                state.stream_waveforms.clone(),
                cache_root,
                cache_key.clone(),
            );
            return Ok(insert_song_preview_ticket(
                &state,
                SongPreviewTicket {
                    source: body.source,
                    quality,
                    cache_key: Some(cache_key),
                    cached: true,
                    url: String::new(),
                    last_used_at: std::time::Instant::now(),
                },
            ));
        }
    }
    match provider
        .preview_url_at_quality(&body.source, quality)
        .await?
    {
        Some(url) => Ok(insert_song_preview_ticket(
            &state,
            SongPreviewTicket {
                source: body.source,
                quality,
                cache_key: Some(cache_key),
                cached: false,
                url,
                last_used_at: std::time::Instant::now(),
            },
        )),
        // B 站等没有"歌曲试听"形状的平台：它们的预览走各自的路
        None => Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "这个平台不支持歌曲试听",
        )),
    }
}

/// 试听直链代理。平台 CDN 常返回 WebView 不认识的 Content-Type，或要求浏览器
/// 无法稳定携带的请求上下文；统一从回环服务转发，并完整支持 Range 拖动。
async fn song_preview_stream(
    State(state): State<Arc<AppState>>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let mut ticket = {
        let mut previews = state.song_previews.lock().unwrap();
        previews
            .get_and_touch(&token)
            .ok_or_else(|| ApiError::not_found("试听地址已过期，请重新双击歌曲"))?
    };
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let cache_key = ticket
        .cache_key
        .clone()
        .unwrap_or_else(|| crate::stream_cache::StreamCache::key(&ticket.source, ticket.quality));
    let cache_root = crate::stream_cache::StreamCache::cache_dir(&state.config);
    if state.config.to_settings().stream_cache_enabled {
        if let Some(cached) = state
            .stream_cache
            .lookup(&cache_root, &cache_key, &ticket.source, ticket.quality)
            .await
        {
            state.stream_waveforms.observe(
                cache_key.clone(),
                cached.path.clone(),
                cached.bytes,
                true,
            );
            schedule_stream_cache_verification(
                state.stream_cache.clone(),
                state.stream_waveforms.clone(),
                cache_root.clone(),
                cache_key.clone(),
            );
            match audio_response(&cached.path, cached.bytes, cached.mime, range.as_deref()).await {
                Ok(response) => return Ok(response),
                Err(_) => {
                    // 清理缓存可能恰好发生在 lookup 和 open 之间；这次直接回源。
                    state.stream_cache.invalidate(&cache_root, &cache_key).await;
                    state.stream_waveforms.remove(&cache_key);
                }
            }
        }
    }

    // 缓存票据故意不解析平台短链；缓存被关闭、清掉或校验失败时才回源。
    if ticket.cached || ticket.url.is_empty() {
        refresh_song_preview_ticket(&state, &token, &mut ticket).await?;
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|err| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;
    let mut upstream =
        request_song_preview_upstream(&client, &ticket.url, range.as_deref()).await?;
    let mut status = preview_upstream_status(&upstream);

    // 网易云 vkey、QQ sip 等短链可能在票据有效期内先过期。只在明确的鉴权/失效
    // 状态下按原 source + quality 刷新一次，并原样重放 Range；单次请求绝不死循环。
    if song_preview_url_needs_refresh(status) {
        refresh_song_preview_ticket(&state, &token, &mut ticket).await?;
        upstream = request_song_preview_upstream(&client, &ticket.url, range.as_deref()).await?;
        status = preview_upstream_status(&upstream);
    }

    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        return Err(ApiError::new(status, format!("试听源返回 HTTP {status}")));
    }
    let mut upstream_headers = upstream.headers().clone();
    let mut content_type = preview_audio_mime(&upstream_headers, "audio/mpeg");
    if content_type.is_none() {
        // 某些过期短链用 200 + HTML/JSON 错误页伪装成功；刷新一次再判，绝不把
        // 错误页送进 audio 或缓存成一首“歌曲”。
        refresh_song_preview_ticket(&state, &token, &mut ticket).await?;
        upstream = request_song_preview_upstream(&client, &ticket.url, range.as_deref()).await?;
        status = preview_upstream_status(&upstream);
        if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
            return Err(ApiError::new(status, format!("试听源返回 HTTP {status}")));
        }
        upstream_headers = upstream.headers().clone();
        content_type = preview_audio_mime(&upstream_headers, "audio/mpeg");
    }
    let content_type = content_type
        .ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY, "试听源返回的不是音频内容"))?;
    let persistent_cache_enabled = state.config.to_settings().stream_cache_enabled;
    let response_segment = preview_response_segment(status, &upstream_headers);
    state.stream_waveforms.media_started(&cache_key);
    if persistent_cache_enabled {
        // Android 的播放器和后台整轨 CDN 下载共用一条移动网络与同一块闪存，首播
        // 400ms 后再拉第二份整曲会直接表现成卡顿/爆音。移动端改为把播放器本来
        // 就收到的完整 0-based 响应 inline tee 进 StreamCacheWriter，不启动第二 GET。
        #[cfg(not(target_os = "android"))]
        schedule_song_preview_cache(
            state.clone(),
            token,
            ticket.clone(),
            cache_key.clone(),
            content_type.clone(),
        );
        #[cfg(target_os = "android")]
        schedule_song_preview_cache_when_session_idle(
            state.clone(),
            token.clone(),
            ticket.clone(),
            cache_key.clone(),
            content_type.clone(),
        );
    }
    let capture_plan = if persistent_cache_enabled {
        #[cfg(target_os = "android")]
        {
            let inline = match response_segment {
                Some(segment)
                    if segment.start == 0 && segment.end.saturating_add(1) == segment.total =>
                {
                    inline_preview_cache_plan(
                        &state,
                        &cache_root,
                        &cache_key,
                        &ticket,
                        &content_type,
                        segment.total,
                    )
                    .map(PreviewBodyCapturePlan::Persistent)
                }
                _ => None,
            };
            if inline.is_some() {
                inline
            } else {
                session_preview_capture_plan(&state, &cache_key, response_segment)
                    .map(PreviewBodyCapturePlan::Session)
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            None
        }
    } else {
        session_preview_capture_plan(&state, &cache_key, response_segment)
            .map(PreviewBodyCapturePlan::Session)
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store");
    for name in [header::CONTENT_LENGTH, header::CONTENT_RANGE] {
        if let Some(value) = upstream_headers.get(name.as_str()) {
            builder = builder.header(name, value);
        }
    }
    builder
        .body(captured_preview_body(upstream, capture_plan))
        .map_err(|err| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))
}

fn session_preview_capture_plan(
    state: &AppState,
    cache_key: &str,
    segment: Option<PreviewCacheSegment>,
) -> Option<crate::stream_waveform::StreamWaveformCapturePlan> {
    let segment = segment?;
    let expected = segment.end.checked_sub(segment.start)?.checked_add(1)?;
    state.stream_waveforms.capture_plan(
        state.config.data_dir.join("stream-waveform-session"),
        cache_key.to_string(),
        segment.start,
        expected,
        segment.total,
        segment.end.saturating_add(1) == segment.total,
    )
}

#[cfg(target_os = "android")]
const INLINE_CACHE_WAVEFORM_PUBLISH_BYTES: u64 = 512 * 1024;

#[cfg(target_os = "android")]
struct InlinePreviewCachePlan {
    cache: crate::stream_cache::StreamCache,
    source: SongSource,
    quality: Quality,
    content_type: String,
    waveforms: crate::stream_waveform::StreamWaveformCoordinator,
    cache_key: String,
    cache_root: PathBuf,
    total: u64,
}

#[cfg(target_os = "android")]
struct InlinePreviewCacheCapture {
    writer: crate::stream_cache::StreamCacheWriter,
    waveforms: crate::stream_waveform::StreamWaveformCoordinator,
    cache_key: String,
    cache_root: PathBuf,
    total: u64,
    published_bytes: u64,
    response_bytes: u64,
}

#[cfg(target_os = "android")]
fn inline_preview_cache_plan(
    state: &AppState,
    cache_root: &Path,
    cache_key: &str,
    ticket: &SongPreviewTicket,
    content_type: &str,
    total: u64,
) -> Option<InlinePreviewCachePlan> {
    (total > 0).then(|| InlinePreviewCachePlan {
        cache: state.stream_cache.clone(),
        source: ticket.source.clone(),
        quality: ticket.quality,
        content_type: content_type.to_string(),
        waveforms: state.stream_waveforms.clone(),
        cache_key: cache_key.to_string(),
        cache_root: cache_root.to_path_buf(),
        total,
    })
}

#[cfg(target_os = "android")]
impl InlinePreviewCachePlan {
    async fn begin(self) -> Option<InlinePreviewCacheCapture> {
        let mut reservation = self.cache.reserve(self.cache_key.clone())?;
        // worker 内也绝不等待槽位；拿不到就关闭旁路，媒体响应已经在独立前进。
        if !reservation.try_acquire_slot() {
            return None;
        }
        let writer = reservation
            .begin_write(
                &self.cache_root,
                &self.source,
                self.quality,
                self.content_type,
                Some(self.total),
            )
            .await
            .ok()
            .flatten()?;
        Some(InlinePreviewCacheCapture {
            writer,
            waveforms: self.waveforms,
            cache_key: self.cache_key,
            cache_root: self.cache_root,
            total: self.total,
            published_bytes: 0,
            response_bytes: 0,
        })
    }
}

#[cfg(target_os = "android")]
impl InlinePreviewCacheCapture {
    async fn write_chunk(&mut self, chunk: &[u8]) -> std::io::Result<()> {
        if self.writer.written_bytes() == 0 && looks_like_text_error_payload(chunk) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "试听缓存首包不是音频",
            ));
        }
        let next_response_bytes = self.response_bytes.saturating_add(chunk.len() as u64);
        if next_response_bytes > self.total {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "媒体响应超过声明的完整资源长度",
            ));
        }
        if !self.writer.write_chunk(chunk).await? {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "流媒体缓存已取消",
            ));
        }
        self.response_bytes = next_response_bytes;
        let written = self.writer.written_bytes();
        if written.saturating_sub(self.published_bytes) >= INLINE_CACHE_WAVEFORM_PUBLISH_BYTES
            && self.writer.flush_for_observer().await?
        {
            self.waveforms.observe(
                self.cache_key.clone(),
                self.writer.partial_path().to_path_buf(),
                written,
                false,
            );
            self.published_bytes = written;
        }
        Ok(())
    }

    async fn finish(mut self, reached_eof: bool) -> std::io::Result<()> {
        if !reached_eof || self.response_bytes != self.total {
            // Drop 删除不完整 partial；不能把有缺口的文件提交成可命中缓存。
            return Ok(());
        }
        let committed = self.writer.finish().await?;
        if committed {
            self.waveforms.observe(
                self.cache_key.clone(),
                crate::stream_cache::StreamCache::media_path(&self.cache_root, &self.cache_key),
                self.total,
                true,
            );
        }
        Ok(())
    }
}

enum PreviewBodyCapturePlan {
    Session(crate::stream_waveform::StreamWaveformCapturePlan),
    #[cfg(target_os = "android")]
    Persistent(InlinePreviewCachePlan),
}

impl PreviewBodyCapturePlan {
    async fn begin(self) -> Option<PreviewBodyCapture> {
        match self {
            Self::Session(plan) => plan
                .begin()
                .await
                .ok()
                .flatten()
                .map(PreviewBodyCapture::Session),
            #[cfg(target_os = "android")]
            Self::Persistent(plan) => plan.begin().await.map(PreviewBodyCapture::Persistent),
        }
    }
}

enum PreviewBodyCapture {
    Session(crate::stream_waveform::StreamWaveformCapture),
    #[cfg(target_os = "android")]
    Persistent(InlinePreviewCacheCapture),
}

impl PreviewBodyCapture {
    async fn write_chunk(&mut self, chunk: &[u8]) -> std::io::Result<()> {
        match self {
            Self::Session(capture) => capture.write_chunk(chunk).await,
            #[cfg(target_os = "android")]
            Self::Persistent(capture) => capture.write_chunk(chunk).await,
        }
    }

    async fn finish(self, reached_eof: bool) -> std::io::Result<()> {
        match self {
            Self::Session(capture) => capture.finish(reached_eof).await,
            #[cfg(target_os = "android")]
            Self::Persistent(capture) => capture.finish(reached_eof).await,
        }
    }
}

const PREVIEW_CAPTURE_QUEUE_CHUNKS: usize = 8;

fn start_preview_capture_worker(
    plan: PreviewBodyCapturePlan,
) -> (
    tokio::sync::mpsc::Sender<axum::body::Bytes>,
    Arc<AtomicBool>,
) {
    let (sender, mut receiver) =
        tokio::sync::mpsc::channel::<axum::body::Bytes>(PREVIEW_CAPTURE_QUEUE_CHUNKS);
    let reached_eof = Arc::new(AtomicBool::new(false));
    let worker_eof = Arc::clone(&reached_eof);
    tokio::spawn(async move {
        // mkdir/open/StreamCacheWriter::begin_write 全在这里；媒体响应构造和 chunk
        // 转发只面对有界 sender，不会等待初始化。
        let Some(mut capture) = plan.begin().await else {
            return;
        };
        let mut healthy = true;
        while let Some(chunk) = receiver.recv().await {
            if capture.write_chunk(&chunk).await.is_err() {
                healthy = false;
                break;
            }
        }
        let complete = healthy && worker_eof.load(Ordering::Acquire);
        let _ = capture.finish(complete).await;
    });
    (sender, reached_eof)
}

fn enqueue_preview_capture(
    sender: &mut Option<tokio::sync::mpsc::Sender<axum::body::Bytes>>,
    chunk: &axum::body::Bytes,
) {
    let Some(active) = sender.as_ref() else {
        return;
    };
    // Bytes::clone 只增引用计数。队列满/后台失败就关闭本次旁路并保留连续前缀，
    // 绝不能 await 写盘或 flush，让可选波形对媒体流施加 backpressure。
    if active.try_send(chunk.clone()).is_err() {
        sender.take();
    }
}

/// 把代理已经读取到的同一份字节投进有界后台队列。旁路写盘/分析再慢也不会卡住
/// 音频 chunk；只有上游媒体流本身失败才向播放器报错。
fn captured_preview_body(
    upstream: reqwest::Response,
    capture: Option<PreviewBodyCapturePlan>,
) -> axum::body::Body {
    let source = Box::pin(upstream.bytes_stream());
    let (sender, reached_eof) = capture
        .map(start_preview_capture_worker)
        .map(|(sender, reached_eof)| (Some(sender), Some(reached_eof)))
        .unwrap_or((None, None));
    let stream = futures_util::stream::unfold(
        (source, sender, reached_eof, false),
        |(mut source, mut sender, reached_eof, done)| async move {
            if done {
                return None;
            }
            match source.next().await {
                Some(Ok(chunk)) => {
                    enqueue_preview_capture(&mut sender, &chunk);
                    Some((Ok(chunk), (source, sender, reached_eof, false)))
                }
                Some(Err(error)) => {
                    sender.take();
                    Some((
                        Err(std::io::Error::other(format!("试听流读取失败：{error}"))),
                        (source, None, reached_eof, true),
                    ))
                }
                None => {
                    if sender.is_some() {
                        if let Some(reached_eof) = reached_eof.as_ref() {
                            reached_eof.store(true, Ordering::Release);
                        }
                        sender.take();
                    }
                    None
                }
            }
        },
    );
    axum::body::Body::from_stream(stream)
}

async fn refresh_song_preview_ticket(
    state: &AppState,
    token: &str,
    ticket: &mut SongPreviewTicket,
) -> ApiResult<()> {
    let provider = state
        .provider(ticket.source.platform)
        .ok_or_else(|| ApiError::bad_request("不认识的平台"))?;
    let refreshed_url = provider
        .preview_url_at_quality(&ticket.source, ticket.quality)
        .await?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "这个平台暂时无法刷新试听地址",
            )
        })?;
    ticket.url = refreshed_url;
    ticket.cached = false;
    ticket.last_used_at = std::time::Instant::now();
    let mut previews = state.song_previews.lock().unwrap();
    if !previews.update_url(token, ticket.url.clone()) {
        // 极端并发下票据可能在 provider 请求期间被容量淘汰；当前正在用的票据
        // 应恢复为最新租约，避免随后 seek 立刻 404。
        previews.insert(token.to_string(), ticket.clone());
    }
    Ok(())
}

fn schedule_song_preview_cache(
    state: Arc<AppState>,
    token: String,
    ticket: SongPreviewTicket,
    cache_key: String,
    content_type_hint: String,
) {
    let Some(mut reservation) = state.stream_cache.reserve(cache_key.clone()) else {
        return;
    };
    tokio::spawn(async move {
        // 先让 WebView 的首批缓冲独占链路；缓存是后台完整拉取，不参与首包延迟。
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        #[cfg(target_os = "android")]
        if !state.stream_waveforms.is_session_idle(&cache_key) {
            // 延迟任务醒来后用户可能已经重新播放同一首；此时宁可本轮不缓存，也
            // 不能让第二 GET 再次和 WebView 抢网络/闪存。
            return;
        }
        if !reservation.is_valid() || !reservation.acquire_slot().await {
            return;
        }
        let cache_root = crate::stream_cache::StreamCache::cache_dir(&state.config);
        if let Some(cached) = state
            .stream_cache
            .lookup(&cache_root, &cache_key, &ticket.source, ticket.quality)
            .await
        {
            state
                .stream_waveforms
                .observe(cache_key, cached.path, cached.bytes, true);
            return;
        }
        if let Err(error) = cache_song_preview_background(
            state,
            token,
            ticket,
            cache_key,
            content_type_hint,
            reservation,
        )
        .await
        {
            tracing::debug!(error = %error, "在线音频后台缓存未完成");
        }
    });
}

#[cfg(target_os = "android")]
fn schedule_song_preview_cache_when_session_idle(
    state: Arc<AppState>,
    token: String,
    ticket: SongPreviewTicket,
    cache_key: String,
    content_type_hint: String,
) {
    let Some(deferred) = state.stream_cache.defer_until_idle(cache_key.clone()) else {
        return;
    };
    tokio::spawn(async move {
        // media_started 会给当前播放续 5 秒租约；先跨过它，再每 2 秒确认一次。
        // bounded Range 因而不会丢掉持久缓存功能，但补整轨只会发生在切歌/播放
        // 结束且前缀分析也退出之后。
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        loop {
            if !deferred.is_valid() {
                return;
            }
            if state.stream_waveforms.is_session_idle(&cache_key) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        if !deferred.is_valid() {
            return;
        }
        drop(deferred);
        schedule_song_preview_cache(state, token, ticket, cache_key, content_type_hint);
    });
}

#[derive(Debug, Clone, Copy)]
struct PreviewCacheSegment {
    start: u64,
    end: u64,
    total: u64,
}

fn preview_cache_segment(
    status: StatusCode,
    headers: &HeaderMap,
    requested_start: u64,
) -> Option<PreviewCacheSegment> {
    let segment = preview_response_segment(status, headers)?;
    (segment.start == requested_start).then_some(segment)
}

/// 从上游响应本身取出实际字节区间。媒体代理的 Range 可能被 CDN 忽略并退成 200，
/// 所以波形旁路必须以响应头为准，不能拿浏览器请求头猜写入偏移。
fn preview_response_segment(
    status: StatusCode,
    headers: &HeaderMap,
) -> Option<PreviewCacheSegment> {
    if status == StatusCode::OK {
        let total = headers
            .get(header::CONTENT_LENGTH)?
            .to_str()
            .ok()?
            .parse::<u64>()
            .ok()?;
        return (total > 0).then_some(PreviewCacheSegment {
            start: 0,
            end: total - 1,
            total,
        });
    }
    if status != StatusCode::PARTIAL_CONTENT {
        return None;
    }
    let raw = headers.get(header::CONTENT_RANGE)?.to_str().ok()?.trim();
    let (unit, value) = raw.split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (span, total) = value.split_once('/')?;
    let (start, end) = span.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = end.parse::<u64>().ok()?;
    let total = total.parse::<u64>().ok()?;
    if start > end || end >= total {
        return None;
    }
    let declared = end - start + 1;
    if let Some(length) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        if length != declared {
            return None;
        }
    }
    Some(PreviewCacheSegment { start, end, total })
}

async fn refresh_background_preview_url(
    state: &AppState,
    token: &str,
    ticket: &SongPreviewTicket,
) -> Result<String, String> {
    let provider = state
        .provider(ticket.source.platform)
        .ok_or_else(|| "缓存来源平台不可用".to_string())?;
    let url = provider
        .preview_url_at_quality(&ticket.source, ticket.quality)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "缓存来源地址无法刷新".to_string())?;
    let mut previews = state.song_previews.lock().unwrap();
    let _ = previews.update_url(token, url.clone());
    Ok(url)
}

async fn cache_song_preview_background(
    state: Arc<AppState>,
    token: String,
    ticket: SongPreviewTicket,
    cache_key: String,
    content_type_hint: String,
    reservation: crate::stream_cache::StreamCacheReservation,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;
    let cache_root = crate::stream_cache::StreamCache::cache_dir(&state.config);
    let mut url = ticket.url.clone();
    let mut offset = 0_u64;
    let mut expected_total = None;
    let mut writer: Option<crate::stream_cache::StreamCacheWriter> = None;
    let mut reservation = Some(reservation);
    let mut refreshes_left = 1_u8;
    // 只在累计跨过一个有意义的增长量时 publish 给只读波形任务。每个网络 chunk
    // 都 flush 会把纯展示需求放大成大量 IO；最终提交会无条件再 publish 一次。
    let mut last_waveform_observed_bytes = 0_u64;

    // 绝大多数 CDN 对 bytes=0- 一次返回整首；循环同时兼容主动限制单段大小的源。
    for _ in 0..2048 {
        if !state.config.to_settings().stream_cache_enabled
            || reservation.as_ref().is_some_and(|item| !item.is_valid())
            || writer.as_ref().is_some_and(|item| !item.is_valid())
        {
            return Ok(());
        }
        let request = client
            .get(&url)
            .header(reqwest::header::RANGE, format!("bytes={offset}-"));
        let mut response = tokio::time::timeout(std::time::Duration::from_secs(30), request.send())
            .await
            .map_err(|_| "缓存源连接超时".to_string())?
            .map_err(|error| format!("缓存源连接失败：{error}"))?;
        let status = preview_upstream_status(&response);
        if song_preview_url_needs_refresh(status) {
            if offset > 0 {
                return Err("缓存续传地址失效，已丢弃本次临时文件".into());
            }
            if refreshes_left == 0 {
                return Err(format!("缓存源刷新后仍返回 HTTP {status}"));
            }
            refreshes_left -= 1;
            url = refresh_background_preview_url(&state, &token, &ticket).await?;
            continue;
        }
        let Some(mime) = preview_audio_mime(response.headers(), &content_type_hint) else {
            if offset > 0 {
                return Err("缓存续传源变成了非音频内容，已丢弃临时文件".into());
            }
            if refreshes_left == 0 {
                return Err("缓存源刷新后仍返回非音频内容".into());
            }
            refreshes_left -= 1;
            url = refresh_background_preview_url(&state, &token, &ticket).await?;
            continue;
        };
        let segment = preview_cache_segment(status, response.headers(), offset)
            .ok_or_else(|| format!("缓存源没有返回可续写的完整范围：HTTP {status}"))?;
        if expected_total.is_some_and(|total| total != segment.total) {
            return Err("缓存源总长度在续传时发生变化".into());
        }
        expected_total = Some(segment.total);

        if writer.is_none() {
            writer = reservation
                .take()
                .expect("reservation is consumed only once")
                .begin_write(
                    &cache_root,
                    &ticket.source,
                    ticket.quality,
                    mime,
                    Some(segment.total),
                )
                .await
                .map_err(|error| format!("创建缓存临时文件失败：{error}"))?;
            if writer.is_none() {
                return Ok(());
            }
        }

        let mut received = 0_u64;
        loop {
            let chunk = tokio::time::timeout(std::time::Duration::from_secs(30), response.chunk())
                .await
                .map_err(|_| "缓存源连续 30 秒没有返回数据".to_string())?
                .map_err(|error| format!("读取缓存源失败：{error}"))?;
            let Some(chunk) = chunk else {
                break;
            };
            if offset == 0 && received == 0 && looks_like_text_error_payload(&chunk) {
                return Err("缓存源返回了 HTML/JSON 错误内容".into());
            }
            received = received.saturating_add(chunk.len() as u64);
            let writer = writer.as_mut().expect("writer created above");
            let keep_writing = writer
                .write_chunk(&chunk)
                .await
                .map_err(|error| format!("写入缓存失败：{error}"))?;
            if !keep_writing {
                return Ok(());
            }
            if writer
                .written_bytes()
                .saturating_sub(last_waveform_observed_bytes)
                >= 512 * 1024
            {
                // writer 仍独占写句柄；协调器只会另开一个普通只读句柄去读已经可见
                // 的文件前缀。读取失败（例如 MP4 的尾部索引尚未到达）会安静等待下次
                // 增长或最终文件，绝不影响缓存写入和播放。
                if writer.flush_for_observer().await.unwrap_or(false) {
                    last_waveform_observed_bytes = writer.written_bytes();
                    state.stream_waveforms.observe(
                        cache_key.clone(),
                        writer.partial_path().to_path_buf(),
                        last_waveform_observed_bytes,
                        false,
                    );
                }
            }
        }
        let declared = segment.end - segment.start + 1;
        if received != declared {
            return Err(format!(
                "缓存分段长度不符：声明 {declared}，收到 {received}"
            ));
        }
        offset = segment.end + 1;
        if offset == segment.total {
            let committed = writer
                .as_mut()
                .expect("writer created above")
                .finish()
                .await
                .map_err(|error| format!("提交缓存失败：{error}"))?;
            if committed {
                state.stream_waveforms.observe(
                    cache_key.clone(),
                    crate::stream_cache::StreamCache::media_path(&cache_root, &cache_key),
                    segment.total,
                    true,
                );
                tracing::debug!(source = %ticket.source.key, bytes = segment.total, "在线音频已缓存");
            }
            return Ok(());
        }
    }
    Err("缓存源分段过多，已停止续传".into())
}

fn looks_like_text_error_payload(bytes: &[u8]) -> bool {
    let prefix = bytes
        .iter()
        .copied()
        .take(96)
        .skip_while(|byte| byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    let lower = String::from_utf8_lossy(&prefix).to_ascii_lowercase();
    lower.starts_with("<!doctype html")
        || lower.starts_with("<html")
        || lower.starts_with("<?xml")
        || lower.starts_with("#extm3u")
        || lower.starts_with('{')
        || lower.starts_with("[{")
}

fn preview_upstream_status(response: &reqwest::Response) -> StatusCode {
    StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY)
}

fn preview_audio_mime(headers: &HeaderMap, fallback: &str) -> Option<String> {
    let Some(raw) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    else {
        return Some(fallback.to_string());
    };
    let base = raw
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if base.starts_with("audio/") {
        return Some(raw.to_string());
    }
    if matches!(
        base.as_str(),
        "application/octet-stream" | "binary/octet-stream"
    ) {
        return Some(fallback.to_string());
    }
    None
}

fn song_preview_url_needs_refresh(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND | StatusCode::GONE
    )
}

async fn request_song_preview_upstream(
    client: &reqwest::Client,
    url: &str,
    range: Option<&str>,
) -> ApiResult<reqwest::Response> {
    let mut request = client.get(url);
    if let Some(range) = range {
        request = request.header(reqwest::header::RANGE, range);
    }
    request
        .send()
        .await
        .map_err(|err| ApiError::new(StatusCode::BAD_GATEWAY, format!("试听源连接失败：{err}")))
}

/// 逐个平台试解析。返回 `(结果, 最后一次错误)`，结果为 None 表示没人认得这个链接。
///
/// **一家报错要接着试下一家**：网易云的分享链接过期时它会抛错，但同一条
/// 短链有可能被 QQ 认走；在第一个错误上就断掉，用户看到的是"解析失败"，
/// 而实际上换一家就能出结果。
async fn resolve_core(
    state: &Arc<AppState>,
    url: &str,
    limit: usize,
) -> (Option<ResolveResponse>, String) {
    let mut last_error = String::new();
    for platform in PLATFORMS {
        let Some(provider) = state.provider(platform) else {
            continue;
        };
        match provider.resolve(url, limit).await {
            Ok(Some(response)) => return (Some(response), last_error),
            Ok(None) => continue,
            Err(err) => {
                tracing::warn!("解析 {platform} 失败：{err:#}");
                last_error = format!("{err:#}");
            }
        }
    }
    (None, last_error)
}

/// 没人认领时的错误文案。带上最后一次的原因，否则用户只知道"不行"而不知道为什么。
fn unresolved_detail(last_error: &str) -> String {
    if last_error.is_empty() {
        "无法识别的链接".to_string()
    } else {
        format!("无法识别的链接：{last_error}")
    }
}

async fn resolve(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ResolveRequest>,
) -> ApiResult<Json<ResolveResponse>> {
    let url = payload.url.trim();
    if url.is_empty() {
        return Err(ApiError::bad_request("链接不能为空"));
    }
    let (result, last_error) = resolve_core(&state, url, payload.limit).await;
    result
        .map(Json)
        .ok_or_else(|| ApiError::bad_request(unresolved_detail(&last_error)))
}

/// 投喂里的链接一律按"这可能是个歌单"来取，条数和 `/api/resolve` 的默认值一致。
/// 跟着 `limit`（那是**搜索**每平台的条数，默认 20）走的话，
/// 粘一个 300 首的歌单进来只会解析出前 20 首。
const INTAKE_RESOLVE_LIMIT: usize = 500;

/// 外层并发度。和 Python 的 `INTAKE_WORKERS` 一致。
const INTAKE_WORKERS: usize = 4;

/// 单条 entry 的处理上限，和 Python 的 `INTAKE_TIMEOUT` 一致。
const INTAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// 一条投喂失败时的形状。`kind=error` 是前端渲染红色错误行的依据。
fn intake_error(entry: String, message: impl Into<String>) -> IntakeItem {
    IntakeItem {
        entry,
        kind: IntakeKind::Error,
        platform: None,
        title: String::new(),
        groups: Vec::new(),
        collections: Vec::new(),
        errors: Default::default(),
        error: message.into(),
    }
}

/// 批量投喂：一大段文本进来，按行/逗号拆开，逐条决定是搜索还是解析链接。
async fn intake(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<IntakeRequest>,
) -> ApiResult<Json<IntakeResponse>> {
    let started = std::time::Instant::now();
    let (entries, skipped) =
        crate::aggregate::split_intake_text(&payload.text, payload.max_entries);
    if entries.is_empty() {
        // 一条都没拆出来（纯空白/纯标点）说明这次提交是无效的，
        // 回一份空结果的话前端会显示"0 条输入"，看着像后端把内容吃了
        return Err(ApiError::bad_request("没有解析出任何关键词或链接"));
    }

    // 并发但收着点：每条 entry 自己还会再并发打各平台，外层再开大
    // 就等于对平台接口发起几十路并发，非常容易被限流。`buffered` 保序。
    let mut items: Vec<IntakeItem> = futures_util::stream::iter(entries.into_iter().map(|entry| {
        let state = &state;
        let payload = &payload;
        async move {
            match tokio::time::timeout(INTAKE_TIMEOUT, intake_one(state, &entry, payload)).await {
                Ok(item) => item,
                // 一条卡死不能把整批拖到浏览器超时，把它单独标成失败继续走
                Err(_) => intake_error(entry, "处理超时"),
            }
        }
    }))
    .buffered(INTAKE_WORKERS)
    .collect()
    .await;
    // 「已在库」角标：整批只查一次曲库
    let known = crate::aggregate::library_source_keys(&state);
    for item in &mut items {
        crate::aggregate::mark_in_library(&mut item.groups, &known);
    }
    Ok(Json(IntakeResponse {
        items,
        skipped,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    }))
}

async fn intake_one(state: &Arc<AppState>, entry: &str, payload: &IntakeRequest) -> IntakeItem {
    let mut item = IntakeItem {
        entry: entry.to_string(),
        kind: IntakeKind::Search,
        platform: None,
        title: String::new(),
        groups: Vec::new(),
        collections: Vec::new(),
        errors: Default::default(),
        error: String::new(),
    };

    if crate::aggregate::is_url(entry) {
        // 链接：挨个问 provider 认不认。一家报错继续问下一家，和 /api/resolve 同一条实现
        let (result, last_error) = resolve_core(state, entry, INTAKE_RESOLVE_LIMIT).await;
        let Some(response) = result else {
            // 认不出来算这一条**失败**，不是"未知类型"：前端按 kind 分支渲染，
            // unknown 会被当成一个空包展开，用户看不到失败原因
            item.kind = IntakeKind::Error;
            item.error = unresolved_detail(&last_error);
            return item;
        };
        item.kind = match response.kind {
            ResolveKind::Song => IntakeKind::Song,
            ResolveKind::Playlist => IntakeKind::Playlist,
            ResolveKind::Album => IntakeKind::Album,
            ResolveKind::Unknown => IntakeKind::Unknown,
        };
        item.platform = Some(response.platform);
        item.title = response.title;
        // 歌单里的每一首各自成一组，前端可以逐条勾选
        item.groups = response
            .sources
            .into_iter()
            .map(crate::aggregate::singleton_group)
            .collect();
        return item;
    }

    // 关键词：走和 /api/search 同一条实现，避免两份逻辑漂移
    let response = crate::aggregate::search(
        state,
        &SearchRequest {
            query: entry.to_string(),
            platforms: payload.platforms.clone(),
            limit: payload.limit,
            merge: payload.merge,
            kind: payload.kind,
        },
    )
    .await;
    item.kind = match payload.kind {
        SearchKind::Song => IntakeKind::Search,
        SearchKind::Playlist => IntakeKind::Playlist,
        SearchKind::Artist => IntakeKind::Artist,
        SearchKind::Album => IntakeKind::Album,
        SearchKind::Radio => IntakeKind::Radio,
    };
    item.title = entry.to_string();
    item.groups = response.groups;
    item.collections = response.collections;
    item.errors = response.errors;
    item
}

// ---------------------------------------------------------------- 下载

async fn list_downloads(axum::Extension(ctx): axum::Extension<Ctx>) -> Json<Vec<DownloadTask>> {
    Json(ctx.downloads.list())
}

async fn start_downloads(
    State(state): State<Arc<AppState>>,
    axum::Extension(ctx): axum::Extension<Ctx>,
) -> Json<serde_json::Value> {
    // 「开始」是队列的统一执行入口：新排队任务和之前失败、可重试的歌曲
    // 应该在同一次点击里一起跑，不能逼用户再逐行点一遍「重试」。
    let retried = retry_failed_audio(state, ctx.downloads.clone());
    ctx.downloads.release_queued();
    Json(json!({ "started": true, "retried": retried }))
}

async fn enqueue(
    State(state): State<Arc<AppState>>,
    axum::Extension(ctx): axum::Extension<Ctx>,
    Json(payload): Json<DownloadRequest>,
) -> ApiResult<Json<Vec<DownloadTask>>> {
    if payload.sources.is_empty() {
        // 空数组回 200 + [] 的话，前端那句"已加入队列"照样会弹，
        // 而队列里什么都没有——这是最容易被当成"下载坏了"的一种表现
        return Err(ApiError::bad_request("没有要下载的曲目"));
    }
    let dest_dir = normalize_dest_dir(&state, &payload.dest_dir)?;
    let settings = state.config.to_settings();
    let quality = payload.quality.unwrap_or(settings.default_quality);
    let analyze = payload.analyze.unwrap_or(settings.auto_analyze);
    let tasks = payload
        .sources
        .into_iter()
        .map(|source| {
            enqueue_audio(
                state.clone(),
                ctx.downloads.clone(),
                source,
                quality,
                analyze,
                dest_dir.clone(),
            )
        })
        .collect();
    // 整批入队后广播一次完整队列：超过上限被裁掉的旧条目只能靠这条事件让前端知道
    ctx.downloads.broadcast_list();
    Ok(Json(tasks))
}

async fn cancel_download(
    axum::Extension(ctx): axum::Extension<Ctx>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<DownloadTask>> {
    ctx.downloads
        .cancel(&id)
        .map(Json)
        .ok_or_else(|| ApiError::not_found("任务不存在"))
}

async fn retry_download(
    State(state): State<Arc<AppState>>,
    axum::Extension(ctx): axum::Extension<Ctx>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<DownloadTask>> {
    retry_audio(state, ctx.downloads.clone(), &id)
        .map(Json)
        .map_err(ApiError::from)
}

async fn clear_downloads(axum::Extension(ctx): axum::Extension<Ctx>) -> Json<serde_json::Value> {
    Json(json!({ "removed": ctx.downloads.clear_finished() }))
}

/// 移除一条已经结束的任务记录。运行中的条目必须先取消，不能在它还持有进程时
/// 直接从队列地图里拔掉。
async fn remove_download(
    AxumPath(id): AxumPath<String>,
    axum::Extension(ctx): axum::Extension<Ctx>,
) -> ApiResult<Json<serde_json::Value>> {
    let task = ctx
        .downloads
        .get(&id)
        .ok_or_else(|| ApiError::not_found("任务不存在"))?;
    if !matches!(
        task.state,
        TaskState::Done | TaskState::Failed | TaskState::Canceled
    ) {
        return Err(ApiError::bad_request("只能移除已结束的任务；请先取消"));
    }
    ctx.downloads
        .remove_finished(&id)
        .ok_or_else(|| ApiError::bad_request("任务无法移除"))?;
    Ok(Json(json!({ "removed": true })))
}

// ---------------------------------------------------------------- 视频

#[derive(Deserialize)]
struct VideoResolveBody {
    #[serde(default)]
    url: String,
}

async fn video_resolve(
    State(state): State<Arc<AppState>>,
    Json(body): Json<VideoResolveBody>,
) -> ApiResult<Json<VideoInfo>> {
    let url = body.url.trim();
    if url.is_empty() {
        return Err(ApiError::bad_request("链接不能为空"));
    }
    Ok(Json(state.bilibili.resolve_video(url).await?))
}

/// 前端没显式给画质/转码时跟随全局设置。
///
/// 单独摘出来是为了能测：`max_height <= 0` 必须落回设置里的值，
/// 否则会拿一个 0 去挑流，结果是"下下来的是最低画质"。
fn apply_video_defaults(req: &mut VideoDownloadRequest, settings: &Settings) {
    if req.max_height <= 0 {
        req.max_height = settings.video_max_height;
    }
    if !req.transcode {
        req.transcode = settings.video_transcode;
    }
    // 偏移封顶 ±10 分钟：这个值来自预览面板一下一下按出来的校准，
    // 正常不过几秒；来一个天文数字的负偏移等于让 ffmpeg 铺几小时黑场
    req.offset_ms = req.offset_ms.clamp(-600_000, 600_000);
}

async fn video_download(
    State(state): State<Arc<AppState>>,
    axum::Extension(ctx): axum::Extension<Ctx>,
    Json(mut payload): Json<VideoDownloadRequest>,
) -> ApiResult<Json<DownloadTask>> {
    if payload.url.trim().is_empty() && payload.bvid.trim().is_empty() {
        return Err(ApiError::bad_request("缺少视频链接或 BV 号"));
    }
    apply_video_defaults(&mut payload, &state.config.to_settings());
    payload.dest_dir = normalize_dest_dir(&state, &payload.dest_dir)?;
    // 立刻入队、立刻返回。真正的标题要向 B 站请求一次才知道，那一跳放在
    // 下载任务自己的线程里做（见 `enqueue_video`）——在这里同步等的话，
    // 点一次「下载」按钮要卡上几秒才有反应，限流时更久。
    let task = enqueue_video(state.clone(), ctx.downloads.clone(), payload);
    ctx.downloads.broadcast_list();
    Ok(Json(task))
}

fn normalize_vj_quality(raw: &str) -> ApiResult<String> {
    match raw.trim() {
        "1080p" | "720p" | "480p" => Ok(raw.trim().to_string()),
        "" => Ok("1080p".into()),
        other => Err(ApiError::bad_request(format!("不支持的导出质量：{other}"))),
    }
}

async fn vj_export(
    State(state): State<Arc<AppState>>,
    axum::Extension(ctx): axum::Extension<Ctx>,
    Json(mut payload): Json<VjExportRequest>,
) -> ApiResult<Json<DownloadTask>> {
    if payload.track_ids.is_empty() {
        return Err(ApiError::bad_request("没有要导出的曲目"));
    }
    // 文件夹必须在曲库里；normalize_dest_dir 顺带校验「是目录」。
    payload.folder = normalize_dest_dir(&state, &payload.folder)?;
    if payload.folder.is_empty() {
        return Err(ApiError::bad_request("缺少导出源文件夹"));
    }
    payload.quality = normalize_vj_quality(&payload.quality)?;
    if !payload.fade_seconds.is_finite() || !(0.0..=120.0).contains(&payload.fade_seconds) {
        return Err(ApiError::bad_request("淡入淡出秒数应在 0 到 120 之间"));
    }
    if payload.fade_bars > 32 {
        return Err(ApiError::bad_request("淡入淡出小节数不能超过 32"));
    }
    // 小节是更精确的音乐语义；两者误传时优先按上一首的小节计算。
    if payload.fade_bars > 0 {
        payload.fade_seconds = 0.0;
    }
    // 整节开时隐含拍对齐（和前端开关语义一致）。
    if payload.snap_whole_bar {
        payload.snap_nearest_beat = true;
    }
    let folder_label = Path::new(&payload.folder)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(payload.folder.as_str())
        .to_string();
    let task = enqueue_vj_export(state.clone(), ctx.downloads.clone(), payload, &folder_label);
    ctx.downloads.broadcast_list();
    Ok(Json(task))
}

#[derive(Deserialize)]
struct VideoPreviewParams {
    bvid: String,
    /// 分 P 下标，从 0 起。
    #[serde(default)]
    page: usize,
    /// 视频在线播放上限；省略时跟随 settings.json。
    #[serde(default)]
    max_height: Option<i64>,
}

/// 视频预览流代理。B 站 CDN 认 Referer + Cookie 的防盗链，webview 里的
/// `<video>` 发不出这些头，只能由后端转一手。Range 原样进出——
/// 进度条的每次拖动就是一个新的 Range 请求。
async fn video_preview(
    State(state): State<Arc<AppState>>,
    Query(params): Query<VideoPreviewParams>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty());
    let max_height = params
        .max_height
        .unwrap_or_else(|| state.config.to_settings().video_playback_max_height);
    let stream = state
        .bilibili
        .preview_stream_at_height(&params.bvid, params.page, max_height, range)
        .await?;
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(stream.status).unwrap_or(StatusCode::OK))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, stream.content_type.as_str());
    if let Some(length) = stream.content_length {
        builder = builder.header(header::CONTENT_LENGTH, length);
    }
    if let Some(content_range) = stream.content_range.as_deref() {
        builder = builder.header(header::CONTENT_RANGE, content_range);
    }
    builder
        .body(axum::body::Body::from_stream(stream.body))
        .map_err(|err| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("构造预览响应失败：{err}"),
            )
        })
}

#[derive(Deserialize)]
struct VideoCalibrateBody {
    track_id: i64,
    bvid: String,
    #[serde(default)]
    page: usize,
}

/// 低采样率响度包络：8kHz mono PCM 每 400 点算一个 RMS，最终 20Hz。
fn pcm_envelope(bytes: &[u8]) -> Vec<f64> {
    let samples: Vec<f64> = bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f64 / i16::MAX as f64)
        .collect();
    let mut values: Vec<f64> = samples
        .chunks(400)
        .filter(|chunk| chunk.len() == 400)
        .map(|chunk| {
            let power = chunk.iter().map(|value| value * value).sum::<f64>() / chunk.len() as f64;
            (1.0 + power.sqrt() * 100.0).ln()
        })
        .collect();
    if values.is_empty() {
        return values;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance = values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / values.len() as f64;
    let scale = variance.sqrt().max(1e-6);
    for value in &mut values {
        *value = (*value - mean) / scale;
    }
    values
}

fn decode_alignment_envelope(input: String, headers: Option<String>) -> Result<Vec<f64>, String> {
    let ffmpeg = kdj_providers::ffmpeg::binary().map_err(|err| format!("{err:#}"))?;
    let mut command = std::process::Command::new(ffmpeg);
    command.args(["-v", "error", "-t", "210"]);
    if let Some(headers) = headers {
        command.args(["-headers", &headers]);
    }
    let output = command
        .args([
            "-i", &input, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1",
        ])
        .output()
        .map_err(|err| format!("启动 ffmpeg 失败：{err}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffmpeg 解码失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let envelope = pcm_envelope(&output.stdout);
    if envelope.len() < 20 * 30 {
        return Err("可用于校准的音频不足 30 秒".into());
    }
    Ok(envelope)
}

/// 在周期 20Hz 的响度包络上做归一化互相关。返回“视频相对本地音频”的偏移：
/// 正数 = 视频前面有额外片头，协同播放应从视频该位置开始；负数 = 视频延迟起播。
fn correlate_offset(local: &[f64], video: &[f64]) -> (i64, f64) {
    let local = &local[..local.len().min(20 * 120)];
    let mut best = (0i32, f64::NEG_INFINITY);
    for lag in -(20 * 30)..=(20 * 150) {
        let local_start = (-lag).max(0) as usize;
        let video_start = lag.max(0) as usize;
        let count = (local.len() - local_start).min(video.len().saturating_sub(video_start));
        if count < 20 * 30 {
            continue;
        }
        let score = local[local_start..local_start + count]
            .iter()
            .zip(&video[video_start..video_start + count])
            .map(|(a, b)| a * b)
            .sum::<f64>()
            / count as f64;
        if score > best.1 {
            best = (lag, score);
        }
    }
    (best.0 as i64 * 50, best.1)
}

/// 自动校准本地歌曲与 B 站视频音轨。只解码低采样率 PCM，不下载成品、不入库。
async fn video_calibrate(
    State(state): State<Arc<AppState>>,
    Json(body): Json<VideoCalibrateBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let track = state
        .library
        .get(body.track_id)?
        .ok_or_else(|| ApiError::not_found("用于校准的本地曲目不存在"))?;
    if !Path::new(&track.path).is_file() {
        return Err(ApiError::not_found("用于校准的本地音频文件已丢失"));
    }
    let (video_url, cookies) = state
        .bilibili
        .calibration_audio_source(&body.bvid, body.page)
        .await
        .map_err(|err| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                format!("获取视频音轨失败：{err:#}"),
            )
        })?;
    let headers = format!(
        "Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0\r\n{}",
        if cookies.is_empty() {
            String::new()
        } else {
            format!("Cookie: {cookies}\r\n")
        }
    );
    let local_path = track.path;
    let local_job =
        tokio::task::spawn_blocking(move || decode_alignment_envelope(local_path, None));
    let video_job =
        tokio::task::spawn_blocking(move || decode_alignment_envelope(video_url, Some(headers)));
    let (local, video) = tokio::join!(local_job, video_job);
    let local = local
        .map_err(|err| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?
        .map_err(|err| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, err))?;
    let video = video
        .map_err(|err| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?
        .map_err(|err| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, err))?;
    let (offset_ms, score) = correlate_offset(&local, &video);
    if !score.is_finite() || score < 0.12 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("两段音频相似度不足，无法可靠自动校准（{score:.2}）"),
        ));
    }
    Ok(Json(json!({ "offset_ms": offset_ms, "score": score })))
}

// ---------------------------------------------------------------- 曲库

#[derive(Debug, Default, Deserialize)]
struct TrackQueryParams {
    #[serde(default)]
    q: String,
    #[serde(default)]
    key: String,
    bpm_min: Option<f64>,
    bpm_max: Option<f64>,
    energy_min: Option<i64>,
    analyzed: Option<bool>,
    #[serde(default)]
    folder: String,
    #[serde(default)]
    folder_deep: bool,
    #[serde(default)]
    sort: Option<String>,
    #[serde(default)]
    order: Option<String>,
    /// 副排序键：主键相同的那一撮再按它排。空 = 只按主键。
    #[serde(default)]
    sort2: Option<String>,
    #[serde(default)]
    order2: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn stream_playlists(
    State(state): State<Arc<AppState>>,
    AxumPath(platform): AxumPath<String>,
) -> ApiResult<Json<Vec<StreamPlaylist>>> {
    let platform = parse_platform(&platform)?;
    let provider = state
        .provider(platform)
        .ok_or_else(|| ApiError::not_found("平台不可用"))?;
    Ok(Json(provider.stream_playlists().await?))
}

async fn stream_playlist(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<StreamPlaylistRequest>,
) -> ApiResult<Json<StreamPlaylistApiResponse>> {
    if payload.key.trim().is_empty() {
        return Err(ApiError::bad_request("歌单来源缺少 key"));
    }
    let provider = state
        .provider(payload.platform)
        .ok_or_else(|| ApiError::not_found("平台不可用"))?;
    let response = provider
        .stream_playlist_tracks(&payload.key, payload.limit)
        .await?
        .ok_or_else(|| ApiError::bad_request("该平台暂不支持歌单展开"))?;
    let in_library_source_keys = in_library_source_keys(&state, &response.sources);
    Ok(Json(StreamPlaylistApiResponse {
        response,
        in_library_source_keys,
    }))
}

async fn library_tracks(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TrackQueryParams>,
) -> ApiResult<Json<TrackPage>> {
    let outside = params.folder.trim() == kdj_library::folders::OUTSIDE_FOLDER;
    let exclude_under = if outside {
        library_roots(&state)
            .into_iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect()
    } else {
        Vec::new()
    };
    let query = TrackQuery {
        q: params.q,
        key: params.key,
        bpm_min: params.bpm_min,
        bpm_max: params.bpm_max,
        energy_min: params.energy_min,
        analyzed: params.analyzed,
        folder: if outside {
            String::new()
        } else {
            params.folder
        },
        folder_deep: params.folder_deep,
        exclude_under,
        sort: params.sort.unwrap_or_else(|| "added_at".into()),
        order: params.order.unwrap_or_else(|| "desc".into()),
        sort2: params.sort2.unwrap_or_default(),
        order2: params.order2.unwrap_or_else(|| "asc".into()),
        limit: params.limit.unwrap_or(200).clamp(1, 1000),
        offset: params.offset.unwrap_or(0).max(0),
    };
    Ok(Json(state.library.list_tracks(&query)?))
}

#[derive(Debug, Default, Deserialize)]
struct OneLibraryDeviceParams {
    #[serde(default)]
    device_path: String,
}

#[derive(Debug, Default, Deserialize)]
struct CreateOneLibraryPlaylistRequest {
    #[serde(default)]
    device_path: String,
    #[serde(default)]
    name: String,
    parent_id: Option<i32>,
    #[serde(default)]
    folder: bool,
}

#[derive(Debug, Default, Deserialize)]
struct PatchOneLibraryPlaylistRequest {
    #[serde(default)]
    device_path: String,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Default, Deserialize)]
struct MoveOneLibraryPlaylistRequest {
    #[serde(default)]
    device_path: String,
    #[serde(default)]
    parent_id: i32,
    sequence: Option<i32>,
}

#[derive(Debug, Default, Deserialize)]
struct OneLibraryPlaylistTracksRequest {
    #[serde(default)]
    device_path: String,
    #[serde(default)]
    track_ids: Vec<i64>,
}

#[derive(Debug, Default, Deserialize)]
struct ReorderOneLibraryPlaylistTracksRequest {
    #[serde(default)]
    device_path: String,
    #[serde(default)]
    content_ids: Vec<i32>,
}

#[derive(Debug, Default, Deserialize)]
struct OneLibraryRatingRequest {
    #[serde(default)]
    device_path: String,
    #[serde(default)]
    rating: i32,
}

#[derive(Debug, Default, Deserialize)]
struct CopyOneLibraryPlaylistTracksRequest {
    #[serde(default)]
    source_device_path: String,
    #[serde(default)]
    source_playlist_id: i32,
    #[serde(default)]
    target_device_path: String,
    #[serde(default)]
    target_playlist_id: i32,
    #[serde(default)]
    content_ids: Vec<i32>,
}

#[derive(Debug, Default, Deserialize)]
struct ImportOneLibraryTracksRequest {
    #[serde(default)]
    device_path: String,
    #[serde(default)]
    playlist_id: i32,
    #[serde(default)]
    content_ids: Vec<i32>,
    #[serde(default)]
    dest: String,
}

#[derive(Debug, Default, Deserialize)]
struct OneLibraryCoverParams {
    #[serde(default)]
    device_path: String,
    #[serde(default)]
    content_id: i32,
}

#[derive(Debug, Deserialize)]
struct OneLibraryWaveformParams {
    #[serde(default)]
    device_path: String,
    #[serde(default)]
    content_id: i32,
    #[serde(default)]
    playback_id: i64,
    #[serde(default = "default_buckets")]
    buckets: usize,
}

/// rbox 为每次 `OneLibrary::new` 建独立 r2d2 池；同一加密库被列表轮询、封面缩略图
/// 和写操作同时建多个池时，连接初始化会互相撞成 `database is locked`。HTTP 边界只让
/// 一个短数据库任务进入；波形解码等拿到安全路径后立即释放许可，不占着锁做重活。
static ONE_LIBRARY_HTTP_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

async fn one_library_task<T, F>(task: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    let _permit = ONE_LIBRARY_HTTP_SLOT
        .acquire()
        .await
        .map_err(|error| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, error.to_string()))?;
    let result = tokio::task::spawn_blocking(task)
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))??;
    Ok(result)
}

async fn one_library_playlists(
    Query(params): Query<OneLibraryDeviceParams>,
) -> ApiResult<Json<Vec<OneLibraryPlaylist>>> {
    let playlists =
        one_library_task(move || crate::usb_library::one_library_playlists(&params.device_path))
            .await?;
    Ok(Json(playlists))
}

async fn one_library_playlist_create(
    Json(payload): Json<CreateOneLibraryPlaylistRequest>,
) -> ApiResult<Json<OneLibraryPlaylist>> {
    let playlist = one_library_task(move || {
        crate::usb_library::create_one_library_playlist(
            &payload.device_path,
            &payload.name,
            payload.parent_id,
            payload.folder,
        )
    })
    .await?;
    Ok(Json(playlist))
}

async fn one_library_playlist_patch(
    AxumPath(id): AxumPath<i32>,
    Json(payload): Json<PatchOneLibraryPlaylistRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    one_library_task(move || {
        crate::usb_library::rename_one_library_playlist(&payload.device_path, id, &payload.name)
    })
    .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn one_library_playlist_move(
    AxumPath(id): AxumPath<i32>,
    Json(payload): Json<MoveOneLibraryPlaylistRequest>,
) -> ApiResult<Json<Vec<OneLibraryPlaylist>>> {
    let playlists = one_library_task(move || {
        crate::usb_library::move_one_library_playlist(
            &payload.device_path,
            id,
            payload.parent_id,
            payload.sequence,
        )
    })
    .await?;
    Ok(Json(playlists))
}

async fn one_library_playlist_delete(
    AxumPath(id): AxumPath<i32>,
    Json(payload): Json<OneLibraryDeviceParams>,
) -> ApiResult<Json<serde_json::Value>> {
    one_library_task(move || {
        crate::usb_library::delete_one_library_playlist(&payload.device_path, id)
    })
    .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn one_library_playlist_tracks_add(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i32>,
    Json(payload): Json<OneLibraryPlaylistTracksRequest>,
) -> ApiResult<Json<PlaylistExportResult>> {
    let mut seen = HashSet::new();
    let mut tracks = Vec::new();
    for track_id in payload.track_ids {
        if track_id <= 0 || !seen.insert(track_id) {
            continue;
        }
        tracks.push(
            state
                .library
                .get(track_id)?
                .ok_or_else(|| ApiError::not_found(format!("曲目不存在：{track_id}")))?,
        );
    }
    let device_path = payload.device_path;
    let analysis_cache_dir = state.config.data_dir.join("waveform");
    let result = one_library_task(move || {
        crate::usb_library::add_one_library_playlist_tracks(
            &device_path,
            id,
            tracks,
            Some(&analysis_cache_dir),
        )
    })
    .await?;
    Ok(Json(result))
}

async fn one_library_playlist_tracks(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i32>,
    Query(params): Query<OneLibraryDeviceParams>,
) -> ApiResult<Json<Vec<kdj_core::models::OneLibraryTrack>>> {
    let device_path = params.device_path;
    let mut tracks = one_library_task({
        let device_path = device_path.clone();
        move || crate::usb_library::one_library_playlist_tracks(&device_path, id)
    })
    .await?;

    let mut changed_local_ids = Vec::new();
    for track in &mut tracks {
        let Some(local_id) = track.local_track_id else {
            continue;
        };
        let Some(local) = state.library.get(local_id)? else {
            track.local_track_id = None;
            continue;
        };
        let key = format!("{device_path}\0{}", track.content_id);
        let previous = state
            .one_library_sync
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                key,
                crate::state::OneLibrarySyncSnapshot {
                    rating: track.rating,
                    cover_version: track.cover_version.clone(),
                    update_count: track.external_update_count,
                },
            );
        let first_external_edit = previous.is_none() && track.external_modified;
        let rating_changed = first_external_edit
            || previous
                .as_ref()
                .is_some_and(|seen| seen.rating != track.rating);
        let cover_changed = first_external_edit
            || previous.as_ref().is_some_and(|seen| {
                seen.cover_version != track.cover_version
                    || seen.update_count != track.external_update_count
            });

        if rating_changed && local.rating != track.rating {
            if let Err(error) = state.library.patch(
                local_id,
                &TrackPatch {
                    rating: Some(track.rating.clamp(0, 5)),
                    ..TrackPatch::default()
                },
            ) {
                tracing::warn!("同步 OneLibrary 评分到本地曲目 {local_id} 失败：{error:#}");
            } else {
                changed_local_ids.push(local_id);
            }
        }
        if cover_changed {
            let cover = one_library_task({
                let device_path = device_path.clone();
                let content_id = track.content_id;
                move || crate::usb_library::one_library_cover(&device_path, content_id)
            })
            .await;
            if let Ok((data, _)) = cover {
                if let Err(error) = state.library.write_cover_to_file(local_id, &data) {
                    tracing::warn!("同步 OneLibrary 封面到本地曲目 {local_id} 失败：{error:#}");
                } else {
                    changed_local_ids.push(local_id);
                }
            }
        }
    }
    changed_local_ids.sort_unstable();
    changed_local_ids.dedup();
    if !changed_local_ids.is_empty() {
        state.hub.publish_library_updated(&changed_local_ids);
    }
    Ok(Json(tracks))
}

async fn one_library_playlist_tracks_reorder(
    AxumPath(id): AxumPath<i32>,
    Json(payload): Json<ReorderOneLibraryPlaylistTracksRequest>,
) -> ApiResult<Json<Vec<kdj_core::models::OneLibraryTrack>>> {
    let tracks = one_library_task(move || {
        crate::usb_library::reorder_one_library_playlist_tracks(
            &payload.device_path,
            id,
            payload.content_ids,
        )
    })
    .await?;
    Ok(Json(tracks))
}

async fn one_library_playlist_tracks_remove(
    AxumPath(id): AxumPath<i32>,
    Json(payload): Json<ReorderOneLibraryPlaylistTracksRequest>,
) -> ApiResult<Json<Vec<kdj_core::models::OneLibraryTrack>>> {
    let tracks = one_library_task(move || {
        crate::usb_library::remove_one_library_playlist_tracks(
            &payload.device_path,
            id,
            payload.content_ids,
        )
    })
    .await?;
    Ok(Json(tracks))
}

async fn one_library_track_rating(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i32>,
    Json(payload): Json<OneLibraryRatingRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let rating = payload.rating.clamp(0, 5);
    let local_track_id = one_library_task(move || {
        crate::usb_library::set_one_library_rating(&payload.device_path, id, rating)
    })
    .await?;
    if let Some(local_id) =
        local_track_id.filter(|local_id| state.library.get(*local_id).ok().flatten().is_some())
    {
        state.library.patch(
            local_id,
            &TrackPatch {
                rating: Some(i64::from(rating)),
                ..TrackPatch::default()
            },
        )?;
        state.hub.publish_library_updated(&[local_id]);
    }
    Ok(Json(json!({ "ok": true })))
}

async fn one_library_playlist_tracks_copy(
    Json(payload): Json<CopyOneLibraryPlaylistTracksRequest>,
) -> ApiResult<Json<Vec<kdj_core::models::OneLibraryTrack>>> {
    let tracks = one_library_task(move || {
        crate::usb_library::copy_one_library_playlist_tracks(
            &payload.source_device_path,
            payload.source_playlist_id,
            &payload.target_device_path,
            payload.target_playlist_id,
            payload.content_ids,
        )
    })
    .await?;
    Ok(Json(tracks))
}

async fn one_library_capacity(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<OneLibraryPlaylistTracksRequest>,
) -> ApiResult<Json<OneLibraryCapacityPlan>> {
    let mut seen = HashSet::new();
    let mut tracks = Vec::new();
    for track_id in payload.track_ids {
        if track_id <= 0 || !seen.insert(track_id) {
            continue;
        }
        tracks.push(
            state
                .library
                .get(track_id)?
                .ok_or_else(|| ApiError::not_found(format!("曲目不存在：{track_id}")))?,
        );
    }
    let device_path = payload.device_path;
    let plan = one_library_task(move || {
        crate::usb_library::one_library_capacity_plan(&device_path, &tracks)
    })
    .await?;
    Ok(Json(plan))
}

async fn one_library_import_tracks(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ImportOneLibraryTracksRequest>,
) -> ApiResult<Json<OneLibraryImportResult>> {
    let roots = require_roots(&state)?;
    let dest = kdj_library::folders::ensure_inside(Path::new(&payload.dest), &roots)?;
    if !dest.is_dir() {
        return Err(ApiError::bad_request("目标不是文件夹"));
    }
    let source_device_key = payload.device_path.clone();
    let source_tracks = one_library_task({
        let device_path = payload.device_path.clone();
        move || crate::usb_library::one_library_playlist_tracks(&device_path, payload.playlist_id)
    })
    .await?;
    let requested: HashSet<i32> = payload
        .content_ids
        .into_iter()
        .filter(|id| *id > 0)
        .collect();
    if requested.is_empty() {
        return Err(ApiError::bad_request("没有选中要导入的 OneLibrary 曲目"));
    }
    let library = state.library.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut track_ids = Vec::new();
        let mut errors = HashMap::new();
        let mut matched = HashSet::new();
        for track in source_tracks {
            if !requested.contains(&track.content_id) {
                continue;
            }
            matched.insert(track.content_id);
            let source = PathBuf::from(&track.path);
            let portable_metadata = PortableTrackMetadata::from(&track);
            let imported = (|| -> anyhow::Result<i64> {
                anyhow::ensure!(source.is_file(), "外置音频文件已丢失");
                let target = kdj_library::folders::copy_file(&source, &dest)?;
                let id = match library.upsert_file(
                    &target,
                    "onelibrary",
                    &format!("{}:{}", source_device_key, track.content_id),
                ) {
                    Ok(id) => id,
                    Err(error) => {
                        let _ = std::fs::remove_file(&target);
                        return Err(error);
                    }
                };
                if let Err(error) = library.apply_portable_metadata(id, &portable_metadata) {
                    // 元数据和文件必须作为一次导入出现；半成品记录不能冒充成功。
                    let _ = library.delete(id, FileDisposal::Keep);
                    let _ = std::fs::remove_file(&target);
                    return Err(error);
                }
                Ok(id)
            })();
            match imported {
                Ok(id) => track_ids.push(id),
                Err(error) => {
                    errors.insert(track.content_id.to_string(), format!("{error:#}"));
                }
            }
        }
        for missing in requested.difference(&matched) {
            errors.insert(missing.to_string(), "曲目不在来源 OneLibrary 列表中".into());
        }
        OneLibraryImportResult { track_ids, errors }
    })
    .await
    .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if !result.track_ids.is_empty() {
        state.hub.publish_library_updated(&result.track_ids);
    }
    Ok(Json(result))
}

async fn one_library_cover(Query(params): Query<OneLibraryCoverParams>) -> ApiResult<Response> {
    let (data, mime) = one_library_task(move || {
        crate::usb_library::one_library_cover(&params.device_path, params.content_id)
    })
    .await?;
    Ok((StatusCode::OK, cover_headers(mime), data).into_response())
}

async fn one_library_set_cover(
    State(state): State<Arc<AppState>>,
    Query(params): Query<OneLibraryCoverParams>,
    body: axum::body::Bytes,
) -> ApiResult<Json<serde_json::Value>> {
    if body.is_empty() {
        return Err(ApiError::bad_request("没有收到图片数据"));
    }
    let local_cover = body.clone();
    let local_track_id = one_library_task(move || {
        crate::usb_library::set_one_library_cover(&params.device_path, params.content_id, &body)
    })
    .await?;
    if let Some(local_id) =
        local_track_id.filter(|local_id| state.library.get(*local_id).ok().flatten().is_some())
    {
        state.library.write_cover_to_file(local_id, &local_cover)?;
        state.hub.publish_library_updated(&[local_id]);
    }
    Ok(Json(json!({ "ok": true })))
}

async fn one_library_waveform(
    State(state): State<Arc<AppState>>,
    Query(params): Query<OneLibraryWaveformParams>,
) -> ApiResult<Json<Waveform>> {
    if params.playback_id >= 0 {
        return Err(ApiError::bad_request("OneLibrary 播放 id 必须是负数"));
    }
    let file = one_library_task({
        let device_path = params.device_path.clone();
        move || crate::usb_library::one_library_content_file(&device_path, params.content_id)
    })
    .await?;
    let buckets = params.buckets.clamp(64, 2_000);
    let waveform = state
        .waveforms
        .get_or_compute_detached(
            file.cache_id,
            file.legacy_cache_id,
            file.path,
            buckets,
            state.config.data_dir.join("waveform-onelibrary"),
            file.portable_waveform_dir,
        )
        .await
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, format!("{error:#}")))?;
    let mut waveform = crate::waveform::fit_waveform_columns(waveform, buckets);
    waveform.track_id = params.playback_id;
    Ok(Json(waveform))
}

async fn library_devices() -> ApiResult<Json<Vec<RemovableDevice>>> {
    let devices = tokio::task::spawn_blocking(crate::usb_library::removable_devices)
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(devices))
}

#[derive(Debug, Default, Deserialize)]
struct AuthorizeRemovableDeviceRequest {
    #[serde(default)]
    path: String,
}

async fn library_device_authorize(
    Json(payload): Json<AuthorizeRemovableDeviceRequest>,
) -> ApiResult<Json<RemovableDevice>> {
    let device = tokio::task::spawn_blocking(move || {
        crate::usb_library::authorize_removable_device(&payload.path)
    })
    .await
    .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))??;
    Ok(Json(device))
}

async fn library_track(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<Json<Track>> {
    state
        .library
        .get(id)?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("曲目不存在"))
}

async fn library_lyrics(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<Json<LocalLyricsResponse>> {
    let track = state
        .library
        .get(id)?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    let stored = kdj_library::folders::read_lyrics(
        Path::new(&track.path),
        &track.source_platform,
        &track.source_key,
    )?
    .ok_or_else(|| ApiError::not_found("本地没有歌词"))?;
    Ok(Json(LocalLyricsResponse {
        lrc: stored.lrc,
        translated_lrc: stored.translated_lrc,
        romaji_lrc: stored.romaji_lrc,
    }))
}

async fn library_patch(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Json(payload): Json<TrackPatch>,
) -> ApiResult<Json<TrackPatchResult>> {
    let rating_to_sync = payload.rating.map(|rating| rating.clamp(0, 5) as i32);
    let track = state.library.patch(id, &payload)?;
    // 写回文件标签是尽力而为：文件只读、被 DJ 软件占着都是常事，
    // 让整次保存回滚的话用户白填一遍表单。数据库那份留着，把原因带回去自己判断。
    let tag_write_error = state
        .library
        .write_patch_to_file(id, &payload)
        .err()
        .map(|err| format!("{err:#}"));
    if let Some(reason) = &tag_write_error {
        tracing::warn!("曲目 {id} 写回文件标签失败：{reason}");
    }
    if let Some(rating) = rating_to_sync {
        if let Err(error) = one_library_task(move || {
            crate::usb_library::sync_local_rating_to_one_libraries(id, rating)
        })
        .await
        {
            tracing::warn!("同步本地评分到 OneLibrary 失败：{error:?}");
        }
    }
    state.hub.publish_library_updated(&[id]);
    Ok(Json(TrackPatchResult {
        track,
        tag_write_error,
    }))
}

#[derive(Deserialize)]
struct DeleteParams {
    #[serde(default)]
    delete_file: bool,
    /// 新三态："keep" / "trash" / "remove"。带它时优先于 delete_file；
    /// 不带时按老布尔翻译（true=remove），旧客户端行为一字不变。
    file: Option<String>,
}

/// "keep"/"trash"/"remove" → 处置方式。空串当 keep：批量端点的 serde(default)。
fn parse_disposal(name: &str) -> ApiResult<FileDisposal> {
    match name {
        "" | "keep" => Ok(FileDisposal::Keep),
        "trash" => Ok(FileDisposal::Trash),
        "remove" => Ok(FileDisposal::Remove),
        other => Err(ApiError::bad_request(format!(
            "file 只能是 keep/trash/remove，收到：{other}"
        ))),
    }
}

fn delete_undo_item(deleted: DeletedTrack) -> FolderUndoItem {
    let source = PathBuf::from(&deleted.track.path);
    FolderUndoItem {
        op: FolderUndoOp::Delete,
        track_id: deleted.track.id,
        source: source.clone(),
        target: PathBuf::new(),
        created_track_id: None,
        source_platform: deleted.track.source_platform.clone(),
        source_key: deleted.track.source_key.clone(),
        deleted: Some(deleted),
    }
}

fn finish_delete_undo(state: &AppState, items: Vec<FolderUndoItem>) -> FolderUndoStatus {
    if items.is_empty() {
        // 不可恢复的删除不能让 Cmd+Z 误撤回更早的复制/移动。
        state.clear_folder_undo();
        state.folder_undo_status()
    } else {
        state.push_folder_undo(FolderUndoBatch {
            op: FolderUndoOp::Delete,
            items,
        })
    }
}

async fn library_delete(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Query(params): Query<DeleteParams>,
) -> ApiResult<Json<serde_json::Value>> {
    let disposal = match &params.file {
        Some(name) => parse_disposal(name)?,
        None if params.delete_file => FileDisposal::Remove,
        None => FileDisposal::Keep,
    };
    let _operations = state.folder_operations.lock().unwrap();
    // 删不存在的曲目要 404：回 200 + {"ok": false} 的话前端会当成删成功，
    // 把那一行从列表里抹掉，刷新之后它又回来了
    let (removed, deleted) = if disposal == FileDisposal::Remove {
        (state.library.delete(id, disposal)?, None)
    } else {
        state.library.delete_for_undo(id, disposal)?
    };
    if !removed {
        return Err(ApiError::not_found("曲目不存在"));
    }
    let undo = finish_delete_undo(&state, deleted.into_iter().map(delete_undo_item).collect());
    state.hub.publish_library_updated(&[id]);
    Ok(Json(json!({ "ok": true, "undo": undo })))
}

#[derive(Deserialize)]
struct BatchDeleteRequest {
    track_ids: Vec<i64>,
    #[serde(default)]
    file: String,
}

/// 批量删除。多选删 50 首打 50 个请求会推 50 条 WS 事件、触发 50 轮防抖刷新，
/// 收成一个端点就是一条事件一次刷新。
/// 单条失败不中断整批（比如某个文件进不了回收站）：删曲目是逐条独立的操作，
/// 一颗坏文件不该把其余 49 首都挡回去；失败的连库记录一起原样留着，逐条报因。
async fn library_delete_batch(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<BatchDeleteRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let disposal = parse_disposal(&payload.file)?;
    let _operations = state.folder_operations.lock().unwrap();
    let mut removed: Vec<i64> = Vec::new();
    let mut undo_items = Vec::new();
    let mut changed = false;
    let mut errors = serde_json::Map::new();
    for id in payload.track_ids {
        let result = if disposal == FileDisposal::Remove {
            Ok((state.library.delete(id, disposal)?, None))
        } else {
            state.library.delete_for_undo(id, disposal)
        };
        match result {
            Ok((true, deleted)) => {
                removed.push(id);
                changed = true;
                if let Some(deleted) = deleted {
                    undo_items.push(delete_undo_item(deleted));
                }
            }
            Ok((false, _)) => {
                // false=库里本来就没有：目的已达成，不算失败，保持旧批量接口语义
                removed.push(id);
            }
            Err(err) => {
                errors.insert(id.to_string(), json!(format!("{err:#}")));
            }
        }
    }
    let undo = if changed {
        finish_delete_undo(&state, undo_items)
    } else {
        state.folder_undo_status()
    };
    if !removed.is_empty() {
        state.hub.publish_library_updated(&removed);
    }
    Ok(Json(
        json!({ "removed": removed.len(), "errors": errors, "undo": undo }),
    ))
}

async fn write_tags(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<Json<Track>> {
    let track = state
        .library
        .get(id)?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    kdj_providers::tags::write_analysis_tags(
        Path::new(&track.path),
        track.bpm,
        &track.camelot,
        &track.music_key,
        track.energy,
        &track.comment,
    )?;
    Ok(Json(track))
}

/// 反方向：把文件里现存的标签读回库里。
///
/// 覆盖规则、mtime 归零那些事全在 `reread_tags_from_file` 里，这里不重复一遍——
/// 那套规则必须和增量导入共用同一份实现，抄到路由层迟早会跑偏。
///
/// 读完要 `publish_library_updated`：曲目详情面板是靠这条事件回刷的，
/// 少了它用户点完「重读标签」得手动切走再切回来才看得见新值。
async fn reread_tags(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<Json<Track>> {
    let track = state.library.reread_tags_from_file(id)?;
    state.hub.publish_library_updated(&[id]);
    Ok(Json(track))
}

async fn library_stats(State(state): State<Arc<AppState>>) -> ApiResult<Json<LibraryStats>> {
    Ok(Json(state.library.stats()?))
}

#[derive(Deserialize)]
struct HarmonicParams {
    /// 默认容差从 ±6 放宽到 ±12 BPM：±6 在 128 BPM 上不到 5%，
    /// 而现场 pitch 推 ±6% 是常规操作，卡在 ±6 会白白滤掉一大半能接的曲子。
    #[serde(default = "default_tolerance")]
    bpm_tolerance: f64,
    #[serde(default = "default_harmonic_limit")]
    limit: usize,
    /// 放宽的关系集（相对小调、两步等）。默认开。
    #[serde(default = "default_true")]
    wide: bool,
    /// 只在这个文件夹（含子级）里接。空 = 全库。
    #[serde(default)]
    folder: String,
}
fn default_tolerance() -> f64 {
    12.0
}
fn default_harmonic_limit() -> usize {
    60
}
fn default_true() -> bool {
    true
}

/// 检查更新：问 GitHub 最新 Release，回「有没有更新 + 下载页」。
///
/// 走后端而不是让前端直接 fetch GitHub：省掉 CSP connect-src 白名单
/// 和安卓 WebView 的证书链差异，浏览器/桌面/安卓三个壳同一条路。
/// 版本号取本 crate 的（workspace 统一版本，发版脚本和 tauri.conf.json 同步涨）。
async fn update_check() -> ApiResult<Json<kdj_providers::update::UpdateInfo>> {
    Ok(Json(
        kdj_providers::update::check(env!("CARGO_PKG_VERSION")).await?,
    ))
}

async fn library_harmonic(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Query(params): Query<HarmonicParams>,
) -> ApiResult<Json<Vec<HarmonicMatch>>> {
    // 曲目不存在和"这首没有调号所以没有推荐"是两回事，前者必须 404，
    // 否则前端只会看到一张空列表，分不清是没歌还是这首被删了
    if state.library.get(id)?.is_none() {
        return Err(ApiError::not_found("曲目不存在"));
    }
    Ok(Json(state.library.harmonic_matches(
        id,
        params.bpm_tolerance,
        // limit=0 会一首都不返回，几千的 limit 又会把整库塞给前端
        params.limit.clamp(1, 200),
        params.wide,
        // 「接下一首」的范围开关：空 = 全库，非空 = 只在这个文件夹（含子级）里接
        &params.folder,
    )?))
}

// ---------------------------------------------------------------- 文件夹

/// 定曲库根目录，并决定要不要把反推结果写回设置。
///
/// 返回 `(根目录, 要写回设置的目录列表)`；第二项是 `Some` 才动设置。
///
/// **反推只在设置里一个目录都没配的时候做**（和 v0.1.0 的 `if config.library_dirs: return`
/// 一致）。判据不能换成"解析出来的根为空"：外置硬盘没插时配好的目录同样解析不出来，
/// 那时反推会把用户配的目录直接顶掉，硬盘插回去也回不来了。
fn pick_library_roots(
    configured: &[String],
    track_paths: impl FnOnce() -> Vec<String>,
) -> (Vec<PathBuf>, Option<Vec<String>>) {
    if !configured.is_empty() {
        return (kdj_library::folders::resolve_roots(configured), None);
    }
    // 没配曲库目录时从已入库路径反推，否则文件夹树一片空白而歌明明都在。
    //
    // 反推出来的结果要**写回设置**：不写回的话设置页永远显示"还没有曲库目录"，
    // 而文件夹树里歌都在，用户只能自己再加一遍同一个目录。
    let inferred = kdj_library::folders::infer_roots(&track_paths());
    if inferred.is_empty() {
        return (inferred, None);
    }
    let dirs: Vec<String> = inferred
        .iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect();
    (inferred, Some(dirs))
}

fn library_roots(state: &AppState) -> Vec<PathBuf> {
    let mut settings = state.config.to_settings();
    let (roots, adopt) = pick_library_roots(&settings.library_dirs, || {
        state.library.all_paths().unwrap_or_default()
    });
    if let Some(dirs) = adopt {
        tracing::info!("从已入库路径反推曲库根目录：{dirs:?}");
        settings.library_dirs = dirs;
        state.config.apply_settings(settings);
    }
    roots
}

/// 会改动文件系统的文件夹操作都要先有根目录。
///
/// 没有根就没有"界内/界外"可言，`ensure_inside` 会一律拒绝，
/// 报出来的是"目标目录不在曲库范围内"——真正的原因却是根本没配曲库目录。
fn require_roots(state: &AppState) -> ApiResult<Vec<PathBuf>> {
    let roots = library_roots(state);
    if roots.is_empty() {
        return Err(ApiError::bad_request("还没有配置曲库目录，去设置里加一个"));
    }
    Ok(roots)
}

/// 校验下载目标文件夹：空串放行；非空必须是曲库根内的真实目录。
fn normalize_dest_dir(state: &AppState, raw: &str) -> ApiResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let roots = require_roots(state)?;
    let dest = kdj_library::folders::ensure_inside(Path::new(trimmed), &roots)?;
    if !dest.is_dir() {
        return Err(ApiError::bad_request("目标不是文件夹"));
    }
    Ok(dest.to_string_lossy().into_owned())
}

fn folder_tree(state: &AppState) -> ApiResult<FolderTree> {
    let paths = state.library.all_paths()?;
    let roots: Vec<String> = library_roots(state)
        .into_iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect();
    Ok(kdj_library::folders::build_tree(&roots, &paths))
}

async fn library_folders(State(state): State<Arc<AppState>>) -> ApiResult<Json<FolderTree>> {
    Ok(Json(folder_tree(&state)?))
}

async fn folder_create(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderCreateRequest>,
) -> ApiResult<Json<FolderTree>> {
    kdj_library::folders::create_folder(
        Path::new(&payload.parent),
        &payload.name,
        &require_roots(&state)?,
    )?;
    Ok(Json(folder_tree(&state)?))
}

async fn folder_rename(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderRenameRequest>,
) -> ApiResult<Json<FolderTree>> {
    let roots = require_roots(&state)?;
    // 归一化之后再拿去 rebase：请求里可能带 `~` 或结尾的斜杠，
    // 而库里存的是归一化路径，对不上就一首都改不到
    let source = kdj_library::folders::ensure_inside(Path::new(&payload.path), &roots)?;
    let target = kdj_library::folders::rename_folder(&source, &payload.name, &roots)?;
    // 目录改名后库里的 path 要跟着改，否则整批曲目会变成"文件不存在"
    let ids = state.library.rebase_paths(&source, &target)?;
    state.hub.publish_library_updated(&ids);
    Ok(Json(folder_tree(&state)?))
}

async fn folder_delete(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderDeleteRequest>,
) -> ApiResult<Json<FolderTree>> {
    kdj_library::folders::delete_folder(Path::new(&payload.path), &require_roots(&state)?)?;
    Ok(Json(folder_tree(&state)?))
}

/// 从软件里移出文件夹：库记录摘掉、曲库根注销，磁盘文件一字不动。
///
/// 根目录：从 `library_dirs` 拿掉，下面的歌全部移出曲库。
/// 子目录：只移出该目录（含子级）下的曲目，文件夹树里那个空壳还在——
/// 因为文件夹模式认的是磁盘真实目录，不是虚拟分组。
async fn folder_forget(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderForgetRequest>,
) -> ApiResult<Json<FolderForgetResult>> {
    let roots = require_roots(&state)?;
    let target = kdj_library::folders::ensure_inside(Path::new(&payload.path), &roots)?;
    let removed_ids = state.library.forget_under(&target)?;
    // 恰好是某个曲库根（或设置里登记在它底下的子根）才注销；
    // 普通子目录只摘曲目，不改 library_dirs。
    let mut settings = state.config.to_settings();
    let next_roots = unregister_library_roots(&settings.library_dirs, &target);
    if next_roots != settings.library_dirs {
        // 下载目录还指着刚移出的根时，改指到剩下的第一个曲库根；
        // 一个都不剩就原样留着——下载栏仍能显示路径，用户自己换。
        let forgotten = target.to_string_lossy();
        let fallback = next_roots.first().cloned();
        if path_equals_or_within(&settings.download_dir, &forgotten) {
            if let Some(dir) = fallback.clone() {
                settings.download_dir = dir;
            }
        }
        if path_equals_or_within(&settings.video_download_dir, &forgotten) {
            if let Some(dir) = fallback {
                settings.video_download_dir = dir;
            }
        }
        settings.library_dirs = next_roots;
        state.config.apply_settings(settings);
        state.sync_provider_context();
    }
    if !removed_ids.is_empty() {
        state.hub.publish_library_updated(&removed_ids);
    }
    Ok(Json(FolderForgetResult {
        removed: removed_ids.len(),
        tree: folder_tree(&state)?,
    }))
}

/// `candidate` 是否就是 `root`，或落在它下面。两边都按库里同一套归一化比。
fn path_equals_or_within(candidate: &str, root: &str) -> bool {
    let raw = candidate.trim();
    if raw.is_empty() {
        return false;
    }
    let candidate = PathBuf::from(kdj_library::service::normalize_path(Path::new(raw)));
    let root = PathBuf::from(kdj_library::service::normalize_path(Path::new(root)));
    kdj_core::paths::is_within(&root, &candidate)
}

/// 从曲库根列表里拿掉 `target` 本身，以及登记在它下面的子路径。
fn unregister_library_roots(existing: &[String], target: &Path) -> Vec<String> {
    let target = PathBuf::from(kdj_library::service::normalize_path(target));
    existing
        .iter()
        .filter(|item| {
            let path = PathBuf::from(kdj_library::service::normalize_path(Path::new(item)));
            !kdj_core::paths::is_within(&target, &path)
        })
        .cloned()
        .collect()
}

async fn folder_init(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderInitRequest>,
) -> ApiResult<Json<FolderTree>> {
    let roots = require_roots(&state)?;
    let targets: Vec<PathBuf> = if payload.path.trim().is_empty() {
        roots.clone()
    } else {
        // 越界检查不能省：这条接口会往目标目录里写 .kdj/manifest.json
        vec![kdj_library::folders::ensure_inside(
            Path::new(payload.path.trim()),
            &roots,
        )?]
    };
    for target in targets {
        kdj_library::folders::init_manifests(&target, &roots)?;
    }
    Ok(Json(folder_tree(&state)?))
}

/// 启动旧文件夹清单升级。请求本身立即返回；进度统一走活动栏事件。
async fn folder_upgrade(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let job_id = crate::jobs::spawn_folder_manifest_upgrade(state);
    Json(json!({ "job_id": job_id }))
}

/// 给旧版本曲库补齐固定波形；和文件夹迁移一样只返回任务 id。
async fn waveform_upgrade(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let job_id = crate::jobs::spawn_waveform_backfill(state);
    Json(json!({ "job_id": job_id }))
}

async fn folder_move(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderMoveRequest>,
) -> ApiResult<Json<FolderTree>> {
    let (old, new) = kdj_library::folders::move_folder(
        Path::new(&payload.path),
        Path::new(&payload.dest_parent),
        &require_roots(&state)?,
    )?;
    // 拖回原地时 old == new，rebase 一遍纯属白写库
    if old != new {
        let ids = state.library.rebase_paths(&old, &new)?;
        state.hub.publish_library_updated(&ids);
    }
    Ok(Json(folder_tree(&state)?))
}

/// 合并写清单：同一份 `.kdj/manifest.json` 里既有子目录名（文件夹树的顺序）
/// 也有文件名（曲目手排）。拖文件夹时提交的是目录名、拖曲目时提交的是文件名，
/// **整份覆盖会把另一类的顺序抹掉**——排好的 set 顺序会在拖一次文件夹之后消失。
///
/// 规则：没被这次提交涉及的名字按原相对顺序放前面。目录和文件从不在同一个
/// 列表里渲染，两类之间的先后无所谓。
fn merge_manifest_order(existing: &[String], submitted: &[String]) -> Vec<String> {
    let submitted: Vec<String> = submitted
        .iter()
        .filter(|name| !name.is_empty())
        .cloned()
        .collect();
    let touched: std::collections::HashSet<&str> = submitted.iter().map(String::as_str).collect();
    let mut merged: Vec<String> = existing
        .iter()
        .filter(|name| !touched.contains(name.as_str()))
        .cloned()
        .collect();
    merged.extend(submitted);
    merged
}

async fn folder_order(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderOrderRequest>,
) -> ApiResult<Json<FolderTree>> {
    let target =
        kdj_library::folders::ensure_inside(Path::new(&payload.path), &require_roots(&state)?)?;
    if !target.is_dir() {
        return Err(ApiError::bad_request("文件夹不存在"));
    }
    let existing = kdj_library::folders::read_manifest_order(&target);
    kdj_library::folders::write_manifest(
        &target,
        &merge_manifest_order(&existing, &payload.names),
    )?;
    Ok(Json(folder_tree(&state)?))
}

async fn folder_undo_status(State(state): State<Arc<AppState>>) -> Json<FolderUndoStatus> {
    Json(state.folder_undo_status())
}

/// 撤回最近一次成功的曲目复制/移动/删除批次。
///
/// 每个条目在执行前都校验路径/曲目身份，避免把用户后来放进去的
/// 同名文件误删。批次允许部分撤回，失败项会留在栈顶等待用户处理。
async fn folder_undo(State(state): State<Arc<AppState>>) -> ApiResult<Json<FolderUndoResponse>> {
    let _operations = state.folder_operations.lock().unwrap();
    let mut stack = state.folder_undo.lock().unwrap();
    let Some(batch) = stack.back().cloned() else {
        return Err(ApiError::not_found("没有可撤回的曲库操作"));
    };

    let mut remaining = Vec::new();
    let mut changed_ids = Vec::new();
    let mut errors = BTreeMap::new();
    let mut undone = 0usize;
    for (index, item) in batch.items.iter().enumerate().rev() {
        match undo_folder_item(&state, item) {
            Ok(ids) => {
                changed_ids.extend(ids);
                undone += 1;
            }
            Err(err) => {
                errors.insert(format!("{}:{index}", item.track_id), format!("{err:#}"));
                remaining.push(item.clone());
            }
        }
    }
    remaining.reverse();

    if remaining.is_empty() {
        stack.pop_back();
    } else if let Some(last) = stack.back_mut() {
        last.items = remaining;
    }
    changed_ids.sort_unstable();
    changed_ids.dedup();
    if !changed_ids.is_empty() {
        state.hub.publish_library_updated(&changed_ids);
    }

    let status = stack
        .back()
        .map(|next| FolderUndoStatus {
            available: !next.items.is_empty(),
            op: Some(next.op),
            count: next.items.len(),
        })
        .unwrap_or_default();
    Ok(Json(FolderUndoResponse {
        undone,
        track_ids: changed_ids,
        op: batch.op,
        status,
        errors,
    }))
}

fn undo_folder_item(state: &AppState, item: &FolderUndoItem) -> anyhow::Result<Vec<i64>> {
    match item.op {
        FolderUndoOp::Delete => {
            let deleted = item
                .deleted
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("删除撤回缺少曲目快照：{}", item.track_id))?;
            state.library.restore_deleted(deleted)?;
            Ok(vec![item.track_id])
        }
        FolderUndoOp::Move => {
            anyhow::ensure!(
                item.target.is_file(),
                "撤回目标文件不存在：{}",
                item.target.display()
            );
            let Some(track) = state.library.get(item.track_id)? else {
                anyhow::bail!("移动曲目记录不存在：{}", item.track_id);
            };
            anyhow::ensure!(
                kdj_library::service::normalize_path(Path::new(&track.path))
                    == kdj_library::service::normalize_path(&item.target),
                "移动曲目路径已变化，拒绝覆盖：{}",
                item.target.display()
            );
            anyhow::ensure!(
                !item.source.exists(),
                "原文件位置已有文件，未覆盖：{}",
                item.source.display()
            );
            let parent = item
                .source
                .parent()
                .ok_or_else(|| anyhow::anyhow!("原文件没有父目录：{}", item.source.display()))?;
            anyhow::ensure!(parent.is_dir(), "原文件夹不存在：{}", parent.display());
            let restored = kdj_library::folders::move_file(&item.target, parent)?;
            if let Err(err) = kdj_library::folders::move_lyrics(
                &item.target,
                &restored,
                &item.source_platform,
                &item.source_key,
            ) {
                tracing::warn!("撤回移动歌词失败 {}：{err:#}", restored.display());
            }
            state.library.relocate(item.track_id, &restored)?;
            Ok(vec![item.track_id])
        }
        FolderUndoOp::Copy => {
            anyhow::ensure!(
                item.target.is_file(),
                "撤回目标文件不存在：{}",
                item.target.display()
            );
            let new_id = item
                .created_track_id
                .ok_or_else(|| anyhow::anyhow!("复制操作缺少新曲目记录"))?;
            let Some(track) = state.library.get(new_id)? else {
                anyhow::bail!("复制出来的曲目记录不存在：{new_id}");
            };
            anyhow::ensure!(
                kdj_library::service::normalize_path(Path::new(&track.path))
                    == kdj_library::service::normalize_path(&item.target),
                "复制目标已被重新登记，拒绝删除：{}",
                item.target.display()
            );
            kdj_library::folders::remove_lyrics(
                &item.target,
                &item.source_platform,
                &item.source_key,
            )?;
            anyhow::ensure!(
                state.library.delete(new_id, FileDisposal::Remove)?,
                "复制出来的曲目已不存在：{new_id}"
            );
            Ok(vec![new_id])
        }
    }
}

async fn folder_apply(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderOpRequest>,
) -> ApiResult<Json<FolderOpResult>> {
    let roots = require_roots(&state)?;
    let dest = kdj_library::folders::ensure_inside(Path::new(&payload.dest), &roots)?;
    if !dest.is_dir() {
        return Err(ApiError::bad_request("目标不是文件夹"));
    }
    let _operations = state.folder_operations.lock().unwrap();

    let mut track_ids = Vec::new();
    let mut methods: BTreeMap<String, i64> = BTreeMap::new();
    let mut errors: BTreeMap<String, String> = BTreeMap::new();
    let mut undo_items = Vec::new();

    for id in &payload.track_ids {
        let Some(track) = state.library.get(*id)? else {
            errors.insert(id.to_string(), "曲目不存在".into());
            continue;
        };
        let source = PathBuf::from(&track.path);
        if !source.is_file() {
            errors.insert(id.to_string(), "文件已丢失".into());
            continue;
        }
        // 拖回原地：静默跳过，不算错误也不算改动
        if source.parent() == Some(dest.as_path()) {
            continue;
        }
        match payload.op {
            FileOp::Move => match kdj_library::folders::move_file(&source, &dest) {
                Ok(target) => {
                    if let Err(err) = kdj_library::folders::move_lyrics(
                        &source,
                        &target,
                        &track.source_platform,
                        &track.source_key,
                    ) {
                        tracing::warn!("移动歌词失败 {}：{err:#}", target.display());
                    }
                    state.library.relocate(*id, &target)?;
                    track_ids.push(*id);
                    undo_items.push(FolderUndoItem {
                        op: FolderUndoOp::Move,
                        track_id: *id,
                        source: source.clone(),
                        target: target.clone(),
                        created_track_id: None,
                        source_platform: track.source_platform.clone(),
                        source_key: track.source_key.clone(),
                        deleted: None,
                    });
                    *methods.entry("move".into()).or_insert(0) += 1;
                }
                Err(err) => {
                    errors.insert(id.to_string(), format!("{err:#}"));
                }
            },
            FileOp::Copy => match kdj_library::folders::copy_file(&source, &dest) {
                Ok(target) => {
                    if let Err(err) = kdj_library::folders::copy_lyrics(
                        &source,
                        &target,
                        &track.source_platform,
                        &track.source_key,
                    ) {
                        tracing::warn!("复制歌词失败 {}：{err:#}", target.display());
                    }
                    match state.library.upsert_file(
                        &target,
                        &track.source_platform,
                        &track.source_key,
                    ) {
                        Ok(new_id) => {
                            state.library.clone_metadata(*id, new_id)?;
                            track_ids.push(new_id);
                            undo_items.push(FolderUndoItem {
                                op: FolderUndoOp::Copy,
                                track_id: *id,
                                source: source.clone(),
                                target: target.clone(),
                                created_track_id: Some(new_id),
                                source_platform: track.source_platform.clone(),
                                source_key: track.source_key.clone(),
                                deleted: None,
                            });
                            *methods.entry("copy".into()).or_insert(0) += 1;
                        }
                        Err(err) => {
                            errors.insert(id.to_string(), format!("{err:#}"));
                        }
                    }
                }
                Err(err) => {
                    errors.insert(id.to_string(), format!("{err:#}"));
                }
            },
        }
    }

    // 一条都没动时不发事件：白发一条 library.updated 会让前端整表刷一次
    if !track_ids.is_empty() {
        state.hub.publish_library_updated(&track_ids);
    }
    let undo = if undo_items.is_empty() {
        state.folder_undo_status()
    } else {
        state.push_folder_undo(FolderUndoBatch {
            op: match payload.op {
                FileOp::Move => FolderUndoOp::Move,
                FileOp::Copy => FolderUndoOp::Copy,
            },
            items: undo_items,
        })
    };
    Ok(Json(FolderOpResult {
        track_ids,
        op: payload.op,
        methods,
        errors,
        undo,
    }))
}

// ---------------------------------------------------------------- 扫描 / 分析

/// 把显式传进来的目录登记成曲库根目录。
///
/// 不登记的话，用户「添加文件夹」加进来的歌在文件夹树里一个都看不见
/// （树只认 `library_dirs`），还得再去设置里把同一个目录加第二遍——
/// 而「添加文件夹」的语义就是一步到位，不该留这种尾巴。
///
/// 但**已经落在某个根下面的子目录不登记**：文件夹树里点一个子目录也会触发扫描
/// （未入库的自动导入），每次都登记的话那个子目录会同时以"根"和"某根的子节点"
/// 两个身份出现在树上，看着像凭空多出来一份。
fn merge_library_roots(existing: &[String], paths: &[String]) -> Vec<String> {
    let mut roots = kdj_library::folders::resolve_roots(existing);
    let mut merged = existing.to_vec();
    for item in paths {
        let candidate = kdj_core::config::expand_user(item);
        if !candidate.is_dir() {
            continue;
        }
        if kdj_library::folders::ensure_inside(&candidate, &roots).is_ok() {
            continue; // 已经在某个根里
        }
        let normalized = candidate.to_string_lossy().into_owned();
        if !merged.contains(&normalized) {
            merged.push(normalized);
            // 新根可能把后面某个候选包住，重算一遍再判断下一个
            roots = kdj_library::folders::resolve_roots(&merged);
        }
    }
    merged
}

fn register_library_roots(state: &AppState, paths: &[String]) {
    let mut settings = state.config.to_settings();
    let merged = merge_library_roots(&settings.library_dirs, paths);
    if merged != settings.library_dirs {
        settings.library_dirs = merged;
        state.config.apply_settings(settings);
    }
}

async fn library_scan(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ScanRequest>,
) -> ApiResult<Json<ScanResponse>> {
    // 空串要滤掉：前端的目录选择器取消时会塞一个空字符串进来，
    // 留着它等于"扫描当前工作目录"
    let requested: Vec<String> = payload
        .paths
        .iter()
        .filter(|item| !item.trim().is_empty())
        .cloned()
        .collect();
    // 不传路径就扫全部曲库根
    let paths = if requested.is_empty() {
        library_roots(&state)
            .into_iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect()
    } else {
        register_library_roots(&state, &requested);
        requested
    };
    if paths.is_empty() {
        // 既没给目录、也没有曲库根，起个任务也是扫 0 个文件，不如直接说清楚。
        // 措辞不提"扫描"：界面上这条路径只有「添加文件夹」一个入口，
        // 冒出一个用户没听说过的词只会让他不知道自己刚才操作的是什么
        // （参照实现在这里回的是"没有可扫描的目录"，状态码/时机保持一致）。
        return Err(ApiError::bad_request("没有可添加的目录"));
    }
    let job_id = crate::jobs::spawn_scan(state.clone(), paths, payload.recursive, payload.analyze);
    // `found` 恒为 0，真实数量走 `scan.progress` 的第一条事件（它已经带着总数）。
    // 在这里先 collect_files 一遍拿准数看着更漂亮，代价是把整棵目录树**同步**走一遍：
    // 大目录要几十秒，HTTP 请求会被拖到超时，而且那是在 async 执行器上做阻塞 IO。
    // v0.1.0 就是为了这个才立刻返回的。
    Ok(Json(ScanResponse { job_id, found: 0 }))
}

async fn library_analyze(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AnalyzeRequest>,
) -> ApiResult<Json<AnalyzeResponse>> {
    let pending = match payload.version {
        kdj_core::models::AnalysisVersion::V1 => state
            .library
            .pending_analysis_ids(payload.track_ids.as_deref(), payload.force)?,
        kdj_core::models::AnalysisVersion::V2 => state.library.pending_bpm_key_analysis_v2_ids(
            payload.track_ids.as_deref(),
            payload.force,
            payload.limit,
            Some(&payload.folder),
        )?,
    };
    let queued = pending.len();
    // `priority` 必须透传：前端「放到一首还没分析的歌」就是靠它插队的，
    // 吞掉这个字段的话，那一首会跟着「停止分析」一起被掐掉（见 jobs.rs）
    let job_id = match payload.version {
        kdj_core::models::AnalysisVersion::V1 => {
            crate::jobs::spawn_analysis(state.clone(), pending, payload.priority)
        }
        kdj_core::models::AnalysisVersion::V2 => {
            crate::jobs::spawn_bpm_key_analysis_v2(state.clone(), pending)
        }
    };
    Ok(Json(AnalyzeResponse { job_id, queued }))
}

#[derive(Debug, Default, Deserialize)]
struct AnalyzeCancelParams {
    /// 前端停止按钮传的是它手里那个 job_id；不传（或传了个过期的）= 全停。
    #[serde(default)]
    job_id: String,
}

/// 停止分析。已经开始的那一首会跑完——半路掐断会在库里留下半写的行。
async fn library_analyze_cancel(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AnalyzeCancelParams>,
) -> Json<crate::jobs::CancelReport> {
    // 结果就在响应体里（canceled/remaining），前端就地展示；
    // 界面上早没有浮层通知了，这里不额外发事件
    Json(state.analysis.cancel(&params.job_id))
}

// ---------------------------------------------------------------- 媒体

/// 是不是视频容器。播放时不给 `<audio>` 塞整个视频文件（mkv 根本放不了），
/// 先用 ffmpeg 把音轨抽出来缓存成 m4a，再按普通音频伺服；封面也走视频那条路。
///
/// 后缀表用 `tags::VIDEO_EXTENSIONS` 那一份，不在这里再抄一遍：
/// 抄一份的下场是扫描认得的格式和播放认得的格式慢慢对不上，
/// 表现成"这个文件进得了库但点了没声音"。
fn is_video_container(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    kdj_providers::tags::VIDEO_EXTENSIONS.contains(&ext.as_str())
}

/// 缓存键里的文件 mtime。文件被换掉（重新打了标签、换了个更好的版本）之后
/// 旧缓存必须自动作废，否则用户会一直看到旧封面 / 旧波形，还完全不知道怎么刷。
/// 读不到就当 0——最坏是这份缓存一直命中，比每次都重算强。
fn file_mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_secs())
        .unwrap_or(0)
}

/// 视频文件 → 音轨 m4a 缓存。remux（流拷贝）优先，编码不兼容再转码 AAC。
///
/// 缓存键带 mtime：文件被替换后旧缓存自动失效。半成品写 `.partial` 名，
/// ffmpeg 中断不会留下能被下次请求误用的坏文件。
async fn extracted_audio(path: &Path, track_id: i64, cache_dir: &Path) -> ApiResult<PathBuf> {
    let mtime = file_mtime(path);
    let target = cache_dir.join(format!("{track_id}-{mtime}.m4a"));
    if std::fs::metadata(&target)
        .map(|meta| meta.len() > 0)
        .unwrap_or(false)
    {
        return Ok(target);
    }
    if !kdj_providers::ffmpeg::available() {
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "系统里没有 ffmpeg，视频音轨播放不了",
        ));
    }
    std::fs::create_dir_all(cache_dir).map_err(|err| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("建缓存目录失败：{err}"),
        )
    })?;
    let tmp = cache_dir.join(format!("{track_id}-{mtime}.partial.m4a"));
    let log = cache_dir.join(format!("{track_id}-{mtime}.log"));
    let cancel = tokio_util::sync::CancellationToken::new();
    // webm/mkv 里常见 opus/vorbis，塞不进 m4a 容器，copy 会失败 → 第二轮转码
    for copy in [true, false] {
        let args = kdj_providers::ffmpeg::extract_audio_args(path, &tmp, copy, 0);
        if kdj_providers::ffmpeg::run(&args, &log, &cancel)
            .await
            .is_ok()
            && std::fs::metadata(&tmp)
                .map(|meta| meta.len() > 0)
                .unwrap_or(false)
        {
            let _ = std::fs::rename(&tmp, &target);
            let _ = std::fs::remove_file(&log);
            return Ok(target);
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "抽不出音轨（文件可能损坏或没有音频流）",
    ))
}

/// 音频流。**必须支持 Range**，否则播放器拖不动进度条。
async fn library_audio(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let track = state
        .library
        .get(id)?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    let mut path = PathBuf::from(&track.path);
    if !path.is_file() {
        return Err(ApiError::not_found("音频文件已丢失"));
    }
    if is_video_container(&path) {
        path = extracted_audio(&path, track.id, &state.config.data_dir.join("audio-cache")).await?;
    }
    let total = tokio::fs::metadata(&path)
        .await
        .map_err(|err| ApiError::not_found(format!("读不到音频文件：{err}")))?
        .len();
    let raw_range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        // 空的 Range 头等于没带，不能当成"不可满足"去回 416
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    audio_response(&path, total, mime_for(&path), raw_range.as_deref()).await
}

#[derive(Default, Deserialize)]
struct LibraryVideoParams {
    /// WebView 明确拒绝原文件后，转为所有平台都能解的 H.264/AAC MP4。
    #[serde(default)]
    compat: bool,
}

/// WebView 兼容视频缓存。普通 MP4/MOV 仍直接 Range 原文件；只有媒体元素明确报
/// NotSupportedError 后才走这里，避免每次播放都无谓重编码。
async fn compatible_video(path: &Path, track_id: i64, cache_dir: &Path) -> ApiResult<PathBuf> {
    use std::collections::HashMap;
    use std::sync::OnceLock;

    type CompatLocks = std::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>;
    static LOCKS: OnceLock<CompatLocks> = OnceLock::new();

    let mtime = file_mtime(path);
    let target = cache_dir.join(format!("{track_id}-{mtime}.mp4"));
    let lock = {
        let mut locks = LOCKS
            .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks
            .entry(target.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().await;
    if std::fs::metadata(&target)
        .map(|meta| meta.len() > 0)
        .unwrap_or(false)
    {
        return Ok(target);
    }
    if !kdj_providers::ffmpeg::available() {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "系统 WebView 不支持这个视频编码，且没有找到 FFmpeg 用于兼容转换",
        ));
    }
    std::fs::create_dir_all(cache_dir).map_err(|err| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("建立视频兼容缓存失败：{err}"),
        )
    })?;
    let tmp = cache_dir.join(format!("{track_id}-{mtime}.partial.mp4"));
    let log = cache_dir.join(format!("{track_id}-{mtime}.log"));
    let cancel = tokio_util::sync::CancellationToken::new();
    // 统一到 H.264/AAC + yuv420p，并把 moov 移到文件头；这是 WKWebView、Chromium
    // WebView 和系统画中画共同支持的最小交集。4K 素材降到 2160p，普通素材不放大。
    let args = kdj_providers::ffmpeg::mux_args(&[path.to_path_buf()], &tmp, true, 2160, 0);
    if let Err(err) = kdj_providers::ffmpeg::run(&args, &log, &cancel).await {
        let _ = std::fs::remove_file(&tmp);
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("视频兼容转换失败：{err}"),
        ));
    }
    if !std::fs::metadata(&tmp)
        .map(|meta| meta.len() > 0)
        .unwrap_or(false)
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "视频兼容转换没有产生有效文件",
        ));
    }
    std::fs::rename(&tmp, &target).map_err(|err| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("保存视频兼容缓存失败：{err}"),
        )
    })?;
    let _ = std::fs::remove_file(&log);
    Ok(target)
}

/// 本地视频流。默认 Range 原文件；WebView 不支持其容器/编码时由前端以
/// `compat=true` 重试，后端一次性生成通用 MP4 缓存。
async fn library_video(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Query(params): Query<LibraryVideoParams>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let track = state
        .library
        .get(id)?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    let mut path = PathBuf::from(&track.path);
    if !path.is_file() {
        return Err(ApiError::not_found("视频文件已丢失"));
    }
    if !is_video_container(&path) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "这不是视频曲目"));
    }
    if params.compat {
        path =
            compatible_video(&path, track.id, &state.config.data_dir.join("video-cache")).await?;
    }
    let total = tokio::fs::metadata(&path)
        .await
        .map_err(|err| ApiError::not_found(format!("读不到视频文件：{err}")))?
        .len();
    let raw_range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty());
    audio_response(&path, total, video_mime_for(&path), raw_range).await
}

/// 流式读的块大小。和 Python 版的 `STREAM_CHUNK` 一致。
const STREAM_CHUNK: usize = 256 * 1024;

/// 按 Range 头切一份响应出来。三种结果：整份 200 / 片段 206 / 不可满足 416。
///
/// **边读边发**，对齐 Python 版的 `_iter_file`：整份读进内存的话，一首 100 MB 的
/// flac 每被 seek 一次就要多占 100 MB——桌面上的表现是"拖一下进度条卡一下"，
/// 安卓上直接就是 OOM。DJ 的曲库里 flac 是常态，不是边角情况。
async fn audio_response(
    path: &Path,
    total: u64,
    mime: String,
    raw_range: Option<&str>,
) -> ApiResult<Response> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let mut headers: Vec<(header::HeaderName, String)> = vec![
        (header::CONTENT_TYPE, mime),
        (header::ACCEPT_RANGES, "bytes".to_string()),
        (header::CACHE_CONTROL, "no-store".to_string()),
    ];

    let (status, start, length) = match raw_range {
        None => (StatusCode::OK, 0, total),
        Some(raw_range) => {
            // 带了 Range 却不可满足：必须 416 并告知总长度。
            // 回一份完整的 200 会让播放器以为"这次 seek 成功了"，
            // 拿到的却是从头开始的数据——表现就是"进度条拖了等于没拖"
            let Some((start, end)) = parse_range(raw_range, total) else {
                return Ok((
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    [
                        (header::CONTENT_RANGE, format!("bytes */{total}")),
                        (header::ACCEPT_RANGES, "bytes".to_string()),
                    ],
                )
                    .into_response());
            };
            headers.push((
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total}"),
            ));
            (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
        }
    };
    headers.push((header::CONTENT_LENGTH, length.to_string()));

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|err| ApiError::not_found(format!("读不到音频文件：{err}")))?;
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|err| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("定位到 {start} 失败：{err}"),
                )
            })?;
    }
    let stream = tokio_util::io::ReaderStream::with_capacity(file.take(length), STREAM_CHUNK);

    let mut response = axum::body::Body::from_stream(stream).into_response();
    *response.status_mut() = status;
    for (name, value) in headers {
        // 头都是自己拼的字面量/数字，解析失败只可能是 mime 里混进了控制字符
        if let Ok(value) = axum::http::HeaderValue::from_str(&value) {
            response.headers_mut().insert(name, value);
        }
    }
    Ok(response)
}

/// `bytes=0-1023` / `bytes=1024-` / `bytes=-500`
fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    // 先 trim + 转小写，和 Python 版 `_parse_range` 的 `(header or "").strip().lower()` 一致。
    // RFC 7233 的 range unit 是大小写无关的，裸比 "bytes=" 会把 `Bytes=0-` 判成
    // 不可满足 → 416，表现是"某些播放器一拖进度条就报错"。
    let normalized = value.trim().to_ascii_lowercase();
    let spec = normalized.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start_text, end_text) = spec.split_once('-')?;
    let (start, end) = match (start_text.trim(), end_text.trim()) {
        // 后缀式：最后 N 字节
        ("", suffix) => {
            let length: u64 = suffix.parse().ok()?;
            (total.saturating_sub(length), total - 1)
        }
        (start, "") => (start.parse().ok()?, total - 1),
        (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.min(total - 1)),
    };
    (start <= end && start < total).then_some((start, end))
}

fn mime_for(path: &Path) -> String {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "m4a" | "mp4" | "aac" => "audio/mp4",
        "ogg" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn video_mime_for(path: &Path) -> String {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    }
    .to_string()
}

async fn library_cover(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<Response> {
    let track = state
        .library
        .get(id)?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    let path = PathBuf::from(&track.path);
    if let Some((data, mime)) = kdj_providers::tags::read_cover(&path) {
        return Ok((StatusCode::OK, cover_headers(mime), data).into_response());
    }
    // VJ 素材和 MV 是没有内嵌封面的，一律 404 的话曲库里那一批视频
    // 全是空白占位。抽一帧当封面——播放器就是这么做的。
    if is_video_container(&path) {
        if let Some(data) = video_cover(
            &path,
            track.id,
            track.duration,
            &state.config.data_dir.join("covers"),
        )
        .await
        {
            return Ok((StatusCode::OK, cover_headers(JPEG_MIME.into()), data).into_response());
        }
    }
    Err(ApiError::not_found("没有内嵌封面"))
}

const JPEG_MIME: &str = "image/jpeg";

/// 同时最多几个抽帧进程。曲库列表一屏几十行，滚一下就是几十个封面请求同时进来，
/// 不设闸等于一次 fork 出几十个视频解码进程，机器直接卡住（4K 素材尤其明显）。
/// 抽一帧本身很快，排队基本察觉不到，而且只有第一次要排——之后全走缓存。
static FRAME_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

/// 视频没有内嵌封面时抽一帧当封面，结果按 `(id, mtime)` 缓存到 `data/covers/`。
///
/// **任何一步失败都只返回 `None`**（上层照旧 404，前端显示占位图）。
/// 安卓上根本没有 ffmpeg，这条路径要是能冒出 500，整个曲库列表会红一片；
/// 抽不出封面本来也不是错误，只是"这首没有图"。
async fn video_cover(
    path: &Path,
    track_id: i64,
    duration: Option<f64>,
    cache_dir: &Path,
) -> Option<Vec<u8>> {
    let mtime = file_mtime(path);
    let target = cover_cache_file(cache_dir, track_id, mtime);
    if let Ok(data) = std::fs::read(&target) {
        if !data.is_empty() {
            return Some(data);
        }
    }
    if !kdj_providers::ffmpeg::available() {
        return None;
    }
    std::fs::create_dir_all(cache_dir).ok()?;
    let _slot = FRAME_SLOTS.acquire().await.ok()?;

    let cancel = tokio_util::sync::CancellationToken::new();
    let log = cache_dir.join(format!("{track_id}-{mtime}.log"));
    // 同一首歌可能被好几个请求同时撞上（列表和详情面板各要一次），
    // 半成品的文件名带上纳秒，免得两个进程往同一个文件里写出一份花的 JPEG
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.subsec_nanos())
        .unwrap_or(0);

    let mut best: Option<(PathBuf, Vec<u8>)> = None;
    for (index, at) in kdj_providers::ffmpeg::frame_positions(duration)
        .into_iter()
        .enumerate()
    {
        let tmp = cache_dir.join(format!("{track_id}-{mtime}-{nonce}-{index}.partial.jpg"));
        let extracted = kdj_providers::ffmpeg::extract_frame(path, &tmp, at, &log, &cancel)
            .await
            .is_ok();
        let data = extracted
            .then(|| std::fs::read(&tmp).ok())
            .flatten()
            .filter(|data| !data.is_empty());
        let Some(data) = data else {
            let _ = std::fs::remove_file(&tmp);
            continue;
        };
        let black = kdj_providers::ffmpeg::frame_is_mostly_black(&data);
        if black && best.is_some() {
            let _ = std::fs::remove_file(&tmp);
        } else if let Some((stale, _)) = best.replace((tmp, data)) {
            // 手上这张不黑，之前那张黑的可以扔了
            let _ = std::fs::remove_file(&stale);
        }
        // 全黑的先留着：后面的位置可能压根抽不出来（时长未知时会挪过文件末尾），
        // 那时候一张黑图仍然比 404 强
        if !black {
            break;
        }
    }
    let _ = std::fs::remove_file(&log);

    let (tmp, data) = best?;
    // 先写临时名再改名，中途被打断也不会在缓存里留下一个半截的 JPEG
    // 被下一次请求当成好图返回。改名失败不影响这次的结果，下次重抽一遍就是
    if std::fs::rename(&tmp, &target).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Some(data)
}

/// 抽帧封面的缓存文件名。带 mtime，文件换掉之后旧图自动作废。
fn cover_cache_file(cache_dir: &Path, track_id: i64, mtime: u64) -> PathBuf {
    cache_dir.join(format!("{track_id}-{mtime}.jpg"))
}

/// 封面的响应头。
///
/// 曲库列表每行都放缩略图，滚一屏就是几十个请求，不给缓存头的话每次滚回来
/// 都要重读文件、重解 tag，所以必须缓存。但**只缓存一小时**（和 Python 版一致）：
/// 曲目 id 不变而文件被换掉是很常见的（换了个更好的版本、重新打了标签），
/// 缓存一整天的话用户会看到一整天的旧封面，还完全不知道该怎么让它刷新。
fn cover_headers(mime: String) -> [(header::HeaderName, String); 2] {
    [
        (header::CONTENT_TYPE, mime),
        (header::CACHE_CONTROL, "private, max-age=3600".to_string()),
    ]
}

/// 换封面能收的最大图片。比这更大的多半是用户挑错了文件（原始 RAW / 长截图），
/// 而且整张要塞进音频容器，写进去每次读标签都得跟着搬一遍。
const COVER_MAX_BYTES: usize = 16 * 1024 * 1024;

/// `PUT /api/library/cover/{id}`：请求体就是图片二进制（JPEG / PNG）。
///
/// 不做 multipart：前端要么是 `<input type=file>` 的 File，要么是拖进来的 File，
/// 两者都能直接当 body 发，多包一层 form 只是白绕。
async fn library_set_cover(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    body: axum::body::Bytes,
) -> ApiResult<Json<Track>> {
    if body.is_empty() {
        return Err(ApiError::bad_request("没有收到图片数据"));
    }
    state.library.write_cover_to_file(id, &body)?;
    let one_library_cover = body.to_vec();
    if let Err(error) = one_library_task(move || {
        crate::usb_library::sync_local_cover_to_one_libraries(id, &one_library_cover)
    })
    .await
    {
        tracing::warn!("同步本地封面到 OneLibrary 失败：{error:?}");
    }
    let track = state
        .library
        .get(id)?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    state.hub.publish_library_updated(&[id]);
    Ok(Json(track))
}

#[derive(Deserialize)]
struct WaveformParams {
    #[serde(default = "default_buckets")]
    buckets: usize,
}
fn default_buckets() -> usize {
    640
}

/// 整轨彩色波形：每列一个高度 + 一个 RGB，前端直接一列一根柱子地画。
///
/// 结果按 `(id, buckets, mtime)` 缓存到 `data/waveform/`，第二次是秒开。
/// 未命中时走 [`crate::waveform::WaveformCoordinator`]：单飞 + 给分析让路。
async fn library_waveform(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Query(params): Query<WaveformParams>,
) -> ApiResult<Json<Waveform>> {
    let buckets = params.buckets.clamp(64, 2000);
    let track = state
        .library
        .get(id)?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    let path = PathBuf::from(&track.path);
    if !path.is_file() {
        return Err(ApiError::not_found("音频文件已丢失"));
    }

    let cache_dir = state.config.data_dir.join("waveform");
    let wave = state
        .waveforms
        .get_or_compute(id, path, buckets, cache_dir)
        .await
        .map_err(|err| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, format!("{err:#}")))?;
    Ok(Json(wave))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_library_http_database_tasks_are_serialized() {
        let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let peak = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            tasks.push(tokio::spawn(async move {
                one_library_task(move || {
                    let now = active.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    peak.fetch_max(now, std::sync::atomic::Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(15));
                    active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                })
                .await
                .unwrap();
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(peak.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn preview_refreshes_only_expired_or_denied_upstream_urls() {
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::GONE,
        ] {
            assert!(song_preview_url_needs_refresh(status));
        }
        for status in [
            StatusCode::OK,
            StatusCode::PARTIAL_CONTENT,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            assert!(!song_preview_url_needs_refresh(status));
        }
    }

    #[test]
    fn preview_cache_accepts_whole_and_resumable_ranges() {
        let mut whole = HeaderMap::new();
        whole.insert(header::CONTENT_LENGTH, "100".parse().unwrap());
        assert_eq!(
            preview_cache_segment(StatusCode::OK, &whole, 0).map(|segment| (
                segment.start,
                segment.end,
                segment.total
            )),
            Some((0, 99, 100))
        );

        let mut first = HeaderMap::new();
        first.insert(header::CONTENT_RANGE, "bytes 0-39/100".parse().unwrap());
        first.insert(header::CONTENT_LENGTH, "40".parse().unwrap());
        assert_eq!(
            preview_cache_segment(StatusCode::PARTIAL_CONTENT, &first, 0).map(|segment| (
                segment.start,
                segment.end,
                segment.total
            )),
            Some((0, 39, 100))
        );

        let mut rest = HeaderMap::new();
        rest.insert(header::CONTENT_RANGE, "bytes 40-99/100".parse().unwrap());
        rest.insert(header::CONTENT_LENGTH, "60".parse().unwrap());
        assert_eq!(
            preview_cache_segment(StatusCode::PARTIAL_CONTENT, &rest, 40).map(|segment| (
                segment.start,
                segment.end,
                segment.total
            )),
            Some((40, 99, 100))
        );
        assert!(preview_cache_segment(StatusCode::PARTIAL_CONTENT, &rest, 0).is_none());
        assert_eq!(
            preview_response_segment(StatusCode::PARTIAL_CONTENT, &rest)
                .map(|segment| segment.start),
            Some(40),
            "session tee trusts the actual CDN response offset"
        );
    }

    #[test]
    fn session_waveform_polling_is_not_gated_by_persistent_cache_settings() {
        // 这是协议语义，不是用户设置值：默认关闭持久缓存时，媒体代理仍会把同一
        // 响应旁路成会话前缀，因此前端必须在首次空快照后继续 poll。
        assert!(SONG_PREVIEW_SESSION_WAVEFORM_ENABLED);
    }

    #[tokio::test]
    async fn a_slow_or_failed_capture_never_backpressures_audio_chunks() {
        let (sender, receiver) = tokio::sync::mpsc::channel::<axum::body::Bytes>(1);
        let mut sender = Some(sender);
        // 不启动接收者，模拟闪存写入永久卡住。第一次填满有界队列，第二次必须
        // 同步放弃捕获；enqueue 没有 await，媒体 chunk 可立即继续下发。
        enqueue_preview_capture(&mut sender, &axum::body::Bytes::from_static(b"first"));
        assert!(sender.is_some());
        enqueue_preview_capture(&mut sender, &axum::body::Bytes::from_static(b"second"));
        assert!(sender.is_none());
        drop(receiver);

        let (closed_sender, closed_receiver) = tokio::sync::mpsc::channel::<axum::body::Bytes>(1);
        drop(closed_receiver);
        let mut closed_sender = Some(closed_sender);
        enqueue_preview_capture(
            &mut closed_sender,
            &axum::body::Bytes::from_static(b"still-audio"),
        );
        assert!(
            closed_sender.is_none(),
            "failed worker only disables the tee"
        );
    }

    #[test]
    fn preview_cache_rejects_explicit_non_audio_content() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            "text/html; charset=utf-8".parse().unwrap(),
        );
        assert!(preview_audio_mime(&headers, "audio/mpeg").is_none());
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        assert!(preview_audio_mime(&headers, "audio/mpeg").is_none());
        headers.insert(
            header::CONTENT_TYPE,
            "application/octet-stream".parse().unwrap(),
        );
        assert_eq!(
            preview_audio_mime(&headers, "audio/mpeg").as_deref(),
            Some("audio/mpeg")
        );
        assert!(looks_like_text_error_payload(b"  <!doctype html><html>"));
        assert!(!looks_like_text_error_payload(b"ID3\x04\0\0\0"));
    }

    #[test]
    fn range_parsing_covers_the_three_forms() {
        assert_eq!(parse_range("bytes=0-1023", 4096), Some((0, 1023)));
        assert_eq!(parse_range("bytes=1024-", 4096), Some((1024, 4095)));
        assert_eq!(parse_range("bytes=-500", 4096), Some((3596, 4095)));
    }

    #[test]
    fn the_range_unit_is_case_insensitive_and_may_be_padded() {
        // Python 版对整个头做 strip().lower() 之后才比 "bytes="。
        // 少了这一步，`Bytes=` / ` bytes=` 会被判成不可满足 → 416，
        // 播放器那边的表现是"一拖进度条就报错"
        assert_eq!(parse_range("Bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("BYTES=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("  bytes=0-9  ", 100), Some((0, 9)));
        // 但单位名本身写错还是要拒
        assert_eq!(parse_range("Items=0-9", 100), None);
    }

    #[test]
    fn range_end_is_clamped_to_the_file_length() {
        // 播放器经常请求一个超出末尾的 end，不能因此 500
        assert_eq!(parse_range("bytes=0-99999", 4096), Some((0, 4095)));
    }

    #[test]
    fn malformed_or_unsatisfiable_ranges_are_rejected() {
        assert_eq!(parse_range("bytes=5000-6000", 4096), None);
        assert_eq!(parse_range("items=0-10", 4096), None);
        assert_eq!(parse_range("bytes=abc", 4096), None);
        assert_eq!(parse_range("bytes=100-50", 4096), None, "start > end");
        assert_eq!(parse_range("bytes=0-10", 0), None, "空文件没有可用范围");
    }

    /// 写一份内容可辨认的样本文件（第 i 个字节 = i % 251），
    /// 这样"切出来的到底是不是那一段"能真的验，而不是只看长度对不对。
    fn sample_audio(name: &str, size: usize) -> PathBuf {
        let dir = scratch(name);
        let path = dir.join("a.mp3");
        let data: Vec<u8> = (0..size).map(|index| (index % 251) as u8).collect();
        std::fs::write(&path, data).unwrap();
        path
    }

    async fn body_bytes(response: Response) -> Vec<u8> {
        axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec()
    }

    #[tokio::test]
    async fn a_request_without_range_gets_the_whole_file() {
        let path = sample_audio("audio-full", 100);
        let response = audio_response(&path, 100, "audio/mpeg".into(), None)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers().clone();
        assert_eq!(headers[header::ACCEPT_RANGES], "bytes");
        assert_eq!(headers[header::CONTENT_LENGTH], "100");
        assert_eq!(headers[header::CONTENT_TYPE], "audio/mpeg");
        assert_eq!(body_bytes(response).await.len(), 100);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn a_satisfiable_range_gets_206_with_exactly_those_bytes() {
        // 只对 Content-Range 不够：seek 错位的话头是对的、字节是错的，
        // 表现是"拖到副歌放出来的是别处"
        let path = sample_audio("audio-range", 100);
        let response = audio_response(&path, 100, "audio/mpeg".into(), Some("bytes=10-19"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        let headers = response.headers().clone();
        assert_eq!(headers[header::CONTENT_RANGE], "bytes 10-19/100");
        assert_eq!(headers[header::CONTENT_LENGTH], "10");
        assert_eq!(body_bytes(response).await, (10u8..20).collect::<Vec<u8>>());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn an_open_ended_range_runs_to_the_end_of_the_file() {
        let path = sample_audio("audio-tail", 100);
        let response = audio_response(&path, 100, "audio/mpeg".into(), Some("bytes=90-"))
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 90-99/100");
        assert_eq!(body_bytes(response).await, (90u8..100).collect::<Vec<u8>>());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn an_unsatisfiable_range_gets_416_not_the_whole_file() {
        // 回 200 + 整份数据的话，播放器以为 seek 成功了，
        // 拿到的却是从头开始的字节——表现是"进度条拖了等于没拖"
        let path = sample_audio("audio-416", 100);
        let response = audio_response(&path, 100, "audio/mpeg".into(), Some("bytes=500-600"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */100");
        assert!(body_bytes(response).await.is_empty(), "416 不该带数据");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn a_large_file_is_streamed_not_slurped() {
        // 整份读进内存的写法在这条用例上会读满 4 MB 只为了发 10 字节。
        // 直接盯住"内存"没法在单测里断言，退而求其次盯住**字节正确**：
        // 只有真的 seek 过去才可能拿到这一段。
        let size = 4 * 1024 * 1024 + 7;
        let path = sample_audio("audio-big", size);
        let start = (size - 10) as u64;
        let response = audio_response(
            &path,
            size as u64,
            "audio/flac".into(),
            Some(&format!("bytes={start}-")),
        )
        .await
        .unwrap();
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "10");
        let expected: Vec<u8> = ((size - 10)..size).map(|i| (i % 251) as u8).collect();
        assert_eq!(body_bytes(response).await, expected);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn covers_are_cached_for_an_hour_not_a_day() {
        // 曲目 id 不变而文件被换掉很常见（换了个更好的版本、重打了标签）。
        // 缓存一整天的话用户会盯着旧封面一整天，还不知道怎么让它刷新。
        // 参照实现（sidecar/kdj/app.py::library_cover）就是 3600。
        let headers = cover_headers("image/jpeg".into());
        assert_eq!(headers[0].1, "image/jpeg");
        assert_eq!(headers[1].1, "private, max-age=3600");
    }

    #[test]
    fn online_cover_proxy_accepts_only_the_two_search_platforms() {
        let wyy = reqwest::Url::parse("https://p1.music.126.net/a.jpg").unwrap();
        let qqm = reqwest::Url::parse("https://y.qq.com/music/photo/a.jpg").unwrap();
        let other = reqwest::Url::parse("https://example.com/a.jpg").unwrap();
        assert!(cover_host_allowed(Platform::Wyy, &wyy));
        assert!(cover_host_allowed(Platform::Qqm, &qqm));
        assert!(!cover_host_allowed(Platform::Wyy, &qqm));
        assert!(!cover_host_allowed(Platform::Qqm, &other));
        assert!(!cover_host_allowed(Platform::Soundcloud, &other));
    }

    #[test]
    fn online_cover_proxy_checks_image_magic_bytes() {
        assert_eq!(
            sniff_remote_cover(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(sniff_remote_cover(b"\xff\xd8\xffrest"), Some("image/jpeg"));
        assert_eq!(sniff_remote_cover(b"not an image"), None);
    }

    #[test]
    fn video_containers_go_through_the_audio_extraction_path() {
        // mkv/webm 直接塞给 <audio> 是放不出来的，必须先抽音轨
        assert!(is_video_container(Path::new("a.mkv")));
        assert!(is_video_container(Path::new("a.MP4")));
        assert!(is_video_container(Path::new("a.webm")));
        assert!(!is_video_container(Path::new("a.flac")));
        assert!(!is_video_container(Path::new("a.m4a")));
    }

    #[test]
    fn unresolved_links_report_the_last_provider_error() {
        // 前端把 detail 原样贴在界面上，只说"无法识别"排查不了任何东西
        assert_eq!(unresolved_detail(""), "无法识别的链接");
        assert_eq!(
            unresolved_detail("分享链接已过期"),
            "无法识别的链接：分享链接已过期"
        );
    }

    #[test]
    fn reordering_folders_keeps_the_track_order_in_the_same_manifest() {
        // 同一份 .kdj/manifest.json 里既有目录名也有文件名：整份覆盖会把另一类抹掉，
        // 表现是"拖了一次文件夹，手排好的曲目顺序全没了"
        let existing = vec![
            "a.mp3".to_string(),
            "b.mp3".to_string(),
            "温州".to_string(),
            "杭州".to_string(),
        ];
        let merged = merge_manifest_order(&existing, &["杭州".into(), "温州".into()]);
        assert_eq!(merged, vec!["a.mp3", "b.mp3", "杭州", "温州"]);

        // 反过来拖曲目也一样，目录顺序要留着
        let merged = merge_manifest_order(&merged, &["b.mp3".into(), "a.mp3".into()]);
        assert_eq!(merged, vec!["杭州", "温州", "b.mp3", "a.mp3"]);
    }

    #[test]
    fn empty_names_are_dropped_from_the_manifest() {
        let merged = merge_manifest_order(&["a".into()], &["".into(), "b".into()]);
        assert_eq!(merged, vec!["a", "b"]);
    }

    #[test]
    fn video_requests_fall_back_to_the_configured_quality() {
        let mut settings = Settings::with_download_dir(Path::new("/tmp"));
        settings.video_max_height = 720;
        settings.video_transcode = true;

        let mut req = VideoDownloadRequest {
            bvid: "BV1".into(),
            max_height: 0,
            ..Default::default()
        };
        apply_video_defaults(&mut req, &settings);
        assert_eq!(req.max_height, 720, "0 = 没指定，跟随设置");
        assert!(req.transcode, "没显式要求转码时跟随设置");

        // 显式给了就以请求为准
        let mut req = VideoDownloadRequest {
            bvid: "BV1".into(),
            max_height: 1080,
            ..Default::default()
        };
        apply_video_defaults(&mut req, &settings);
        assert_eq!(req.max_height, 1080);
    }

    #[test]
    fn a_replaced_file_gets_a_different_cover_cache_name() {
        // 曲目 id 不变而文件被换掉很常见（剪了个新版本、重新压了一遍）。
        // 缓存名不带 mtime 的话用户会永远看到旧那一帧
        let dir = Path::new("/tmp/covers");
        let before = cover_cache_file(dir, 42, 1_700_000_000);
        let after = cover_cache_file(dir, 42, 1_700_000_999);
        assert_ne!(before, after);
        assert_eq!(before.file_name().unwrap(), "42-1700000000.jpg");
        // 不同曲目也不能撞
        assert_ne!(before, cover_cache_file(dir, 43, 1_700_000_000));
    }

    #[tokio::test]
    async fn a_file_that_cannot_be_read_as_video_degrades_to_no_cover() {
        // 没装 ffmpeg（安卓）、文件坏了、根本没有视频流——三种情况都得是
        // "这首没有图"而不是 500，否则曲库列表会红一片
        let base = scratch("cover-broken");
        let fake = base.join("broken.mp4");
        std::fs::write(&fake, b"this is not a video").unwrap();
        let cache = base.join("covers");

        let cover = video_cover(&fake, 1, Some(180.0), &cache).await;
        assert!(cover.is_none(), "抽不出来就是没有，不该 panic 也不该报错");
        // 失败不能在缓存里留下空文件，否则下一次会把它当成好图返回
        let leftovers: Vec<_> = std::fs::read_dir(&cache)
            .map(|entries| entries.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "留下了半成品：{leftovers:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 用 ffmpeg 自己造一段测试视频。没装 ffmpeg 就返回 None，这条用例整个跳过——
    /// 安卓和干净的 CI 机器上本来就没有 ffmpeg。
    async fn make_test_video(path: &Path, filter: &str, seconds: u32) -> bool {
        if !kdj_providers::ffmpeg::available() {
            return false;
        }
        let args = [
            "-y",
            "-f",
            "lavfi",
            "-i",
            filter,
            "-t",
            &seconds.to_string(),
            "-pix_fmt",
            "yuv420p",
            path.to_str().unwrap(),
        ]
        .map(str::to_string);
        let log = path.with_extension("log");
        let ok =
            kdj_providers::ffmpeg::run(&args, &log, &tokio_util::sync::CancellationToken::new())
                .await
                .is_ok();
        let _ = std::fs::remove_file(&log);
        ok
    }

    #[tokio::test]
    async fn a_video_without_embedded_art_gets_a_frame_and_caches_it() {
        let base = scratch("cover-frame");
        let video = base.join("clip.mp4");
        if !make_test_video(&video, "testsrc=size=640x360:rate=10", 4).await {
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        let cache = base.join("covers");

        let cover = video_cover(&video, 7, Some(4.0), &cache).await.unwrap();
        assert!(cover.starts_with(b"\xff\xd8\xff"), "得是一张真的 JPEG");
        let cached = cover_cache_file(&cache, 7, file_mtime(&video));
        assert_eq!(std::fs::read(&cached).unwrap(), cover, "第二次要走缓存");
        // 半成品不能留在缓存目录里
        let names: Vec<String> = std::fs::read_dir(&cache)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1, "缓存目录里应该只剩成品：{names:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn an_all_black_opening_makes_it_try_a_later_position() {
        // VJ 素材常常黑好几秒。第一个位置全黑时要往后挪，
        // 不然列表里排出来一列黑方块，和没有封面看着一样
        let base = scratch("cover-black");
        let video = base.join("fade.mp4");
        // 前 6 秒纯黑，之后是彩色测试图；时长 12 秒 → 第一枪落在 1.2 秒（黑），
        // 重试落在 4.2 / 7.2 秒，后者能抽到画面
        let filter = "color=c=black:size=320x240:rate=10:duration=6[a];\
testsrc=size=320x240:rate=10:duration=6[b];[a][b]concat=n=2:v=1:a=0";
        if !make_test_video(&video, filter, 12).await {
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        // 先确认第一枪确实打在黑场上，否则这条用例是白跑的
        let first = base.join("first.jpg");
        kdj_providers::ffmpeg::extract_frame(
            &video,
            &first,
            kdj_providers::ffmpeg::frame_position(Some(12.0)),
            &base.join("ff.log"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
        assert!(
            kdj_providers::ffmpeg::frame_is_mostly_black(&std::fs::read(&first).unwrap()),
            "样本视频开头不是黑的，这条用例没验到东西"
        );

        let cover = video_cover(&video, 8, Some(12.0), &base.join("covers"))
            .await
            .unwrap();
        assert!(
            !kdj_providers::ffmpeg::frame_is_mostly_black(&cover),
            "挑出来的还是黑的，重试没起作用"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn audio_mime_types_match_the_container() {
        assert_eq!(mime_for(Path::new("a.mp3")), "audio/mpeg");
        assert_eq!(mime_for(Path::new("a.FLAC")), "audio/flac");
        assert_eq!(mime_for(Path::new("a.m4a")), "audio/mp4");
        assert_eq!(mime_for(Path::new("a.xyz")), "application/octet-stream");
    }

    #[test]
    fn video_mime_types_do_not_disguise_quicktime_as_mp4() {
        assert_eq!(video_mime_for(Path::new("a.mp4")), "video/mp4");
        assert_eq!(video_mime_for(Path::new("a.MOV")), "video/quicktime");
        assert_eq!(video_mime_for(Path::new("a.webm")), "video/webm");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kdj-roots-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // canonicalize 一次，免得 macOS 上 /var 与 /private/var 的差异干扰包含性判断
        std::fs::canonicalize(&dir).unwrap()
    }

    fn undo_test_state(base: &Path) -> Arc<AppState> {
        let config = Arc::new(kdj_core::AppConfig::create(
            base.join("data"),
            base.join("downloads"),
            0,
        ));
        AppState::new(config).unwrap()
    }

    fn insert_undo_track(state: &AppState, path: &Path) -> i64 {
        let path_text = path.to_string_lossy().into_owned();
        let filename = path.file_name().unwrap().to_string_lossy().into_owned();
        let conn = state.library.db().conn().unwrap();
        conn.execute(
            "INSERT INTO tracks (path, filename, title, format, added_at, modified_at) \
             VALUES (?, ?, '', 'mp3', 'now', 'now')",
            [path_text.as_str(), filename.as_str()],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn undo_move_restores_the_file_and_track_path() {
        let base = scratch("undo-move");
        let state = undo_test_state(&base);
        let source_dir = base.join("library").join("source");
        let target_dir = base.join("library").join("target");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::create_dir_all(&target_dir).unwrap();
        let source = source_dir.join("song.mp3");
        let target = target_dir.join("song.mp3");
        std::fs::write(&source, b"audio").unwrap();
        let id = insert_undo_track(&state, &source);
        std::fs::rename(&source, &target).unwrap();
        state.library.relocate(id, &target).unwrap();

        let item = FolderUndoItem {
            op: FolderUndoOp::Move,
            track_id: id,
            source: source.clone(),
            target: target.clone(),
            created_track_id: None,
            source_platform: String::new(),
            source_key: String::new(),
            deleted: None,
        };
        assert_eq!(undo_folder_item(&state, &item).unwrap(), vec![id]);
        assert!(source.is_file());
        assert!(!target.exists());
        assert_eq!(
            state.library.get(id).unwrap().unwrap().path,
            source.to_string_lossy()
        );
        drop(state);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn undo_copy_removes_the_new_file_and_track() {
        let base = scratch("undo-copy");
        let state = undo_test_state(&base);
        let source_dir = base.join("library").join("source");
        let target_dir = base.join("library").join("target");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::create_dir_all(&target_dir).unwrap();
        let source = source_dir.join("song.mp3");
        let target = target_dir.join("song.mp3");
        std::fs::write(&source, b"audio").unwrap();
        std::fs::copy(&source, &target).unwrap();
        let source_id = insert_undo_track(&state, &source);
        let copy_id = insert_undo_track(&state, &target);

        let item = FolderUndoItem {
            op: FolderUndoOp::Copy,
            track_id: source_id,
            source: source.clone(),
            target: target.clone(),
            created_track_id: Some(copy_id),
            source_platform: String::new(),
            source_key: String::new(),
            deleted: None,
        };
        assert_eq!(undo_folder_item(&state, &item).unwrap(), vec![copy_id]);
        assert!(source.is_file());
        assert!(!target.exists());
        assert!(state.library.get(copy_id).unwrap().is_none());
        drop(state);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn undo_delete_restores_the_file_and_library_record() {
        let base = scratch("undo-delete");
        let state = undo_test_state(&base);
        let library_dir = base.join("library");
        std::fs::create_dir_all(&library_dir).unwrap();
        let source = library_dir.join("song.mp3");
        std::fs::write(&source, b"audio").unwrap();
        let id = insert_undo_track(&state, &source);
        let (removed, deleted) = state
            .library
            .delete_for_undo(id, FileDisposal::Keep)
            .unwrap();
        assert!(removed);
        let item = FolderUndoItem {
            op: FolderUndoOp::Delete,
            track_id: id,
            source: source.clone(),
            target: PathBuf::new(),
            created_track_id: None,
            source_platform: String::new(),
            source_key: String::new(),
            deleted,
        };
        assert_eq!(undo_folder_item(&state, &item).unwrap(), vec![id]);
        assert!(source.is_file());
        assert!(state.library.get(id).unwrap().is_some());
        drop(state);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn empty_undo_status_is_not_available() {
        let base = scratch("undo-status");
        let state = undo_test_state(&base);
        assert!(!state.folder_undo_status().available);
        assert_eq!(state.folder_undo_status().count, 0);
        drop(state);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn adding_a_folder_registers_it_as_a_library_root() {
        // 「添加文件夹」必须一步到位：不登记的话加进来的歌在文件夹树里一个都看不见
        let base = scratch("register");
        let music = base.join("music");
        std::fs::create_dir_all(&music).unwrap();
        let merged = merge_library_roots(&[], &[music.to_string_lossy().into_owned()]);
        assert_eq!(merged, vec![music.to_string_lossy().into_owned()]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_subdirectory_of_an_existing_root_is_not_registered_again() {
        // 点文件夹树里的子目录也会触发扫描，每次都登记的话那个子目录会
        // 同时以"根"和"某根的子节点"两个身份出现在树上
        let base = scratch("subdir");
        let sub = base.join("温州");
        std::fs::create_dir_all(&sub).unwrap();
        let existing = vec![base.to_string_lossy().into_owned()];
        let merged = merge_library_roots(&existing, &[sub.to_string_lossy().into_owned()]);
        assert_eq!(merged, existing, "已经在根里的子目录不再登记");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_unreachable_configured_root_is_never_replaced_by_an_inferred_one() {
        // 外置硬盘没插时 resolve_roots 也返回空。这时候要是去反推，
        // 用户配好的目录会被下载目录顶掉，硬盘插回去也回不来了
        let base = scratch("unreachable");
        let music = base.join("music");
        std::fs::create_dir_all(&music).unwrap();
        let configured = vec!["/Volumes/没插的移动硬盘/Music".to_string()];

        let (roots, adopt) = pick_library_roots(&configured, || {
            vec![music.join("a.mp3").to_string_lossy().into_owned()]
        });
        assert!(roots.is_empty(), "目录不可达就是没有根，不该悄悄换一个");
        assert!(adopt.is_none(), "更不能把设置改掉");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_empty_configuration_adopts_the_inferred_roots() {
        // 文件夹模式上线前扫过歌的库：library_dirs 是空的，但歌都在列表里摆着
        let base = scratch("adopt");
        let music = base.join("music");
        std::fs::create_dir_all(&music).unwrap();
        let (roots, adopt) = pick_library_roots(&[], || {
            vec![music.join("a.mp3").to_string_lossy().into_owned()]
        });
        assert_eq!(roots.len(), 1);
        assert_eq!(
            adopt,
            Some(vec![roots[0].to_string_lossy().into_owned()]),
            "反推出来的要写回设置，否则设置页永远显示还没配目录"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_empty_library_infers_nothing_and_leaves_the_settings_alone() {
        let (roots, adopt) = pick_library_roots(&[], Vec::new);
        assert!(roots.is_empty());
        assert!(adopt.is_none());
    }

    #[test]
    fn nonexistent_paths_and_duplicates_are_ignored() {
        let base = scratch("dedupe");
        let music = base.join("music");
        std::fs::create_dir_all(&music).unwrap();
        let path = music.to_string_lossy().into_owned();
        let merged = merge_library_roots(
            &[path.clone()],
            &[
                path.clone(),
                base.join("不存在").to_string_lossy().into_owned(),
            ],
        );
        assert_eq!(merged, vec![path], "重复的和不存在的都不该进去");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn forgetting_a_root_drops_it_and_nested_registered_paths() {
        let base = scratch("forget-root");
        let music = base.join("music");
        let nested = music.join("set");
        let other = base.join("other");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let existing = vec![
            music.to_string_lossy().into_owned(),
            nested.to_string_lossy().into_owned(),
            other.to_string_lossy().into_owned(),
        ];
        let next = unregister_library_roots(&existing, &music);
        assert_eq!(
            next,
            vec![other.to_string_lossy().into_owned()],
            "移出根目录时，登记在它底下的子路径一并拿掉"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn forgetting_a_subdir_does_not_unregister_its_root() {
        let base = scratch("forget-sub");
        let sub = base.join("温州");
        std::fs::create_dir_all(&sub).unwrap();
        let existing = vec![base.to_string_lossy().into_owned()];
        let next = unregister_library_roots(&existing, &sub);
        assert_eq!(next, existing, "移出子目录只摘曲目，根目录登记还在");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn audio_correlation_finds_a_video_intro() {
        // 20Hz 包络里前置 10 秒（200 点），自动校准应让视频从 +10s 开始。
        let local: Vec<f64> = (0..1200)
            .map(|index| (((index * 73 + index * index * 11) % 101) as f64 - 50.0) / 30.0)
            .collect();
        let mut video = vec![0.0; 200];
        video.extend_from_slice(&local);
        video.extend(std::iter::repeat_n(0.0, 300));
        let (offset, score) = correlate_offset(&local, &video);
        assert_eq!(offset, 10_000);
        assert!(score > 0.5);
    }
}
