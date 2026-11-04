//! `/api/kdjv/*`: checking, editing and playing `.kdjv` projects, and exporting them (export.rs).
use super::*;
use crate::{error::{ApiError, ApiResult}, state::AppState};
use axum::{
    extract::{Path as AxumPath, Query},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::Deserialize;
pub fn router(manager: Arc<Workshop>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/kdjv/check", post(kdjv_check))
        .route("/api/kdjv/edit", post(kdjv_edit))
        .route("/api/kdjv/preview", post(kdjv_preview))
        .route("/api/kdjv/rename", post(kdjv_rename))
        .route("/api/kdjv/source/{track_id}/{n}", get(kdjv_source))
        .route("/api/kdjv/image/{track_id}/{n}", get(kdjv_image))
        .route("/api/kdjv/cover/{track_id}", get(kdjv_cover))
        .route("/api/kdjv/export", post(super::export::kdjv_export))
        .route("/api/kdjv/title-image", post(kdjv_title_image).layer(axum::extract::DefaultBodyLimit::max(TITLE_IMAGE_BYTES * 2)))
        .layer(Extension(manager))
}
/// A `.kdjv` project (kdjv.rs), by its library row or its path.
#[derive(Deserialize)]
pub(super) struct KdjvTarget {
    #[serde(default)]
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) track_id: Option<i64>,
}
pub(super) fn kdjv_file(m: &Workshop, target: &KdjvTarget) -> Result<(std::path::PathBuf, Option<i64>)> {
    let (path, track_id) = match (target.track_id, target.path.as_deref()) {
        (Some(id), _) => (std::path::PathBuf::from(m.state.library.get(id)?.context("曲目不存在")?.path), Some(id)),
        (None, Some(path)) => (std::path::PathBuf::from(path), None),
        (None, None) => bail!("需要 path 或 track_id"),
    };
    if !kdjv::is_project_path(&path) {
        bail!("不是 .kdjv 工程：{}", path.display())
    }
    Ok((path, track_id))
}
/// Edits of a format 2 project (lanes.rs), by its path or library row.
#[derive(Deserialize)]
struct KdjvEdit {
    #[serde(flatten)]
    target: KdjvTarget,
    /// tracks.rs `Op`s, read once the project's format is known.
    ops: Vec<serde_json::Value>,
    #[serde(default)]
    create: bool,
}
async fn kdjv_edit(
    Extension(m): Extension<Arc<Workshop>>,
    Json(edit): Json<KdjvEdit>,
) -> ApiResult<Json<serde_json::Value>> {
    let (file, _) = kdjv_file(&m, &edit.target)?;
    let cancel = CancellationToken::new();
    Ok(Json(m.kdjv_edit(&file, &edit.ops, edit.create, &cancel).await?))
}
/// A project renamed, by its path or library row (kdjv.rs `kdjv_rename`).
#[derive(Deserialize)]
struct KdjvRename {
    #[serde(flatten)]
    target: KdjvTarget,
    name: String,
}
async fn kdjv_rename(
    Extension(m): Extension<Arc<Workshop>>,
    Json(rename): Json<KdjvRename>,
) -> ApiResult<Json<serde_json::Value>> {
    let (file, _) = kdjv_file(&m, &rename.target)?;
    let cancel = CancellationToken::new();
    Ok(Json(m.kdjv_rename(&file, &rename.name, &cancel).await?))
}
async fn kdjv_check(
    Extension(m): Extension<Arc<Workshop>>,
    Json(target): Json<KdjvTarget>,
) -> ApiResult<Json<kdjv::Checked>> {
    let (file, _) = kdjv_file(&m, &target)?;
    Ok(Json(m.kdjv_check(&file).await?))
}
/// What playing a project starts from (kdjv.rs `kdjv_preview`): its sound, mixed now if need be,
/// with `kdjv.progress` meanwhile, and the clips drawn live.
async fn kdjv_preview(
    Extension(m): Extension<Arc<Workshop>>,
    Json(target): Json<KdjvTarget>,
) -> ApiResult<Json<kdjv::Preview>> {
    let (file, track_id) = kdjv_file(&m, &target)?;
    let shown = file.to_string_lossy().into_owned();
    let state = m.state.clone();
    let cancel = CancellationToken::new();
    let last = Mutex::new(u32::MAX);
    let preview = m
        .kdjv_preview(&file, &cancel, &|progress, detail| {
            let step = (progress * 100.) as u32;
            if std::mem::replace(&mut *last.lock().unwrap(), step) == step {
                return;
            }
            state.hub.publish(
                "kdjv.progress",
                &serde_json::json!({"path": shown, "track_id": track_id, "progress": progress, "detail": detail, "error": null}),
            );
        })
        .await;
    if let Err(error) = &preview {
        state.hub.publish(
            "kdjv.progress",
            &serde_json::json!({"path": shown, "track_id": track_id, "progress": 0, "detail": "", "error": format!("{error:#}")}),
        );
    }
    Ok(Json(preview?))
}
/// One source file of a project's live preview, by the project's library row and the source's
/// number: only the files that project names are served, with Range for seeking.
async fn kdjv_source(
    Extension(m): Extension<Arc<Workshop>>,
    AxumPath((track_id, n)): AxumPath<(i64, usize)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let (file, _) = kdjv_file(&m, &KdjvTarget { path: None, track_id: Some(track_id) })?;
    let path = kdjv::source(&file, n).ok_or_else(|| crate::error::ApiError::not_found("工程里没有这个素材"))?;
    serve_file(&path, &headers).await
}
/// A file with Range for seeking, typed by its extension.
async fn serve_file(path: &std::path::Path, headers: &HeaderMap) -> ApiResult<Response> {
    let total = tokio::fs::metadata(path)
        .await
        .map_err(|err| crate::error::ApiError::not_found(format!("读不到素材：{err}")))?
        .len();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    let mime = match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    };
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).filter(|v| !v.trim().is_empty());
    crate::routes::audio_response(path, total, mime.into(), range).await
}
#[derive(Deserialize)]
struct ImageFrame {
    #[serde(default)]
    index: usize,
    /// Pixels wide; the picture's own size when 0.
    #[serde(default)]
    width: u32,
}
/// Frame `index` of a project's still or GIF source as PNG (frames.rs, pure Rust): what an export
/// draws for an image clip.
async fn kdjv_image(
    Extension(m): Extension<Arc<Workshop>>,
    AxumPath((track_id, n)): AxumPath<(i64, usize)>,
    Query(frame): Query<ImageFrame>,
) -> ApiResult<Response> {
    let (file, _) = kdjv_file(&m, &KdjvTarget { path: None, track_id: Some(track_id) })?;
    let source = tokio::task::spawn_blocking(move || Workshop::kdjv_image_source(&file, n)).await.map_err(|e| anyhow::anyhow!(e.to_string()))??;
    let data = m.image_frame(&source, frame.index, frame.width.min(7680)).await?;
    Ok((
        [(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "private, max-age=604800")],
        data,
    )
        .into_response())
}
/// Where a project row's cover is cut from (kdjv.rs `cover_source`): the source's number and the
/// second in it. The window decodes that frame and keeps it as the row's cover.
async fn kdjv_cover(
    Extension(m): Extension<Arc<Workshop>>,
    AxumPath(track_id): AxumPath<i64>,
) -> ApiResult<Json<serde_json::Value>> {
    let (file, _) = kdjv_file(&m, &KdjvTarget { path: None, track_id: Some(track_id) })?;
    let (source, at) = kdjv::cover_source(&file).ok_or_else(|| ApiError::not_found("工程里没有视频素材").expected())?;
    Ok(Json(serde_json::json!({"source": source, "at": at})))
}
/// The most a title's picture may weigh.
const TITLE_IMAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
struct TitleImage {
    /// The PNG, base64.
    png: String,
}

/// A title's text drawn as a picture by the editor, kept in KDJ's data folder (not beside the
/// project, where the library would take it for an image of its own), named by what it holds.
async fn kdjv_title_image(
    Extension(m): Extension<Arc<Workshop>>,
    Json(image): Json<TitleImage>,
) -> ApiResult<Json<serde_json::Value>> {
    let path = save_title_image(&m.state.config.data_dir, &image.png)?;
    Ok(Json(serde_json::json!({"src": path})))
}

fn save_title_image(data_dir: &std::path::Path, png: &str) -> Result<std::path::PathBuf> {
    use base64::Engine;
    use sha2::Digest;
    let bytes = base64::engine::general_purpose::STANDARD.decode(png.as_bytes()).context("不是 base64")?;
    if bytes.len() > TITLE_IMAGE_BYTES || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        bail!("字幕图要是 4 MB 以内的 PNG")
    }
    let digest = sha2::Sha256::digest(&bytes);
    let name: String = digest.iter().take(10).map(|b| format!("{b:02x}")).collect();
    let folder = data_dir.join("kdjv-titles");
    std::fs::create_dir_all(&folder)?;
    let path = folder.join(format!("{name}.png"));
    if !path.is_file() {
        let temporary = path.with_extension(format!("png.{}.tmp", std::process::id()));
        std::fs::write(&temporary, &bytes)?;
        std::fs::rename(&temporary, &path)?;
    }
    Ok(path)
}

