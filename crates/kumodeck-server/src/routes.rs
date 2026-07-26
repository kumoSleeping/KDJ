//! HTTP 路由。路径和响应形状必须和 `sidecar/kumodeck/app.py` 一一对应——
//! 前端 `src/lib/api.ts` 是照着旧契约写的。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use kumodeck_core::models::*;
use kumodeck_core::Settings;
use kumodeck_library::service::TrackQuery;
use serde::Deserialize;
use serde_json::json;

use crate::downloads::{enqueue_audio, enqueue_video, DownloadManager};
use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, PLATFORMS};

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
        .route("/api/search", post(search))
        .route("/api/resolve", post(resolve))
        .route("/api/downloads", get(list_downloads).post(enqueue))
        .route("/api/downloads/{id}/cancel", post(cancel_download))
        .route("/api/downloads/clear", post(clear_downloads))
        .route("/api/video/resolve", post(video_resolve))
        .route("/api/video/download", post(video_download))
        .route("/api/library/tracks", get(library_tracks))
        .route("/api/library/tracks/{id}", get(library_track))
        .route("/api/library/tracks/{id}", patch(library_patch))
        .route("/api/library/tracks/{id}", delete(library_delete))
        .route("/api/library/tracks/{id}/write-tags", post(write_tags))
        .route("/api/library/stats", get(library_stats))
        .route("/api/library/harmonic/{id}", get(library_harmonic))
        .route("/api/library/folders", get(library_folders))
        .route("/api/library/folders/create", post(folder_create))
        .route("/api/library/folders/rename", post(folder_rename))
        .route("/api/library/folders/delete", post(folder_delete))
        .route("/api/library/folders/init", post(folder_init))
        .route("/api/library/folders/move", post(folder_move))
        .route("/api/library/folders/order", post(folder_order))
        .route("/api/library/folders/apply", post(folder_apply))
        .route("/api/library/scan", post(library_scan))
        .route("/api/library/analyze", post(library_analyze))
        .route("/api/library/audio/{id}", get(library_audio))
        .route("/api/library/cover/{id}", get(library_cover))
        .layer(axum::Extension(ctx))
}

// ---------------------------------------------------------------- 基础

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    Json(Health {
        ok: true,
        version: kumodeck_core::VERSION.to_string(),
        ffmpeg: kumodeck_providers::ffmpeg::available(),
        data_dir: state.config.data_dir.to_string_lossy().into_owned(),
        download_dir: state.config.download_dir().to_string_lossy().into_owned(),
        // 前端据此隐藏安卓上做不了的桌面专属入口
        platform: std::env::consts::OS.to_string(),
    })
}

async fn get_settings(State(state): State<Arc<AppState>>) -> Json<Settings> {
    Json(state.config.to_settings())
}

async fn put_settings(
    State(state): State<Arc<AppState>>,
    axum::Extension(ctx): axum::Extension<Ctx>,
    Json(payload): Json<Settings>,
) -> Json<Settings> {
    let settings = state.config.apply_settings(payload);
    ctx.downloads.set_concurrency(settings.concurrent_downloads);
    Json(settings)
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

// ---------------------------------------------------------------- 搜索

async fn search(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SearchRequest>,
) -> Json<SearchResponse> {
    Json(crate::aggregate::search(&state, &payload).await)
}

async fn resolve(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ResolveRequest>,
) -> ApiResult<Json<ResolveResponse>> {
    // 挨个问 provider 认不认这个链接；不是自己的返回 Ok(None)
    for platform in PLATFORMS {
        let Some(provider) = state.provider(platform) else {
            continue;
        };
        match provider.resolve(&payload.url, payload.limit).await {
            Ok(Some(response)) => return Ok(Json(response)),
            Ok(None) => continue,
            Err(err) => return Err(ApiError::bad_request(format!("{err:#}"))),
        }
    }
    Err(ApiError::bad_request("没有平台认领这个链接"))
}

// ---------------------------------------------------------------- 下载

async fn list_downloads(axum::Extension(ctx): axum::Extension<Ctx>) -> Json<Vec<DownloadTask>> {
    Json(ctx.downloads.list())
}

async fn enqueue(
    State(state): State<Arc<AppState>>,
    axum::Extension(ctx): axum::Extension<Ctx>,
    Json(payload): Json<DownloadRequest>,
) -> Json<Vec<DownloadTask>> {
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
            )
        })
        .collect();
    Json(tasks)
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

async fn clear_downloads(axum::Extension(ctx): axum::Extension<Ctx>) -> Json<serde_json::Value> {
    Json(json!({ "removed": ctx.downloads.clear_finished() }))
}

// ---------------------------------------------------------------- 视频

#[derive(Deserialize)]
struct VideoResolveBody {
    url: String,
}

async fn video_resolve(
    State(state): State<Arc<AppState>>,
    Json(body): Json<VideoResolveBody>,
) -> ApiResult<Json<VideoInfo>> {
    Ok(Json(state.bilibili.resolve_video(&body.url).await?))
}

async fn video_download(
    State(state): State<Arc<AppState>>,
    axum::Extension(ctx): axum::Extension<Ctx>,
    Json(payload): Json<VideoDownloadRequest>,
) -> ApiResult<Json<DownloadTask>> {
    // 先解析一次拿标题，队列面板上才不是一个光秃秃的 BV 号
    let probe = if payload.bvid.is_empty() {
        payload.url.clone()
    } else {
        payload.bvid.clone()
    };
    let title = state
        .bilibili
        .resolve_video(&probe)
        .await
        .map(|info| info.title)
        .unwrap_or_else(|_| probe.clone());
    Ok(Json(enqueue_video(
        state.clone(),
        ctx.downloads.clone(),
        payload,
        title,
    )))
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
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn library_tracks(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TrackQueryParams>,
) -> ApiResult<Json<TrackPage>> {
    let query = TrackQuery {
        q: params.q,
        key: params.key,
        bpm_min: params.bpm_min,
        bpm_max: params.bpm_max,
        energy_min: params.energy_min,
        analyzed: params.analyzed,
        folder: params.folder,
        folder_deep: params.folder_deep,
        sort: params.sort.unwrap_or_else(|| "added_at".into()),
        order: params.order.unwrap_or_else(|| "desc".into()),
        limit: params.limit.unwrap_or(200).clamp(1, 1000),
        offset: params.offset.unwrap_or(0).max(0),
    };
    Ok(Json(state.library.list_tracks(&query)?))
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

async fn library_patch(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Json(payload): Json<TrackPatch>,
) -> ApiResult<Json<Track>> {
    let track = state.library.patch(id, &payload)?;
    state.hub.publish_library_updated(&[id]);
    Ok(Json(track))
}

#[derive(Deserialize)]
struct DeleteParams {
    #[serde(default)]
    delete_file: bool,
}

async fn library_delete(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Query(params): Query<DeleteParams>,
) -> ApiResult<Json<serde_json::Value>> {
    let ok = state.library.delete(id, params.delete_file)?;
    state.hub.publish_library_updated(&[id]);
    Ok(Json(json!({ "ok": ok })))
}

async fn write_tags(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<Json<Track>> {
    let track = state
        .library
        .get(id)?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    kumodeck_providers::tags::write_analysis_tags(
        Path::new(&track.path),
        track.bpm,
        &track.camelot,
        &track.music_key,
        track.energy,
    )?;
    Ok(Json(track))
}

async fn library_stats(State(state): State<Arc<AppState>>) -> ApiResult<Json<LibraryStats>> {
    Ok(Json(state.library.stats()?))
}

#[derive(Deserialize)]
struct HarmonicParams {
    #[serde(default = "default_tolerance")]
    bpm_tolerance: f64,
    #[serde(default = "default_harmonic_limit")]
    limit: usize,
}
fn default_tolerance() -> f64 {
    12.0
}
fn default_harmonic_limit() -> usize {
    60
}

async fn library_harmonic(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Query(params): Query<HarmonicParams>,
) -> ApiResult<Json<Vec<HarmonicMatch>>> {
    Ok(Json(state.library.harmonic_matches(
        id,
        params.bpm_tolerance,
        params.limit,
        true,
    )?))
}

// ---------------------------------------------------------------- 文件夹

fn library_roots(state: &AppState) -> Vec<PathBuf> {
    let settings = state.config.to_settings();
    let roots = kumodeck_library::folders::resolve_roots(&settings.library_dirs);
    if !roots.is_empty() {
        return roots;
    }
    // 没配曲库目录时从已入库路径反推，否则文件夹树一片空白而歌明明都在
    state
        .library
        .all_paths()
        .map(|paths| kumodeck_library::folders::infer_roots(&paths))
        .unwrap_or_default()
}

fn folder_tree(state: &AppState) -> ApiResult<FolderTree> {
    let paths = state.library.all_paths()?;
    let roots: Vec<String> = library_roots(state)
        .into_iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect();
    Ok(kumodeck_library::folders::build_tree(&roots, &paths))
}

async fn library_folders(State(state): State<Arc<AppState>>) -> ApiResult<Json<FolderTree>> {
    Ok(Json(folder_tree(&state)?))
}

async fn folder_create(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderCreateRequest>,
) -> ApiResult<Json<FolderTree>> {
    kumodeck_library::folders::create_folder(
        Path::new(&payload.parent),
        &payload.name,
        &library_roots(&state),
    )?;
    Ok(Json(folder_tree(&state)?))
}

async fn folder_rename(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderRenameRequest>,
) -> ApiResult<Json<FolderTree>> {
    let source = PathBuf::from(&payload.path);
    let target = kumodeck_library::folders::rename_folder(
        &source,
        &payload.name,
        &library_roots(&state),
    )?;
    // 目录改名后库里的 path 要跟着改，否则整批曲目会变成"文件不存在"
    let ids = state.library.rebase_paths(&source, &target)?;
    state.hub.publish_library_updated(&ids);
    Ok(Json(folder_tree(&state)?))
}

async fn folder_delete(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderDeleteRequest>,
) -> ApiResult<Json<FolderTree>> {
    kumodeck_library::folders::delete_folder(Path::new(&payload.path), &library_roots(&state))?;
    Ok(Json(folder_tree(&state)?))
}

async fn folder_init(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderInitRequest>,
) -> ApiResult<Json<FolderTree>> {
    let roots = library_roots(&state);
    let targets: Vec<PathBuf> = if payload.path.trim().is_empty() {
        roots.clone()
    } else {
        vec![PathBuf::from(payload.path.trim())]
    };
    for target in targets {
        kumodeck_library::folders::init_manifests(&target, &roots)?;
    }
    Ok(Json(folder_tree(&state)?))
}

async fn folder_move(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderMoveRequest>,
) -> ApiResult<Json<FolderTree>> {
    let (old, new) = kumodeck_library::folders::move_folder(
        Path::new(&payload.path),
        Path::new(&payload.dest_parent),
        &library_roots(&state),
    )?;
    let ids = state.library.rebase_paths(&old, &new)?;
    state.hub.publish_library_updated(&ids);
    Ok(Json(folder_tree(&state)?))
}

async fn folder_order(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderOrderRequest>,
) -> ApiResult<Json<FolderTree>> {
    let target = kumodeck_library::folders::ensure_inside(
        Path::new(&payload.path),
        &library_roots(&state),
    )?;
    kumodeck_library::folders::write_manifest(&target, &payload.names);
    Ok(Json(folder_tree(&state)?))
}

async fn folder_apply(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderOpRequest>,
) -> ApiResult<Json<FolderOpResult>> {
    let roots = library_roots(&state);
    let dest = kumodeck_library::folders::ensure_inside(Path::new(&payload.dest), &roots)?;
    if !dest.is_dir() {
        return Err(ApiError::bad_request("目标不是文件夹"));
    }

    let mut track_ids = Vec::new();
    let mut methods: BTreeMap<String, i64> = BTreeMap::new();
    let mut errors: BTreeMap<String, String> = BTreeMap::new();

    for id in &payload.track_ids {
        let Some(track) = state.library.get(*id)? else {
            errors.insert(id.to_string(), "曲目不存在".into());
            continue;
        };
        let source = PathBuf::from(&track.path);
        match payload.op {
            FileOp::Move => match kumodeck_library::folders::move_file(&source, &dest) {
                Ok(target) => {
                    state.library.relocate(*id, &target)?;
                    track_ids.push(*id);
                    *methods.entry("move".into()).or_insert(0) += 1;
                }
                Err(err) => {
                    errors.insert(id.to_string(), format!("{err:#}"));
                }
            },
            FileOp::Link => match kumodeck_library::folders::link_file(&source, &dest) {
                Ok((target, method)) => {
                    // 链接出来的那一份是新曲目，把分析结果和人工标记一并带过去
                    match state.library.upsert_file(&target, &track.source_platform, &track.source_key) {
                        Ok(new_id) => {
                            state.library.clone_metadata(*id, new_id)?;
                            track_ids.push(new_id);
                            *methods.entry(method.to_string()).or_insert(0) += 1;
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

    state.hub.publish_library_updated(&track_ids);
    Ok(Json(FolderOpResult {
        track_ids,
        op: payload.op,
        methods,
        errors,
    }))
}

// ---------------------------------------------------------------- 扫描 / 分析

async fn library_scan(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ScanRequest>,
) -> ApiResult<Json<ScanResponse>> {
    // 不传路径就扫全部曲库根
    let paths = if payload.paths.is_empty() {
        library_roots(&state)
            .into_iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect()
    } else {
        payload.paths
    };
    let found = kumodeck_library::scan::collect_files(&paths, payload.recursive).len();
    let job_id = crate::jobs::spawn_scan(state.clone(), paths, payload.recursive, payload.analyze);
    Ok(Json(ScanResponse { job_id, found }))
}

async fn library_analyze(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AnalyzeRequest>,
) -> ApiResult<Json<AnalyzeResponse>> {
    let pending = state
        .library
        .pending_analysis_ids(payload.track_ids.as_deref(), payload.force)?;
    let write_tags = state.config.to_settings().write_tags_after_analyze;
    let queued = pending.len();
    let job_id = crate::jobs::spawn_analysis(state.clone(), pending, write_tags);
    Ok(Json(AnalyzeResponse { job_id, queued }))
}

// ---------------------------------------------------------------- 媒体

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
    let path = PathBuf::from(&track.path);
    let data = std::fs::read(&path)
        .map_err(|err| ApiError::not_found(format!("读不到音频文件：{err}")))?;
    let total = data.len() as u64;
    let mime = mime_for(&path);

    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_range(value, total));

    let Some((start, end)) = range else {
        return Ok((
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, mime),
                (header::ACCEPT_RANGES, "bytes".to_string()),
                (header::CONTENT_LENGTH, total.to_string()),
            ],
            data,
        )
            .into_response());
    };

    let slice = data[start as usize..=(end as usize)].to_vec();
    Ok((
        StatusCode::PARTIAL_CONTENT,
        [
            (header::CONTENT_TYPE, mime),
            (header::ACCEPT_RANGES, "bytes".to_string()),
            (
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total}"),
            ),
            (header::CONTENT_LENGTH, (end - start + 1).to_string()),
        ],
        slice,
    )
        .into_response())
}

/// `bytes=0-1023` / `bytes=1024-` / `bytes=-500`
fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = value.strip_prefix("bytes=")?.split(',').next()?.trim();
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

async fn library_cover(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<Response> {
    let track = state
        .library
        .get(id)?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    let (data, mime) = kumodeck_providers::tags::read_cover(Path::new(&track.path))
        .ok_or_else(|| ApiError::not_found("这首没有封面"))?;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            // 封面不会变，让浏览器缓存住，翻列表时不用反复请求
            (header::CACHE_CONTROL, "private, max-age=86400".to_string()),
        ],
        data,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing_covers_the_three_forms() {
        assert_eq!(parse_range("bytes=0-1023", 4096), Some((0, 1023)));
        assert_eq!(parse_range("bytes=1024-", 4096), Some((1024, 4095)));
        assert_eq!(parse_range("bytes=-500", 4096), Some((3596, 4095)));
    }

    #[test]
    fn range_end_is_clamped_to_the_file_length() {
        // 播放器经常请求一个超出末尾的 end，不能因此 500
        assert_eq!(parse_range("bytes=0-99999", 4096), Some((0, 4095)));
    }

    #[test]
    fn malformed_or_unsatisfiable_ranges_fall_back_to_a_full_response() {
        assert_eq!(parse_range("bytes=5000-6000", 4096), None);
        assert_eq!(parse_range("items=0-10", 4096), None);
        assert_eq!(parse_range("bytes=abc", 4096), None);
        assert_eq!(parse_range("bytes=100-50", 4096), None, "start > end");
        assert_eq!(parse_range("bytes=0-10", 0), None, "空文件没有可用范围");
    }

    #[test]
    fn audio_mime_types_match_the_container() {
        assert_eq!(mime_for(Path::new("a.mp3")), "audio/mpeg");
        assert_eq!(mime_for(Path::new("a.FLAC")), "audio/flac");
        assert_eq!(mime_for(Path::new("a.m4a")), "audio/mp4");
        assert_eq!(mime_for(Path::new("a.xyz")), "application/octet-stream");
    }
}
