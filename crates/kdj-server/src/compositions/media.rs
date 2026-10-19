//! Bounded, cancellable local media operations over FFmpeg/FFprobe: probing, capturing output,
//! rendering with progress and checking a render. No shell command construction.
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
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

fn ms(text: &str) -> i64 {
    text.parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .map(|v| (v * 1000.).round() as i64)
        .unwrap_or(0)
}

impl Probe {
    pub fn video(&self) -> Option<&Stream> {
        self.streams
            .iter()
            .filter(|s| s.codec_type == "video" && s.disposition.get("attached_pic") != Some(&1))
            .max_by_key(|s| {
                (
                    s.disposition.get("default").copied().unwrap_or(0),
                    std::cmp::Reverse(s.index),
                )
            })
    }
    pub fn audio(&self) -> Option<&Stream> {
        self.streams
            .iter()
            .filter(|s| s.codec_type == "audio")
            .max_by_key(|s| {
                (
                    s.disposition.get("default").copied().unwrap_or(0),
                    std::cmp::Reverse(s.index),
                )
            })
    }
    pub fn duration(&self, stream: &Stream) -> i64 {
        let direct = ms(&stream.duration);
        if direct > 0 {
            return direct;
        }
        if let Some(tag) = stream.tags.get("DURATION") {
            let parts: Vec<_> = tag.split(':').collect();
            if parts.len() == 3 {
                let duration =
                    ms(parts[0]) * 3600 + ms(parts[1]) * 60 + ms(parts[2]) - ms(&stream.start_time);
                if duration > 0 {
                    return duration;
                }
            }
        }
        ms(&self.format.duration) - (ms(&stream.start_time) - ms(&self.format.start_time)).max(0)
    }
    pub fn audio_shift(&self) -> i64 {
        self.audio().map(|s| ms(&s.start_time)).unwrap_or(0)
            - self.video().map(|s| ms(&s.start_time)).unwrap_or(0)
    }
    pub fn check(&self, video: bool) -> Result<i64> {
        let stream = if video {
            self.video().context("文件没有可用的视频流")?
        } else {
            self.audio().context("文件没有可用的音频流")?
        };
        let duration = self.duration(stream);
        if duration <= 0 {
            bail!("无法确定媒体时长");
        }
        if video
            && self
                .streams
                .iter()
                .filter(|s| {
                    s.codec_type == "video" && s.disposition.get("attached_pic") != Some(&1)
                })
                .count()
                > 1
        {
            bail!("多路画面暂不支持安全合成");
        }
        Ok(duration)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signature {
    pub size: u64,
    pub modified_ns: u128,
    pub edge_hash: u64,
}

pub fn signature(path: &Path) -> Result<Signature> {
    use std::hash::Hasher;
    let mut file = std::fs::File::open(path).context("源文件无法读取")?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        bail!("源路径不是普通文件");
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    let mut buffer = vec![0; 65536];
    let count = file.read(&mut buffer)?;
    hash.write(&buffer[..count]);
    if meta.len() > 65536 {
        file.seek(SeekFrom::End(-65536))?;
        let count = file.read(&mut buffer)?;
        hash.write(&buffer[..count]);
    }
    Ok(Signature {
        size: meta.len(),
        modified_ns: meta
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos(),
        edge_hash: hash.finish(),
    })
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

/// Side data that only describes how to interpret the picture we already
/// convert ourselves: HDR metadata, Dolby Vision configuration, ambient light
/// and the ICC profile the canvas ignores anyway. These entries cannot move a
/// pixel, so the workshop path may ignore them; anything unknown still fails
/// closed.
fn harmless_side_data(kind: &str) -> bool {
    matches!(
        kind,
        "Ambient viewing environment"
            | "Mastering display metadata"
            | "Content light level metadata"
            | "DOVI configuration record"
            | "DOVI metadata"
            | "HDR Dynamic Metadata SMPTE2094-40 (HDR10+)"
            | "SMPTE 2094-40 dynamic metadata"
            | "ICC Profile"
    )
}

/// Accept only unit, right-angle display rotations that FFmpeg autorotation
/// applies before our filters. Keep rejecting perspective, scaling and unknown
/// side data rather than silently dropping their meaning.
fn display_matrix_swaps_axes(data: &serde_json::Value) -> Result<bool> {
    let matrix = data["displaymatrix"].as_str().context("素材旋转矩阵缺失")?
        .lines().filter(|line| !line.trim().is_empty())
        .map(|line| line.split_once(':').context("素材旋转矩阵无效")
            .and_then(|(_, values)| values.split_whitespace()
                .map(|value| value.parse::<i64>().context("素材旋转矩阵无效"))
                .collect::<Result<Vec<_>>>()))
        .collect::<Result<Vec<_>>>()?.into_iter().flatten().collect::<Vec<_>>();
    anyhow::ensure!(matrix.len() == 9 && matrix[2] == 0 && matrix[5] == 0
        && matrix[6] == 0 && matrix[7] == 0 && matrix[8] == 1 << 30,
        "素材包含不支持的画面变换");
    match (matrix[0], matrix[1], matrix[3], matrix[4]) {
        (65536, 0, 0, 65536) | (-65536, 0, 0, -65536) => Ok(false),
        (0, -65536, 65536, 0) | (0, 65536, -65536, 0) => Ok(true),
        _ => bail!("素材包含不支持的画面变换"),
    }
}

fn workshop_rotation_swaps_axes(list: &[serde_json::Value]) -> Result<bool> {
    let mut swap = None;
    for data in list {
        let kind = data["side_data_type"].as_str().unwrap_or_default();
        if harmless_side_data(kind) {
            continue;
        }
        anyhow::ensure!(kind == "Display Matrix", "素材包含不支持的附加画面信息");
        anyhow::ensure!(swap.is_none(), "素材包含不支持的附加画面信息");
        swap = Some(display_matrix_swaps_axes(data)?);
    }
    Ok(swap.unwrap_or(false))
}

/// HDR pictures must reach the canvas as SDR, otherwise HLG/PQ code values
/// would be composited as if they were BT.709. `npl=190` reproduces the system
/// tone mapping these iPhone recordings were validated against.
pub(super) const HDR_TO_SDR: &str =
    "zscale=t=linear:npl=190,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

pub(super) fn workshop_hdr(stream: &Stream) -> bool {
    ["smpte2084", "arib-std-b67"].contains(&stream.color_transfer.as_str())
}

/// `zscale` and `tonemap` come from libzimg, which stripped FFmpeg builds
/// omit; report that with an actionable message instead of failing when the
/// render is already running. The successful probe is remembered because the
/// preview path asks once per eight-second chunk.
pub(super) async fn ensure_tone_mapping(cancel: &CancellationToken) -> Result<()> {
    static READY: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if READY.get().is_some() {
        return Ok(());
    }
    let binary = kdj_providers::ffmpeg::binary()?;
    let args = ["-hide_banner", "-filters"].map(str::to_owned);
    let output = capture(&binary, &args, 512 * 1024, Duration::from_secs(10), cancel).await?;
    let text = String::from_utf8_lossy(&output);
    let available: std::collections::HashSet<_> = text
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .collect();
    let missing: Vec<_> = ["zscale", "tonemap"]
        .into_iter()
        .filter(|filter| !available.contains(filter))
        .collect();
    anyhow::ensure!(
        missing.is_empty(),
        "FFmpeg 缺少 HDR 转换滤镜：{}；请在媒体工具中重新安装",
        missing.join("、")
    );
    let _ = READY.set(());
    Ok(())
}

/// Workshop proxies use square, display-oriented pixels. Normalize SAR and
/// validated autorotation. HDR and high bit depth are converted by the caller
/// with [`HDR_TO_SDR`]/[`ensure_tone_mapping`]; only transforms we cannot
/// reproduce are refused.
pub(super) fn workshop_video_size(stream: &Stream) -> Result<(u32, u32)> {
    let sar = match stream.sample_aspect_ratio.as_str() {
        "" | "N/A" | "0:1" => 1.,
        value => value.split_once(':')
            .and_then(|(n, d)| Some(n.parse::<f64>().ok()? / d.parse::<f64>().ok()?))
            .filter(|v| v.is_finite() && *v > 0.)
            .context("素材像素比例无效")?,
    };
    let width = (stream.width as f64 * sar / 2.).round() * 2.;
    let height = (stream.height as f64 / 2.).round() * 2.;
    if !(2. ..=32768.).contains(&width) || !(2. ..=32768.).contains(&height) {
        bail!("素材显示尺寸超出支持范围");
    }
    if stream.tags.get("rotate").is_some_and(|v| v != "0") {
        bail!("此视频包含旧式旋转标记，当前无法安全重编码；未修改原文件");
    }
    let swap = workshop_rotation_swaps_axes(&stream.side_data_list)?;
    Ok(if swap { (height as u32, width as u32) } else { (width as u32, height as u32) })
}

pub async fn render(
    args: &[String],
    duration: i64,
    cancel: &CancellationToken,
    progress: impl Fn(f64),
) -> Result<()> {
    let mut child = command(&kdj_providers::ffmpeg::binary()?)
        .args(args)
        .spawn()
        .context("启动合成失败")?;
    let mut stdout = BufReader::new(child.stdout.take().context("缺少进度管道")?).lines();
    let stderr = child.stderr.take().context("缺少错误管道")?;
    let work = async {
        let read = async {
            while let Some(line) = stdout.next_line().await? {
                if let Some(value) = line
                    .strip_prefix("out_time_us=")
                    .and_then(|v| v.parse::<f64>().ok())
                {
                    progress((value / (duration as f64 * 1000.)).clamp(0., 0.99));
                }
            }
            Ok::<_, std::io::Error>(())
        };
        let (read, tail) = tokio::join!(read, stderr_tail(stderr));
        read?;
        let status = child.wait().await?;
        if !status.success() {
            bail!("合成失败（{status}）：{}", String::from_utf8_lossy(&tail).trim());
        }
        Ok(())
    };
    tokio::select! {
        biased;
        _=cancel.cancelled()=> { let _=child.kill().await; bail!("合成已取消"); }
        result=tokio::time::timeout(kdj_providers::ffmpeg::FFMPEG_TIMEOUT,work)=>match result { Ok(result)=>result,Err(_)=>{let _=child.kill().await;bail!("合成超时");} }
    }
}

pub fn validate(source: &Probe, output: &Probe, duration: i64) -> Result<()> {
    let out_video = output.video().context("成品缺少视频流")?;
    let src_video = source.video().context("源文件缺少视频流")?;
    let audio = output.audio().context("成品缺少替换音轨")?;
    if output
        .streams
        .iter()
        .filter(|s| s.codec_type == "audio")
        .count()
        != 1
    {
        bail!("成品音轨数量异常");
    }
    let fps = frame_rate(src_video);
    let tolerance = (2000. / fps).ceil() as i64 + 60;
    if (output.duration(out_video) - duration).abs() > tolerance
        || (output.duration(audio) - duration).abs() > tolerance
    {
        bail!(
            "成品时长校验失败：预期 {duration} ms，视频 {} ms，音频 {} ms",
            output.duration(out_video),
            output.duration(audio)
        );
    }
    if (src_video.width, src_video.height) != (out_video.width, out_video.height) {
        bail!("成品画面尺寸与原视频不一致");
    }
    let aux = |probe: &Probe| {
        probe
            .streams
            .iter()
            .filter(|s| s.codec_type != "audio" && s.codec_type != "video")
            .map(|s| s.codec_type.clone())
            .collect::<Vec<_>>()
    };
    if aux(source) != aux(output) || source.chapters.len() != output.chapters.len() {
        bail!("成品未完整保留字幕、附件或章节");
    }
    let preserved = |tags: &BTreeMap<String, String>| {
        tags.iter()
            .filter(|(key, _)| {
                ![
                    "encoder",
                    "duration",
                    "major_brand",
                    "minor_version",
                    "compatible_brands",
                ]
                .contains(&key.to_lowercase().as_str())
            })
            .map(|(k, v)| (k.to_lowercase(), v.clone()))
            .collect::<BTreeMap<_, _>>()
    };
    let output_tags = preserved(&output.format.tags);
    if preserved(&source.format.tags)
        .iter()
        .any(|(k, v)| output_tags.get(k) != Some(v))
    {
        bail!("成品无法安全保留原视频元数据");
    }
    let video_tags = preserved(&out_video.tags);
    if preserved(&src_video.tags)
        .iter()
        .any(|(k, v)| video_tags.get(k) != Some(v))
    {
        bail!("成品无法安全保留视频流元数据");
    }
    let source_aux: Vec<_> = source
        .streams
        .iter()
        .filter(|s| s.index != src_video.index && s.codec_type != "audio")
        .collect();
    let output_aux: Vec<_> = output
        .streams
        .iter()
        .filter(|s| s.index != out_video.index && s.codec_type != "audio")
        .collect();
    if source_aux.len() != output_aux.len()
        || source_aux.iter().zip(output_aux).any(|(s, o)| {
            s.codec_type != o.codec_type
                || preserved(&s.tags)
                    .iter()
                    .any(|(k, v)| preserved(&o.tags).get(k) != Some(v))
        })
    {
        bail!("成品无法安全保留附加媒体流");
    }
    Ok(())
}

fn frame_rate(stream: &Stream) -> f64 {
    stream
        .avg_frame_rate
        .split_once('/')
        .and_then(|(n, d)| Some(n.parse::<f64>().ok()? / d.parse::<f64>().ok()?))
        .filter(|v| v.is_finite() && *v > 0.)
        .unwrap_or(25.)
}
