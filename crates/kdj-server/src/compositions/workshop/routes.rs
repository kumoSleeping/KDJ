//! `/api/kdjv/*`: checking and rendering `.kdjv` projects for playing.
use super::*;
use crate::{error::ApiResult, state::AppState};
use axum::{Extension, Json, Router, routing::post};
use serde::Deserialize;
pub fn router(manager: Arc<Workshop>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/kdjv/check", post(kdjv_check))
        .route("/api/kdjv/render", post(kdjv_render))
        .layer(Extension(manager))
}
/// A `.kdjv` project (kdjv.rs), by its library row or its path.
#[derive(Deserialize)]
struct KdjvTarget {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    track_id: Option<i64>,
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
/// Renders a project for playing, or finds its render. The render runs on its own: a caller
/// that goes away (the listener skipped the song, a CLI was interrupted) leaves it to finish,
/// so the next play is immediate. `kdjv.progress` tells the window how far it is.
async fn kdjv_render(
    Extension(m): Extension<Arc<Workshop>>,
    Json(target): Json<KdjvTarget>,
) -> ApiResult<Json<serde_json::Value>> {
    let (file, track_id) = kdjv_file(&m, &target)?;
    let worker = m.clone();
    let shown = file.to_string_lossy().into_owned();
    let result = tokio::spawn(async move {
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
            })
            .await;
        match &rendered {
            Ok(_) => publish(1., "", None),
            Err(error) => publish(0., "", Some(&format!("{error:#}"))),
        }
        rendered
    })
    .await
    .map_err(|error| anyhow::anyhow!("渲染中断：{error}"))??;
    Ok(Json(serde_json::json!({"path": result, "track_id": track_id})))
}
