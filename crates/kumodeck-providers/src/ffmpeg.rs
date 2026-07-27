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

/// GUI 启动的 app 看不见的常见安装位置。
///
/// **macOS 的坑**：从 Finder/Dock 双击的 .app 继承的是 launchd 的极简
/// `PATH=/usr/bin:/bin:/usr/sbin:/sbin`，Homebrew 的 `/opt/homebrew/bin`
/// 根本不在里面。症状是**终端里起 dev 一切正常，装好的 App 里视频放不了**
/// （视频播放/分析要先用 ffmpeg 抽音轨），且 /api/health 报 ffmpeg=false。
/// v0.1.0 的 Electron 壳靠 `fix-path` 这个 npm 包兜的，纯 Rust 壳要自己兜。
const GUI_BLIND_DIRS: &[&str] = &[
    "/opt/homebrew/bin", // Apple Silicon Homebrew
    "/usr/local/bin",    // Intel Homebrew / 手动安装
    "/opt/local/bin",    // MacPorts
];

fn which(name: &str) -> Option<PathBuf> {
    if let Some(path_var) = std::env::var_os("PATH") {
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
    }
    // PATH 里没有再兜 GUI 看不见的位置——顺序反过来会把用户显式放进
    // PATH 的自编译版盖掉
    for dir in GUI_BLIND_DIRS {
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// 毫秒转 ffmpeg 认的秒数写法（`-ss 1.250`）。
fn secs(ms: i64) -> String {
    format!("{:.3}", ms as f64 / 1000.0)
}

/// 混流命令。`inputs` 是 `[视频]` 或 `[视频, 音频]`。
///
/// `offset_ms` 正数掐掉开头（`-ss` 放在 `-i` 前面，重编码下精确到帧），
/// 负数在开头补黑场 + 静音（tpad / adelay）。非零一律强制重编码：
/// copy 只能按关键帧切，误差以秒计，而这个值是对着唱盘一拍一拍
/// 校出来的，差几十毫秒都等于白校。
pub fn mux_args(
    inputs: &[PathBuf],
    output: &Path,
    transcode: bool,
    max_height: i64,
    offset_ms: i64,
) -> Vec<String> {
    let transcode = transcode || offset_ms != 0;
    let mut args: Vec<String> = vec!["-y".into()];
    for input in inputs {
        if offset_ms > 0 {
            // 每条输入都要各自 -ss：DASH 的音画是两个文件，只掐视频那条会错位
            args.push("-ss".into());
            args.push(secs(offset_ms));
        }
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
        // 负偏移的黑场在缩放前面补：tpad 生成的帧跟着源一起缩，滤镜链只写一遍尺寸
        let mut vf = String::new();
        if offset_ms < 0 {
            vf.push_str(&format!("tpad=start_duration={},", secs(-offset_ms)));
        }
        vf.push_str(&format!("scale=-2:min({max_height}\\,ih)"));
        args.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                TRANSCODE_PRESET,
                "-crf",
                &TRANSCODE_CRF.to_string(),
                "-vf",
                &vf,
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ]
            .map(str::to_string),
        );
        if offset_ms < 0 {
            // 画面补了黑场，声音就得补等长的静音，否则音画从头错到尾
            args.push("-af".into());
            args.push(format!("adelay={}:all=1", -offset_ms));
        }
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
///
/// `offset_ms` 语义同 [`mux_args`]：正数掐头、负数补静音，非零强制重编码
/// （AAC 帧 20ms 一个，copy 切不准）。
pub fn extract_audio_args(source: &Path, output: &Path, copy: bool, offset_ms: i64) -> Vec<String> {
    let copy = copy && offset_ms == 0;
    let mut args: Vec<String> = vec!["-y".into()];
    if offset_ms > 0 {
        args.push("-ss".into());
        args.push(secs(offset_ms));
    }
    args.extend([
        "-i".into(),
        source.to_string_lossy().into_owned(),
        "-vn".into(),
        "-map".into(),
        "0:a:0".into(),
    ]);
    if copy {
        args.push("-c:a".into());
        args.push("copy".into());
    } else {
        if offset_ms < 0 {
            args.push("-af".into());
            args.push(format!("adelay={}:all=1", -offset_ms));
        }
        args.extend(["-c:a", "aac", "-b:a", "128k"].map(str::to_string));
    }
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push(output.to_string_lossy().into_owned());
    args
}

// ---------------------------------------------------------------- 抽封面帧

/// 抽一帧的超时。混流可以跑半小时（`FFMPEG_TIMEOUT`），抽一帧不行：
/// 曲库列表正端着一个 HTTP 请求等这张图，十几秒还没出来就该认输了，
/// 那种情况多半是文件本身坏了，再等下去也是白等。
pub const FRAME_TIMEOUT: Duration = Duration::from_secs(15);

/// 缩略图最长边。列表里一行几十像素，详情面板最大三四百，
/// 512 够用；再大只是让每张图多占几百 KB 的缓存和带宽。
const FRAME_MAX_EDGE: u32 = 512;

/// 平均亮度低于这个值（0~255）就当"这一帧是黑的"。
/// 纯黑场实测在 1~3，夜景、暗调 MV 也有 20 往上，取 12 不会误伤正常的暗画面。
const FRAME_DARK_LUMA: f64 = 12.0;

/// 抽第几秒：**开头不能要**。片头常是黑场、台标、淡入，取第 0 帧
/// 十有八九得到一张纯黑的图。缩略图工具（ffmpegthumbnailer 之类）的通行做法
/// 是按时长取一个百分比，这里取 `min(10s, 时长的 10%)`——长片十秒足够跳过片头，
/// 短片按比例走也不会一下跳到中段。
///
/// 时长未知（曲库里没存、或者文件读不出来）时退回 1s：不准，但比第 0 帧强。
pub fn frame_position(duration_secs: Option<f64>) -> f64 {
    match duration_secs.filter(|secs| secs.is_finite() && *secs > 0.0) {
        Some(secs) => (secs * 0.1).min(10.0),
        None => 1.0,
    }
}

/// 依次要试的位置。第一张要是全黑就往后挪——VJ 素材"开头黑几秒"太常见了，
/// 只试一个位置的话曲库列表里会排出一列黑方块，和没有封面看着一样。
pub fn frame_positions(duration_secs: Option<f64>) -> Vec<f64> {
    let first = frame_position(duration_secs);
    match duration_secs.filter(|secs| secs.is_finite() && *secs > 0.0) {
        Some(secs) => vec![first, secs * 0.35, secs * 0.6],
        // 时长未知时没法按比例挪，只能按秒往后蹦。蹦过文件末尾的那次会抽帧失败，
        // 正好当成"没有更靠后的可选了"，不用额外判断
        None => vec![first, 5.0, 15.0],
    }
}

/// 抽帧命令。
pub fn frame_args(source: &Path, output: &Path, at_secs: f64) -> Vec<String> {
    vec![
        "-y".into(),
        // `-ss` 必须在 `-i` **前面**：放在后面 ffmpeg 会从头一帧帧解码再全部丢弃，
        // 一个十分钟的 4K MV 要白等好几秒；放在前面是按容器索引直接跳过去
        "-ss".into(),
        format!("{at_secs:.3}"),
        "-i".into(),
        source.to_string_lossy().into_owned(),
        "-frames:v".into(),
        "1".into(),
        // 视频文件里的音轨这里一点用没有，解它纯属浪费
        "-an".into(),
        "-vf".into(),
        // `min(边长, iw)` 是"只缩不放"的惯用写法：直接写死 512 会把一段
        // 320×240 的老素材放大成糊的
        format!(
            "scale='min({FRAME_MAX_EDGE},iw)':'min({FRAME_MAX_EDGE},ih)':force_original_aspect_ratio=decrease"
        ),
        "-q:v".into(),
        "3".into(),
        "-f".into(),
        "image2".into(),
        // 不加 `-update`，image2 会把输出名当成序列模板（要求带 %d），
        // 有些版本直接报错退出
        "-update".into(),
        "1".into(),
        output.to_string_lossy().into_owned(),
    ]
}

/// 从视频里抽一帧存成 JPEG。
pub async fn extract_frame(
    source: &Path,
    output: &Path,
    at_secs: f64,
    log_path: &Path,
    cancel: &CancellationToken,
) -> Result<()> {
    let args = frame_args(source, output, at_secs);
    // 超时时这里把 `run()` 的 future 直接丢掉，子进程带着 `kill_on_drop(true)`
    // 会跟着被杀，不会留下一个啃着 CPU 的孤儿 ffmpeg
    match tokio::time::timeout(FRAME_TIMEOUT, run(&args, log_path, cancel)).await {
        Ok(result) => result,
        Err(_) => bail!("抽帧超时"),
    }
}

/// 这一帧是不是几乎全黑。
///
/// 解不出来的图一律当"不黑"：宁可放一张我们看不懂的封面出去，
/// 也不要因为解码器不认它就把本来能用的图丢掉。
pub fn frame_is_mostly_black(jpeg: &[u8]) -> bool {
    let Ok(decoded) = image::load_from_memory(jpeg) else {
        return false;
    };
    let luma = decoded.to_luma8();
    if luma.is_empty() {
        return false;
    }
    let total: u64 = luma.iter().map(|pixel| u64::from(*pixel)).sum();
    (total as f64 / luma.len() as f64) < FRAME_DARK_LUMA
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
            0,
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
        let args = mux_args(&[PathBuf::from("s.flv")], Path::new("out.mp4"), false, 1080, 0);
        // `0:a:0?` 的问号不能丢：有些 flv 真的没有音轨，丢了整条命令就失败
        assert!(as_str(&args).contains(&"0:a:0?"));
    }

    #[test]
    fn transcode_scales_without_upscaling() {
        let args = mux_args(&[PathBuf::from("v.m4s")], Path::new("out.mp4"), true, 720, 0);
        let args = as_str(&args);
        assert!(args.contains(&"libx264"));
        // min(...) 保证不会把 480p 的源放大到 720p
        assert!(args.iter().any(|arg| arg.contains("min(720\\,ih)")));
        assert!(!args.contains(&"copy"));
    }

    #[test]
    fn audio_extraction_prefers_copy_then_falls_back_to_aac() {
        let copy = extract_audio_args(Path::new("s.m4s"), Path::new("o.m4a"), true, 0);
        assert!(as_str(&copy).windows(2).any(|w| w == ["-c:a", "copy"]));

        let reencode = extract_audio_args(Path::new("s.flv"), Path::new("o.m4a"), false, 0);
        let reencode = as_str(&reencode);
        assert!(reencode.windows(2).any(|w| w == ["-c:a", "aac"]));
        assert!(reencode.contains(&"128k"));
    }

    #[test]
    fn a_positive_offset_trims_every_input_and_forces_reencode() {
        let args = mux_args(
            &[PathBuf::from("v.m4s"), PathBuf::from("a.m4s")],
            Path::new("out.mp4"),
            false,
            1080,
            1250,
        );
        let args = as_str(&args);
        // 两条输入各自 -ss：DASH 音画分离，只掐一条就错位
        assert_eq!(args.iter().filter(|arg| **arg == "-ss").count(), 2);
        assert!(args.windows(2).any(|w| w == ["-ss", "1.250"]));
        // 明明传的 transcode=false，也必须走重编码——copy 只能按关键帧切
        assert!(args.contains(&"libx264"));
        assert!(!args.contains(&"copy"));
    }

    #[test]
    fn a_negative_offset_pads_black_video_and_matching_silence() {
        let args = mux_args(&[PathBuf::from("v.m4s")], Path::new("out.mp4"), true, 1080, -800);
        let args = as_str(&args);
        assert!(args.iter().any(|arg| arg.contains("tpad=start_duration=0.800")));
        // 画面补了黑场，声音必须补等长静音
        assert!(args.windows(2).any(|w| w == ["-af", "adelay=800:all=1"]));
        assert!(!args.contains(&"-ss"));
    }

    #[test]
    fn audio_offset_overrides_the_copy_fast_path() {
        let trimmed = extract_audio_args(Path::new("s.m4s"), Path::new("o.m4a"), true, 300);
        let trimmed = as_str(&trimmed);
        assert!(trimmed.windows(2).any(|w| w == ["-ss", "0.300"]));
        assert!(!trimmed.contains(&"copy"));

        let padded = extract_audio_args(Path::new("s.m4s"), Path::new("o.m4a"), true, -300);
        let padded = as_str(&padded);
        assert!(padded.windows(2).any(|w| w == ["-af", "adelay=300:all=1"]));
        assert!(!padded.contains(&"copy"));
    }

    #[test]
    fn the_cover_frame_skips_the_opening_black_screen() {
        // 片头是黑场/台标/淡入，第 0 帧基本等于一张黑图
        assert!(frame_position(Some(300.0)) > 0.0);
        // 长片：10% 是 30 秒，太靠后了，封顶在 10 秒
        assert_eq!(frame_position(Some(300.0)), 10.0);
        // 短素材：按 10% 走，不能一律 10 秒——那会落到 15 秒素材的中后段
        assert_eq!(frame_position(Some(60.0)), 6.0);
        assert!((frame_position(Some(15.0)) - 1.5).abs() < 1e-9);
    }

    #[test]
    fn an_unknown_duration_still_avoids_frame_zero() {
        // 曲库里没存时长（没分析过 / 读不出来）时不能退回 0
        assert_eq!(frame_position(None), 1.0);
        assert_eq!(frame_position(Some(0.0)), 1.0);
        assert_eq!(frame_position(Some(-3.0)), 1.0);
        assert_eq!(frame_position(Some(f64::NAN)), 1.0);
    }

    #[test]
    fn retry_positions_move_forward_and_stay_inside_the_file() {
        let positions = frame_positions(Some(200.0));
        assert_eq!(positions.len(), 3);
        assert!(
            positions.windows(2).all(|pair| pair[0] < pair[1]),
            "重试要往后挪，挪回原地等于白试一次"
        );
        assert!(
            positions.iter().all(|at| *at < 200.0),
            "挪过末尾就抽不出帧了"
        );
        // 时长未知时只能按秒往后蹦
        assert_eq!(frame_positions(None), vec![1.0, 5.0, 15.0]);
    }

    #[test]
    fn seeking_happens_before_decoding_not_after() {
        // `-ss` 落到 `-i` 后面的话 ffmpeg 会从头解码再丢弃，
        // 十分钟的 4K MV 每张封面要多等好几秒
        let args = frame_args(Path::new("v.mp4"), Path::new("c.jpg"), 10.0);
        let args = as_str(&args);
        let ss = args.iter().position(|arg| *arg == "-ss").unwrap();
        let input = args.iter().position(|arg| *arg == "-i").unwrap();
        assert!(ss < input);
        assert!(args.windows(2).any(|w| w == ["-frames:v", "1"]));
        // 只缩不放：320×240 的老素材不该被拉成 512 宽的糊图
        assert!(args.iter().any(|arg| arg.contains("min(512,iw)")));
        assert!(args
            .iter()
            .any(|arg| arg.contains("force_original_aspect_ratio=decrease")));
        // image2 不带 -update 会把输出名当序列模板
        assert!(args.windows(2).any(|w| w == ["-update", "1"]));
    }

    /// 造一张纯色 JPEG 当样本。
    fn solid_jpeg(level: u8) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(16, 16, image::Rgb([level, level, level]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
            .unwrap();
        out
    }

    #[test]
    fn a_black_frame_is_detected_but_a_dark_one_is_kept() {
        assert!(frame_is_mostly_black(&solid_jpeg(0)));
        // 夜景、暗调 MV 是正常画面，误判掉的话会一直往后重试、白跑 ffmpeg
        assert!(!frame_is_mostly_black(&solid_jpeg(40)));
        assert!(!frame_is_mostly_black(&solid_jpeg(255)));
    }

    #[test]
    fn an_undecodable_frame_counts_as_usable() {
        // 解不出来只说明我们不认识它，不代表它是黑的；
        // 判成"黑"会把一张本来能显示的封面白白丢掉
        assert!(!frame_is_mostly_black(b"not an image"));
        assert!(!frame_is_mostly_black(&[]));
    }

    #[tokio::test]
    async fn an_extracted_frame_fits_in_512_without_being_stretched() {
        // 没装 ffmpeg 就跳过：安卓和干净的 CI 机器上本来就没有
        if !available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("kumodeck-frame-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("clip.mp4");
        let log = dir.join("ffmpeg.log");
        let cancel = CancellationToken::new();

        // 1234×566 缩下来是 512×235——奇数高度，mjpeg 还得编得出来
        let make = [
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=1234x566:rate=10",
            "-t",
            "3",
            "-pix_fmt",
            "yuv420p",
            video.to_str().unwrap(),
        ]
        .map(str::to_string);
        run(&make, &log, &cancel).await.unwrap();

        let shot = dir.join("frame.jpg");
        extract_frame(&video, &shot, 1.0, &log, &cancel).await.unwrap();

        let data = std::fs::read(&shot).unwrap();
        assert!(data.starts_with(b"\xff\xd8\xff"), "得是一张真的 JPEG");
        let decoded = image::load_from_memory(&data).unwrap();
        assert_eq!(decoded.width().max(decoded.height()), 512, "最长边压到 512");
        let ratio = f64::from(decoded.width()) / f64::from(decoded.height());
        assert!(
            (ratio - 1234.0 / 566.0).abs() < 0.02,
            "画面被拉变形了：{ratio}"
        );
        assert!(!frame_is_mostly_black(&data), "testsrc 是彩条，不该判成黑");

        // 比源还小的素材不许放大，放大只会得到一张糊图
        let small = dir.join("small.mp4");
        let make_small = [
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=10",
            "-t",
            "3",
            "-pix_fmt",
            "yuv420p",
            small.to_str().unwrap(),
        ]
        .map(str::to_string);
        run(&make_small, &log, &cancel).await.unwrap();
        let shot_small = dir.join("small.jpg");
        extract_frame(&small, &shot_small, 1.0, &log, &cancel)
            .await
            .unwrap();
        let decoded = image::load_from_memory(&std::fs::read(&shot_small).unwrap()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (320, 240));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn seeking_past_the_end_fails_instead_of_writing_an_empty_file() {
        if !available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("kumodeck-frame-eof-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("clip.mp4");
        let log = dir.join("ffmpeg.log");
        let cancel = CancellationToken::new();
        let make = [
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=160x120:rate=10",
            "-t",
            "2",
            "-pix_fmt",
            "yuv420p",
            video.to_str().unwrap(),
        ]
        .map(str::to_string);
        run(&make, &log, &cancel).await.unwrap();

        // 时长未知时重试位置会挪过文件末尾，这一枪必须是"失败"，
        // 不能悄悄留下一个 0 字节的 jpg 被当成封面发出去
        let shot = dir.join("frame.jpg");
        let result = extract_frame(&video, &shot, 30.0, &log, &cancel).await;
        let size = std::fs::metadata(&shot).map(|meta| meta.len()).unwrap_or(0);
        assert!(result.is_err() || size == 0);
        let _ = std::fs::remove_dir_all(&dir);
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
