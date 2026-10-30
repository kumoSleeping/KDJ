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
    let _running = super::running::Running::note(child.id(), args.last().map_or("", String::as_str));
    let mut stdout = BufReader::new(child.stdout.take().context("缺少进度管道")?).lines();
    let stderr = child.stderr.take().context("缺少错误管道")?;
    let liveness = super::running::Liveness::new();
    let work = async {
        let read = async {
            let mut reached = f64::NEG_INFINITY;
            while let Some(line) = stdout.next_line().await? {
                if let Some(value) = line
                    .strip_prefix("out_time_us=")
                    .and_then(|v| v.parse::<f64>().ok())
                {
                    if value > reached {
                        reached = value;
                        liveness.moved();
                    }
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
        result=work=>result,
        // Stuck, however long it has run: a long render that keeps moving is left to finish.
        _=liveness.stalled()=>{let _=child.kill().await;bail!("合成超时：{} 分钟没有进展", super::running::STALL.as_secs()/60);}
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
