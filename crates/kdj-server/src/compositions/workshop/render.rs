//! A project's sound and picture as FFmpeg graphs: sound in cached eight-second PCM chunks,
//! the picture composed over the mixed sound into one MP4.
use super::*;
use std::{
    hash::{Hash, Hasher},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
pub const SAMPLE_RATE: u64 = 48_000;
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
/// What a render reports while it runs: how far it is (0..1 of its own part), or what it does.
pub(super) enum Step {
    Progress(f64),
    Detail(String),
}
pub(super) fn check(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        bail!("处理已取消")
    }
    Ok(())
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
pub fn frames(ms: f64) -> u64 {
    (ms * SAMPLE_RATE as f64 / 1000.).round() as u64
}
/// A pixel format with an alpha plane (FFmpeg's names: yuva420p, rgba, gbrap10le, ya8, …).
fn has_alpha(pix_fmt: &str) -> bool {
    ["yuva", "rgba", "bgra", "argb", "abgr", "gbrap", "ya8", "ya16"].iter().any(|prefix| pix_fmt.starts_with(prefix))
}
/// What a video input reads past its clip's end: a frame or two of headroom for the
/// retiming and frame-rate conversion; `trim` still cuts at the exact boundary.
const INPUT_SLACK_MS: f64 = 500.;
/// Threads of the picture graph (scaling, fades, overlays). It was one so a render never took
/// the CPU from playing; half the cores, at most four, keeps that margin and lets a project of
/// many clips render well above real time.
fn picture_threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get() / 2).clamp(1, 4)
}
pub(super) struct Scratch(pub(super) PathBuf);
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
pub(super) fn slice(c: &Clip, lo: f64, hi: f64) -> Clip {
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
            "-t".into(),
            secs(clip.source_out_ms - clip.source_in_ms + INPUT_SLACK_MS),
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
                        Some("pcm" | "mp4" | "jpg" | "png" | "json" | "afp")
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
        let mut audio = p.audio_project();
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
        let key = key(&("audio-v4-crossfades", &audible.sources, &audible.layers, lo, hi))?;
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
    /// The sound of `p` between `lo` and `hi` (ms), mixed into `stage/mix.wav` from the
    /// cached chunks of `audio_chunk`. Progress goes from 0 to 1.
    pub(super) async fn mix_file(
        &self,
        p: &CompositionProject,
        stage: &Path,
        lo: f64,
        hi: f64,
        cancel: &CancellationToken,
        report: &(dyn Fn(Step) -> Result<()> + Sync),
    ) -> Result<PathBuf> {
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
            report(Step::Progress((n - first + 1) as f64 / (last - first) as f64))?;
        }
        file.flush().await?;
        drop(file);
        Ok(audio)
    }

    /// The picture of `p` between `lo` and `hi` (ms) over the mixed sound `audio`, encoded to
    /// `output` (MP4) and checked: canvas size, a sound track and the length. Progress goes from
    /// 0 to 1: the clips are prepared up to 0.4, the encoder runs the rest.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn picture_file(
        &self,
        p: &CompositionProject,
        stage: &Path,
        audio: &Path,
        output: &Path,
        lo: f64,
        hi: f64,
        cancel: &CancellationToken,
        report: &(dyn Fn(Step) -> Result<()> + Sync),
    ) -> Result<()> {
        let duration = hi - lo;
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
        ]);
        args.push(picture_threads().to_string());
        let mut graph = vec![format!(
            "color=c=black:s={}x{}:r={}:d={},format=yuv420p[base0]",
            p.canvas.width,
            p.canvas.height,
            number(p.canvas.fps),
            secs(duration)
        )];
        let mut hdr_ready = false;
        for (n, (s, c)) in clips.iter().enumerate() {
            check(cancel)?;
            if s.image() {
                report(Step::Detail(format!("准备图片 {}/{}", n + 1, clips.len())))?;
                self.image_input(s, c, p.canvas.fps, &stage, n, &mut args, cancel).await?;
                image_graph(&mut graph, n, s, c, p, lo);
                report(Step::Progress(0.4 * (n + 1) as f64 / clips.len() as f64))?;
                continue;
            }
            report(Step::Detail(format!("准备视频 {}/{}", n + 1, clips.len())))?;
            let probe = verify_source(s, cancel).await?;
            let stream = probe.video().context("素材没有画面")?;
            let (width, height) = media::workshop_video_size(stream)?;
            let hdr = if media::workshop_hdr(stream) {
                if !hdr_ready {
                    report(Step::Detail("准备 HDR 转换".into()))?;
                    media::ensure_tone_mapping(cancel).await?;
                    hdr_ready = true;
                }
                format!(",{}", media::HDR_TO_SDR)
            } else { String::new() };
            // Decode directly into the final graph. A full-length intermediate
            // used to encode every video twice and delay all visible progress.
            // `-t` ends the input with the clip: trim alone left every input decoding to the
            // end of its file, so thirty clips of one video decoded it thirty times over.
            args.extend(["-threads".into(), "1".into(), "-ss".into(), secs(c.source_in_ms),
                "-t".into(), secs(c.source_out_ms - c.source_in_ms + INPUT_SLACK_MS),
                "-i".into(), s.path.clone()]);
            let keep_position = c.picture.crop_keep_position && !c.picture.crop_auto_fit;
            let (fit_width, fit_height) = if keep_position {
                (width as f64, height as f64)
            } else { cropped_size(width as f64, height as f64, c.picture.crop) };
            let (w, h) = fitted_picture_size(p, c, fit_width, fit_height, 2.);
            let fades = &c.fades;
            let dynamic = fades.video_in_ms > fades.offset_ms
                || (fades.video_out_ms > 0. && fades.offset_ms + c.duration() > fades.span_ms - fades.video_out_ms);
            let cropped = c.picture.crop.iter().any(|v| *v > 0.);
            // Normalize display pixels before masking, including anamorphic sources.
            // Transparent padding preserves the original frame's size and position.
            let mask = if cropped {
                format!(",scale={width}:{height},setsar=1,format=rgba{}", crop_mask(width as f64, height as f64, c.picture.crop, keep_position))
            } else { String::new() };
            let pixels = format!("[{n}:{}]trim=duration={},setpts=PTS-STARTPTS,setpts='({})/TB',fps={}:eof_action=pass{hdr}{mask},scale={}:{},setsar=1",
                stream.index, secs(c.source_out_ms-c.source_in_ms), retime(c), number(p.canvas.fps), number(w), number(h));
            let shift = format!("setpts=PTS+{}/TB[clip{n}]", secs(c.start_ms-lo));
            // A source with its own transparency (a rendered title, a keyed clip) keeps it under
            // a fade the way a cropped one keeps its mask: the fade multiplies the alpha.
            let keeps_alpha = cropped || has_alpha(&stream.pix_fmt);
            if dynamic || c.picture.opacity < 1. {
                // The envelope is spatially uniform. Evaluate it on four pixels
                // per frame, then enlarge the alpha plane; never evaluate an
                // expression for every RGB pixel of a full-resolution frame.
                if keeps_alpha {
                    graph.push(format!("{pixels},format=rgba,split[pixels{n}][sourcealpha{n}]"));
                    graph.push(format!("[sourcealpha{n}]alphaextract[originalalpha{n}]"));
                } else {
                    graph.push(format!("{pixels},format=yuv420p[pixels{n}]"));
                }
                graph.push(format!("color=white:s=2x2:r={}:d={},format=gray,geq=lum='255*{}*{}',scale={}:{}:flags=neighbor[fadealpha{n}]", number(p.canvas.fps), secs(c.duration()), number(c.picture.opacity), envelope(c,false,"T*1000"), number(w), number(h)));
                if keeps_alpha {
                    graph.push(format!("[originalalpha{n}][fadealpha{n}]blend=all_mode=multiply:shortest=1[alpha{n}]"));
                    graph.push(format!("[pixels{n}][alpha{n}]alphamerge=shortest=1,{shift}"));
                } else {
                    graph.push(format!("[pixels{n}][fadealpha{n}]alphamerge=shortest=1,{shift}"));
                }
            } else {
                graph.push(format!("{pixels},{shift}"));
            }
            // Retiming/frame-rate conversion can end one frame before the
            // declared clip boundary. Hold that frame inside the interval;
            // enable still removes it at the exact cut and preserves real gaps.
            graph.push(format!("[base{n}][clip{n}]overlay=x='{}':y='{}':eof_action=repeat:repeatlast=1:enable='gte(t,{})*lt(t,{})'[base{}]",picture_axis(c.picture.x, c.picture.crop_auto_fit, "W", "w"),picture_axis(c.picture.y, c.picture.crop_auto_fit, "H", "h"),secs(c.start_ms-lo),secs(c.start_ms-lo+c.duration()),n+1));
            report(Step::Progress(0.4 * (n + 1) as f64 / clips.len() as f64))?;
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
                    let _ = report(Step::Progress(0.4 + 0.6 * v));
                }
            },
            |encoder| { let _ = report(Step::Detail(format!("合成画面 · {encoder}"))); },
        )
        .await?;
        let probe = media::probe(&output, cancel).await?;
        let v = probe.video().context("成品没有画面")?;
        if v.width != p.canvas.width
            || v.height != p.canvas.height
            || probe.audio().is_none()
            || (probe.duration(v) as f64 - duration).abs() > 1000. / p.canvas.fps + 50.
        {
            bail!("成品尺寸、音轨或时长校验失败")
        }
        Ok(())
    }

}

impl Workshop {
    pub(super) async fn image_input(&self, s: &Source, c: &Clip, fps: f64, stage: &Path, n: usize, args: &mut Vec<String>, cancel: &CancellationToken) -> Result<()> {
        let count = if s.kind == "gif" { (c.duration()*fps/1000.).ceil() as usize } else { 1 };
        let mut list = String::from("ffconcat version 1.0\n");
        let indices: Vec<usize> = (0..count).map(|frame| kdj_providers::workshop_images::frame_index(&s.frame_ends_ms, c.animation_offset_ms + frame as f64*1000./fps)).collect();
        if s.kind == "gif" {
            check(cancel)?;
            self.gif_frames(s, &indices.iter().copied().collect(), stage, n, cancel).await?;
        }
        for index in indices {
            check(cancel)?;
            let name = format!("image-{n}-{index}.png");
            if s.kind != "gif" {
                tokio::fs::write(stage.join(&name), self.image_frame(s, index, 0).await?).await?;
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
fn cropped_size(width: f64, height: f64, crop: [f64; 4]) -> (f64, f64) {
    ((width * (1. - crop[0] - crop[2])).floor().max(1.),
     (height * (1. - crop[1] - crop[3])).floor().max(1.))
}
/// Shared source-space crop. Optional transparent padding preserves the original
/// footprint; without it the caller fits the retained rectangle instead.
fn crop_mask(width: f64, height: f64, crop: [f64; 4], keep_position: bool) -> String {
    if crop.iter().all(|v| *v == 0.) { return String::new(); }
    let (sw, sh) = cropped_size(width, height, crop);
    let x = (width * crop[0]).floor();
    let y = (height * crop[1]).floor();
    let mut filters = format!(",crop={}:{}:{}:{}:exact=1", number(sw), number(sh), number(x), number(y));
    if keep_position {
        filters.push_str(&format!(",pad={}:{}:{}:{}:color=black@0", number(width), number(height), number(x), number(y)));
    }
    filters
}
/// Match pictureBox in the frontend, including outward rounding for cover.
fn fitted_picture_size(p: &CompositionProject, c: &Clip, fw: f64, fh: f64, unit: f64) -> (f64, f64) {
    let width = p.canvas.width as f64;
    let from_height = p.canvas.height as f64 * fw / fh;
    let auto_fit = c.picture.crop_auto_fit;
    let fit = if auto_fit { width.max(from_height) } else { width.min(from_height) };
    let round = |v: f64| (if auto_fit { v.ceil() } else { v.round() }).max(1.);
    let w = round(fit * c.picture.scale / unit) * unit;
    (w, round(w * fh / fw / unit) * unit)
}
fn picture_axis(center: f64, auto_fit: bool, canvas: &str, size: &str) -> String {
    let at = format!("{canvas}*{}-{size}/2", number(center));
    if auto_fit {
        format!("max(min(0,{canvas}-{size}),min(max(0,{canvas}-{size}),{at}))")
    } else {
        format!("max(0,min({canvas}-{size},{at}))")
    }
}
fn image_graph(graph: &mut Vec<String>, n: usize, s: &Source, c: &Clip, p: &CompositionProject, lo: f64) {
    let keep_position = c.picture.crop_keep_position && !c.picture.crop_auto_fit;
    let (fw, fh) = if keep_position { (s.width as f64, s.height as f64) }
        else { cropped_size(s.width as f64, s.height as f64, c.picture.crop) };
    let (w, h) = fitted_picture_size(p, c, fw, fh, 1.);
    let angle=c.picture.rotation*std::f64::consts::PI/180.;
    // Same crop mode and fitted geometry as pictureBox; RGBA throughout.
    let mut pixels=format!("[{n}:v]setpts=PTS-STARTPTS,format=rgba{}",crop_mask(s.width as f64,s.height as f64,c.picture.crop,keep_position));
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
    graph.push(format!("[base{n}][clip{n}]overlay=x='{}':y='{}':format=yuv420:eof_action=repeat:repeatlast=1:enable='gte(t,{})*lt(t,{})'[base{}]",picture_axis(c.picture.x,c.picture.crop_auto_fit,"W","w"),picture_axis(c.picture.y,c.picture.crop_auto_fit,"H","h"),secs(c.start_ms-lo),secs(c.start_ms-lo+c.duration()),n+1));
}
