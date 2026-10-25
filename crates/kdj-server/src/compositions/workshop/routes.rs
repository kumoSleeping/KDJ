//! `/api/kdjv/*`: checking and rendering `.kdjv` projects for playing, and exporting them as MP4.
use super::*;
use crate::{error::ApiResult, state::AppState};
use axum::{
    body::{Body, Bytes},
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
        .route("/api/kdjv/proxy/{track_id}/{n}", get(kdjv_proxy))
        .route("/api/kdjv/frame", get(kdjv_frame))
        .route("/api/kdjv/render", post(kdjv_render))
        .route("/api/kdjv/export", post(kdjv_export))
        .route("/api/kdjv/title-image", post(kdjv_title_image).layer(axum::extract::DefaultBodyLimit::max(TITLE_IMAGE_BYTES * 2)))
        .layer(Extension(manager))
}
/// A `.kdjv` project (kdjv.rs), by its library row or its path.
#[derive(Deserialize)]
struct KdjvTarget {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    track_id: Option<i64>,
    /// Answer as NDJSON: a `{"event":"progress","done","total":100,"detail"}` line each second
    /// while the render runs, then `{"event":"result",…}` or `{"event":"error","message"}`.
    #[serde(default)]
    stream: bool,
}
fn kdjv_file(m: &Workshop, target: &KdjvTarget) -> Result<(std::path::PathBuf, Option<i64>)> {
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
/// with `kdjv.progress` meanwhile; its render when there is one; and the clips drawn live.
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
    let (file, _) = kdjv_file(&m, &KdjvTarget { path: None, track_id: Some(track_id), stream: false })?;
    let path = kdjv::source(&file, n).ok_or_else(|| crate::error::ApiError::not_found("工程里没有这个素材"))?;
    serve_file(&path, &headers).await
}
/// A video source's preview proxy (proxy.rs), once made: what the live preview loads instead of
/// the source when the project says `proxy`.
async fn kdjv_proxy(
    Extension(m): Extension<Arc<Workshop>>,
    AxumPath((track_id, n)): AxumPath<(i64, usize)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let (file, _) = kdjv_file(&m, &KdjvTarget { path: None, track_id: Some(track_id), stream: false })?;
    let source = kdjv::source(&file, n).ok_or_else(|| crate::error::ApiError::not_found("工程里没有这个素材"))?;
    let path = m.kdjv_proxy(&source).ok_or_else(|| crate::error::ApiError::not_found("预览代理还没做好"))?;
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
/// One frame of a project's source, for the editor's picture lane.
#[derive(Deserialize)]
struct KdjvFrame {
    track_id: i64,
    /// The source as the document names it.
    src: String,
    /// Seconds into the source.
    t: f64,
    /// Pixels high (the width follows the picture).
    #[serde(default)]
    h: Option<u32>,
}
/// A small JPEG of the source at `t`, made once by ffmpeg and kept in the render cache, named by
/// the file (and its change time), the time to a tenth of a second and the height.
async fn kdjv_frame(
    Extension(m): Extension<Arc<Workshop>>,
    Query(q): Query<KdjvFrame>,
) -> ApiResult<Response> {
    use sha2::Digest;
    let (file, _) = kdjv_file(&m, &KdjvTarget { path: None, track_id: Some(q.track_id), stream: false })?;
    let source = kdjv::named_source(&file, &q.src).ok_or_else(|| crate::error::ApiError::not_found("工程里没有这个素材"))?;
    let height = q.h.unwrap_or(72).clamp(24, 240);
    let tenths = (q.t.max(0.0) * 10.0).round() as u64;
    let changed = std::fs::metadata(&source)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let digest = sha2::Sha256::digest(format!("{}\0{changed}\0{tenths}\0{height}", source.display()).as_bytes());
    let name: String = digest.iter().take(12).map(|b| format!("{b:02x}")).collect();
    // Beside the renders, so the cache's own trim keeps it in bounds.
    let folder = m.cache.clone();
    let target = folder.join(format!("frame-{name}.jpg"));
    let cached = tokio::fs::read(&target).await.ok().filter(|data| !data.is_empty());
    let data = match cached {
        Some(data) => data,
        None => {
            let _slot = m.frame_slots.acquire().await.map_err(anyhow::Error::from)?;
            let partial = folder.join(format!("frame-{name}.{}.part", std::process::id()));
            let log = folder.join(format!("frame-{name}.log"));
            let args: Vec<String> = vec![
                "-y".into(), "-ss".into(), format!("{:.1}", tenths as f64 / 10.0),
                "-i".into(), source.to_string_lossy().into_owned(),
                "-frames:v".into(), "1".into(), "-an".into(),
                "-vf".into(), format!("scale=-2:{height}"),
                "-q:v".into(), "5".into(), "-f".into(), "mjpeg".into(), partial.to_string_lossy().into_owned(),
            ];
            let cancel = CancellationToken::new();
            let made = tokio::time::timeout(std::time::Duration::from_secs(20), kdj_providers::ffmpeg::run(&args, &log, &cancel)).await;
            let _ = std::fs::remove_file(&log);
            let data = match made {
                Ok(Ok(())) => tokio::fs::read(&partial).await.ok().filter(|data| !data.is_empty()),
                _ => None,
            };
            let Some(data) = data else {
                let _ = std::fs::remove_file(&partial);
                return Err(crate::error::ApiError::not_found("这一帧取不出来").expected());
            };
            let _ = std::fs::rename(&partial, &target);
            m.trim_cache();
            data
        }
    };
    Ok((
        [(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=604800")],
        data,
    )
        .into_response())
}
/// Starts a project's render, or the wait for one under way (kdjv.rs keeps one per project).
/// It runs on its own: a caller that goes away leaves it to finish. `kdjv.progress` tells the
/// window how far it is, and so does the returned watch: percent and what is being done.
fn spawn_render(
    m: &Arc<Workshop>,
    file: std::path::PathBuf,
    track_id: Option<i64>,
    options: kdjv::RenderOptions,
) -> (tokio::task::JoinHandle<Result<std::path::PathBuf>>, tokio::sync::watch::Receiver<(u32, String)>) {
    let worker = m.clone();
    let shown = file.to_string_lossy().into_owned();
    let (tell, watch) = tokio::sync::watch::channel((0_u32, String::new()));
    let job = tokio::spawn(async move {
        let state = worker.state.clone();
        let publish = |progress: f64, detail: &str, error: Option<&str>| {
            state.hub.publish(
                "kdjv.progress",
                &serde_json::json!({"path": shown, "track_id": track_id, "progress": progress, "detail": detail, "error": error}),
            );
        };
        let last = Mutex::new((u32::MAX, String::new()));
        let cancel = CancellationToken::new();
        let rendered = worker
            .kdjv_render(&file, &options, &cancel, &|progress, detail| {
                let step = (progress * 100.) as u32;
                let mut seen = last.lock().unwrap();
                if step == seen.0 && (detail.is_empty() || detail == seen.1) {
                    return;
                }
                seen.0 = step;
                if !detail.is_empty() {
                    seen.1 = detail.to_string();
                }
                publish(progress, &seen.1, None);
                let _ = tell.send((step, seen.1.clone()));
            })
            .await;
        match &rendered {
            Ok(_) => publish(1., "", None),
            Err(error) => publish(0., "", Some(&format!("{error:#}"))),
        }
        rendered
    });
    (job, watch)
}
/// Renders a project for playing, or finds its render. A caller that asks for `stream` gets
/// the progress as NDJSON lines.
async fn kdjv_render(
    Extension(m): Extension<Arc<Workshop>>,
    Json(target): Json<KdjvTarget>,
) -> ApiResult<Response> {
    let (file, track_id) = kdjv_file(&m, &target)?;
    let (job, watch) = spawn_render(&m, file, track_id, kdjv::RenderOptions::default());
    if !target.stream {
        let result = job.await.map_err(|error| anyhow::anyhow!("渲染中断：{error}"))??;
        return Ok(Json(serde_json::json!({"path": result, "track_id": track_id})).into_response());
    }
    let line = |value: serde_json::Value| Ok::<_, std::convert::Infallible>(Bytes::from(format!("{value}\n")));
    let stream = futures_util::stream::unfold(Some((job, watch)), move |held| async move {
        let (mut job, mut watch) = held?;
        tokio::select! {
            finished = &mut job => {
                let end = match finished {
                    Ok(Ok(path)) => serde_json::json!({"event": "result", "path": path, "track_id": track_id}),
                    Ok(Err(error)) => serde_json::json!({"event": "error", "message": format!("{error:#}")}),
                    Err(error) => serde_json::json!({"event": "error", "message": format!("渲染中断：{error}")}),
                };
                Some((line(end), None))
            }
            _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {
                let (done, detail) = watch.borrow_and_update().clone();
                Some((line(serde_json::json!({"event": "progress", "done": done, "total": 100, "detail": detail})), Some((job, watch))))
            }
        }
    });
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream))
        .map_err(|error| anyhow::anyhow!(error.to_string()))?)
}
/// An export: the project and, optionally, how it differs from the render made for playing.
#[derive(Deserialize)]
struct KdjvExport {
    #[serde(flatten)]
    target: KdjvTarget,
    #[serde(default)]
    options: kdjv::RenderOptions,
}

/// The project written out as one file beside it (the library's 导出, the editor's 导出): rendered
/// as for playing, or with the options given (size, frame rate, quality, a stretch, the sound
/// alone), then copied to `<project>.mp4` (`.wav`), or `<project> 2.mp4`… — an existing file is
/// never replaced.
async fn kdjv_export(
    Extension(m): Extension<Arc<Workshop>>,
    Json(export): Json<KdjvExport>,
) -> ApiResult<Json<serde_json::Value>> {
    let (file, track_id) = kdjv_file(&m, &export.target)?;
    let extension = if export.options.audio_only { "wav" } else { "mp4" };
    let (job, _) = spawn_render(&m, file.clone(), track_id, export.options);
    let render = job.await.map_err(|error| anyhow::anyhow!("渲染中断：{error}"))??;
    let exported = tokio::task::spawn_blocking(move || -> Result<std::path::PathBuf> {
        let folder = file.parent().context("工程没有所在的文件夹")?;
        let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "工程".into());
        for n in 1..1000 {
            let name = if n == 1 { format!("{stem}.{extension}") } else { format!("{stem} {n}.{extension}") };
            let path = folder.join(name);
            // create_new: two exports at once never take the same name.
            let Ok(mut out) = std::fs::OpenOptions::new().write(true).create_new(true).open(&path) else { continue };
            let copied = std::fs::File::open(&render).and_then(|mut from| std::io::copy(&mut from, &mut out));
            if let Err(error) = copied {
                drop(out);
                let _ = std::fs::remove_file(&path);
                bail!("写入 {} 失败：{error}", path.display());
            }
            return Ok(path);
        }
        bail!("{} 旁边已经有太多同名的导出", file.display())
    })
    .await
    .map_err(|error| anyhow::anyhow!("导出中断：{error}"))??;
    Ok(Json(serde_json::json!({"path": exported, "track_id": track_id})))
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

