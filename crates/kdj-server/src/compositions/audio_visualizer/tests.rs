use super::*;
use std::io::Write;
#[cfg(target_os = "macos")]
mod replay;

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "kdj-visualizer-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn fixtures(&self) -> ExportRequest {
        let image = self.0.join("封面 ' [1].png");
        image::RgbaImage::from_fn(240, 320, |x, y| {
            if x < 30 {
                image::Rgba([0, 0, 0, 255])
            } else {
                image::Rgba([
                    (x % 256) as u8,
                    (y % 256) as u8,
                    180,
                    if y < 50 { 96 } else { 255 },
                ])
            }
        })
        .save(&image)
        .unwrap();
        let audio = self.0.join("audio.wav");
        let mut file = std::fs::File::create(&audio).unwrap();
        let sr = 44100u32;
        let samples = sr * 2;
        let bytes = samples * 2;
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + bytes).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&sr.to_le_bytes()).unwrap();
        file.write_all(&(sr * 2).to_le_bytes()).unwrap();
        file.write_all(&2u16.to_le_bytes()).unwrap();
        file.write_all(&16u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&bytes.to_le_bytes()).unwrap();
        for i in 0..samples {
            let t = i as f64 / sr as f64;
            let value =
                (std::f64::consts::TAU * 120. * t).sin() * 0.3 * (0.4 + 0.6 * (t * 2.).fract());
            file.write_all(&((value * 32767.) as i16).to_le_bytes())
                .unwrap();
        }
        let mut scene = Scene::with_image(image.to_string_lossy().into_owned());
        scene.canvas.width = 320;
        scene.canvas.height = 180;
        ExportRequest {
            scene,
            audio_path: audio.to_string_lossy().into_owned(),
            output_path: self.0.join("output.mp4").to_string_lossy().into_owned(),
            acceleration: EncodingAcceleration::Software,
        }
    }
    fn no_stage(&self) -> bool {
        !std::fs::read_dir(&self.0).unwrap().flatten().any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(".kdj-composition-")
        })
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn destination_is_new_local_mp4_only() {
    let scratch = Scratch::new();
    let output = scratch.0.join("existing.mp4");
    std::fs::write(&output, b"original").unwrap();
    assert!(destination(output.to_str().unwrap()).is_err());
    assert_eq!(std::fs::read(&output).unwrap(), b"original");
    assert!(destination("https://example.test/output.mp4").is_err());
    assert!(destination(scratch.0.join("wrong.mkv").to_str().unwrap()).is_err());
}

#[tokio::test]
async fn cancelled_export_cannot_touch_files() {
    let scratch = Scratch::new();
    let request = scratch.fixtures();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = export(&request, &cancel, |_| {}, |_| {}).await;
    assert!(result.is_err());
    assert!(!Path::new(&request.output_path).exists());
    assert!(scratch.no_stage());
}

#[tokio::test]
#[ignore = "requires real desktop FFmpeg; run explicitly for the visualizer pipeline"]
async fn real_ffmpeg_export_preserves_duration_and_cleans_cancelled_work() {
    let scratch = Scratch::new();
    let mut request = scratch.fixtures();
    for (index, mode) in [
        kdj_core::audio_visualizer::DiscMode::Cover,
        kdj_core::audio_visualizer::DiscMode::Disc,
        kdj_core::audio_visualizer::DiscMode::Hidden,
    ]
    .into_iter()
    .enumerate()
    {
        request.scene.disc.mode = mode;
        request.scene.right.rotation_deg = if index == 1 { 25. } else { 0. };
        request.scene.right.mirror_x = index == 1;
        request.scene.left.blur = if index == 1 { 2. } else { 0. };
        request.output_path = scratch
            .0
            .join(format!("output-{index}.mp4"))
            .to_string_lossy()
            .into_owned();
        if index == 2 {
            let second = scratch.0.join("second.png");
            image::RgbaImage::from_pixel(500, 100, image::Rgba([15, 120, 200, 180]))
                .save(&second)
                .unwrap();
            request
                .scene
                .images
                .push(second.to_string_lossy().into_owned());
            request.scene.right.image = 1;
        }
        let result = export(&request, &CancellationToken::new(), |_| {}, |_| {})
            .await
            .unwrap();
        assert_eq!(result.frames, 60);
        assert_eq!(result.duration_ms, 2000);
        assert_eq!((result.width, result.height, result.fps), (320, 180, 30));
        assert!(result.output_bytes > 1000);
        assert!(scratch.no_stage());
        let bytes = std::fs::read(&request.output_path).unwrap();
        assert!(
            export(&request, &CancellationToken::new(), |_| {}, |_| {})
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(&request.output_path).unwrap(), bytes);
    }
    request.output_path = scratch
        .0
        .join("cancelled.mp4")
        .to_string_lossy()
        .into_owned();
    let cancel = CancellationToken::new();
    let result = export(
        &request,
        &cancel,
        |p| {
            if p > 0.15 {
                cancel.cancel();
            }
        },
        |_| {},
    )
    .await;
    assert!(result.is_err());
    assert!(!Path::new(&request.output_path).exists());
    assert!(scratch.no_stage());
    // Mutating an input after FFmpeg has cached it must still prevent publication.
    request.output_path = scratch
        .0
        .join("changed-source.mp4")
        .to_string_lossy()
        .into_owned();
    let changed = std::sync::atomic::AtomicBool::new(false);
    let result = export(
        &request,
        &CancellationToken::new(),
        |p| {
            if p > 0.16 && !changed.swap(true, std::sync::atomic::Ordering::Relaxed) {
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(&request.scene.images[0])
                    .unwrap()
                    .write_all(b"changed")
                    .unwrap();
            }
        },
        |_| {},
    )
    .await;
    assert!(result.is_err());
    assert!(!Path::new(&request.output_path).exists());
    assert!(scratch.no_stage());
}
