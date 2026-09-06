//! Explicit settings check; never spawn processes from the frequent health poll.
use std::{path::PathBuf, process::Stdio, time::Duration};

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ToolStatus {
    state: &'static str,
    path: Option<PathBuf>,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FfmpegInstallationStatus {
    platform: &'static str,
    arch: &'static str,
    ffmpeg: ToolStatus,
    ffprobe: ToolStatus,
}

fn version_from_output(name: &str, output: &std::process::Output) -> Option<String> {
    if !output.status.success() {
        return None;
    }
    let prefix = format!("{name} version ");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix(&prefix)?.split_whitespace().next().map(str::to_owned))
}

async fn inspect(name: &str, path: Option<PathBuf>) -> ToolStatus {
    let mut result = ToolStatus { state: "missing", path, version: None, error: None };
    let Some(path) = &result.path else { return result; };
    result.state = "broken";
    let mut command = tokio::process::Command::new(path);
    command.arg("-version").stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    match tokio::time::timeout(Duration::from_secs(5), command.output()).await {
        Ok(Ok(output)) => match version_from_output(name, &output) {
            Some(version) => {
                result.state = "ready";
                result.version = Some(version);
            }
            None => result.error = Some(format!("{name} 版本检测失败，请检查安装与系统兼容性")),
        },
        Ok(Err(error)) => result.error = Some(format!("{name} 无法运行：{error}")),
        Err(_) => result.error = Some(format!("{name} 检测超时")),
    }
    result
}

pub async fn installation_status() -> FfmpegInstallationStatus {
    let (ffmpeg, ffprobe) = tokio::join!(
        inspect("ffmpeg", super::binary().ok()),
        inspect("ffprobe", super::probe_binary().ok().or_else(|| super::which("ffprobe"))),
    );
    FfmpegInstallationStatus {
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        ffmpeg,
        ffprobe,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_and_unlaunchable_are_distinct() {
        assert_eq!(inspect("ffmpeg", None).await.state, "missing");
        let broken = inspect("ffmpeg", Some(PathBuf::from("/nonexistent-kdj-ffmpeg/status-tool"))).await;
        assert_eq!(broken.state, "broken");
        assert!(broken.error.is_some());
        assert!(broken.version.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn requires_success_and_expected_tool_banner() {
        use std::os::unix::process::ExitStatusExt;
        let mut output = std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: b"ffmpeg version 8.0-custom Copyright (c) FFmpeg\nconfiguration: ...".to_vec(),
            stderr: vec![],
        };
        assert_eq!(version_from_output("ffmpeg", &output).as_deref(), Some("8.0-custom"));
        assert_eq!(version_from_output("ffprobe", &output), None);
        output.status = std::process::ExitStatus::from_raw(256);
        assert_eq!(version_from_output("ffmpeg", &output), None);
    }
}
