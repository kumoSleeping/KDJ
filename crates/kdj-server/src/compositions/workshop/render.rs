use super::*;
use kdj_core::work_scheduler::{WorkClass, WorkRequest, work_scheduler};
use std::{
    hash::{Hash, Hasher},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
pub const SAMPLE_RATE: u64 = 48_000;
pub const BYTES_PER_FRAME: u64 = 4;
pub const CHUNK_MS: f64 = 8_000.;
fn number(x: f64) -> String {
    format!("{x:.9}")
}
fn secs(x: f64) -> String {
    number(x / 1000.)
}
fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}
pub(super) fn key(value: &impl Serialize) -> Result<String> {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_vec(value)?.hash(&mut h);
    Ok(format!("{:016x}", h.finish()))
}
fn check(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        bail!("处理已取消")
    }
    Ok(())
}

// A successful process exit (or an existing cache name) does not prove that an
// MP4 was finalized. Check its boxes as well as the advertised video duration.
async fn validate_proxy(path: &Path, duration: f64, cancel: &CancellationToken) -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = tokio::fs::File::open(path).await?;
    let length = file.metadata().await?.len();
    let (mut offset, mut movie, mut data) = (0u64, false, false);
    while offset < length {
        check(cancel)?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header).await?;
        let short = u32::from_be_bytes(header[..4].try_into().unwrap());
        let (size, header_size) = match short {
            0 => (length - offset, 8),
            1 => (file.read_u64().await?, 16),
            n => (u64::from(n), 8),
        };
        if size < header_size || size > length - offset {
            bail!("预览缓存未写完整")
        }
        movie |= &header[4..] == b"moov" && size > header_size;
        data |= &header[4..] == b"mdat" && size > header_size;
        offset += size;
        file.seek(std::io::SeekFrom::Start(offset)).await?;
    }
    if !movie || !data {
        bail!("预览缓存缺少画面数据")
    }
    let probe = media::probe(path, cancel).await?;
    let actual = probe.check(true)? as f64;
    if actual + 100. < duration {
        bail!("预览缓存时长不完整")
    }
    Ok(())
}

struct PreviewTemp(PathBuf);
impl Drop for PreviewTemp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("ffgraph"));
    }
}
fn wave_header(frames: u64) -> Vec<u8> {
    let size = (frames * 4) as u32;
    let mut b = Vec::with_capacity(44);
    b.extend(b"RIFF");
    b.extend((size + 36).to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(48000u32.to_le_bytes());
    b.extend(192000u32.to_le_bytes());
    b.extend(4u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend(size.to_le_bytes());
    b
}
pub fn header(p: &CompositionProject) -> Vec<u8> {
    wave_header(frames(p.duration()))
}
pub fn frames(ms: f64) -> u64 {
    (ms * SAMPLE_RATE as f64 / 1000.).round() as u64
}
pub fn wav_length(p: &CompositionProject) -> u64 {
    44 + frames(p.duration()) * BYTES_PER_FRAME
}
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// Both render paths consume these source-domain parts, including sliced speed ramps.
fn retime(c: &Clip) -> String {
    c.parts()
        .iter()
        .map(|p| {
            format!(
                "clip(PTS*TB-{},0,{})/{}",
                secs(p.source_start_ms - c.source_in_ms),
                secs(p.source_end_ms - p.source_start_ms),
                number(p.rate)
            )
        })
        .collect::<Vec<_>>()
        .join("+")
        + ""
}
fn envelope(c: &Clip, audio: bool, time: &str) -> String {
    let f = &c.fades;
    let (i, o) = if audio {
        (f.audio_in_ms, f.audio_out_ms)
    } else {
        (f.video_in_ms, f.video_out_ms)
    };
    let shape = |x: String| {
        let x = format!("clip({x},0,1)");
        if f.linear {
            x
        } else {
            format!("({x})*({x})*(3-2*({x}))")
        }
    };
    let mut parts = vec!["1".into()];
    if i > 0. {
        parts.push(shape(format!(
            "({time}+{})/{}",
            number(f.offset_ms),
            number(i)
        )))
    };
    if o > 0. {
        parts.push(shape(format!(
            "({}-({time}+{}))/{}",
            number(f.span_ms),
            number(f.offset_ms),
            number(o)
        )))
    };
    parts.join("*")
}
fn slice(c: &Clip, lo: f64, hi: f64) -> Clip {
    let mut next = c.clone();
    if c.display_duration_ms.is_some() {
        next.display_duration_ms = Some(hi - lo); next.animation_offset_ms = c.source_at(lo);
    } else {
        next.source_in_ms = c.source_at(lo); next.source_out_ms = c.source_at(hi);
    }
    next.fades.offset_ms += lo;
    next.start_ms += lo;
    next
}
async fn verify_source(s: &Source, cancel: &CancellationToken) -> Result<media::Probe> {
    check(cancel)?;
    if !s.signature.is_empty() && signature(Path::new(&s.path))? != s.signature {
        bail!("素材已变化：{}，请重新添加", s.title)
    }
    media::probe(Path::new(&s.path), cancel).await
}

fn continuous_audio(a: &Clip, b: &Clip) -> bool {
    a.id != b.id
        && a.display_duration_ms.is_none()
        && b.display_duration_ms.is_none()
        && a.source_id == b.source_id
        && (a.start_ms + a.duration() - b.start_ms).abs() < 1e-6
        && (a.source_out_ms - b.source_in_ms).abs() < 1e-6
        && a.speed == b.speed
        && a.sound.muted == b.sound.muted
        && a.sound.gain == b.sound.gain
}

/// Compile editorial splits into uninterrupted audio runs. Decoder, resampler and
/// atempo state must survive a pure split, not restart and pad each child to length.
/// This projection never changes the saved clips or their independent video edits.
fn audio_runs(clips: &[Clip]) -> Vec<Clip> {
    let mut ordered: Vec<_> = clips.iter().collect();
    ordered.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    let mut runs: Vec<Clip> = Vec::new();
    for clip in ordered {
        if let Some(previous) = runs.last_mut() {
            let a = &previous.fades;
            let b = &clip.fades;
            let no_fades = a.audio_in_ms == 0. && a.audio_out_ms == 0.
                && b.audio_in_ms == 0. && b.audio_out_ms == 0.;
            let same_envelope = no_fades || (
                a.audio_in_ms == b.audio_in_ms && a.audio_out_ms == b.audio_out_ms
                && a.linear == b.linear && a.span_ms == b.span_ms
                && (a.offset_ms + previous.duration() - b.offset_ms).abs() < 1e-6
            );
            if continuous_audio(previous, clip) && same_envelope {
                previous.source_out_ms = clip.source_out_ms;
                continue;
            }
        }
        runs.push(clip.clone());
    }
    runs
}

#[test]
fn audio_runs_preserve_real_edits() {
    let left = Clip {
        id: "left".into(), source_id: "source".into(), start_ms: 0.,
        source_in_ms: 0., source_out_ms: 1000., speed: Speed::normal(2000.),
        picture: Picture::default(),
        sound: Sound { muted: false, gain: 1., manual: false },
        fades: Fades { audio_in_ms: 200., audio_out_ms: 200., ..Fades::new(2000., false) },
        video_transition: None, display_duration_ms: None, animation_offset_ms: 0.,
    };
    let mut right = left.clone();
    right.id = "right".into();
    right.start_ms = 1000.;
    right.source_in_ms = 1000.;
    right.source_out_ms = 2000.;
    right.fades.offset_ms = 1000.;
    let inputs = [left.clone(), right.clone()];
    let runs = audio_runs(&inputs);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].source_out_ms, 2000.);
    assert_eq!(inputs, [left.clone(), right.clone()], "projection must not edit the project");
    let edits: &[fn(&mut Clip)] = &[
        |c| c.source_id = "other".into(),
        |c| c.source_in_ms += 10.,
        |c| c.start_ms += 10.,
        |c| c.start_ms -= 10.,
        |c| c.sound.gain = 0.5,
        |c| c.sound.muted = true,
        |c| c.speed.start = 1.2,
        |c| c.fades.audio_in_ms += 10.,
        |c| c.fades.audio_out_ms += 10.,
        |c| c.fades.offset_ms = 0.,
        |c| c.fades.span_ms += 10.,
        |c| c.fades.linear = true,
        |c| c.display_duration_ms = Some(1000.),
    ];
    for (i, edit) in edits.iter().enumerate() {
        let mut changed = right.clone();
        edit(&mut changed);
        assert_eq!(audio_runs(&[left.clone(), changed]).len(), 2, "real edit {i} must stay separate");
    }
    let mut left = left;
    left.fades = Fades::new(1000., false);
    right.fades = Fades::new(1000., false);
    assert_eq!(audio_runs(&[left, right]).len(), 1, "inactive envelopes have no phase to reset");
}

/// Generate a bounded audio interval with pre-roll for stretch and limiter state.
async fn audio_args(
    p: &CompositionProject,
    lo: f64,
    hi: f64,
    cancel: &CancellationToken,
) -> Result<Vec<String>> {
    let mut args = strings(&["-nostdin", "-v", "error", "-filter_complex_threads", "1"]);
    let mut graph = vec![];
    let mut inputs = vec![];
    let from = (lo - 500.).max(0.);
    let until = (hi + 100.).min(p.duration());
    let mut index = 0;
    for c in p.layers.iter().flat_map(|l| &l.clips) {
        let s = p.source(&c.source_id).context("素材不存在")?;
        if c.sound.muted || !s.audio || c.start_ms >= until || c.start_ms + c.duration() <= from {
            continue;
        }
        let clip = slice(
            c,
            (from - c.start_ms).max(0.),
            (until - c.start_ms).min(c.duration()),
        );
        let probe = verify_source(s, cancel).await?;
        let Some(a) = probe.audio() else { continue };
        let shifted = clip.source_in_ms
            - if s.video {
                probe.audio_shift() as f64
            } else {
                0.
            };
        let pad = (-shifted).max(0.);
        args.extend([
            "-ss".into(),
            secs(shifted.max(0.)),
            "-i".into(),
            s.path.clone(),
        ]);
        let parts = clip.parts();
        let first = parts.first().context("音频区间无效")?;
        let mut filters = format!("[{index}:{}]asetpts=PTS-STARTPTS", a.index);
        if pad > 0. {
            filters.push_str(&format!(",adelay={}:all=1", number(pad)));
        }
        filters.push_str(&format!(
            ",atrim=duration={},asetpts=PTS-STARTPTS",
            secs(clip.source_out_ms - clip.source_in_ms)
        ));
        if parts.len() > 1 {
            let commands = parts
                .iter()
                .skip(1)
                .map(|part| {
                    format!(
                        "{} atempo@speed{index} tempo {}",
                        secs(part.source_start_ms - clip.source_in_ms),
                        number(part.rate)
                    )
                })
                .collect::<Vec<_>>()
                .join(";");
            filters.push_str(&format!(",asendcmd=c='{commands}'"));
        }
        filters.push_str(&format!(",atempo@speed{index}={},aresample=48000,apad,atrim=end_sample={},asetpts=N/SR/TB,volume='{}*{}':eval=frame",number(first.rate),frames(clip.duration()),number(clip.sound.gain),envelope(&clip,true,"t*1000")));
        // Two milliseconds at genuine discontinuities remove DC clicks without overlapping,
        // moving, or shortening clips. A split with continuous source mapping has no new fade.
        let siblings=&p.layers.iter().find(|l|l.clips.iter().any(|other|other.id==c.id)).unwrap().clips;
        let continuous = continuous_audio;
        let samples=frames(clip.duration());let fade=96u64.min(samples/2).max(1);
        if (clip.start_ms-c.start_ms).abs()<0.01 && !siblings.iter().any(|prev|continuous(prev,c)) {
            filters.push_str(&format!(",afade=t=in:ss=0:ns={fade}"));
        }
        if (clip.start_ms+clip.duration()-c.start_ms-c.duration()).abs()<0.01 && !siblings.iter().any(|next|continuous(c,next)) {
            filters.push_str(&format!(",afade=t=out:ss={}:ns={fade}",samples.saturating_sub(fade)));
        }
        filters.push_str(&format!(",adelay={}:all=1[a{index}]",number((clip.start_ms-from).max(0.))));
        graph.push(filters);
        inputs.push(format!("[a{index}]"));
        index += 1;
    }
    if inputs.is_empty() {
        graph.push(format!(
            "anullsrc=r=48000:cl=stereo,atrim=duration={}[mixed]",
            secs(until - from)
        ));
    } else {
        graph.push(format!("{}amix=inputs={}:normalize=0:dropout_transition=0,alimiter=limit=1:level=0:latency=1[mixed]",inputs.join(""),inputs.len()));
    }
    graph.push(format!(
        "[mixed]atrim=start_sample={},asetpts=N/SR/TB,apad,atrim=end_sample={}[out]",
        frames(lo - from),
        frames(hi) - frames(lo)
    ));
    args.extend([
        "-filter_complex".into(),
        graph.join(";"),
        "-map".into(),
        "[out]".into(),
        "-ac".into(),
        "2".into(),
        "-ar".into(),
        "48000".into(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-f".into(),
        "s16le".into(),
        "pipe:1".into(),
    ]);
    Ok(args)
}
impl Workshop {
    pub(super) async fn cache_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.cache_locks.lock().unwrap();
        if locks.len() > 2048 {
            locks.retain(|_, v| Arc::strong_count(v) > 1);
        }
        locks
            .entry(key.into())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
    pub(super) fn trim_cache(&self) {
        // A filmstrip may finish dozens of frames at once; don't rescan the
        // entire cache for every JPEG or block multiple runtime workers on it.
        let Ok(mut last) = self.cache_trim_at.try_lock() else {
            return;
        };
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(10)) {
            return;
        }
        *last = Some(std::time::Instant::now());
        let Ok(entries) = std::fs::read_dir(&self.cache) else {
            return;
        };
        let mut files = entries
            .filter_map(|e| {
                let e = e.ok()?;
                let m = e.metadata().ok()?;
                if !m.is_file()
                    || !matches!(
                        e.path().extension().and_then(|s| s.to_str()),
                        Some("pcm" | "mp4" | "jpg" | "json")
                    )
                {
                    return None;
                }
                Some((e.path(), m.len(), m.modified().ok()))
            })
            .collect::<Vec<_>>();
        let mut size: u64 = files.iter().map(|(_, size, _)| size).sum();
        files.sort_by_key(|(_, _, time)| *time);
        for (path, bytes, _) in files {
            if size <= 2 * 1024 * 1024 * 1024 {
                break;
            }
            let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let busy = self
                .cache_locks
                .lock()
                .unwrap()
                .get(name)
                .is_some_and(|lock| Arc::strong_count(lock) > 1);
            if !busy && std::fs::remove_file(&path).is_ok() {
                size -= bytes;
            }
        }
    }
    pub async fn audio_chunk(
        &self,
        p: &CompositionProject,
        n: u64,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        let lo = n as f64 * CHUNK_MS;
        let hi = (lo + CHUNK_MS).min(p.duration());
        if hi <= lo {
            return Ok(vec![]);
        }
        let mut audio = p.clone();
        for layer in &mut audio.layers {
            layer.clips = audio_runs(&layer.clips);
        }
        let mut audible = audio.clone();
        audible.layers.iter_mut().for_each(|l| {
            l.grid = None; // Grid corrections do not change PCM.
            l.clips.retain(|c| {
                !c.sound.muted
                    && c.start_ms < hi + 100.
                    && c.start_ms + c.duration() > (lo - 500.).max(0.)
            });
            for c in &mut l.clips {
                c.picture = Picture::default();
                c.video_transition = None;
                c.fades.video_in_ms = 0.;
                c.fades.video_out_ms = 0.;
            }
        });
        // Geometry, names and revisions do not invalidate already prepared sound.
        let key = key(&("audio-v3-continuous-runs", &audible.sources, &audible.layers, lo, hi))?;
        let path = self.cache.join(format!("{key}.pcm"));
        let lock = self.cache_lock(&key).await;
        let _lock = lock.lock().await;
        check(cancel)?;
        if path.is_file() {
            for source in &audible.sources {
                if audible
                    .layers
                    .iter()
                    .flat_map(|l| &l.clips)
                    .any(|c| c.source_id == source.id)
                    && !source.signature.is_empty()
                    && signature(Path::new(&source.path))? != source.signature
                {
                    bail!("素材已变化：{}，请重新添加", source.title)
                }
            }
            return Ok(tokio::fs::read(&path).await?);
        }
        let _permit = tokio::select! {_=cancel.cancelled()=>bail!("预览已取消"),p=self.preview_slots.acquire()=>p?};
        let args = audio_args(&audio, lo, hi, cancel).await?;
        let expected = (frames(hi) - frames(lo)) * 4;
        let bytes = media::capture(
            &kdj_providers::ffmpeg::binary()?,
            &args,
            expected + 4096,
            Duration::from_secs(120),
            cancel,
        )
        .await?;
        if bytes.len() as u64 != expected {
            bail!("预览音频长度不符：{} / {expected}", bytes.len())
        }
        check(cancel)?;
        let temp = self.cache.join(format!("{key}.part"));
        tokio::fs::write(&temp, &bytes).await?;
        tokio::fs::rename(&temp, &path).await?;
        self.trim_cache();
        Ok(bytes)
    }
    pub async fn proxy(&self, preview: &Preview, cid: &str, part: u64) -> Result<PathBuf> {
        let visual = preview.project.video_project();
        let c = visual.clip(cid).context("片段不存在")?;
        let lo = part as f64 * CHUNK_MS;
        let hi = (lo + CHUNK_MS).min(c.duration());
        if hi <= lo {
            bail!("预览区间越界")
        }
        let c = slice(c, lo, hi);
        let s = preview.project.source(&c.source_id).context("素材不存在")?;
        let key = key(&(
            "video-v3",
            s,
            &c.speed,
            c.source_in_ms,
            c.source_out_ms,
            preview.project.canvas.fps.min(30.),
        ))?;
        let path = self.cache.join(format!("{key}.mp4"));
        let lock = self.cache_lock(&key).await;
        let _lock = lock.lock().await;
        check(&preview.cancel)?;
        if path.is_file() {
            if validate_proxy(&path, c.duration(), &preview.cancel).await.is_ok() {
                return Ok(path);
            }
            check(&preview.cancel)?;
            tokio::fs::remove_file(&path).await?;
        }
        let _permit = tokio::select! {_=preview.cancel.cancelled()=>bail!("预览已取消"),p=self.preview_slots.acquire()=>p?};
        // Unique staging names also isolate a decoder still shutting down after
        // its HTTP request was dropped from a new request for the same chunk.
        let temp = self.cache.join(format!("{key}-{}.part", id()));
        let _temp = PreviewTemp(temp.clone());
        let result = video(
            s,
            &c,
            preview.project.canvas.fps.min(30.),
            Some(640),
            &temp,
            &preview.cancel,
        )
        .await;
        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(e);
        }
        check(&preview.cancel)?;
        validate_proxy(&temp, c.duration(), &preview.cancel).await?;
        tokio::fs::rename(&temp, &path).await?;
        self.trim_cache();
        Ok(path)
    }
    pub(super) async fn render_export(
        &self,
        p: &CompositionProject,
        jid: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let _slot = tokio::select! {_=cancel.cancelled()=>bail!("导出已取消"),s=self.export_slots.acquire()=>s?};
        let work_cancel = cancel.clone();
        let _work = tokio::task::spawn_blocking(move || {
            work_scheduler()
                .acquire(WorkRequest::new(WorkClass::MediaComposition), || {
                    work_cancel.is_cancelled()
                })
                .map_err(|_| anyhow::anyhow!("导出已取消"))
        })
        .await??;
        let directory = PathBuf::from(&p.output.directory);
        if !directory.is_dir() {
            bail!("导出目录不存在")
        }
        let stage = directory.join(format!(".kdj-composition-vj-{}", id()));
        std::fs::create_dir(&stage)?;
        let _scratch = Scratch(stage.clone());
        self.job(jid, |j| {
            j.phase = "rendering".into();
            j.error.clear();
            j.detail = "混合声音".into();
        })?;
        let lo = p.output.in_ms;
        let hi = p.output.out_ms.unwrap_or(p.duration());
        let duration = hi - lo;
        let audio = stage.join("mix.wav");
        let mut file = tokio::fs::File::create(&audio).await?;
        file.write_all(&wave_header(frames(hi) - frames(lo)))
            .await?;
        let first = (lo / CHUNK_MS).floor() as u64;
        let last = (hi / CHUNK_MS).ceil() as u64;
        for n in first..last {
            check(cancel)?;
            let bytes = self.audio_chunk(p, n, cancel).await?;
            let begin = (frames(lo.max(n as f64 * CHUNK_MS)) - frames(n as f64 * CHUNK_MS)) * 4;
            let end = (frames(hi.min((n + 1) as f64 * CHUNK_MS)) - frames(n as f64 * CHUNK_MS)) * 4;
            file.write_all(&bytes[begin as usize..end as usize]).await?;
            self.job(jid, |j| {
                j.progress = 0.2 * (n - first + 1) as f64 / (last - first) as f64
            })?;
        }
        file.flush().await?;
        drop(file);
        let extension = p.output.format.as_str();
        let output = stage.join(format!("render.{extension}"));
        if extension == "mp4" {
        let visual = p.video_project();
        let mut clips = vec![];
        for layer in visual.layers.iter().rev() {
            for c in &layer.clips {
                let s = p.source(&c.source_id).context("素材不存在")?;
                if !s.visual() || c.start_ms >= hi || c.start_ms + c.duration() <= lo {
                    continue;
                }
                let clip = slice(
                    c,
                    (lo - c.start_ms).max(0.),
                    (hi - c.start_ms).min(c.duration()),
                );
                clips.push((s, clip));
            }
        }
        let mut args = strings(&[
            "-nostdin",
            "-n",
            "-v",
            "error",
            "-progress",
            "pipe:1",
            "-nostats",
            "-filter_complex_threads",
            "1",
        ]);
        let mut graph = vec![format!(
            "color=c=black:s={}x{}:r={}:d={},format=yuv420p[base0]",
            p.canvas.width,
            p.canvas.height,
            number(p.canvas.fps),
            secs(duration)
        )];
        for (n, (s, c)) in clips.iter().enumerate() {
            check(cancel)?;
            if s.image() {
                self.job(jid, |j| j.detail = format!("准备图片 {}/{}", n + 1, clips.len()))?;
                self.image_input(s, c, p.canvas.fps, &stage, n, &mut args, cancel).await?;
                image_graph(&mut graph, n, s, c, p, lo);
                self.job(jid, |j| j.progress = 0.2 + 0.3 * (n + 1) as f64 / clips.len() as f64)?;
                continue;
            }
            self.job(jid, |j| j.detail = format!("准备视频 {}/{}", n + 1, clips.len()))?;
            let probe = verify_source(s, cancel).await?;
            let stream = probe.video().context("素材没有画面")?;
            let (width, height) = media::workshop_video_size(stream)?;
            // Decode directly into the final graph. A full-length intermediate
            // used to encode every video twice and delay all visible progress.
            args.extend(["-threads".into(), "1".into(), "-ss".into(), secs(c.source_in_ms),
                "-i".into(), s.path.clone()]);
            let w = ((p.canvas.width as f64 * c.picture.scale).min(
                p.canvas.height as f64 * width as f64 / height as f64 * c.picture.scale,
            ) / 2.)
                .round()
                .max(1.)
                * 2.;
            let h = (w * height as f64 / width as f64 / 2.).round().max(1.) * 2.;
            let fades = &c.fades;
            let dynamic = fades.video_in_ms > fades.offset_ms
                || (fades.video_out_ms > 0. && fades.offset_ms + c.duration() > fades.span_ms - fades.video_out_ms);
            let pixels = format!("[{n}:{}]trim=duration={},setpts=PTS-STARTPTS,setpts='({})/TB',fps={}:eof_action=pass,scale={}:{},setsar=1",
                stream.index, secs(c.source_out_ms-c.source_in_ms), retime(c), number(p.canvas.fps), number(w), number(h));
            let shift = format!("setpts=PTS+{}/TB[clip{n}]", secs(c.start_ms-lo));
            if dynamic || c.picture.opacity < 1. {
                // The envelope is spatially uniform. Evaluate it on four pixels
                // per frame, then enlarge the alpha plane; never evaluate an
                // expression for every RGB pixel of a full-resolution frame.
                graph.push(format!("{pixels},format=yuv420p[pixels{n}]"));
                graph.push(format!("color=white:s=2x2:r={}:d={},format=gray,geq=lum='255*{}*{}',scale={}:{}:flags=neighbor[alpha{n}]", number(p.canvas.fps), secs(c.duration()), number(c.picture.opacity), envelope(c,false,"T*1000"), number(w), number(h)));
                graph.push(format!("[pixels{n}][alpha{n}]alphamerge=shortest=1,{shift}"));
            } else {
                graph.push(format!("{pixels},{shift}"));
            }
            // Retiming/frame-rate conversion can end one frame before the
            // declared clip boundary. Hold that frame inside the interval;
            // enable still removes it at the exact cut and preserves real gaps.
            graph.push(format!("[base{n}][clip{n}]overlay=x='max(0,min(W-w,W*{}-w/2))':y='max(0,min(H-h,H*{}-h/2))':eof_action=repeat:repeatlast=1:enable='gte(t,{})*lt(t,{})'[base{}]",number(c.picture.x),number(c.picture.y),secs(c.start_ms-lo),secs(c.start_ms-lo+c.duration()),n+1));
            self.job(jid, |j| {
                j.progress = 0.2 + 0.3 * (n + 1) as f64 / clips.len() as f64
            })?;
        }
        args.extend(["-i".into(), audio.to_string_lossy().into_owned()]);
        let graphfile = stage.join("render.ffgraph");
        tokio::fs::write(&graphfile, graph.join(";")).await?;

        args.extend([
            "-filter_complex_script".into(),
            graphfile.to_string_lossy().into_owned(),
            "-map".into(),
            format!("[base{}]", clips.len()),
            "-map".into(),
            format!("{}:a", clips.len()),
            "-c:v:0".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            p.output.quality.to_string(),
            "-threads:v:0".into(),
            "2".into(),
            "-pix_fmt:v:0".into(),
            "yuv420p".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "256k".into(),
            "-t".into(),
            secs(duration),
            "-movflags".into(),
            "+faststart".into(),
            output.to_string_lossy().into_owned(),
        ]);
        let last_progress = Mutex::new(0u32);
        super::super::acceleration::render_with_status(
            &args,
            duration.round() as i64,
            cancel,
            p.output.acceleration,
            |v| {
                let progress = (v * 1000.) as u32;
                let mut last = last_progress.lock().unwrap();
                if progress > *last {
                    *last = progress;
                    let _ = self.job(jid, |j| j.progress = 0.5 + v * 0.45);
                }
            },
            |encoder| { let _ = self.job(jid, |j| j.detail = format!("合成画面 · {encoder}")); },
        )
        .await?;
        self.job(jid, |j| {
            j.phase = "validating".into();
            j.progress = 0.96;
        })?;
        let probe = media::probe(&output, cancel).await?;
        let v = probe.video().context("成品没有画面")?;
        if v.width != p.canvas.width
            || v.height != p.canvas.height
            || probe.audio().is_none()
            || (probe.duration(v) as f64 - duration).abs() > 1000. / p.canvas.fps + 50.
        {
            bail!("成品尺寸、音轨或时长校验失败")
        }
        } else {
            self.job(jid, |j| { j.detail = "编码音频".into(); j.progress = 0.5; })?;
            if extension == "wav" {
                tokio::fs::rename(&audio, &output).await?;
            } else {
                let mut args = strings(&["-v", "error", "-nostdin", "-y", "-i"]);
                args.push(audio.to_string_lossy().into_owned());
                args.extend(strings(&["-vn", "-c:a"]));
                args.push(if extension == "flac" { "flac" } else { "libmp3lame" }.into());
                if extension == "mp3" { args.extend(strings(&["-b:a", "320k"])); }
                args.push(output.to_string_lossy().into_owned());
                media::capture(&kdj_providers::ffmpeg::binary()?, &args, 4096, Duration::from_secs(3600), cancel).await?;
            }
            self.job(jid, |j| { j.phase = "validating".into(); j.progress = 0.96; })?;
            let probe = media::probe(&output, cancel).await?;
            let stream = probe.audio().context("成品没有音轨")?;
            if probe.video().is_some() || (probe.duration(stream) as f64 - duration).abs() > 100. {
                bail!("音频成品时长或格式校验失败");
            }
            let args = vec!["-v".into(), "error".into(), "-xerror".into(), "-i".into(), output.to_string_lossy().into_owned(), "-f".into(), "null".into(), "-".into()];
            media::capture(&kdj_providers::ffmpeg::binary()?, &args, 4096, Duration::from_secs(3600), cancel).await?;
        }
        for source in p.sources.iter().filter(|s| {
            p.layers
                .iter()
                .any(|l| l.source_id == s.id && !l.clips.is_empty())
        }) {
            if !source.signature.is_empty()
                && signature(Path::new(&source.path))? != source.signature
            {
                bail!("素材在导出期间发生变化：{}", source.title)
            }
        }
        let sig = media::signature(&output)?;
        let name = p.output.name.trim();
        if name.is_empty() || name.contains(['/', '\\', '\0']) || name == "." || name == ".." {
            bail!("导出文件名无效")
        }
        let stem = [".mp4", ".wav", ".flac", ".mp3"].iter().find_map(|ext| name.strip_suffix(ext)).unwrap_or(name);
        let mut destination = None;
        for n in 0..10_000 {
            check(cancel)?;
            let path = directory.join(if n == 0 {
                format!("{stem}.{extension}")
            } else {
                format!("{stem} ({n}).{extension}")
            });
            if path.exists() {
                continue;
            }
            self.job(jid, |j| {
                j.phase = "committing".into();
                j.path = path.to_string_lossy().into_owned();
                j.signature = Some(sig.clone());
            })?;
            match std::fs::hard_link(&output, &path) {
                Ok(()) => {
                    destination = Some(path);
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    self.job(jid, |j| {
                        j.signature = None;
                        j.path.clear();
                    })?;
                    continue;
                }
                Err(e) => {
                    self.job(jid, |j| {
                        j.signature = None;
                        j.path.clear();
                    })?;
                    return Err(e.into());
                }
            }
        }
        let destination = destination.context("无法创建不重名的成品")?;
        #[cfg(unix)]
        std::fs::File::open(&directory)?.sync_all()?;
        // After publication cancellation cannot turn a committed export into a second render.
        self.job(jid, |j| {
            j.phase = "importing".into();
            j.progress = 0.99;
        })?;
        let tid = self.import(&destination).await?;
        self.job(jid, |j| {
            j.phase = "complete".into();
            j.progress = 1.;
            j.track_id = Some(tid);
            j.error.clear();
        })?;
        self.state.hub.publish(
            "composition.completed",
            &serde_json::json!({"track_id":tid,"path":destination,"replaced":false}),
        );
        Ok(())
    }
}
async fn video(
    s: &Source,
    c: &Clip,
    fps: f64,
    max_width: Option<u32>,
    out: &Path,
    cancel: &CancellationToken,
) -> Result<(u32, u32)> {
    let probe = verify_source(s, cancel).await?;
    let stream = probe.video().context("素材没有画面")?;
    let (width, height) = media::workshop_video_size(stream)?;
    let mut args = strings(&[
        "-nostdin",
        "-n",
        "-v",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-filter_complex_threads",
        "1",
        "-threads",
        "1",
        "-ss",
    ]);
    args.push(secs(c.source_in_ms));
    args.extend(["-i".into(), s.path.clone()]);
    let mut filters = format!(
        "[0:{}]trim=duration={},setpts=PTS-STARTPTS,setpts='({})/TB',fps={}:eof_action=pass",
        stream.index,
        secs(c.source_out_ms - c.source_in_ms),
        retime(c),
        number(fps)
    );
    filters.push_str(&format!(",scale={width}:{height},setsar=1"));
    if let Some(max) = max_width {
        filters.push_str(&format!(",scale=w='min({max},iw)':h='min({max},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"));
    }
    filters.push_str(",setsar=1[v]");
    // A script avoids OS argument limits for long speed curves.
    let script = out.with_extension("ffgraph");
    tokio::fs::write(&script, &filters).await?;
    args.extend([
        "-filter_complex_script".into(),
        script.to_string_lossy().into_owned(),
        "-map".into(),
        "[v]".into(),
        "-an".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "ultrafast".into(),
        "-crf".into(),
        if max_width.is_some() { "24" } else { "16" }.into(),
        "-threads:v".into(),
        "2".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-t".into(),
        secs(c.duration()),
        "-movflags".into(),
        "+faststart".into(),
        "-f".into(),
        "mp4".into(),
        out.to_string_lossy().into_owned(),
    ]);
    let result = media::render(&args, c.duration().round() as i64, cancel, |_| {}).await;
    let _ = tokio::fs::remove_file(script).await;
    result.map(|()| (width, height))
}
pub(super) async fn alignment_pcm(
    p: &CompositionProject,
    c: &Clip,
    cancel: &CancellationToken,
) -> Result<Vec<f32>> {
    if c.duration() > 30. * 60. * 1000. {
        bail!("超过 30 分钟的片段请手动定位")
    }
    let mut p = p.clone();
    let mut c = c.clone();
    c.start_ms = 0.;
    c.sound.muted = false;
    c.sound.gain = 1.;
    c.fades.audio_in_ms = 0.;
    c.fades.audio_out_ms = 0.;
    p.layers = vec![Layer {
        grid: None,
        id: id(),
        source_id: c.source_id.clone(),
        clips: vec![c.clone()],
    }];
    let mut args = audio_args(&p, 0., c.duration(), cancel).await?;
    let index = args
        .iter()
        .rposition(|s| s == "48000")
        .context("缺少采样率")?;
    args[index] = "8000".into();
    let index = args.iter().rposition(|s| s == "2").context("缺少通道")?;
    args[index] = "1".into();
    let bytes = media::capture(
        &kdj_providers::ffmpeg::binary()?,
        &args,
        32 * 1024 * 1024,
        Duration::from_secs(120),
        cancel,
    )
    .await?;
    Ok(bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.)
        .collect())
}

impl Workshop {
    async fn image_input(&self, s: &Source, c: &Clip, fps: f64, stage: &Path, n: usize, args: &mut Vec<String>, cancel: &CancellationToken) -> Result<()> {
        let mut copied = std::collections::HashSet::new();
        let count = if s.kind == "gif" { (c.duration()*fps/1000.).ceil() as usize } else { 1 };
        let mut list = String::from("ffconcat version 1.0\n");
        for frame in 0..count {
            check(cancel)?;
            let index = kdj_providers::workshop_images::frame_index(&s.frame_ends_ms, c.animation_offset_ms + frame as f64*1000./fps);
            let name = format!("image-{n}-{index}.png");
            if copied.insert(index) {
                let path = self.image_frame(s, index, 0).await?;
                tokio::fs::copy(path, stage.join(&name)).await?;
            }
            if s.kind == "gif" {
                list.push_str(&format!("file '{name}'\noption framerate {}\nduration {}\n",number(fps),number(1./fps)));
            } else {
                // Decode a still once. Repeat the transformed frame in the graph
                // only for this clip's lifetime, not the entire project.
                args.extend(["-threads".into(),"1".into(),"-framerate".into(),number(fps),"-i".into(),stage.join(name).to_string_lossy().into_owned()]);
            }
        }
        if s.kind == "gif" {
            let path=stage.join(format!("image-{n}.ffconcat"));
            tokio::fs::write(&path,list).await?;
            args.extend(["-safe".into(),"0".into(),"-f".into(),"concat".into(),"-i".into(),path.to_string_lossy().into_owned()]);
        }
        Ok(())
    }
}
fn image_graph(graph: &mut Vec<String>, n: usize, s: &Source, c: &Clip, p: &CompositionProject, lo: f64) {
    let [left,top,right,bottom]=c.picture.crop;
    let sw=(s.width as f64*(1.-left-right)).floor().max(1.);
    let sh=(s.height as f64*(1.-top-bottom)).floor().max(1.);
    let w=(p.canvas.width as f64).min(p.canvas.height as f64*sw/sh)*c.picture.scale;
    let w=w.round().max(1.); let h=(w*sh/sw).round().max(1.);
    let angle=c.picture.rotation*std::f64::consts::PI/180.;
    // Identical integer crop and fitted size to pictureBox; RGBA throughout.
    let mut pixels=format!("[{n}:v]setpts=PTS-STARTPTS,format=rgba,crop={}:{}:{}:{}:exact=1",number(sw),number(sh),number((s.width as f64*left).floor()),number((s.height as f64*top).floor()));
    if c.picture.flip_x {pixels.push_str(",hflip");}
    if c.picture.flip_y {pixels.push_str(",vflip");}
    pixels.push_str(&format!(",scale={}:{}",number(w),number(h)));
    let rw=(w*angle.cos().abs()+h*angle.sin().abs()-1e-9).ceil().max(1.);
    let rh=(w*angle.sin().abs()+h*angle.cos().abs()-1e-9).ceil().max(1.);
    if c.picture.rotation != 0. {pixels.push_str(&format!(",rotate={}:ow={}:oh={}:c=none",number(angle),number(rw),number(rh)));}
    if s.kind != "gif" {
        let repeats = (c.duration() * p.canvas.fps / 1000.).ceil().max(1.) as u64 - 1;
        // Geometry filters can clear a still's frame duration. Assign timestamps
        // explicitly so a one-frame loop cannot keep emitting PTS=0 forever.
        pixels.push_str(&format!(",loop=loop={repeats}:size=1:start=0,setpts=N/{}/TB", number(p.canvas.fps)));
    }
    // Bound both split branches before alpha processing. An infinite color
    // branch kept pulling frames after the finite fade branch reached EOF,
    // buffering the unused alpha frames until the process ran out of memory.
    pixels.push_str(&format!(",trim=duration={},setpts=PTS-STARTPTS", secs(c.duration())));
    let shift=format!("setpts=PTS+{}/TB[clip{n}]",secs(c.start_ms-lo));
    if c.picture.opacity < 1. || c.fades.video_in_ms > 0. || c.fades.video_out_ms > 0. {
        graph.push(format!("{pixels},split[color{n}][sourcealpha{n}]"));
        graph.push(format!("[sourcealpha{n}]alphaextract[originalalpha{n}]"));
        graph.push(format!("color=white:s=2x2:r={}:d={},format=gray,geq=lum='255*{}*{}',scale={}:{}:flags=neighbor[fadealpha{n}]",number(p.canvas.fps),secs(c.duration()),number(c.picture.opacity),envelope(c,false,"T*1000"),number(rw),number(rh)));
        graph.push(format!("[originalalpha{n}][fadealpha{n}]blend=all_mode=multiply:shortest=1[alpha{n}]"));
        graph.push(format!("[color{n}][alpha{n}]alphamerge=shortest=1,{shift}"));
    } else {graph.push(format!("{pixels},{shift}"));}
    graph.push(format!("[base{n}][clip{n}]overlay=x='max(0,min(W-w,W*{}-w/2))':y='max(0,min(H-h,H*{}-h/2))':format=yuv420:eof_action=repeat:repeatlast=1:enable='gte(t,{})*lt(t,{})'[base{}]",number(c.picture.x),number(c.picture.y),secs(c.start_ms-lo),secs(c.start_ms-lo+c.duration()),n+1));
}
