//! `/api/kdjv/*`: checking and rendering `.kdjv` projects for playing, and exporting them as MP4.
use super::*;
use crate::{error::ApiResult, state::AppState};
use axum::{
    body::{Body, Bytes},
    http::header,
    response::{IntoResponse, Response},
    Extension, Json, Router, routing::post,
};
use serde::Deserialize;
pub fn router(manager: Arc<Workshop>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/kdjv/check", post(kdjv_check))
        .route("/api/kdjv/render", post(kdjv_render))
        .route("/api/kdjv/export", post(kdjv_export))
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
async fn kdjv_check(
    Extension(m): Extension<Arc<Workshop>>,
    Json(target): Json<KdjvTarget>,
) -> ApiResult<Json<kdjv::Checked>> {
    let (file, _) = kdjv_file(&m, &target)?;
    Ok(Json(m.kdjv_check(&file).await?))
}
/// Starts a project's render, or the wait for one under way (kdjv.rs keeps one per project).
/// It runs on its own: a caller that goes away leaves it to finish. `kdjv.progress` tells the
/// window how far it is, and so does the returned watch: percent and what is being done.
fn spawn_render(
    m: &Arc<Workshop>,
    file: std::path::PathBuf,
    track_id: Option<i64>,
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
            .kdjv_render(&file, &cancel, &|progress, detail| {
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
    let (job, watch) = spawn_render(&m, file, track_id);
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
/// The project written out as one MP4 beside it (the library's 导出): rendered as for playing,
/// then copied to `<project>.mp4`, or `<project> 2.mp4`… — an existing file is never replaced.
async fn kdjv_export(
    Extension(m): Extension<Arc<Workshop>>,
    Json(target): Json<KdjvTarget>,
) -> ApiResult<Json<serde_json::Value>> {
    let (file, track_id) = kdjv_file(&m, &target)?;
    let (job, _) = spawn_render(&m, file.clone(), track_id);
    let render = job.await.map_err(|error| anyhow::anyhow!("渲染中断：{error}"))??;
    let exported = tokio::task::spawn_blocking(move || -> Result<std::path::PathBuf> {
        let folder = file.parent().context("工程没有所在的文件夹")?;
        let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "工程".into());
        for n in 1..1000 {
            let name = if n == 1 { format!("{stem}.mp4") } else { format!("{stem} {n}.mp4") };
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
        bail!("{} 旁边已经有太多同名的 MP4", file.display())
    })
    .await
    .map_err(|error| anyhow::anyhow!("导出中断：{error}"))??;
    Ok(Json(serde_json::json!({"path": exported, "track_id": track_id})))
}
