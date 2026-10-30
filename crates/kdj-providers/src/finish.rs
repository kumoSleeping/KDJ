//! 下载收尾：音画合并、抽音轨、Offset 掐头补静音。
//!
//! 先用纯 Rust 的 kdj-media（MP4 原样封装；Offset 时音轨解码后按采样裁剪/补静音，
//! 用系统 AAC 编码器重编，画面原样复制、用编辑列表对齐到同一时刻）。它做不到的
//! ——转码、MKV、FLV 单流、非 AAC 音轨改 Offset、没有系统 AAC 编码器——
//! 再交给 FFmpeg；那台设备上也没有 FFmpeg 时，报 kdj-media 的原因。

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use tokio_util::sync::CancellationToken;

use crate::ffmpeg;

fn is_mp4(path: &Path) -> bool {
    kdj_media::mp4::read::looks_like_mp4(path)
}

async fn native(output: &Path, offset_ms: i64, cancel: &CancellationToken, run: impl FnOnce(&kdj_media::remux::Job) -> Result<()> + Send + 'static) -> Result<()> {
    let (output, scratch, cancel) = (output.to_path_buf(), output.parent().map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir), cancel.clone());
    tokio::task::spawn_blocking(move || {
        let cancelled = || cancel.is_cancelled();
        let job = kdj_media::remux::Job { output: &output, scratch: &scratch, offset_ms, cancelled: &cancelled };
        run(&job)
    })
    .await
    .context("封装线程异常退出")?
}

fn canceled(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        bail!("下载已取消");
    }
    Ok(())
}

/// 视频（`inputs[0]`）和可选的音频（`inputs[1]`，没有时取视频文件自带的音轨）封装成一个文件。
/// `video_only` 时不要音轨。`transcode` 和 MKV 只有 FFmpeg 能做。
pub async fn mux(inputs: &[PathBuf], output: &Path, video_only: bool, transcode: bool, max_height: i64, offset_ms: i64, log_path: &Path, cancel: &CancellationToken) -> Result<()> {
    let mkv = output.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("mkv"));
    let mut reason = None;
    if !transcode && !mkv && inputs.iter().all(|path| is_mp4(path)) {
        let video = inputs[0].clone();
        let audio = (!video_only).then(|| inputs.get(1).unwrap_or(&inputs[0]).clone());
        match native(output, offset_ms, cancel, move |job| kdj_media::remux::mux(Some(&video), audio.as_deref(), job)).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                canceled(cancel)?;
                tracing::warn!(error = %format!("{error:#}"), "纯 Rust 封装失败，尝试 FFmpeg");
                reason = Some(error);
            }
        }
    }
    if !ffmpeg::available() {
        return Err(reason.unwrap_or_else(|| anyhow::anyhow!(if transcode { "转码需要 FFmpeg，这台设备上没有" } else if mkv { "封装成 MKV 需要 FFmpeg，这台设备上没有" } else { "这个视频流的格式需要 FFmpeg 处理，这台设备上没有" })));
    }
    let args = if video_only {
        ffmpeg::mux_video_only_args(inputs, output, transcode, max_height, offset_ms)
    } else {
        ffmpeg::mux_args(inputs, output, transcode, max_height, offset_ms)
    };
    ffmpeg::run(&args, log_path, cancel).await
}

/// 只要音轨，装进 M4A。源音轨不是 AAC（FLV 里常见 MP3）时由 FFmpeg 重编码。
pub async fn extract_audio(source: &Path, output: &Path, offset_ms: i64, log_path: &Path, cancel: &CancellationToken) -> Result<()> {
    let mut reason = None;
    if is_mp4(source) {
        let source = source.to_path_buf();
        match native(output, offset_ms, cancel, move |job| kdj_media::remux::extract_audio(&source, job)).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                canceled(cancel)?;
                tracing::warn!(error = %format!("{error:#}"), "纯 Rust 抽音轨失败，尝试 FFmpeg");
                reason = Some(error);
            }
        }
    }
    if !ffmpeg::available() {
        return Err(reason.unwrap_or_else(|| anyhow::anyhow!("这个音频流的格式需要 FFmpeg 处理，这台设备上没有")));
    }
    // 带偏移必然重编码（见 extract_audio_args），copy 那一趟纯属白跑
    if offset_ms == 0 {
        match ffmpeg::run(&ffmpeg::extract_audio_args(source, output, true, 0), log_path, cancel).await {
            Ok(()) => return Ok(()),
            Err(err) if err.to_string().contains("取消") => return Err(err),
            // 源音轨不是 AAC 时 m4a 容器装不下，退回重编码
            Err(_) => {
                let _ = std::fs::remove_file(output);
            }
        }
    }
    ffmpeg::run(&ffmpeg::extract_audio_args(source, output, false, offset_ms), log_path, cancel).await
}

/// 下载能不能带 Offset：要么有系统 AAC 编码器（音轨重编），要么有 FFmpeg。
pub fn offset_available() -> bool {
    kdj_media::remux::offset_supported() || ffmpeg::available()
}
