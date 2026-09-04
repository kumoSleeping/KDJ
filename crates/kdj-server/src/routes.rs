//! HTTP 路由。路径和响应形状必须和 `sidecar/kdj/app.py` 一一对应——
//! 前端 `src/lib/api.ts` 是照着旧契约写的。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Extension, Json, Router};
use futures_util::StreamExt;
use kdj_core::models::*;
use kdj_core::Settings;
use kdj_library::service::{DeletedTrack, FileDisposal, TrackMediaSource, TrackQuery};
use kdj_providers::{MusicProvider, ProtectedPreviewIdentity, VideoPreviewTrack};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::downloads::{
    enqueue_audio, enqueue_video, restart_inactive_tasks, retry_task, DownloadManager,
};
use crate::error::{ApiError, ApiResult};
use crate::state::{
    AppState, FolderUndoBatch, FolderUndoItem, SongPreviewTicket, YoutubeHlsResource, PLATFORMS,
};
use crate::youtube_hls::{
    YoutubeHlsCachedBody, YoutubeHlsCachedFailure, YoutubeHlsCachedResponse,
    YoutubeHlsCachedResult, YoutubeHlsSegmentSpool,
};
use crate::MediaToken;

#[derive(Clone)]
pub struct Ctx {
    pub state: Arc<AppState>,
    pub downloads: Arc<DownloadManager>,
}

pub fn router(ctx: Ctx) -> Router<Arc<AppState>> {
    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/control/show", post(control_show))
        .route("/api/control/quit", post(control_quit))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route(
            "/api/activity/logs",
            get(activity_logs).delete(clear_activity_logs),
        )
        .route("/api/activity/logs/batch", post(append_activity_logs))
        .route(
            "/api/activity/settings",
            get(activity_log_settings).put(update_activity_log_settings),
        )
        .route("/api/cache", get(cache_overview))
        .route("/api/cache/{category}", delete(clear_cache_category))
        .route("/api/accounts", get(list_accounts))
        .route("/api/accounts/cached", get(list_cached_accounts))
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
            "/api/accounts/soundcloud/login/browsers",
            get(browser_catalog),
        )
        .route(
            "/api/accounts/soundcloud/login/browser",
            post(soundcloud_browser_login),
        )
        .route(
            "/api/accounts/soundcloud/login/webview",
            post(soundcloud_webview_login),
        )
        .route("/api/accounts/ytm/login/browsers", get(browser_catalog))
        .route("/api/accounts/ytm/login/browser", post(ytm_browser_login))
        .route("/api/accounts/ytm/login/headers", post(ytm_headers_login))
        .route("/api/accounts/ytm/login/webview", post(ytm_webview_login))
        .route("/api/accounts/youtube/login/browsers", get(browser_catalog))
        .route(
            "/api/accounts/youtube/login/browser",
            post(youtube_browser_login),
        )
        .route(
            "/api/accounts/youtube/login/headers",
            post(youtube_headers_login),
        )
        .route("/api/search", post(search))
        .route("/api/search/cover", post(search_cover))
        .route("/api/search/capabilities", get(search_capabilities))
        .route("/api/search/collection", post(resolve_collection))
        .route("/api/lyrics", post(lyrics))
        .route(
            "/api/song/preview/ytm/identity",
            get(ytm_protected_preview_identity),
        )
        .route(
            "/api/song/preview/ytm/player",
            post(ytm_protected_preview_player),
        )
        .route(
            "/api/song/preview/ytm/player-url",
            get(ytm_protected_preview_player_url),
        )
        .route(
            "/api/song/preview/ytm/player-script",
            post(ytm_protected_preview_player_script),
        )
        .route("/api/song/preview/ytm/sabr/proxy", post(ytm_sabr_proxy))
        .route(
            "/api/song/preview/ytm/sabr/spools",
            post(ytm_sabr_spool_create),
        )
        .route(
            "/api/song/preview/ytm/sabr/spools/{token}",
            post(ytm_sabr_spool_append),
        )
        .route(
            "/api/song/preview/ytm/sabr/spools/{token}/complete",
            post(ytm_sabr_spool_complete),
        )
        .route(
            "/api/song/preview/ytm/sabr/spools/{token}/fail",
            post(ytm_sabr_spool_fail),
        )
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
        .route(
            "/api/downloads/preparations/pending",
            get(pending_download_preparations),
        )
        .route(
            "/api/downloads/{id}/prepared-source",
            post(attach_prepared_download_source),
        )
        .route(
            "/api/downloads/{id}/preparation-failed",
            post(fail_download_preparation),
        )
        .route("/api/downloads/{id}", delete(remove_download))
        .route("/api/downloads/start", post(start_downloads))
        .route("/api/downloads/pause", post(pause_downloads))
        .route("/api/downloads/cancel-all", post(cancel_all_downloads))
        .route("/api/downloads/{id}/cancel", post(cancel_download))
        .route("/api/downloads/{id}/retry", post(retry_download))
        .route("/api/downloads/{id}/quality", post(update_download_quality))
        .route("/api/downloads/{id}/height", post(update_download_height))
        .route("/api/downloads/clear", post(clear_downloads))
        .route("/api/video/resolve", post(video_resolve))
        .route("/api/video/download", post(video_download))
        .route(
            "/api/video/youtube/player-script",
            post(youtube_protected_preview_player_script),
        )
        .route("/api/video/youtube/hls/begin", post(youtube_begin_hls))
        .route(
            "/api/video/youtube/hls/complete",
            post(youtube_complete_hls),
        )
        .route(
            "/api/video/youtube/hls/{ticket}/session",
            post(youtube_start_hls_session),
        )
        .route(
            "/api/video/youtube/hls/{ticket}/revoke",
            post(youtube_revoke_hls_session),
        )
        .route("/api/video/youtube/hls/{ticket}", get(youtube_hls_resource))
        .route("/api/video/preview", get(video_preview))
        .route("/api/video/calibrate", post(video_calibrate))
        .route("/api/library/tracks", get(library_tracks))
        .route(
            "/api/library/tracks/summaries",
            post(library_track_summaries),
        )
        .route("/api/stream/playlists/{platform}", get(stream_playlists))
        .route("/api/stream/playlist", post(stream_playlist))
        .route(
            "/api/stream/playlist/remove-track",
            post(stream_playlist_remove_track),
        )
        .route("/api/library/tracks/{id}", get(library_track))
        .route(
            "/api/library/lyrics/{id}",
            get(library_lyrics).put(cache_library_lyrics),
        )
        .route("/api/library/tracks/{id}", patch(library_patch))
        .route("/api/library/tracks/{id}", delete(library_delete))
        // 静态段和 {id} 同位并存：axum 的 matchit 保证静态优先，
        // 且 "delete" 本来也解析不成 i64，不会被吞进单条路由
        .route("/api/library/tracks/delete", post(library_delete_batch))
        .route("/api/library/tracks/{id}/write-tags", post(write_tags))
        .route("/api/library/tracks/{id}/reread-tags", post(reread_tags))
        .route("/api/library/stats", get(library_stats))
        .route("/api/update/check", get(update_check))
        .route("/api/library/harmonic", post(library_harmonic_profile))
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
        .route("/api/library/folders/merge", post(folder_merge))
        .route("/api/library/folders/order", post(folder_order))
        .route(
            "/api/library/folders/undo",
            get(folder_undo_status).post(folder_undo),
        )
        .route("/api/library/folders/apply", post(folder_apply))
        .route(
            "/api/library/duplicates/analyze",
            post(analyze_duplicate_tracks),
        )
        .route("/api/library/scan", post(library_scan))
        .route("/api/library/scan/cancel", post(library_scan_cancel))
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
        .route("/api/library/waveform/{id}", get(library_waveform));
    #[cfg(debug_assertions)]
    let router = router.route(
        "/api/dev/youtube-playback-e2e-report",
        post(write_youtube_playback_e2e_report),
    );
    router.layer(axum::Extension(ctx))
}

// ---------------------------------------------------------------- 基础

async fn health() -> Json<Value> {
    // 健康检查只用于版本/能力探测。设置接口已经在认证后提供用户配置，没必要在这里
    // 重复暴露 data_dir/download_dir 的绝对路径。
    Json(json!({
        "ok": true,
        "version": kdj_core::VERSION,
        "ffmpeg": kdj_providers::ffmpeg::available(),
        "platform": std::env::consts::OS,
    }))
}

#[cfg(debug_assertions)]
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YoutubeE2eMeasurement {
    playable_ms: u64,
    advancing_ms: u64,
    duration_seconds: u64,
}

#[cfg(debug_assertions)]
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YoutubeE2eProbe {
    master_status: Option<u16>,
    master_type: Option<String>,
    master_bytes: Option<usize>,
    master_entries: Option<usize>,
    master_failure: Option<String>,
    child_status: Option<u16>,
    child_type: Option<String>,
    child_bytes: Option<usize>,
    child_entries: Option<usize>,
    child_failure: Option<String>,
    segment_status: Option<u16>,
    segment_type: Option<String>,
    segment_bytes: Option<usize>,
    segment_failure: Option<String>,
    range_segment_status: Option<u16>,
    range_segment_bytes: Option<usize>,
    range_segment_failure: Option<String>,
    midpoint_segment_status: Option<u16>,
    midpoint_segment_bytes: Option<usize>,
    midpoint_segment_failure: Option<String>,
    last_segment_status: Option<u16>,
    last_segment_bytes: Option<usize>,
    last_segment_failure: Option<String>,
    attribute_uri_count: Option<usize>,
    attribute_kinds: Option<Vec<String>>,
    attribute_status: Option<u16>,
    attribute_failure: Option<String>,
    attribute_uri_failures: Option<usize>,
    attribute_segment_failures: Option<usize>,
    variant_count: Option<usize>,
    variant_failures: Option<usize>,
    segment_failures: Option<usize>,
    range_segment_failures: Option<usize>,
}

#[cfg(debug_assertions)]
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YoutubeE2eReport {
    status: String,
    stage: String,
    startup_prewarm_ms: Option<u64>,
    cold_video: Option<YoutubeE2eMeasurement>,
    seek_ms: Option<u64>,
    switched_video: Option<YoutubeE2eMeasurement>,
    warm_video: Option<YoutubeE2eMeasurement>,
    ytm_audio_playable_ms: Option<u64>,
    ytm_audio_advancing_ms: Option<u64>,
    hls_probe: Option<YoutubeE2eProbe>,
    error: Option<String>,
}

#[cfg(debug_assertions)]
async fn write_youtube_playback_e2e_report(
    State(state): State<Arc<AppState>>,
    Json(report): Json<YoutubeE2eReport>,
) -> ApiResult<Json<Value>> {
    if !matches!(report.status.as_str(), "running" | "passed" | "failed")
        || report.stage.is_empty()
        || report.stage.len() > 64
        || !report
            .stage
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
        || report.error.as_ref().is_some_and(|value| {
            value.len() > 240
                || value.contains("http://")
                || value.contains("https://")
                || value.to_ascii_lowercase().contains("cookie")
                || value.to_ascii_lowercase().contains("token")
        })
    {
        return Err(ApiError::bad_request("YouTube E2E 报告无效"));
    }
    let bytes = serde_json::to_vec_pretty(&report).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "YouTube E2E 报告编码失败",
        )
    })?;
    tokio::fs::write(
        state
            .config
            .data_dir
            .join("youtube-playback-e2e-report.json"),
        bytes,
    )
    .await
    .map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "YouTube E2E 报告写入失败",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn control_show(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    state
        .control
        .send(crate::state::UiControl::Show)
        .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "窗口控制通道已关闭"))?;
    Ok(Json(json!({ "ok": true })))
}

async fn control_quit(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    state
        .control
        .send(crate::state::UiControl::Quit)
        .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "窗口控制通道已关闭"))?;
    Ok(Json(json!({ "ok": true })))
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
) -> ApiResult<Json<SettingsView>> {
    let previous_settings = state.config.to_settings();
    let directory_change_requested = payload.download_dir != previous_settings.download_dir
        || payload.library_dirs != previous_settings.library_dirs;
    let previous_download_dir = state.config.download_dir();
    let settings = match state.config.apply_settings(payload) {
        Ok(settings) => settings,
        Err(error) => {
            if directory_change_requested {
                state.activity_log.record_level(
                    crate::activity_log::ActivityCategory::User,
                    crate::activity_log::ActivityLevel::Error,
                    "设定本地文件夹失败",
                    format!("{error:#}"),
                );
            }
            return Err(error.into());
        }
    };
    let download_dir_changed = state.config.download_dir() != previous_download_dir;
    let library_dirs_changed = settings.library_dirs != previous_settings.library_dirs;
    if download_dir_changed {
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
    if download_dir_changed {
        state
            .activity_log
            .record(crate::activity_log::ActivityLogDraft {
                category: crate::activity_log::ActivityCategory::User,
                level: crate::activity_log::ActivityLevel::Info,
                action: "设定下载文件夹".into(),
                detail: String::new(),
                target: String::new(),
                status: Some(StatusCode::OK.as_u16()),
                duration_ms: None,
                count: 1,
            });
    }
    if library_dirs_changed {
        state
            .activity_log
            .record(crate::activity_log::ActivityLogDraft {
                category: crate::activity_log::ActivityCategory::User,
                level: crate::activity_log::ActivityLevel::Info,
                action: "设定曲库文件夹".into(),
                detail: String::new(),
                target: String::new(),
                status: Some(StatusCode::OK.as_u16()),
                duration_ms: None,
                count: 1,
            });
    }
    Ok(Json(settings_view(settings)))
}

#[derive(Debug, Deserialize)]
struct ActivityLogQuery {
    category: Option<crate::activity_log::ActivityCategory>,
    #[serde(default = "default_activity_log_limit")]
    limit: usize,
}

fn default_activity_log_limit() -> usize {
    160
}

async fn activity_logs(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ActivityLogQuery>,
) -> Json<crate::activity_log::ActivityLogOverview> {
    Json(state.activity_log.overview(query.category, query.limit))
}

async fn append_activity_logs(
    State(state): State<Arc<AppState>>,
    Json(batch): Json<crate::activity_log::ActivityLogBatch>,
) -> ApiResult<Json<Value>> {
    if batch.entries.len() > 100 {
        return Err(ApiError::bad_request("单批日志不能超过 100 条"));
    }
    let accepted = state.activity_log.record_batch(batch.entries);
    Ok(Json(json!({ "accepted": accepted })))
}

async fn clear_activity_logs(State(state): State<Arc<AppState>>) -> ApiResult<StatusCode> {
    let activity_log = state.activity_log.clone();
    tokio::task::spawn_blocking(move || activity_log.clear())
        .await
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "清理日志任务失败"))??;
    Ok(StatusCode::NO_CONTENT)
}

async fn activity_log_settings(
    State(state): State<Arc<AppState>>,
) -> Json<crate::activity_log::ActivityLogSettings> {
    Json(state.activity_log.settings())
}

async fn update_activity_log_settings(
    State(state): State<Arc<AppState>>,
    Json(settings): Json<crate::activity_log::ActivityLogSettings>,
) -> ApiResult<Json<crate::activity_log::ActivityLogSettings>> {
    let activity_log = state.activity_log.clone();
    let settings = tokio::task::spawn_blocking(move || activity_log.set_settings(settings))
        .await
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "保存日志设置任务失败"))??;
    Ok(Json(settings))
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

/// 启动页只恢复本地账号快照，不访问任何第三方平台。联网核验仍保留在
/// `/api/accounts`，只供用户明确刷新/重试时调用。
async fn list_cached_accounts(State(state): State<Arc<AppState>>) -> Json<Vec<Account>> {
    let mut accounts = Vec::new();
    for platform in PLATFORMS {
        let Some(provider) = state.provider(platform) else {
            continue;
        };
        accounts.push(provider.cached_account().await);
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

#[derive(Debug, Deserialize)]
struct BrowserLoginBody {
    browser: String,
    #[serde(default)]
    profile: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SoundCloudWebviewLoginBody {
    access_token: String,
    #[serde(default)]
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct YoutubeHeadersLoginBody {
    headers: String,
}

#[derive(Debug, Deserialize)]
struct YoutubeWebviewLoginBody {
    cookie: String,
}

/// 只探测本机浏览器与 Profile；不会读取 Cookie 内容或触发系统钥匙串。
async fn browser_catalog() -> ApiResult<Json<kdj_providers::browser::BrowserCatalog>> {
    let catalog = tokio::task::spawn_blocking(kdj_providers::browser::catalog)
        .await
        .map_err(|error| ApiError::bad_request(format!("检测浏览器失败：{error}")))?;
    Ok(Json(catalog))
}

/// 从桌面浏览器的指定 Profile 导入 SoundCloud 网页会话。
async fn soundcloud_browser_login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<BrowserLoginBody>,
) -> ApiResult<Json<Account>> {
    let browser = payload.browser.trim().to_string();
    let profile = payload.profile.map(|profile| profile.trim().to_string());
    if browser.is_empty() {
        return Err(ApiError::bad_request("请选择浏览器"));
    }
    state.soundcloud.import_browser(browser, profile).await?;
    let account = state.soundcloud.account().await;
    state.hub.publish("account.changed", &account);
    Ok(Json(account))
}

/// KDJ 原生隔离窗口只把 SoundCloud 的网页登录会话交回本机后端；令牌不经过
/// renderer。provider 会先请求 `/me` 验证，成功后才替换已有登录态。
async fn soundcloud_webview_login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SoundCloudWebviewLoginBody>,
) -> ApiResult<Json<Account>> {
    let access_token = payload.access_token.trim().to_string();
    if access_token.is_empty() || access_token.len() > 4096 {
        return Err(ApiError::bad_request("SoundCloud 登录窗口没有返回有效会话"));
    }
    state
        .soundcloud
        .import_webview_session(access_token, payload.expires_at)
        .await?;
    let account = state.soundcloud.account().await;
    state.hub.publish("account.changed", &account);
    Ok(Json(account))
}

async fn import_youtube_browser(
    auth: Arc<kdj_providers::youtubemusic::auth::YoutubeAuth>,
    payload: BrowserLoginBody,
) -> ApiResult<kdj_providers::youtubemusic::auth::BrowserSession> {
    let browser = payload.browser.trim().to_string();
    let profile = payload.profile.map(|profile| profile.trim().to_string());
    if browser.is_empty() {
        return Err(ApiError::bad_request("请选择浏览器"));
    }
    tokio::task::spawn_blocking(move || auth.import_browser(&browser, profile.as_deref()))
        .await
        .map_err(|error| ApiError::bad_request(format!("读取浏览器会话失败：{error}")))?
        .map_err(Into::into)
}

/// YouTube Music 只更新自己的会话与账号事件。
async fn ytm_browser_login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<BrowserLoginBody>,
) -> ApiResult<Json<Account>> {
    let session = import_youtube_browser(state.ytm_auth.clone(), payload).await?;
    state.ytm_auth.save(session)?;
    let account = state
        .provider(Platform::Ytm)
        .ok_or_else(|| ApiError::bad_request("YouTube Music provider 不可用"))?
        .account()
        .await;
    state.hub.publish("account.changed", &account);
    Ok(Json(account))
}

/// 普通 YouTube 视频只更新自己的会话与账号事件。
async fn youtube_browser_login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<BrowserLoginBody>,
) -> ApiResult<Json<Account>> {
    let session = import_youtube_browser(state.youtube_auth.clone(), payload).await?;
    state.youtube_auth.save(session)?;
    let account = state
        .provider(Platform::Youtube)
        .ok_or_else(|| ApiError::bad_request("YouTube provider 不可用"))?
        .account()
        .await;
    state.hub.publish("account.changed", &account);
    Ok(Json(account))
}

fn save_headers_session(
    auth: &kdj_providers::youtubemusic::auth::YoutubeAuth,
    headers: &str,
) -> ApiResult<()> {
    let session = kdj_providers::youtubemusic::auth::BrowserSession::from_headers(headers)?;
    auth.save(session)?;
    Ok(())
}

/// ytmusicapi 标准回退：只写 YouTube Music 请求头会话。
async fn ytm_headers_login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<YoutubeHeadersLoginBody>,
) -> ApiResult<Json<Account>> {
    save_headers_session(&state.ytm_auth, &payload.headers)?;
    let account = state
        .provider(Platform::Ytm)
        .ok_or_else(|| ApiError::bad_request("YouTube Music provider 不可用"))?
        .account()
        .await;
    state.hub.publish("account.changed", &account);
    Ok(Json(account))
}

/// 桌面 WebView 登录：Cookie 只在 Rust 侧流转，不进 renderer。
async fn ytm_webview_login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<YoutubeWebviewLoginBody>,
) -> ApiResult<Json<Account>> {
    let cookie = payload.cookie.trim();
    if cookie.is_empty() || cookie.len() > 256 * 1024 {
        return Err(ApiError::bad_request(
            "YouTube Music 登录窗口没有返回有效会话",
        ));
    }
    let session = kdj_providers::youtubemusic::auth::BrowserSession::from_cookie_header(
        cookie,
        "WebView 登录 · music.youtube.com",
    )?;
    state
        .youtubemusic
        .validate_browser_session(&session)
        .await
        .map_err(|error| {
            ApiError::bad_request(format!("YouTube Music 登录会话验证失败：{error}"))
        })?;
    state.ytm_auth.save(session)?;
    let account = state
        .provider(Platform::Ytm)
        .ok_or_else(|| ApiError::bad_request("YouTube Music provider 不可用"))?
        .account()
        .await;
    state.hub.publish("account.changed", &account);
    Ok(Json(account))
}

/// 普通 YouTube 请求头回退；不会覆盖 YouTube Music 会话。
async fn youtube_headers_login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<YoutubeHeadersLoginBody>,
) -> ApiResult<Json<Account>> {
    save_headers_session(&state.youtube_auth, &payload.headers)?;
    let account = state
        .provider(Platform::Youtube)
        .ok_or_else(|| ApiError::bad_request("YouTube provider 不可用"))?
        .account()
        .await;
    state.hub.publish("account.changed", &account);
    Ok(Json(account))
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
    kdj_core::ensure_rustls_ring();
    let mut url = reqwest::Url::parse(payload.url.trim())
        .map_err(|_| ApiError::bad_request("封面地址无效"))?;
    let mut redirect_hops = 0usize;
    let response = loop {
        if url.scheme() != "https" || !cover_host_allowed(payload.platform, &url) {
            return Err(ApiError::bad_request(
                "封面地址不是允许的网易云 / QQ 图片地址",
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| ApiError::bad_request("封面地址缺少主机名"))?;
        let addrs = kdj_providers::net::pinned_public_addrs(&url)
            .await
            .map_err(|_| ApiError::bad_request("封面地址解析到了非公网地址"))?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // 代理会绕过上面的 `resolve_to_addrs`，并替我们访问原本已拒绝的私网地址。
            .no_proxy()
            .referer(false)
            .timeout(std::time::Duration::from_secs(12))
            .user_agent("KDJ cover matcher")
            .resolve_to_addrs(host, &addrs)
            .build()
            .map_err(|error| ApiError::bad_request(format!("封面代理不可用：{error}")))?;
        let candidate = client
            .get(url.clone())
            .send()
            .await
            .map_err(|error| ApiError::bad_request(format!("封面下载失败：{error}")))?;
        if !candidate.status().is_redirection() {
            break candidate;
        }
        let location = candidate
            .headers()
            .get(reqwest::header::LOCATION)
            .ok_or_else(|| ApiError::bad_request("封面重定向缺少 Location"))?
            .to_str()
            .map_err(|_| ApiError::bad_request("封面重定向地址无效"))?;
        url = url
            .join(location)
            .map_err(|_| ApiError::bad_request("封面重定向地址无效"))?;
        redirect_hops += 1;
        if redirect_hops > 5 {
            return Err(ApiError::bad_request("封面重定向次数过多"));
        }
    };
    if !response.status().is_success() {
        return Err(ApiError::bad_request(format!(
            "封面下载失败：HTTP {}",
            response.status()
        )));
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

async fn resolve_collection(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CollectionResolveRequest>,
) -> ApiResult<Json<CollectionResolveResponse>> {
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
    Ok(Json(response))
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

#[derive(Serialize)]
struct YtmProtectedIdentityResponse {
    visitor_data: String,
    data_sync_id: String,
    gvs_binding: &'static str,
}

async fn ytm_protected_preview_identity(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<YtmProtectedIdentityResponse>> {
    let provider = state
        .provider(Platform::Ytm)
        .ok_or_else(|| ApiError::not_found("YouTube Music 平台不可用"))?;
    let identity = provider
        .protected_preview_identity()
        .await?
        .ok_or_else(|| ApiError::bad_request("YouTube Music 登录会话标识不可用"))?;
    let gvs_binding = match identity.gvs_binding {
        kdj_providers::provider::ProtectedPoTokenBinding::VideoId => "video_id",
        kdj_providers::provider::ProtectedPoTokenBinding::DataSyncId => "data_sync_id",
        kdj_providers::provider::ProtectedPoTokenBinding::VisitorData => "visitor_data",
    };
    Ok(Json(YtmProtectedIdentityResponse {
        visitor_data: identity.visitor_data,
        data_sync_id: identity.data_sync_id,
        gvs_binding,
    }))
}

#[derive(Deserialize)]
struct YtmProtectedPlayerBody {
    source: SongSource,
    #[serde(default)]
    po_token: Option<String>,
    visitor_data: String,
    data_sync_id: String,
    player_url: String,
    signature_timestamp: u64,
    #[serde(default)]
    quality: Option<Quality>,
}

#[derive(Serialize)]
struct YtmProtectedPlayerResponse {
    signature_cipher: String,
    player_url: String,
    sabr_url: Option<String>,
    video_playback_ustreamer_config: Option<String>,
    sabr_formats: Vec<Value>,
    sabr_audio_itag: u32,
    duration_ms: u64,
}

async fn ytm_protected_preview_player(
    State(state): State<Arc<AppState>>,
    Json(body): Json<YtmProtectedPlayerBody>,
) -> ApiResult<Json<YtmProtectedPlayerResponse>> {
    if body.source.platform != Platform::Ytm
        || body
            .po_token
            .as_deref()
            .is_some_and(|token| !valid_web_po_token(token))
        || body.visitor_data.is_empty()
        || body.visitor_data.len() > 4096
        || body.visitor_data.contains(['\r', '\n'])
        || body.data_sync_id.len() > 512
        || body.data_sync_id.contains(['\r', '\n'])
        || body.player_url.len() > 4096
        || body.player_url.contains(['\r', '\n'])
        || !(10_000..=100_000).contains(&body.signature_timestamp)
    {
        return Err(ApiError::bad_request("YouTube Music WebPO 参数无效"));
    }
    let provider = state
        .provider(Platform::Ytm)
        .ok_or_else(|| ApiError::not_found("YouTube Music 平台不可用"))?;
    let quality = body
        .quality
        .unwrap_or_else(|| state.config.to_settings().stream_quality);
    let protected = provider
        .protected_preview_cipher(
            &body.source,
            quality,
            body.po_token.as_deref(),
            &ProtectedPreviewIdentity {
                visitor_data: body.visitor_data,
                data_sync_id: body.data_sync_id,
                // Binding was already selected by the identity endpoint and consumed in the
                // WebView while minting the GVS proof; the player request itself does not use it.
                gvs_binding: kdj_providers::provider::ProtectedPoTokenBinding::VideoId,
            },
            &body.player_url,
            body.signature_timestamp,
        )
        .await?
        .ok_or_else(|| ApiError::bad_request("YouTube Music 没有返回受保护试听流"))?;
    Ok(Json(YtmProtectedPlayerResponse {
        signature_cipher: protected.signature_cipher,
        player_url: protected.player_url,
        sabr_url: protected.sabr_url,
        video_playback_ustreamer_config: protected.video_playback_ustreamer_config,
        sabr_formats: protected.sabr_formats,
        sabr_audio_itag: protected.sabr_audio_itag,
        duration_ms: protected.duration_ms,
    }))
}

async fn ytm_protected_preview_player_url(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<String>> {
    let provider = state
        .provider(Platform::Ytm)
        .ok_or_else(|| ApiError::not_found("YouTube Music 平台不可用"))?;
    let player_url = provider
        .protected_preview_player_url()
        .await?
        .ok_or_else(|| ApiError::bad_request("YouTube Music 播放器脚本不可用"))?;
    Ok(Json(player_url))
}

#[derive(Deserialize)]
struct YtmProtectedPlayerScriptBody {
    player_url: String,
}

async fn ytm_protected_preview_player_script(
    State(state): State<Arc<AppState>>,
    Json(body): Json<YtmProtectedPlayerScriptBody>,
) -> ApiResult<Response> {
    let provider = state
        .provider(Platform::Ytm)
        .ok_or_else(|| ApiError::not_found("YouTube Music 平台不可用"))?;
    let javascript = provider
        .protected_preview_player_script(&body.player_url)
        .await?
        .ok_or_else(|| ApiError::bad_request("YouTube Music 播放器脚本不可用"))?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "private, max-age=3600"),
        ],
        javascript,
    )
        .into_response())
}

fn validated_ytm_sabr_url(value: &str) -> ApiResult<String> {
    if value.is_empty() || value.len() > 8192 || value.contains(['\r', '\n']) {
        return Err(ApiError::bad_request("YouTube SABR URL 无效"));
    }
    let url =
        reqwest::Url::parse(value).map_err(|_| ApiError::bad_request("YouTube SABR URL 无效"))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || (host != "googlevideo.com" && !host.ends_with(".googlevideo.com"))
        || url.path() != "/videoplayback"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::bad_request("YouTube SABR URL 不受信任"));
    }
    Ok(url.into())
}

async fn ytm_sabr_proxy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    if body.is_empty() || body.len() > 1024 * 1024 {
        return Err(ApiError::bad_request("YouTube SABR 请求体无效"));
    }
    let url = headers
        .get("x-kdj-sabr-url")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::bad_request("YouTube SABR URL 缺失"))?;
    let url = validated_ytm_sabr_url(url)?;
    let upstream = state
        .youtube_media_http
        .post(url)
        .header(header::CONTENT_TYPE, "application/x-protobuf")
        .header(header::ACCEPT, "application/vnd.yt-ump")
        .header(header::ACCEPT_ENCODING, "identity")
        .header(header::ORIGIN, "https://music.youtube.com")
        .header(header::REFERER, "https://music.youtube.com/")
        .header(
            header::USER_AGENT,
            kdj_providers::youtubemusic::client::PLAYBACK_WEB_USER_AGENT,
        )
        .body(body)
        .send()
        .await
        .map_err(|error| {
            let kind = if error.is_timeout() {
                "请求超时"
            } else if error.is_connect() {
                "连接失败"
            } else {
                "请求失败"
            };
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                format!("连接 YouTube SABR 上游失败（{kind}）"),
            )
        })?;
    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| header::HeaderValue::from_static("application/octet-stream"));
    let stream = upstream
        .bytes_stream()
        .map(|result| result.map_err(std::io::Error::other));
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream))
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

#[derive(Deserialize)]
struct YtmSabrSpoolCreateBody {
    source: SongSource,
    total: u64,
    content_type: String,
    #[serde(default)]
    quality: Option<Quality>,
    #[serde(default)]
    bypass_cache: bool,
}

async fn ytm_sabr_spool_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<YtmSabrSpoolCreateBody>,
) -> ApiResult<Json<Value>> {
    if body.source.platform != Platform::Ytm
        || body.total == 0
        || body.total > 512 * 1024 * 1024
        || !matches!(body.content_type.as_str(), "audio/mp4" | "audio/webm")
    {
        return Err(ApiError::bad_request("YouTube SABR 媒体参数无效"));
    }
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
            if cached
                .mime
                .split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case(body.content_type.as_str()))
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
                        browser_resolved: true,
                        protected_spool: None,
                        last_used_at: std::time::Instant::now(),
                    },
                ));
            }
        }
    }
    let extension = if body.content_type == "audio/webm" {
        "webm"
    } else {
        "m4a"
    };
    let spool = crate::protected_media::ProtectedMediaSpool::start_upload(
        crate::protected_media::spool_path(&state.config.data_dir, extension),
        body.total,
        body.content_type,
    )
    .await
    .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    schedule_protected_spool_cache(
        state.clone(),
        Arc::clone(&spool),
        body.source.clone(),
        quality,
        cache_key.clone(),
    );
    Ok(insert_song_preview_ticket(
        &state,
        SongPreviewTicket {
            source: body.source,
            quality,
            cache_key: Some(cache_key),
            cached: false,
            url: String::new(),
            browser_resolved: true,
            protected_spool: Some(spool),
            last_used_at: std::time::Instant::now(),
        },
    ))
}

fn ytm_upload_spool(
    state: &AppState,
    token: &str,
) -> ApiResult<Arc<crate::protected_media::ProtectedMediaSpool>> {
    let ticket = state
        .song_previews
        .lock()
        .unwrap()
        .get_and_touch(token)
        .ok_or_else(|| ApiError::not_found("YouTube SABR 媒体会话不存在"))?;
    if ticket.source.platform != Platform::Ytm || !ticket.browser_resolved || ticket.cached {
        return Err(ApiError::bad_request("YouTube SABR 媒体会话无效"));
    }
    ticket
        .protected_spool
        .ok_or_else(|| ApiError::bad_request("YouTube SABR 媒体会话无效"))
}

async fn ytm_sabr_spool_append(
    State(state): State<Arc<AppState>>,
    AxumPath(token): AxumPath<String>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let spool = ytm_upload_spool(&state, &token)?;
    let (available, total) = spool
        .append_upload(&body)
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(Json(json!({ "available": available, "total": total })))
}

async fn ytm_sabr_spool_complete(
    State(state): State<Arc<AppState>>,
    AxumPath(token): AxumPath<String>,
) -> ApiResult<StatusCode> {
    ytm_upload_spool(&state, &token)?
        .finish_upload()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct YtmSabrSpoolFailBody {
    error: String,
}

async fn ytm_sabr_spool_fail(
    State(state): State<Arc<AppState>>,
    AxumPath(token): AxumPath<String>,
    Json(body): Json<YtmSabrSpoolFailBody>,
) -> ApiResult<StatusCode> {
    let message = body.error.trim().chars().take(500).collect::<String>();
    ytm_upload_spool(&state, &token)?.fail_upload(if message.is_empty() {
        "YouTube SABR 媒体会话失败".to_string()
    } else {
        message
    });
    Ok(StatusCode::NO_CONTENT)
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

async fn cache_overview(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<crate::cache_overview::CacheOverview>> {
    Ok(Json(crate::cache_overview::stats(&state).await?))
}

async fn clear_cache_category(
    State(state): State<Arc<AppState>>,
    AxumPath(category): AxumPath<String>,
) -> ApiResult<Json<crate::cache_overview::CacheOverview>> {
    match category.as_str() {
        "media" => crate::cache_overview::clear_media(&state).await?,
        "waveform" => crate::cache_overview::clear_waveform(&state).await?,
        "lyrics" => crate::cache_overview::clear_lyrics(&state).await?,
        "basic" => crate::cache_overview::clear_basic(&state)?,
        "logs" => {
            let activity_log = state.activity_log.clone();
            tokio::task::spawn_blocking(move || activity_log.clear())
                .await
                .map_err(|_| {
                    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "清理日志任务失败")
                })??;
        }
        "other" => {
            return Err(ApiError::bad_request(
                "其他数据包含设置与曲库索引，不能清理",
            ))
        }
        _ => return Err(ApiError::bad_request("不认识的缓存类别")),
    }
    Ok(Json(crate::cache_overview::stats(&state).await?))
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
    let mut progress = state.stream_waveforms.request_with_analysis_duration(
        cache_key.clone(),
        state.config.to_settings().analysis_duration,
    );
    let cache_writing = persistent_cache_enabled && state.stream_cache.is_writing(&cache_key);
    progress.active |= cache_writing;
    if cache_writing
        && matches!(
            progress.cache_status,
            crate::stream_waveform::StreamCacheStatus::Waiting
                | crate::stream_waveform::StreamCacheStatus::Failed
        )
    {
        progress.cache_status = crate::stream_waveform::StreamCacheStatus::Caching;
        progress.cache_error.clear();
    }
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
    ensure_generic_song_preview_platform(body.source.platform)?;
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
            if body.source.platform == Platform::Ytm
                && cached
                    .mime
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("audio/webm"))
            {
                // 旧版本可能缓存了 Symphonia 0.5 无法解码的 Opus/WebM。命中它会
                // 永久重复 unsupported format；丢掉后重新走播放 API 选择 AAC。
                state.stream_cache.invalidate(&cache_root, &cache_key).await;
                state.stream_waveforms.remove(&cache_key);
            } else {
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
                        browser_resolved: false,
                        protected_spool: None,
                        last_used_at: std::time::Instant::now(),
                    },
                ));
            }
        }
    }
    let preview = provider
        .preview_url_at_quality(&body.source, quality)
        .await?;
    match preview {
        Some(url) => Ok(insert_song_preview_ticket(
            &state,
            SongPreviewTicket {
                source: body.source,
                quality,
                cache_key: Some(cache_key),
                cached: false,
                url,
                browser_resolved: false,
                protected_spool: None,
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

fn ensure_generic_song_preview_platform(platform: Platform) -> ApiResult<()> {
    if platform == Platform::Ytm {
        return Err(ApiError::bad_request(
            "YouTube Music 试听只允许使用受保护的 SABR 链路",
        ));
    }
    Ok(())
}

fn valid_web_po_token(value: &str) -> bool {
    (80..=2048).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'='))
}

fn validated_ytm_browser_stream_url(value: &str, po_token: &str) -> ApiResult<String> {
    if value.len() > 16 * 1024 || value.contains(['\r', '\n']) {
        return Err(ApiError::bad_request("YouTube Music 音频 URL 无效"));
    }
    let url = reqwest::Url::parse(value)
        .map_err(|_| ApiError::bad_request("YouTube Music 音频 URL 无效"))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let trusted_host = host == "googlevideo.com" || host.ends_with(".googlevideo.com");
    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    let audio = params
        .get("mime")
        .is_some_and(|mime| mime.starts_with("audio/"));
    if url.scheme() != "https"
        || !trusted_host
        || url.path() != "/videoplayback"
        || params.get("pot").map(String::as_str) != Some(po_token)
        || !audio
    {
        return Err(ApiError::bad_request(
            "YouTube Music 音频 URL 不属于受信任的 GVS 来源",
        ));
    }
    Ok(url.into())
}

fn validated_fresh_ytm_download_url(value: &str, po_token: &str) -> ApiResult<String> {
    let url = validated_ytm_browser_stream_url(value, po_token)?;
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| ApiError::bad_request("YouTube Music 音频 URL 无效"))?;
    let params: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
    let expires = params
        .get("expire")
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| ApiError::bad_request("YouTube Music 音频 URL 缺少有效期"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    if expires <= now.saturating_add(60) {
        return Err(ApiError::bad_request("YouTube Music 音频 URL 已过期"));
    }
    Ok(url)
}

fn ytm_download_stream_identity(value: &str) -> ApiResult<(u64, String, String)> {
    let parsed = reqwest::Url::parse(value)
        .map_err(|_| ApiError::bad_request("YouTube Music 音频 URL 无效"))?;
    let params: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
    let length = params
        .get("clen")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| ApiError::bad_request("YouTube Music 音频 URL 缺少媒体长度"))?;
    let mime = params
        .get("mime")
        .filter(|value| value.starts_with("audio/"))
        .cloned()
        .ok_or_else(|| ApiError::bad_request("YouTube Music 下载来源不是音频"))?;
    let itag = params
        .get("itag")
        .filter(|value| !value.is_empty() && value.len() <= 16)
        .cloned()
        .ok_or_else(|| ApiError::bad_request("YouTube Music 音频 URL 缺少格式标识"))?;
    Ok((length, mime, itag))
}

fn required_ytm_download_proofs(total: u64) -> ApiResult<usize> {
    let count = total.saturating_add(crate::protected_media::GVS_RANGE_CHUNK_BYTES - 1)
        / crate::protected_media::GVS_RANGE_CHUNK_BYTES;
    let count =
        usize::try_from(count).map_err(|_| ApiError::bad_request("YouTube Music 媒体长度无效"))?;
    if count == 0 || count > crate::protected_media::GVS_MAX_PROOFS {
        return Err(ApiError::bad_request(
            "YouTube Music 媒体过大，无法建立完整下载会话",
        ));
    }
    Ok(count)
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
    if ticket.cached || (ticket.url.is_empty() && ticket.protected_spool.is_none()) {
        refresh_song_preview_ticket(&state, &token, &mut ticket).await?;
    }
    if let Some(spool) = &ticket.protected_spool {
        let (start, end) = match range.as_deref() {
            Some(raw) => parse_range(raw, spool.total())
                .ok_or_else(|| ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "试听范围无效"))?,
            None => (0, spool.total() - 1),
        };
        let requested_end = range.as_ref().map(|_| end);
        let slice = spool
            .read_range(start, requested_end)
            .await
            .map_err(|error| ApiError::new(StatusCode::BAD_GATEWAY, error.to_string()))?;
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, slice.content_type)
            .header(header::CONTENT_LENGTH, slice.bytes.len().to_string())
            .header(
                header::CONTENT_RANGE,
                format!("bytes {}-{}/{}", slice.start, slice.end, slice.total),
            )
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, "no-store")
            .body(axum::body::Body::from(slice.bytes))
            .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()));
    }

    let mut upstream = request_song_preview_upstream(
        &state.preview_http,
        ticket.source.platform,
        &ticket.url,
        range.as_deref(),
    )
    .await?;
    let mut status = preview_upstream_status(&upstream);
    if ticket.browser_resolved {
        tracing::warn!(
            range = range.as_deref().unwrap_or("none"),
            status = %status,
            "YTM GVS 代理请求"
        );
    }

    // 网易云 vkey、QQ sip 等短链可能在票据有效期内先过期。只在明确的鉴权/失效
    // 状态下按原 source + quality 刷新一次，并原样重放 Range；单次请求绝不死循环。
    if song_preview_url_needs_refresh(status) {
        refresh_song_preview_ticket(&state, &token, &mut ticket).await?;
        upstream = request_song_preview_upstream(
            &state.preview_http,
            ticket.source.platform,
            &ticket.url,
            range.as_deref(),
        )
        .await?;
        status = preview_upstream_status(&upstream);
    }

    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        return Err(ApiError::new(status, format!("试听源返回 HTTP {status}")));
    }
    let mut upstream_headers = upstream.headers().clone();
    let mut content_type = preview_audio_mime_for_url(&upstream_headers, &ticket.url);
    if content_type.is_none() {
        // 某些过期短链用 200 + HTML/JSON 错误页伪装成功；刷新一次再判，绝不把
        // 错误页送进 audio 或缓存成一首“歌曲”。
        refresh_song_preview_ticket(&state, &token, &mut ticket).await?;
        upstream = request_song_preview_upstream(
            &state.preview_http,
            ticket.source.platform,
            &ticket.url,
            range.as_deref(),
        )
        .await?;
        status = preview_upstream_status(&upstream);
        if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
            return Err(ApiError::new(status, format!("试听源返回 HTTP {status}")));
        }
        upstream_headers = upstream.headers().clone();
        content_type = preview_audio_mime_for_url(&upstream_headers, &ticket.url);
    }
    let content_type = content_type
        .ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY, "试听源返回的不是音频内容"))?;
    let persistent_cache_enabled = state.config.to_settings().stream_cache_enabled;
    let response_segment = preview_response_segment(status, &upstream_headers);
    state.stream_waveforms.media_started(&cache_key);
    if persistent_cache_enabled {
        if ticket.browser_resolved {
            // WEB_REMIX 的同一张 GVS 票据还要承受 MP4 probe/seek。播放期间绝不能再
            // 开一个整轨缓存请求与它并发；等会话空闲后再补缓存。
            schedule_song_preview_cache_when_session_idle(
                state.clone(),
                token.clone(),
                ticket.clone(),
                cache_key.clone(),
                content_type.clone(),
            );
        } else {
            // Android 的播放器和后台整轨 CDN 下载共用一条移动网络与同一块闪存，首播
            // 400ms 后再拉第二份整曲会直接表现成卡顿/爆音。移动端改为等会话空闲。
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

fn schedule_protected_spool_cache(
    state: Arc<AppState>,
    spool: Arc<crate::protected_media::ProtectedMediaSpool>,
    source: SongSource,
    quality: Quality,
    cache_key: String,
) {
    if !state.config.to_settings().stream_cache_enabled {
        return;
    }
    tokio::spawn(async move {
        if spool.wait_complete().await.is_err() {
            return;
        }
        let root = crate::stream_cache::StreamCache::cache_dir(&state.config);
        let Ok(Some(mut writer)) = state
            .stream_cache
            .begin_write(
                &root,
                cache_key.clone(),
                &source,
                quality,
                spool.content_type().to_string(),
                Some(spool.total()),
            )
            .await
        else {
            return;
        };
        let mut offset = 0_u64;
        while offset < spool.total() {
            let requested_end = offset
                .saturating_add(crate::protected_media::LOCAL_RANGE_CHUNK_BYTES - 1)
                .min(spool.total() - 1);
            let Ok(slice) = spool.read_range(offset, Some(requested_end)).await else {
                return;
            };
            if !matches!(writer.write_chunk(&slice.bytes).await, Ok(true)) {
                return;
            }
            offset = slice.end.saturating_add(1);
        }
        if matches!(writer.finish().await, Ok(true)) {
            let path = crate::stream_cache::StreamCache::media_path(&root, &cache_key);
            state
                .stream_waveforms
                .observe(cache_key, path, spool.total(), true);
        }
    });
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
            self.waveforms.observe_with_total(
                self.cache_key.clone(),
                self.writer.partial_path().to_path_buf(),
                written,
                self.total,
                false,
            );
            self.published_bytes = written;
        }
        Ok(())
    }

    async fn finish(mut self, reached_eof: bool) -> std::io::Result<()> {
        let partial_path = self.writer.partial_path().to_path_buf();
        if !reached_eof || self.response_bytes != self.total {
            // Drop 删除不完整 partial；不能把有缺口的文件提交成可命中缓存。
            self.waveforms
                .discard_cache_path(&self.cache_key, &partial_path);
            return Ok(());
        }
        let committed = match self.writer.finish().await {
            Ok(committed) => committed,
            Err(error) => {
                self.waveforms
                    .discard_cache_path(&self.cache_key, &partial_path);
                return Err(error);
            }
        };
        if committed {
            self.waveforms.observe(
                self.cache_key.clone(),
                crate::stream_cache::StreamCache::media_path(&self.cache_root, &self.cache_key),
                self.total,
                true,
            );
        } else {
            self.waveforms
                .discard_cache_path(&self.cache_key, &partial_path);
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
    let refreshed = if ticket.source.platform == Platform::Ytm && ticket.browser_resolved {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "YouTube Music WebPO 地址已失效，请重新播放",
        ));
    } else {
        provider
            .preview_url_at_quality(&ticket.source, ticket.quality)
            .await?
    };
    ticket.url = refreshed.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "这个平台暂时无法刷新试听地址",
        )
    })?;
    ticket.cached = false;
    ticket.last_used_at = std::time::Instant::now();
    // token 也是刷新状态的一部分，整张覆盖比只更新 URL 更安全。
    state
        .song_previews
        .lock()
        .unwrap()
        .insert(token.to_string(), ticket.clone());
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
    let Some(cache_sequence) = state.stream_waveforms.begin_cache_sequence(&cache_key) else {
        return;
    };
    tokio::spawn(async move {
        // 先让 WebView 的首批缓冲独占链路；缓存是后台完整拉取，不参与首包延迟。
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        #[cfg(target_os = "android")]
        if !state.stream_waveforms.is_session_idle(&cache_key) {
            // 延迟任务醒来后用户可能已经重新播放同一首；此时宁可本轮不缓存，也
            // 不能让第二 GET 再次和 WebView 抢网络/闪存。
            state
                .stream_waveforms
                .cancel_cache_sequence(&cache_key, cache_sequence);
            return;
        }
        if !reservation.is_valid() || !reservation.acquire_slot().await {
            state
                .stream_waveforms
                .cancel_cache_sequence(&cache_key, cache_sequence);
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
        run_song_preview_cache_sequence(
            state,
            token,
            ticket,
            cache_key,
            content_type_hint,
            cache_sequence,
            reservation,
        )
        .await;
    });
}

const SONG_PREVIEW_CACHE_RETRY_DELAYS: [std::time::Duration; 2] = [
    std::time::Duration::from_secs(1),
    std::time::Duration::from_secs(4),
];
const SONG_PREVIEW_CACHE_ATTEMPTS: usize = SONG_PREVIEW_CACHE_RETRY_DELAYS.len() + 1;

fn song_preview_cache_retry_delay_after(attempt: usize) -> Option<std::time::Duration> {
    SONG_PREVIEW_CACHE_RETRY_DELAYS.get(attempt).copied()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewCacheOutcome {
    Complete,
    Cancelled,
}

async fn run_song_preview_cache_sequence(
    state: Arc<AppState>,
    token: String,
    mut ticket: SongPreviewTicket,
    cache_key: String,
    content_type_hint: String,
    cache_sequence: u64,
    initial_reservation: crate::stream_cache::StreamCacheReservation,
) {
    let mut reservation = Some(initial_reservation);
    for attempt in 0..SONG_PREVIEW_CACHE_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(SONG_PREVIEW_CACHE_RETRY_DELAYS[attempt - 1]).await;
            if !state.config.to_settings().stream_cache_enabled {
                state
                    .stream_waveforms
                    .cancel_cache_sequence(&cache_key, cache_sequence);
                return;
            }
            match refresh_background_preview_url(&state, &token, &ticket).await {
                Ok(url) => ticket.url = url,
                Err(error) => {
                    let retrying = song_preview_cache_retry_delay_after(attempt).is_some();
                    if !state.stream_waveforms.cache_attempt_failed(
                        &cache_key,
                        cache_sequence,
                        error.clone(),
                        retrying,
                    ) {
                        return;
                    }
                    if retrying {
                        tracing::debug!(attempt = attempt + 1, error = %error, "在线音频缓存刷新失败，等待重试");
                        continue;
                    }
                    record_song_preview_cache_failure(&state, &ticket, &error);
                    return;
                }
            }
            let Some(mut next) = state.stream_cache.reserve(cache_key.clone()) else {
                state
                    .stream_waveforms
                    .cancel_cache_sequence(&cache_key, cache_sequence);
                return;
            };
            if !next.acquire_slot().await {
                state
                    .stream_waveforms
                    .cancel_cache_sequence(&cache_key, cache_sequence);
                return;
            }
            reservation = Some(next);
        }

        let result = cache_song_preview_background(
            state.clone(),
            ticket.clone(),
            cache_key.clone(),
            content_type_hint.clone(),
            reservation
                .take()
                .expect("each cache attempt owns a fresh reservation"),
        )
        .await;
        match result {
            Ok(PreviewCacheOutcome::Complete) => return,
            Ok(PreviewCacheOutcome::Cancelled) => {
                state
                    .stream_waveforms
                    .cancel_cache_sequence(&cache_key, cache_sequence);
                return;
            }
            Err(error) => {
                let retrying = song_preview_cache_retry_delay_after(attempt).is_some();
                if !state.stream_waveforms.cache_attempt_failed(
                    &cache_key,
                    cache_sequence,
                    error.clone(),
                    retrying,
                ) {
                    return;
                }
                if retrying {
                    tracing::debug!(attempt = attempt + 1, error = %error, "在线音频后台缓存未完成，等待重试");
                    continue;
                }
                record_song_preview_cache_failure(&state, &ticket, &error);
                return;
            }
        }
    }
}

fn record_song_preview_cache_failure(state: &AppState, ticket: &SongPreviewTicket, error: &str) {
    tracing::warn!(source = %ticket.source.key, error, "在线音频后台缓存重试耗尽");
    state.activity_log.record_level(
        crate::activity_log::ActivityCategory::Network,
        crate::activity_log::ActivityLevel::Warn,
        "在线音频缓存失败",
        error,
    );
}

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
    let refreshed = if ticket.source.platform == Platform::Ytm && ticket.browser_resolved {
        return (!ticket.url.is_empty())
            .then(|| ticket.url.clone())
            .ok_or_else(|| "缓存来源地址无法刷新".to_string());
    } else {
        provider
            .preview_url_at_quality(&ticket.source, ticket.quality)
            .await
    };
    let url = refreshed
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "缓存来源地址无法刷新".to_string())?;
    let mut previews = state.song_previews.lock().unwrap();
    let _ = previews.update_url(token, url.clone());
    Ok(url)
}

async fn cache_song_preview_background(
    state: Arc<AppState>,
    ticket: SongPreviewTicket,
    cache_key: String,
    content_type_hint: String,
    reservation: crate::stream_cache::StreamCacheReservation,
) -> Result<PreviewCacheOutcome, String> {
    kdj_core::ensure_rustls_ring();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .referer(false)
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;
    let cache_root = crate::stream_cache::StreamCache::cache_dir(&state.config);
    let mut offset = 0_u64;
    let mut expected_total = None;
    let mut writer: Option<crate::stream_cache::StreamCacheWriter> = None;
    let mut reservation = Some(reservation);
    // 只在累计跨过一个有意义的增长量时 publish 给只读波形任务。每个网络 chunk
    // 都 flush 会把纯展示需求放大成大量 IO；最终提交会无条件再 publish 一次。
    let mut last_waveform_observed_bytes = 0_u64;

    // 绝大多数 CDN 对 bytes=0- 一次返回整首；循环同时兼容主动限制单段大小的源。
    for _ in 0..2048 {
        if !state.config.to_settings().stream_cache_enabled
            || reservation.as_ref().is_some_and(|item| !item.is_valid())
            || writer.as_ref().is_some_and(|item| !item.is_valid())
        {
            return Ok(PreviewCacheOutcome::Cancelled);
        }
        let requested_range = format!("bytes={offset}-");
        let mut response = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            send_song_preview_upstream(
                &client,
                ticket.source.platform,
                &ticket.url,
                Some(&requested_range),
            ),
        )
        .await
        .map_err(|_| "缓存源连接超时".to_string())??;
        let status = preview_upstream_status(&response);
        if song_preview_url_needs_refresh(status) {
            // URL 或上游边界一旦失效，不能把刷新后的响应拼到旧 partial。外层会
            // 重新解析 URL、创建新 writer，并严格从 bytes=0- 开始下一次尝试。
            return Err(format!("缓存源返回 HTTP {status}"));
        }
        let Some(mime) = preview_audio_mime(response.headers(), &content_type_hint) else {
            return Err("缓存源返回非音频内容".into());
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
                return Ok(PreviewCacheOutcome::Cancelled);
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
                return Ok(PreviewCacheOutcome::Cancelled);
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
                    state.stream_waveforms.observe_with_total(
                        cache_key.clone(),
                        writer.partial_path().to_path_buf(),
                        last_waveform_observed_bytes,
                        segment.total,
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
                return Ok(PreviewCacheOutcome::Complete);
            }
            return Ok(PreviewCacheOutcome::Cancelled);
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

/// GVS 常把 WebM/MP4 音频标成 application/octet-stream。此前一律伪装成
/// audio/mpeg，导致原生播放器拿 MP3 hint 探测 WebM，最终报 unsupported format。
/// 播放 API 的受信任 URL 已携带真实 mime，应以它作为降级值。
fn preview_audio_mime_for_url(headers: &HeaderMap, url: &str) -> Option<String> {
    let fallback = reqwest::Url::parse(url)
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find_map(|(key, value)| (key == "mime").then(|| value.into_owned()))
        })
        .filter(|mime| mime.starts_with("audio/"))
        .unwrap_or_else(|| "audio/mpeg".to_string());
    preview_audio_mime(headers, &fallback)
}

fn song_preview_url_needs_refresh(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND | StatusCode::GONE
    )
}

fn is_googlevideo_url(value: &str) -> bool {
    reqwest::Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "googlevideo.com" || host.ends_with(".googlevideo.com"))
}

fn gvs_upstream_range(url: &str, range: &str) -> String {
    if !is_googlevideo_url(url) {
        return range.to_string();
    }
    let Some(start) = range
        .trim()
        .strip_prefix("bytes=")
        .and_then(|value| value.strip_suffix('-'))
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return range.to_string();
    };
    const WEB_MEDIA_CHUNK_BYTES: u64 = 1024 * 1024;
    format!(
        "bytes={start}-{}",
        start.saturating_add(WEB_MEDIA_CHUNK_BYTES - 1)
    )
}

async fn send_song_preview_upstream(
    client: &reqwest::Client,
    platform: Platform,
    url: &str,
    range: Option<&str>,
) -> Result<reqwest::Response, String> {
    if platform == Platform::Soundcloud {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(range) = range {
            let value = range
                .parse::<reqwest::header::HeaderValue>()
                .map_err(|_| "试听范围无效".to_string())?;
            headers.insert(reqwest::header::RANGE, value);
        }
        return kdj_providers::net::guarded_media_get(
            url,
            &headers,
            kdj_providers::net::GuardedMediaPolicy {
                max_redirects: 5,
                connect_timeout: std::time::Duration::from_secs(10),
                read_timeout: std::time::Duration::from_secs(30),
            },
        )
        .await
        .map_err(|error| format!("试听源连接失败：{error}"));
    }

    let mut request = if is_googlevideo_url(url) {
        kdj_providers::youtubemusic::gvs_playback_request(client, url)
    } else {
        client.get(url)
    };
    if let Some(range) = range {
        // Keep each protected GVS response finite. The loopback source will request the next
        // contiguous segment after EOF; this also avoids leaving an aborted open-ended probe alive
        // while MP4 immediately seeks elsewhere.
        request = request.header(reqwest::header::RANGE, gvs_upstream_range(url, range));
    }
    request
        .send()
        .await
        .map_err(|error| format!("试听源连接失败：{error}"))
}

async fn request_song_preview_upstream(
    client: &reqwest::Client,
    platform: Platform,
    url: &str,
    range: Option<&str>,
) -> ApiResult<reqwest::Response> {
    send_song_preview_upstream(client, platform, url, range)
        .await
        .map_err(|error| ApiError::new(StatusCode::BAD_GATEWAY, error))
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
// 链接集合默认完整展开；各 provider 把 0 解释为 full_listing。
const INTAKE_RESOLVE_LIMIT: usize = 0;

/// 用户一次投喂里的条目可以并行解析；各 provider 自己的同资源单飞与缓存负责
/// 合并重复请求，不在这里让互不相关的平台彼此排队。
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
    let items: Vec<IntakeItem> = futures_util::stream::iter(entries.into_iter().map(|entry| {
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

async fn pending_download_preparations(
    axum::Extension(ctx): axum::Extension<Ctx>,
) -> Json<Vec<crate::downloads::PendingDownloadPreparation>> {
    Json(ctx.downloads.pending_download_preparations())
}

#[derive(Deserialize)]
struct PreparedDownloadSourceBody {
    #[serde(default)]
    attempt: u64,
    #[serde(default)]
    proofs: Vec<String>,
    #[serde(default)]
    resolved_urls: Vec<String>,
    #[serde(default)]
    youtube_hls_ticket: String,
}

fn loopback_download_origin(headers: &HeaderMap) -> ApiResult<String> {
    let authority = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::bad_request("本地下载服务地址缺失"))?;
    let origin = reqwest::Url::parse(&format!("http://{authority}"))
        .map_err(|_| ApiError::bad_request("本地下载服务地址无效"))?;
    if !matches!(
        origin.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    ) || origin.port().is_none()
    {
        return Err(ApiError::bad_request("本地下载服务地址不受信任"));
    }
    Ok(format!("http://{authority}"))
}

async fn attach_prepared_download_source(
    axum::Extension(ctx): axum::Extension<Ctx>,
    Extension(media): Extension<MediaToken>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<PreparedDownloadSourceBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let task = ctx
        .downloads
        .get(&id)
        .ok_or_else(|| ApiError::not_found("任务不存在"))?;
    if !ctx.downloads.preparation_is_current(&id, body.attempt) {
        return Err(ApiError::bad_request("下载准备已经过期"));
    }
    let prepared = match task.platform {
        Platform::Ytm => {
            if task.kind != TaskKind::Audio
                || body.proofs.is_empty()
                || body.proofs.len() > crate::protected_media::GVS_MAX_PROOFS
                || body.proofs.len() != body.resolved_urls.len()
            {
                return Err(ApiError::bad_request("YouTube Music 下载证明数量无效"));
            }
            let mut urls = Vec::with_capacity(body.resolved_urls.len());
            let mut stream_identity: Option<(u64, String, String)> = None;
            for (proof, resolved_url) in body.proofs.iter().zip(&body.resolved_urls) {
                if !valid_web_po_token(proof) {
                    return Err(ApiError::bad_request("YouTube Music WebPO token 无效"));
                }
                let url = validated_fresh_ytm_download_url(resolved_url, proof)?;
                let current_identity = ytm_download_stream_identity(&url)?;
                if stream_identity
                    .as_ref()
                    .is_some_and(|expected| expected != &current_identity)
                {
                    return Err(ApiError::bad_request(
                        "YouTube Music 分段授权不属于同一音频流",
                    ));
                }
                stream_identity.get_or_insert(current_identity);
                urls.push(url);
            }
            let total = stream_identity
                .as_ref()
                .map(|identity| identity.0)
                .ok_or_else(|| ApiError::bad_request("YouTube Music 下载来源无效"))?;
            if required_ytm_download_proofs(total)? != urls.len() {
                return Err(ApiError::bad_request(
                    "YouTube Music 下载证明数量与媒体长度不匹配",
                ));
            }
            let path = crate::protected_media::spool_path(&ctx.state.config.data_dir, "m4a");
            let spool = crate::protected_media::ProtectedMediaSpool::start(
                &ctx.state.youtube_media_http,
                &urls[0],
                &urls,
                path,
            )
            .await
            .map_err(|error| ApiError::new(StatusCode::BAD_GATEWAY, error.to_string()))?;
            let completed = spool.wait_complete();
            tokio::pin!(completed);
            loop {
                tokio::select! {
                    result = &mut completed => {
                        result.map_err(|error| ApiError::new(StatusCode::BAD_GATEWAY, error.to_string()))?;
                        if !ctx.downloads.preparation_is_current(&id, body.attempt) {
                            spool.cancel();
                            return Err(ApiError::bad_request("下载已取消"));
                        }
                        break;
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                        if !ctx.downloads.preparation_is_current(&id, body.attempt) {
                            spool.cancel();
                            return Err(ApiError::bad_request("下载已取消"));
                        }
                        let (downloaded, total) = spool.progress();
                        ctx.downloads.preparation_progress(
                            &id,
                            body.attempt,
                            downloaded,
                            total,
                        );
                    }
                }
            }
            ctx.downloads
                .preparation_progress(&id, body.attempt, spool.total(), spool.total());
            let path = spool.persist();
            let mut prepared = reqwest::Url::from_file_path(&path).map_err(|_| {
                ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "媒体会话路径无效")
            })?;
            prepared
                .query_pairs_mut()
                .append_pair("mime", spool.content_type());
            prepared.into()
        }
        Platform::Youtube => {
            if task.kind != TaskKind::Video
                || body.youtube_hls_ticket.len() != 64
                || !body
                    .youtube_hls_ticket
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(ApiError::bad_request("YouTube HLS 下载票据无效"));
            }
            let expected = ctx
                .downloads
                .video_preparation_request(&id, body.attempt)
                .ok_or_else(|| ApiError::bad_request("这条任务不接受 YouTube HLS 来源"))?;
            let source = ctx
                .state
                .youtube_hls_resource(&body.youtube_hls_ticket)
                .filter(|resource| !resource.cancel.is_cancelled())
                .ok_or_else(|| ApiError::bad_request("YouTube HLS 下载票据已失效"))?;
            if expected.bvid.trim().is_empty()
                || source.video_id != expected.bvid.trim()
                || source.max_height != expected.max_height
            {
                return Err(ApiError::bad_request("YouTube HLS 下载票据与任务不匹配"));
            }
            let origin = loopback_download_origin(&headers)?;
            let session_ticket = ctx.state.issue_youtube_hls_resource(
                source.video_id,
                source.url,
                source.user_agent,
                source.proof_token,
                source.max_height,
                tokio_util::sync::CancellationToken::new(),
            );
            ctx.state
                .cancel_youtube_hls_resource(&body.youtube_hls_ticket);
            format!(
                "{origin}{path}",
                path = local_youtube_hls_url(&session_ticket, &media),
            )
        }
        _ => return Err(ApiError::bad_request("当前平台不需要外部媒体准备")),
    };
    if let Err(error) = ctx
        .downloads
        .attach_prepared_source(&id, body.attempt, prepared.clone())
    {
        if let Ok(url) = reqwest::Url::parse(&prepared) {
            if url.scheme() == "file" {
                if let Ok(path) = url.to_file_path() {
                    let _ = tokio::fs::remove_file(path).await;
                }
            } else if let Some(ticket) = url.path().strip_prefix("/api/video/youtube/hls/") {
                ctx.state.cancel_youtube_hls_resource(ticket);
            }
        }
        return Err(ApiError::bad_request(error.to_string()));
    }
    Ok(Json(json!({ "prepared": true })))
}

#[derive(Deserialize)]
struct FailedDownloadPreparationBody {
    #[serde(default)]
    attempt: u64,
    error: String,
}

async fn fail_download_preparation(
    axum::Extension(ctx): axum::Extension<Ctx>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<FailedDownloadPreparationBody>,
) -> ApiResult<Json<DownloadTask>> {
    let message = body.error.trim();
    let message = if message.is_empty() {
        "下载来源准备失败"
    } else {
        message
    };
    let task = ctx
        .downloads
        .fail_preparation(&id, body.attempt, message)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(Json(task))
}

async fn start_downloads(
    State(state): State<Arc<AppState>>,
    axum::Extension(ctx): axum::Extension<Ctx>,
) -> Json<serde_json::Value> {
    // 「开始」是队列的统一执行入口：新排队任务和之前失败、可重试的歌曲
    // 应该在同一次点击里一起跑，不能逼用户再逐行点一遍「重试」。
    let retried = restart_inactive_tasks(state, ctx.downloads.clone());
    ctx.downloads.release_queued();
    Json(json!({ "started": true, "retried": retried }))
}

async fn pause_downloads(axum::Extension(ctx): axum::Extension<Ctx>) -> Json<serde_json::Value> {
    Json(json!({ "paused": ctx.downloads.pause_all() }))
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
    let hold = payload.hold;
    let tasks = payload
        .sources
        .into_iter()
        .map(|source| {
            if matches!(source.platform, Platform::Bilibili | Platform::Youtube) {
                let platform = source.platform;
                let request = VideoDownloadRequest {
                    platform,
                    bvid: source
                        .payload
                        .get(if platform == Platform::Bilibili {
                            "bvid"
                        } else {
                            "video_id"
                        })
                        .and_then(serde_json::Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or(source.key.as_str())
                        .to_string(),
                    page_index: source
                        .payload
                        .get("page_index")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0) as usize,
                    page_count: source
                        .payload
                        .get("page_count")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0) as usize,
                    page_title: source
                        .payload
                        .get("page_title")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    max_height: source
                        .payload
                        .get("max_height")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or(settings.video_max_height),
                    audio_only: source
                        .payload
                        .get("audio_only")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    transcode: platform != Platform::Youtube
                        && source
                            .payload
                            .get("transcode")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(settings.video_transcode),
                    dest_dir: dest_dir.clone(),
                    title: source.title.clone(),
                    artist: source.artist_text(),
                    cover: source.cover.clone(),
                    ..Default::default()
                };
                enqueue_video(state.clone(), ctx.downloads.clone(), request, hold)
            } else {
                enqueue_audio(
                    state.clone(),
                    ctx.downloads.clone(),
                    source,
                    quality,
                    analyze,
                    dest_dir.clone(),
                    hold,
                )
            }
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

async fn cancel_all_downloads(
    axum::Extension(ctx): axum::Extension<Ctx>,
) -> Json<serde_json::Value> {
    Json(json!({ "canceled": ctx.downloads.cancel_all() }))
}

async fn retry_download(
    State(state): State<Arc<AppState>>,
    axum::Extension(ctx): axum::Extension<Ctx>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<DownloadTask>> {
    retry_task(state, ctx.downloads.clone(), &id)
        .map(Json)
        .map_err(ApiError::from)
}

#[derive(Deserialize)]
struct DownloadQualityBody {
    quality: Quality,
}

async fn update_download_quality(
    axum::Extension(ctx): axum::Extension<Ctx>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<DownloadQualityBody>,
) -> ApiResult<Json<DownloadTask>> {
    ctx.downloads
        .set_queued_audio_quality(&id, body.quality)
        .map(Json)
        .map_err(ApiError::from)
}

#[derive(Deserialize)]
struct DownloadHeightBody {
    max_height: i64,
}

async fn update_download_height(
    axum::Extension(ctx): axum::Extension<Ctx>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<DownloadHeightBody>,
) -> ApiResult<Json<DownloadTask>> {
    ctx.downloads
        .set_pending_video_height(&id, body.max_height)
        .map(Json)
        .map_err(ApiError::from)
}

async fn clear_downloads(axum::Extension(ctx): axum::Extension<Ctx>) -> Json<serde_json::Value> {
    Json(json!({ "removed": ctx.downloads.clear_inactive() }))
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
        TaskState::Paused | TaskState::Done | TaskState::Failed | TaskState::Canceled
    ) {
        return Err(ApiError::bad_request(
            "只能移除暂停或已结束的任务；请先暂停",
        ));
    }
    ctx.downloads
        .remove_finished(&id)
        .ok_or_else(|| ApiError::bad_request("任务无法移除"))?;
    Ok(Json(json!({ "removed": true })))
}

// ---------------------------------------------------------------- 视频

async fn youtube_protected_preview_player_script(
    State(state): State<Arc<AppState>>,
    Json(body): Json<YtmProtectedPlayerScriptBody>,
) -> ApiResult<Response> {
    let javascript = state
        .youtube
        .protected_preview_player_script(&body.player_url)
        .await?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "private, max-age=3600"),
        ],
        javascript,
    )
        .into_response())
}

#[derive(Deserialize)]
struct YoutubeBeginHlsBody {
    bvid: String,
    user_agent: String,
    #[serde(default)]
    max_height: Option<i64>,
}

#[derive(Serialize)]
struct YoutubeBeginHlsResponse {
    preparation_id: String,
    visitor_data: String,
    data_sync_id: String,
    gvs_binding: &'static str,
    n_challenge: String,
    player_url: String,
}

#[derive(Deserialize)]
struct YoutubeCompleteHlsBody {
    preparation_id: String,
    n_value: String,
    gvs_po_token: String,
}

#[derive(Serialize)]
struct YoutubeCompleteHlsResponse {
    path: String,
}

fn valid_youtube_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn trusted_youtube_hls_resource_url(value: &str) -> ApiResult<reqwest::Url> {
    if value.is_empty() || value.len() > 16 * 1024 || value.contains(['\r', '\n']) {
        return Err(ApiError::bad_request("YouTube HLS URL 无效"));
    }
    let url =
        reqwest::Url::parse(value).map_err(|_| ApiError::bad_request("YouTube HLS URL 无效"))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = url.path();
    let rejection = if url.scheme() != "https" {
        Some("协议")
    } else if url.port_or_known_default() != Some(443) {
        Some("端口")
    } else if host != "googlevideo.com" && !host.ends_with(".googlevideo.com") {
        Some("域名")
    } else if !(path.starts_with("/api/manifest/") || path.starts_with("/videoplayback/")) {
        Some(if path.starts_with("/api/manifest/") {
            "其他 manifest 路径"
        } else if path.starts_with("/videoplayback") {
            "videoplayback 路径形态"
        } else if path.starts_with("/initplayback") {
            "initplayback 路径"
        } else {
            "其他路径类型"
        })
    } else if !url.username().is_empty() || url.password().is_some() {
        Some("用户信息")
    } else if url.fragment().is_some() {
        Some("片段标识")
    } else {
        None
    };
    if let Some(rejection) = rejection {
        return Err(ApiError::bad_request(format!(
            "YouTube HLS URL 不受信任（{rejection}）"
        )));
    }
    Ok(url)
}

fn percent_encode_hls_path_segment(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        // BgUtils' web-safe token intentionally keeps base64 padding. yt-dlp inserts that token
        // verbatim into the `/pot/<token>` manifest path; changing `=` to `%3D` changes the raw
        // path-bound capability seen by GVS. Keep legal padding while still escaping separators
        // and every non-web-safe byte.
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'=') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    encoded
}

fn percent_decode_hls_path_segment(value: &str) -> Option<String> {
    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex(*bytes.get(index + 1)?)?;
            let low = hex(*bytes.get(index + 2)?)?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// yt-dlp's current WEB Safari path places the GVS proof immediately before the final HLS
/// `file/index.m3u8` or `playlist/index.m3u8` suffix. The protected playlist then emits segment
/// paths that already contain that proof; inventing a `pot` query for a segment makes GVS reject
/// an otherwise valid URL. Keeping all of this server-side prevents the proof and upstream URL
/// from entering the privileged WebView.
fn hls_url_with_proof(value: &str, proof_token: &str) -> ApiResult<String> {
    if !kdj_providers::youtube::valid_proof_token(proof_token) {
        return Err(ApiError::bad_request("YouTube GVS 凭证无效"));
    }
    let url = trusted_youtube_hls_resource_url(value)?;
    let encoded_proof = percent_encode_hls_path_segment(proof_token);
    if url.path().contains("/pot/") {
        let path = url.path();
        let encoded_inherited = path
            .split_once("/pot/")
            .and_then(|(_, remainder)| remainder.split('/').next());
        // GoogleVideo may canonicalize the inherited padding from `=` to `%3D` (and an encoded
        // separator to `%2F`) when it writes child playlists. Compare the decoded path segment,
        // but retain the exact upstream spelling and still require one unambiguous `/pot/` slot.
        if path.matches("/pot/").count() == 1
            && encoded_inherited
                .and_then(percent_decode_hls_path_segment)
                .is_some_and(|inherited| inherited == proof_token)
        {
            return Ok(url.into());
        }
        return Err(ApiError::bad_request(
            "YouTube HLS 分片继承了不匹配的播放证明",
        ));
    }
    if url.path().starts_with("/videoplayback/") {
        return Err(ApiError::bad_request("YouTube HLS 分片没有继承播放证明"));
    }
    let path = url.path();
    let suffix = ["/file/index.m3u8", "/playlist/index.m3u8"]
        .into_iter()
        .find(|suffix| path.ends_with(suffix))
        .ok_or_else(|| ApiError::bad_request("YouTube HLS 清单路径无效"))?;
    let prefix = path
        .strip_suffix(suffix)
        .ok_or_else(|| ApiError::bad_request("YouTube HLS 清单路径无效"))?;
    let protected_path = format!("{prefix}/pot/{}{suffix}", encoded_proof);
    let host = url
        .host_str()
        .ok_or_else(|| ApiError::bad_request("YouTube HLS URL 无效"))?;
    let query = url
        .query()
        .map(|value| format!("?{value}"))
        .unwrap_or_default();
    Ok(format!("https://{host}{protected_path}{query}"))
}

fn valid_hls_n_value(value: &str) -> bool {
    (1..=512).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn hls_n_challenge(value: &str) -> ApiResult<Option<String>> {
    let url = trusted_youtube_hls_resource_url(value)?;
    let segments = url
        .path_segments()
        .ok_or_else(|| ApiError::bad_request("YouTube HLS 清单路径无效"))?
        .collect::<Vec<_>>();
    let value = segments
        .windows(2)
        .find(|pair| pair[0] == "n")
        .map(|pair| pair[1].to_string());
    if value
        .as_deref()
        .is_some_and(|value| !valid_hls_n_value(value))
    {
        return Err(ApiError::bad_request("YouTube HLS n challenge 无效"));
    }
    Ok(value)
}

fn hls_url_with_solved_n(value: &str, challenge: &str, solved: &str) -> ApiResult<String> {
    let url = trusted_youtube_hls_resource_url(value)?;
    if challenge.is_empty() {
        if !solved.is_empty() {
            return Err(ApiError::bad_request("YouTube HLS n 变换不匹配"));
        }
        return Ok(url.into());
    }
    if !valid_hls_n_value(challenge) || !valid_hls_n_value(solved) {
        return Err(ApiError::bad_request("YouTube HLS n 变换无效"));
    }
    let marker = format!("/n/{challenge}");
    if url.path().matches(&marker).count() != 1 {
        return Err(ApiError::bad_request("YouTube HLS n challenge 已变化"));
    }
    let replaced = url.as_str().replacen(&marker, &format!("/n/{solved}"), 1);
    trusted_youtube_hls_resource_url(&replaced).map(Into::into)
}

fn hls_variant_height(line: &str) -> Option<i64> {
    let raw = line.split("RESOLUTION=").nth(1)?.split(',').next()?;
    raw.split_once('x')?.1.parse().ok()
}

fn split_hls_attribute_fields(value: &str) -> Vec<&str> {
    let mut fields = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (offset, character) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && character == '\\' {
            escaped = true;
        } else if character == '"' {
            quoted = !quoted;
        } else if character == ',' && !quoted {
            fields.push(&value[start..offset]);
            start = offset + 1;
        }
    }
    fields.push(&value[start..]);
    fields
}

fn hls_attribute_value<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let (_, attributes) = line.split_once(':')?;
    split_hls_attribute_fields(attributes)
        .into_iter()
        .find_map(|field| {
            let (key, value) = field.trim().split_once('=')?;
            (key == name).then_some(value.trim().trim_matches('"'))
        })
}

fn hls_variant_is_muxed_h264_aac(line: &str) -> bool {
    let Some(codecs) = hls_attribute_value(line, "CODECS") else {
        return false;
    };
    let codecs = codecs.to_ascii_lowercase();
    let mut h264 = false;
    let mut aac = false;
    for codec in codecs.split(',').map(str::trim) {
        h264 |= codec.starts_with("avc1.") || codec.starts_with("avc3.");
        // The native YouTube downloader performs a fixed, decode-free transmux and therefore
        // accepts the AAC-LC profile it can preserve exactly. HE-AAC would require a different
        // elementary-stream path and must not be advertised as the same fixed rendition.
        aac |= codec == "mp4a.40.2";
    }
    h264 && aac
}

fn strip_hls_rendition_group_attributes(line: &str) -> String {
    const GROUP_ATTRIBUTES: [&str; 4] = ["AUDIO", "VIDEO", "SUBTITLES", "CLOSED-CAPTIONS"];
    let Some((tag, attributes)) = line.split_once(':') else {
        return line.to_string();
    };
    let kept = split_hls_attribute_fields(attributes)
        .into_iter()
        .filter(|field| {
            field
                .trim()
                .split_once('=')
                .is_none_or(|(key, _)| !GROUP_ATTRIBUTES.contains(&key))
        })
        .collect::<Vec<_>>();
    format!("{tag}:{}", kept.join(","))
}

fn local_youtube_hls_url(ticket: &str, media: &MediaToken) -> String {
    format!(
        "/api/video/youtube/hls/{ticket}?kdj_media_token={}",
        media.expose()
    )
}

fn rewrite_hls_uri(
    state: &AppState,
    media: &MediaToken,
    resource: &YoutubeHlsResource,
    base: &reqwest::Url,
    raw: &str,
) -> ApiResult<String> {
    if raw.is_empty() || raw.len() > 16 * 1024 || raw.contains(['\r', '\n']) {
        return Err(ApiError::bad_request("YouTube HLS 子资源地址无效"));
    }
    let resolved = base
        .join(raw)
        .map_err(|_| ApiError::bad_request("YouTube HLS 子资源地址无效"))?;
    let protected =
        hls_url_with_proof(resolved.as_str(), &resource.proof_token).map_err(|error| {
            ApiError::new(
                error.status,
                format!("YouTube HLS 子资源：{}", error.detail),
            )
        })?;
    let ticket = state.issue_youtube_hls_resource(
        resource.video_id.clone(),
        protected,
        resource.user_agent.clone(),
        resource.proof_token.clone(),
        resource.max_height,
        resource.cancel.clone(),
    );
    Ok(local_youtube_hls_url(&ticket, media))
}

fn rewrite_hls_uri_attributes(
    line: &str,
    mut rewrite: impl FnMut(&str) -> ApiResult<String>,
) -> ApiResult<String> {
    let mut output = String::with_capacity(line.len());
    let mut remainder = line;
    while let Some(start) = remainder.find("URI=\"") {
        let value_start = start + 5;
        let Some(relative_end) = remainder[value_start..].find('"') else {
            return Err(ApiError::bad_request("YouTube HLS URI 属性无效"));
        };
        let value_end = value_start + relative_end;
        output.push_str(&remainder[..value_start]);
        output.push_str(&rewrite(&remainder[value_start..value_end])?);
        output.push('"');
        remainder = &remainder[value_end + 1..];
    }
    output.push_str(remainder);
    Ok(output)
}

fn rewrite_youtube_hls_playlist(
    state: &AppState,
    media: &MediaToken,
    resource: &YoutubeHlsResource,
    base: &reqwest::Url,
    text: &str,
) -> ApiResult<String> {
    if !text.trim_start().starts_with("#EXTM3U") {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "YouTube HLS 上游没有返回播放清单",
        ));
    }
    let selected_variant_height = text
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("#EXT-X-STREAM-INF:"))
        .filter(|line| hls_variant_is_muxed_h264_aac(line))
        .filter_map(hls_variant_height)
        .filter(|height| *height <= resource.max_height)
        .max();
    let mut output = String::with_capacity(text.len() + 1024);
    let mut skip_variant_uri = false;
    let mut saw_variant = false;
    let mut kept_variants = 0usize;
    for line in text.lines() {
        let trimmed = line.trim();
        if skip_variant_uri {
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            skip_variant_uri = false;
            continue;
        }
        if trimmed.starts_with("#EXT-X-MEDIA:") {
            // KDJ deliberately serves one already-muxed H.264/AAC rendition. Alternate audio,
            // subtitle and accessibility groups are separate media paths; some also leave the
            // GoogleVideo origin. Exposing them lets AVFoundation select or prefetch a path that
            // was never covered by the one fixed playback proof.
            continue;
        }
        let filtered_variant;
        let line = if trimmed.starts_with("#EXT-X-STREAM-INF:") {
            saw_variant = true;
            if kept_variants > 0
                || !hls_variant_is_muxed_h264_aac(trimmed)
                || hls_variant_height(trimmed) != selected_variant_height
            {
                skip_variant_uri = true;
                continue;
            }
            kept_variants += 1;
            filtered_variant = strip_hls_rendition_group_attributes(line);
            filtered_variant.as_str()
        } else if trimmed.starts_with("#EXT-X-I-FRAME-STREAM-INF:") {
            // Trick-play playlists are an alternate media path. KDJ deliberately exposes one
            // exact muxed variant so WebKit cannot mask an upstream failure by probing or changing
            // to a lower rendition.
            continue;
        } else {
            line
        };

        let rewritten = if line.trim().starts_with('#') {
            rewrite_hls_uri_attributes(line, |raw| {
                rewrite_hls_uri(state, media, resource, base, raw)
            })?
        } else if line.trim().is_empty() {
            String::new()
        } else {
            rewrite_hls_uri(state, media, resource, base, line.trim())?
        };
        output.push_str(&rewritten);
        output.push('\n');
    }
    if saw_variant && kept_variants == 0 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "当前画质上限没有可播放的 YouTube HLS 变体",
        ));
    }
    Ok(output)
}

fn valid_hls_range(value: &str) -> bool {
    let Some(raw) = value.strip_prefix("bytes=") else {
        return false;
    };
    let Some((start, end)) = raw.split_once('-') else {
        return false;
    };
    !start.is_empty()
        && start.bytes().all(|byte| byte.is_ascii_digit())
        && (end.is_empty() || end.bytes().all(|byte| byte.is_ascii_digit()))
}

async fn youtube_begin_hls(
    State(state): State<Arc<AppState>>,
    Json(body): Json<YoutubeBeginHlsBody>,
) -> ApiResult<Json<YoutubeBeginHlsResponse>> {
    if !valid_youtube_video_id(&body.bvid)
        || !kdj_providers::youtube::valid_browser_user_agent(&body.user_agent)
        || !body.user_agent.contains("Safari/")
    {
        return Err(ApiError::bad_request("YouTube HLS 参数无效"));
    }
    let max_height = body
        .max_height
        .unwrap_or_else(|| state.config.to_settings().video_playback_max_height);
    if !(144..=4320).contains(&max_height) {
        return Err(ApiError::bad_request("YouTube 播放画质上限无效"));
    }
    // Identity, HLS and player assets come from the exact same watch page. A second homepage
    // request adds latency and can observe a different upstream session epoch.
    let context = state
        .youtube
        .protected_hls_context(&body.bvid, &body.user_agent)
        .await?;
    let identity = context.identity.clone();
    let n_challenge = hls_n_challenge(&context.manifest)?.unwrap_or_default();
    let preparation_id = state.issue_youtube_hls_preparation(
        body.bvid.clone(),
        context.manifest,
        n_challenge.clone(),
        body.user_agent,
        max_height,
    );
    let gvs_binding = match identity.gvs_binding {
        kdj_providers::provider::ProtectedPoTokenBinding::VideoId => "video_id",
        kdj_providers::provider::ProtectedPoTokenBinding::DataSyncId => "data_sync_id",
        kdj_providers::provider::ProtectedPoTokenBinding::VisitorData => "visitor_data",
    };
    Ok(Json(YoutubeBeginHlsResponse {
        preparation_id,
        visitor_data: identity.visitor_data,
        data_sync_id: identity.data_sync_id,
        gvs_binding,
        n_challenge,
        player_url: context.player_url,
    }))
}

async fn youtube_complete_hls(
    State(state): State<Arc<AppState>>,
    Json(body): Json<YoutubeCompleteHlsBody>,
) -> ApiResult<Json<YoutubeCompleteHlsResponse>> {
    if body.preparation_id.len() != 64
        || !body
            .preparation_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || !kdj_providers::youtube::valid_proof_token(&body.gvs_po_token)
    {
        return Err(ApiError::bad_request("YouTube HLS 完成参数无效"));
    }
    let preparation = state
        .take_youtube_hls_preparation(&body.preparation_id)
        .ok_or_else(|| ApiError::bad_request("YouTube HLS 准备已失效"))?;
    let manifest = hls_url_with_solved_n(
        &preparation.manifest,
        &preparation.n_challenge,
        &body.n_value,
    )?;
    let manifest = hls_url_with_proof(&manifest, &body.gvs_po_token)?;
    let ticket = state.issue_youtube_hls_resource(
        preparation.video_id,
        manifest,
        preparation.user_agent,
        body.gvs_po_token,
        preparation.max_height,
        tokio_util::sync::CancellationToken::new(),
    );
    Ok(Json(YoutubeCompleteHlsResponse {
        path: format!("/api/video/youtube/hls/{ticket}"),
    }))
}

async fn youtube_start_hls_session(
    State(state): State<Arc<AppState>>,
    AxumPath(ticket): AxumPath<String>,
) -> ApiResult<Json<YoutubeCompleteHlsResponse>> {
    let source = state
        .youtube_hls_resource(&ticket)
        .filter(|resource| !resource.cancel.is_cancelled())
        .ok_or_else(|| ApiError::not_found("YouTube HLS 准备票据已失效"))?;
    let ticket = state.issue_youtube_hls_resource(
        source.video_id,
        source.url,
        source.user_agent,
        source.proof_token,
        source.max_height,
        tokio_util::sync::CancellationToken::new(),
    );
    Ok(Json(YoutubeCompleteHlsResponse {
        path: format!("/api/video/youtube/hls/{ticket}"),
    }))
}

async fn youtube_revoke_hls_session(
    State(state): State<Arc<AppState>>,
    AxumPath(ticket): AxumPath<String>,
) -> ApiResult<Json<Value>> {
    if !state.cancel_youtube_hls_resource(&ticket) {
        return Err(ApiError::not_found("YouTube HLS 播放票据已失效"));
    }
    Ok(Json(json!({ "revoked": true })))
}

fn youtube_hls_upstream_request(
    client: &reqwest::Client,
    url: reqwest::Url,
    user_agent: &str,
    is_playlist: bool,
) -> reqwest::RequestBuilder {
    client
        .get(url)
        .header(header::ACCEPT_ENCODING, "identity")
        .header(
            header::ACCEPT,
            if is_playlist {
                "application/vnd.apple.mpegurl, application/x-mpegURL, */*"
            } else {
                "*/*"
            },
        )
        .header(header::REFERER, "https://www.youtube.com/")
        .header(header::USER_AGENT, user_agent)
    // Deliberately do not attach the captured youtube.com Cookie header. A browser does not send
    // YouTube-domain cookies to googlevideo.com; the signed URL plus the path-bound GVS proof is
    // the CDN capability. Manually widening cookie scope can create an identity mismatch and
    // unnecessarily exposes the account session to a different origin.
}

fn youtube_hls_segment_label(url: &reqwest::Url) -> String {
    let segments = url
        .path_segments()
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let numeric_value_after = |name: &str| {
        segments
            .windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1])
            .filter(|value| value.bytes().all(|byte| byte.is_ascii_digit()))
    };
    let range_value_after = |name: &str| {
        segments
            .windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1])
            .filter(|value| {
                value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'-')
            })
    };
    let query_value = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
            .filter(|value| {
                value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'-')
            })
    };
    let itag = numeric_value_after("itag").unwrap_or("未知");
    let sequence = numeric_value_after("sq")
        .map(str::to_string)
        .or_else(|| query_value("sq"))
        .unwrap_or_else(|| "未知".into());
    let range = range_value_after("range")
        .map(str::to_string)
        .or_else(|| query_value("range"))
        .unwrap_or_else(|| "未知".into());
    format!("媒体分片 itag={itag} sq={sequence} range={range}")
}

fn youtube_hls_segment_length_hint(url: &reqwest::Url) -> Option<u64> {
    let path_range = url
        .path_segments()
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|pair| pair[0] == "range")
        .map(|pair| pair[1].to_string());
    let raw = path_range.or_else(|| {
        url.query_pairs()
            .find(|(key, _)| key == "range")
            .map(|(_, value)| value.into_owned())
    })?;
    let (start, end) = raw.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = end.parse::<u64>().ok()?;
    end.checked_sub(start)?.checked_add(1)
}

fn youtube_hls_cached_failure(
    status: StatusCode,
    detail: impl Into<String>,
) -> YoutubeHlsCachedFailure {
    YoutubeHlsCachedFailure {
        status,
        detail: detail.into(),
    }
}

async fn read_youtube_hls_playlist(
    mut response: reqwest::Response,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<Bytes, YoutubeHlsCachedFailure> {
    const MAX_PLAYLIST_BYTES: usize = 2 * 1024 * 1024;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PLAYLIST_BYTES as u64)
    {
        return Err(youtube_hls_cached_failure(
            StatusCode::BAD_GATEWAY,
            "YouTube HLS 播放清单异常过大",
        ));
    }
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or_default()
            .min(MAX_PLAYLIST_BYTES as u64) as usize,
    );
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => {
                return Err(youtube_hls_cached_failure(
                    StatusCode::NO_CONTENT,
                    "YouTube HLS 播放会话已撤销",
                ));
            }
            result = response.chunk() => result.map_err(|_| {
                youtube_hls_cached_failure(
                    StatusCode::BAD_GATEWAY,
                    "读取 YouTube HLS 播放清单失败",
                )
            })?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        if bytes.len().saturating_add(chunk.len()) > MAX_PLAYLIST_BYTES {
            return Err(youtube_hls_cached_failure(
                StatusCode::BAD_GATEWAY,
                "YouTube HLS 播放清单异常过大",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(bytes))
}

async fn prepare_youtube_hls_resource(
    state: &AppState,
    media: &MediaToken,
    resource: &YoutubeHlsResource,
    url: reqwest::Url,
    is_playlist: bool,
) -> YoutubeHlsCachedResult {
    let request = youtube_hls_upstream_request(
        &state.youtube_media_http,
        url.clone(),
        &resource.user_agent,
        is_playlist,
    );
    let upstream = tokio::select! {
        _ = resource.cancel.cancelled() => {
            return Err(youtube_hls_cached_failure(
                StatusCode::NO_CONTENT,
                "YouTube HLS 播放会话已撤销",
            ));
        }
        result = tokio::time::timeout(std::time::Duration::from_secs(20), request.send()) => {
            match result {
                Err(_) => {
                    return Err(youtube_hls_cached_failure(
                        StatusCode::BAD_GATEWAY,
                        "连接 YouTube HLS 上游超时",
                    ));
                }
                Ok(Err(error)) => {
                    let kind = if error.is_timeout() {
                        "请求超时"
                    } else if error.is_connect() {
                        "连接失败"
                    } else {
                        "请求失败"
                    };
                    return Err(youtube_hls_cached_failure(
                        StatusCode::BAD_GATEWAY,
                        format!("连接 YouTube HLS 上游失败（{kind}）"),
                    ));
                }
                Ok(Ok(response)) => response,
            }
        }
    };
    let status = preview_upstream_status(&upstream);
    if !status.is_success() {
        let resource_kind = if is_playlist {
            "播放清单".to_string()
        } else {
            youtube_hls_segment_label(&url)
        };
        return Err(youtube_hls_cached_failure(
            StatusCode::BAD_GATEWAY,
            format!(
                "YouTube HLS {resource_kind}上游返回 HTTP {}（唯一请求）",
                status.as_u16()
            ),
        ));
    }
    let final_url = trusted_youtube_hls_resource_url(upstream.url().as_str()).map_err(|error| {
        youtube_hls_cached_failure(
            error.status,
            format!("YouTube HLS 上游最终地址：{}", error.detail),
        )
    })?;
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.contains(['\r', '\n']))
        .unwrap_or(if is_playlist {
            "application/vnd.apple.mpegurl"
        } else {
            "application/octet-stream"
        })
        .to_string();

    if is_playlist {
        let bytes = read_youtube_hls_playlist(upstream, &resource.cancel).await?;
        let text = std::str::from_utf8(&bytes).map_err(|_| {
            youtube_hls_cached_failure(StatusCode::BAD_GATEWAY, "YouTube HLS 播放清单编码无效")
        })?;
        let rewritten = rewrite_youtube_hls_playlist(state, media, resource, &final_url, text)
            .map_err(|error| youtube_hls_cached_failure(error.status, error.detail))?;
        return Ok(YoutubeHlsCachedResponse {
            content_type: "application/vnd.apple.mpegurl".into(),
            body: YoutubeHlsCachedBody::Playlist(Bytes::from(rewritten)),
        });
    }

    let spool = YoutubeHlsSegmentSpool::start(
        upstream,
        youtube_hls_segment_length_hint(&final_url),
        crate::youtube_hls::spool_path(&state.config.data_dir),
        resource.cancel.clone(),
    )
    .await?;
    Ok(YoutubeHlsCachedResponse {
        content_type,
        body: YoutubeHlsCachedBody::Segment(spool),
    })
}

fn youtube_hls_local_range(value: Option<&str>, total: u64) -> ApiResult<(u64, u64, bool)> {
    let Some(value) = value else {
        return Ok((0, total.saturating_sub(1), false));
    };
    if !valid_hls_range(value) {
        return Err(ApiError::bad_request("YouTube HLS Range 无效"));
    }
    let (start, end) = value
        .strip_prefix("bytes=")
        .and_then(|value| value.split_once('-'))
        .ok_or_else(|| ApiError::bad_request("YouTube HLS Range 无效"))?;
    let start = start
        .parse::<u64>()
        .map_err(|_| ApiError::bad_request("YouTube HLS Range 无效"))?;
    let end = if end.is_empty() {
        total.saturating_sub(1)
    } else {
        end.parse::<u64>()
            .map_err(|_| ApiError::bad_request("YouTube HLS Range 无效"))?
            .min(total.saturating_sub(1))
    };
    if start >= total || start > end {
        return Err(ApiError::new(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "YouTube HLS Range 超出分片长度",
        ));
    }
    Ok((start, end, true))
}

async fn youtube_hls_resource(
    State(state): State<Arc<AppState>>,
    Extension(media): Extension<MediaToken>,
    AxumPath(ticket): AxumPath<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let resource = state
        .youtube_hls_resource(&ticket)
        .ok_or_else(|| ApiError::not_found("YouTube HLS 播放票据已失效"))?;
    if resource.cancel.is_cancelled() {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let url = trusted_youtube_hls_resource_url(&resource.url)?;
    let is_playlist = url.path().starts_with("/api/manifest/");
    let requested_range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    if let Some(range) = requested_range {
        if !valid_hls_range(range) {
            return Err(ApiError::bad_request("YouTube HLS Range 无效"));
        }
    }
    let cached = resource
        .response
        .get_or_init(|| prepare_youtube_hls_resource(&state, &media, &resource, url, is_playlist))
        .await;
    let cached = match cached {
        Ok(cached) => cached,
        Err(error) if error.status == StatusCode::NO_CONTENT => {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        Err(error) => return Err(ApiError::new(error.status, error.detail.clone())),
    };
    match &cached.body {
        YoutubeHlsCachedBody::Playlist(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, &cached.content_type)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(Body::from(bytes.clone()))
            .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())),
        YoutubeHlsCachedBody::Segment(spool) => {
            let total = match requested_range {
                Some(_) => Some(spool.wait_total().await.map_err(|_| {
                    ApiError::new(StatusCode::BAD_GATEWAY, "读取 YouTube HLS 本地分片长度失败")
                })?),
                None => spool.total(),
            };
            let (start, end, partial) = match (requested_range, total) {
                (Some(range), Some(total)) => {
                    let (start, end, partial) = youtube_hls_local_range(Some(range), total)?;
                    (start, Some(end), partial)
                }
                (None, Some(total)) => (0, Some(total.saturating_sub(1)), false),
                (None, None) => (0, None, false),
                (Some(_), None) => unreachable!("Range 请求已经等待分片长度"),
            };
            let stream = spool.stream(start, end).await.map_err(|_| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "打开 YouTube HLS 本地分片失败",
                )
            })?;
            let mut builder = Response::builder()
                .status(if partial {
                    StatusCode::PARTIAL_CONTENT
                } else {
                    StatusCode::OK
                })
                .header(header::CONTENT_TYPE, &cached.content_type)
                .header(header::CACHE_CONTROL, "private, max-age=300")
                .header(header::ACCEPT_RANGES, "bytes");
            if let Some(end) = end {
                builder = builder.header(header::CONTENT_LENGTH, end - start + 1);
            }
            if partial {
                builder = builder.header(
                    header::CONTENT_RANGE,
                    format!(
                        "bytes {start}-{}/{}",
                        end.expect("partial response has an end"),
                        total.expect("partial response has a total")
                    ),
                );
            }
            builder.body(Body::from_stream(stream)).map_err(|error| {
                ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            })
        }
    }
}

#[derive(Deserialize)]
struct VideoResolveBody {
    #[serde(default)]
    url: String,
    #[serde(default)]
    platform: Option<Platform>,
}

async fn video_resolve(
    State(state): State<Arc<AppState>>,
    Json(body): Json<VideoResolveBody>,
) -> ApiResult<Json<VideoInfo>> {
    let url = body.url.trim();
    if url.is_empty() {
        return Err(ApiError::bad_request("链接不能为空"));
    }
    let platform = body.platform.unwrap_or_else(|| {
        reqwest::Url::parse(url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_ascii_lowercase))
            .filter(|host| host != "music.youtube.com")
            .filter(|host| {
                host == "youtu.be" || host == "youtube.com" || host.ends_with(".youtube.com")
            })
            .map(|_| Platform::Youtube)
            .unwrap_or(Platform::Bilibili)
    });
    let provider = state
        .video_provider(platform)
        .ok_or_else(|| ApiError::bad_request("这个来源不是视频平台"))?;
    let info = provider.resolve_video(url).await?;
    Ok(Json(info))
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
        return Err(ApiError::bad_request("缺少视频链接或视频 ID"));
    }
    if !matches!(payload.platform, Platform::Bilibili | Platform::Youtube) {
        return Err(ApiError::bad_request("这个来源不是视频平台"));
    }
    apply_video_defaults(&mut payload, &state.config.to_settings());
    payload.dest_dir = normalize_dest_dir(&state, &payload.dest_dir)?;
    // 立刻入队、立刻返回。真正的标题由视频 provider 在任务线程里补齐，
    // 避免网络解析阻塞按钮反馈。
    let task = enqueue_video(state.clone(), ctx.downloads.clone(), payload, false);
    ctx.downloads.broadcast_list();
    Ok(Json(task))
}

#[derive(Deserialize)]
struct VideoPreviewParams {
    /// 省略时兼容旧客户端，按 B 站处理。
    #[serde(default)]
    platform: Option<Platform>,
    bvid: String,
    /// 分 P 下标，从 0 起。
    #[serde(default)]
    page: usize,
    /// 视频在线播放上限；省略时跟随 settings.json。
    #[serde(default)]
    max_height: Option<i64>,
    /// 单文件或 DASH 独立轨；旧客户端默认单文件。
    #[serde(default)]
    track: VideoPreviewTrackParam,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum VideoPreviewTrackParam {
    #[default]
    Muxed,
    Video,
    Audio,
}

impl From<VideoPreviewTrackParam> for VideoPreviewTrack {
    fn from(value: VideoPreviewTrackParam) -> Self {
        match value {
            VideoPreviewTrackParam::Muxed => Self::Muxed,
            VideoPreviewTrackParam::Video => Self::Video,
            VideoPreviewTrackParam::Audio => Self::Audio,
        }
    }
}

/// 平台视频预览流代理。具体的鉴权、Referer/Cookie、URL 刷新与格式选择由
/// VideoProvider 持有；这里仅把统一 Range 响应重新包给 WebView。
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
    let platform = params.platform.unwrap_or(Platform::Bilibili);
    let provider = state
        .video_provider(platform)
        .ok_or_else(|| ApiError::bad_request("这个来源不是视频平台"))?;
    let stream = provider
        .preview_stream(
            &params.bvid,
            params.page,
            max_height,
            params.track.into(),
            range,
        )
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
    if let Some(codec) = stream.codec.as_deref() {
        builder = builder.header("x-kdj-media-codec", codec);
    }
    if let Some((start, end)) = stream.init_range {
        builder = builder.header("x-kdj-media-init-range", format!("{start}-{end}"));
    }
    if let Some((start, end)) = stream.index_range {
        builder = builder.header("x-kdj-media-index-range", format!("{start}-{end}"));
    }
    if let Some(duration_ms) = stream.duration_ms {
        builder = builder.header("x-kdj-media-duration-ms", duration_ms);
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
        .bilibili_preview
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

/// SQLite、标签和媒体容器解析都是同步阻塞工作。曲库请求先经过这道有界闸门再进
/// blocking 池，避免快速滚动或封面瀑布把 Tokio 的工作线程与阻塞线程同时塞满。
static LIBRARY_READ_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

async fn run_library_read<T, F>(work: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    let _permit = LIBRARY_READ_SLOTS.acquire().await.map_err(|err| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("曲库读取通道不可用：{err}"),
        )
    })?;
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("曲库读取任务异常结束：{err}"),
            )
        })?
        .map_err(ApiError::from)
}

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
    // 一个侧栏根只允许访问自己的平台。YouTube 与 YouTube Music 可能显示同一
    // 播放列表，但不能为了去重偷偷再刷新另一边的目录。
    let playlists = provider.stream_playlists().await?;
    if playlists
        .iter()
        .any(|playlist| playlist.platform != platform)
    {
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "平台目录返回了混合来源，已拒绝展示",
        ));
    }
    Ok(Json(playlists))
}

async fn stream_playlist(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<StreamPlaylistRequest>,
) -> ApiResult<Json<StreamPlaylistResponse>> {
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
    if response.platform != payload.platform
        || response
            .sources
            .iter()
            .any(|source| source.platform != payload.platform)
    {
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "平台歌单返回了混合来源，已拒绝展示",
        ));
    }
    Ok(Json(response))
}

async fn stream_playlist_remove_track(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<StreamPlaylistTrackRemoveRequest>,
) -> ApiResult<Json<StreamPlaylistTrackRemoveResponse>> {
    let key = payload.key.trim();
    if key.is_empty() {
        return Err(ApiError::bad_request("歌单来源缺少 key"));
    }
    if payload.source.key.trim().is_empty() {
        return Err(ApiError::bad_request("歌曲来源缺少 key"));
    }
    if payload.source.platform != payload.platform {
        return Err(ApiError::bad_request("歌曲来源与歌单平台不一致"));
    }
    if payload.platform == Platform::Local {
        return Err(ApiError::bad_request("本地曲库不属于平台歌单"));
    }
    let provider = state
        .provider(payload.platform)
        .ok_or_else(|| ApiError::not_found("平台不可用"))?;
    provider
        .remove_stream_playlist_track(key, &payload.source)
        .await?;
    Ok(Json(StreamPlaylistTrackRemoveResponse {
        platform: payload.platform,
        key: key.to_string(),
        source_key: payload.source.key,
        removed: true,
    }))
}

async fn library_tracks(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TrackQueryParams>,
) -> ApiResult<Json<TrackSummaryPage>> {
    let query = library_track_query(&state, params)?;
    let library = Arc::clone(&state.library);
    Ok(Json(
        run_library_read(move || library.list_track_summaries(&query)).await?,
    ))
}

fn library_track_query(state: &AppState, params: TrackQueryParams) -> ApiResult<TrackQuery> {
    let outside = params.folder.trim() == kdj_library::folders::OUTSIDE_FOLDER;
    let exclude_under = if outside {
        library_roots(state)?
            .into_iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect()
    } else {
        Vec::new()
    };
    Ok(TrackQuery {
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
        sort: params.sort.unwrap_or_else(|| "file_created_at".into()),
        order: params.order.unwrap_or_else(|| "desc".into()),
        sort2: params.sort2.unwrap_or_default(),
        order2: params.order2.unwrap_or_else(|| "asc".into()),
        limit: params.limit.unwrap_or(200).clamp(1, 10_000),
        offset: params.offset.unwrap_or(0).max(0),
    })
}

#[derive(Debug, Default, Deserialize)]
struct TrackSummaryBatchRequest {
    #[serde(default)]
    track_ids: Vec<i64>,
    #[serde(flatten)]
    query: TrackQueryParams,
}

/// `library.updated` 的增量回填端点。请求中不存在的 id 不返回，前端可以在不重拉
/// 整个已加载窗口的前提下识别删除；批量上限防止错误客户端把它当全库导出接口。
async fn library_track_summaries(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<TrackSummaryBatchRequest>,
) -> ApiResult<Json<Vec<TrackSummary>>> {
    if payload.track_ids.len() > 500 {
        return Err(ApiError::bad_request("一次最多读取 500 条曲目摘要"));
    }
    let query = library_track_query(&state, payload.query)?;
    let track_ids = payload.track_ids;
    let library = Arc::clone(&state.library);
    Ok(Json(
        run_library_read(move || library.track_summaries(&query, &track_ids)).await?,
    ))
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum WaveformRequestProfile {
    #[default]
    Current,
    ReleaseOverview,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum WaveformRequestIntent {
    #[default]
    Visible,
    Player,
    Prefetch,
}

impl From<WaveformRequestIntent> for crate::waveform::ReleaseOverviewIntent {
    fn from(value: WaveformRequestIntent) -> Self {
        match value {
            WaveformRequestIntent::Visible => Self::Visible,
            WaveformRequestIntent::Player => Self::Player,
            WaveformRequestIntent::Prefetch => Self::Prefetch,
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum WaveformResponseFormat {
    #[default]
    Json,
    Binary,
}

fn waveform_response(
    waveform: Waveform,
    profile: WaveformRequestProfile,
    format: WaveformResponseFormat,
) -> ApiResult<Response> {
    if format == WaveformResponseFormat::Json {
        return Ok(Json(waveform).into_response());
    }
    let wire_profile = match profile {
        WaveformRequestProfile::Current => crate::waveform::WaveformWireProfile::CurrentDetail,
        WaveformRequestProfile::ReleaseOverview => {
            crate::waveform::WaveformWireProfile::ReleaseOverview
        }
    };
    let body =
        crate::waveform::encode_waveform_binary(&waveform, wire_profile).map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("编码波形响应失败：{error:#}"),
            )
        })?;
    let mut response = body.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static(crate::waveform::WAVEFORM_BINARY_MIME),
    );
    response.headers_mut().insert(
        axum::http::HeaderName::from_static("x-kdj-waveform-profile"),
        axum::http::HeaderValue::from_static(wire_profile.name()),
    );
    response.headers_mut().insert(
        axum::http::HeaderName::from_static("x-kdj-waveform-revision"),
        axum::http::HeaderValue::from_str(&wire_profile.revision().to_string())
            .expect("waveform revision is an ASCII integer"),
    );
    Ok(response)
}
async fn library_track(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<Json<Track>> {
    let library = Arc::clone(&state.library);
    run_library_read(move || library.get(id))
        .await?
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
    if !crate::lyrics::lyric_timeline_compatible(track.duration, &stored.lrc, &stored.word_lrc) {
        return Err(ApiError::not_found("本地歌词时间轴与当前音频版本不匹配"));
    }
    Ok(Json(LocalLyricsResponse {
        lrc: stored.lrc,
        word_lrc: stored.word_lrc,
        translated_lrc: stored.translated_lrc,
        romaji_lrc: stored.romaji_lrc,
        platform: Platform::parse(stored.platform.trim()),
        key: stored.key,
        title: stored.title,
        artist: stored.artist,
        score: stored.score,
    }))
}

/// 在线匹配成功后，把歌词写进曲目旁的 `.kdj/lyrics/`。存储键使用曲目自身来源；
/// 没有来源时 folders 层按文件名生成本地键，绝不反向修改音频的分享来源身份。
async fn cache_library_lyrics(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Json(payload): Json<LyricsResponse>,
) -> ApiResult<Json<LocalLyricsResponse>> {
    let track = state
        .library
        .get(id)?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    if !crate::lyrics::lyric_timeline_compatible(track.duration, &payload.lrc, &payload.word_lrc) {
        return Err(ApiError::bad_request("匹配结果的歌词时间轴超出音频时长"));
    }
    let stored = kdj_library::folders::StoredLyrics {
        lrc: payload.lrc,
        word_lrc: payload.word_lrc,
        translated_lrc: payload.translated_lrc,
        romaji_lrc: payload.romaji_lrc,
        platform: payload.platform.as_str().to_string(),
        key: payload.key,
        title: payload.title,
        artist: payload.artist,
        score: payload.score,
    };
    let written = kdj_library::folders::write_lyrics_cache(
        Path::new(&track.path),
        &track.source_platform,
        &track.source_key,
        &stored,
    )?;
    if !written {
        return Err(ApiError::bad_request("匹配结果没有可缓存的主歌词"));
    }
    Ok(Json(LocalLyricsResponse {
        lrc: stored.lrc,
        word_lrc: stored.word_lrc,
        translated_lrc: stored.translated_lrc,
        romaji_lrc: stored.romaji_lrc,
        platform: Platform::parse(stored.platform.trim()),
        key: stored.key,
        title: stored.title,
        artist: stored.artist,
        score: stored.score,
    }))
}

async fn library_patch(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Json(payload): Json<TrackPatch>,
) -> ApiResult<Json<TrackPatchResult>> {
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

#[derive(Deserialize)]
struct HarmonicProfileRequest {
    bpm: Option<f64>,
    camelot: String,
    #[serde(default = "default_tolerance")]
    bpm_tolerance: f64,
    #[serde(default = "default_harmonic_limit")]
    limit: usize,
    #[serde(default = "default_true")]
    wide: bool,
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

async fn library_harmonic_profile(
    State(state): State<Arc<AppState>>,
    Json(request): Json<HarmonicProfileRequest>,
) -> ApiResult<Json<Vec<HarmonicMatch>>> {
    Ok(Json(state.library.harmonic_matches_for_profile(
        &request.camelot,
        request.bpm,
        request.bpm_tolerance,
        request.limit.clamp(1, 200),
        request.wide,
        &request.folder,
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

fn library_roots(state: &AppState) -> ApiResult<Vec<PathBuf>> {
    let mut settings = state.config.to_settings();
    let (roots, adopt) = pick_library_roots(&settings.library_dirs, || {
        state.library.all_paths().unwrap_or_default()
    });
    if let Some(dirs) = adopt {
        tracing::info!("从已入库路径反推曲库根目录：{dirs:?}");
        settings.library_dirs = dirs;
        state.config.apply_settings(settings)?;
    }
    Ok(roots)
}

/// 会改动文件系统的文件夹操作都要先有根目录。
///
/// 没有根就没有"界内/界外"可言，`ensure_inside` 会一律拒绝，
/// 报出来的是"目标目录不在曲库范围内"——真正的原因却是根本没配曲库目录。
fn require_roots(state: &AppState) -> ApiResult<Vec<PathBuf>> {
    let roots = library_roots(state)?;
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
    let roots: Vec<String> = library_roots(state)?
        .into_iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect();
    Ok(kdj_library::folders::build_tree(&roots, &paths))
}

#[derive(Deserialize)]
struct DuplicateAnalyzeRequest {
    #[serde(default)]
    all: bool,
    #[serde(default)]
    folders: Vec<String>,
    #[serde(default)]
    include_subfolders: bool,
}

#[derive(Serialize)]
struct DuplicateCandidate {
    track: Track,
    quality_score: i64,
    quality_label: String,
}

#[derive(Serialize)]
struct DuplicateGroup {
    group_id: String,
    confidence: &'static str,
    reason: String,
    keep_id: i64,
    candidates: Vec<DuplicateCandidate>,
}

#[derive(Serialize)]
struct DuplicateAnalysisResult {
    all: bool,
    folders: Vec<String>,
    include_subfolders: bool,
    scanned: usize,
    missing_tracks: Vec<Track>,
    offline_roots: Vec<String>,
    groups: Vec<DuplicateGroup>,
}

fn path_under_root(path: &Path, root: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        let path = path
            .to_string_lossy()
            .replace(char::from(92), "/")
            .to_ascii_lowercase();
        let root = root
            .to_string_lossy()
            .replace(char::from(92), "/")
            .trim_end_matches('/')
            .to_ascii_lowercase();
        return path == root || path.starts_with(&(root + "/"));
    }
    #[cfg(not(target_os = "windows"))]
    path.starts_with(root)
}

fn unavailable_library_tracks(
    tracks: &[Track],
    configured_roots: &[PathBuf],
) -> (Vec<Track>, Vec<String>, Vec<Track>) {
    let offline_root_paths: Vec<&PathBuf> = configured_roots
        .iter()
        .filter(|root| !root.is_dir())
        .collect();
    let mut offline_roots: Vec<String> = offline_root_paths
        .iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect();
    offline_roots.sort();
    offline_roots.dedup();
    let mut missing_tracks = Vec::new();
    let mut available_tracks = Vec::new();
    for track in tracks {
        let path = Path::new(&track.path);
        if offline_root_paths
            .iter()
            .any(|root| path_under_root(path, root))
        {
            continue;
        }
        if path.is_file() {
            available_tracks.push(track.clone());
        } else {
            missing_tracks.push(track.clone());
        }
    }
    (missing_tracks, offline_roots, available_tracks)
}

fn duplicate_text(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

fn duplicate_quality(track: &Track) -> (i64, String) {
    let format = track.format.trim().to_ascii_lowercase();
    let lossless = matches!(format.as_str(), "flac" | "wav" | "aiff" | "aif" | "alac");
    let format_rank = if lossless { 2_i64 } else { 1_i64 };
    let sample_rate = track.samplerate.unwrap_or(0).max(0);
    let bitrate = track.bitrate.unwrap_or(0).max(0);
    let channels = track.channels.unwrap_or(0).max(0);
    let score = format_rank * 1_000_000_000_000_000
        + sample_rate * 100_000_000
        + channels * 1_000_000
        + if lossless {
            (track.size.max(0) / 1024).min(999_999)
        } else {
            (bitrate * 1000).min(999_999)
        };
    let mut details = vec![format.to_uppercase()];
    if sample_rate > 0 {
        details.push(format!("{:.1} kHz", sample_rate as f64 / 1000.0));
    }
    if bitrate > 0 && !lossless {
        details.push(format!("{bitrate} kbps"));
    }
    (score, details.join(" · "))
}

fn duplicate_groups(mut tracks: Vec<Track>) -> Vec<DuplicateGroup> {
    let mut buckets: BTreeMap<(String, String), Vec<Track>> = BTreeMap::new();
    for track in tracks.drain(..) {
        let title = if track.title.trim().is_empty() {
            Path::new(&track.filename)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(&track.filename)
        } else {
            &track.title
        };
        let title = duplicate_text(title);
        if title.len() < 2 {
            continue;
        }
        buckets
            .entry((title, duplicate_text(&track.artist)))
            .or_default()
            .push(track);
    }

    let mut groups = Vec::new();
    for ((title, artist), mut bucket) in buckets {
        if bucket.len() < 2 {
            continue;
        }
        bucket.sort_by(|left, right| {
            left.duration
                .unwrap_or(f64::MAX)
                .total_cmp(&right.duration.unwrap_or(f64::MAX))
                .then_with(|| left.id.cmp(&right.id))
        });
        let mut partitions: Vec<Vec<Track>> = Vec::new();
        for track in bucket {
            let fits = partitions.last().and_then(|part| {
                let base = part.first()?.duration?;
                let duration = track.duration?;
                Some((duration - base).abs() <= 3.0)
            });
            if fits.unwrap_or(false) {
                partitions.last_mut().unwrap().push(track);
            } else {
                partitions.push(vec![track]);
            }
        }
        for partition in partitions.into_iter().filter(|part| part.len() > 1) {
            let same_source = partition
                .first()
                .filter(|track| !track.source_key.trim().is_empty())
                .is_some_and(|first| {
                    partition.iter().all(|track| {
                        track.source_platform == first.source_platform
                            && track.source_key == first.source_key
                    })
                });
            let same_size = partition.first().is_some_and(|first| {
                first.size > 0 && partition.iter().all(|track| track.size == first.size)
            });
            // 只有平台来源键完全相同才默认勾选删除。文件大小相同不是内容哈希，
            // 不足以证明两个不同母带/剪辑真的一样。
            let confidence = if same_source { "high" } else { "possible" };
            let reason = if same_source {
                "来源标识相同，标题、艺人和时长一致"
            } else if same_size {
                "标题、艺人、时长和文件大小一致"
            } else {
                "标题、艺人和时长接近，请试听确认"
            }
            .to_string();
            let mut candidates: Vec<DuplicateCandidate> = partition
                .into_iter()
                .map(|track| {
                    let (quality_score, quality_label) = duplicate_quality(&track);
                    DuplicateCandidate {
                        track,
                        quality_score,
                        quality_label,
                    }
                })
                .collect();
            candidates.sort_by(|left, right| {
                right
                    .quality_score
                    .cmp(&left.quality_score)
                    .then_with(|| left.track.id.cmp(&right.track.id))
            });
            let keep_id = candidates[0].track.id;
            groups.push(DuplicateGroup {
                group_id: format!("{title}:{artist}:{}", groups.len()),
                confidence,
                reason,
                keep_id,
                candidates,
            });
        }
    }
    groups
}

async fn analyze_duplicate_tracks(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<DuplicateAnalyzeRequest>,
) -> ApiResult<Json<DuplicateAnalysisResult>> {
    if !payload.all && payload.folders.is_empty() {
        return Err(ApiError::bad_request("至少选择一个文件夹"));
    }
    let mut folders: Vec<String> = if payload.all {
        Vec::new()
    } else {
        payload
            .folders
            .iter()
            .map(|folder| normalize_dest_dir(&state, folder))
            .collect::<ApiResult<_>>()?
    };
    folders.sort();
    folders.dedup();
    let mut roots: Vec<String> = Vec::new();
    for folder in folders {
        let path = Path::new(&folder);
        if payload.include_subfolders && roots.iter().any(|root| path.starts_with(Path::new(root)))
        {
            continue;
        }
        roots.push(folder);
    }
    let mut tracks = Vec::new();
    let mut seen = HashSet::new();
    let query_roots: Vec<Option<&String>> = if payload.all {
        vec![None]
    } else {
        roots.iter().map(Some).collect()
    };
    for folder in query_roots {
        let mut offset = 0;
        loop {
            let page = state.library.list_tracks(&TrackQuery {
                folder: folder.cloned().unwrap_or_default(),
                folder_deep: payload.include_subfolders,
                sort: "id".into(),
                order: "asc".into(),
                limit: 2000,
                offset,
                ..TrackQuery::default()
            })?;
            let count = page.items.len() as i64;
            for track in page.items {
                if seen.insert(track.id) {
                    tracks.push(track);
                }
            }
            offset += count;
            if count == 0 || offset >= page.total {
                break;
            }
        }
    }
    let scanned = tracks.len();
    // 配置里的根不能先走 resolve_roots：它会过滤离线卷，之后就无法区分“文件已
    // 移动/删除”和“整块 U 盘没挂载”。离线根只提示，不允许一键释放整盘记录。
    let configured_roots: Vec<PathBuf> = state
        .config
        .to_settings()
        .library_dirs
        .iter()
        .filter(|root| !root.trim().is_empty())
        .map(|root| kdj_core::config::expand_user(root))
        .collect();
    let (missing_tracks, offline_roots, available_tracks) =
        unavailable_library_tracks(&tracks, &configured_roots);
    Ok(Json(DuplicateAnalysisResult {
        all: payload.all,
        folders: roots,
        include_subfolders: payload.include_subfolders,
        scanned,
        missing_tracks,
        offline_roots,
        groups: duplicate_groups(available_tracks),
    }))
}

async fn library_folders(State(state): State<Arc<AppState>>) -> ApiResult<Json<FolderTree>> {
    Ok(Json(folder_tree(&state)?))
}

async fn folder_create(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderCreateRequest>,
) -> ApiResult<Json<FolderTree>> {
    let _operations = state.folder_operations.lock().unwrap();
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
    let _operations = state.folder_operations.lock().unwrap();
    // 归一化之后再拿去 rebase：请求里可能带 `~` 或结尾的斜杠，
    // 而库里存的是归一化路径，对不上就一首都改不到
    let source = kdj_library::folders::ensure_inside(Path::new(&payload.path), &roots)?;
    let target = kdj_library::folders::rename_folder(&source, &payload.name, &roots)?;
    // 目录改名后库里的 path 要跟着改，否则整批曲目会变成"文件不存在"
    let ids = match state.library.rebase_paths(&source, &target) {
        Ok(ids) => ids,
        Err(database_error) => {
            let old_name = source
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            let rollback = kdj_library::folders::rename_folder(&target, old_name, &roots);
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                match rollback {
                    Ok(_) => format!("文件夹改名未写入曲库，磁盘已恢复：{database_error:#}"),
                    Err(rollback_error) => format!(
                        "文件夹改名后曲库更新失败，磁盘回滚也失败：{database_error:#}；{rollback_error:#}"
                    ),
                },
            ));
        }
    };
    state.hub.publish_library_updated(&ids);
    Ok(Json(folder_tree(&state)?))
}

async fn folder_delete(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderDeleteRequest>,
) -> ApiResult<Json<FolderTree>> {
    let _operations = state.folder_operations.lock().unwrap();
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
    let _operations = state.folder_operations.lock().unwrap();
    // 恰好是某个曲库根（或设置里登记在它底下的子根）才注销；
    // 普通子目录只摘曲目，不改 library_dirs。
    let previous_settings = state.config.to_settings();
    let mut settings = previous_settings.clone();
    let next_roots = unregister_library_roots(&settings.library_dirs, &target);
    let applied_settings = if next_roots != settings.library_dirs {
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
        let saved = state.config.apply_settings(settings)?;
        state.sync_provider_context();
        Some(saved)
    } else {
        None
    };
    // 先持久化“以后不再扫描这个根”，再删库记录。进程在两步之间退出时最多留下
    // 一批可重新添加根目录找回的记录，不会把评分/歌单先删掉、重启后根又回来。
    let removed_ids = match state.library.forget_under(&target) {
        Ok(ids) => ids,
        Err(database_error) => {
            let rollback_error = if let Some(applied) = applied_settings {
                let mut rollback = state.config.to_settings();
                // 只撤回本操作真正写过、且尚未被后续设置修改的字段；主题等并发操作保留。
                if rollback.library_dirs == applied.library_dirs {
                    rollback.library_dirs = previous_settings.library_dirs;
                }
                if rollback.download_dir == applied.download_dir {
                    rollback.download_dir = previous_settings.download_dir;
                }
                if rollback.video_download_dir == applied.video_download_dir {
                    rollback.video_download_dir = previous_settings.video_download_dir;
                }
                match state.config.apply_settings(rollback) {
                    Ok(_) => {
                        state.sync_provider_context();
                        None
                    }
                    Err(error) => Some(error),
                }
            } else {
                None
            };
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                match rollback_error {
                    None => format!("移出曲库失败，设置已恢复：{database_error:#}"),
                    Some(error) => format!(
                        "移出曲库的数据库操作失败，设置回滚也失败：{database_error:#}；{error:#}"
                    ),
                },
            ));
        }
    };
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
    let _operations = state.folder_operations.lock().unwrap();
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
    let roots = require_roots(&state)?;
    let _operations = state.folder_operations.lock().unwrap();
    let (old, new) = kdj_library::folders::move_folder(
        Path::new(&payload.path),
        Path::new(&payload.dest_parent),
        &roots,
    )?;
    // 拖回原地时 old == new，rebase 一遍纯属白写库
    if old != new {
        let ids = match state.library.rebase_paths(&old, &new) {
            Ok(ids) => ids,
            Err(database_error) => {
                let rollback = old
                    .parent()
                    .map(|parent| kdj_library::folders::move_folder(&new, parent, &roots));
                let rollback_message = match rollback {
                    Some(Ok(_)) => "磁盘已恢复".to_string(),
                    Some(Err(error)) => format!("磁盘回滚失败：{error:#}"),
                    None => "原文件夹缺少上级目录，无法回滚".to_string(),
                };
                return Err(ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("文件夹移动未写入曲库：{database_error:#}；{rollback_message}"),
                ));
            }
        };
        state.hub.publish_library_updated(&ids);
    }
    Ok(Json(folder_tree(&state)?))
}

#[derive(Deserialize)]
struct FolderMergeRequest {
    paths: Vec<String>,
    dest_parent: String,
    name: String,
}

#[derive(Serialize)]
struct FolderMergeResponse {
    tree: FolderTree,
    target: String,
}

fn rollback_folder_moves(
    state: &AppState,
    moved: &[(PathBuf, PathBuf)],
    roots: &[PathBuf],
) -> Vec<String> {
    let mut errors = Vec::new();
    for (old, new) in moved.iter().rev() {
        let Some(parent) = old.parent() else {
            errors.push(format!("{} 缺少原上级目录", old.display()));
            continue;
        };
        match kdj_library::folders::move_folder(new, parent, roots) {
            Ok((rollback_old, rollback_new)) => {
                if let Err(error) = state.library.rebase_paths(&rollback_old, &rollback_new) {
                    errors.push(format!("恢复 {} 的曲库路径失败：{error:#}", old.display()));
                }
            }
            Err(error) => errors.push(format!("恢复 {} 的磁盘目录失败：{error:#}", old.display())),
        }
    }
    errors
}

/// 把多个文件夹归并到用户指定位置的新文件夹中。
///
/// 保留每个来源文件夹作为子目录，不做危险的扁平化；同名目录在预检阶段直接拒绝。
/// 任一步失败都会把已经移动的目录按原父级回滚，并同步恢复数据库路径。
async fn folder_merge(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderMergeRequest>,
) -> ApiResult<Json<FolderMergeResponse>> {
    if payload.paths.len() < 2 {
        return Err(ApiError::bad_request("至少选择两个文件夹才能合并"));
    }
    let roots = require_roots(&state)?;
    let _operations = state.folder_operations.lock().unwrap();
    let dest_parent = kdj_library::folders::ensure_inside(Path::new(&payload.dest_parent), &roots)?;
    if !dest_parent.is_dir() {
        return Err(ApiError::bad_request("新文件夹位置不存在"));
    }
    let mut sources: Vec<PathBuf> = payload
        .paths
        .iter()
        .map(|path| kdj_library::folders::ensure_inside(Path::new(path), &roots))
        .collect::<anyhow::Result<_>>()?;
    sources.sort();
    sources.dedup();
    sources = sources
        .iter()
        .filter(|source| {
            !sources
                .iter()
                .any(|parent| parent != *source && source.starts_with(parent))
        })
        .cloned()
        .collect();
    if sources.len() < 2 {
        return Err(ApiError::bad_request("选择中只有一个独立文件夹"));
    }
    for source in &sources {
        if roots.iter().any(|root| source == root) {
            return Err(ApiError::bad_request("曲库根目录不能参与合并"));
        }
        if !source.is_dir() {
            return Err(ApiError::bad_request(format!(
                "文件夹不存在：{}",
                source.display()
            )));
        }
    }
    let names: Vec<_> = sources.iter().filter_map(|path| path.file_name()).collect();
    let unique_names: HashSet<_> = names.iter().collect();
    if unique_names.len() != names.len() {
        return Err(ApiError::bad_request("所选文件夹存在同名项，无法安全归并"));
    }

    let target = kdj_library::folders::create_folder(&dest_parent, &payload.name, &roots)?;
    if sources.iter().any(|source| target.starts_with(source)) {
        let _ = std::fs::remove_dir(&target);
        return Err(ApiError::bad_request("新文件夹不能建在待合并文件夹内部"));
    }

    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut changed_ids = Vec::new();
    for source in &sources {
        let failure = match kdj_library::folders::move_folder(source, &target, &roots) {
            Ok((old, new)) => {
                // 先登记这次磁盘移动；即使紧接着数据库失败，它也必须进入回滚集合。
                moved.push((old.clone(), new.clone()));
                match state.library.rebase_paths(&old, &new) {
                    Ok(ids) => {
                        changed_ids.extend(ids);
                        None
                    }
                    Err(error) => Some(format!("更新曲库路径失败：{error:#}")),
                }
            }
            Err(error) => Some(format!("移动磁盘目录失败：{error:#}")),
        };
        if let Some(failure) = failure {
            let rollback_errors = rollback_folder_moves(&state, &moved, &roots);
            let _ = std::fs::remove_dir(&target);
            let detail = if rollback_errors.is_empty() {
                format!("合并失败，已完整回滚：{failure}")
            } else {
                format!(
                    "合并失败且有回滚项未完成：{failure}；{}",
                    rollback_errors.join("；")
                )
            };
            return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, detail));
        }
    }
    changed_ids.sort_unstable();
    changed_ids.dedup();
    state.hub.publish_library_updated(&changed_ids);
    Ok(Json(FolderMergeResponse {
        tree: folder_tree(&state)?,
        target: target.to_string_lossy().into_owned(),
    }))
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
    let _operations = state.folder_operations.lock().unwrap();
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
            if let Err(error) = kdj_library::folders::move_lyrics(
                &item.target,
                &restored,
                &item.source_platform,
                &item.source_key,
            ) {
                let rollback = rollback_track_move(
                    &restored,
                    &item.target,
                    &item.source_platform,
                    &item.source_key,
                );
                if rollback.is_empty() {
                    anyhow::bail!("撤回移动歌词失败，音频与歌词已回滚：{error:#}");
                }
                anyhow::bail!(
                    "撤回移动歌词失败：{error:#}；回滚也有异常：{}",
                    rollback.join("；")
                );
            }
            if let Err(error) = state.library.relocate(item.track_id, &restored) {
                let rollback = rollback_track_move(
                    &restored,
                    &item.target,
                    &item.source_platform,
                    &item.source_key,
                );
                if rollback.is_empty() {
                    anyhow::bail!("撤回移动时更新曲库失败，文件已恢复到撤回前位置：{error:#}");
                }
                anyhow::bail!(
                    "撤回移动时更新曲库失败：{error:#}；回滚文件也有异常：{}",
                    rollback.join("；")
                );
            }
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
            remove_registered_copy(state, new_id, &item.target)?;
            if let Err(error) = kdj_library::folders::remove_lyrics(
                &item.target,
                &item.source_platform,
                &item.source_key,
            ) {
                // 主文件与曲库记录已经一致地撤回；歌词 sidecar 清理失败不应让同一条
                // 撤回永远卡在栈顶、下一次又因主文件不存在而必然失败。
                tracing::warn!(
                    "撤回复制后清理歌词失败 {}：{error:#}",
                    item.target.display()
                );
            }
            Ok(vec![new_id])
        }
    }
}

/// 在曲库更新失败后，把已经移动的音频和歌词尽量放回原处。
/// 返回空列表表示完整回滚；非空内容会进入 API 错误，避免把半完成状态伪装成成功。
fn rollback_track_move(source: &Path, target: &Path, platform: &str, key: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if let Err(error) = kdj_library::folders::move_lyrics(source, target, platform, key) {
        errors.push(format!("歌词回滚失败：{error:#}"));
    }
    let Some(parent) = target.parent() else {
        errors.push(format!("回滚目标没有父目录：{}", target.display()));
        return errors;
    };
    match kdj_library::folders::move_file(source, parent) {
        Ok(restored)
            if kdj_library::service::normalize_path(&restored)
                == kdj_library::service::normalize_path(target) => {}
        Ok(restored) => errors.push(format!(
            "文件被恢复到意外位置：{}（应为 {}）",
            restored.display(),
            target.display()
        )),
        Err(error) => errors.push(format!("文件回滚失败：{error:#}")),
    }
    errors
}

/// 撤销一条已登记的复制：先事务性摘掉数据库记录，再删文件；如果删文件失败，
/// 用刚保存的完整快照恢复数据库，保证不会留下“磁盘有文件、曲库没记录”的半截状态。
fn remove_registered_copy(state: &AppState, track_id: i64, target: &Path) -> anyhow::Result<()> {
    let (removed, snapshot) = state
        .library
        .delete_for_undo(track_id, FileDisposal::Keep)?;
    anyhow::ensure!(removed, "复制出来的曲目已不存在：{track_id}");
    let snapshot = snapshot.ok_or_else(|| anyhow::anyhow!("无法保存复制曲目的回滚快照"))?;
    if let Err(error) = std::fs::remove_file(target) {
        if let Err(rollback) = state.library.restore_deleted(&snapshot) {
            anyhow::bail!("删除复制文件失败：{error}；恢复曲库记录也失败：{rollback:#}");
        }
        anyhow::bail!("删除复制文件失败，曲库记录已恢复：{error}");
    }
    Ok(())
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
        let track = match state.library.get(*id) {
            Ok(Some(track)) => track,
            Ok(None) => {
                errors.insert(id.to_string(), "曲目不存在".into());
                continue;
            }
            Err(error) => {
                errors.insert(id.to_string(), format!("读取曲目失败：{error:#}"));
                continue;
            }
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
                    if let Err(error) = kdj_library::folders::move_lyrics(
                        &source,
                        &target,
                        &track.source_platform,
                        &track.source_key,
                    ) {
                        let rollback = rollback_track_move(
                            &target,
                            &source,
                            &track.source_platform,
                            &track.source_key,
                        );
                        let message = if rollback.is_empty() {
                            format!("移动歌词失败，音频与歌词已回滚：{error:#}")
                        } else {
                            format!(
                                "移动歌词失败：{error:#}；回滚也有异常：{}",
                                rollback.join("；")
                            )
                        };
                        errors.insert(id.to_string(), message);
                        continue;
                    }
                    if let Err(error) = state.library.relocate(*id, &target) {
                        let rollback = rollback_track_move(
                            &target,
                            &source,
                            &track.source_platform,
                            &track.source_key,
                        );
                        let message = if rollback.is_empty() {
                            format!("更新曲库失败，文件已回滚：{error:#}")
                        } else {
                            format!(
                                "更新曲库失败：{error:#}；回滚也有异常：{}",
                                rollback.join("；")
                            )
                        };
                        errors.insert(id.to_string(), message);
                        continue;
                    }
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
                    match state.library.get_by_path(&target) {
                        Ok(Some(_)) => {
                            let cleanup = std::fs::remove_file(&target)
                                .err()
                                .map(|error| format!("；清理复制文件失败：{error}"))
                                .unwrap_or_default();
                            errors.insert(
                                id.to_string(),
                                format!("目标路径已在曲库登记，已取消复制{cleanup}"),
                            );
                            continue;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            let cleanup = std::fs::remove_file(&target)
                                .err()
                                .map(|cleanup| format!("；清理复制文件失败：{cleanup}"))
                                .unwrap_or_default();
                            errors.insert(
                                id.to_string(),
                                format!("检查目标曲库记录失败：{error:#}{cleanup}"),
                            );
                            continue;
                        }
                    }
                    match state.library.upsert_file(
                        &target,
                        &track.source_platform,
                        &track.source_key,
                    ) {
                        Ok(new_id) => {
                            if let Err(error) = state.library.clone_metadata(*id, new_id) {
                                let cleanup = remove_registered_copy(&state, new_id, &target);
                                let message = match cleanup {
                                    Ok(()) => format!("复制元数据失败，复制内容已回滚：{error:#}"),
                                    Err(cleanup) => format!(
                                        "复制元数据失败：{error:#}；清理复制内容也失败：{cleanup:#}"
                                    ),
                                };
                                errors.insert(id.to_string(), message);
                                continue;
                            }
                            if let Err(error) = kdj_library::folders::copy_lyrics(
                                &source,
                                &target,
                                &track.source_platform,
                                &track.source_key,
                            ) {
                                let cleanup = kdj_library::folders::remove_lyrics(
                                    &target,
                                    &track.source_platform,
                                    &track.source_key,
                                );
                                tracing::warn!(
                                    "复制歌词失败 {}：{error:#}；清理结果：{cleanup:?}",
                                    target.display()
                                );
                                errors.insert(
                                    id.to_string(),
                                    format!("音频已复制，但歌词复制失败：{error:#}"),
                                );
                            }
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
                            let cleanup = std::fs::remove_file(&target)
                                .err()
                                .map(|error| format!("；清理复制文件失败：{error}"))
                                .unwrap_or_default();
                            errors.insert(id.to_string(), format!("{err:#}{cleanup}"));
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
        let normalized = kdj_library::service::normalize_path(&candidate);
        let identity = kdj_core::paths::path_identity(Path::new(&normalized));
        if !merged
            .iter()
            .any(|current| kdj_core::paths::path_identity(Path::new(current)) == identity)
        {
            merged.push(normalized);
            // 新根可能把后面某个候选包住，重算一遍再判断下一个
            roots = kdj_library::folders::resolve_roots(&merged);
        }
    }
    merged
}

fn register_library_roots(state: &AppState, paths: &[String]) -> ApiResult<()> {
    let mut settings = state.config.to_settings();
    let merged = merge_library_roots(&settings.library_dirs, paths);
    if merged != settings.library_dirs {
        settings.library_dirs = merged;
        state.config.apply_settings(settings)?;
    }
    Ok(())
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
        library_roots(&state)?
            .into_iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect()
    } else {
        register_library_roots(&state, &requested)?;
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

#[derive(Debug, Default, Deserialize)]
struct ScanCancelParams {
    /// 传当前进度里的 job_id；省略时作为兜底取消全部显式扫描。
    #[serde(default)]
    job_id: String,
}

async fn library_scan_cancel(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ScanCancelParams>,
) -> Json<crate::jobs::ScanCancelReport> {
    Json(state.scans.cancel(&params.job_id))
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
        kdj_core::models::AnalysisVersion::V3 => state.library.pending_bpm_key_analysis_v3_ids(
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
        kdj_core::models::AnalysisVersion::V3 => {
            crate::jobs::spawn_bpm_key_analysis_v3(state.clone(), pending)
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

/// 停止分析。解码与逐帧 FFT 都有协作取消点；只有完整结果才会写入曲库。
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
pub(crate) async fn audio_response(
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
    Query(params): Query<CoverQueryParams>,
) -> ApiResult<Response> {
    let library = Arc::clone(&state.library);
    let source = run_library_read(move || library.media_source(id))
        .await?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    let path = PathBuf::from(&source.path);
    if let Some(size) = params.size {
        if let Some(data) =
            cover_thumbnail(&source, &state.config.data_dir.join("covers"), size).await
        {
            return Ok((StatusCode::OK, cover_headers(JPEG_MIME.into()), data).into_response());
        }
        return Err(ApiError::not_found("没有可用封面"));
    }

    let cover_path = path.clone();
    if let Some((data, mime)) =
        run_library_read(move || Ok(kdj_providers::tags::read_cover(&cover_path))).await?
    {
        return Ok((StatusCode::OK, cover_headers(mime), data).into_response());
    }
    // VJ 素材和 MV 是没有内嵌封面的，一律 404 的话曲库里那一批视频
    // 全是空白占位。抽一帧当封面——播放器就是这么做的。
    if is_video_container(&path) {
        if let Some(data) = video_cover(
            &path,
            source.id,
            source.duration,
            &state.config.data_dir.join("covers"),
        )
        .await
        {
            return Ok((StatusCode::OK, cover_headers(JPEG_MIME.into()), data).into_response());
        }
    }
    Err(ApiError::not_found("没有内嵌封面"))
}

#[derive(Debug, Default, Deserialize)]
struct CoverQueryParams {
    /// 列表缩略图的最长边；不传表示详情/分享所需的原始封面。
    size: Option<u32>,
}

const JPEG_MIME: &str = "image/jpeg";

static COVER_THUMBNAIL_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);
static COVER_THUMBNAIL_LOCKS: std::sync::LazyLock<Vec<tokio::sync::Mutex<()>>> =
    std::sync::LazyLock::new(|| (0..16).map(|_| tokio::sync::Mutex::new(())).collect());

/// 音频内嵌图和视频抽帧统一生成固定尺寸 JPEG。缓存键带文件 mtime 与尺寸；空的
/// `.none` 是负缓存，避免无封面曲目每次滚回屏幕都重新打开整个媒体容器。
async fn cover_thumbnail(
    source: &TrackMediaSource,
    cache_dir: &Path,
    requested_size: u32,
) -> Option<Vec<u8>> {
    let size = requested_size.clamp(32, 256);
    let mtime = if source.file_mtime.is_finite() && source.file_mtime > 0.0 {
        source.file_mtime as u64
    } else {
        file_mtime(Path::new(&source.path))
    };
    let thumb_dir = cache_dir.join("thumbs");
    let target = thumb_dir.join(format!("{}-{mtime}-{size}.jpg", source.id));
    let negative = thumb_dir.join(format!("{}-{mtime}-{size}.none", source.id));
    if let Ok(data) = tokio::fs::read(&target).await {
        if !data.is_empty() {
            return Some(data);
        }
    }
    if tokio::fs::metadata(&negative).await.is_ok() {
        return None;
    }

    let lock_index = source.id.unsigned_abs() as usize % COVER_THUMBNAIL_LOCKS.len();
    let _key_guard = COVER_THUMBNAIL_LOCKS[lock_index].lock().await;
    // 同一首的并发请求在 key 锁内复查；第一个请求已经生成后，后续直接读缓存。
    if let Ok(data) = tokio::fs::read(&target).await {
        if !data.is_empty() {
            return Some(data);
        }
    }
    if tokio::fs::metadata(&negative).await.is_ok() {
        return None;
    }
    tokio::fs::create_dir_all(&thumb_dir).await.ok()?;
    let _slot = COVER_THUMBNAIL_SLOTS.acquire().await.ok()?;

    let media_path = PathBuf::from(&source.path);
    let embedded_target = target.clone();
    let embedded = tokio::task::spawn_blocking(move || {
        let data = kdj_providers::tags::read_cover_thumbnail(&media_path, size)?;
        store_thumbnail_atomically(&embedded_target, &data);
        Some(data)
    })
    .await
    .ok()
    .flatten();
    if embedded.is_some() {
        return embedded;
    }

    if is_video_container(Path::new(&source.path)) {
        if let Some(frame) = video_cover(
            Path::new(&source.path),
            source.id,
            source.duration,
            cache_dir,
        )
        .await
        {
            let video_target = target.clone();
            if let Some(data) = tokio::task::spawn_blocking(move || {
                let data = kdj_providers::tags::thumbnail_cover_data(&frame, size)?;
                store_thumbnail_atomically(&video_target, &data);
                Some(data)
            })
            .await
            .ok()
            .flatten()
            {
                return Some(data);
            }
        }
    }

    let _ = tokio::fs::write(negative, []).await;
    None
}

fn store_thumbnail_atomically(target: &Path, data: &[u8]) {
    let partial = target.with_extension(format!("jpg.partial-{}", std::process::id()));
    if std::fs::write(&partial, data).is_ok() && std::fs::rename(&partial, target).is_ok() {
        return;
    }
    let _ = std::fs::remove_file(partial);
}

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
    #[serde(default)]
    profile: WaveformRequestProfile,
    #[serde(default)]
    format: WaveformResponseFormat,
    /// Current-track detail warmup may share the pre-emptible light lane with healthy playback.
    #[serde(default)]
    background: bool,
    #[serde(default)]
    intent: WaveformRequestIntent,
    /// Monotonic browser-side ordering for the two latest-wins lanes.
    #[serde(default)]
    request_id: u64,
    /// Update native cancellation state without transferring a waveform already held in JS memory.
    #[serde(default)]
    intent_only: bool,
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
) -> ApiResult<Response> {
    let buckets = params
        .buckets
        .clamp(64, crate::waveform::MAX_WAVEFORM_BUCKETS);
    let track = state
        .library
        .get(id)?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    let release_intent = crate::waveform::ReleaseOverviewIntent::from(params.intent);
    if params.profile == WaveformRequestProfile::ReleaseOverview && params.intent_only {
        state
            .waveforms
            .note_release_overview_intent(id, release_intent, params.request_id);
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let path = PathBuf::from(&track.path);
    if !path.is_file() {
        return Err(ApiError::not_found("音频文件已丢失"));
    }

    let cache_dir = state.config.data_dir.join("waveform");
    let wave = if params.profile == WaveformRequestProfile::ReleaseOverview {
        state
            .waveforms
            .get_release_overview_with_intent(
                id,
                path,
                cache_dir,
                release_intent,
                params.request_id,
            )
            .await
    } else if params.background {
        state
            .waveforms
            .warm_detail_while_playing(id, path, buckets, cache_dir)
            .await
    } else {
        state
            .waveforms
            .get_or_compute(id, path, buckets, cache_dir)
            .await
    }
    .map_err(|err| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, format!("{err:#}")))?;
    waveform_response(wave, params.profile, params.format)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_hls_proof_is_inserted_only_into_trusted_manifest_paths() {
        let proof = "abcdEFGH0123_-.+/=abcd";
        let raw = "https://rr1---sn.example.googlevideo.com/api/manifest/hls_variant/id/x/file/index.m3u8?keep=1";
        let protected = hls_url_with_proof(raw, proof).unwrap();
        assert!(protected.contains("/pot/"));
        assert!(protected.contains("%2F"));
        assert!(protected.contains("=abcd/file/index.m3u8"));
        assert!(!protected.contains("%3D"));
        assert!(protected.ends_with("/file/index.m3u8?keep=1"));

        let alternate_manifest =
            "https://rr1---sn.example.googlevideo.com/api/manifest/hls_chunklist/id/x/playlist/index.m3u8";
        assert!(hls_url_with_proof(alternate_manifest, proof)
            .unwrap()
            .contains("/pot/"));
        assert!(trusted_youtube_hls_resource_url(
            "https://rr1---sn.example.googlevideo.com/api/private/id/x"
        )
        .is_err());

        let inherited = format!(
            "https://rr1---sn.example.googlevideo.com/videoplayback/id/x/pot/{}/seg.ts?keep=1",
            percent_encode_hls_path_segment(proof)
        );
        assert_eq!(hls_url_with_proof(&inherited, proof).unwrap(), inherited);
        let canonicalized = inherited.replace("=abcd/seg.ts", "%3Dabcd/seg.ts");
        assert_eq!(
            hls_url_with_proof(&canonicalized, proof).unwrap(),
            canonicalized
        );
        let mismatched_canonicalized = canonicalized.replace("%3Dabcd", "%3Dwrong");
        assert!(hls_url_with_proof(&mismatched_canonicalized, proof).is_err());
        assert!(hls_url_with_proof(
            "https://rr1---sn.example.googlevideo.com/videoplayback/id/x/pot/wrong-proof/seg.ts",
            proof,
        )
        .is_err());
        assert!(hls_url_with_proof(
            "https://rr1---sn.example.googlevideo.com/videoplayback/id/x/seg.ts?keep=1",
            proof,
        )
        .is_err());
        assert!(hls_url_with_proof(
            "https://attacker.example/api/manifest/hls_variant/id/x/file/index.m3u8",
            proof
        )
        .is_err());
        assert!(crate::state::trusted_googlevideo_media_target(
            &reqwest::Url::parse(raw).unwrap()
        ));
        assert!(!crate::state::trusted_googlevideo_media_target(
            &reqwest::Url::parse("https://attacker.example/videoplayback").unwrap()
        ));
        assert!(!crate::state::trusted_googlevideo_media_target(
            &reqwest::Url::parse("https://rr1---sn.example.googlevideo.com/redirect").unwrap()
        ));
    }

    #[test]
    fn youtube_hls_n_challenge_is_replaced_once_before_proof_is_inserted() {
        let raw = "https://rr1---sn.example.googlevideo.com/api/manifest/hls_variant/id/x/n/old_123/file/index.m3u8?keep=1";
        assert_eq!(hls_n_challenge(raw).unwrap().as_deref(), Some("old_123"));
        let solved = hls_url_with_solved_n(raw, "old_123", "new-456").unwrap();
        assert!(solved.contains("/n/new-456/file/index.m3u8"));
        assert!(!solved.contains("/n/old_123/"));
        assert!(hls_url_with_solved_n(raw, "different", "new-456").is_err());
        assert!(hls_url_with_solved_n(raw, "old_123", "bad/value").is_err());
    }

    #[test]
    fn youtube_hls_playlist_hides_upstream_urls_and_filters_height() {
        let root = std::env::temp_dir().join(format!(
            "kdj-hls-playlist-test-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let config = Arc::new(kdj_core::AppConfig::create(
            root.join("data"),
            root.join("downloads"),
            0,
        ));
        let state = AppState::new(config).unwrap();
        let proof = "abcdEFGH0123_-.+/=abcd".to_string();
        let master = reqwest::Url::parse(
            "https://rr1---sn.example.googlevideo.com/api/manifest/hls_variant/id/root/file/index.m3u8",
        )
        .unwrap();
        let ticket = state.issue_youtube_hls_resource(
            "abcDEF12345".into(),
            hls_url_with_proof(master.as_str(), &proof).unwrap(),
            "Mozilla/5.0 AppleWebKit/605.1.15 Version/18.5 Safari/605.1.15".into(),
            proof,
            720,
            tokio_util::sync::CancellationToken::new(),
        );
        let resource = state.youtube_hls_resource(&ticket).unwrap();
        let media = MediaToken::generate();
        let playlist = "#EXTM3U\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"alternate\",URI=\"https://rr1---sn.example.googlevideo.com/api/manifest/hls_playlist/id/audio/playlist/index.m3u8\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS=\"avc1.4d401e,mp4a.40.2\"\n\
https://rr1---sn.example.googlevideo.com/api/manifest/hls_playlist/id/low/playlist/index.m3u8\n\
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,URI=\"https://rr1---sn.example.googlevideo.com/api/manifest/hls_playlist/id/iframe/playlist/index.m3u8\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS=\"avc1.4d401f,mp4a.40.2\",AUDIO=\"alternate\",SUBTITLES=\"captions\"\n\
https://rr1---sn.example.googlevideo.com/api/manifest/hls_playlist/id/selected/playlist/index.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\"\n\
https://rr1---sn.example.googlevideo.com/api/manifest/hls_playlist/id/high/playlist/index.m3u8\n";
        let rewritten =
            rewrite_youtube_hls_playlist(&state, &media, &resource, &master, playlist).unwrap();
        assert_eq!(rewritten.matches("#EXT-X-STREAM-INF:").count(), 1);
        assert!(rewritten.contains("1280x720"));
        assert!(!rewritten.contains("640x360"));
        assert!(!rewritten.contains("1080"));
        assert!(!rewritten.contains("I-FRAME"));
        assert!(!rewritten.contains("EXT-X-MEDIA"));
        assert!(!rewritten.contains("AUDIO="));
        assert!(!rewritten.contains("SUBTITLES="));
        assert!(rewritten.contains("CODECS=\"avc1.4d401f,mp4a.40.2\""));
        assert!(!rewritten.contains("googlevideo.com"));
        assert!(!rewritten.contains(&resource.proof_token));
        assert!(rewritten.contains("/api/video/youtube/hls/"));
        assert!(rewritten.contains("kdj_media_token="));
        let child_ticket = rewritten
            .split("/api/video/youtube/hls/")
            .nth(1)
            .unwrap()
            .split('?')
            .next()
            .unwrap();
        let child = state.youtube_hls_resource(child_ticket).unwrap();
        assert!(!resource.cancel.is_cancelled());
        assert!(!child.cancel.is_cancelled());
        assert!(state.cancel_youtube_hls_resource(&ticket));
        assert!(resource.cancel.is_cancelled());
        assert!(child.cancel.is_cancelled());
        assert!(state.youtube_hls_resource(&ticket).is_none());
        assert!(state.youtube_hls_resource(child_ticket).is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn youtube_hls_variant_requires_one_muxed_h264_aac_stream() {
        let muxed = "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,CODECS=\"avc1.4d401f,mp4a.40.2\",AUDIO=\"alt\"";
        assert!(hls_variant_is_muxed_h264_aac(muxed));
        assert_eq!(
            strip_hls_rendition_group_attributes(muxed),
            "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,CODECS=\"avc1.4d401f,mp4a.40.2\""
        );
        assert!(!hls_variant_is_muxed_h264_aac(
            "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,CODECS=\"avc1.4d401f\""
        ));
        assert!(!hls_variant_is_muxed_h264_aac(
            "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,CODECS=\"mp4a.40.2\""
        ));
        assert!(!hls_variant_is_muxed_h264_aac(
            "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,CODECS=\"avc1.4d401f,mp4a.40.5\""
        ));
    }

    #[test]
    fn youtube_hls_range_accepts_only_one_forward_byte_range() {
        assert!(valid_hls_range("bytes=0-"));
        assert!(valid_hls_range("bytes=100-199"));
        assert!(!valid_hls_range("bytes=-100"));
        assert!(!valid_hls_range("bytes=0-1,5-6"));
        assert!(!valid_hls_range("items=0-1"));
        assert_eq!(youtube_hls_local_range(None, 100).unwrap(), (0, 99, false));
        assert_eq!(
            youtube_hls_local_range(Some("bytes=10-19"), 100).unwrap(),
            (10, 19, true)
        );
        assert_eq!(
            youtube_hls_local_range(Some("bytes=90-999"), 100).unwrap(),
            (90, 99, true)
        );
        assert!(youtube_hls_local_range(Some("bytes=100-"), 100).is_err());
        let segment = reqwest::Url::parse(
            "https://rr1---sn.example.googlevideo.com/videoplayback/id/x/range/100-299/pot/proof/seg.ts",
        )
        .unwrap();
        assert_eq!(youtube_hls_segment_length_hint(&segment), Some(200));
    }

    #[tokio::test]
    async fn youtube_hls_ticket_initializes_its_upstream_response_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cache = Arc::new(tokio::sync::OnceCell::<YoutubeHlsCachedResult>::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let initialize = |cache: Arc<tokio::sync::OnceCell<YoutubeHlsCachedResult>>,
                          calls: Arc<AtomicUsize>| async move {
            cache
                .get_or_init(|| async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    Ok(YoutubeHlsCachedResponse {
                        content_type: "application/vnd.apple.mpegurl".into(),
                        body: YoutubeHlsCachedBody::Playlist(Bytes::from_static(b"#EXTM3U\n")),
                    })
                })
                .await
                .is_ok()
        };
        let (first, second) = tokio::join!(
            initialize(Arc::clone(&cache), Arc::clone(&calls)),
            initialize(Arc::clone(&cache), Arc::clone(&calls))
        );
        assert!(first && second);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn youtube_hls_upstream_never_widens_youtube_cookie_scope_to_googlevideo() {
        kdj_core::ensure_rustls_ring();
        let client = reqwest::Client::new();
        let url = reqwest::Url::parse(
            "https://rr1---sn.example.googlevideo.com/videoplayback/id/x/pot/proof/seg.ts",
        )
        .unwrap();
        let request = youtube_hls_upstream_request(
            &client,
            url,
            "Mozilla/5.0 AppleWebKit/605.1.15 Version/18.5 Safari/605.1.15",
            false,
        )
        .build()
        .unwrap();
        assert!(request.headers().get(header::COOKIE).is_none());
        assert_eq!(
            request.headers().get(header::REFERER).unwrap(),
            "https://www.youtube.com/"
        );
    }

    #[tokio::test]
    async fn waveform_binary_response_advertises_the_compact_profiled_contract() {
        let waveform = Waveform {
            track_id: 7,
            duration: 2.0,
            amp: vec![0.25, 0.75],
            minimum: vec![-0.2, -0.7],
            maximum: vec![0.25, 0.75],
            r: vec![255, 0],
            g: vec![0, 255],
            b: vec![1, 2],
            transient: vec![0, 255],
        };
        let response = waveform_response(
            waveform,
            WaveformRequestProfile::Current,
            WaveformResponseFormat::Binary,
        )
        .unwrap();
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            crate::waveform::WAVEFORM_BINARY_MIME
        );
        assert_eq!(
            response.headers()["x-kdj-waveform-profile"],
            crate::waveform::CURRENT_WAVEFORM_PROFILE
        );
        assert_eq!(
            response.headers()["x-kdj-waveform-revision"],
            crate::waveform::CURRENT_WAVEFORM_REVISION.to_string()
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..8], b"KDJWVFM\0");
        assert_eq!(body.len(), 36 + 2 * 8);
    }

    #[test]
    fn googlevideo_detection_only_accepts_the_media_host() {
        assert!(is_googlevideo_url(
            "https://rr1---sn.example.googlevideo.com/videoplayback?id=x"
        ));
        assert!(!is_googlevideo_url("https://cdn.example.test/audio"));
        assert_eq!(
            gvs_upstream_range(
                "https://rr1---sn.example.googlevideo.com/videoplayback?id=x",
                "bytes=65536-"
            ),
            "bytes=65536-1114111"
        );
        assert_eq!(
            gvs_upstream_range("https://cdn.example.test/audio", "bytes=10-"),
            "bytes=10-"
        );
    }

    #[test]
    fn web_po_tokens_accept_only_bounded_base64url_text() {
        let token = "A".repeat(120);
        assert!(valid_web_po_token(&token));
        assert!(valid_web_po_token(&format!("{}-_", "A".repeat(100))));
        assert!(!valid_web_po_token("short"));
        assert!(!valid_web_po_token(&format!("{}+", "A".repeat(100))));
        let url = format!(
            "https://rr1---sn.example.googlevideo.com/videoplayback?mime=audio%2Fmp4&pot={token}"
        );
        assert!(validated_ytm_browser_stream_url(&url, &token).is_ok());
        assert!(validated_ytm_browser_stream_url(
            &format!("https://example.test/videoplayback?mime=audio%2Fmp4&pot={token}"),
            &token
        )
        .is_err());
    }

    #[test]
    fn generic_preview_cannot_reintroduce_a_second_ytm_playback_path() {
        assert!(ensure_generic_song_preview_platform(Platform::Ytm).is_err());
        assert!(ensure_generic_song_preview_platform(Platform::Qqm).is_ok());
        assert!(ensure_generic_song_preview_platform(Platform::Wyy).is_ok());
    }

    #[test]
    fn ytm_download_urls_must_still_be_fresh_when_the_queue_starts() {
        let token = "A".repeat(120);
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        let fresh = format!(
            "https://rr1---sn.example.googlevideo.com/videoplayback?mime=audio%2Fwebm&pot={token}&expire={future}"
        );
        assert!(validated_fresh_ytm_download_url(&fresh, &token).is_ok());

        let expired = format!(
            "https://rr1---sn.example.googlevideo.com/videoplayback?mime=audio%2Fwebm&pot={token}&expire=1"
        );
        assert!(validated_fresh_ytm_download_url(&expired, &token).is_err());
        let no_expiry = format!(
            "https://rr1---sn.example.googlevideo.com/videoplayback?mime=audio%2Fwebm&pot={token}"
        );
        assert!(validated_fresh_ytm_download_url(&no_expiry, &token).is_err());
    }

    #[test]
    fn ytm_download_proof_count_covers_every_bounded_range() {
        let chunk = crate::protected_media::GVS_RANGE_CHUNK_BYTES;
        assert_eq!(required_ytm_download_proofs(1).unwrap(), 1);
        assert_eq!(required_ytm_download_proofs(chunk).unwrap(), 1);
        assert_eq!(required_ytm_download_proofs(chunk + 1).unwrap(), 2);
        assert_eq!(
            required_ytm_download_proofs(chunk * crate::protected_media::GVS_MAX_PROOFS as u64)
                .unwrap(),
            crate::protected_media::GVS_MAX_PROOFS
        );
        assert!(required_ytm_download_proofs(
            chunk * crate::protected_media::GVS_MAX_PROOFS as u64 + 1
        )
        .is_err());
    }

    #[test]
    fn ytm_download_segments_must_keep_the_same_stream_identity() {
        let first = ytm_download_stream_identity(
            "https://rr1---sn.example.googlevideo.com/videoplayback?clen=12000000&mime=audio%2Fwebm&itag=251",
        )
        .unwrap();
        let continuation = ytm_download_stream_identity(
            "https://rr2---sn.example.googlevideo.com/videoplayback?itag=251&mime=audio%2Fwebm&clen=12000000",
        )
        .unwrap();
        let other = ytm_download_stream_identity(
            "https://rr2---sn.example.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4&clen=12000000",
        )
        .unwrap();
        assert_eq!(first, continuation);
        assert_ne!(first, other);
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
        assert!(
            preview_cache_segment(StatusCode::OK, &whole, 40).is_none(),
            "a resumed request returning 200 must restart in a fresh attempt from byte 0"
        );
    }

    #[test]
    fn background_cache_has_exactly_two_bounded_retries() {
        assert_eq!(SONG_PREVIEW_CACHE_ATTEMPTS, 3);
        assert_eq!(
            song_preview_cache_retry_delay_after(0),
            Some(std::time::Duration::from_secs(1))
        );
        assert_eq!(
            song_preview_cache_retry_delay_after(1),
            Some(std::time::Duration::from_secs(4))
        );
        assert_eq!(song_preview_cache_retry_delay_after(2), None);
        assert_eq!(song_preview_cache_retry_delay_after(3), None);
    }

    #[test]
    fn bounded_retry_policy_reaches_a_third_success_or_one_terminal_failure() {
        fn simulate(successful_attempt: Option<usize>) -> (usize, usize) {
            let mut attempts = 0;
            let mut terminal_failures = 0;
            for attempt in 0..SONG_PREVIEW_CACHE_ATTEMPTS {
                attempts += 1;
                if successful_attempt == Some(attempt) {
                    break;
                }
                if song_preview_cache_retry_delay_after(attempt).is_none() {
                    terminal_failures += 1;
                    break;
                }
            }
            (attempts, terminal_failures)
        }

        assert_eq!(simulate(Some(2)), (3, 0));
        assert_eq!(simulate(None), (3, 1));
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
        assert_eq!(
            preview_audio_mime_for_url(
                &headers,
                "https://rr1---sn.example.googlevideo.com/videoplayback?mime=audio%2Fwebm%3Bcodecs%3Dopus"
            )
            .as_deref(),
            Some("audio/webm;codecs=opus"),
            "GVS octet-stream must retain the playback API's real container"
        );
        let empty = HeaderMap::new();
        assert_eq!(
            preview_audio_mime_for_url(
                &empty,
                "https://rr1---sn.example.googlevideo.com/videoplayback?mime=audio%2Fmp4"
            )
            .as_deref(),
            Some("audio/mp4")
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
        let disguised = reqwest::Url::parse("https://p1.music.126.net.evil.example/a.jpg").unwrap();
        assert!(cover_host_allowed(Platform::Wyy, &wyy));
        assert!(cover_host_allowed(Platform::Qqm, &qqm));
        assert!(!cover_host_allowed(Platform::Wyy, &qqm));
        assert!(!cover_host_allowed(Platform::Qqm, &other));
        assert!(!cover_host_allowed(Platform::Wyy, &disguised));
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

    #[tokio::test]
    async fn matched_lyrics_persist_for_a_source_less_track_and_remain_clearable() {
        let base = scratch("local-lyrics-cache");
        let state = undo_test_state(&base);
        let library_dir = base.join("library");
        std::fs::create_dir_all(&library_dir).unwrap();
        let audio = library_dir.join("song.mp3");
        std::fs::write(&audio, b"audio").unwrap();
        let id = insert_undo_track(&state, &audio);
        let payload = LyricsResponse {
            lrc: "[00:01.00]主歌词".into(),
            word_lrc: "[1000,500](1000,500,0)逐字".into(),
            translated_lrc: "[00:01.00]翻译".into(),
            romaji_lrc: String::new(),
            platform: Platform::Wyy,
            key: "42".into(),
            title: "song".into(),
            artist: "artist".into(),
            score: 0.95,
        };

        let cached = cache_library_lyrics(State(Arc::clone(&state)), AxumPath(id), Json(payload))
            .await
            .unwrap()
            .0;
        assert_eq!(cached.platform, Some(Platform::Wyy));
        assert_eq!(cached.word_lrc, "[1000,500](1000,500,0)逐字");

        let restored = library_lyrics(State(Arc::clone(&state)), AxumPath(id))
            .await
            .unwrap()
            .0;
        assert_eq!(restored.platform, Some(Platform::Wyy));
        assert_eq!(restored.key, "42");
        let track = state.library.get(id).unwrap().unwrap();
        assert_eq!(track.source_platform, "local");
        assert!(track.source_key.is_empty(), "歌词来源不能变成歌曲分享来源");

        crate::cache_overview::clear_lyrics(&state).await.unwrap();
        assert!(library_lyrics(State(Arc::clone(&state)), AxumPath(id))
            .await
            .is_err());
        drop(state);
        let _ = std::fs::remove_dir_all(&base);
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

    #[test]
    fn duplicate_analysis_recommends_the_lossless_copy() {
        let lossy = Track {
            id: 1,
            title: "Same Song".into(),
            artist: "Artist".into(),
            duration: Some(180.0),
            format: "mp3".into(),
            bitrate: Some(320),
            samplerate: Some(44_100),
            size: 8_000_000,
            source_platform: "wyy".into(),
            source_key: "same".into(),
            ..Track::default()
        };
        let lossless = Track {
            id: 2,
            format: "flac".into(),
            bitrate: Some(900),
            size: 30_000_000,
            ..lossy.clone()
        };
        let groups = duplicate_groups(vec![lossy, lossless]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].keep_id, 2);
        assert_eq!(groups[0].confidence, "high");
    }

    #[test]
    fn optimization_distinguishes_missing_files_from_an_offline_library_root() {
        let base = scratch("optimization-missing");
        let online = base.join("online");
        std::fs::create_dir_all(&online).unwrap();
        let missing = Track {
            id: 1,
            path: online.join("moved.mp3").to_string_lossy().into_owned(),
            filename: "moved.mp3".into(),
            ..Track::default()
        };
        let offline_root = base.join("offline-usb");
        let offline = Track {
            id: 2,
            path: offline_root.join("song.mp3").to_string_lossy().into_owned(),
            filename: "song.mp3".into(),
            ..Track::default()
        };
        let (missing_tracks, offline_roots, available_tracks) = unavailable_library_tracks(
            &[missing.clone(), offline],
            &[online, offline_root.clone()],
        );
        assert_eq!(missing_tracks.len(), 1);
        assert_eq!(missing_tracks[0].id, missing.id);
        assert_eq!(
            offline_roots,
            vec![offline_root.to_string_lossy().into_owned()]
        );
        assert!(available_tracks.is_empty());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn duplicate_analysis_does_not_merge_different_length_versions() {
        let original = Track {
            id: 1,
            title: "Same Song".into(),
            artist: "Artist".into(),
            duration: Some(180.0),
            format: "flac".into(),
            ..Track::default()
        };
        let live = Track {
            id: 2,
            duration: Some(240.0),
            ..original.clone()
        };
        assert!(duplicate_groups(vec![original, live]).is_empty());
    }
}
