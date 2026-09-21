use super::super::frame_pipe::FrameSource;
use anyhow::{Result, ensure};
use kdj_analysis::visualizer::FeatureTimeline;
use kdj_core::audio_visualizer::Scene;
use std::sync::Arc;

pub(super) struct SpectrumFrames {
    pub scene: Scene,
    pub timeline: Arc<FeatureTimeline>,
}
impl FrameSource for SpectrumFrames {
    fn frame_count(&self) -> u64 {
        self.timeline.frames.len() as u64
    }
    fn frame_bytes(&self) -> usize {
        let (_, _, width, height) = self.scene.spectrum_rect();
        width as usize * height as usize * 4
    }
    fn draw(&self, index: u64, rgba: &mut [u8]) -> Result<()> {
        ensure!(rgba.len() == self.frame_bytes(), "透明帧缓冲区大小错误");
        let frame = self
            .timeline
            .frames
            .get(index as usize)
            .ok_or_else(|| anyhow::anyhow!("频谱帧越界"))?;
        ensure!(
            frame.bands.len() == self.scene.spectrum.bands,
            "频带数量与场景不匹配"
        );
        rgba.fill(0); // Straight RGBA: no chroma key and no black opaque background.
        let (origin, _, width, height) = self.scene.spectrum_rect();
        let scale = height as f64 / 1080.;
        let mut color = self.scene.spectrum.color;
        color[3] = color[3].min(100);
        for y in (0..height).step_by(3) {
            let end = (y + 3).min(height) as f64;
            line(
                rgba,
                width,
                height,
                (self.scene.arc_x(y as f64) - origin as f64, y as f64),
                (self.scene.arc_x(end) - origin as f64, end),
                scale.max(0.75),
                color,
            );
        }
        color = self.scene.spectrum.color;
        for (i, &level) in frame.bands.iter().enumerate() {
            let y = (i as f64 + 0.5) * height as f64 / frame.bands.len() as f64;
            let x = self.scene.arc_x(y) - origin as f64;
            let (nx, ny) = self.scene.arc_normal(y);
            let length = level.clamp(0., 1.) as f64
                * self.scene.spectrum.length
                * self.scene.canvas.width as f64;
            line(
                rgba,
                width,
                height,
                (x - nx * length, y - ny * length),
                (x + nx * length, y + ny * length),
                (1.8 * scale).max(1.),
                color,
            );
        }
        Ok(())
    }
}

fn line(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    a: (f64, f64),
    b: (f64, f64),
    thickness: f64,
    color: [u8; 4],
) {
    let radius = thickness / 2.;
    let x0 = (a.0.min(b.0) - radius - 1.).floor().max(0.) as u32;
    let x1 = (a.0.max(b.0) + radius + 1.)
        .ceil()
        .max(0.)
        .min(width as f64) as u32;
    let y0 = (a.1.min(b.1) - radius - 1.).floor().max(0.) as u32;
    let y1 = (a.1.max(b.1) + radius + 1.)
        .ceil()
        .max(0.)
        .min(height as f64) as u32;
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let length = dx * dx + dy * dy;
    for y in y0..y1 {
        for x in x0..x1 {
            let px = x as f64 + 0.5;
            let py = y as f64 + 0.5;
            let t = if length > 0. {
                ((px - a.0) * dx + (py - a.1) * dy) / length
            } else {
                0.
            }
            .clamp(0., 1.);
            let distance = ((px - a.0 - dx * t).powi(2) + (py - a.1 - dy * t).powi(2)).sqrt();
            let alpha = (radius + 0.5 - distance).clamp(0., 1.) * color[3] as f64 / 255.;
            if alpha == 0. {
                continue;
            }
            let offset = (y as usize * width as usize + x as usize) * 4;
            let old = pixels[offset + 3] as f64 / 255.;
            let combined = alpha + old * (1. - alpha);
            for c in 0..3 {
                pixels[offset + c] = ((color[c] as f64 * alpha
                    + pixels[offset + c] as f64 * old * (1. - alpha))
                    / combined)
                    .round() as u8;
            }
            pixels[offset + 3] = (combined * 255.).round() as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kdj_analysis::visualizer::FeatureFrame;
    #[test]
    fn alpha_is_real_and_arbitrary_seek_replays_identically() {
        let scene = Scene::with_image(
            std::env::temp_dir()
                .join("cover.png")
                .to_string_lossy()
                .into(),
        );
        let timeline = Arc::new(FeatureTimeline {
            version: 1,
            sample_rate: 22050,
            sample_count: 1470,
            fps: 30,
            frames: vec![
                FeatureFrame {
                    bands: vec![0.; 48],
                    bass: 0.,
                    rms: 0.,
                    onset: 0.,
                },
                FeatureFrame {
                    bands: vec![1.; 48],
                    bass: 1.,
                    rms: 1.,
                    onset: 1.,
                },
            ],
        });
        let source = SpectrumFrames { scene, timeline };
        let mut first = vec![0; source.frame_bytes()];
        source.draw(1, &mut first).unwrap();
        // Shared golden with tests/audioVisualizer.test.ts: exact straight RGBA bytes.
        let hash = first.iter().fold(2_166_136_261u32, |h, byte| {
            (h ^ u32::from(*byte)).wrapping_mul(16_777_619)
        });
        assert_eq!(hash, 3_595_654_391);
        assert!(first.chunks_exact(4).filter(|p| p[3] == 0).count() > first.len() / 8);
        assert!(
            first
                .chunks_exact(4)
                .any(|p| p[3] > 0 && p[3] < 255 && p[0] != 0)
        );
        let mut second = vec![255; source.frame_bytes()];
        source.draw(0, &mut second).unwrap();
        source.draw(1, &mut second).unwrap();
        assert_eq!(first, second);
        assert!(source.draw(2, &mut second).is_err());
    }
}
