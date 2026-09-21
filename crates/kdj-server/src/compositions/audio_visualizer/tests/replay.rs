use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct FailFirstAttempt {
    inner: raster::SpectrumFrames,
    starts: AtomicUsize,
}
impl FrameSource for FailFirstAttempt {
    fn frame_count(&self) -> u64 {
        self.inner.frame_count()
    }
    fn frame_bytes(&self) -> usize {
        self.inner.frame_bytes()
    }
    fn draw(&self, index: u64, output: &mut [u8]) -> Result<()> {
        if index == 0 {
            self.starts.fetch_add(1, Ordering::SeqCst);
        }
        if index == 1 && self.starts.load(Ordering::SeqCst) == 1 {
            anyhow::bail!("injected producer failure after the first hardware frame");
        }
        self.inner.draw(index, output)
    }
}

#[tokio::test]
#[ignore = "requires actual VideoToolbox; verifies consumed-pipe software fallback"]
async fn hardware_failure_restarts_the_entire_frame_source() {
    let scratch = Scratch::new();
    let request = scratch.fixtures();
    let cancel = CancellationToken::new();
    let stage = Stage::new(&scratch.0).unwrap();
    graph::write_masks(&request.scene, &stage.0).unwrap();
    let timeline = Arc::new(
        kdj_analysis::visualizer::analyze(
            Path::new(&request.audio_path),
            &request.scene.spectrum,
            &|| false,
        )
        .unwrap(),
    );
    let args = graph::build(
        &request.scene,
        Path::new(&request.audio_path),
        &stage.0,
        timeline.duration_seconds(),
    );
    let source = Arc::new(FailFirstAttempt {
        inner: raster::SpectrumFrames {
            scene: request.scene.clone(),
            timeline,
        },
        starts: AtomicUsize::new(0),
    });
    let messages = Mutex::new(Vec::new());
    let progress = Mutex::new(Vec::new());
    let result = acceleration::render_frames(
        &args,
        2000,
        &cancel,
        EncodingAcceleration::VideoToolbox,
        |value| progress.lock().unwrap().push(value),
        |message| messages.lock().unwrap().push(message.to_owned()),
        source.clone(),
        (320, 180, 30.),
    )
    .await;
    let messages = messages.into_inner().unwrap();
    assert!(
        messages.iter().any(|s| s == "h264_videotoolbox"),
        "No real hardware attempt: {messages:?}"
    );
    result.unwrap();
    assert!(messages.iter().any(|s| s.contains("硬件失败后回退")));
    assert_eq!(
        source.starts.load(Ordering::SeqCst),
        2,
        "software must restart at frame zero"
    );
    let progress = progress.into_inner().unwrap();
    assert!(progress.windows(2).all(|p| p[1] >= p[0]));
    let output = media::probe(&stage.0.join("render.mp4"), &cancel)
        .await
        .unwrap();
    assert_eq!(output.check(true).unwrap(), 2000);
    assert_eq!(output.check(false).unwrap(), 2000);
}
