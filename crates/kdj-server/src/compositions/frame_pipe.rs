//! Replayable RGBA input with two frame credits. A dedicated producer overlaps
//! drawing/upload with pipe writes; credits bound memory even under backpressure.
//! Every attempt joins its producer before a hardware retry can request frame 0.
use anyhow::{Context, Result, bail, ensure};
use axum::body::Bytes;
use std::{path::Path, process::Stdio, sync::Arc, time::{Duration, Instant}};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

pub(super) enum FramePixels {
    Raster(Vec<u8>),
    Uploaded(Bytes),
}
impl FramePixels {
    fn bytes(&self) -> &[u8] {
        match self { Self::Raster(pixels) => pixels, Self::Uploaded(pixels) => pixels }
    }
    fn recycle(self) -> Vec<u8> {
        match self { Self::Raster(pixels) => pixels, Self::Uploaded(_) => Vec::new() }
    }
}

pub(super) trait FrameSource: Send + Sync {
    fn frame_count(&self) -> u64;
    fn frame_bytes(&self) -> usize;
    /// Must be a pure function of index and immutable source parameters.
    fn draw(&self, index: u64, rgba: &mut [u8]) -> Result<()>;
    /// Upload sources can transfer ownership without copying a full RGBA frame.
    /// Blocking sources must observe the per-attempt token, not just job cancel.
    fn pixels(&self, index: u64, mut buffer: Vec<u8>, cancel: &CancellationToken) -> Result<FramePixels> {
        ensure!(!cancel.is_cancelled(), "可视化导出已取消");
        buffer.resize(self.frame_bytes(), 0);
        self.draw(index, &mut buffer)?;
        Ok(FramePixels::Raster(buffer))
    }
}

async fn tail(mut input: impl tokio::io::AsyncRead + Unpin) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut block = [0; 8192];
    while let Ok(count) = input.read(&mut block).await {
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&block[..count]);
        if bytes.len() > 65536 {
            bytes.drain(..bytes.len() - 65536);
        }
    }
    bytes
}
struct StopOnDrop(CancellationToken);
impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub(super) async fn render(
    binary: &Path,
    args: &[String],
    duration_ms: i64,
    cancel: &CancellationToken,
    source: Arc<dyn FrameSource>,
    progress: impl Fn(f64),
) -> Result<()> {
    ensure!(!cancel.is_cancelled(), "可视化导出已取消");
    ensure!(
        source.frame_count() > 0 && (1..=32 * 1024 * 1024).contains(&source.frame_bytes()),
        "透明帧大小或数量无效"
    );
    ensure!(duration_ms > 0, "导出时长无效");
    ensure!(
        args.windows(2)
            .filter(|p| p[0] == "-i" && p[1] == "pipe:0")
            .count()
            == 1,
        "透明帧输入必须是唯一标准输入管道"
    );
    let stopped = cancel.child_token();
    let _stop = StopOnDrop(stopped.clone());
    let mut command = Command::new(binary);
    kdj_core::thread_qos::background_command(command.as_std_mut());
    let mut child = command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("启动透明图层合成失败")?;
    let mut input = child.stdin.take().context("缺少透明帧输入管道")?;
    let mut stdout = BufReader::new(child.stdout.take().context("缺少导出进度管道")?).lines();
    let stderr = child.stderr.take().context("缺少导出错误管道")?;
    let started = Instant::now();
    let count = source.frame_count();
    let bytes = source.frame_bytes();
    let (frames_tx, mut frames_rx) = tokio::sync::mpsc::channel(1);
    let (buffers_tx, mut buffers_rx) = tokio::sync::mpsc::channel(2);
    // A credit is held from production until write completion. At most two
    // frames exist, including a frame being drawn (not just queued frames).
    buffers_tx.try_send(Vec::new())?;
    buffers_tx.try_send(Vec::new())?;
    let token = stopped.clone();
    let producer = tokio::task::spawn_blocking(move || {
        for index in 0..count {
            let Some(buffer) = buffers_rx.blocking_recv() else { break; };
            if token.is_cancelled() { break; }
            let draw_started = Instant::now();
            let frame = source.pixels(index, buffer, &token);
            let failed = frame.is_err();
            if frames_tx.blocking_send((frame, draw_started.elapsed())).is_err() || failed { break; }
        }
    });
    let errors = tokio::spawn(tail(stderr));
    let mut written = 0_u64;
    let mut drawing = Duration::ZERO;
    let mut writing = Duration::ZERO;
    let work = async {
        let write = async {
            // These endpoints belong to this future. Dropping it wakes either
            // blocking channel operation in the producer on error/cancellation.
            let buffers_tx = buffers_tx;
            let frames_rx = &mut frames_rx;
            for _ in 0..count {
                let (frame, elapsed) = frames_rx.recv().await.context("视频帧供给提前结束")?;
                let frame = frame?;
                ensure!(frame.bytes().len() == bytes, "RGBA 帧长度不匹配");
                drawing += elapsed;
                let write_started = Instant::now();
                input.write_all(frame.bytes()).await.context("写入透明帧失败")?;
                writing += write_started.elapsed();
                written += 1;
                // After the final production, the receiver may already be gone.
                let _ = buffers_tx.try_send(frame.recycle());
            }
            input.shutdown().await?;
            drop(input);
            Ok::<_, anyhow::Error>(())
        };
        let read = async {
            while let Some(line) = stdout.next_line().await? {
                if let Some(time) = line.strip_prefix("out_time_us=")
                    .and_then(|s| s.parse::<f64>().ok()).filter(|v| v.is_finite()) {
                    progress((time / (duration_ms as f64 * 1000.)).clamp(0., 0.99));
                }
            }
            Ok::<_, anyhow::Error>(())
        };
        let wait = async {
            let status = child.wait().await?;
            ensure!(status.success(), "透明图层合成失败（{status}）");
            Ok::<_, anyhow::Error>(())
        };
        tokio::try_join!(write, read, wait)?;
        Ok(())
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(anyhow::anyhow!("可视化导出已取消")),
        result = tokio::time::timeout(kdj_providers::ffmpeg::FFMPEG_TIMEOUT, work) => match result {
            Ok(result) => result,
            Err(_) => Err(anyhow::anyhow!("可视化导出超时")),
        },
    };
    stopped.cancel();
    drop(frames_rx);
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let producer_result = producer.await.context("透明帧绘制任务失败");
    let errors = errors.await.context("读取编码错误失败")?;
    tracing::info!(frames = written, frame_bytes = bytes, elapsed_ms = started.elapsed().as_millis() as u64,
        source_ms = drawing.as_millis() as u64, pipe_ms = writing.as_millis() as u64,
        "visualizer frame pipeline (source and pipe times overlap)");
    if let Err(error) = result {
        bail!("{error:#}：{}", String::from_utf8_lossy(&errors).trim());
    }
    producer_result?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Invalid;
    impl FrameSource for Invalid {
        fn frame_count(&self) -> u64 {
            0
        }
        fn frame_bytes(&self) -> usize {
            usize::MAX
        }
        fn draw(&self, _: u64, _: &mut [u8]) -> Result<()> {
            panic!("must not draw")
        }
    }
    #[tokio::test]
    async fn checks_cancellation_and_allocation_before_spawning() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = render(
            Path::new("missing"),
            &[],
            1000,
            &cancel,
            Arc::new(Invalid),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("取消"));
        assert!(
            render(
                Path::new("missing"),
                &[],
                1000,
                &CancellationToken::new(),
                Arc::new(Invalid),
                |_| {}
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("大小")
        );
    }
}
