//! Bounded, cancellable FFprobe / FFmpeg runs for the CLI's `peek`: probing and capturing
//! output. No shell command construction. The visualizer's export does not use any of it.
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Stream {
    pub index: usize,
    #[serde(default)]
    pub codec_type: String,
    #[serde(default)]
    pub codec_name: String,
    #[serde(default)]
    pub start_time: String,
    #[serde(default)]
    pub duration: String,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub avg_frame_rate: String,
    #[serde(default)]
    pub pix_fmt: String,
    #[serde(default)]
    pub color_space: String,
    #[serde(default)]
    pub color_transfer: String,
    #[serde(default)]
    pub color_primaries: String,
    #[serde(default)]
    pub sample_aspect_ratio: String,
    #[serde(default)]
    pub side_data_list: Vec<serde_json::Value>,
    #[serde(default)]
    pub disposition: BTreeMap<String, i32>,
    #[serde(default)]
    pub tags: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Format {
    #[serde(default)]
    pub duration: String,
    #[serde(default)]
    pub start_time: String,
    #[serde(default)]
    pub tags: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Chapter {
    #[serde(default)]
    pub start_time: String,
    #[serde(default)]
    pub end_time: String,
    #[serde(default)]
    pub tags: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Probe {
    #[serde(default)]
    pub streams: Vec<Stream>,
    #[serde(default)]
    pub format: Format,
    #[serde(default)]
    pub chapters: Vec<Chapter>,
}

fn command(binary: &Path) -> Command {
    let mut command = Command::new(binary);
    kdj_core::thread_qos::background_command(command.as_std_mut());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

pub(super) async fn stderr_tail(mut reader: impl tokio::io::AsyncRead + Unpin) -> Vec<u8> {
    let mut tail = Vec::new();
    let mut buf = [0; 8192];
    while let Ok(count) = reader.read(&mut buf).await {
        if count == 0 {
            break;
        }
        tail.extend_from_slice(&buf[..count]);
        if tail.len() > 65536 {
            tail.drain(..tail.len() - 65536);
        }
    }
    tail
}

pub(crate) async fn capture(
    binary: &Path,
    args: &[String],
    limit: u64,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    let mut child = command(binary)
        .args(args)
        .spawn()
        .context("启动媒体处理失败")?;
    let mut stdout = child
        .stdout
        .take()
        .context("缺少媒体输出管道")?
        .take(limit + 1);
    let stderr = child.stderr.take().context("缺少媒体错误管道")?;
    let work = async {
        let mut bytes = Vec::new();
        let read = async {
            stdout.read_to_end(&mut bytes).await?;
            if bytes.len() as u64 > limit {
                bail!("媒体分析输出超过限制");
            }
            Ok::<_, anyhow::Error>(())
        };
        let (_, tail) = tokio::try_join!(read, async {
            Ok::<_, anyhow::Error>(stderr_tail(stderr).await)
        })?;
        let status = child.wait().await?;
        if !status.success() {
            bail!("媒体处理失败：{}", String::from_utf8_lossy(&tail).trim());
        }
        Ok(bytes)
    };
    tokio::select! {
        biased;
        _=cancel.cancelled()=> { let _=child.kill().await; bail!("合成已取消"); }
        result=tokio::time::timeout(timeout,work)=> match result { Ok(value)=>value, Err(_)=>{ let _=child.kill().await; bail!("媒体处理超时"); } }
    }
}

pub async fn probe(path: &Path, cancel: &CancellationToken) -> Result<Probe> {
    let started = std::time::Instant::now();
    let args = vec![
        "-v".into(),
        "error".into(),
        "-show_streams".into(),
        "-show_format".into(),
        "-show_chapters".into(),
        "-of".into(),
        "json".into(),
        path.to_string_lossy().into_owned(),
    ];
    let data = capture(
        &kdj_providers::ffmpeg::probe_binary()?,
        &args,
        8 * 1024 * 1024,
        Duration::from_secs(60),
        cancel,
    )
    .await?;
    let capture_ms = started.elapsed().as_secs_f64() * 1000.;
    let parse_started = std::time::Instant::now();
    let result = serde_json::from_slice(&data).context("读取媒体信息失败");
    tracing::debug!(target: "kdj_alignment_timing", capture_ms,
        parse_ms = parse_started.elapsed().as_secs_f64() * 1000., "media probe finished");
    result
}

