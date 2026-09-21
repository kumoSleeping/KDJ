//! Versioned, deterministic scene contract for the desktop audio-video exporter.
//! Coordinates are normalized; time is always source-audio time, never wall time.
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}
impl Default for Canvas {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct ImageTransform {
    pub image: usize,
    pub focus_x: f64,
    pub focus_y: f64,
    pub zoom: f64,
    pub rotation_deg: f64,
    pub mirror_x: bool,
    pub mirror_y: bool,
    pub blur: f64,
}
impl Default for ImageTransform {
    fn default() -> Self {
        Self {
            image: 0,
            focus_x: 0.5,
            focus_y: 0.5,
            zoom: 1.,
            rotation_deg: 0.,
            mirror_x: false,
            mirror_y: false,
            blur: 0.,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct ArcBoundary {
    pub position: f64,
    pub bend: f64,
}
impl Default for ArcBoundary {
    fn default() -> Self {
        Self {
            position: 0.60,
            bend: 0.14,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiscMode {
    Hidden,
    Disc,
    #[default]
    Cover,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Disc {
    pub mode: DiscMode,
    pub image: usize,
    pub x: f64,
    pub y: f64,
    /// Diameter relative to the shorter canvas edge.
    pub size: f64,
    pub rpm: f64,
    pub direction: i8,
}
impl Default for Disc {
    fn default() -> Self {
        Self {
            mode: DiscMode::Cover,
            image: 0,
            x: 0.27,
            y: 0.52,
            size: 0.60,
            rpm: 6.,
            direction: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Spectrum {
    pub bands: usize,
    /// Maximum length on each side, relative to canvas width.
    pub length: f64,
    pub sensitivity: f64,
    /// Per-30-Hz-frame release retention, baked into the shared feature timeline.
    pub smoothing: f64,
    pub color: [u8; 4],
}
impl Default for Spectrum {
    fn default() -> Self {
        Self {
            bands: 48,
            length: 0.075,
            sensitivity: 1.,
            smoothing: 0.72,
            color: [129, 209, 246, 220],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Scene {
    pub version: u32,
    pub canvas: Canvas,
    /// Asset slots, not per-layer copies. No third image slot is accepted.
    pub images: Vec<String>,
    pub left: ImageTransform,
    pub right: ImageTransform,
    pub arc: ArcBoundary,
    pub disc: Disc,
    pub spectrum: Spectrum,
}
impl Default for Scene {
    fn default() -> Self {
        Self {
            version: 1,
            canvas: Canvas::default(),
            images: vec![],
            left: ImageTransform::default(),
            right: ImageTransform::default(),
            arc: ArcBoundary::default(),
            disc: Disc::default(),
            spectrum: Spectrum::default(),
        }
    }
}

fn between(v: f64, lo: f64, hi: f64) -> bool {
    v.is_finite() && (lo..=hi).contains(&v)
}
impl Scene {
    pub fn with_image(image: String) -> Self {
        Self {
            images: vec![image],
            ..Self::default()
        }
    }

    /// Check the contract before opening files or allocating a raster.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1 {
            return Err("不支持的可视化工程版本");
        }
        let c = &self.canvas;
        if c.width < 320
            || c.height < 180
            || c.width > 2560
            || c.height > 1440
            || c.width % 2 != 0
            || c.height % 2 != 0
            || c.fps != 30
        {
            return Err("首版画布需为偶数尺寸，320×180 至 2560×1440，30 fps");
        }
        if !(1..=2).contains(&self.images.len())
            || self.images.iter().any(|p| !Path::new(p).is_absolute())
        {
            return Err("需要一至两张本地图片");
        }
        for image in [&self.left, &self.right] {
            if image.image >= self.images.len()
                || !between(image.focus_x, 0., 1.)
                || !between(image.focus_y, 0., 1.)
                || !between(image.zoom, 1., 4.)
                || !between(image.rotation_deg, -180., 180.)
                || !between(image.blur, 0., 20.)
            {
                return Err("图片变换参数无效");
            }
        }
        if !between(self.arc.position, 0.25, 0.75) || !between(self.arc.bend, -0.20, 0.20) {
            return Err("弧线参数无效");
        }
        let d = &self.disc;
        if d.image >= self.images.len()
            || !between(d.size, 0.1, 0.85)
            || !between(d.x, 0., 1.)
            || !between(d.y, 0., 1.)
            || !between(d.rpm, 0., 60.)
            || ![-1, 1].contains(&d.direction)
        {
            return Err("唱片参数无效");
        }
        let s = &self.spectrum;
        if !(16..=96).contains(&s.bands)
            || !between(s.length, 0.005, 0.15)
            || !between(s.sensitivity, 0.1, 4.)
            || !between(s.smoothing, 0., 0.98)
        {
            return Err("频谱参数无效");
        }
        Ok(())
    }

    pub fn arc_x(&self, y: f64) -> f64 {
        let u = y / self.canvas.height as f64;
        self.canvas.width as f64
            * (self.arc.position + self.arc.bend * (4. * (u - 0.5).powi(2) - 1.))
    }
    pub fn arc_normal(&self, y: f64) -> (f64, f64) {
        let slope = self.canvas.width as f64 / self.canvas.height as f64
            * self.arc.bend
            * 8.
            * (y / self.canvas.height as f64 - 0.5);
        let norm = (1. + slope * slope).sqrt();
        (1. / norm, -slope / norm)
    }
    /// Only this stripe crosses the binary pipe, never the whole base image.
    pub fn spectrum_rect(&self) -> (u32, u32, u32, u32) {
        let w = self.canvas.width as f64;
        let a = self.arc.position * w;
        let b = (self.arc.position - self.arc.bend) * w;
        let margin = self.spectrum.length * w + 4.;
        let x = (a.min(b) - margin).floor().max(0.) as u32;
        let end = (a.max(b) + margin).ceil().min(w) as u32;
        (x, 0, end - x, self.canvas.height)
    }
    pub fn disc_angle(&self, seconds: f64) -> f64 {
        seconds * std::f64::consts::TAU * self.disc.rpm / 60. * self.disc.direction as f64
    }
    /// Pre-rotation crop size; rotating this rectangle covers the final viewport.
    pub fn crop_extent(width: f64, height: f64, degrees: f64) -> (u32, u32) {
        let (sin, cos) = degrees.to_radians().sin_cos();
        let even = |v: f64| ((v / 2.).ceil() as u32 * 2).max(2);
        (
            even(width * cos.abs() + height * sin.abs()),
            even(width * sin.abs() + height * cos.abs()),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scene() -> Scene {
        Scene::with_image(
            std::env::temp_dir()
                .join("cover.png")
                .to_string_lossy()
                .into(),
        )
    }
    #[test]
    fn validates_before_allocating_or_opening_assets() {
        assert!(Scene::default().validate().is_err());
        let mut s = scene();
        assert!(s.validate().is_ok());
        s.images.push(s.images[0].clone());
        assert!(s.validate().is_ok());
        s.images.push(s.images[0].clone());
        assert!(s.validate().is_err());
        s = scene();
        s.left.zoom = f64::NAN;
        assert!(s.validate().is_err());
        s = scene();
        s.canvas.fps = 60;
        assert!(s.validate().is_err());
        s = scene();
        s.right.image = 1;
        assert!(s.validate().is_err());
        s = scene();
        s.canvas.width = u32::MAX;
        assert!(s.validate().is_err());
    }
    #[test]
    fn geometry_is_time_based_and_stripe_is_bounded() {
        let s = scene();
        assert!((s.arc_x(0.) - 1152.).abs() < 1e-8);
        assert!((s.arc_x(540.) - 883.2).abs() < 1e-8);
        assert_eq!(s.spectrum_rect(), (735, 0, 565, 1080));
        assert!((s.disc_angle(5.) - std::f64::consts::PI).abs() < 1e-8);
        let (x, y) = s.arc_normal(540.);
        assert_eq!((x, y), (1., -0.));
        assert_eq!(Scene::crop_extent(1920., 1080., 90.), (1082, 1920));
    }
    #[test]
    fn serialized_contract_round_trips_and_rejects_unknown_fields() {
        let s = scene();
        assert_eq!(
            s,
            serde_json::from_slice::<Scene>(&serde_json::to_vec(&s).unwrap()).unwrap()
        );
        assert!(serde_json::from_str::<Scene>(r#"{"mystery":1}"#).is_err());
    }
}
