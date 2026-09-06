use super::CompositionManager;
use crate::{error::ApiResult, state::AppState};
use axum::{
    Extension, Json, Router,
    extract::Path,
    routing::{get, post},
};
use kdj_core::composition::{CompositionOptions, CompositionSnapshot};
use serde::Deserialize;
use std::sync::Arc;

pub fn router(manager: Arc<CompositionManager>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/compositions", get(list).post(enqueue).delete(clear))
        .route("/api/compositions/defaults", post(defaults))
        .route("/api/compositions/order", post(reorder))
        .route("/api/compositions/stack-video", post(stack_video))
        .route("/api/compositions/start", post(start))
        .route("/api/compositions/cancel", post(cancel))
        .route(
            "/api/compositions/{id}",
            axum::routing::patch(patch).delete(remove),
        )
        .route("/api/compositions/{id}/analyze", post(reanalyze))
        .route(
            "/api/compositions/{id}/{lane}",
            axum::routing::delete(remove_lane),
        )
        .layer(Extension(manager))
}
async fn list(Extension(manager): Extension<Arc<CompositionManager>>) -> Json<CompositionSnapshot> {
    Json(manager.snapshot())
}
#[derive(Deserialize)]
struct Enqueue {
    track_ids: Vec<i64>,
}
async fn enqueue(
    Extension(manager): Extension<Arc<CompositionManager>>,
    Json(body): Json<Enqueue>,
) -> ApiResult<Json<CompositionSnapshot>> {
    Ok(Json(manager.enqueue(&body.track_ids)?))
}
async fn defaults(
    Extension(manager): Extension<Arc<CompositionManager>>,
    Json(body): Json<CompositionOptions>,
) -> ApiResult<Json<CompositionSnapshot>> {
    Ok(Json(manager.defaults(body)?))
}
#[derive(Deserialize)]
struct Order {
    lane: String,
    entry_ids: Vec<String>,
}
async fn reorder(
    Extension(manager): Extension<Arc<CompositionManager>>,
    Json(body): Json<Order>,
) -> ApiResult<Json<CompositionSnapshot>> {
    Ok(Json(manager.reorder(&body.lane, &body.entry_ids)?))
}
#[derive(Deserialize)]
struct Stack {
    source_entry_id: String,
    target_task_id: String,
}
async fn stack_video(
    Extension(manager): Extension<Arc<CompositionManager>>,
    Json(body): Json<Stack>,
) -> ApiResult<Json<CompositionSnapshot>> {
    Ok(Json(manager.stack_video(
        &body.source_entry_id,
        &body.target_task_id,
    )?))
}
#[derive(Deserialize)]
struct Ids {
    ids: Option<Vec<String>>,
}
async fn start(
    Extension(manager): Extension<Arc<CompositionManager>>,
    Json(body): Json<Ids>,
) -> ApiResult<Json<CompositionSnapshot>> {
    Ok(Json(manager.start(body.ids.as_deref())?))
}
async fn cancel(
    Extension(manager): Extension<Arc<CompositionManager>>,
    Json(body): Json<Ids>,
) -> ApiResult<Json<CompositionSnapshot>> {
    Ok(Json(manager.cancel(body.ids.as_deref())?))
}
#[derive(Deserialize)]
struct Patch {
    generation: u64,
    options: Option<CompositionOptions>,
    offset_ms: Option<i64>,
    force_confirmed: Option<bool>,
}
#[derive(Deserialize)]
struct Generation {
    generation: u64,
}
async fn reanalyze(
    Extension(manager): Extension<Arc<CompositionManager>>,
    Path(id): Path<String>,
    Json(body): Json<Generation>,
) -> ApiResult<Json<CompositionSnapshot>> {
    Ok(Json(manager.reanalyze(&id, body.generation)?))
}
async fn patch(
    Extension(manager): Extension<Arc<CompositionManager>>,
    Path(id): Path<String>,
    Json(body): Json<Patch>,
) -> ApiResult<Json<CompositionSnapshot>> {
    Ok(Json(manager.patch(
        &id,
        body.generation,
        body.options,
        body.offset_ms,
        body.force_confirmed,
    )?))
}
async fn remove(
    Extension(manager): Extension<Arc<CompositionManager>>,
    Path(id): Path<String>,
) -> ApiResult<Json<CompositionSnapshot>> {
    Ok(Json(manager.remove(Some(&id), None)?))
}
async fn remove_lane(
    Extension(manager): Extension<Arc<CompositionManager>>,
    Path((id, lane)): Path<(String, String)>,
) -> ApiResult<Json<CompositionSnapshot>> {
    Ok(Json(manager.remove(Some(&id), Some(&lane))?))
}
async fn clear(
    Extension(manager): Extension<Arc<CompositionManager>>,
) -> ApiResult<Json<CompositionSnapshot>> {
    Ok(Json(manager.remove(None, None)?))
}
