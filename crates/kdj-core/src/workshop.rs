//! Non-destructive VJ projects. Source and project clocks are deliberately separate.
use crate::composition::EncodingAcceleration;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
mod transitions;
pub use transitions::{VideoTransition, video_transition_span};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub frame_ends_ms: Vec<f64>,
    pub id: String,
    pub track_id: i64,
    pub path: String,
    pub title: String,
    pub duration_ms: f64,
    pub video: bool,
    pub audio: bool,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub signature: String,
}
impl Source {
    pub fn image(&self) -> bool { matches!(self.kind.as_str(), "image" | "gif") }
    pub fn visual(&self) -> bool { self.video || self.image() }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Speed {
    pub preset: String,
    pub start: f64,
    pub middle: f64,
    pub end: f64,
    // The curve domain survives splitting. Children only change their source bounds.
    pub domain_start_ms: f64,
    pub domain_end_ms: f64,
}
impl Speed {
    pub fn normal(end: f64) -> Self {
        Self {
            preset: "constant".into(),
            start: 1.,
            middle: 1.,
            end: 1.,
            domain_start_ms: 0.,
            domain_end_ms: end,
        }
    }
    pub fn rate(&self, source: f64) -> f64 {
        if self.preset == "constant" {
            return self.start;
        }
        let x = ((source - self.domain_start_ms) / (self.domain_end_ms - self.domain_start_ms))
            .clamp(0., 1.);
        if self.preset == "ramp" {
            self.start + (self.end - self.start) * smooth(x)
        } else if x < 0.5 {
            self.start + (self.middle - self.start) * smooth(x * 2.)
        } else {
            self.middle + (self.end - self.middle) * smooth(x * 2. - 1.)
        }
    }
}
pub fn smooth(x: f64) -> f64 {
    let x = x.clamp(0., 1.);
    x * x * (3. - 2. * x)
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Picture {
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub flip_x: bool,
    #[serde(default)]
    pub flip_y: bool,
    /// Removed fractions of the oriented source: left, top, right, bottom.
    #[serde(default)]
    pub crop: [f64; 4],
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub opacity: f64,
}
impl Default for Picture {
    fn default() -> Self {
        Self {
            rotation: 0., flip_x: false, flip_y: false, crop: [0.; 4],
            x: 0.5,
            y: 0.5,
            scale: 1.,
            opacity: 1.,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Sound {
    pub muted: bool,
    pub gain: f64,
    pub manual: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Fades {
    pub offset_ms: f64,
    pub span_ms: f64,
    pub video_in_ms: f64,
    pub video_out_ms: f64,
    pub audio_in_ms: f64,
    pub audio_out_ms: f64,
    #[serde(default)]
    pub linear: bool,
}
impl Fades {
    pub fn new(span: f64, overlay: bool) -> Self {
        let fade = if overlay { 300f64.min(span / 2.) } else { 0. };
        Self {
            offset_ms: 0.,
            span_ms: span,
            video_in_ms: fade,
            video_out_ms: fade,
            audio_in_ms: 0.,
            audio_out_ms: 0.,
            linear: false,
        }
    }
    pub fn alpha(&self, local: f64, audio: bool) -> f64 {
        let age = self.offset_ms + local;
        let (i, o) = if audio {
            (self.audio_in_ms, self.audio_out_ms)
        } else {
            (self.video_in_ms, self.video_out_ms)
        };
        let ramp = |x: f64| {
            if self.linear {
                x.clamp(0., 1.)
            } else {
                smooth(x)
            }
        };
        (if i > 0. { ramp(age / i) } else { 1. })
            * (if o > 0. {
                ramp((self.span_ms - age) / o)
            } else {
                1.
            })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Clip {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_transition: Option<VideoTransition>,
    #[serde(default)]
    pub display_duration_ms: Option<f64>,
    #[serde(default)]
    pub animation_offset_ms: f64,
    pub id: String,
    pub source_id: String,
    pub start_ms: f64,
    pub source_in_ms: f64,
    pub source_out_ms: f64,
    pub speed: Speed,
    pub picture: Picture,
    pub sound: Sound,
    pub fades: Fades,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TimePart {
    pub source_start_ms: f64,
    pub source_end_ms: f64,
    pub output_start_ms: f64,
    pub output_end_ms: f64,
    pub rate: f64,
}
impl Clip {
    /// Identical fixed-domain quadrature is used by the editor and media compiler.
    pub fn parts(&self) -> Vec<TimePart> {
        if let Some(duration) = self.display_duration_ms {
            return vec![TimePart { source_start_ms: self.animation_offset_ms, source_end_ms: self.animation_offset_ms + duration, output_start_ms: 0., output_end_ms: duration, rate: 1. }];
        }
        let count = if self.speed.preset == "constant" {
            1
        } else {
            256
        };
        let step = (self.speed.domain_end_ms - self.speed.domain_start_ms) / count as f64;
        let mut output = 0.;
        let mut parts = Vec::new();
        for n in 0..count {
            let lo = self.speed.domain_start_ms + n as f64 * step;
            let hi = lo + step;
            let a = lo.max(self.source_in_ms);
            let b = hi.min(self.source_out_ms);
            if b <= a {
                continue;
            }
            let rate = self.speed.rate((lo + hi) / 2.);
            let end = output + (b - a) / rate;
            parts.push(TimePart {
                source_start_ms: a,
                source_end_ms: b,
                output_start_ms: output,
                output_end_ms: end,
                rate,
            });
            output = end;
        }
        parts
    }
    pub fn duration(&self) -> f64 {
        self.parts().last().map_or(0., |p| p.output_end_ms)
    }
    pub fn source_at(&self, local: f64) -> f64 {
        if let Some(duration) = self.display_duration_ms { return self.animation_offset_ms + local.clamp(0., duration); }
        let parts = self.parts();
        let p = parts
            .iter()
            .find(|p| local < p.output_end_ms)
            .or(parts.last());
        p.map_or(self.source_in_ms, |p| {
            (p.source_start_ms + (local - p.output_start_ms) * p.rate)
                .clamp(self.source_in_ms, self.source_out_ms)
        })
    }
    pub fn output_at(&self, source: f64) -> f64 {
        if let Some(duration) = self.display_duration_ms { return (source - self.animation_offset_ms).clamp(0., duration); }
        let parts = self.parts();
        let p = parts
            .iter()
            .find(|p| source < p.source_end_ms)
            .or(parts.last());
        p.map_or(0., |p| {
            p.output_start_ms
                + (source.clamp(self.source_in_ms, self.source_out_ms) - p.source_start_ms) / p.rate
        })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GridSegment {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub bpm: f64,
    pub confidence: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BeatGrid {
    pub analysis_revision: String,
    pub source_signature: String,
    pub beats: Vec<f64>,
    pub downbeats: Vec<f64>,
    pub segments: Vec<GridSegment>,
    pub beats_per_bar: u8,
    pub downbeat_confidence: f64,
    pub locked: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Layer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid: Option<BeatGrid>,
    pub id: String,
    pub source_id: String,
    pub clips: Vec<Clip>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PictureLayout {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub opacity: f64,
}
impl Default for PictureLayout {
    fn default() -> Self {
        Self { x: 0.5, y: 0.5, scale: 1., opacity: 1. }
    }
}
impl PictureLayout {
    fn valid(&self) -> bool {
        finite_range(self.x, 0., 1.) && finite_range(self.y, 0., 1.)
            && finite_range(self.scale, 0.1, 2.) && finite_range(self.opacity, 0., 1.)
    }
    pub fn apply(&self, picture: &mut Picture) {
        picture.x = self.x;
        picture.y = self.y;
        picture.scale = self.scale;
        picture.opacity = self.opacity;
    }
}
fn default_import_picture() -> Option<PictureLayout> { Some(PictureLayout::default()) }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Canvas {
    #[serde(default = "default_import_picture")]
    pub import_picture: Option<PictureLayout>,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub initialized: bool,
}
impl Default for Canvas {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30.,
            initialized: false,
            import_picture: default_import_picture(),
        }
    }
}
fn default_output_format() -> String { "mp4".into() }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Output {
    #[serde(default = "default_output_format")]
    pub format: String,
    pub name: String,
    pub directory: String,
    pub in_ms: f64,
    pub out_ms: Option<f64>,
    pub quality: u8,
    pub acceleration: EncodingAcceleration,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Marker {
    pub id: String,
    pub position_ms: f64,
    pub number: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompositionProject {
    #[serde(default)]
    pub markers: Vec<Marker>,
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub sources: Vec<Source>,
    pub layers: Vec<Layer>,
    pub canvas: Canvas,
    pub output: Output,
    #[serde(default)]
    pub migrated_from: Option<String>,
}
impl CompositionProject {
    pub fn has_picture(&self) -> bool {
        self.layers.iter().flat_map(|layer| &layer.clips)
            .any(|clip| self.source(&clip.source_id).is_some_and(Source::visual))
    }

    /// Follow changes in timeline content, not unused sources or preview visibility.
    /// An explicit format edit takes precedence; existing audio-only choices survive
    /// removal of the last picture. Keep the frontend draft rule in sync.
    pub fn sync_output_format(&mut self, previous: &Self) {
        if self.output.format != previous.output.format { return; }
        match (previous.has_picture(), self.has_picture()) {
            (false, true) => self.output.format = "mp4".into(),
            (true, false) if self.output.format == "mp4" => self.output.format = "wav".into(),
            _ => {}
        }
    }

    /// A standalone music clip is the timing/name authority. Prefer audible
    /// material, then the longest clip; visual layer ordering never wins ties.
    pub fn music_reference(&self) -> Option<&Clip> {
        self.sources
            .iter()
            .filter(|s| s.audio && !s.video)
            .flat_map(|s| {
                self.layers
                    .iter()
                    .flat_map(|l| &l.clips)
                    .filter(move |c| c.source_id == s.id)
            })
            .reduce(|best, c| {
                if (!c.sound.muted, c.duration()) > (!best.sound.muted, best.duration()) {
                    c
                } else {
                    best
                }
            })
    }
    pub fn duration(&self) -> f64 {
        self.layers
            .iter()
            .flat_map(|l| &l.clips)
            .map(|c| c.start_ms + c.duration())
            .fold(0., f64::max)
    }
    pub fn source(&self, id: &str) -> Option<&Source> {
        self.sources.iter().find(|s| s.id == id)
    }
    pub fn clip(&self, id: &str) -> Option<&Clip> {
        self.layers
            .iter()
            .flat_map(|l| &l.clips)
            .find(|c| c.id == id)
    }
    pub fn validate(&self) -> Result<(), String> {
        let fail = |s: &str| Err(s.to_owned());
        let mut marker_ids = HashSet::new();
        let mut marker_numbers = HashSet::new();
        if self.markers.len() > 5000 || self.markers.iter().any(|m| {
            m.id.is_empty() || !marker_ids.insert(&m.id) || m.number == 0
                || !marker_numbers.insert(m.number) || !finite_range(m.position_ms, 0., 21_600_000.)
        }) {
            return fail("标记参数无效");
        }
        if self.layers.len() > 1000
            || self.sources.len() > 1000
            || self.layers.iter().map(|l| l.clips.len()).sum::<usize>() > 5000
        {
            return fail("作品素材数量超出范围");
        }
        if !(2..=7680).contains(&self.canvas.width)
            || !(2..=7680).contains(&self.canvas.height)
            || self.canvas.width % 2 != 0
            || self.canvas.height % 2 != 0
            || !finite_range(self.canvas.fps, 1., 120.)
        {
            return fail("画布尺寸或帧率无效");
        }
        if self.canvas.import_picture.as_ref().is_some_and(|p| !p.valid()) {
            return fail("新素材画面参数无效");
        }
        if !["mp4", "wav", "flac", "mp3"].contains(&self.output.format.as_str()) { return fail("输出格式无效"); }
        let mut ids = HashSet::new();
        for s in &self.sources {
            if !matches!(s.kind.as_str(), "" | "audio" | "video" | "image" | "gif")
                || (s.image() && (s.audio || s.video || s.width == 0 || s.height == 0))
                || (s.kind == "gif" && (s.frame_ends_ms.is_empty() || s.frame_ends_ms.len() > 100_000 || s.frame_ends_ms.iter().any(|v| !finite_range(*v, 0.001, 21_600_000.)) || s.frame_ends_ms.windows(2).any(|v|v[0]>=v[1]) || s.frame_ends_ms.last().is_some_and(|v| (*v-s.duration_ms).abs() > 0.01))) {
                return fail("图片格式或动画时序无效");
            }
            if !ids.insert(&s.id) || !finite_range(s.duration_ms, 1., 21_600_000.) {
                return fail("素材标识或时长无效");
            }
        }
        let mut clips = HashSet::new();
        let mut layers = HashSet::new();
        for l in &self.layers {
            if !layers.insert(&l.id) || self.source(&l.source_id).is_none() {
                return fail("素材行不存在");
            }
            if let Some(g) = &l.grid {
                let duration = self.source(&l.source_id).unwrap().duration_ms / 1000.;
                if !(1..=32).contains(&g.beats_per_bar) || !finite_range(g.downbeat_confidence, 0., 1.)
                    || [&g.beats, &g.downbeats].iter().any(|events| events.iter().any(|&t| !finite_range(t, 0., duration + 0.001)) || events.windows(2).any(|w| w[1] <= w[0]))
                    || g.segments.iter().any(|s| !finite_range(s.bpm, 20., 400.) || !finite_range(s.confidence, 0., 1.) || !finite_range(s.start_seconds, 0., duration) || !finite_range(s.end_seconds, s.start_seconds + 0.000001, duration + 0.001))
                    || g.segments.windows(2).any(|w| w[0].end_seconds > w[1].start_seconds + 0.001) {
                    return fail("小节网格参数无效");
                }
            }
            let mut order: Vec<_> = l.clips.iter().collect();
            order.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
            let mut end = 0.;
            for c in order {
                let s = self.source(&c.source_id).ok_or("片段素材不存在")?;
                if c.source_id != l.source_id
                    || !clips.insert(&c.id)
                    || !finite_range(c.start_ms, 0., 21_600_000.)
                    || !finite_range(c.source_in_ms, 0., s.duration_ms)
                    || !finite_range(
                        c.source_out_ms,
                        c.source_in_ms + 0.001,
                        s.duration_ms + 0.001,
                    )
                {
                    return fail("片段区间越界");
                }
                if s.image() != c.display_duration_ms.is_some()
                    || !finite_range(c.animation_offset_ms, 0., 21_600_000.)
                    || c.display_duration_ms.is_some_and(|d| !finite_range(d, 0.001, 21_600_000.)) {
                    return fail("图片显示时长或动画进度无效");
                }
                let v = &c.speed;
                if !["constant", "ramp", "pulse"].contains(&v.preset.as_str())
                    || ![v.start, v.middle, v.end]
                        .iter()
                        .all(|v| finite_range(*v, 0.5, 2.))
                    || !finite_range(v.domain_start_ms, 0., c.source_in_ms)
                    || !finite_range(v.domain_end_ms, c.source_out_ms, s.duration_ms + 0.001)
                    || v.domain_end_ms <= v.domain_start_ms
                {
                    return fail("速度参数无效");
                }
                if c.video_transition.as_ref().is_some_and(|t| !s.video
                    || !finite_range(t.duration_ms, 0., 10000.) || !(-1..=1).contains(&t.alignment)) {
                    return fail("画面过渡参数无效");
                }
                let duration = c.duration();
                if !finite_range(duration, 0.001, 21_600_000.) || c.start_ms + 0.001 < end {
                    return fail("本行片段重叠，请先移动后续片段");
                }
                end = c.start_ms + duration;
                let p = &c.picture;
                let f = &c.fades;
                if !finite_range(p.x, 0., 1.)
                    || !finite_range(p.y, 0., 1.)
                    || !finite_range(p.scale, 0.1, 2.)
                    || !finite_range(p.opacity, 0., 1.)
                    || !finite_range(p.rotation, -360., 360.)
                    || !p.crop.iter().all(|v| finite_range(*v, 0., 0.99))
                    || p.crop[0] + p.crop[2] >= 0.99 || p.crop[1] + p.crop[3] >= 0.99
                    || !finite_range(c.sound.gain, 0., 2.)
                {
                    return fail("画面或声音参数无效");
                }
                // Scaling an envelope and recomputing a clip's duration use
                // different floating-point operations. Allow the same 0.01 ms
                // rounding margin at both ends, without accepting real overruns.
                if !finite_range(f.span_ms, 0.001, 21_600_000.)
                    || !finite_range(f.offset_ms, 0., 21_600_000.)
                    || f.offset_ms + duration > f.span_ms + 0.01
                {
                    return Err(format!("素材“{}”的淡入淡出范围未覆盖片段", s.title));
                }
                if ![f.video_in_ms, f.video_out_ms, f.audio_in_ms, f.audio_out_ms]
                    .iter()
                    .all(|v| finite_range(*v, 0., f.span_ms / 2. + 0.01))
                {
                    return Err(format!("素材“{}”的淡入淡出时长超出范围", s.title));
                }
            }
        }
        if self.duration() > 21_600_000. {
            return fail("作品长度超过六小时");
        }
        if !finite_range(self.output.in_ms, 0., self.duration())
            || self
                .output
                .out_ms
                .is_some_and(|v| !finite_range(v, self.output.in_ms + 0.001, self.duration()))
            || !(14..=30).contains(&self.output.quality)
        {
            return fail("导出区间或质量无效");
        }
        Ok(())
    }
}
fn finite_range(x: f64, a: f64, b: f64) -> bool {
    x.is_finite() && x >= a && x <= b
}

#[cfg(test)]
mod tests {
    use super::*;
    fn clip() -> Clip {
        Clip {
            video_transition: None,
            display_duration_ms: None, animation_offset_ms: 0.,
            id: "a".into(),
            source_id: "s".into(),
            start_ms: 0.,
            source_in_ms: 0.,
            source_out_ms: 10000.,
            speed: Speed {
                preset: "pulse".into(),
                start: 0.5,
                middle: 2.,
                end: 0.5,
                domain_start_ms: 0.,
                domain_end_ms: 10000.,
            },
            picture: Picture::default(),
            sound: Sound {
                muted: false,
                gain: 1.,
                manual: false,
            },
            fades: Fades::new(10000., true),
        }
    }
    #[test]
    fn split_preserves_speed_and_fade_phase() {
        let c = clip();
        let cut = c.duration() * 0.43;
        let source = c.source_at(cut);
        let mut a = c.clone();
        a.source_out_ms = source;
        let mut b = c.clone();
        b.source_in_ms = source;
        b.fades.offset_ms = cut;
        assert!((a.duration() + b.duration() - c.duration()).abs() < 1e-6);
        for t in [0., 100., 700.] {
            assert!((b.source_at(t) - c.source_at(cut + t)).abs() < 1e-6);
            assert!((b.fades.alpha(t, false) - c.fades.alpha(cut + t, false)).abs() < 1e-9);
        }
    }
    #[test]
    fn canvas_import_picture_is_compatible_and_validated() {
        let old: Canvas = serde_json::from_str(r#"{"width":1920,"height":1080,"fps":30,"initialized":true}"#).unwrap();
        assert_eq!(old.import_picture, Some(PictureLayout::default()));
        let disabled = Canvas { import_picture: None, ..old };
        let roundtrip: Canvas = serde_json::from_str(&serde_json::to_string(&disabled).unwrap()).unwrap();
        assert_eq!(roundtrip.import_picture, None);
        for (x, y, scale, opacity) in [(f64::NAN, 0.5, 1., 1.), (0.5, 2., 1., 1.), (0.5, 0.5, 0., 1.), (0.5, 0.5, 1., 1.1)] {
            assert!(!PictureLayout { x, y, scale, opacity }.valid());
        }
    }
    #[test]
    fn time_map_round_trips() {
        let c = clip();
        for n in 0..100 {
            let s = n as f64 * 100.;
            assert!((c.source_at(c.output_at(s)) - s).abs() < 1e-7);
        }
    }
    #[test]
    fn fade_is_smooth_and_mirrored() {
        let f = Fades::new(1000., true);
        assert!((f.alpha(75., false) - 0.15625).abs() < 1e-9);
        assert!((f.alpha(75., false) - f.alpha(925., false)).abs() < 1e-9);
    }
    #[test]
    fn fade_validation_tolerates_speed_rounding_but_rejects_real_overruns() {
        let mut c = clip();
        c.source_out_ms = 78000.;
        c.speed = Speed::normal(78000.);
        c.speed.start = 0.985;
        c.fades = Fades::new(78000. * (1. / c.speed.start), true);
        assert!(c.fades.span_ms < c.duration(), "reproduce scaling roundoff");
        let mut p = CompositionProject {
            markers: vec![],
            id: "project".into(),
            revision: 0,
            name: "project".into(),
            sources: vec![Source {
                kind: "video".into(), frame_ends_ms: vec![],
                id: "s".into(),
                track_id: 1,
                path: String::new(),
                title: "video".into(),
                duration_ms: 78000.,
                video: true,
                audio: true,
                width: 1920,
                height: 1080,
                fps: 60.,
                signature: String::new(),
            }],
            layers: vec![Layer {
                grid: None,
                id: "layer".into(),
                source_id: "s".into(),
                clips: vec![c],
            }],
            canvas: Canvas::default(),
            output: Output {
                format: "mp4".into(),
                name: String::new(),
                directory: String::new(),
                in_ms: 0.,
                out_ms: None,
                quality: 20,
                acceleration: EncodingAcceleration::Auto,
            },
            migrated_from: None,
        };
        // Exercise the same JSON boundary as saving and reloading an edit.
        p = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(p.validate(), Ok(()));
        let valid = p.layers[0].clips[0].fades.clone();
        for field in ["span", "offset", "fade", "nan"] {
            let f = &mut p.layers[0].clips[0].fades;
            *f = valid.clone();
            match field {
                "span" => f.span_ms -= 1.,
                "offset" => f.offset_ms = 1.,
                "fade" => f.video_in_ms = f.span_ms / 2. + 1.,
                _ => f.span_ms = f64::NAN,
            }
            assert!(p.validate().unwrap_err().contains("video"), "{field}");
        }
        let c = &mut p.layers[0].clips[0];
        c.fades = valid;
        let cut = c.source_at(30000.);
        c.source_in_ms = cut;
        c.fades.offset_ms = 30000.;
        assert_eq!(
            p.validate(),
            Ok(()),
            "split envelope keeps its parent phase"
        );
    }
}
