//! A project written out beside itself (the export queue's 剪辑 tasks, the library's 导出 MP4): the
//! sound alone as WAV, or an MP4 whose picture the window draws from the sources with the live
//! preview's own arithmetic and encodes (the visualizer's transport and muxing, studio.rs
//! `start_project`) over the project's mix. Nothing here runs FFmpeg.
use super::routes::{kdjv_file, KdjvTarget};
use super::*;
use crate::compositions::audio_visualizer::studio;
use crate::error::{ApiError, ApiResult};
use axum::{Extension, Json};
use std::time::{Duration, SystemTime};

/// Where an export stages its mix, in the cache; what an earlier run left is removed at start.
pub const STAGE_PREFIX: &str = ".kdjv-export-";
/// How often an export looks whether its project has been written since it started.
const EXPORT_WATCH: Duration = Duration::from_millis(300);
/// The largest picture the window's H.264 encoder is asked for; a larger canvas is scaled down.
const MAX_WIDTH: u32 = 3840;
const MAX_HEIGHT: u32 = 2160;

#[derive(Deserialize)]
pub(super) struct KdjvExport {
    #[serde(flatten)]
    target: KdjvTarget,
    #[serde(default)]
    options: kdjv::RenderOptions,
    /// Frames in each GOP the window uploads; one second's when not given.
    #[serde(default)]
    chunk_frames: Option<u32>,
    /// What the window's encoder is held to; the canvas decides when not given.
    #[serde(default)]
    video_bitrate: Option<u64>,
    /// The queue's own name for the task (older windows); the job's id is what stops it now.
    #[serde(default)]
    #[allow(dead_code)]
    id: Option<String>,
}

/// A project file as it is on disk: its length and when it was written; None once it is gone.
fn written(file: &Path) -> Option<(u64, SystemTime)> {
    let meta = std::fs::metadata(file).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// `<stem>.<extension>` beside the project, or `<stem> 2.<extension>`…: never an existing file.
fn free_name(file: &Path, extension: &str) -> Result<PathBuf> {
    let folder = file.parent().context("工程没有所在的文件夹")?;
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "工程".into());
    (1..1000)
        .map(|n| folder.join(if n == 1 { format!("{stem}.{extension}") } else { format!("{stem} {n}.{extension}") }))
        .find(|path| std::fs::symlink_metadata(path).is_err())
        .with_context(|| format!("{} 旁边已经有太多同名的导出", file.display()))
}

/// The canvas an export encodes: the project's, scaled down into what the encoder takes, even.
fn export_size(width: u32, height: u32) -> (u32, u32) {
    let scale = (MAX_WIDTH as f64 / width as f64).min(MAX_HEIGHT as f64 / height as f64).min(1.);
    let even = |v: f64| ((v.round() as u32) / 2 * 2).max(16);
    (even(width as f64 * scale), even(height as f64 * scale))
}

/// Starts an export. The sound is mixed first (`kdjv.progress` meanwhile); the sound alone is
/// written and answered at once. For an MP4 the answer is the job the window now feeds
/// (`/api/visualizer/jobs/{id}`), the frames it draws (`export`: frame `f` is project second
/// `from + f / fps`) and the project as drawn (`live`). A write of the project that changes what
/// is exported stops the job (`kdjv_project_changed`); a title, a rename or the same document
/// saved again leaves it running.
pub(super) async fn kdjv_export(
    Extension(m): Extension<Arc<Workshop>>,
    Json(export): Json<KdjvExport>,
) -> ApiResult<Json<serde_json::Value>> {
    let (file, track_id) = kdjv_file(&m, &export.target)?;
    let cancel = CancellationToken::new();
    let before = written(&file);
    let key = m.kdjv_export_key(&file, &export.options, &cancel).await?;
    let (p, lo, hi) = m.kdjv_export_project(&file, &export.options, &cancel).await?;
    std::fs::create_dir_all(&m.cache).map_err(anyhow::Error::from)?;
    let stage = m.cache.join(format!("{STAGE_PREFIX}{}", id()));
    std::fs::create_dir(&stage).map_err(anyhow::Error::from)?;
    let scratch = render::Scratch(stage.clone());
    let shown = file.to_string_lossy().into_owned();
    let state = m.state.clone();
    let publish = |progress: f64, detail: &str, error: Option<&str>| {
        state.hub.publish(
            "kdjv.progress",
            &serde_json::json!({"path": shown, "track_id": track_id, "progress": progress, "detail": detail, "error": error}),
        );
    };
    let sound = m.kdjv_export_sound(&p, &stage, lo, hi, &cancel, &|v| publish(v, "混合声音", None)).await;
    let sound = match sound {
        Ok(sound) => sound,
        Err(error) => {
            publish(0., "", Some(&format!("{error:#}")));
            return Err(error.into());
        }
    };
    publish(1., "", None);
    let unchanged = || async { written(&file) == before || m.kdjv_export_key(&file, &export.options, &CancellationToken::new()).await.is_ok_and(|now| now == key) };
    let project_changed = || ApiError::new(axum::http::StatusCode::CONFLICT, "工程在导出时被改动，导出已停止").coded("kdjv_project_changed").expected();
    if export.options.audio_only {
        let output = free_name(&file, "wav")?;
        let (from, to) = (sound.clone(), output.clone());
        tokio::task::spawn_blocking(move || -> Result<()> {
            // create_new: two exports at once never take the same name; on disk before announced.
            let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&to)?;
            let copied = std::fs::File::open(&from).and_then(|mut f| std::io::copy(&mut f, &mut out)).and_then(|_| out.sync_all());
            if let Err(error) = copied {
                drop(out);
                let _ = std::fs::remove_file(&to);
                bail!("写入 {} 失败：{error}", to.display());
            }
            Ok(())
        })
        .await
        .map_err(|error| anyhow::anyhow!("导出中断：{error}"))??;
        if !unchanged().await {
            let _ = std::fs::remove_file(&output);
            return Err(project_changed());
        }
        return Ok(Json(serde_json::json!({"path": output, "track_id": track_id})));
    }
    if !unchanged().await {
        return Err(project_changed());
    }
    let output = free_name(&file, "mp4")?;
    let (width, height) = export_size(p.canvas.width, p.canvas.height);
    let fps = (p.canvas.fps.round() as u32).clamp(1, 120);
    let chunk_frames = export.chunk_frames.unwrap_or(fps);
    let duration = (hi - lo) / 1000.;
    let job = studio::start_project(
        studio::ProjectExport { duration, width, height, fps, chunk_frames, video_bitrate: export.video_bitrate.unwrap_or(0), sound, output: output.clone() },
        Box::new(scratch),
    )?;
    let job_id = job["id"].as_str().unwrap_or_default().to_string();
    tokio::spawn({
        let (m, file, options, key) = (m.clone(), file.clone(), export.options.clone(), key.clone());
        async move {
            let mut seen = before;
            while !studio::job_ended(&job_id) {
                tokio::time::sleep(EXPORT_WATCH).await;
                let now = written(&file);
                if now == seen {
                    continue;
                }
                let same = now.is_some() && m.kdjv_export_key(&file, &options, &CancellationToken::new()).await.is_ok_and(|now| now == key);
                if !same {
                    studio::stop_project(&job_id, "kdjv_project_changed", "工程在导出时被改动，导出已停止");
                    return;
                }
                seen = now;
            }
        }
    });
    Ok(Json(serde_json::json!({
        "job": job,
        "export": {
            "width": width, "height": height, "fps": fps, "from": lo / 1000., "to": hi / 1000.,
            "frames": (duration * fps as f64).ceil() as u64, "chunk_frames": chunk_frames,
        },
        "live": kdjv::live(&p),
        "output": output,
        "track_id": track_id,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_canvas_the_encoder_cannot_take_is_scaled_into_it_and_kept_even() {
        assert_eq!(export_size(1920, 1080), (1920, 1080));
        assert_eq!(export_size(853, 480), (852, 480));
        assert_eq!(export_size(4096, 2160), (3840, 2024));
        assert_eq!(export_size(7680, 4320), (3840, 2160));
        assert_eq!(export_size(1080, 3840), (608, 2160));
    }

    #[test]
    fn an_export_never_takes_an_existing_name() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("VJ.kdjv");
        std::fs::write(&file, "{}").unwrap();
        assert_eq!(free_name(&file, "mp4").unwrap(), dir.path().join("VJ.mp4"));
        std::fs::write(dir.path().join("VJ.mp4"), b"x").unwrap();
        assert_eq!(free_name(&file, "mp4").unwrap(), dir.path().join("VJ 2.mp4"));
    }
}
