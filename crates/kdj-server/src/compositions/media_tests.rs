//! Real local FFmpeg acceptance fixtures; every file lives in an owned temporary directory.
use super::media::*;
use kdj_core::composition::{CompositionOptions, CompositionTimeline, LengthPolicy};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(super) struct Fixture(pub PathBuf);
impl Fixture {
    pub fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "kdj-composition-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    pub fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    pub fn generate(&self, name: &str, args: &[&str]) -> PathBuf {
        let path = self.path(name);
        let output = std::process::Command::new(kdj_providers::ffmpeg::binary().unwrap())
            .args(["-nostdin", "-v", "error", "-n", "-threads", "1"])
            .args(args)
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        path
    }
    pub fn video(&self, name: &str, color: &str, frequency: u32, duration: f64) -> PathBuf {
        self.generate(
            name,
            &[
                "-f",
                "lavfi",
                "-i",
                &format!("color=c={color}:s=160x90:r=25:d={duration}"),
                "-f",
                "lavfi",
                "-i",
                &format!("sine=frequency={frequency}:sample_rate=48000:duration={duration}"),
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-c:a",
                "aac",
                "-threads",
                "1",
                "-shortest",
            ],
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).expect("clean composition fixture");
    }
}

async fn frame(path: &Path, time: f64) -> [f64; 3] {
    let output = tokio::process::Command::new(kdj_providers::ffmpeg::binary().unwrap())
        .args(["-nostdin", "-v", "error", "-ss", &time.to_string(), "-i"])
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "crop=20:20:70:35",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout.len(), 1200);
    let mut rgb = [0.; 3];
    for pixel in output.stdout.chunks_exact(3) {
        for i in 0..3 {
            rgb[i] += pixel[i] as f64 / 400.;
        }
    }
    rgb
}
async fn compose(
    video: &Path,
    audio: &Path,
    output: &Path,
    offset: i64,
    policy: LengthPolicy,
    overlay: bool,
) -> Probe {
    let cancel = CancellationToken::new();
    let vp = probe(video, &cancel).await.unwrap();
    let ap = probe(audio, &cancel).await.unwrap();
    let t = CompositionTimeline::calculate(
        vp.check(true).unwrap(),
        ap.check(overlay).unwrap(),
        offset,
        policy,
    )
    .unwrap();
    let options = CompositionOptions::default();
    let chapters = output.with_extension("ffmeta");
    let shift = vp.chapter_shift(t.black_head_ms);
    if !vp.chapters.is_empty() {
        std::fs::write(&chapters, chapter_metadata(&vp, shift)).unwrap();
    }
    let args = render_args(&Render {
        video_path: video,
        secondary_path: audio,
        video: &vp,
        secondary: &ap,
        timeline: t,
        offset,
        options: &options,
        overlay,
        output,
        chapters: (!vp.chapters.is_empty()).then_some(chapters.as_path()),
    })
    .unwrap();
    let deadline = cancel.clone();
    let watchdog = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        deadline.cancel();
    });
    let result = render(&args, t.duration_ms, &cancel, |_| {}).await;
    watchdog.abort();
    result.unwrap();
    let out = probe(output, &cancel).await.unwrap();
    validate(&vp, &out, t.duration_ms).unwrap_or_else(|e| panic!("{e:#}\n{args:?}\n{out:?}"));
    validate_chapters(&vp, &out, shift).unwrap();
    out
}
fn power(pcm: &[f32], frequency: f64) -> f64 {
    let (mut re, mut im) = (0., 0.);
    for (i, v) in pcm.iter().enumerate() {
        let angle = std::f64::consts::TAU * frequency * i as f64 / 8000.;
        re += *v as f64 * angle.cos();
        im += *v as f64 * angle.sin();
    }
    re * re + im * im
}

#[tokio::test]
#[ignore = "local FFmpeg media acceptance"]
async fn replacement_silence_and_real_black_at_both_ends() {
    let f = Fixture::new();
    let video = f.video("main.mp4", "red", 440, 4.);
    let audio = f.generate(
        "replacement.wav",
        &[
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:duration=6:sample_rate=48000",
        ],
    );
    let original = signature(&video).unwrap();
    let full = f.path("full.mp4");
    let out = compose(&video, &audio, &full, -1000, LengthPolicy::FullAudio, false).await;
    assert_eq!(
        out.streams
            .iter()
            .filter(|s| s.codec_type == "audio")
            .count(),
        1
    );
    for time in [0.3, 5.5] {
        assert!(frame(&full, time).await.iter().all(|v| *v < 8.));
    }
    assert!(frame(&full, 2.).await[0] > 200.);
    let keep = f.path("keep.mp4");
    let out = compose(&video, &audio, &keep, 1000, LengthPolicy::KeepVideo, false).await;
    let samples = pcm(&keep, out.audio().unwrap().index, &CancellationToken::new())
        .await
        .unwrap();
    assert!(samples[1000..5000].iter().all(|v| v.abs() < 0.002));
    let audible = &samples[16000..24000];
    assert!(power(audible, 1000.) > 100. * power(audible, 440.));
    assert_eq!(signature(&video).unwrap(), original);
}

#[tokio::test]
#[ignore = "local FFmpeg media acceptance"]
async fn overlay_is_interval_limited_fades_and_retains_main_audio() {
    let f = Fixture::new();
    let video = f.video("main.mp4", "red", 440, 4.);
    let clip = f.video("clip.mp4", "blue", 1000, 1.6);
    let output = f.path("overlay.mp4");
    let out = compose(&video, &clip, &output, 1200, LengthPolicy::KeepVideo, true).await;
    for time in [0.3, 3.3] {
        let p = frame(&output, time).await;
        assert!(p[0] > 200. && p[2] < 20., "{time}: {p:?}");
    }
    let middle = frame(&output, 2.).await;
    assert!(middle[2] > 200. && middle[0] < 20., "{middle:?}");
    let fade = frame(&output, 1.32).await;
    assert!(fade[0] > 50. && fade[2] > 50., "{fade:?}");
    let samples = pcm(
        &output,
        out.audio().unwrap().index,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let middle = &samples[16000..20000];
    assert!(power(middle, 440.) > 100. * power(middle, 1000.));
    let negative = f.path("negative.mp4");
    compose(
        &video,
        &clip,
        &negative,
        -400,
        LengthPolicy::KeepVideo,
        true,
    )
    .await;
    assert!(frame(&negative, 0.6).await[2] > 200.);
    assert!(frame(&negative, 1.5).await[0] > 200.);
}

#[tokio::test]
#[ignore = "local FFmpeg media acceptance"]
async fn canceled_render_never_touches_source_and_bad_media_is_rejected() {
    let f = Fixture::new();
    let video = f.video("main.mp4", "red", 440, 2.);
    let clip = f.video("clip.mp4", "blue", 1000, 2.);
    let before = signature(&video).unwrap();
    let cancel = CancellationToken::new();
    let vp = probe(&video, &cancel).await.unwrap();
    let ap = probe(&clip, &cancel).await.unwrap();
    let options = CompositionOptions::default();
    let t = CompositionTimeline::calculate(2000, 2000, 0, LengthPolicy::KeepVideo).unwrap();
    let staged = f.path("partial.mp4");
    let args = render_args(&Render {
        video_path: &video,
        secondary_path: &clip,
        video: &vp,
        secondary: &ap,
        timeline: t,
        offset: 0,
        options: &options,
        overlay: true,
        output: &staged,
        chapters: None,
    })
    .unwrap();
    cancel.cancel();
    assert!(render(&args, 2000, &cancel, |_| {}).await.is_err());
    assert_eq!(signature(&video).unwrap(), before);
    let invalid = f.path("invalid.mp4");
    std::fs::write(&invalid, b"not media").unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_secs(5),
            probe(&invalid, &CancellationToken::new())
        )
        .await
        .unwrap()
        .is_err()
    );
}

#[tokio::test]
#[ignore = "local FFmpeg media acceptance"]
async fn subtitles_metadata_and_chapters_survive_prefix_padding() {
    let f = Fixture::new();
    let base = f.video("base.mp4", "red", 440, 4.);
    let subtitles = f.path("captions.srt");
    std::fs::write(&subtitles, "1\n00:00:01,000 --> 00:00:02,000\nChorus\n").unwrap();
    let metadata = f.path("tags.ffmeta");
    std::fs::write(&metadata,";FFMETADATA1\ntitle=Original title\nartist=Original artist\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=500\nEND=2500\ntitle=Chorus\n").unwrap();
    let source = f.generate(
        "tagged.mkv",
        &[
            "-i",
            base.to_str().unwrap(),
            "-i",
            subtitles.to_str().unwrap(),
            "-i",
            metadata.to_str().unwrap(),
            "-map",
            "0",
            "-map",
            "1",
            "-map_metadata",
            "2",
            "-map_chapters",
            "2",
            "-c",
            "copy",
            "-metadata:s:s:0",
            "language=eng",
        ],
    );
    let audio = f.generate(
        "audio.wav",
        &["-f", "lavfi", "-i", "sine=frequency=1000:duration=6"],
    );
    let output = f.path("result.mkv");
    let out = compose(
        &source,
        &audio,
        &output,
        -1000,
        LengthPolicy::FullAudio,
        false,
    )
    .await;
    assert_eq!(out.chapters.len(), 1);
    assert!(out.streams.iter().any(|s| s.codec_type == "subtitle"));
    assert!(
        out.format
            .tags
            .iter()
            .any(|(k, v)| k.eq_ignore_ascii_case("title") && v == "Original title")
    );
}

#[tokio::test]
#[ignore = "local FFmpeg media acceptance"]
async fn lossy_chorus_alignment_is_within_fifty_milliseconds() {
    let f = Fixture::new();
    let mut seed = 17u32;
    let samples: Vec<f32> = (0..48 * 8000)
        .map(|i| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let t = i as f32 / 8000.;
            let frequency = 180. + 140. * (t * 0.71).sin() + 65. * (t * t * 0.19).sin();
            (0.2 + 0.15 * (t * 3.7 + (t * 0.13).sin() * 4.).sin())
                * (std::f32::consts::TAU * frequency * t).sin()
                + (seed as f32 / u32::MAX as f32 - 0.5) * 0.01
        })
        .collect();
    let raw = f.path("signal.f32");
    std::fs::write(
        &raw,
        samples
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let full = f.generate(
        "full.m4a",
        &[
            "-f",
            "f32le",
            "-ar",
            "8000",
            "-ac",
            "1",
            "-i",
            raw.to_str().unwrap(),
            "-ar",
            "48000",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
        ],
    );
    let clip = f.generate(
        "clip.mp3",
        &[
            "-f",
            "f32le",
            "-ar",
            "8000",
            "-ac",
            "1",
            "-i",
            raw.to_str().unwrap(),
            "-ss",
            "21.23",
            "-t",
            "9",
            "-af",
            "volume=0.31",
            "-ar",
            "44100",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "128k",
        ],
    );
    let cancel = CancellationToken::new();
    let a = pcm(&clip, 0, &cancel).await.unwrap();
    let b = pcm(&full, 0, &cancel).await.unwrap();
    let result = kdj_analysis::alignment::align_segment(&a, &b, || false).unwrap();
    assert!(result.matched, "{result:?}");
    assert!((result.offset_ms - 21230).abs() <= 50, "{result:?}");
}

#[tokio::test]
#[ignore = "local FFmpeg media acceptance"]
async fn manual_source_trim_and_audio_mix_follow_selected_range() {
    use kdj_core::composition::{AudioMixMode, CompositionSegment, OverlayAudio};
    let f = Fixture::new();
    let main = f.video("main.mp4", "red", 440, 6.);
    let secondary = f.video("clip.mp4", "blue", 1000, 4.);
    let cancel = CancellationToken::new();
    let vp = probe(&main, &cancel).await.unwrap();
    let ap = probe(&secondary, &cancel).await.unwrap();
    let mut options = CompositionOptions::default();
    options.segment = CompositionSegment {
        source_start_ms: 1000,
        source_end_ms: Some(3000),
    };
    options.overlay.fade_ms = 0;
    options.overlay.audio = OverlayAudio::Mix;
    options.audio.mode = AudioMixMode::Mix;
    options.audio.gain = 0.5;
    options.audio.fade_in_ms = 300;
    options.audio.fade_out_ms = 300;
    let timeline = options
        .segment
        .timeline(6000, 4000, 1000, LengthPolicy::KeepVideo)
        .unwrap();
    // Both visual overlay and audio-only replacement must select source 1–3s at main 2–4s.
    for overlay in [true, false] {
        let out_path = f.path(if overlay { "overlay.mp4" } else { "audio.mp4" });
        let args = render_args(&Render {
            video_path: &main,
            secondary_path: &secondary,
            video: &vp,
            secondary: &ap,
            timeline,
            offset: 1000,
            options: &options,
            overlay,
            output: &out_path,
            chapters: None,
        })
        .unwrap();
        render(&args, 6000, &cancel, |_| {}).await.unwrap();
        let out = probe(&out_path, &cancel).await.unwrap();
        validate(&vp, &out, 6000).unwrap();
        if overlay {
            for time in [1.5, 4.5] {
                let rgb = frame(&out_path, time).await;
                assert!(rgb[0] > 180. && rgb[2] < 30.);
            }
            let rgb = frame(&out_path, 3.).await;
            assert!(rgb[2] > 180. && rgb[0] < 30.);
        }
        let samples = pcm(&out_path, out.audio().unwrap().index, &cancel)
            .await
            .unwrap();
        let before = &samples[8000..12000];
        let during = &samples[20000..24000];
        let after = &samples[36000..40000];
        assert!(
            power(before, 440.) > power(before, 1000.) * 100.,
            "overlay={overlay} before440={} before1000={} during440={} during1000={} after440={} after1000={} args={args:?}",
            power(before, 440.),
            power(before, 1000.),
            power(during, 440.),
            power(during, 1000.),
            power(after, 440.),
            power(after, 1000.)
        );
        assert!(power(after, 440.) > power(after, 1000.) * 100.);
        assert!(power(during, 1000.) > power(before, 1000.) * 100.);
        assert!(power(during, 440.) > power(during, 1000.));
    }
}
