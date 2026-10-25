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
/// The formats this build reads: 1, tracks of timed clips; 2, the editor's lanes (`Lanes`); 3,
/// the editor's free tracks (`Tracks`, tracks.rs), the one the editor writes.
const VERSION: u64 = 1;
const LANES: u64 = 2;
const TRACKS: u64 = super::tracks::FORMAT;

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
    /// Fractions of the picture taken off: left, top, right, bottom. What is left is fitted or filled.
    #[serde(default)]
    crop: [f64; 4],
    #[serde(default)]
    fade_in: f64,
    #[serde(default)]
    fade_out: f64,
    #[serde(default)]
    audio_fade_in: Option<f64>,
    #[serde(default)]
    audio_fade_out: Option<f64>,
    /// How a message names the clip: a lane document's own place for it (`main[2]`).
    #[serde(skip)]
    name: Option<String>,
    /// A lane's branch fades over its whole length, not only half of it.
    #[serde(skip)]
    whole_fade: bool,
}

impl DocClip {
    fn new(src: &str, at: f64, from: f64, out: f64) -> Self {
        DocClip {
            src: src.to_string(), at, from, out, speed: 1., volume: 1., muted: false, x: 0.5, y: 0.5, scale: 1.,
            opacity: 1., fill: false, crop: [0.; 4], fade_in: 0., fade_out: 0., audio_fade_in: None, audio_fade_out: None,
            name: None, whole_fade: false,
        }
    }
}

/// `.kdjv` 2: the editor's lanes (docs/kdjv.md). A main lane of clips laid end to end like a
/// railway, gaps of black among them, and branches up onto the lane above it: the end of a clip
/// running on over the start of the next ("out"), or the start of one coming in early over the
/// end of the one before ("in"), fading by default. In VJ mode a song is the base and sets the
/// length. It is read into the tracks of format 1 — branches on top, the main lane, the song —
/// so playing, checking, mixing and rendering are those of any project.
#[derive(Debug, Deserialize)]
struct Lanes {
    #[serde(default)]
    title: String,
    #[serde(default)]
    canvas: Option<DocCanvas>,
    #[serde(default)]
    song: Option<LaneSong>,
    /// Several songs one after another (a project of one song writes `song`).
    #[serde(default)]
    songs: Vec<LaneSong>,
    #[serde(default)]
    main: Vec<LaneItem>,
    #[serde(default)]
    branches: Vec<Branch>,
    /// Titles (字幕): each its text drawn as a picture, over everything from `at` for `length`.
    #[serde(default)]
    titles: Vec<LaneTitle>,
}
#[derive(Debug, Deserialize)]
struct LaneTitle {
    src: String,
    at: f64,
    length: f64,
}
#[derive(Debug, Deserialize)]
struct LaneSong {
    src: String,
    #[serde(rename = "in", default)]
    from: f64,
    out: f64,
    #[serde(default = "one")]
    volume: f64,
}
/// One stretch of the main lane: a clip, or `{"gap": seconds}` of black.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum LaneItem {
    Gap { gap: f64 },
    Clip(LaneClip),
}
#[derive(Debug, Deserialize)]
struct LaneClip {
    #[serde(default)]
    id: String,
    src: String,
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
    #[serde(default)]
    fill: bool,
    #[serde(default)]
    crop: [f64; 4],
}
#[derive(Debug, Deserialize)]
struct Branch {
    /// The id of the main lane's clip that branches.
    clip: String,
    /// `out`: its end runs on over the next; `in`: its start comes in early over the one before.
    side: String,
    /// Seconds of the project the branch lasts.
    length: f64,
    #[serde(default = "one")]
    opacity: f64,
    /// Fade over the branch (the default), or cover at a steady opacity.
    #[serde(default = "yes")]
    fade: bool,
}
fn yes() -> bool {
    true
}

impl Lanes {
    fn doc(self) -> Result<Doc> {
        let mut main = vec![];
        let mut placed: HashMap<String, usize> = HashMap::new();
        let mut at = 0.;
        for (n, item) in self.main.iter().enumerate() {
            match item {
                LaneItem::Gap { gap } => {
                    if !(gap.is_finite() && *gap > 0.) {
                        bail!("main[{n}]：gap 是 {gap}，要大于 0 秒")
                    }
                    at += gap;
                }
                LaneItem::Clip(c) => {
                    if !(c.speed.is_finite() && c.speed > 0.) {
                        bail!("main[{n}]：speed 是 {}，要在 0.5–2 之间", c.speed)
                    }
                    if !c.id.is_empty() && placed.insert(c.id.clone(), main.len()).is_some() {
                        bail!("main[{n}]：id「{}」和前面的片段重复", c.id)
                    }
                    let mut clip = DocClip::new(&c.src, at, c.from, c.out);
                    clip.speed = c.speed;
                    clip.volume = c.volume;
                    clip.muted = c.muted;
                    (clip.x, clip.y, clip.scale, clip.opacity, clip.fill, clip.crop) = (c.x, c.y, c.scale, c.opacity, c.fill, c.crop);
                    clip.name = Some(format!("main[{n}]（主线第 {} 段，{}）", n + 1, file_name(&c.src)));
                    at += (c.out - c.from) / c.speed;
                    main.push(clip);
                }
            }
        }
        let mut aux: Vec<DocClip> = vec![];
        for (j, b) in self.branches.iter().enumerate() {
            let where_ = format!("branches[{j}]（{} 的{}分叉）", b.clip, if b.side == "in" { "入" } else { "出" });
            let Some(&n) = placed.get(&b.clip) else { bail!("{where_}：主线上没有 id 为「{}」的片段", b.clip) };
            if !(b.length.is_finite() && b.length > 0. && b.length <= 30.) {
                bail!("{where_}：length 是 {}，要在 0–30 秒之间", b.length)
            }
            let c = &main[n];
            let span = b.length * c.speed;
            let mut clip = match b.side.as_str() {
                "out" => DocClip::new(&c.src, c.at + (c.out - c.from) / c.speed, c.out, c.out + span),
                "in" => {
                    if c.from < span - 1e-6 {
                        bail!("{where_}：这一段从素材第 {:.3} 秒开始，前面不够 {:.3} 秒素材提前进来", c.from, span)
                    }
                    DocClip::new(&c.src, c.at - b.length, c.from - span, c.from)
                }
                other => bail!("{where_}：side 是「{other}」，要是 out 或 in"),
            };
            if clip.at < -1e-6 {
                bail!("{where_}：提前进来的 {:.3} 秒落在成片开头之前", b.length)
            }
            clip.at = clip.at.max(0.);
            clip.speed = c.speed;
            clip.volume = c.volume;
            // The branch is picture over the seam; the sound stays the main lane's.
            clip.muted = true;
            (clip.x, clip.y, clip.scale, clip.fill, clip.crop) = (c.x, c.y, c.scale, c.fill, c.crop);
            clip.opacity = b.opacity;
            if b.fade {
                if b.side == "in" { clip.fade_in = b.length } else { clip.fade_out = b.length }
                clip.whole_fade = true;
            }
            clip.name = Some(where_.clone());
            if let Some(other) = aux.iter().find(|o| o.at < clip.at + b.length - 1e-6 && clip.at < o.at + (o.out - o.from) / o.speed - 1e-6) {
                bail!("{where_}：和 {} 在辅线上重叠", other.name.clone().unwrap_or_default())
            }
            aux.push(clip);
        }
        aux.sort_by(|a, b| a.at.total_cmp(&b.at));
        let mut tracks = vec![];
        if !self.titles.is_empty() {
            // The titles over everything else.
            let mut clips = vec![];
            for (n, t) in self.titles.iter().enumerate() {
                if !(t.at >= 0. && t.length > 0.) {
                    bail!("titles[{n}]：at 要 ≥ 0，length 要 > 0")
                }
                let mut clip = DocClip::new(&t.src, t.at, 0., t.length);
                clip.muted = true;
                clip.name = Some(format!("titles[{n}]（字幕）"));
                clips.push(clip);
            }
            clips.sort_by(|a, b| a.at.total_cmp(&b.at));
            tracks.push(DocTrack { clips });
        }
        tracks.extend([DocTrack { clips: aux }, DocTrack { clips: main }]);
        let songs: Vec<&LaneSong> = if self.songs.is_empty() { self.song.iter().collect() } else { self.songs.iter().collect() };
        if !songs.is_empty() {
            // The songs one after another on one track: together they are the VJ's length.
            let mut clips = vec![];
            let mut end = 0.;
            for (n, song) in songs.iter().enumerate() {
                if !(song.out - song.from > 0.) {
                    bail!("songs[{n}]（{}）：out 要大于 in", file_name(&song.src))
                }
                let mut clip = DocClip::new(&song.src, end, song.from, song.out);
                clip.volume = song.volume;
                // A song is heard, never seen: a video put in the sound lane gives only its sound.
                clip.opacity = 0.;
                clip.name = Some(format!("song（{}）", file_name(&song.src)));
                end += song.out - song.from;
                clips.push(clip);
            }
            if at > end + 0.05 {
                bail!("主线长 {at:.3} 秒，比歌（{end:.3} 秒）长：VJ 的长度由歌决定")
            }
            tracks.push(DocTrack { clips });
        }
        Ok(Doc { title: self.title, canvas: self.canvas, tracks })
    }
}

/// `.kdjv` 3: the editor's free tracks (tracks.rs). Read into format 1's tracks: the titles on
/// top, then each track in its order. A sound track is heard and not seen (a video there gives its
/// sound alone); a hidden picture track is not seen, a muted track not heard. A clip's fades may
/// last its whole length: a fade over the overlap of two tracks is a crossfade.
#[derive(Debug, Deserialize)]
struct Tracks {
    #[serde(default)]
    title: String,
    #[serde(default)]
    canvas: Option<DocCanvas>,
    #[serde(default)]
    tracks: Vec<FreeTrack>,
    #[serde(default)]
    titles: Vec<LaneTitle>,
}
#[derive(Debug, Deserialize)]
struct FreeTrack {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    muted: bool,
    #[serde(default)]
    clips: Vec<DocClip>,
}

impl Tracks {
    fn doc(self) -> Result<Doc> {
        let mut tracks = vec![];
        if !self.titles.is_empty() {
            let mut clips = vec![];
            for (n, t) in self.titles.iter().enumerate() {
                if !(t.at >= 0. && t.length > 0.) {
                    bail!("titles[{n}]：at 要 ≥ 0，length 要 > 0")
                }
                let mut clip = DocClip::new(&t.src, t.at, 0., t.length);
                clip.muted = true;
                clip.name = Some(format!("titles[{n}]（字幕）"));
                clips.push(clip);
            }
            clips.sort_by(|a, b| a.at.total_cmp(&b.at));
            tracks.push(DocTrack { clips });
        }
        let (mut pictures, mut sounds) = (0, 0);
        for track in self.tracks {
            let sound = track.kind == "sound";
            let (word, n) = if sound { sounds += 1; ("声音", sounds) } else { pictures += 1; ("画面", pictures) };
            let mut clips = vec![];
            for (k, mut clip) in track.clips.into_iter().enumerate() {
                if sound || track.hidden {
                    clip.opacity = 0.;
                }
                if track.muted {
                    clip.muted = true;
                }
                clip.whole_fade = true;
                clip.name = Some(format!("{word}轨 {n} 第 {} 段（{}）", k + 1, file_name(&clip.src)));
                clips.push(clip);
            }
            tracks.push(DocTrack { clips });
        }
        Ok(Doc { title: self.title, canvas: self.canvas, tracks })
    }
}

fn file_name(src: &str) -> String {
    Path::new(src).file_name().map_or(src.to_string(), |f| f.to_string_lossy().into_owned())
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
    /// The frame a library row shows for the project: the video playing a third of the way in
    /// (the opening is often a fade from black), else the first video clip; its file and the
    /// second in it. None when no clip is a video.
    fn cover_frame(&self, base: &Path) -> Option<(PathBuf, f64)> {
        let video = |c: &&DocClip| {
            let ext = Path::new(&c.src).extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
            kdj_providers::tags::VIDEO_EXTENSIONS.contains(&ext.as_str()) && c.speed > 0.
        };
        let at = self.duration() / 3.;
        let clips: Vec<&DocClip> = self.tracks.iter().flat_map(|t| &t.clips).filter(video).collect();
        let playing = clips.iter().find(|c| c.at <= at && at < c.at + (c.out - c.from) / c.speed);
        let first = clips.iter().min_by(|a, b| a.at.total_cmp(&b.at));
        let (clip, second) = match playing {
            Some(c) => (*c, c.from + (at - c.at) * c.speed),
            None => {
                let c = *first?;
                (c, c.from + (c.out - c.from) / 2.)
            }
        };
        Some((source_path(base, &clip.src), second.max(0.)))
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
    let doc: Doc = match value.get("kdjv").and_then(|v| v.as_u64()) {
        Some(VERSION) => serde_json::from_value(value).context("工程内容无效")?,
        Some(LANES) => serde_json::from_value::<Lanes>(value).context("工程内容无效")?.doc()?,
        Some(TRACKS) => serde_json::from_value::<Tracks>(value).context("工程内容无效")?.doc()?,
        Some(other) => bail!("工程格式版本 {other} 需要更新的 KDJ"),
        None => bail!("缺少 \"kdjv\": 1、2 或 3"),
    };
    if doc.tracks.iter().all(|t| t.clips.is_empty()) {
        bail!("工程里没有片段")
    }
    Ok(doc)
}

/// What each source file held when it was last probed, by its path; its `signature` says whether
/// it is still the same file.
static PROBED: std::sync::OnceLock<Mutex<HashMap<PathBuf, Probed>>> = std::sync::OnceLock::new();

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
            // Names the clip the way the AI can find it again in its own document: track, index,
            // where it sits in the project and which file it plays.
            let file = Path::new(&c.src).file_name().map_or(c.src.clone(), |f| f.to_string_lossy().into_owned());
            let where_ = c.name.clone()
                .unwrap_or_else(|| format!("tracks[{t}].clips[{n}]（第 {} 条轨道第 {} 个片段，at {:.3} 秒，{file}）", t + 1, n + 1, c.at));
            let sid = source_id(&c.src).with_context(|| format!("{where_}：找不到素材"))?;
            if !(c.at.is_finite() && c.at >= 0. && c.from.is_finite() && c.from >= 0. && c.out.is_finite() && c.out > c.from) {
                bail!("{where_}：at、in、out 无效（at {}，in {}，out {}；秒，out 要大于 in）", c.at, c.from, c.out)
            }
            let source = sources.iter().find(|s| s.id == sid).expect("source listed above");
            if !source.image() && c.out * 1000. > source.duration_ms + 50. {
                bail!("{where_}：out {:.3} 超出素材长度 {:.3} 秒", c.out, source.duration_ms / 1000.)
            }
            // The last 50 ms past a source's end is rounding between the length a library or a
            // container reports and the one its streams decode to; such an out ends the clip at the
            // source's end instead of failing the workshop's exact bound.
            let out_ms = if source.image() { c.out * 1000. } else { (c.out * 1000.).min(source.duration_ms) };
            if out_ms <= c.from * 1000. {
                bail!("{where_}：in {:.3} 不在素材长度 {:.3} 秒以内", c.from, source.duration_ms / 1000.)
            }
            for (field, value, low, high) in [
                ("speed", c.speed, 0.5, 2.),
                ("volume", c.volume, 0., 2.),
                ("x", c.x, 0., 1.),
                ("y", c.y, 0., 1.),
                ("scale", c.scale, 0.1, 2.),
                ("opacity", c.opacity, 0., 1.),
            ] {
                if !(value.is_finite() && (low..=high).contains(&value)) {
                    bail!("{where_}：{field} 是 {value}，要在 {low}–{high} 之间")
                }
            }
            let mut clip = Clip {
                video_transition: None,
                display_duration_ms: None,
                animation_offset_ms: 0.,
                id: format!("c{t}-{n}"),
                source_id: sid.clone(),
                start_ms: c.at * 1000.,
                source_in_ms: c.from * 1000.,
                source_out_ms: out_ms,
                speed: Speed {
                    preset: "constant".into(),
                    start: c.speed,
                    middle: c.speed,
                    end: c.speed,
                    domain_start_ms: c.from * 1000.,
                    domain_end_ms: out_ms,
                },
                picture: Picture {
                    x: c.x,
                    y: c.y,
                    scale: c.scale,
                    opacity: c.opacity,
                    crop_auto_fit: c.fill,
                    crop: c.crop,
                    // What is left of a crop is fitted (or filled) as a whole picture.
                    crop_keep_position: false,
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
            for (field, value) in [
                ("fade_in", Some(c.fade_in)),
                ("fade_out", Some(c.fade_out)),
                ("audio_fade_in", c.audio_fade_in),
                ("audio_fade_out", c.audio_fade_out),
            ] {
                let Some(value) = value else { continue };
                let limit = if c.whole_fade { span } else { span / 2. };
                if !(value.is_finite() && value >= 0. && value * 1000. <= limit + 0.01) {
                    bail!("{where_}：{field} {value} 秒超过这一段在成片里长度 {:.3} 秒的一半（最多 {:.3} 秒）", span / 1000., span / 2000.)
                }
            }
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
    crossfade_handles(&mut layers, &sources);
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

/// How far before a fading clip's start the picture before it may end and still be its seam.
const SEAM_MS: f64 = 50.;

/// A picture clip fading in where the picture before it simply ends is a crossfade: the clip that
/// ended is carried on under the fading one for the fade, from where it stopped in its source (as
/// far as the source goes; a still or a gif just holds on), picture only, in a layer of its own
/// right under the fading clip. Not where a picture already shows under the fade's start (that is
/// a crossfade as it stands), nor after a clip that fades out itself (a dip the user made). The
/// document is untouched: the render and the live preview both draw from this project.
fn crossfade_handles(layers: &mut Vec<Layer>, sources: &[Source]) {
    let seen = |c: &Clip| sources.iter().any(|s| s.id == c.source_id && s.visual()) && c.picture.opacity > 0.;
    let mut handles: Vec<(usize, Clip)> = vec![];
    for (l, layer) in layers.iter().enumerate() {
        for b in layer.clips.iter().filter(|b| b.fades.video_in_ms > 0. && seen(b)) {
            let (start, fade) = (b.start_ms, b.fades.video_in_ms);
            let shows = |c: &Clip| seen(c) && c.start_ms <= start + 1. && c.start_ms + c.duration() > start + 1.;
            if layers[l + 1..].iter().flat_map(|layer| &layer.clips).any(shows) {
                continue;
            }
            // The picture seen before the cut: the topmost clip ending there.
            let Some(a) = layers.iter().flat_map(|layer| &layer.clips).filter(|a| {
                let end = a.start_ms + a.duration();
                !std::ptr::eq(*a, b) && seen(a) && a.fades.video_out_ms <= 0. && end >= start - SEAM_MS && end <= start + 1.
            }).next() else { continue };
            let end = a.start_ms + a.duration();
            let want = start + fade - end;
            let mut c = a.clone();
            c.id = format!("{}-under-{}", a.id, b.id);
            c.start_ms = end;
            c.sound = Sound { muted: true, gain: 0., manual: true };
            if a.display_duration_ms.is_some() {
                c.animation_offset_ms = a.animation_offset_ms + a.duration();
                c.display_duration_ms = Some(want);
            } else {
                let Some(source) = sources.iter().find(|s| s.id == a.source_id) else { continue };
                let rate = a.speed.rate(a.source_out_ms).max(0.01);
                let out = (a.source_out_ms + want * rate).min(source.duration_ms);
                if out - a.source_out_ms < 1. {
                    continue;
                }
                c.source_in_ms = a.source_out_ms;
                c.source_out_ms = out;
                c.speed.domain_start_ms = c.source_in_ms;
                c.speed.domain_end_ms = out;
            }
            // Carried on as it was seen at its end; it ends under the fading clip, so no fade of its own.
            c.fades = Fades { offset_ms: 0., span_ms: c.duration(), video_in_ms: 0., video_out_ms: 0., audio_in_ms: 0., audio_out_ms: 0., linear: false };
            handles.push((l, c));
        }
    }
    // Each under the layer of its fading clip, the latest first so the indices still hold.
    for (l, c) in handles.into_iter().rev() {
        let id = format!("track-{l}-{}", c.id);
        layers.insert(l + 1, Layer { grid: None, id, source_id: c.source_id.clone(), clips: vec![c] });
    }
}

pub use kdj_providers::tags::is_project_path;

/// The file and second a library row's cover is cut from (see `Doc::cover_frame`).
pub fn cover_frame(file: &Path) -> Option<(PathBuf, f64)> {
    let doc = parse(&std::fs::read_to_string(file).ok()?).ok()?;
    doc.cover_frame(file.parent().unwrap_or(Path::new(".")))
}

/// What KDJ keeps of a project: its full render (picture and sound in one MP4, for 导出 MP4 and
/// for playing once it exists) and its sound alone (the mix the live preview plays).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Made {
    Render,
    Sound,
}

/// What each project file plays from, as last made. The window asks for it (POST
/// /api/kdjv/preview|render) before it plays a project; the library's media routes only look here.
/// Each with the project's mtime when it was made: an edit since makes it stale.
static MADE: std::sync::OnceLock<Mutex<HashMap<(PathBuf, Made), (u64, PathBuf)>>> = std::sync::OnceLock::new();
/// Where that is remembered across restarts (`<cache>/kdjv-index`): one small file per project
/// and kind, named by the project's path, holding the project's mtime and the file made. Set by
/// Workshop::new.
pub(super) static INDEX: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn index_file(file: &Path, made: Made) -> Option<PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    file.hash(&mut h);
    let suffix = match made {
        Made::Render => "",
        Made::Sound => ".sound",
    };
    Some(INDEX.get()?.join(format!("{:016x}{suffix}", h.finish())))
}

fn mtime(file: &Path) -> u64 {
    crate::waveform::file_mtime(file)
}

fn remember(file: &Path, made: Made, output: &Path) {
    let Ok(file) = std::fs::canonicalize(file) else { return };
    if let Some(index) = index_file(&file, made) {
        let _ = std::fs::create_dir_all(index.parent().unwrap_or(Path::new(".")));
        let _ = std::fs::write(index, format!("{}\n{}", mtime(&file), output.display()));
    }
    let stamp = mtime(&file);
    MADE.get_or_init(Default::default).lock().unwrap().insert((file, made), (stamp, output.to_path_buf()));
}

/// What a project file last got of this kind, while it is still in the cache — remembered across
/// restarts as long as the project file has not changed since.
fn made(file: &Path, made: Made) -> Option<PathBuf> {
    let file = std::fs::canonicalize(file).ok()?;
    let stamp = mtime(&file);
    let known = MADE.get_or_init(Default::default).lock().unwrap().get(&(file.clone(), made))
        .filter(|(at, path)| *at == stamp && path.is_file()).map(|(_, path)| path.clone());
    known.or_else(|| {
        let text = std::fs::read_to_string(index_file(&file, made)?).ok()?;
        let (stamp, output) = text.split_once('\n')?;
        let output = PathBuf::from(output);
        (stamp.parse::<u64>().ok()? == mtime(&file) && output.is_file()).then_some(output)
    })
}

/// The render a project file last got.
pub fn rendered(file: &Path) -> Option<PathBuf> {
    made(file, Made::Render)
}

/// What a project sounds like: its render, else the mix its live preview plays.
pub fn sounded(file: &Path) -> Option<PathBuf> {
    rendered(file).or_else(|| made(file, Made::Sound))
}

/// The n-th source file a project names (what its live preview loads), from the document alone:
/// nothing is probed. None when the project names no such file.
pub fn source(file: &Path, n: usize) -> Option<PathBuf> {
    let doc = parse(&std::fs::read_to_string(file).ok()?).ok()?;
    doc.sources(file.parent().unwrap_or(Path::new("."))).into_iter().nth(n)
}

/// The file a project names as `src` (as its document writes it), when it is one of its sources:
/// what the editor may ask a frame of, and nothing else.
pub fn named_source(file: &Path, src: &str) -> Option<PathBuf> {
    let doc = parse(&std::fs::read_to_string(file).ok()?).ok()?;
    let base = file.parent().unwrap_or(Path::new("."));
    let path = source_path(base, src);
    doc.sources(base).contains(&path).then_some(path)
}

/// A project as its live preview draws it: the canvas and each picture clip, its source by number
/// (the order of `Doc::sources`, served by `/api/kdjv/source/{track}/{n}`).
#[derive(Debug, Serialize)]
pub struct Live {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub sources: Vec<LiveSource>,
    pub clips: Vec<LiveClip>,
}
#[derive(Debug, Serialize)]
pub struct LiveSource {
    /// `video`, `image`, `gif` or `audio`.
    pub kind: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// The file and its signature: the same source number may be another file after an edit.
    pub file: String,
    /// Its preview proxy is made (proxy.rs): the window loads `/api/kdjv/proxy/{track}/{n}`.
    pub proxy: bool,
}
/// One picture clip, in seconds as in the document.
#[derive(Debug, Serialize)]
pub struct LiveClip {
    pub source: usize,
    /// 0 is the top track.
    pub track: usize,
    pub at: f64,
    #[serde(rename = "in")]
    pub from: f64,
    pub out: f64,
    /// The clip's length in the project.
    pub length: f64,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub opacity: f64,
    pub fill: bool,
    /// Fractions taken off: left, top, right, bottom.
    pub crop: [f64; 4],
    pub fade_in: f64,
    pub fade_out: f64,
}

/// The live preview's view of a project: every picture clip and what its source is. Pure.
pub fn live(p: &CompositionProject) -> Live {
    let sources = p.sources.iter().map(|s| LiveSource { kind: s.kind.clone(), width: s.width, height: s.height, fps: s.fps, file: format!("{}#{}", s.path, s.signature), proxy: false }).collect();
    let mut clips = vec![];
    for (track, layer) in p.layers.iter().enumerate() {
        for c in &layer.clips {
            let Some(n) = p.sources.iter().position(|s| s.id == c.source_id) else { continue };
            // Nothing to draw: a sound, or a clip nobody can see (a video giving only its sound).
            if !p.sources[n].visual() || c.picture.opacity <= 0. {
                continue;
            }
            clips.push(LiveClip {
                source: n,
                track,
                at: c.start_ms / 1000.,
                from: c.source_in_ms / 1000.,
                out: c.source_out_ms / 1000.,
                length: c.duration() / 1000.,
                x: c.picture.x,
                y: c.picture.y,
                scale: c.picture.scale,
                opacity: c.picture.opacity,
                fill: c.picture.crop_auto_fit,
                crop: c.picture.crop,
                fade_in: c.fades.video_in_ms / 1000.,
                fade_out: c.fades.video_out_ms / 1000.,
            });
        }
    }
    Live { duration: p.duration() / 1000., width: p.canvas.width, height: p.canvas.height, sources, clips }
}

/// What the project's sound is keyed by: the clips heard, the sources they play and its length.
fn sound_key(p: &CompositionProject) -> Result<String> {
    let audible = super::render::heard(p);
    let sources: Vec<_> = audible.sources.iter()
        .filter(|s| audible.layers.iter().flat_map(|l| &l.clips).any(|c| c.source_id == s.id))
        .collect();
    key(&(&sources, &audible.layers, p.duration()))
}

/// How an export differs from the render made for playing: none of these set is that render.
#[derive(Debug, Default, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderOptions {
    /// The picture's size in pixels (even numbers); the project's own when not given.
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub fps: Option<f64>,
    /// The encoder's CRF: 16 high, 20 standard (the default), 26 compact.
    #[serde(default)]
    pub quality: Option<u8>,
    /// Only this stretch of the project, in seconds.
    #[serde(default)]
    pub from: Option<f64>,
    #[serde(default)]
    pub to: Option<f64>,
    /// The sound alone, as WAV.
    #[serde(default)]
    pub audio_only: bool,
}

impl RenderOptions {
    pub fn is_default(&self) -> bool {
        *self == RenderOptions::default()
    }

    /// Sets the project's canvas and quality from these, and answers the stretch to render in ms.
    fn apply(&self, p: &mut CompositionProject) -> Result<(f64, f64)> {
        if let (Some(width), Some(height)) = (self.width, self.height) {
            if !(16..=7680).contains(&width) || !(16..=4320).contains(&height) {
                bail!("画面尺寸 {width}×{height} 不在 16–7680 × 16–4320 之内")
            }
            p.canvas.width = width / 2 * 2;
            p.canvas.height = height / 2 * 2;
        }
        if let Some(fps) = self.fps {
            if !(1. ..=120.).contains(&fps) {
                bail!("帧率 {fps} 不在 1–120 之内")
            }
            p.canvas.fps = fps;
        }
        if let Some(quality) = self.quality {
            if !(10..=40).contains(&quality) {
                bail!("画质 {quality} 不在 10–40 之内")
            }
            p.output.quality = quality;
        }
        let end = p.duration();
        let lo = (self.from.unwrap_or(0.) * 1000.).clamp(0., end);
        let hi = self.to.map_or(end, |to| (to * 1000.).clamp(0., end));
        if hi - lo < 100. {
            bail!("导出的区间太短（{:.1}–{:.1} 秒）", lo / 1000., hi / 1000.)
        }
        Ok((lo, hi))
    }
}

/// What playing a project starts from: the sound to hear, its render when there is one, and what
/// the live preview draws.
#[derive(Debug, Serialize)]
pub struct Preview {
    pub sound: PathBuf,
    pub render: Option<PathBuf>,
    pub project: Live,
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
        // Every edit opens every source again: a file not changed since is not probed again.
        let signature = signature(&path)?;
        let known = PROBED.get_or_init(Default::default).lock().unwrap().get(&path).filter(|p| p.signature == signature).cloned();
        if let Some(known) = known {
            return Ok(known);
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
        let probed = Probed {
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
            signature,
        };
        PROBED.get_or_init(Default::default).lock().unwrap().insert(path, probed.clone());
        Ok(probed)
    }

    /// The project a `.kdjv` file describes, with every source opened and checked.
    async fn kdjv_project(&self, file: &Path, cancel: &CancellationToken) -> Result<CompositionProject> {
        let text = tokio::fs::read_to_string(file).await.with_context(|| format!("无法读取工程：{}", file.display()))?;
        Self::kdjv_project_text(&text, file.parent().unwrap_or(Path::new(".")), cancel).await
    }

    /// The project a document describes as if saved in `base`, with every source opened and checked.
    async fn kdjv_project_text(text: &str, base: &Path, cancel: &CancellationToken) -> Result<CompositionProject> {
        let doc = parse(text)?;
        let mut probed = HashMap::new();
        for path in doc.sources(base) {
            check(cancel)?;
            let found = Self::probe_source(&path, cancel).await?;
            probed.insert(path, found);
        }
        project(&doc, base, &probed)
    }

    /// The editor's and the AI's edits of a project (tracks.rs, format 3): the operations applied
    /// in order, the result opened as playing it would (every source checked) and only then
    /// written, whole, in place of the file. A project of an earlier format is read as format 3
    /// (tracks.rs `from_earlier`) and written as one by its first edit; opening it writes nothing.
    /// `create` starts a file that must not be there yet. Answers the document and where
    /// everything in it is.
    /// A project renamed: its file in the same folder under `name` (never over another file; the
    /// sources it names relative to that folder stay where they are), its library row moved with it
    /// (analysis, rating and comment kept), and its title the same name. The edit's answer, for the
    /// new path.
    pub async fn kdjv_rename(&self, file: &Path, name: &str, cancel: &CancellationToken) -> Result<serde_json::Value> {
        let name: String = name.trim().chars().map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c }).collect();
        let name = name.trim().trim_start_matches('.').trim().chars().take(120).collect::<String>();
        if name.is_empty() {
            bail!("名字不能是空的")
        }
        let target = file.with_file_name(format!("{name}.{EXTENSION}"));
        // The same file under another case (macOS, Windows) is a rename too.
        let same = |a: &Path, b: &Path| std::fs::canonicalize(a).ok().zip(std::fs::canonicalize(b).ok()).is_some_and(|(a, b)| a == b);
        if target != file {
            if target.exists() && !same(file, &target) {
                bail!("这个文件夹里已经有「{name}」了")
            }
            std::fs::rename(file, &target).with_context(|| format!("改不了名：{}", file.display()))?;
            if let Some(track) = self.state.library.get_by_path(file).ok().flatten() {
                if let Err(error) = self.state.library.relocate(track.id, &target) {
                    let _ = std::fs::rename(&target, file);
                    bail!("曲库没能跟着改名，文件已改回原名：{error:#}")
                }
                self.state.hub.publish_library_updated(&[track.id]);
            }
        }
        self.kdjv_edit(&target, &[serde_json::json!({"op": "title", "title": name})], false, cancel).await
    }

    pub async fn kdjv_edit(&self, file: &Path, ops: &[serde_json::Value], create: bool, cancel: &CancellationToken) -> Result<serde_json::Value> {
        use super::tracks;
        // A new project never takes the place of one that is there.
        if create && file.exists() {
            bail!("已经有这个文件：{}", file.display())
        }
        let read: serde_json::Value = match tokio::fs::read_to_string(file).await {
            Ok(text) => serde_json::from_str(&text).context("工程不是有效的 JSON")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => serde_json::json!({ "kdjv": tracks::FORMAT, "tracks": [] }),
            Err(error) => return Err(error).with_context(|| format!("无法读取工程：{}", file.display())),
        };
        let before = match read.get("kdjv").and_then(|v| v.as_u64()) {
            Some(tracks::FORMAT) => read,
            Some(VERSION | LANES) => tracks::from_earlier(&read).context("工程内容无效")?,
            other => bail!("这个工程是格式 {}，这个版本的 KDJ 改不了", other.map_or("?".into(), |v| v.to_string())),
        };
        let ops: Vec<tracks::Op> = ops.iter().enumerate()
            .map(|(n, op)| serde_json::from_value(op.clone()).with_context(|| format!("第 {} 步不是认得的剪辑操作：{op}", n + 1)))
            .collect::<Result<_>>()?;
        // Opening a project (no operations) only reads it: the file is not written, and one that does
        // not play as it is still opens, saying why, so that it can be put right here.
        let opening = ops.is_empty() && !create;
        let folder = file.parent().unwrap_or(Path::new("."));
        let ops = Self::with_lengths(&ops, folder, cancel).await?;
        let mut after = tracks::apply(&before, &ops)?;
        // What reaches past the end of its file ends there (an open project too: shown so, written
        // only with the next edit).
        let mut lengths: HashMap<String, Option<f64>> = HashMap::new();
        for src in tracks::sources(&after) {
            let probed = Self::probe_source(&source_path(folder, &src), cancel).await.ok();
            lengths.insert(src, probed.filter(|p| p.kind == "video" || p.kind == "audio").map(|p| p.duration_ms / 1000.));
        }
        tracks::fit_sources(&mut after, |src| lengths.get(src).copied().flatten())?;
        let text = serde_json::to_string_pretty(&after)?;
        let base = file.parent().filter(|dir| dir.is_dir()).with_context(|| format!("文件夹不存在：{}", file.display()))?;
        // A draft with nothing in it yet is kept as it is; anything else has to play.
        let (project, problem) = if tracks::is_empty(&after) {
            (None, None)
        } else {
            match Self::kdjv_project_text(&text, base, cancel).await {
                Ok(project) => (Some(project), None),
                Err(error) if opening => (None, Some(format!("{error:#}"))),
                Err(error) => return Err(error),
            }
        };
        let duration = project.as_ref().map_or(0., |p| p.duration() / 1000.);
        // How long each file the document names is, by its name there: how far a clip can reach.
        let lengths: serde_json::Map<String, serde_json::Value> = lengths.into_iter()
            .filter_map(|(src, len)| Some((src, serde_json::json!(len?))))
            .collect();
        if !opening {
            let temporary = file.with_extension(format!("{EXTENSION}.{}.tmp", std::process::id()));
            tokio::fs::write(&temporary, format!("{text}\n")).await?;
            tokio::fs::rename(&temporary, file).await?;
        }
        // The row is there at once (a new project) and reads its new length and title (an edit),
        // without waiting for the folder watcher.
        let track_id = if opening {
            self.state.library.get_by_path(file).ok().flatten().map(|track| track.id)
        } else {
            self.state.library.upsert_file(file, "local", "").ok()
        };
        // The songs' own rows (the first sound track's clips), where the editor reads bar lines.
        let song_track_ids: Vec<Option<i64>> = tracks::song_clips(&after).iter()
            .map(|song| song["src"].as_str()
                .and_then(|src| self.state.library.get_by_path(&source_path(base, src)).ok().flatten())
                .map(|track| track.id))
            .collect();
        Ok(serde_json::json!({
            "path": file, "track_id": track_id,
            "song_track_id": song_track_ids.first().copied().flatten(), "song_track_ids": song_track_ids,
            "document": after, "layout": tracks::layout(&after), "duration": duration,
            "lengths": lengths, "problem": problem,
            // The live preview's clips at once: the picture follows the edit without waiting for the sound.
            "live": project.as_ref().map(|p| self.live_shown(p)),
        }))
    }

    /// The operations with every clip that came without an `out`, or with one past the end of its
    /// file, given the file's whole length, measured here: the library may not know it (a
    /// fragmented M4A says 0 in its header) or know the sound's, longer than the picture.
    async fn with_lengths(ops: &[super::tracks::Op], base: &Path, cancel: &CancellationToken) -> Result<Vec<super::tracks::Op>> {
        use super::tracks::Op;
        let mut out = ops.to_vec();
        for op in &mut out {
            let Op::Add { clip: item, .. } = op else { continue };
            let given = item.get("out").and_then(|v| v.as_f64()).filter(|out| *out > 0.);
            let Some(src) = item.get("src").and_then(|v| v.as_str()) else { continue };
            let probed = Self::probe_source(&source_path(base, src), cancel).await?;
            let seconds = (probed.duration_ms / 1000. * 1000.).floor() / 1000.;
            // A still lasts as long as it is asked to.
            let still = probed.kind == "image" || probed.kind == "gif";
            if given.is_some_and(|out| still || out <= seconds + 1e-3) {
                continue;
            }
            item.insert("out".into(), serde_json::json!(seconds));
        }
        Ok(out)
    }

    /// The project's sound alone, keyed by what is heard only (and how long it is): an edit of
    /// the picture alone keeps the same file, so the playing row is not loaded again.
    fn kdjv_sound_cache(&self, p: &CompositionProject) -> Result<(String, PathBuf)> {
        let name = format!("kdjv-sound-v2-{}", sound_key(p)?);
        let path = self.cache.join(format!("{name}.wav"));
        Ok((name, path))
    }

    /// What playing a project needs at once: its sound, mixed now when it is not in the cache yet
    /// (sound only, several chunks at a time: seconds, not the minutes of a render), its render if
    /// one exists, and the clips the live preview draws. The picture is never rendered here.
    pub async fn kdjv_preview(
        &self,
        file: &Path,
        cancel: &CancellationToken,
        progress: &(dyn Fn(f64, &str) + Sync),
    ) -> Result<Preview> {
        progress(0., "读取工程");
        let p = self.kdjv_project(file, cancel).await?;
        let (_, rendered) = self.kdjv_cache(&p)?;
        let render = rendered.is_file().then_some(rendered);
        if let Some(render) = &render {
            remember(file, Made::Render, render);
        }
        let (name, cached) = self.kdjv_sound_cache(&p)?;
        let lock = self.cache_lock(&name).await;
        let guard = lock.lock().await;
        if !cached.is_file() {
            std::fs::create_dir_all(&self.cache)?;
            let stage = self.cache.join(format!(".{name}-{}", id()));
            std::fs::create_dir(&stage)?;
            let _scratch = Scratch(stage.clone());
            progress(0., "混合声音");
            let mix = self
                .mix_file(&p, &stage, 0., p.duration(), cancel, &|step| {
                    if let Step::Progress(v) = step {
                        progress(v, "混合声音");
                    }
                    Ok(())
                })
                .await?;
            std::fs::rename(&mix, &cached)?;
            self.trim_cache();
        }
        drop(guard);
        remember(file, Made::Sound, &cached);
        progress(1., "");
        Ok(Preview { sound: cached, render, project: self.live_shown(&p) })
    }

    /// Where a render with these options is kept: the playing render's own place for none, else
    /// a place of its own, keyed by them too.
    fn kdjv_cache_with(&self, p: &CompositionProject, options: &RenderOptions) -> Result<(String, PathBuf)> {
        if options.is_default() {
            return self.kdjv_cache(p);
        }
        let name = format!("kdjv-x-{}", key(&(&p.sources, &p.layers, &p.canvas, p.output.quality, options))?);
        let path = self.cache.join(format!("{name}.{}", if options.audio_only { "wav" } else { "mp4" }));
        Ok((name, path))
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
        options: &RenderOptions,
        cancel: &CancellationToken,
        progress: &(dyn Fn(f64, &str) + Sync),
    ) -> Result<PathBuf> {
        progress(0., "读取工程");
        let mut p = self.kdjv_project(file, cancel).await?;
        let (lo, hi) = options.apply(&mut p)?;
        let (name, cached) = self.kdjv_cache_with(&p, options)?;
        let lock = self.cache_lock(&name).await;
        let _guard = lock.lock().await;
        if cached.is_file() {
            if options.is_default() {
                remember(file, Made::Render, &cached);
            }
            return Ok(cached);
        }
        let _slot = tokio::select! {_ = cancel.cancelled() => bail!("渲染已取消"), s = self.export_slots.acquire() => s?};
        std::fs::create_dir_all(&self.cache)?;
        let stage = self.cache.join(format!(".{name}-{}", id()));
        std::fs::create_dir(&stage)?;
        let _scratch = Scratch(stage.clone());
        let report = |step: Step, at: f64, span: f64| -> Result<()> {
            match step {
                Step::Progress(v) => progress(at + span * v, ""),
                Step::Detail(detail) => progress(at, &detail),
            }
            Ok(())
        };
        progress(0., "混合声音");
        let sound_share = if options.audio_only { 1. } else { 0.2 };
        let audio = self.mix_file(&p, &stage, lo, hi, cancel, &|step| report(step, 0., sound_share)).await?;
        if options.audio_only {
            std::fs::rename(&audio, &cached)?;
        } else {
            let output = stage.join("render.mp4");
            progress(0.2, "合成画面");
            self.picture_file(&p, &stage, &audio, &output, lo, hi, cancel, &|step| report(step, 0.2, 0.8)).await?;
            std::fs::rename(&output, &cached)?;
        }
        if options.is_default() {
            remember(file, Made::Render, &cached);
        }
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
    fn an_edit_of_the_picture_alone_keeps_the_sound() {
        let open = |main: &str| {
            let doc = parse(&format!(r#"{{"kdjv":2,"title":"VJ","song":{{"src":"/vj/op.mp4","in":0,"out":30}},"main":[{main}]}}"#)).unwrap();
            let probed = HashMap::from([(PathBuf::from("/vj/a.mp4"), video()), (PathBuf::from("/vj/op.mp4"), video())]);
            sound_key(&project(&doc, Path::new("/projects"), &probed).unwrap()).unwrap()
        };
        let base = open(r#"{"id":"a","src":"/vj/a.mp4","in":0,"out":10,"muted":true}"#);
        assert_eq!(base, open(r#"{"id":"a","src":"/vj/a.mp4","in":5,"out":15,"muted":true,"scale":0.5}"#), "a muted clip moved in its file");
        assert_ne!(base, open(r#"{"id":"a","src":"/vj/a.mp4","in":0,"out":10}"#), "the same clip heard");
    }

    #[test]
    fn a_video_in_the_sound_lane_is_heard_and_not_seen() {
        let doc = parse(
            r#"{"kdjv":2,"title":"VJ","song":{"src":"/vj/op.mp4","in":0,"out":30},
                "main":[{"id":"a","src":"/vj/a.mp4","in":0,"out":10,"muted":true}]}"#,
        )
        .unwrap();
        let probed = HashMap::from([(PathBuf::from("/vj/a.mp4"), video()), (PathBuf::from("/vj/op.mp4"), video())]);
        let p = project(&doc, Path::new("/projects"), &probed).unwrap();
        let song = &p.layers.last().unwrap().clips[0];
        assert_eq!((song.picture.opacity, song.sound.muted), (0., false), "its sound only");
        assert_eq!(live(&p).clips.len(), 1, "only the picture lane's clip is drawn");
    }

    #[test]
    fn lanes_lay_the_main_clips_end_to_end_with_branches_above_and_the_song_below() {
        let doc = parse(
            r#"{"kdjv":2,"title":"VJ","song":{"src":"/music/song.flac","in":0,"out":60},
                "main":[{"id":"a","src":"/vj/a.mp4","in":0,"out":10,"muted":true,"fill":true},
                        {"gap":2},
                        {"id":"b","src":"/vj/b.mp4","in":20,"out":40,"speed":2,"muted":true}],
                "branches":[{"clip":"a","side":"out","length":1,"opacity":0.8},
                            {"clip":"b","side":"in","length":0.5,"fade":false}]}"#,
        )
        .unwrap();
        let probed = HashMap::from([
            (PathBuf::from("/vj/a.mp4"), video()),
            (PathBuf::from("/vj/b.mp4"), video()),
            (PathBuf::from("/music/song.flac"), Probed { video: false, kind: "audio".into(), ..video() }),
        ]);
        let p = project(&doc, Path::new("/projects"), &probed).unwrap();
        assert_eq!(p.layers.len(), 3, "branches, the main lane, the song");
        let main: Vec<(f64, f64, f64)> = p.layers[1].clips.iter().map(|c| (c.start_ms, c.source_in_ms, c.duration())).collect();
        assert_eq!(main, vec![(0., 0., 10_000.), (12_000., 20_000., 10_000.)], "end to end, the gap kept, b twice as fast");
        let tail = &p.layers[0].clips[0];
        assert_eq!((tail.start_ms, tail.source_in_ms, tail.source_out_ms), (10_000., 10_000., 11_000.), "a runs on past its end");
        assert_eq!((tail.fades.video_out_ms, tail.picture.opacity, tail.sound.muted), (1_000., 0.8, true), "fading over all of it, silent");
        let head = &p.layers[0].clips[1];
        assert_eq!((head.start_ms, head.source_in_ms, head.source_out_ms), (11_500., 19_000., 20_000.), "b comes in early, at its speed");
        assert_eq!(head.fades.video_in_ms, 0., "a branch without a fade covers at its opacity");
        assert_eq!(p.layers[2].clips[0].duration(), 60_000.);
        assert_eq!(p.duration(), 60_000., "the song sets the length");
    }

    #[test]
    fn several_songs_play_one_after_another_under_the_lanes() {
        let doc = parse(
            r#"{"kdjv":2,"title":"Set","songs":[{"src":"/music/a.flac","in":10,"out":40},{"src":"/music/b.flac","out":20}],
                "main":[{"id":"a","src":"/vj/a.mp4","in":0,"out":45}]}"#,
        )
        .unwrap();
        let audio = Probed { video: false, kind: "audio".into(), ..video() };
        let probed = HashMap::from([
            (PathBuf::from("/vj/a.mp4"), video()),
            (PathBuf::from("/music/a.flac"), audio.clone()),
            (PathBuf::from("/music/b.flac"), audio),
        ]);
        let p = project(&doc, Path::new("/projects"), &probed).unwrap();
        let songs: Vec<(f64, f64, f64)> = p.layers.last().unwrap().clips.iter().map(|c| (c.start_ms, c.source_in_ms, c.duration())).collect();
        assert_eq!(songs, vec![(0., 10_000., 30_000.), (30_000., 0., 20_000.)]);
        assert_eq!(p.duration(), 50_000., "the songs together set the length");
        let long = r#"{"kdjv":2,"songs":[{"src":"/music/a.flac","out":5},{"src":"/music/b.flac","out":5}],"main":[{"src":"/vj/a.mp4","out":12}]}"#;
        assert!(parse(long).unwrap_err().to_string().contains("比歌"));
    }

    #[test]
    fn a_lane_document_says_which_clip_or_branch_is_wrong() {
        let error = |text: &str| parse(text).unwrap_err().to_string();
        let main = r#""main":[{"id":"a","src":"/vj/a.mp4","in":0,"out":10},{"id":"b","src":"/vj/b.mp4","in":0,"out":10}]"#;
        assert!(error(&format!(r#"{{"kdjv":2,{main},"branches":[{{"clip":"x","side":"out","length":1}}]}}"#)).contains("没有 id"));
        assert!(error(&format!(r#"{{"kdjv":2,{main},"branches":[{{"clip":"b","side":"in","length":1}}]}}"#)).contains("前面不够"));
        assert!(error(&format!(r#"{{"kdjv":2,{main},"branches":[{{"clip":"a","side":"out","length":1}},{{"clip":"a","side":"out","length":2}}]}}"#)).contains("重叠"));
        assert!(error(&format!(r#"{{"kdjv":2,{main},"song":{{"src":"/s.flac","out":15}}}}"#)).contains("比歌"));
        assert!(error(r#"{"kdjv":2,"main":[{"gap":0}]}"#).contains("main[0]"));
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
    fn a_clip_fading_in_where_the_picture_before_it_ends_crossfades_with_it() {
        let base = Path::new("/projects");
        let probed = HashMap::from([(PathBuf::from("/media/a.mp4"), video()), (PathBuf::from("/media/b.mp4"), video())]);
        let built = |text: &str| project(&parse(text).unwrap(), base, &probed).unwrap();
        // Same track, end to end: a carries on under b for b's fade, from where it stopped.
        let p = built(r#"{"kdjv":3,"tracks":[{"kind":"picture","clips":[
            {"src":"/media/a.mp4","at":0,"in":10,"out":20,"speed":2},
            {"src":"/media/b.mp4","at":5,"in":0,"out":10,"fade_in":1}]}]}"#);
        assert_eq!(p.layers.len(), 2, "one layer more, under the fading clip");
        let under = &p.layers[1].clips[0];
        assert_eq!((under.start_ms, under.source_in_ms, under.source_out_ms), (5_000., 20_000., 22_000.), "a second at twice the speed");
        assert!(under.sound.muted && under.fades.video_in_ms == 0. && under.duration() == 1_000.);
        assert_eq!(p.duration(), 15_000., "the project is as long as before");
        assert_eq!(live(&p).clips.len(), 3, "the preview draws it too");
        // As far as the source goes.
        let short = built(r#"{"kdjv":3,"tracks":[{"kind":"picture","clips":[
            {"src":"/media/a.mp4","at":0,"in":0,"out":59.5},
            {"src":"/media/b.mp4","at":59.5,"in":0,"out":10,"fade_in":2}]}]}"#);
        assert_eq!(short.layers[1].clips[0].source_out_ms, 60_000.);
        // A picture already under the fade, or a clip that fades out itself: nothing is added.
        let overlapped = built(r#"{"kdjv":3,"tracks":[
            {"kind":"picture","clips":[{"src":"/media/b.mp4","at":5,"in":0,"out":10,"fade_in":1}]},
            {"kind":"picture","clips":[{"src":"/media/a.mp4","at":0,"in":0,"out":6}]}]}"#);
        assert_eq!(overlapped.layers.len(), 2);
        let dip = built(r#"{"kdjv":3,"tracks":[{"kind":"picture","clips":[
            {"src":"/media/a.mp4","at":0,"in":0,"out":5,"fade_out":1},
            {"src":"/media/b.mp4","at":5,"in":0,"out":10,"fade_in":1}]}]}"#);
        assert_eq!(dip.layers.len(), 1);
    }

    #[test]
    fn the_live_preview_draws_each_picture_clip_from_its_numbered_source() {
        let doc = parse(
            r#"{"kdjv":1,"tracks":[
                {"clips":[{"src":"logo.mp4","at":2,"in":0,"out":4,"opacity":0.5,"fade_in":0.5,"fill":true}]},
                {"clips":[{"src":"/media/a.mp4","at":0,"in":10,"out":20,"speed":2},
                          {"src":"/media/song.flac","at":0,"in":0,"out":30}]}
            ]}"#,
        )
        .unwrap();
        let base = Path::new("/projects");
        let song = Probed { kind: "audio".into(), video: false, ..video() };
        let probed = HashMap::from([
            (PathBuf::from("/projects/logo.mp4"), video()),
            (PathBuf::from("/media/a.mp4"), video()),
            (PathBuf::from("/media/song.flac"), song),
        ]);
        let live = live(&project(&doc, base, &probed).unwrap());
        assert_eq!(live.clips.len(), 2, "a sound-only clip is not drawn");
        let (top, fast) = (&live.clips[0], &live.clips[1]);
        assert_eq!((top.track, top.source, top.fill, top.opacity, top.fade_in), (0, 0, true, 0.5, 0.5));
        assert_eq!((fast.track, fast.source), (1, 1));
        assert_eq!((fast.from, fast.out, fast.length), (10., 20., 5.), "twice as fast plays ten seconds in five");
        assert_eq!(doc.sources(base)[fast.source], PathBuf::from("/media/a.mp4"), "numbered as /api/kdjv/source serves them");
        assert_eq!(live.duration, 30.);
    }

    #[test]
    fn the_cover_is_the_video_playing_a_third_of_the_way_in() {
        let doc = parse(
            r#"{"kdjv":1,"tracks":[{"clips":[
                {"src":"intro.mp4","at":0,"in":0,"out":10},
                {"src":"/media/ed.mp4","at":10,"in":30,"out":50},
                {"src":"logo.png","at":0,"in":0,"out":30}
            ]}]}"#,
        )
        .unwrap();
        let (path, second) = doc.cover_frame(Path::new("/projects")).unwrap();
        assert_eq!(path, PathBuf::from("/media/ed.mp4"));
        assert!((second - 30.).abs() < 1e-9, "{second}");
        let stills = parse(r#"{"kdjv":1,"tracks":[{"clips":[{"src":"a.png","at":0,"in":0,"out":5}]}]}"#).unwrap();
        assert!(stills.cover_frame(Path::new("/")).is_none(), "no video, no frame");
    }

    #[test]
    fn free_tracks_play_top_first_a_sound_track_heard_and_not_seen() {
        let doc = parse(r#"{"kdjv":3,"title":"t","tracks":[
            {"id":"v2","kind":"picture","hidden":true,"clips":[{"id":"c1","src":"/b.mp4","at":0,"in":0,"out":5}]},
            {"id":"v1","kind":"picture","clips":[{"id":"c2","src":"/a.mp4","at":2,"in":0,"out":5,"fade_in":5}]},
            {"id":"a1","kind":"sound","muted":true,"clips":[{"id":"c3","src":"/a.mp4","at":0,"in":0,"out":9}]}
        ]}"#).unwrap();
        assert_eq!(doc.tracks.len(), 3);
        assert_eq!(doc.tracks[0].clips[0].opacity, 0., "a hidden picture track is not seen");
        assert_eq!(doc.tracks[1].clips[0].opacity, 1.);
        assert!(doc.tracks[1].clips[0].whole_fade, "a fade may last the whole clip");
        assert_eq!(doc.tracks[2].clips[0].opacity, 0., "a sound track is not seen");
        assert!(doc.tracks[2].clips[0].muted, "a muted track is not heard");
        assert_eq!(doc.duration(), 9.);
    }

    #[test]
    fn what_cannot_play_is_said_instead_of_guessed() {
        assert!(parse(r#"{"tracks":[]}"#).unwrap_err().to_string().contains("kdjv"));
        assert!(parse(r#"{"kdjv":4,"tracks":[]}"#).unwrap_err().to_string().contains("更新"));
        assert!(parse(r#"{"kdjv":3,"tracks":[{"kind":"picture","clips":[]}]}"#).unwrap_err().to_string().contains("没有片段"));
        assert!(parse(r#"{"kdjv":1,"tracks":[{"clips":[]}]}"#).is_err());
        let doc = parse(r#"{"kdjv":1,"tracks":[{"clips":[{"src":"/a.mp4","at":0,"in":0,"out":90}]}]}"#).unwrap();
        let probed = HashMap::from([(PathBuf::from("/a.mp4"), video())]);
        let error = project(&doc, Path::new("/"), &probed).unwrap_err().to_string();
        assert!(error.contains("超出素材长度"), "{error}");
    }

    #[test]
    fn a_refused_clip_is_named_with_the_value_and_its_limit() {
        let probed = HashMap::from([(PathBuf::from("/a.mp4"), video())]);
        let error = |clip: &str| {
            let doc = parse(&format!(r#"{{"kdjv":1,"tracks":[{{"clips":[{{"src":"/a.mp4","at":0,"in":0,"out":4}}]}},{{"clips":[{clip}]}}]}}"#)).unwrap();
            project(&doc, Path::new("/"), &probed).map(|_| ()).unwrap_err().to_string()
        };
        let fade = error(r#"{"src":"/a.mp4","at":16.6,"in":0,"out":0.5,"fade_out":0.3}"#);
        assert!(fade.contains("tracks[1].clips[0]") && fade.contains("at 16.600") && fade.contains("a.mp4"), "{fade}");
        assert!(fade.contains("fade_out 0.3") && fade.contains("最多 0.250"), "{fade}");
        let speed = error(r#"{"src":"/a.mp4","at":0,"in":0,"out":4,"speed":3}"#);
        assert!(speed.contains("speed 是 3") && speed.contains("0.5–2"), "{speed}");
        let over = error(r#"{"src":"/a.mp4","at":0,"in":10,"out":61}"#);
        assert!(over.contains("out 61.000") && over.contains("60.000"), "{over}");
    }

    #[test]
    fn an_out_a_rounding_past_the_source_end_stops_at_the_end() {
        let doc = parse(r#"{"kdjv":1,"tracks":[{"clips":[{"src":"/a.mp4","at":0,"in":30,"out":60.03}]}]}"#).unwrap();
        let probed = HashMap::from([(PathBuf::from("/a.mp4"), video())]);
        let p = project(&doc, Path::new("/"), &probed).unwrap();
        assert_eq!(p.layers[0].clips[0].source_out_ms, 60_000.);
    }
}
