//! Native-authorized Set intake uses the running library owner and its update
//! bus, not a second Database/LibraryService with independent cache lifetimes.
use crate::{compositions::media, error::ApiError, state::AppState};
use anyhow::{bail, Context};
use axum::{extract::State, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::PathBuf, sync::Arc};

#[derive(Deserialize)]
struct Intake {
    paths: Vec<String>,
    track_ids: Vec<i64>,
}
#[derive(Serialize)]
struct Source {
    track: kdj_core::models::Track,
    video: bool,
    audio_offset: f64,
    duration: f64,
}
pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/live-vj/intake", post(intake))
}
async fn intake(
    State(state): State<Arc<AppState>>,
    Json(input): Json<Intake>,
) -> Result<Json<Vec<Source>>, ApiError> {
    if input.paths.len() + input.track_ids.len() > 500 {
        return Err(anyhow::anyhow!("一次最多导入 500 个素材").into());
    }
    let library = state.library.clone();
    let paths = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<PathBuf>> {
        let mut pending: Vec<_> = input.paths.into_iter().map(PathBuf::from).rev().collect();
        for id in input.track_ids {
            pending.push(PathBuf::from(library.get(id)?.context("素材不存在")?.path));
        }
        let mut paths = vec![];
        let mut seen = HashSet::new();
        let mut visited = 0;
        while let Some(path) = pending.pop() {
            visited += 1;
            if visited > 10000 || paths.len() >= 500 {
                bail!("目录或素材过多，请分批导入")
            }
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                let mut children = std::fs::read_dir(&path)?
                    .map(|e| e.map(|e| e.path()))
                    .collect::<std::io::Result<Vec<_>>>()?;
                children.sort();
                pending.extend(children.into_iter().rev());
            } else if metadata.is_file()
                && kdj_providers::tags::is_media_extension(
                    path.extension().and_then(|e| e.to_str()).unwrap_or(""),
                )
            {
                let path = path.canonicalize()?;
                if seen.insert(path.clone()) {
                    paths.push(path);
                }
            }
        }
        Ok(paths)
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))??;
    let mut result = vec![];
    for path in paths {
        let probe = media::probe(&path, &Default::default()).await?;
        probe.check(false)?; // Silent video cannot be identified from system audio.
        let video = probe.video().is_some();
        let duration = probe.check(video)? as f64 / 1000.;
        let audio_offset = if video {
            probe.audio_shift() as f64 / 1000.
        } else {
            0.
        };
        let library = state.library.clone();
        let track = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let id = library.upsert_file(&path, "local", "")?;
            library.get(id)?.context("素材入库失败")
        })
        .await
        .map_err(|e| anyhow::anyhow!(e))??;
        state.hub.publish_library_updated(&[track.id]);
        result.push(Source {
            track,
            video,
            audio_offset,
            duration,
        });
    }
    Ok(Json(result))
}
