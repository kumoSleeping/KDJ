//! Desktop audio-visualizer phase 1: real, cancellable, no-clobber MP4 export.
//! This is deliberately independent of global playback and the workshop editor.
mod graph;
mod raster;
pub mod studio;
#[cfg(test)]
mod tests;

use super::{acceleration, frame_pipe::FrameSource, media};
use anyhow::{Context, Result, bail, ensure};
use kdj_core::{
    audio_visualizer::Scene,
    composition::EncodingAcceleration,
    work_scheduler::{WorkClass, WorkRequest, work_scheduler},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportRequest {
    pub scene: Scene,
    /// A complete local audio file, not a preview URL or embedded-player handle.
    pub audio_path: String,
    /// Exact new .mp4 path. Existing files are never replaced.
    pub output_path: String,
    #[serde(default)]
    pub acceleration: EncodingAcceleration,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportReport {
    pub output_path: String,
    pub duration_ms: i64,
    pub frames: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub encoder: String,
    pub stripe_width: u32,
    pub stripe_height: u32,
    pub frame_bytes: usize,
    pub pipe_bytes_per_attempt: u64,
    pub rgba_bytes_per_second: u64,
    pub analysis_ms: u128,
    pub render_ms: u128,
    pub output_bytes: u64,
}

struct Stage(PathBuf);
impl Stage {
    fn new(directory: &Path) -> Result<Self> {
        let path = directory.join(format!(
            ".kdj-composition-visualizer-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir(&path).context("无法建立可视化临时目录")?;
        Ok(Self(path))
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        // Exact owned paths only; never recursively erase an unexpected file.
        for name in ["render.mp4", "arc.pgm", "disc.pgm"] {
            let _ = std::fs::remove_file(self.0.join(name));
        }
        let _ = std::fs::remove_dir(&self.0);
    }
}
fn check(cancel: &CancellationToken) -> Result<()> {
    ensure!(!cancel.is_cancelled(), "可视化导出已取消");
    Ok(())
}
fn source(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    ensure!(
        path.is_absolute() && path.is_file(),
        "素材必须是可读取的完整本地文件：{}",
        path.display()
    );
    path.canonicalize().context("无法解析素材路径")
}
fn destination(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    ensure!(
        path.is_absolute()
            && path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("mp4")),
        "输出必须是本地 MP4 的绝对路径"
    );
    let parent = path.parent().context("输出目录无效")?;
    ensure!(parent.is_dir(), "输出目录不存在");
    let output = parent
        .canonicalize()?
        .join(path.file_name().context("输出文件名无效")?);
    match std::fs::symlink_metadata(&output) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
        Ok(_) => bail!("输出文件已存在，未覆盖"),
    }
    Ok(output)
}

async fn capabilities(scene: &Scene, cancel: &CancellationToken) -> Result<()> {
    let binary = kdj_providers::ffmpeg::binary()?;
    let args = ["-hide_banner", "-filters"].map(str::to_string);
    let output =
        media::capture(&binary, &args, 512 * 1024, Duration::from_secs(10), cancel).await?;
    let text = String::from_utf8_lossy(&output);
    let available: std::collections::HashSet<_> = text
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .collect();
    let missing: Vec<_> = graph::required_filters(scene)
        .into_iter()
        .filter(|filter| !available.contains(filter))
        .collect();
    ensure!(
        missing.is_empty(),
        "FFmpeg 缺少必要滤镜：{}；请检查媒体工具设置",
        missing.join("、")
    );
    let args = ["-hide_banner", "-encoders"].map(str::to_string);
    let output =
        media::capture(&binary, &args, 512 * 1024, Duration::from_secs(10), cancel).await?;
    let text = String::from_utf8_lossy(&output);
    let available: std::collections::HashSet<_> = text
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .collect();
    ensure!(
        available.contains("libx264") && available.contains("aac"),
        "FFmpeg 需要 libx264 和 AAC 编码器以保证软件回退；请检查媒体工具设置"
    );
    Ok(())
}

/// The caller can cancel throughout preparation, rendering and validation. The
/// final no-clobber rename is the commit point; cancellation after it cannot
/// turn a published result into a failed/retriable export.
pub async fn export(
    request: &ExportRequest,
    cancel: &CancellationToken,
    progress: impl Fn(f64) + Send + Sync,
    status: impl Fn(&str) + Send + Sync,
) -> Result<ExportReport> {
    ensure!(
        cfg!(any(target_os = "macos", target_os = "windows")),
        "本轮可视化导出仅支持 Windows 和 macOS"
    );
    request.scene.validate().map_err(anyhow::Error::msg)?;
    let cancel = cancel.child_token();
    let _lifetime = cancel.clone().drop_guard();
    check(&cancel)?;
    let output = destination(&request.output_path)?;
    let audio = source(&request.audio_path)?;
    let mut scene = request.scene.clone();
    let mut sources = vec![(audio.clone(), media::signature(&audio)?)];
    for name in &mut scene.images {
        let path = source(name)?;
        ensure!(path != output, "图片与输出文件不能相同");
        let signature = media::signature(&path)?;
        ensure!(
            signature.size <= 64 * 1024 * 1024,
            "图片超过 64 MiB 安全上限"
        );
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        ensure!(
            ["png", "jpg", "jpeg", "webp", "bmp"].contains(&extension.as_str()),
            "首阶段仅支持 PNG、JPEG、WebP、BMP 静态图片"
        );
        *name = path.to_string_lossy().into_owned();
        sources.push((path, signature));
    }
    ensure!(audio != output, "音频与输出文件不能相同");
    // Visualizer admission is serial, and shares the global composition budget.
    static SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    let slots = SLOTS.get_or_init(|| tokio::sync::Semaphore::new(1));
    let _slot = tokio::select! { biased; _ = cancel.cancelled() => bail!("可视化导出已取消"), slot = slots.acquire() => slot? };
    let work_cancel = cancel.clone();
    let _work = tokio::task::spawn_blocking(move || {
        work_scheduler()
            .acquire(WorkRequest::new(WorkClass::MediaComposition), || {
                work_cancel.is_cancelled()
            })
            .map_err(|_| anyhow::anyhow!("可视化导出已取消"))
    })
    .await??;
    check(&cancel)?;
    status("检查媒体工具与素材");
    capabilities(&scene, &cancel).await?;
    let audio_probe = media::probe(&audio, &cancel).await?;
    ensure!(
        audio_probe
            .streams
            .iter()
            .filter(|s| s.codec_type == "audio")
            .count()
            == 1,
        "首阶段需要只有一条音轨的完整音频文件"
    );
    let source_duration = audio_probe.check(false)?;
    for image in &scene.images {
        let probe = media::probe(Path::new(image), &cancel).await?;
        let stream = probe
            .streams
            .iter()
            .find(|s| s.codec_type == "video")
            .context("图片没有有效画面")?;
        ensure!(
            stream.width > 0
                && stream.height > 0
                && stream.width <= 32768
                && stream.height <= 32768
                && stream.width as u64 * stream.height as u64 <= 32_000_000,
            "图片尺寸超出安全上限"
        );
    }
    status("分析音频");
    progress(0.);
    let started = Instant::now();
    let analyze_audio = audio.clone();
    let settings = scene.spectrum.clone();
    let analyze_cancel = cancel.clone();
    let timeline = Arc::new(
        tokio::task::spawn_blocking(move || {
            kdj_analysis::visualizer::analyze(&analyze_audio, &settings, &|| {
                analyze_cancel.is_cancelled()
            })
        })
        .await??,
    );
    let analysis_ms = started.elapsed().as_millis();
    check(&cancel)?;
    let duration = timeline.duration_seconds();
    let duration_ms = (duration * 1000.).round().max(1.) as i64;
    ensure!(
        (duration_ms - source_duration).abs() <= 250,
        "解码时长与源音轨不一致：{duration_ms} / {source_duration} ms；未输出不完整音频"
    );
    progress(0.15);
    let stage = Stage::new(output.parent().unwrap())?;
    let mask_scene = scene.clone();
    let mask_stage = stage.0.clone();
    tokio::task::spawn_blocking(move || graph::write_masks(&mask_scene, &mask_stage)).await??;
    check(&cancel)?;
    let args = graph::build(&scene, &audio, &stage.0, duration);
    let frames = Arc::new(raster::SpectrumFrames {
        scene: scene.clone(),
        timeline,
    });
    let frame_count = frames.frame_count();
    let frame_bytes = frames.frame_bytes();
    let started = Instant::now();
    let encoder = Mutex::new(String::new());
    acceleration::render_frames(
        &args,
        duration_ms,
        &cancel,
        request.acceleration,
        |value| progress(0.15 + 0.80 * value),
        |message| {
            *encoder.lock().unwrap() = message.to_owned();
            status(message);
        },
        frames,
        (
            scene.canvas.width,
            scene.canvas.height,
            scene.canvas.fps as f64,
        ),
    )
    .await?;
    let render_ms = started.elapsed().as_millis();
    check(&cancel)?;
    status("校验成品");
    progress(0.96);
    let temporary = stage.0.join("render.mp4");
    let probe = media::probe(&temporary, &cancel).await?;
    let expected = media::Probe {
        streams: vec![media::Stream {
            codec_type: "video".into(),
            width: scene.canvas.width,
            height: scene.canvas.height,
            avg_frame_rate: format!("{}/1", scene.canvas.fps),
            ..Default::default()
        }],
        ..Default::default()
    };
    media::validate(&expected, &probe, duration_ms)?;
    let video = probe.video().context("成品没有视频")?;
    ensure!(
        video.codec_name == "h264" && video.pix_fmt == "yuv420p",
        "成品视频格式不符合 H.264/yuv420p 约定"
    );
    ensure!(
        probe.audio().is_some_and(|s| s.codec_name == "aac"),
        "成品缺少 AAC 音轨"
    );
    // FlushFileBuffers on Windows cannot flush a read-only handle.
    let file = std::fs::File::options().write(true).open(&temporary)
        .context("无法打开可视化成品进行落盘同步")?;
    file.sync_all().context("可视化成品落盘同步失败")?;
    let output_bytes = file.metadata()?.len();
    drop(file);
    ensure!(output_bytes > 0, "可视化成品为空");
    for (path, signature) in &sources {
        ensure!(
            media::signature(path)? == *signature,
            "导出期间源素材已变化，未提交成品：{}",
            path.display()
        );
    }
    check(&cancel)?;
    // Same-directory atomic publication. No -y, overwrite, or check-then-rename race.
    kdj_providers::net::rename_download_noclobber(&temporary, &output)
        .context("提交可视化成品失败，目标可能已存在")?;
    #[cfg(unix)]
    std::fs::File::open(output.parent().unwrap())?
        .sync_all()
        .context("成品已提交，但输出目录同步失败")?;
    let (_, _, stripe_width, stripe_height) = scene.spectrum_rect();
    progress(1.);
    status("完成");
    Ok(ExportReport {
        output_path: output.to_string_lossy().into_owned(),
        duration_ms,
        frames: frame_count,
        width: scene.canvas.width,
        height: scene.canvas.height,
        fps: scene.canvas.fps,
        encoder: encoder.into_inner().unwrap(),
        stripe_width,
        stripe_height,
        frame_bytes,
        pipe_bytes_per_attempt: frame_bytes as u64 * frame_count,
        rgba_bytes_per_second: frame_bytes as u64 * scene.canvas.fps as u64,
        analysis_ms,
        render_ms,
        output_bytes,
    })
}
