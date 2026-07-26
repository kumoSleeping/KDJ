//! ffmpeg 调用封装：DASH 混流、抽音轨、可选转码。
//!
//! v0.1.x 就没有打包 ffmpeg，要求用户机器上自己装（`shutil.which`）——这里保持一致。
//! 安卓上没有 ffmpeg，走的是"向 B 站要 durl 单流"那条路，不经过本模块。
//!
//! 两个必须保留的行为：
//! - stderr 重定向到文件而不是管道：转码时 ffmpeg 输出很啰嗦，
//!   用管道又不及时读会把缓冲区写满导致死锁；
//! - 支持取消和超时，超时/取消都要真的把进程杀掉。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio_util::sync::CancellationToken;

pub const FFMPEG_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const TRANSCODE_CRF: u32 = 20;
const TRANSCODE_PRESET: &str = "veryfast";

/// 机器上有没有 ffmpeg。`/api/health` 要回这个值。
pub fn available() -> bool {
    binary().is_ok()
}

pub fn binary() -> Result<PathBuf> {
    which("ffmpeg").context("没有找到 ffmpeg，请先安装 FFmpeg")
}

fn which(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        // Windows 上要带扩展名
        let with_exe = dir.join(format!("{name}.exe"));
        if with_exe.is_file() {
            return Some(with_exe);
        }
    }
    None
}

/// 混流命令。`inputs` 是 `[视频]` 或 `[视频, 音频]`。
pub fn mux_args(inputs: &[PathBuf], output: &Path, transcode: bool, max_height: i64) -> Vec<String> {
    let mut args: Vec<String> = vec!["-y".into()];
    for input in inputs {
        args.push("-i".into());
        args.push(input.to_string_lossy().into_owned());
    }
    args.push("-map".into());
    args.push("0:v:0".into());
    if inputs.len() > 1 {
        args.push("-map".into());
        args.push("1:a:0".into());
    } else {
        // 单流里音轨可能不存在，`?` 让它可选，否则整条命令会失败
        args.push("-map".into());
        args.push("0:a:0?".into());
    }
    if transcode {
        args.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                TRANSCODE_PRESET,
                "-crf",
                &TRANSCODE_CRF.to_string(),
                "-vf",
                &format!("scale=-2:min({max_height}\\,ih)"),
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ]
            .map(str::to_string),
        );
    } else {
        // 桌面端没有体积限制的必要，默认直接封装，比重编码快一个数量级
        args.push("-c".into());
        args.push("copy".into());
    }
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// 抽音轨命令。`copy = true` 时不重编码。
pub fn extract_audio_args(source: &Path, output: &Path, copy: bool) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        source.to_string_lossy().into_owned(),
        "-vn".into(),
        "-map".into(),
        "0:a:0".into(),
    ];
    if copy {
        args.push("-c:a".into());
        args.push("copy".into());
    } else {
        args.extend(["-c:a", "aac", "-b:a", "128k"].map(str::to_string));
    }
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// 跑一条 ffmpeg 命令，支持取消与超时。
pub async fn run(args: &[String], log_path: &Path, cancel: &CancellationToken) -> Result<()> {
    // 短视频可能在第一次轮询之前就跑完了，所以起进程之前先看一眼
    if cancel.is_cancelled() {
        bail!("下载已取消");
    }
    let binary = binary()?;
    let log = std::fs::File::create(log_path).context("创建 ffmpeg 日志失败")?;
    let mut child = tokio::process::Command::new(binary)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .kill_on_drop(true)
        .spawn()
        .context("启动 ffmpeg 失败")?;

    let status = tokio::select! {
        status = child.wait() => status.context("等待 ffmpeg 失败")?,
        _ = cancel.cancelled() => {
            let _ = child.kill().await;
            bail!("下载已取消");
        }
        _ = tokio::time::sleep(FFMPEG_TIMEOUT) => {
            let _ = child.kill().await;
            bail!("FFmpeg 处理超时");
        }
    };
    if status.success() {
        return Ok(());
    }
    // 失败原因通常在 stderr 的最后一行
    let detail = std::fs::read_to_string(log_path)
        .ok()
        .and_then(|text| text.trim().lines().next_back().map(str::to_string))
        .unwrap_or_default();
    bail!(
        "FFmpeg 处理失败：{}",
        if detail.is_empty() {
            status.to_string()
        } else {
            detail
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn as_str(args: &[String]) -> Vec<&str> {
        args.iter().map(String::as_str).collect()
    }

    #[test]
    fn dash_mux_copies_both_streams_without_reencoding() {
        let args = mux_args(
            &[PathBuf::from("v.m4s"), PathBuf::from("a.m4s")],
            Path::new("out.mp4"),
            false,
            1080,
        );
        let args = as_str(&args);
        assert_eq!(
            args,
            vec![
                "-y", "-i", "v.m4s", "-i", "a.m4s", "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
                "-movflags", "+faststart", "out.mp4"
            ]
        );
    }

    #[test]
    fn single_input_marks_the_audio_stream_optional() {
        let args = mux_args(&[PathBuf::from("s.flv")], Path::new("out.mp4"), false, 1080);
        // `0:a:0?` 的问号不能丢：有些 flv 真的没有音轨，丢了整条命令就失败
        assert!(as_str(&args).contains(&"0:a:0?"));
    }

    #[test]
    fn transcode_scales_without_upscaling() {
        let args = mux_args(&[PathBuf::from("v.m4s")], Path::new("out.mp4"), true, 720);
        let args = as_str(&args);
        assert!(args.contains(&"libx264"));
        // min(...) 保证不会把 480p 的源放大到 720p
        assert!(args.iter().any(|arg| arg.contains("min(720\\,ih)")));
        assert!(!args.contains(&"copy"));
    }

    #[test]
    fn audio_extraction_prefers_copy_then_falls_back_to_aac() {
        let copy = extract_audio_args(Path::new("s.m4s"), Path::new("o.m4a"), true);
        assert!(as_str(&copy).windows(2).any(|w| w == ["-c:a", "copy"]));

        let reencode = extract_audio_args(Path::new("s.flv"), Path::new("o.m4a"), false);
        let reencode = as_str(&reencode);
        assert!(reencode.windows(2).any(|w| w == ["-c:a", "aac"]));
        assert!(reencode.contains(&"128k"));
    }

    #[tokio::test]
    async fn a_cancelled_token_short_circuits_before_spawning() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let log = std::env::temp_dir().join("kumodeck-ffmpeg-cancel.log");
        let err = run(&["-version".into()], &log, &cancel).await.unwrap_err();
        assert!(err.to_string().contains("取消"));
    }
}
