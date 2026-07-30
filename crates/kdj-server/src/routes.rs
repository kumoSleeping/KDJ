//! HTTP 路由。路径和响应形状必须和 `sidecar/kdj/app.py` 一一对应——
//! 前端 `src/lib/api.ts` 是照着旧契约写的。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use kdj_core::models::*;
use kdj_core::Settings;
use kdj_library::service::{FileDisposal, TrackQuery};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::downloads::{enqueue_audio, enqueue_video, enqueue_vj_export, DownloadManager};
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
        .route("/api/lyrics", post(lyrics))
        .route("/api/song/preview", post(song_preview))
        .route("/api/song/preview/{token}", get(song_preview_stream))
        .route("/api/resolve", post(resolve))
        .route("/api/intake", post(intake))
        .route("/api/downloads", get(list_downloads).post(enqueue))
        .route("/api/downloads/{id}", delete(remove_download))
        .route("/api/downloads/start", post(start_downloads))
        .route("/api/downloads/{id}/cancel", post(cancel_download))
        .route("/api/downloads/clear", post(clear_downloads))
        .route("/api/video/resolve", post(video_resolve))
        .route("/api/video/download", post(video_download))
        .route("/api/video/preview", get(video_preview))
        .route("/api/video/calibrate", post(video_calibrate))
        .route("/api/vj/export", post(vj_export))
        .route("/api/library/tracks", get(library_tracks))
        .route("/api/library/tracks/{id}", get(library_track))
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
    let settings = state.config.apply_settings(payload);
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

// ---------------------------------------------------------------- 搜索

async fn search(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SearchRequest>,
) -> Json<SearchResponse> {
    Json(crate::aggregate::search(&state, &payload).await)
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
}

/// 搜索结果里的「试听」：拿一条**最低码率**的播放直链，不下载不入库。
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
    match provider.preview_url(&body.source).await? {
        Some(url) => {
            let token = format!("{:016x}{:016x}", rand::random::<u64>(), rand::random::<u64>());
            let mut previews = state.song_previews.lock().unwrap();
            previews.retain(|_, (_, created)| created.elapsed() < std::time::Duration::from_secs(1800));
            previews.insert(token.clone(), (url, std::time::Instant::now()));
            Ok(Json(json!({ "url": format!("/api/song/preview/{token}") })))
        }
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
    let url = state
        .song_previews
        .lock()
        .unwrap()
        .get(&token)
        .map(|(url, _)| url.clone())
        .ok_or_else(|| ApiError::not_found("试听地址已过期，请重新双击歌曲"))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|err| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;
    let mut request = client.get(url);
    if let Some(range) = headers.get(header::RANGE).and_then(|value| value.to_str().ok()) {
        request = request.header(reqwest::header::RANGE, range);
    }
    let upstream = request
        .send()
        .await
        .map_err(|err| ApiError::new(StatusCode::BAD_GATEWAY, format!("试听源连接失败：{err}")))?;
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        return Err(ApiError::new(status, format!("试听源返回 HTTP {status}")));
    }
    let upstream_headers = upstream.headers().clone();
    let content_type = upstream_headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.starts_with("audio/"))
        .unwrap_or("audio/mpeg")
        .to_string();
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
    let stream = upstream.bytes_stream().map(|chunk| {
        chunk.map_err(|err| std::io::Error::other(format!("试听流读取失败：{err}")))
    });
    builder
        .body(axum::body::Body::from_stream(stream))
        .map_err(|err| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))
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

async fn intake_one(
    state: &Arc<AppState>,
    entry: &str,
    payload: &IntakeRequest,
) -> IntakeItem {
    let mut item = IntakeItem {
        entry: entry.to_string(),
        kind: IntakeKind::Search,
        platform: None,
        title: String::new(),
        groups: Vec::new(),
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
        },
    )
    .await;
    item.title = entry.to_string();
    item.groups = response.groups;
    item.errors = response.errors;
    item
}

// ---------------------------------------------------------------- 下载

async fn list_downloads(axum::Extension(ctx): axum::Extension<Ctx>) -> Json<Vec<DownloadTask>> {
    Json(ctx.downloads.list())
}

async fn start_downloads(axum::Extension(ctx): axum::Extension<Ctx>) -> Json<serde_json::Value> {
    ctx.downloads.release_queued();
    Json(json!({ "started": true }))
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
    if !matches!(task.state, TaskState::Done | TaskState::Failed | TaskState::Canceled) {
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
    let stream = state
        .bilibili
        .preview_stream(&params.bvid, params.page, range)
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
    let variance = values.iter().map(|value| (value - mean).powi(2)).sum::<f64>() / values.len() as f64;
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
        .args(["-i", &input, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"])
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
        .map_err(|err| ApiError::new(StatusCode::BAD_GATEWAY, format!("获取视频音轨失败：{err:#}")))?;
    let headers = format!(
        "Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0\r\n{}",
        if cookies.is_empty() { String::new() } else { format!("Cookie: {cookies}\r\n") }
    );
    let local_path = track.path;
    let local_job = tokio::task::spawn_blocking(move || decode_alignment_envelope(local_path, None));
    let video_job = tokio::task::spawn_blocking(move || decode_alignment_envelope(video_url, Some(headers)));
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
    // 删不存在的曲目要 404：回 200 + {"ok": false} 的话前端会当成删成功，
    // 把那一行从列表里抹掉，刷新之后它又回来了
    if !state.library.delete(id, disposal)? {
        return Err(ApiError::not_found("曲目不存在"));
    }
    state.hub.publish_library_updated(&[id]);
    Ok(Json(json!({ "ok": true })))
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
    let mut removed: Vec<i64> = Vec::new();
    let mut errors = serde_json::Map::new();
    for id in payload.track_ids {
        match state.library.delete(id, disposal) {
            Ok(_) => removed.push(id), // false=库里本来就没有：目的已达成，不算失败
            Err(err) => {
                errors.insert(id.to_string(), json!(format!("{err:#}")));
            }
        }
    }
    if !removed.is_empty() {
        state.hub.publish_library_updated(&removed);
    }
    Ok(Json(json!({ "removed": removed.len(), "errors": errors })))
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
    let touched: std::collections::HashSet<&str> =
        submitted.iter().map(String::as_str).collect();
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
    let target = kdj_library::folders::ensure_inside(
        Path::new(&payload.path),
        &require_roots(&state)?,
    )?;
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

async fn folder_apply(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<FolderOpRequest>,
) -> ApiResult<Json<FolderOpResult>> {
    let roots = require_roots(&state)?;
    let dest = kdj_library::folders::ensure_inside(Path::new(&payload.dest), &roots)?;
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
                    state.library.relocate(*id, &target)?;
                    track_ids.push(*id);
                    *methods.entry("move".into()).or_insert(0) += 1;
                }
                Err(err) => {
                    errors.insert(id.to_string(), format!("{err:#}"));
                }
            },
            FileOp::Link => match kdj_library::folders::link_file(&source, &dest) {
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

    // 一条都没动时不发事件：白发一条 library.updated 会让前端整表刷一次
    if !track_ids.is_empty() {
        state.hub.publish_library_updated(&track_ids);
    }
    Ok(Json(FolderOpResult {
        track_ids,
        op: payload.op,
        methods,
        errors,
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
    let pending = state
        .library
        .pending_analysis_ids(payload.track_ids.as_deref(), payload.force)?;
    let queued = pending.len();
    // `priority` 必须透传：前端「放到一首还没分析的歌」就是靠它插队的，
    // 吞掉这个字段的话，那一首会跟着「停止分析」一起被掐掉（见 jobs.rs）
    let job_id = crate::jobs::spawn_analysis(state.clone(), pending, payload.priority);
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
    if std::fs::metadata(&target).map(|meta| meta.len() > 0).unwrap_or(false) {
        return Ok(target);
    }
    if !kdj_providers::ffmpeg::available() {
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "系统里没有 ffmpeg，视频音轨播放不了",
        ));
    }
    std::fs::create_dir_all(cache_dir)
        .map_err(|err| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, format!("建缓存目录失败：{err}")))?;
    let tmp = cache_dir.join(format!("{track_id}-{mtime}.partial.m4a"));
    let log = cache_dir.join(format!("{track_id}-{mtime}.log"));
    let cancel = tokio_util::sync::CancellationToken::new();
    // webm/mkv 里常见 opus/vorbis，塞不进 m4a 容器，copy 会失败 → 第二轮转码
    for copy in [true, false] {
        let args = kdj_providers::ffmpeg::extract_audio_args(path, &tmp, copy, 0);
        if kdj_providers::ffmpeg::run(&args, &log, &cancel).await.is_ok()
            && std::fs::metadata(&tmp).map(|meta| meta.len() > 0).unwrap_or(false)
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
    let stream =
        tokio_util::io::ReaderStream::with_capacity(file.take(length), STREAM_CHUNK);

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
    let spec = normalized
        .strip_prefix("bytes=")?
        .split(',')
        .next()?
        .trim();
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
        (
            header::CACHE_CONTROL,
            "private, max-age=3600".to_string(),
        ),
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
        .map_err(|err| {
            ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, format!("{err:#}"))
        })?;
    Ok(Json(wave))
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
        let ok = kdj_providers::ffmpeg::run(
            &args,
            &log,
            &tokio_util::sync::CancellationToken::new(),
        )
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
            &[path.clone(), base.join("不存在").to_string_lossy().into_owned()],
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
