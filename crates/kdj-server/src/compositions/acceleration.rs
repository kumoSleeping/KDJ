//! Hardware H.264 encoding for `media::render_args` and its private staging output.
//!
//! The caller must exclusively own the `.kdj-composition-*/render.<ext>` directory
//! until this future finishes, just as `render_and_commit` does. This module never
//! publishes output, changes paths, or retries an arbitrary destination. Unsupported
//! argument layouts are passed unchanged to the existing renderer.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result, bail};
use kdj_core::composition::EncodingAcceleration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::media;

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const PROBE_BYTES: u64 = 256 * 1024;
const AVAILABLE_TTL: Duration = Duration::from_secs(30 * 60);
const UNAVAILABLE_TTL: Duration = Duration::from_secs(5 * 60);
const FAILURE_TTL: Duration = Duration::from_secs(60);
const DEFAULT_BITRATE: u64 = 12_000_000;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Encoder {
    VideoToolbox,
    Nvidia,
    Intel,
    Amd,
}

impl Encoder {
    fn name(self) -> &'static str {
        match self {
            Self::VideoToolbox => "h264_videotoolbox",
            Self::Nvidia => "h264_nvenc",
            Self::Intel => "h264_qsv",
            Self::Amd => "h264_amf",
        }
    }

    fn supported_platform(self) -> bool {
        match self {
            Self::VideoToolbox => cfg!(target_os = "macos"),
            _ => cfg!(any(target_os = "windows", target_os = "linux")),
        }
    }

    fn options(self, bitrate: u64) -> Vec<String> {
        // Encoder-private flags verified against local VideoToolbox help and the
        // official FFmpeg libavcodec/{nvenc_h264,qsvenc,amfenc_h264} sources.
        // Use the same options in the encode probe: an advertised encoder alone
        // does not establish that the installed driver/runtime can use it.
        let options: &[&str] = match self {
            Self::VideoToolbox => &["-allow_sw:v:0", "0"],
            Self::Nvidia => &["-preset:v:0", "medium", "-rc:v:0", "vbr", "-cq:v:0", "20"],
            Self::Intel => &["-preset:v:0", "medium"],
            Self::Amd => &[
                "-usage:v:0",
                "transcoding",
                "-quality:v:0",
                "quality",
                "-rc:v:0",
                "vbr_peak",
            ],
        };
        let mut args = options.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        args.extend([
            "-b:v:0".into(),
            bitrate.to_string(),
            "-maxrate:v:0".into(),
            (bitrate * 3 / 2).to_string(),
            "-bufsize:v:0".into(),
            (bitrate * 2).to_string(),
        ]);
        args
    }
}

fn candidates(preference: EncodingAcceleration) -> Vec<Encoder> {
    use EncodingAcceleration as P;
    let encoders = match preference {
        P::Software => vec![],
        P::Auto => vec![
            Encoder::VideoToolbox,
            Encoder::Nvidia,
            Encoder::Intel,
            Encoder::Amd,
        ],
        P::VideoToolbox => vec![Encoder::VideoToolbox],
        P::Nvidia => vec![Encoder::Nvidia],
        P::Intel => vec![Encoder::Intel],
        P::Amd => vec![Encoder::Amd],
    };
    encoders
        .into_iter()
        .filter(|e| e.supported_platform())
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BinaryIdentity {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    inode: (u64, u64, i64, i64),
}

impl BinaryIdentity {
    fn read(path: &Path) -> Result<Self> {
        let path = path.canonicalize()?;
        let metadata = std::fs::metadata(&path)?;
        Ok(Self {
            path,
            size: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            #[cfg(unix)]
            inode: {
                use std::os::unix::fs::MetadataExt;
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                )
            },
        })
    }
}

struct Observation {
    available: bool,
    expires: Instant,
}

#[derive(Default)]
struct Cache {
    binary: Option<BinaryIdentity>,
    observations: HashMap<Encoder, Observation>,
}

impl Cache {
    fn use_binary(&mut self, binary: &BinaryIdentity) {
        if self.binary.as_ref() != Some(binary) {
            self.observations.clear();
            self.binary = Some(binary.clone());
        }
    }

    fn remember(&mut self, encoder: Encoder, available: bool, ttl: Duration) {
        self.observations.insert(
            encoder,
            Observation {
                available,
                expires: Instant::now() + ttl,
            },
        );
    }
}

fn cache() -> &'static tokio::sync::Mutex<Cache> {
    static CACHE: OnceLock<tokio::sync::Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(Cache::default()))
}

fn check_cancel(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        bail!("合成已取消");
    }
    Ok(())
}

async fn working_encoder(
    binary: &BinaryIdentity,
    candidates: &[Encoder],
    cancel: &CancellationToken,
) -> Result<Option<Encoder>> {
    // Serializing discovery coalesces concurrent first renders. Waiting for this
    // lock is cancellable; it is never held during a composition render.
    let mut cache = tokio::select! {
        biased;
        _ = cancel.cancelled() => bail!("合成已取消"),
        guard = cache().lock() => guard,
    };
    cache.use_binary(binary);
    for &encoder in candidates {
        check_cancel(cancel)?;
        if let Some(observation) = cache
            .observations
            .get(&encoder)
            .filter(|o| Instant::now() < o.expires)
        {
            if observation.available {
                return Ok(Some(encoder));
            }
            continue;
        }
        let available = probe_encoder(&binary.path, encoder, cancel).await?;
        cache.remember(
            encoder,
            available,
            if available {
                AVAILABLE_TTL
            } else {
                UNAVAILABLE_TTL
            },
        );
        if available {
            return Ok(Some(encoder));
        }
    }
    Ok(None)
}

async fn probe_encoder(
    binary: &Path,
    encoder: Encoder,
    cancel: &CancellationToken,
) -> Result<bool> {
    let mut args = [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x180:r=30:d=0.1",
        "-an",
        "-frames:v:0",
        "3",
        "-c:v:0",
        encoder.name(),
        "-pix_fmt:v:0",
        "yuv420p",
    ]
    .map(str::to_owned)
    .to_vec();
    args.extend(encoder.options(1_000_000));
    args.extend(["-f", "h264", "pipe:1"].map(str::to_owned));
    encode_probe(binary, &args, PROBE_TIMEOUT, cancel).await
}

async fn encode_probe(
    binary: &Path,
    args: &[String],
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<bool> {
    check_cancel(cancel)?;
    let mut command = Command::new(binary);
    kdj_core::thread_qos::background_command(command.as_std_mut());
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let Ok(mut child) = command.spawn() else {
        return Ok(false);
    };
    let mut stdout = child
        .stdout
        .take()
        .context("缺少编码探测管道")?
        .take(PROBE_BYTES + 1);
    let work = async {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await?;
        if bytes.is_empty() || bytes.len() as u64 > PROBE_BYTES {
            return Ok::<_, std::io::Error>(false);
        }
        Ok(child.wait().await?.success())
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        result = tokio::time::timeout(timeout, work) => Some(result),
    };
    // Also reap failed/timed-out probes; dropping the parent future kills the
    // child via kill_on_drop. No probe files or detached drain tasks are created.
    let available = matches!(result, Some(Ok(Ok(true))));
    if !available {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    check_cancel(cancel)?;
    Ok(available)
}

struct Layout {
    pairs: Vec<usize>,
    inputs: Vec<usize>,
    codec: usize,
}

fn layout(args: &[String]) -> Option<Layout> {
    let output = Path::new(args.last()?);
    if output
        .extension()
        .is_some_and(|s| s.eq_ignore_ascii_case("webm"))
    {
        return None;
    }
    let mut pairs = Vec::new();
    let mut inputs = Vec::new();
    let mut codec = None;
    let mut no_clobber = false;
    let mut i = 0;
    while i < args.len() - 1 {
        let key = args[i].as_str();
        if matches!(key, "-nostdin" | "-copyts" | "-n" | "-nostats") {
            no_clobber |= key == "-n";
            i += 1;
            continue;
        }
        // Deliberately recognize the builder's vocabulary, not arbitrary FFmpeg
        // commands: a second output or an unknown flag must never authorize cleanup.
        if !(matches!(
            key,
            "-v" | "-filter_complex_threads"
                | "-threads"
                | "-ss"
                | "-framerate"
                | "-safe"
                | "-itsoffset"
                | "-i"
                | "-f"
                | "-filter_complex"
                | "-filter_complex_script"
                | "-map"
                | "-map_chapters"
                | "-c"
                | "-c:v:0"
                | "-preset"
                | "-crf"
                | "-threads:v:0"
                | "-pix_fmt:v:0"
                | "-c:a"
                | "-b:a"
                | "-t"
                | "-max_interleave_delta"
                | "-progress"
                | "-stats_period"
                | "-movflags"
        ) || key == "-map_metadata"
            || key.starts_with("-map_metadata:")
            || key.starts_with("-disposition:"))
            || i + 1 >= args.len() - 1
        {
            return None;
        }
        if key == "-i" {
            inputs.push(i);
        }
        if matches!(key, "-c" | "-c:v:0") {
            codec = Some(i);
        }
        pairs.push(i);
        i += 2;
    }
    let codec = codec?;
    let last_input = *inputs.last()?;
    if !no_clobber
        || codec < last_input
        || args[codec] != "-c:v:0"
        || args[codec + 1] != "libx264"
        || pairs
            .iter()
            .any(|&i| i > last_input && args[i] == "-f" && args[i + 1] == "webm")
    {
        return None;
    }
    Some(Layout {
        pairs,
        inputs,
        codec,
    })
}

fn accelerated_args(
    args: &[String],
    layout: &Layout,
    encoder: Encoder,
    bitrate: u64,
) -> Vec<String> {
    let last_input = *layout.inputs.last().unwrap();
    let remove = layout
        .pairs
        .iter()
        .copied()
        .filter(|&i| i > last_input && matches!(args[i].as_str(), "-preset" | "-crf"))
        .collect::<Vec<_>>();
    let mut result = Vec::with_capacity(args.len() + 12);
    let mut i = 0;
    while i < args.len() - 1 {
        if remove.contains(&i) {
            i += 2;
            continue;
        }
        result.push(if i == layout.codec + 1 {
            encoder.name().into()
        } else {
            args[i].clone()
        });
        i += 1;
    }
    result.extend(encoder.options(bitrate));
    result.push(args.last().unwrap().clone());
    result
}

struct Staging {
    output: PathBuf,
    directory: PathBuf,
    metadata: std::fs::Metadata,
}

impl Staging {
    fn prepare(args: &[String], layout: &Layout) -> Result<Option<Self>> {
        let output = PathBuf::from(args.last().unwrap());
        let Some(directory) = output.parent() else {
            return Ok(None);
        };
        if !output.is_absolute()
            || output.file_stem() != Some(std::ffi::OsStr::new("render"))
            || output.extension().is_none()
            || !directory
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.starts_with(".kdj-composition-") && s.len() > 17)
        {
            return Ok(None);
        }
        let metadata = std::fs::symlink_metadata(directory)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Ok(None);
        }
        let canonical = directory.canonicalize()?;
        for &i in &layout.inputs {
            // Resolve source aliases before comparing with the absent output.
            // Chapters metadata may be an input here and is never deleted.
            let input = Path::new(&args[i + 1]).canonicalize()?;
            if input == canonical.join(output.file_name().unwrap()) {
                bail!("合成临时输出与源文件相同");
            }
        }
        match std::fs::symlink_metadata(&output) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
            Ok(_) => bail!("合成临时输出已存在，未覆盖"),
        }
        Ok(Some(Self {
            output,
            directory: canonical,
            metadata,
        }))
    }

    fn remove_partial(&self) -> Result<()> {
        let parent = self.output.parent().unwrap();
        let current = std::fs::symlink_metadata(parent)?;
        if !current.is_dir()
            || current.file_type().is_symlink()
            || parent.canonicalize()? != self.directory
            || !same_file(&self.metadata, &current)
        {
            bail!("合成临时目录已变化，未清理输出");
        }
        let metadata = match std::fs::symlink_metadata(&self.output) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            bail!("合成临时输出不是普通文件，未清理");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() != 1 {
                bail!("合成临时输出存在硬链接，未清理");
            }
        }
        // Only this exact, initially absent scratch file. Never recursive cleanup.
        std::fs::remove_file(&self.output).context("无法清理硬件编码临时输出")
    }
}

fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(not(unix))]
    {
        // Stable std does not expose Windows file IDs on the minimum toolchain.
        a.created()
            .ok()
            .zip(b.created().ok())
            .is_some_and(|(a, b)| a == b)
    }
}

fn bitrate(width: u32, height: u32, fps: f64) -> u64 {
    if width == 0 || height == 0 {
        return DEFAULT_BITRATE;
    }
    let fps = if fps.is_finite() && fps > 0. {
        fps.clamp(24., 120.)
    } else {
        30.
    };
    // 12 Mbps at 1080p30, proportional to pixels and frame rate, with headroom
    // for hardware encoders relative to the builder's CRF 20 software output.
    ((DEFAULT_BITRATE as f64 * width as f64 * height as f64 / (1920. * 1080.) * fps / 30.).round()
        as u64)
        .clamp(3_000_000, 80_000_000)
}

async fn source_bitrate(
    args: &[String],
    layout: &Layout,
    cancel: &CancellationToken,
) -> Result<u64> {
    let source = Path::new(&args[layout.inputs[0] + 1]);
    let probe = tokio::time::timeout(Duration::from_secs(3), media::probe(source, cancel)).await;
    check_cancel(cancel)?;
    let Ok(Ok(probe)) = probe else {
        return Ok(DEFAULT_BITRATE);
    };
    let Some(video) = probe.video() else {
        return Ok(DEFAULT_BITRATE);
    };
    let fps = video
        .avg_frame_rate
        .split_once('/')
        .and_then(|(n, d)| Some(n.parse::<f64>().ok()? / d.parse::<f64>().ok()?))
        .unwrap_or(30.);
    Ok(bitrate(video.width, video.height, fps))
}

/// Render composition arguments, optionally using a proven hardware H.264 encoder.
///
/// `Auto` tries the platform's encoders in order (NVENC, QSV, AMF on Windows/Linux).
/// An explicit preference tries only that backend. Unavailable hardware falls back
/// to the original args; a failed hardware render gets one software retry, after
/// removing its private staging partial. Cancellation and `-n` collisions never
/// retry. Copy, WebM, other codecs, and unrecognized layouts pass through unchanged.
/// Progress is monotonic across fallback; the existing renderer reserves 1.0 for
/// the caller's validation/commit phase. No additional trait bounds on the callback.
pub async fn render(
    args: &[String],
    duration: i64,
    cancel: &CancellationToken,
    preference: EncodingAcceleration,
    progress: impl FnMut(f64),
) -> Result<()> {
    render_with_status(args, duration, cancel, preference, progress, |_| {}).await
}

pub async fn render_with_status(
    args: &[String], duration: i64, cancel: &CancellationToken,
    preference: EncodingAcceleration, progress: impl FnMut(f64), status: impl Fn(&str),
) -> Result<()> {
    check_cancel(cancel)?;
    status("CPU 编码");
    // media::render currently accepts Fn. Mutex adapts FnMut while preserving
    // Send/Sync when the caller's closure is Send; no lock survives an await.
    let progress = Mutex::new((progress, 0_f64));
    let report = |value: f64| {
        if value.is_finite() {
            let mut state = progress.lock().unwrap();
            state.1 = state.1.max(value.clamp(0., 0.99));
            let value = state.1;
            (state.0)(value);
        }
    };
    let candidates = candidates(preference);
    let Some(layout) = layout(args).filter(|_| !candidates.is_empty()) else {
        return media::render(args, duration, cancel, report).await;
    };
    let Some(staging) = Staging::prepare(args, &layout)? else {
        return media::render(args, duration, cancel, report).await;
    };
    let binary = kdj_providers::ffmpeg::binary()?;
    let Ok(identity) = BinaryIdentity::read(&binary) else {
        return media::render(args, duration, cancel, report).await;
    };
    let Some(encoder) = working_encoder(&identity, &candidates, cancel).await? else {
        return media::render(args, duration, cancel, report).await;
    };
    let bitrate = source_bitrate(args, &layout, cancel).await?;
    // Discovery may have taken seconds. Recheck both the output and executable
    // immediately before starting; media::render resolves the executable itself.
    let current = Staging::prepare(args, &layout)?.context("合成临时目录已变化")?;
    if current.directory != staging.directory || !same_file(&current.metadata, &staging.metadata) {
        bail!("合成临时目录已变化");
    }
    check_cancel(cancel)?;
    if BinaryIdentity::read(&kdj_providers::ffmpeg::binary()?)
        .ok()
        .as_ref()
        != Some(&identity)
    {
        return media::render(args, duration, cancel, report).await;
    }
    let hardware_args = accelerated_args(args, &layout, encoder, bitrate);
    status(encoder.name());
    match media::render(&hardware_args, duration, cancel, &report).await {
        Ok(()) => check_cancel(cancel),
        Err(error) => {
            // The caller owns cleanup on cancellation. In particular, a cancelled
            // -n refusal must not be mistaken for an owned partial and removed.
            check_cancel(cancel)?;
            // A -n refusal is never evidence that this process owns that file,
            // even if somebody created it after our absence check.
            if error.to_string().contains("already exists")
                || error.to_string().contains("File exists")
            {
                return Err(error);
            }
            staging
                .remove_partial()
                .with_context(|| format!("硬件编码失败：{error}"))?;
            check_cancel(cancel)?;
            // Avoid repeatedly hitting a failed device/session on every queued
            // composition, but allow recovery. Resolution-specific failures only
            // suppress this backend briefly, not for the whole positive-cache TTL.
            if let Ok(mut cache) = cache().try_lock() {
                if cache.binary.as_ref() == Some(&identity) {
                    cache.remember(encoder, false, FAILURE_TTL);
                }
            }
            status("CPU 编码（硬件失败后回退）");
            media::render(args, duration, cancel, report)
                .await
                .with_context(|| {
                    format!(
                        "硬件编码（{}）失败后软件重试也失败：{error}",
                        encoder.name()
                    )
                })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| (*s).into()).collect()
    }

    fn args(output: &Path, input: &Path) -> Vec<String> {
        let mut args = strings(&["-nostdin", "-n", "-i"]);
        args.push(input.to_string_lossy().into_owned());
        args.extend(strings(&[
            "-filter_complex",
            "[0:v]tpad=stop_duration=1[vout]",
            "-map",
            "[vout]",
            "-c",
            "copy",
            "-c:v:0",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-threads:v:0",
            "2",
            "-pix_fmt:v:0",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
        ]));
        args.push(output.to_string_lossy().into_owned());
        args
    }

    #[test]
    fn rewrite_preserves_paths_copy_streams_and_filter_graph() {
        let args = args(Path::new("/tmp/render.mp4"), Path::new("/tmp/source.mp4"));
        let layout = layout(&args).unwrap();
        for encoder in [
            Encoder::VideoToolbox,
            Encoder::Nvidia,
            Encoder::Intel,
            Encoder::Amd,
        ] {
            let updated = accelerated_args(&args, &layout, encoder, DEFAULT_BITRATE);
            assert_eq!(updated.last(), args.last());
            assert_eq!(updated[3], args[3]);
            assert!(updated.iter().any(|s| s == "-n"));
            assert!(
                !updated
                    .iter()
                    .any(|s| matches!(s.as_str(), "-y" | "-crf" | "libx264" | "veryfast"))
            );
            for pair in [
                ["-c", "copy"],
                ["-c:a", "aac"],
                ["-b:a", "256k"],
                ["-filter_complex", "[0:v]tpad=stop_duration=1[vout]"],
            ] {
                assert!(updated.windows(2).any(|w| w == pair));
            }
            assert!(updated.windows(2).any(|w| w == ["-c:v:0", encoder.name()]));
        }
    }

    #[test]
    fn bypasses_webm_copy_other_codecs_and_ambiguous_commands() {
        for codec in ["copy", "libvpx-vp9", "libx265"] {
            let mut args = args(Path::new("/tmp/render.mp4"), Path::new("/tmp/source.mp4"));
            let i = layout(&args).unwrap().codec + 1;
            args[i] = codec.into();
            assert!(layout(&args).is_none());
        }
        let base = args(Path::new("/tmp/render.mp4"), Path::new("/tmp/source.mp4"));
        for suffix in [
            vec!["-c", "copy"],
            vec!["second.mp4"],
            vec!["-y"],
            vec!["-f", "webm"],
        ] {
            let mut args = base[..base.len() - 1].to_vec();
            args.extend(strings(&suffix));
            args.push(base.last().unwrap().clone());
            assert!(layout(&args).is_none());
        }
        assert!(
            layout(&args(
                Path::new("/tmp/render.WeBM"),
                Path::new("/tmp/source.mp4")
            ))
            .is_none()
        );
        assert!(layout(&[]).is_none());
    }

    #[test]
    fn workshop_script_layout_selects_hardware_without_weakening_output_checks() {
        let mut args = args(Path::new("/tmp/render.mp4"), Path::new("/tmp/source.mp4"));
        let graph = args.iter().position(|s| s == "-filter_complex").unwrap();
        args[graph] = "-filter_complex_script".into();
        args[graph + 1] = "/tmp/render.ffgraph".into();
        args.insert(0, "-nostats".into());
        let layout = layout(&args).expect("workshop arguments must reach hardware selection");
        let accelerated = accelerated_args(&args, &layout, Encoder::VideoToolbox, 3_000_000);
        assert!(accelerated.iter().any(|s| s == "h264_videotoolbox"));
        assert!(accelerated.iter().any(|s| s == "-filter_complex_script"));
        assert!(!accelerated.iter().any(|s| s == "libx264"));
    }

    #[test]
    fn workshop_images_gifs_and_video_seeks_reach_hardware_selection() {
        let mut args = args(Path::new("/tmp/render.mp4"), Path::new("/tmp/source.mp4"));
        args.splice(2..2, strings(&["-threads", "1", "-ss", "2.5"]));
        let graph = args.iter().position(|s| s == "-filter_complex").unwrap();
        args.splice(graph..graph, strings(&[
            "-threads", "1", "-framerate", "24", "-i", "/tmp/still.png",
            "-safe", "0", "-f", "concat", "-i", "/tmp/animation.ffconcat",
        ]));
        let layout = layout(&args).expect("image inputs must not silently force software encoding");
        assert_eq!(layout.inputs.len(), 3);
        let updated = accelerated_args(&args, &layout, Encoder::VideoToolbox, DEFAULT_BITRATE);
        for pair in [["-framerate", "24"], ["-safe", "0"], ["-ss", "2.5"], ["-c:v:0", "h264_videotoolbox"]] {
            assert!(updated.windows(2).any(|w| w == pair));
        }
        assert_eq!(updated.last(), args.last());
    }

    #[test]
    fn bitrate_tracks_pixels_and_rate_with_bounds() {
        assert_eq!(bitrate(1920, 1080, 30.), 12_000_000);
        assert_eq!(bitrate(1920, 1080, 60.), 24_000_000);
        assert_eq!(bitrate(3840, 2160, 30.), 48_000_000);
        assert_eq!(bitrate(3840, 2160, 60.), 80_000_000);
        assert_eq!(bitrate(320, 180, 30.), 3_000_000);
        assert_eq!(bitrate(0, 0, f64::NAN), DEFAULT_BITRATE);
        assert_eq!(bitrate(1920, 1080, f64::INFINITY), DEFAULT_BITRATE);
    }

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("kdj-acceleration-test-{}", rand::random::<u64>()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn setup(&self) -> (Vec<String>, PathBuf, PathBuf) {
            let source = self.0.join("source.mp4");
            std::fs::write(&source, b"original").unwrap();
            let directory = self.0.join(".kdj-composition-test-1-unique");
            std::fs::create_dir(&directory).unwrap();
            let output = directory.join("render.mp4");
            (args(&output, &source), output, source)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn cleanup_only_removes_initially_absent_staging_output() {
        let scratch = Scratch::new();
        let (args, output, source) = scratch.setup();
        let layout = layout(&args).unwrap();
        let staging = Staging::prepare(&args, &layout).unwrap().unwrap();
        staging.remove_partial().unwrap(); // Encoder can fail before opening output.
        let chapters = output.with_file_name("chapters.ffmeta");
        std::fs::write(&chapters, b"metadata").unwrap();
        std::fs::write(&output, b"partial").unwrap();
        assert!(Staging::prepare(&args, &layout).is_err());
        staging.remove_partial().unwrap();
        assert!(!output.exists());
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        assert_eq!(std::fs::read(&chapters).unwrap(), b"metadata");
    }

    #[test]
    fn arbitrary_destination_is_not_owned() {
        let scratch = Scratch::new();
        let source = scratch.0.join("source.mp4");
        std::fs::write(&source, b"original").unwrap();
        let args = args(&scratch.0.join("render.mp4"), &source);
        assert!(
            Staging::prepare(&args, &layout(&args).unwrap())
                .unwrap()
                .is_none()
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_and_hardlink_partials_and_replaced_directory() {
        let scratch = Scratch::new();
        let (args, output, source) = scratch.setup();
        let staging = Staging::prepare(&args, &layout(&args).unwrap())
            .unwrap()
            .unwrap();
        std::os::unix::fs::symlink(&source, &output).unwrap();
        assert!(staging.remove_partial().is_err());
        std::fs::remove_file(&output).unwrap();
        std::fs::hard_link(&source, &output).unwrap();
        assert!(staging.remove_partial().is_err());
        std::fs::remove_file(&output).unwrap();
        let directory = output.parent().unwrap();
        std::fs::rename(directory, directory.with_extension("old")).unwrap();
        std::fs::create_dir(directory).unwrap();
        std::fs::write(&output, b"someone else").unwrap();
        assert!(staging.remove_partial().is_err());
        assert_eq!(std::fs::read(&output).unwrap(), b"someone else");
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
    }

    #[test]
    fn cache_invalidates_when_binary_changes() {
        let scratch = Scratch::new();
        let binary = scratch.0.join("ffmpeg");
        std::fs::write(&binary, b"first").unwrap();
        let first = BinaryIdentity::read(&binary).unwrap();
        let mut cache = Cache::default();
        cache.use_binary(&first);
        cache.remember(Encoder::VideoToolbox, true, AVAILABLE_TTL);
        cache.use_binary(&first);
        assert_eq!(cache.observations.len(), 1);
        std::fs::write(&binary, b"replacement").unwrap();
        cache.use_binary(&BinaryIdentity::read(&binary).unwrap());
        assert!(cache.observations.is_empty());
    }

    #[tokio::test]
    async fn discovery_uses_cache_and_waiting_for_it_is_cancellable() {
        let scratch = Scratch::new();
        let binary = scratch.0.join("not-an-executable");
        std::fs::write(&binary, b"not executable").unwrap();
        let identity = BinaryIdentity::read(&binary).unwrap();
        let cancel = CancellationToken::new();
        {
            let mut cache = cache().lock().await;
            cache.use_binary(&identity);
            cache.remember(Encoder::Nvidia, false, UNAVAILABLE_TTL);
            cache.remember(Encoder::Intel, true, AVAILABLE_TTL);
        }
        assert_eq!(
            working_encoder(&identity, &[Encoder::Nvidia, Encoder::Intel], &cancel)
                .await
                .unwrap(),
            Some(Encoder::Intel)
        );
        let mut guard = cache().lock().await;
        let cancellation = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel.cancel();
        };
        let (result, ()) = tokio::join!(
            working_encoder(&identity, &[Encoder::Intel], &cancel),
            cancellation
        );
        assert!(result.is_err());
        guard.observations.clear();
        guard.binary = None;
    }

    #[tokio::test]
    async fn pre_cancelled_render_does_not_discover_or_touch_output() {
        let scratch = Scratch::new();
        let (args, output, _) = scratch.setup();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut progress = Vec::new();
        assert!(
            render(&args, 1000, &cancel, EncodingAcceleration::Auto, |p| {
                progress.push(p)
            })
            .await
            .is_err()
        );
        assert!(progress.is_empty());
        assert!(!output.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn encode_probe_requires_output_and_success_and_is_bounded() {
        let cancel = CancellationToken::new();
        for (script, expected) in [
            ("exit 0", false),
            ("printf packet; exit 1", false),
            ("printf packet", true),
        ] {
            assert_eq!(
                encode_probe(
                    Path::new("/bin/sh"),
                    &strings(&["-c", script]),
                    Duration::from_secs(1),
                    &cancel
                )
                .await
                .unwrap(),
                expected
            );
        }
        let start = Instant::now();
        assert!(
            !encode_probe(
                Path::new("/bin/sleep"),
                &strings(&["10"]),
                Duration::from_millis(30),
                &cancel
            )
            .await
            .unwrap()
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        let cancellation = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            cancel.cancel();
        };
        let arguments = strings(&["10"]);
        let (result, ()) = tokio::join!(
            encode_probe(
                Path::new("/bin/sleep"),
                &arguments,
                Duration::from_secs(10),
                &cancel
            ),
            cancellation
        );
        assert!(result.is_err());
    }
}
