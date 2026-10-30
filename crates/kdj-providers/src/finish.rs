//! 下载收尾：音画合并、抽音轨、Offset 掐头补静音，全部由纯 Rust 的 kdj-media 完成。
//!
//! MP4 / DASH 分片原样封装；哔哩哔哩只给 FLV 单流时先按原样转封装成 MP4（H.264 + AAC / MP3）。
//! Offset 时音轨解码后按采样裁剪/补静音，用系统 AAC 编码器重编，画面原样复制、用编辑列表
//! 对齐到同一时刻。成品一律是 MP4（只要音轨时 M4A；FLV 里的 MP3 不加 Offset 时原样存 MP3）。
//! 做不到的情况——没有系统 AAC 编码器时加 Offset、解不了的音轨（杜比 E-AC-3）转 AAC、
//! H.264 以外的 FLV 画面——直接报 kdj-media 的原因。

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use tokio_util::sync::CancellationToken;

fn is_mp4(path: &Path) -> bool {
    kdj_media::mp4::read::looks_like_mp4(path)
}

fn is_flv(path: &Path) -> bool {
    kdj_media::flv::looks_like_flv(path)
}

fn scratch_dir(output: &Path) -> PathBuf {
    output.parent().map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir)
}

async fn blocking(cancel: &CancellationToken, run: impl FnOnce(&dyn Fn() -> bool) -> Result<()> + Send + 'static) -> Result<()> {
    let cancel = cancel.clone();
    let result = tokio::task::spawn_blocking(move || {
        let cancelled = || cancel.is_cancelled();
        run(&cancelled)
    })
    .await
    .context("封装线程异常退出")?;
    result
}

async fn native(output: &Path, offset_ms: i64, cancel: &CancellationToken, run: impl FnOnce(&kdj_media::remux::Job) -> Result<()> + Send + 'static) -> Result<()> {
    let (output, scratch) = (output.to_path_buf(), scratch_dir(output));
    blocking(cancel, move |cancelled| {
        let job = kdj_media::remux::Job { output: &output, scratch: &scratch, offset_ms, cancelled };
        run(&job)
    })
    .await
}

fn canceled(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        bail!("下载已取消");
    }
    Ok(())
}

/// A scratch file beside `output`, removed when dropped.
struct Scratch(PathBuf);
impl Scratch {
    fn new(output: &Path, name: &str) -> Self {
        Scratch(scratch_dir(output).join(format!(".kdj-flv-{:08x}-{name}", rand::random::<u32>())))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// An FLV's chosen tracks as an MP4 / M4A file of their own.
async fn flv_to_mp4(source: &Path, output: &Path, video: bool, audio: bool, cancel: &CancellationToken) -> Result<()> {
    let (source, output) = (source.to_path_buf(), output.to_path_buf());
    blocking(cancel, move |cancelled| kdj_media::flv::to_mp4(&source, &output, video, audio, cancelled)).await
}

/// 视频（`inputs[0]`）和可选的音频（`inputs[1]`，没有时取视频文件自带的音轨）封装成 MP4。
/// `video_only` 时不要音轨。`inputs[0]` 可以是哔哩哔哩的 FLV 单流。
pub async fn mux(inputs: &[PathBuf], output: &Path, video_only: bool, offset_ms: i64, cancel: &CancellationToken) -> Result<()> {
    let first = inputs.first().context("没有要封装的文件")?;
    if is_flv(first) {
        if offset_ms == 0 {
            return flv_to_mp4(first, output, true, !video_only, cancel).await;
        }
        // Offset：画面和声音先各成一个文件，再按 DASH 那样掐头补静音。
        let video = Scratch::new(output, "video.mp4");
        flv_to_mp4(first, &video.0, true, false, cancel).await?;
        let audio = if video_only { None } else {
            let audio = Scratch::new(output, "audio.m4a");
            flv_to_mp4(first, &audio.0, false, true, cancel).await?;
            Some(audio)
        };
        let (video_path, audio_path) = (video.0.clone(), audio.as_ref().map(|a| a.0.clone()));
        let result = native(output, offset_ms, cancel, move |job| kdj_media::remux::mux(Some(&video_path), audio_path.as_deref(), job)).await;
        canceled(cancel)?;
        return result;
    }
    if let Some(other) = inputs.iter().find(|path| !is_mp4(path)) {
        bail!("不认识的媒体容器，只能处理 MP4 和 FLV：{}", other.display());
    }
    let video = first.clone();
    let audio = (!video_only).then(|| inputs.get(1).unwrap_or(first).clone());
    let result = native(output, offset_ms, cancel, move |job| kdj_media::remux::mux(Some(&video), audio.as_deref(), job)).await;
    canceled(cancel)?;
    result
}

/// 只要音轨，装进 M4A：AAC 原样复制，其余（FLAC、FLV 里的 MP3）用系统 AAC 编码器重编。
pub async fn extract_audio(source: &Path, output: &Path, offset_ms: i64, cancel: &CancellationToken) -> Result<()> {
    let scratch;
    let source = if is_flv(source) {
        scratch = Scratch::new(output, "audio.m4a");
        flv_to_mp4(source, &scratch.0, false, true, cancel).await?;
        scratch.0.clone()
    } else {
        anyhow::ensure!(is_mp4(source), "不认识的媒体容器，只能处理 MP4 和 FLV：{}", source.display());
        source.to_path_buf()
    };
    let result = native(output, offset_ms, cancel, move |job| kdj_media::remux::extract_audio(&source, job)).await;
    canceled(cancel)?;
    result
}

/// FLV 单流的音轨是不是 MP3：不加 Offset、只要音轨时原样存成 `.mp3`，不重编。
pub fn flv_audio_is_mp3(source: &Path) -> bool {
    is_flv(source)
        && kdj_media::flv::Flv::open(source).ok().and_then(|flv| flv.audio_codec()) == Some(kdj_media::flv::AudioCodec::Mp3)
}

/// FLV 单流里的 MP3 帧原样首尾相接，存成 `.mp3`。
pub async fn extract_mp3(source: &Path, output: &Path, cancel: &CancellationToken) -> Result<()> {
    let (source, output) = (source.to_path_buf(), output.to_path_buf());
    blocking(cancel, move |cancelled| kdj_media::flv::to_mp3(&source, &output, cancelled)).await?;
    canceled(cancel)
}

/// 下载能不能带 Offset：音轨要用系统 AAC 编码器重编。
pub fn offset_available() -> bool {
    kdj_media::remux::offset_supported()
}
