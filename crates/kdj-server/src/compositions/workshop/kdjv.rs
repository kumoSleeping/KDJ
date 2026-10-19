//! `.kdjv`: a video that is a project (docs/kdjv.md). The file is a short JSON edit list — which
//! local files play when, from where to where, how fast, how loud, where in the picture and with
//! what fades — and sits in a library folder like any video. KDJ plays it by rendering it once,
//! with the workshop's own mix and picture (render.rs), into its cache; the render is keyed by
//! the edit and the sources' signatures, so a changed project or a changed file renders again.
//!
//! KDJ only reads these files: they are written by the listener or the AI, never rewritten here,
//! so keys this build does not know survive untouched.
use super::render::{check, key, Scratch, Step};
use super::*;

pub const EXTENSION: &str = kdj_providers::tags::PROJECT_EXTENSION;
/// The format this build reads.
const VERSION: u64 = 1;

fn one() -> f64 {
    1.
}
fn half() -> f64 {
    0.5
}
fn fps30() -> f64 {
    30.
}

#[derive(Debug, Deserialize)]
pub struct Doc {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    canvas: Option<DocCanvas>,
    #[serde(default)]
    tracks: Vec<DocTrack>,
}
#[derive(Debug, Deserialize)]
struct DocCanvas {
    width: u32,
    height: u32,
    #[serde(default = "fps30")]
    fps: f64,
}
#[derive(Debug, Deserialize)]
struct DocTrack {
    #[serde(default)]
    clips: Vec<DocClip>,
}
/// One clip; times in seconds. `at` is where it starts in the project, `in`/`out` the part of the
/// source it plays.
#[derive(Debug, Deserialize)]
struct DocClip {
    src: String,
    at: f64,
    #[serde(rename = "in", default)]
    from: f64,
    out: f64,
    #[serde(default = "one")]
    speed: f64,
    #[serde(default = "one")]
    volume: f64,
    #[serde(default)]
    muted: bool,
    #[serde(default = "half")]
    x: f64,
    #[serde(default = "half")]
    y: f64,
    #[serde(default = "one")]
    scale: f64,
    #[serde(default = "one")]
    opacity: f64,
    /// Cover the whole canvas instead of fitting inside it.
    #[serde(default)]
    fill: bool,
    #[serde(default)]
    fade_in: f64,
    #[serde(default)]
    fade_out: f64,
    #[serde(default)]
    audio_fade_in: Option<f64>,
    #[serde(default)]
    audio_fade_out: Option<f64>,
}

impl Doc {
    /// The project's length in seconds, from the clips alone (no file is opened).
    pub fn duration(&self) -> f64 {
        self.tracks
            .iter()
            .flat_map(|t| &t.clips)
            .filter(|c| c.speed > 0.)
            .map(|c| c.at + (c.out - c.from) / c.speed)
            .fold(0., f64::max)
    }
    fn sources(&self, base: &Path) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = vec![];
        for clip in self.tracks.iter().flat_map(|t| &t.clips) {
            let path = source_path(base, &clip.src);
            if !out.contains(&path) {
                out.push(path);
            }
        }
        out
    }
}

/// A source named relative to the project is found beside it.
fn source_path(base: &Path, src: &str) -> PathBuf {
    let path = Path::new(src);
    if path.is_absolute() { path.to_path_buf() } else { base.join(path) }
}

/// Reads a `.kdjv` document. Anything but this format's version is refused, not guessed at.
pub fn parse(text: &str) -> Result<Doc> {
    let value: serde_json::Value = serde_json::from_str(text).context("不是有效的 JSON")?;
    match value.get("kdjv").and_then(|v| v.as_u64()) {
        Some(VERSION) => {}
        Some(other) => bail!("工程格式版本 {other} 需要更新的 KDJ"),
        None => bail!("缺少 \"kdjv\": 1"),
    }
    let doc: Doc = serde_json::from_value(value).context("工程内容无效")?;
    if doc.tracks.iter().all(|t| t.clips.is_empty()) {
        bail!("工程里没有片段")
    }
    Ok(doc)
}

/// What KDJ knows of one source file.
#[derive(Debug, Clone)]
pub struct Probed {
    pub kind: String,
    pub frame_ends_ms: Vec<f64>,
    pub duration_ms: f64,
    pub video: bool,
    pub audio: bool,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub signature: String,
}

/// The workshop project a document describes, given what each source holds. Pure: the tests and
/// the renderer share it.
pub fn project(doc: &Doc, base: &Path, probed: &HashMap<PathBuf, Probed>) -> Result<CompositionProject> {
    let mut sources: Vec<Source> = vec![];
    for (n, path) in doc.sources(base).iter().enumerate() {
        let p = probed.get(path).with_context(|| format!("找不到素材：{}", path.display()))?;
        sources.push(Source {
            kind: p.kind.clone(),
            frame_ends_ms: p.frame_ends_ms.clone(),
            id: format!("s{n}"),
            track_id: 0,
            path: path.to_string_lossy().into_owned(),
            title: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            duration_ms: p.duration_ms,
            video: p.video,
            audio: p.audio,
            width: p.width,
            height: p.height,
            fps: p.fps,
            signature: p.signature.clone(),
        });
    }
    let source_id = |src: &str| {
        let path = source_path(base, src).to_string_lossy().into_owned();
        sources.iter().find(|s| s.path == path).map(|s| s.id.clone())
    };
    let mut layers = vec![];
    for (t, track) in doc.tracks.iter().enumerate() {
        let mut clips = vec![];
        for (n, c) in track.clips.iter().enumerate() {
            let where_ = format!("第 {} 条轨道第 {} 个片段", t + 1, n + 1);
            let sid = source_id(&c.src).with_context(|| format!("{where_}：找不到素材"))?;
            if !(c.at.is_finite() && c.at >= 0. && c.from.is_finite() && c.from >= 0. && c.out.is_finite() && c.out > c.from) {
                bail!("{where_}：at、in、out 无效（秒，out 要大于 in）")
            }
            let source = sources.iter().find(|s| s.id == sid).expect("source listed above");
            if !source.image() && c.out * 1000. > source.duration_ms + 50. {
                bail!("{where_}：out 超出素材长度 {:.3} 秒", source.duration_ms / 1000.)
            }
            let mut clip = Clip {
                video_transition: None,
                display_duration_ms: None,
                animation_offset_ms: 0.,
                id: format!("c{t}-{n}"),
                source_id: sid.clone(),
                start_ms: c.at * 1000.,
                source_in_ms: c.from * 1000.,
                source_out_ms: c.out * 1000.,
                speed: Speed {
                    preset: "constant".into(),
                    start: c.speed,
                    middle: c.speed,
                    end: c.speed,
                    domain_start_ms: c.from * 1000.,
                    domain_end_ms: c.out * 1000.,
                },
                picture: Picture {
                    x: c.x,
                    y: c.y,
                    scale: c.scale,
                    opacity: c.opacity,
                    crop_auto_fit: c.fill,
                    ..Picture::default()
                },
                sound: Sound { muted: c.muted, gain: c.volume, manual: true },
                fades: Fades::new(0., false),
            };
            if source.image() {
                // A still holds for as long as the clip asks.
                clip.display_duration_ms = Some((c.out - c.from) * 1000.);
            }
            let span = clip.duration();
            clip.fades = Fades {
                offset_ms: 0.,
                span_ms: span,
                video_in_ms: c.fade_in * 1000.,
                video_out_ms: c.fade_out * 1000.,
                audio_in_ms: c.audio_fade_in.unwrap_or(c.fade_in) * 1000.,
                audio_out_ms: c.audio_fade_out.unwrap_or(c.fade_out) * 1000.,
                linear: false,
            };
            clips.push(clip);
        }
        if let Some(first) = clips.first() {
            layers.push(Layer { grid: None, id: format!("track-{t}"), source_id: first.source_id.clone(), clips });
        }
    }
    let canvas = match &doc.canvas {
        Some(c) => Canvas { width: c.width, height: c.height, fps: c.fps, initialized: true, ..Canvas::default() },
        None => sources.iter().find(|s| s.video).map_or_else(
            || Canvas { initialized: true, ..Canvas::default() },
            |s| Canvas { width: s.width / 2 * 2, height: s.height / 2 * 2, fps: s.fps, initialized: true, ..Canvas::default() },
        ),
    };
    let p = CompositionProject {
        markers: vec![],
        id: "kdjv".into(),
        revision: 1,
        name: doc.title.clone(),
        sources,
        layers,
        canvas,
        output: Output {
            format: "mp4".into(),
            name: doc.title.clone(),
            directory: String::new(),
            in_ms: 0.,
            out_ms: None,
            quality: 20,
            acceleration: kdj_core::composition::EncodingAcceleration::Auto,
        },
        migrated_from: None,
    };
    p.validate().map_err(|e| anyhow::anyhow!(e))?;
    Ok(p)
}

pub use kdj_providers::tags::is_project_path;

/// Which render each project file plays from, as last rendered. The window asks for the render
/// (POST /api/kdjv/render) before it plays a project; the library's media routes only look here.
static RENDERED: std::sync::OnceLock<Mutex<HashMap<PathBuf, PathBuf>>> = std::sync::OnceLock::new();

fn remember(file: &Path, render: &Path) {
    let Ok(file) = std::fs::canonicalize(file) else { return };
    RENDERED.get_or_init(Default::default).lock().unwrap().insert(file, render.to_path_buf());
}

/// The render a project file last got, while it is still in the cache.
pub fn rendered(file: &Path) -> Option<PathBuf> {
    let file = std::fs::canonicalize(file).ok()?;
    RENDERED.get_or_init(Default::default).lock().unwrap().get(&file).filter(|path| path.is_file()).cloned()
}

/// What a check of a document found, for whoever wrote it.
#[derive(Debug, Serialize)]
pub struct Checked {
    pub title: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub sources: Vec<String>,
    /// Already rendered: plays at once.
    pub ready: bool,
}

impl Workshop {
    async fn probe_source(path: &Path, cancel: &CancellationToken) -> Result<Probed> {
        let path = std::fs::canonicalize(path).with_context(|| format!("素材文件不存在：{}", path.display()))?;
        if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION)) {
            bail!("工程不能套用另一个工程：{}", path.display())
        }
        let image = if kdj_providers::workshop_images::is_image_path(&path) {
            let path = path.clone();
            Some(tokio::task::spawn_blocking(move || kdj_providers::workshop_images::inspect(&path)).await??)
        } else {
            None
        };
        let probe = if image.is_none() { media::probe(&path, cancel).await? } else { media::Probe::default() };
        let video = probe.video().is_some();
        let duration_ms = match &image {
            Some(image) => image.frame_ends_ms.last().copied().unwrap_or(5000.),
            None => probe.check(video)? as f64,
        };
        let (width, height, fps) = super::shape(&probe);
        Ok(Probed {
            kind: match &image {
                Some(image) if image.frame_ends_ms.is_empty() => "image",
                Some(_) => "gif",
                None if video => "video",
                None => "audio",
            }
            .into(),
            frame_ends_ms: image.as_ref().map(|i| i.frame_ends_ms.clone()).unwrap_or_default(),
            duration_ms,
            video,
            audio: probe.audio().is_some(),
            width: image.as_ref().map_or(width, |i| i.width),
            height: image.as_ref().map_or(height, |i| i.height),
            fps: if image.is_some() { 30. } else { fps },
            signature: signature(&path)?,
        })
    }

    /// The project a `.kdjv` file describes, with every source opened and checked.
    async fn kdjv_project(&self, file: &Path, cancel: &CancellationToken) -> Result<CompositionProject> {
        let text = tokio::fs::read_to_string(file).await.with_context(|| format!("无法读取工程：{}", file.display()))?;
        let doc = parse(&text)?;
        let base = file.parent().unwrap_or(Path::new("."));
        let mut probed = HashMap::new();
        for path in doc.sources(base) {
            check(cancel)?;
            let found = Self::probe_source(&path, cancel).await?;
            probed.insert(path, found);
        }
        project(&doc, base, &probed)
    }

    fn kdjv_cache(&self, p: &CompositionProject) -> Result<(String, PathBuf)> {
        let name = format!("kdjv-{}", key(&(&p.sources, &p.layers, &p.canvas))?);
        let path = self.cache.join(format!("{name}.mp4"));
        Ok((name, path))
    }

    /// Opens a `.kdjv` file the way playing it would, without rendering: what it holds, or why
    /// it cannot play.
    pub async fn kdjv_check(&self, file: &Path) -> Result<Checked> {
        let cancel = CancellationToken::new();
        let p = self.kdjv_project(file, &cancel).await?;
        let (_, cached) = self.kdjv_cache(&p)?;
        Ok(Checked {
            title: p.name.clone(),
            duration: p.duration() / 1000.,
            width: p.canvas.width,
            height: p.canvas.height,
            fps: p.canvas.fps,
            sources: p.sources.iter().map(|s| s.path.clone()).collect(),
            ready: cached.is_file(),
        })
    }

    /// The render a `.kdjv` file plays from, made now if it is not in the cache yet. One render
    /// per project at a time; a second caller waits for the first. `progress` gets 0..1 and
    /// what is being done.
    pub async fn kdjv_render(
        &self,
        file: &Path,
        cancel: &CancellationToken,
        progress: &(dyn Fn(f64, &str) + Sync),
    ) -> Result<PathBuf> {
        progress(0., "读取工程");
        let p = self.kdjv_project(file, cancel).await?;
        let (name, cached) = self.kdjv_cache(&p)?;
        let lock = self.cache_lock(&name).await;
        let _guard = lock.lock().await;
        if cached.is_file() {
            remember(file, &cached);
            return Ok(cached);
        }
        let _slot = tokio::select! {_ = cancel.cancelled() => bail!("渲染已取消"), s = self.export_slots.acquire() => s?};
        std::fs::create_dir_all(&self.cache)?;
        let stage = self.cache.join(format!(".{name}-{}", id()));
        std::fs::create_dir(&stage)?;
        let _scratch = Scratch(stage.clone());
        let hi = p.duration();
        let report = |step: Step, lo: f64, span: f64| -> Result<()> {
            match step {
                Step::Progress(v) => progress(lo + span * v, ""),
                Step::Detail(detail) => progress(lo, &detail),
            }
            Ok(())
        };
        progress(0., "混合声音");
        let audio = self.mix_file(&p, &stage, 0., hi, cancel, &|step| report(step, 0., 0.2)).await?;
        let output = stage.join("render.mp4");
        progress(0.2, "合成画面");
        self.picture_file(&p, &stage, &audio, &output, 0., hi, cancel, &|step| report(step, 0.2, 0.8)).await?;
        std::fs::rename(&output, &cached)?;
        remember(file, &cached);
        self.trim_cache();
        progress(1., "");
        Ok(cached)
    }
}

#[cfg(test)]
mod kdjv_tests {
    use super::*;

    fn video() -> Probed {
        Probed {
            kind: "video".into(),
            frame_ends_ms: vec![],
            duration_ms: 60_000.,
            video: true,
            audio: true,
            width: 1281,
            height: 720,
            fps: 30.,
            signature: "sig".into(),
        }
    }

    #[test]
    fn a_document_becomes_the_workshop_project_it_describes() {
        let doc = parse(
            r#"{"kdjv":1,"title":"Set","tracks":[
                {"clips":[{"src":"logo.mp4","at":2,"in":0,"out":4,"opacity":0.5,"fade_in":0.5}]},
                {"clips":[{"src":"/media/a.mp4","at":0,"in":10,"out":20,"speed":2,"volume":0.8},
                          {"src":"/media/a.mp4","at":5,"in":30,"out":40}]}
            ],"generated":{"logo.mp4":{"tool":"remotion"}}}"#,
        )
        .unwrap();
        let base = Path::new("/projects");
        let probed = HashMap::from([
            (PathBuf::from("/projects/logo.mp4"), video()),
            (PathBuf::from("/media/a.mp4"), video()),
        ]);
        let p = project(&doc, base, &probed).unwrap();
        assert_eq!(p.sources.len(), 2, "one source per file, however many clips use it");
        assert_eq!(p.layers.len(), 2);
        assert_eq!(p.layers[0].clips[0].picture.opacity, 0.5, "the first track is the top one");
        let fast = &p.layers[1].clips[0];
        assert_eq!((fast.start_ms, fast.source_in_ms, fast.source_out_ms), (0., 10_000., 20_000.));
        assert_eq!(fast.duration(), 5_000., "twice as fast plays ten seconds in five");
        assert_eq!(fast.sound.gain, 0.8);
        assert_eq!(p.layers[0].clips[0].fades.video_in_ms, 500.);
        assert_eq!(p.canvas.width, 1280, "the canvas follows the first video, evened");
        assert_eq!(p.duration(), 15_000.);
        assert_eq!(doc.duration(), 15.);
    }

    #[test]
    fn what_cannot_play_is_said_instead_of_guessed() {
        assert!(parse(r#"{"tracks":[]}"#).unwrap_err().to_string().contains("kdjv"));
        assert!(parse(r#"{"kdjv":2,"tracks":[]}"#).unwrap_err().to_string().contains("更新"));
        assert!(parse(r#"{"kdjv":1,"tracks":[{"clips":[]}]}"#).is_err());
        let doc = parse(r#"{"kdjv":1,"tracks":[{"clips":[{"src":"/a.mp4","at":0,"in":0,"out":90}]}]}"#).unwrap();
        let probed = HashMap::from([(PathBuf::from("/a.mp4"), video())]);
        let error = project(&doc, Path::new("/"), &probed).unwrap_err().to_string();
        assert!(error.contains("超出素材长度"), "{error}");
    }
}
