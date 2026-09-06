use super::*;
use crate::{
    error::{ApiError, ApiResult},
    state::AppState,
};
use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
pub fn router(manager: Arc<Workshop>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/workshop", get(list).post(create))
        .route("/api/workshop/intake", post(intake))
        .route(
            "/api/workshop/{id}",
            axum::routing::patch(patch).delete(delete),
        )
        .route("/api/workshop/{id}/sources", post(add))
        .route("/api/workshop/{id}/positions", post(positions))
        .route("/api/workshop/{id}/positions/apply", post(apply_positions))
        .route("/api/workshop/{id}/positions/control", post(control_positions))
        .route("/api/workshop/{id}/align", post(align))
        .route(
            "/api/workshop/{id}/sources/{source}/frame",
            get(source_frame),
        )
        .route("/api/workshop/{id}/preview", post(preview))
        .route("/api/workshop/{id}/export", post(export))
        .route("/api/workshop/jobs/{id}/cancel", post(cancel))
        .route("/api/workshop/jobs/{id}/import", post(retry_import))
        .route("/api/workshop/media/{ticket}/audio.wav", get(audio))
        .route(
            "/api/workshop/media/{ticket}/video/{clip}/{part}",
            get(video),
        )
        .route(
            "/api/workshop/preview/{ticket}",
            axum::routing::delete(release),
        )
        .layer(Extension(manager))
}
async fn list(Extension(m): Extension<Arc<Workshop>>) -> Json<Snapshot> {
    Json(m.snapshot())
}
async fn create(Extension(m): Extension<Arc<Workshop>>) -> ApiResult<Json<Snapshot>> {
    Ok(Json(m.create()?))
}
#[derive(Deserialize)]
struct Revision {
    revision: u64,
}
#[derive(Deserialize)]
struct Patch {
    revision: u64,
    #[serde(flatten)]
    edit: Edit,
}
async fn patch(
    Extension(m): Extension<Arc<Workshop>>,
    Path(id): Path<String>,
    Json(p): Json<Patch>,
) -> ApiResult<Json<Snapshot>> {
    Ok(Json(m.patch(&id, p.revision, p.edit)?))
}
async fn delete(
    Extension(m): Extension<Arc<Workshop>>,
    Path(id): Path<String>,
    Json(p): Json<Revision>,
) -> ApiResult<Json<Snapshot>> {
    Ok(Json(m.delete(&id, p.revision)?))
}
#[derive(Deserialize)]
struct Add {
    revision: u64,
    track_ids: Vec<i64>,
    at_ms: f64,
}
async fn add(
    Extension(m): Extension<Arc<Workshop>>,
    Path(id): Path<String>,
    Json(p): Json<Add>,
) -> ApiResult<Json<Snapshot>> {
    Ok(Json(m.add(&id, p.revision, &p.track_ids, p.at_ms).await?))
}
#[derive(Deserialize)]
struct Align {
    revision: u64,
    clip_id: String,
    reference_id: String,
}
async fn align(
    Extension(m): Extension<Arc<Workshop>>,
    Path(id): Path<String>,
    Json(p): Json<Align>,
) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(
        serde_json::json!({"start_ms":m.align(&id,p.revision,&p.clip_id,&p.reference_id).await?,"revision":p.revision}),
    ))
}
#[derive(Deserialize)]
struct PreviewRequest {
    revision: u64,
    audition_after_layer: Option<String>,
}
async fn preview(
    Extension(m): Extension<Arc<Workshop>>,
    Path(id): Path<String>,
    Json(p): Json<PreviewRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let ticket = m.preview(&id, p.revision, p.audition_after_layer.as_deref())?;
    Ok(Json(
        serde_json::json!({"ticket":ticket,"revision":p.revision}),
    ))
}
async fn export(
    Extension(m): Extension<Arc<Workshop>>,
    Path(id): Path<String>,
    Json(p): Json<Revision>,
) -> ApiResult<Json<Snapshot>> {
    Ok(Json(m.export(&id, p.revision)?))
}
async fn cancel(
    Extension(m): Extension<Arc<Workshop>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Snapshot>> {
    Ok(Json(m.cancel(&id).await?))
}
async fn retry_import(
    Extension(m): Extension<Arc<Workshop>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Snapshot>> {
    Ok(Json(m.retry_import(&id).await?))
}
async fn release(
    Extension(m): Extension<Arc<Workshop>>,
    Path(ticket): Path<String>,
) -> Json<serde_json::Value> {
    m.release(&ticket);
    Json(serde_json::json!({}))
}
async fn video(
    Extension(m): Extension<Arc<Workshop>>,
    Path((ticket, clip, part)): Path<(String, String, u64)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let mut preview = m.ticket(&ticket)?;
    // Dropping a disconnected request must also cancel its queued/transcoding
    // work, without revoking the editor's other media requests.
    preview.cancel = preview.cancel.child_token();
    let _request = preview.cancel.clone().drop_guard();
    let path = m.proxy(&preview, &clip, part).await?;
    let total = std::fs::metadata(&path).map_err(anyhow::Error::from)?.len();
    crate::routes::audio_response(
        &path,
        total,
        "video/mp4".into(),
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
    )
    .await
}
async fn audio(
    Extension(m): Extension<Arc<Workshop>>,
    Path(ticket): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let preview = m.ticket(&ticket)?;
    let total = render::wav_length(&preview.project);
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let (status, start, end) = if let Some(range) = range {
        let Some((start, end)) = crate::routes::parse_range(range, total) else {
            return Ok((
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{total}"))],
            )
                .into_response());
        };
        (StatusCode::PARTIAL_CONTENT, start, end)
    } else {
        (StatusCode::OK, 0, total - 1)
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "audio/wav")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_LENGTH, (end - start + 1).to_string());
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }
    if method == Method::HEAD {
        return builder
            .body(axum::body::Body::empty())
            .map_err(|e| ApiError::bad_request(e.to_string()));
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(2);
    tokio::spawn(async move {
        let cancel = preview.cancel.child_token();
        let work = async {
            let mut cursor = start;
            if cursor < 44 {
                let header = render::header(&preview.project);
                let hi = (end + 1).min(44);
                tx.send(Ok(header[cursor as usize..hi as usize].to_vec()))
                    .await
                    .map_err(|_| anyhow::anyhow!("预览已关闭"))?;
                cursor = hi;
            }
            while cursor <= end {
                let byte = cursor - 44;
                let chunk_bytes = render::frames(render::CHUNK_MS) * 4;
                let n = byte / chunk_bytes;
                let bytes = m.audio_chunk(&preview.project, n, &cancel).await?;
                let begin = (byte % chunk_bytes) as usize;
                let length = (end - cursor + 1).min(bytes.len() as u64 - begin as u64) as usize;
                if length == 0 {
                    bail!("预览区间为空")
                };
                tx.send(Ok(bytes[begin..begin + length].to_vec()))
                    .await
                    .map_err(|_| anyhow::anyhow!("预览已关闭"))?;
                cursor += length as u64;
            }
            Ok::<_, anyhow::Error>(())
        };
        let result = tokio::select! {_=tx.closed()=>Ok(()),result=work=>result};
        cancel.cancel();
        if let Err(e) = result {
            let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
        }
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async {
        rx.recv().await.map(|item| (item, rx))
    });
    builder
        .body(axum::body::Body::from_stream(stream))
        .map_err(|e| ApiError::bad_request(e.to_string()))
}

#[derive(Deserialize)]
struct FrameQuery {
    ms: f64,
    width: u32,
}
async fn source_frame(
    Extension(m): Extension<Arc<Workshop>>,
    Path((pid, sid)): Path<(String, String)>,
    Query(q): Query<FrameQuery>,
) -> ApiResult<Response> {
    let bytes = m.source_frame(&pid, &sid, q.ms, q.width).await?;
    Ok((
        [
            (header::CONTENT_TYPE, if bytes.starts_with(b"\x89PNG") { "image/png" } else { "image/jpeg" }),
            (header::CACHE_CONTROL, "private, max-age=0, must-revalidate"),
        ],
        bytes,
    )
        .into_response())
}

async fn positions(
    Extension(m): Extension<Arc<Workshop>>,
    Path(pid): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    m.prepare_positions(&pid)?;
    position_results(&m, &pid)
}
fn position_results(m: &Workshop, pid: &str) -> ApiResult<Json<serde_json::Value>> {
    let items = m.position_views(pid);
    let revision = m
        .journal
        .lock()
        .unwrap()
        .projects
        .iter()
        .find(|p| p.id == pid)
        .context("作品不存在")?
        .revision;
    Ok(Json(
        serde_json::json!({"session":m.session,"project_id":pid,"revision":revision,"items":items}),
    ))
}
#[derive(Deserialize)]
struct PositionControl {
    layer_id: Option<String>,
    stopped: bool,
}
async fn control_positions(
    Extension(m): Extension<Arc<Workshop>>,
    Path(pid): Path<String>,
    Json(q): Json<PositionControl>,
) -> ApiResult<Json<serde_json::Value>> {
    m.control_positions(&pid, q.layer_id.as_deref(), q.stopped)?;
    position_results(&m, &pid)
}
#[derive(Deserialize)]
struct ApplyPosition {
    revision: u64,
    layer_id: String,
    analysis_id: String,
    preset_id: String,
}
async fn apply_positions(
    Extension(m): Extension<Arc<Workshop>>,
    Path(pid): Path<String>,
    Json(q): Json<ApplyPosition>,
) -> ApiResult<Json<Snapshot>> {
    Ok(Json(m.apply_positions(
        &pid,
        q.revision,
        &q.layer_id,
        &q.analysis_id,
        &q.preset_id,
    )?))
}

async fn intake(Extension(m): Extension<Arc<Workshop>>, Json(input): Json<super::intake::Intake>) -> ApiResult<Json<super::intake::IntakeResult>> {
    Ok(Json(m.intake(input).await?))
}
