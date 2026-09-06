//! Bounded, cancellable local media operations. No shell command construction and no writes
//! to a user's destination until a separately validated staging file is committed.
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use kdj_core::composition::{
    AudioMixMode, CompositionAudio, CompositionOptions, CompositionTimeline, OverlayAudio,
};
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
fn seconds(value: i64) -> String {
    format!("{:.3}", value as f64 / 1000.)
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
    pub fn chapter_shift(&self, black_head: i64) -> i64 {
        black_head - self.video().map(|s| ms(&s.start_time)).unwrap_or(0)
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

async fn stderr_tail(mut reader: impl tokio::io::AsyncRead + Unpin) -> Vec<u8> {
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

pub(super) async fn capture(
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
    serde_json::from_slice(&data).context("读取媒体信息失败")
}

pub async fn pcm(path: &Path, stream: usize, cancel: &CancellationToken) -> Result<Vec<f32>> {
    let args = ["-v", "error", "-nostdin", "-threads", "1", "-i"]
        .map(str::to_owned)
        .into_iter()
        .chain([
            path.to_string_lossy().into_owned(),
            "-map".into(),
            format!("0:{stream}"),
        ])
        .chain(
            [
                "-t", "1800", "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1",
            ]
            .map(str::to_owned),
        )
        .collect::<Vec<_>>();
    let data = capture(
        &kdj_providers::ffmpeg::binary()?,
        &args,
        8000 * 4 * 1800 + 4096,
        Duration::from_secs(300),
        cancel,
    )
    .await?;
    Ok(data
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect())
}

/// Positive shift delays audio, negative shift trims it. Always end at the desired video span.
fn audio_chain(input: &str, shift: i64, duration: i64, output: &str) -> String {
    let mut filters = vec!["asetpts=PTS-STARTPTS".to_string()];
    if shift < 0 {
        filters.push(format!(
            "atrim=start={},asetpts=PTS-STARTPTS",
            seconds(-shift)
        ));
    }
    if shift > 0 {
        // FFmpeg 7.1 can emit untimestamped leading silence after an upstream trim.
        // Rebuild sample timestamps before atrim can discard the delayed silence.
        filters.push(format!("adelay={shift}:all=1,asetpts=N/SR/TB"));
    }
    filters.push(format!(
        "apad=whole_dur={},atrim=duration={}",
        seconds(duration),
        seconds(duration)
    ));
    format!("[{input}]{}[{output}]", filters.join(","))
}

/// Apply gain and fades to the audible part, after trimming/delay and before mixing.
fn shape_audio(input: &str, output: &str, start: i64, end: i64, opt: &CompositionAudio) -> String {
    let span = (end - start).max(0);
    let fade_in = opt.fade_in_ms.min(span / 2);
    let fade_out = opt.fade_out_ms.min(span / 2);
    let mut chain = format!("[{input}]volume={:.6}", opt.gain);
    if fade_in > 0 {
        chain.push_str(&format!(
            ",afade=t=in:st={}:d={}",
            seconds(start),
            seconds(fade_in)
        ));
    }
    if fade_out > 0 {
        chain.push_str(&format!(
            ",afade=t=out:st={}:d={}",
            seconds(end - fade_out),
            seconds(fade_out)
        ));
    }
    chain.push_str(&format!("[{output}]"));
    chain
}

pub fn chapter_metadata(probe: &Probe, shift: i64) -> String {
    fn escape(text: &str) -> String {
        text.replace('\\', "\\\\")
            .replace('=', "\\=")
            .replace(';', "\\;")
            .replace('#', "\\#")
            .replace('\n', "\\\n")
            .replace('\r', "")
    }
    let mut text = ";FFMETADATA1\n".to_string();
    for chapter in &probe.chapters {
        text.push_str(&format!(
            "[CHAPTER]\nTIMEBASE=1/1000\nSTART={}\nEND={}\n",
            ms(&chapter.start_time) + shift,
            ms(&chapter.end_time) + shift
        ));
        for (key, value) in &chapter.tags {
            text.push_str(&format!("{}={}\n", escape(key), escape(value)));
        }
    }
    text
}

pub struct Render<'a> {
    pub video_path: &'a Path,
    pub secondary_path: &'a Path,
    pub video: &'a Probe,
    pub secondary: &'a Probe,
    pub timeline: CompositionTimeline,
    pub offset: i64,
    pub options: &'a CompositionOptions,
    pub overlay: bool,
    pub output: &'a Path,
    pub chapters: Option<&'a Path>,
}

fn main_audio_chain(render: &Render<'_>, output: &str) -> String {
    if let Some(audio) = render.video.audio() {
        audio_chain(
            &format!("0:{}", audio.index),
            render.video.audio_shift() + render.timeline.video_start_ms,
            render.timeline.duration_ms,
            output,
        )
    } else {
        format!(
            "anullsrc=r=48000:cl=stereo,atrim=duration={}[{output}]",
            seconds(render.timeline.duration_ms)
        )
    }
}

pub fn render_args(render: &Render<'_>) -> Result<Vec<String>> {
    let v = render.video.video().context("缺少主视频")?;
    let a = render.secondary.audio();
    let t = render.timeline;
    if !render.options.audio.valid() || !render.options.overlay.valid() {
        bail!("合成音频或画面参数超出范围");
    }
    let secondary_duration = render.secondary.check(render.overlay)?;
    let (source_start, source_end) = render
        .options
        .segment
        .bounds(secondary_duration)
        .context("素材区间超出文件范围")?;
    let selected_start = render
        .offset
        .checked_add(source_start)
        .context("素材起点超出范围")?;
    let selected_end = render
        .offset
        .checked_add(source_end)
        .context("素材终点超出范围")?;
    let audio_options = &render.options.audio;
    let mut args = [
        "-nostdin",
        "-v",
        "warning",
        "-n",
        "-copyts",
        "-filter_complex_threads",
        "1",
        "-threads",
        "2",
        "-itsoffset",
    ]
    .map(str::to_owned)
    .to_vec();
    args.extend([
        seconds(t.black_head_ms - ms(&v.start_time)),
        "-i".into(),
        render.video_path.to_string_lossy().into_owned(),
        "-i".into(),
        render.secondary_path.to_string_lossy().into_owned(),
    ]);
    if let Some(chapters) = render.chapters {
        args.extend([
            "-f".into(),
            "ffmetadata".into(),
            "-i".into(),
            chapters.to_string_lossy().into_owned(),
        ]);
    }
    let auxiliary: Vec<_> = render
        .video
        .streams
        .iter()
        .filter(|s| s.index != v.index && s.codec_type != "audio")
        .collect();
    let auxiliary_input = if render.chapters.is_some() { 3 } else { 2 };
    if !auxiliary.is_empty() {
        // Isolate sparse copied subtitle/data packets from the decoded video's demux
        // queue. FFmpeg 7 can otherwise deadlock when encoder lookahead needs more video
        // but the same demuxer is blocked waiting for a sparse copied packet to be muxed.
        args.extend([
            "-itsoffset".into(),
            seconds(t.black_head_ms - ms(&v.start_time)),
            "-i".into(),
            render.video_path.to_string_lossy().into_owned(),
        ]);
    }
    let mut graph = Vec::new();
    let transcode = render.overlay || t.black_head_ms > 0 || t.black_tail_ms > 0;
    if transcode {
        ensure_safe_transcode(v)?;
        if render.overlay {
            ensure_safe_transcode(render.secondary.video().context("缺少叠加视频")?)?;
        }
    }
    let video_map = if render.overlay {
        let ov = render.secondary.video().context("缺少叠加视频")?;
        let start = selected_start.max(0);
        let trim = source_start + (-selected_start).max(0);
        let end = selected_end.min(t.duration_ms);
        let length = end - start;
        if length <= 0 || v.width == 0 || v.height == 0 || ov.width == 0 || ov.height == 0 {
            bail!("叠加视频没有有效画面范围");
        }
        let opt = &render.options.overlay;
        let width = ((v.width as f64 * opt.scale)
            .min(v.height as f64 * ov.width as f64 / ov.height as f64) as u32
            / 2
            * 2)
        .max(2);
        graph.push(format!("[0:{}]setpts=PTS-STARTPTS[base]", v.index));
        let mut overlay = format!(
            "[1:{}]setpts=PTS-STARTPTS,trim=start={}:duration={},setpts=PTS-STARTPTS,scale={width}:-2,format=rgba,colorchannelmixer=aa={:.4}",
            ov.index,
            seconds(trim),
            seconds(length),
            opt.opacity
        );
        let fade = opt.fade_ms.min(length / 2);
        if fade > 0 {
            overlay.push_str(&format!(
                ",fade=t=in:st=0:d={}:alpha=1,fade=t=out:st={}:d={}:alpha=1",
                seconds(fade),
                seconds(length - fade),
                seconds(fade)
            ));
        }
        overlay.push_str(&format!(",setpts=PTS+{}/TB[overlay]", seconds(start)));
        graph.push(overlay);
        graph.push(format!("[base][overlay]overlay=x='max(0,min(W-w,W*{:.5}-w/2))':y='max(0,min(H-h,H*{:.5}-h/2))':eof_action=pass:repeatlast=0:enable='between(t,{},{})'[vout]",opt.x,opt.y,seconds(start),seconds(end)));
        if opt.audio == OverlayAudio::Main {
            graph.push(main_audio_chain(render, "main_unscaled"));
            graph.push(format!(
                "[main_unscaled]volume={:.6},alimiter=limit=1:level=0:latency=1[aout]",
                audio_options.main_gain
            ));
        } else {
            let a = a.context("叠加视频没有声音，请选择主视频原声")?;
            graph.push(main_audio_chain(render, "main_audio"));
            graph.push(format!(
                "[main_audio]volume={:.6}[main_scaled]",
                audio_options.main_gain
            ));
            graph.push(if opt.audio == OverlayAudio::ReplaceSegment {
                format!(
                    "[main_scaled]volume=0:enable='gte(t,{})*lt(t,{})'[main_muted]",
                    seconds(start),
                    seconds(end)
                )
            } else {
                "[main_scaled]anull[main_muted]".into()
            });
            graph.push(audio_chain(
                &format!("1:{}", a.index),
                render.offset + render.secondary.audio_shift(),
                t.duration_ms,
                "insert_audio",
            ));
            graph.push(format!(
                "[insert_audio]volume=0:enable='not(gte(t,{})*lt(t,{}))'[insert_clipped]",
                seconds(start),
                seconds(end)
            ));
            graph.push(shape_audio(
                "insert_clipped",
                "insert_shaped",
                start,
                end,
                audio_options,
            ));
            graph.push("[main_muted][insert_shaped]amix=inputs=2:normalize=0,alimiter=limit=1:level=0:latency=1[aout]".into());
        }
        "[vout]".into()
    } else {
        let a = a.context("缺少替换音频")?;
        graph.push(format!(
            "[1:{}]asetpts=PTS-STARTPTS,atrim=start={}:end={},asetpts=PTS-STARTPTS[selected_audio]",
            a.index,
            seconds(source_start),
            seconds(source_end)
        ));
        graph.push(audio_chain(
            "selected_audio",
            t.audio_start_ms,
            t.duration_ms,
            "replacement_padded",
        ));
        graph.push(shape_audio(
            "replacement_padded",
            "replacement_shaped",
            t.audio_start_ms.max(0),
            t.duration_ms - t.silence_tail_ms,
            audio_options,
        ));
        if audio_options.mode == AudioMixMode::Mix {
            graph.push(main_audio_chain(render, "main_padded"));
            graph.push(format!(
                "[main_padded]volume={:.6}[main_scaled]",
                audio_options.main_gain
            ));
            graph.push("[main_scaled][replacement_shaped]amix=inputs=2:normalize=0,alimiter=limit=1:level=0:latency=1[aout]".into());
        } else {
            graph.push("[replacement_shaped]alimiter=limit=1:level=0:latency=1[aout]".into());
        }
        if transcode {
            // FFmpeg 7 setpts clears the link frame rate; tpad's duration options would
            // silently produce zero black frames. Restore the source rate explicitly.
            let fps = frame_rate(v);
            graph.push(format!("[0:{}]setpts=PTS-STARTPTS,fps={fps:.8},tpad=start_mode=add:stop_mode=add:color=black:start_duration={}:stop_duration={}[vout]",v.index,seconds(t.black_head_ms),seconds(t.black_tail_ms)));
            "[vout]".into()
        } else {
            format!("0:{}", v.index)
        }
    };
    args.extend([
        "-filter_complex".into(),
        graph.join(";"),
        "-map".into(),
        video_map,
        "-map".into(),
        "[aout]".into(),
    ]);
    for (index, stream) in auxiliary.into_iter().enumerate() {
        args.extend(["-map".into(), format!("{auxiliary_input}:{}", stream.index)]);
        args.extend([
            format!("-map_metadata:s:{}", index + 2),
            format!("{auxiliary_input}:s:{}", stream.index),
            format!("-disposition:{}", index + 2),
            dispositions(stream),
        ]);
    }
    args.extend([
        "-map_metadata".into(),
        "0".into(),
        "-map_metadata:s:v:0".into(),
        format!("0:s:{}", v.index),
        "-disposition:v:0".into(),
        dispositions(v),
        "-map_chapters".into(),
        if render.chapters.is_some() {
            "2".into()
        } else {
            "0".into()
        },
        "-c".into(),
        "copy".into(),
    ]);
    let webm = render
        .output
        .extension()
        .is_some_and(|s| s.eq_ignore_ascii_case("webm"));
    if transcode {
        if webm {
            args.extend(
                [
                    "-c:v:0",
                    "libvpx-vp9",
                    "-crf",
                    "24",
                    "-b:v:0",
                    "0",
                    "-cpu-used",
                    "4",
                ]
                .map(str::to_owned),
            );
        } else {
            args.extend(
                ["-c:v:0", "libx264", "-preset", "veryfast", "-crf", "20"].map(str::to_owned),
            );
        }
        args.extend(["-threads:v:0", "2", "-pix_fmt:v:0", "yuv420p"].map(str::to_owned));
    }
    args.extend([
        "-c:a".into(),
        if webm { "libopus".into() } else { "aac".into() },
        "-b:a".into(),
        "256k".into(),
        "-t".into(),
        seconds(t.duration_ms),
        "-max_interleave_delta".into(),
        "1000000".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-stats_period".into(),
        "0.25".into(),
    ]);
    if render.output.extension().is_some_and(|s| {
        ["mp4", "mov", "m4v"]
            .iter()
            .any(|ext| s.eq_ignore_ascii_case(ext))
    }) {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    args.push(render.output.to_string_lossy().into_owned());
    Ok(args)
}

pub(super) fn ensure_safe_transcode(stream: &Stream) -> Result<()> {
    if ["smpte2084", "arib-std-b67"].contains(&stream.color_transfer.as_str())
        || ["10", "12", "16"]
            .iter()
            .any(|depth| stream.pix_fmt.contains(depth))
    {
        bail!("此视频包含 HDR 或高位深画面，当前无法安全保留其色彩信息；未修改原文件");
    }
    if !stream.side_data_list.is_empty()
        || !["", "N/A", "1:1"].contains(&stream.sample_aspect_ratio.as_str())
        || stream.tags.get("rotate").is_some_and(|v| v != "0")
    {
        bail!("此视频包含旋转、特殊像素比例或附加画面信息，当前无法安全重编码；未修改原文件");
    }
    Ok(())
}

/// Workshop proxies use square pixels. Normalize SAR before reusing the stricter
/// in-place composition checks; rotation and color metadata still need preservation.
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
    let mut square = stream.clone();
    square.sample_aspect_ratio = "1:1".into();
    ensure_safe_transcode(&square)?;
    Ok((width as u32, height as u32))
}

fn dispositions(stream: &Stream) -> String {
    let flags = stream
        .disposition
        .iter()
        .filter(|(_, value)| **value == 1)
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join("+");
    if flags.is_empty() { "0".into() } else { flags }
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

pub fn validate_chapters(source: &Probe, output: &Probe, shift: i64) -> Result<()> {
    if source.chapters.len() != output.chapters.len() {
        bail!("成品章节数量已变化");
    }
    for (before, after) in source.chapters.iter().zip(&output.chapters) {
        if (ms(&after.start_time) - ms(&before.start_time) - shift).abs() > 2
            || (ms(&after.end_time) - ms(&before.end_time) - shift).abs() > 2
            || before.tags != after.tags
        {
            bail!("成品章节时间或标签未完整保留");
        }
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

/// Atomic replacement never unlinks the old destination first. On Windows an open player
/// handle without FILE_SHARE_DELETE makes ReplaceFileW fail, leaving the source untouched.
pub fn replace_file(from: &Path, to: &Path) -> Result<()> {
    #[cfg(not(windows))]
    {
        std::fs::rename(from, to).context("无法安全替换原文件")
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        if !to.exists() {
            return std::fs::rename(from, to).context("无法提交文件");
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn ReplaceFileW(
                replaced: *const u16,
                replacement: *const u16,
                backup: *const u16,
                flags: u32,
                exclude: *mut std::ffi::c_void,
                reserved: *mut std::ffi::c_void,
            ) -> i32;
        }
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        let ok = unsafe {
            ReplaceFileW(
                to.as_ptr(),
                from.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error()).context("文件被占用或无法安全替换")
        } else {
            Ok(())
        }
    }
}

pub fn unique_output(video: &Path, directory: &Path) -> Result<PathBuf> {
    let stem = video
        .file_stem()
        .context("视频文件名无效")?
        .to_string_lossy();
    let ext = video
        .extension()
        .context("视频扩展名无效")?
        .to_string_lossy();
    for index in 0..10000 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!(" ({index})")
        };
        let path = directory.join(format!("{stem} [合成]{suffix}.{ext}"));
        if !path.try_exists()? {
            return Ok(path);
        }
    }
    bail!("目标目录同名文件过多")
}
