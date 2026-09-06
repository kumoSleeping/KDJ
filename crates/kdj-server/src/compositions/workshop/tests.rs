use super::super::media_tests::Fixture;
use super::*;
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use kdj_core::AppConfig;
use tower::ServiceExt;
fn manager(f: &Fixture) -> Arc<Workshop> {
    let config = Arc::new(AppConfig::create(f.path("data"), f.path("outputs"), 0));
    std::fs::create_dir_all(f.path("outputs")).unwrap();
    let state = AppState::new(config).unwrap();
    let old = CompositionManager::open(state.clone()).unwrap();
    Workshop::open(state, &old).unwrap()
}
fn edit(p: &CompositionProject) -> Edit {
    Edit {
        name: p.name.clone(),
        layers: p.layers.clone(),
        canvas: p.canvas.clone(),
        output: p.output.clone(),
    }
}

#[tokio::test]
#[ignore = "requires KDJ_TEST_WORKSHOP_JOURNAL and local media; exports into an owned temporary directory"]
async fn local_workshop_export_acceptance() {
    let journal = std::env::var_os("KDJ_TEST_WORKSHOP_JOURNAL").expect("set KDJ_TEST_WORKSHOP_JOURNAL");
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(journal).unwrap()).unwrap();
    let mut p: CompositionProject = serde_json::from_value(value["projects"][0].clone()).unwrap();
    let f = Fixture::new();
    let m = manager(&f);
    p.output.directory = f.path("outputs").to_string_lossy().into_owned();
    if let Ok(seconds) = std::env::var("KDJ_TEST_WORKSHOP_SECONDS") {
        p.output.out_ms = Some(seconds.parse::<f64>().unwrap() * 1000.);
    }
    m.change(|j| { j.projects.push(p.clone()); Ok(()) }).unwrap();
    let began = std::time::Instant::now();
    let snapshot = m.export(&p.id, p.revision).unwrap();
    let jid = snapshot.jobs.last().unwrap().id.clone();
    let mut last_detail = String::new();
    let job = tokio::time::timeout(std::time::Duration::from_secs(600), async {
        loop {
            let job = m.snapshot().jobs.into_iter().find(|j| j.id == jid).unwrap();
            if job.detail != last_detail {
                eprintln!("{:.1}s {} {:.1}%", began.elapsed().as_secs_f64(), job.detail, job.progress * 100.);
                last_detail = job.detail.clone();
            }
            if ["complete", "failed", "import_failed"].contains(&job.phase.as_str()) { break job; }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }).await.expect("full export timed out");
    eprintln!("Export finished in {:.1}s: {} {}", began.elapsed().as_secs_f64(), job.phase, job.error);
    assert_eq!(job.phase, "complete", "{}", job.error);
    let output = media::probe(Path::new(&job.path), &CancellationToken::new()).await.unwrap();
    assert_eq!((output.video().unwrap().width, output.video().unwrap().height), (p.canvas.width, p.canvas.height));
}

#[test]
fn workshop_pixel_aspect_validation_preserves_other_guards() {
    let mut stream = media::Stream {
        width: 1280, height: 720, pix_fmt: "yuv420p".into(),
        sample_aspect_ratio: "639:640".into(), ..Default::default()
    };
    assert_eq!(media::workshop_video_size(&stream).unwrap(), (1278, 720));
    assert!(media::ensure_safe_transcode(&stream).is_err(), "in-place composition remains strict");
    for invalid in ["1:0", "-1:1", "NaN:1", "broken"] {
        stream.sample_aspect_ratio = invalid.into();
        assert!(media::workshop_video_size(&stream).is_err());
    }
    stream.sample_aspect_ratio = "2:1".into();
    stream.pix_fmt = "yuv420p10le".into();
    assert!(media::workshop_video_size(&stream).is_err());
    stream.pix_fmt = "yuv420p".into();
    stream.tags.insert("rotate".into(), "90".into());
    assert!(media::workshop_video_size(&stream).is_err());
    stream.tags.clear();
    stream.side_data_list.push(serde_json::json!({"side_data_type":"Display Matrix"}));
    assert!(media::workshop_video_size(&stream).is_err());
}

#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn workshop_non_square_pixel_export() {
    let f = Fixture::new();
    let mut paths = vec![];
    for sar in ["639/640", "2/1"] {
        paths.push(f.generate(&format!("sar-{}.mp4", paths.len()), &[
            "-f", "lavfi", "-i", "color=red:s=160x90:r=25:d=1",
            "-vf", &format!("setsar={sar}"), "-c:v", "libx264", "-threads", "1",
        ]));
    }
    // Optional read-only acceptance against the user's actual failing source.
    if let Some(path) = std::env::var_os("KDJ_TEST_SAR_SOURCE") {
        paths.push(PathBuf::from(path));
    }
    let m = manager(&f);
    for (index, path) in paths.iter().enumerate() {
        let before = media::signature(path).unwrap();
        let mut p = m.intake(intake::Intake { project_id: None, revision: None,
            track_ids: vec![], paths: vec![path.to_string_lossy().into_owned()], at_ms: 0.
        }).await.unwrap().snapshot.projects.last().unwrap().clone();
        p.canvas = Canvas { width: 320, height: 180, fps: 25., initialized: true, ..Default::default() };
        p.output.out_ms = Some(600.);
        p = m.patch(&p.id, p.revision, edit(&p)).unwrap().projects.last().unwrap().clone();
        if index == 1 {
            // Existing saved projects still contain encoded dimensions.
            m.change(|j| {
                let saved = j.projects.iter_mut().find(|v| v.id == p.id).unwrap();
                saved.sources[0].width = 160;
                saved.sources[0].height = 90;
                Ok(())
            }).unwrap();
        }
        let snapshot = m.export(&p.id, p.revision).unwrap();
        let jid = snapshot.jobs.last().unwrap().id.clone();
        let job = tokio::time::timeout(std::time::Duration::from_secs(60), async {
            loop {
                let job = m.snapshot().jobs.into_iter().find(|j| j.id == jid).unwrap();
                if ["complete", "failed", "import_failed"].contains(&job.phase.as_str()) { break job; }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }).await.expect("SAR export timed out");
        assert_eq!(job.phase, "complete", "{}", job.error);
        let output = media::probe(Path::new(&job.path), &CancellationToken::new()).await.unwrap();
        assert_eq!(output.video().unwrap().sample_aspect_ratio, "1:1");
        assert_eq!(media::signature(path).unwrap(), before, "source stays unchanged");
        if index == 1 {
            let top = sample(Path::new(&job.path), 0.2, 160, 10);
            let center = sample(Path::new(&job.path), 0.2, 160, 90);
            assert!(top.iter().all(|v| *v < 10), "wide video must retain letterboxing: {top:?}");
            assert!(center[0] > 220 && center[1] < 20, "{center:?}");
        }
    }
}
#[tokio::test]
async fn cancellation_acknowledges_cleanup_and_allows_immediate_reexport() {
    let f = Fixture::new();
    let m = manager(&f);
    let mut p = naming::music_project();
    p.output.directory = f.path("outputs").to_string_lossy().into_owned();
    m.change(|j| { j.projects.push(p.clone()); Ok(()) }).unwrap();
    // Hold the renderer so cancellation exercises the just-published receipt
    // without touching media files or relying on timing of an FFmpeg process.
    let _slot = m.export_slots.acquire().await.unwrap();
    for _ in 0..2 {
        let snapshot = m.export(&p.id, p.revision).unwrap();
        let jid = snapshot.jobs.last().unwrap().id.clone();
        assert!(m.jobs.lock().unwrap().contains_key(&jid));
        let (one, two) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            tokio::join!(m.cancel(&jid), m.cancel(&jid))
        }).await.expect("one cancellation must settle without a second click");
        for snapshot in [one.unwrap(), two.unwrap()] {
            let job = snapshot.jobs.iter().find(|j| j.id == jid).unwrap();
            assert_eq!(job.phase, "canceled");
            assert!(job.error.is_empty() && job.detail.is_empty());
            assert_eq!(serde_json::to_value(&snapshot.projects[0]).unwrap(), serde_json::to_value(&p).unwrap());
        }
        assert!(!m.jobs.lock().unwrap().contains_key(&jid));
        assert_eq!(m.cancel(&jid).await.unwrap().revision, m.snapshot().revision);
    }
}
fn sample(path: &Path, seconds: f64, x: u32, y: u32) -> [u8; 3] {
    let output = std::process::Command::new(kdj_providers::ffmpeg::binary().unwrap())
        .args(["-v", "error", "-ss", &seconds.to_string(), "-i"])
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("format=rgb24,crop=1:1:{x}:{y}"),
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout.len(), 3);
    output.stdout.try_into().unwrap()
}
#[tokio::test]
async fn drafts_are_revisioned_duplicates_independent_and_restartable() {
    let f = Fixture::new();
    let m = manager(&f);
    let p = m.create().unwrap().projects[0].clone();
    let mut e = edit(&p);
    e.name = "作品名".into();
    let s = m.patch(&p.id, p.revision, e).unwrap();
    assert!(m.patch(&p.id, p.revision, edit(&p)).is_err());
    let restored = Workshop::open(
        m.state.clone(),
        &CompositionManager::open(m.state.clone()).unwrap(),
    )
    .unwrap();
    assert_eq!(restored.snapshot().projects[0].name, "作品名");
    assert_eq!(
        restored.snapshot().projects[0].revision,
        s.projects[0].revision
    );
}
#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn imported_visuals_follow_saved_picture_layout() {
    let f = Fixture::new();
    let m = manager(&f);
    let mut p = m.create().unwrap().projects[0].clone();
    let layout = PictureLayout { x: 0.25, y: 0.7, scale: 0.5, opacity: 0.65 };
    p.canvas.import_picture = Some(layout.clone());
    p = m.patch(&p.id, p.revision, edit(&p)).unwrap().projects[0].clone();
    let video = f.video("layout.mp4", "blue", 440, 1.);
    let image = f.generate("layout.png", &["-f", "lavfi", "-i", "color=red:s=64x64", "-frames:v", "1"]);
    let audio = f.generate("layout.wav", &["-f", "lavfi", "-i", "sine=frequency=440:duration=1"]);
    let paths = [&video, &image, &audio].map(|p| p.to_string_lossy().into_owned()).to_vec();
    p = m.intake(intake::Intake { project_id: Some(p.id.clone()), revision: Some(p.revision),
        track_ids: vec![], paths, at_ms: 0. }).await.unwrap().snapshot.projects[0].clone();
    assert_eq!(p.canvas.import_picture, Some(layout.clone()), "first video initialization preserves the import layout");
    assert_eq!(p.layers.len(), 3);
    let mut expected = Picture::default();
    layout.apply(&mut expected);
    for layer in &p.layers {
        assert_eq!(layer.clips[0].picture, if p.source(&layer.source_id).unwrap().visual() { expected.clone() } else { Picture::default() });
    }
    let restored = Workshop::open(m.state.clone(), &CompositionManager::open(m.state.clone()).unwrap()).unwrap();
    assert_eq!(restored.snapshot().projects[0].canvas.import_picture, Some(layout));
    drop(restored);
    let previous_layers = p.layers.clone();
    p.canvas.import_picture = None;
    p = m.patch(&p.id, p.revision, edit(&p)).unwrap().projects[0].clone();
    p = m.intake(intake::Intake { project_id: Some(p.id.clone()), revision: Some(p.revision),
        track_ids: vec![], paths: vec![image.to_string_lossy().into_owned()], at_ms: 0. }).await.unwrap().snapshot.projects[0].clone();
    assert_eq!(p.layers[0].clips[0].picture, Picture::default());
    assert_eq!(p.layers[1..], previous_layers);
}
#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn multilayer_export_preview_range_and_pitch_preserving_ramp() {
    let f = Fixture::new();
    let m = manager(&f);
    let base = f.video("blue.mp4", "blue", 440, 9.);
    let top = f.video("red.mp4", "red", 880, 4.);
    let a = m.state.library.upsert_file(&base, "local", "").unwrap();
    let b = m.state.library.upsert_file(&top, "local", "").unwrap();
    let p = m.create().unwrap().projects[0].clone();
    let p = m.add(&p.id, 0, &[a, b, b], 0.).await.unwrap().projects[0].clone();
    assert_eq!(p.sources.len(), 2);
    assert_eq!(p.layers.len(), 3);
    assert_ne!(p.layers[0].clips[0].id, p.layers[1].clips[0].id);
    assert!(p.layers[0].clips[0].sound.muted);
    assert!(!p.layers[2].clips[0].sound.muted);
    let mut p = p;
    p.layers[0].clips[0].picture.scale = 0.5;
    p.layers[1].clips[0].picture.scale = 0.5;
    let c = &mut p.layers[0].clips[0];
    c.speed = Speed {
        preset: "ramp".into(),
        start: 0.5,
        middle: 1.,
        end: 2.,
        domain_start_ms: 0.,
        domain_end_ms: 4000.,
    };
    c.fades = Fades::new(c.duration(), true);
    c.sound.muted = false;
    c.sound.gain = 0.25;
    let p = m.patch(&p.id, p.revision, edit(&p)).unwrap().projects[0].clone();
    p.validate().unwrap();
    let ticket = m.preview(&p.id, p.revision, None).unwrap();
    let preview = m.ticket(&ticket).unwrap();
    let token = CancellationToken::new();
    let first = m.audio_chunk(&p, 0, &token).await.unwrap();
    let second = m.audio_chunk(&p, 1, &token).await.unwrap();
    assert_eq!(first.len(), 48000 * 4 * 8);
    assert_eq!(second.len(), 48000 * 4);
    assert!(
        first
            .chunks_exact(2)
            .any(|b| i16::from_le_bytes([b[0], b[1]]).abs() > 100)
    );
    let proxy = m
        .proxy(&preview, &p.layers[0].clips[0].id, 0)
        .await
        .unwrap();
    let probe = media::probe(&proxy, &token).await.unwrap();
    assert!((probe.check(true).unwrap() as f64 - p.layers[0].clips[0].duration()).abs() < 80.);
    let app = routes::router(m.clone()).with_state(m.state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/workshop/media/{ticket}/audio.wav"))
                .header("range", "bytes=40-63")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    let bytes = to_bytes(response.into_body(), 24).await.unwrap();
    assert_eq!(&bytes[4..], &first[..20]);
    let job_id = id();
    m.change(|j| {
        j.jobs.push(Job {
            id: job_id.clone(),
            project_id: p.id.clone(),
            revision: p.revision,
            phase: "queued".into(),
            progress: 0.,
            detail: String::new(),
            error: String::new(),
            path: String::new(),
            signature: None,
            track_id: None,
        });
        Ok(())
    })
    .unwrap();
    m.render_export(&p, &job_id, &token).await.unwrap();
    let job = m.snapshot().jobs[0].clone();
    assert_eq!(job.phase, "complete");
    assert!(job.track_id.is_some());
    let center = sample(Path::new(&job.path), 2., 80, 44);
    let corner = sample(Path::new(&job.path), 2., 5, 5);
    assert!(center[0] > 180 && center[2] < 60, "{center:?}");
    assert!(corner[2] > 150 && corner[0] < 60, "{corner:?}");
    let tail = sample(Path::new(&job.path), 8.5, 80, 44);
    assert!(tail[2] > 150);
    assert!(base.is_file() && top.is_file());
    let again = m.retry_import(&job_id).await.unwrap();
    assert_eq!(again.jobs[0].track_id, job.track_id);
    m.release(&ticket);
    assert!(m.ticket(&ticket).is_err());
}
#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn preview_repairs_unfinished_cache_and_keeps_subframe_clips() {
    let f = Fixture::new();
    let m = manager(&f);
    let source = f.video("preview.mp4", "green", 440, 1.);
    let tid = m.state.library.upsert_file(&source, "local", "").unwrap();
    let p = m.create().unwrap().projects[0].clone();
    let mut p = m.add(&p.id, 0, &[tid], 0.).await.unwrap().projects[0].clone();
    let ticket = m.preview(&p.id, p.revision, None).unwrap();
    let preview = m.ticket(&ticket).unwrap();
    let cid = &p.layers[0].clips[0].id;
    let path = m.proxy(&preview, cid, 0).await.unwrap();
    let complete = std::fs::read(&path).unwrap();
    // Empty files, header-only MP4s, and faststart MP4s truncated inside mdat
    // must all be rebuilt rather than served as successful cache hits.
    for broken in [vec![], complete[..48].to_vec(), complete[..complete.len() - 100].to_vec()] {
        std::fs::write(&path, broken).unwrap();
        assert_eq!(m.proxy(&preview, cid, 0).await.unwrap(), path);
        let probe = media::probe(&path, &preview.cancel).await.unwrap();
        assert!(probe.check(true).unwrap() >= 960);
        assert_eq!(std::fs::read(&path).unwrap().len(), complete.len());
    }
    m.release(&ticket);
    let clip = &mut p.layers[0].clips[0];
    clip.source_out_ms = 15.603;
    clip.fades = Fades::new(clip.duration(), true);
    p = m.patch(&p.id, p.revision, edit(&p)).unwrap().projects[0].clone();
    let ticket = m.preview(&p.id, p.revision, None).unwrap();
    let preview = m.ticket(&ticket).unwrap();
    let short = m.proxy(&preview, &p.layers[0].clips[0].id, 0).await.unwrap();
    let probe = media::probe(&short, &preview.cancel).await.unwrap();
    assert!(probe.check(true).unwrap() > 0, "short clips still have a video frame");
    assert!(std::fs::read_dir(&m.cache).unwrap().flatten().all(|e| {
        !matches!(e.path().extension().and_then(|e| e.to_str()), Some("part" | "ffgraph"))
    }));
    m.release(&ticket);
}

#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn stale_source_and_cancellation_do_not_publish_output() {
    let f = Fixture::new();
    let m = manager(&f);
    let source = f.video("source.mp4", "green", 220, 1.);
    let tid = m.state.library.upsert_file(&source, "local", "").unwrap();
    let p = m.create().unwrap().projects[0].clone();
    let p = m.add(&p.id, 0, &[tid], 0.).await.unwrap().projects[0].clone();
    let t = m.preview(&p.id, p.revision, None).unwrap();
    let fresh = m.preview(&p.id, p.revision, None).unwrap();
    assert_ne!(
        t, fresh,
        "remounting the same revision gets an independent preview lease"
    );
    m.release(&t);
    assert!(
        m.ticket(&fresh).is_ok(),
        "late release cannot revoke the current editor"
    );
    let t = fresh;
    let preview = m.ticket(&t).unwrap();
    m.release(&t);
    assert!(
        m.proxy(&preview, &p.layers[0].clips[0].id, 0)
            .await
            .is_err()
    );
    std::fs::write(source, b"changed").unwrap();
    assert!(
        m.audio_chunk(&p, 0, &CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_dir(f.path("outputs")).unwrap().count(), 0);
}

#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn migration_is_once_only_and_music_defaults_preserve_manual_choices() {
    let f = Fixture::new();
    let m = manager(&f);
    let video = f.video("old.mp4", "blue", 330, 2.);
    let music = f.generate(
        "music.wav",
        &["-f", "lavfi", "-i", "sine=frequency=550:duration=2"],
    );
    let v = m.state.library.upsert_file(&video, "local", "").unwrap();
    let a = m.state.library.upsert_file(&music, "local", "").unwrap();
    let old = CompositionManager::open(m.state.clone()).unwrap();
    old.enqueue(&[v]).unwrap();
    let migrated = Workshop::open(m.state.clone(), &old).unwrap();
    let p = migrated.snapshot().projects[0].clone();
    assert_eq!(p.layers.len(), 1);
    assert!(p.migrated_from.is_some());
    let mut p = p;
    p.layers[0].clips[0].sound.manual = true;
    let p = migrated
        .patch(&p.id, p.revision, edit(&p))
        .unwrap()
        .projects[0]
        .clone();
    let p = migrated
        .add(&p.id, p.revision, &[a], 0.)
        .await
        .unwrap()
        .projects[0]
        .clone();
    assert!(!p.layers[1].clips[0].sound.muted);
    assert!(!p.layers[0].clips[0].sound.muted);
    migrated.delete(&p.id, p.revision).unwrap();
    let restored = Workshop::open(m.state.clone(), &old).unwrap();
    assert!(
        restored.snapshot().projects.is_empty(),
        "deleted migrated drafts must not reappear"
    );
    let p = restored.create().unwrap().projects[0].clone();
    let p = restored
        .add(&p.id, p.revision, &[v, a], 0.)
        .await
        .unwrap()
        .projects[0]
        .clone();
    assert!(p.layers[1].clips[0].sound.muted);
}

#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn automatic_position_presets_split_shared_recording_without_changing_effects() {
    let f = Fixture::new();
    let m = manager(&f);
    let rate = 8000;
    let pcm: Vec<f32> = (0..110 * rate)
        .map(|i| {
            let t = i as f32 / rate as f32;
            let freq = 180. + 140. * (t * 0.71).sin() + 65. * (t * t * 0.19).sin();
            (0.2 + 0.15 * (t * 3.7 + (t * 0.13).sin() * 4.).sin())
                * (std::f32::consts::TAU * freq * t).sin()
        })
        .collect();
    let edited: Vec<f32> = pcm[..36 * rate]
        .iter()
        .chain(pcm[70 * rate..].iter())
        .copied()
        .collect();
    let write_pcm = |name: &str, samples: &[f32]| {
        let path = f.path(name);
        std::fs::write(
            &path,
            samples
                .iter()
                .flat_map(|s| s.to_le_bytes())
                .collect::<Vec<_>>(),
        )
        .unwrap();
        path
    };
    let full = write_pcm("full.f32", &pcm);
    let short = write_pcm("edited.f32", &edited);
    let music = f.generate(
        "music.wav",
        &[
            "-f",
            "f32le",
            "-ar",
            "8000",
            "-ac",
            "1",
            "-i",
            full.to_str().unwrap(),
            "-c:a",
            "pcm_s16le",
        ],
    );
    let video = f.generate(
        "edit.mp4",
        &[
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=160x90:r=25:d=76",
            "-f",
            "f32le",
            "-ar",
            "8000",
            "-ac",
            "1",
            "-i",
            short.to_str().unwrap(),
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
    );
    let a = m.state.library.upsert_file(&video, "local", "").unwrap();
    let b = m.state.library.upsert_file(&music, "local", "").unwrap();
    let p = m.create().unwrap().projects[0].clone();
    let p = m.add(&p.id, 0, &[a], 0.).await.unwrap().projects[0].clone();
    assert_eq!(m.position_views(&p.id)[0].phase, "waiting");
    let p = m.add(&p.id, p.revision, &[b], 0.).await.unwrap().projects[0].clone();
    let layer = p
        .layers
        .iter()
        .find(|l| p.source(&l.source_id).unwrap().video)
        .unwrap()
        .clone();
    let frame = m
        .source_frame(&p.id, &layer.source_id, 1600., 160)
        .await
        .unwrap();
    assert!(frame.starts_with(&[0xff, 0xd8]));
    assert_eq!(
        frame,
        m.source_frame(&p.id, &layer.source_id, 1600., 160)
            .await
            .unwrap()
    );
    assert!(
        m.source_frame(&p.id, &layer.source_id, f64::NAN, 160)
            .await
            .is_err()
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    let result = loop {
        let view = m
            .position_views(&p.id)
            .into_iter()
            .find(|v| v.layer_id == layer.id)
            .unwrap();
        if view.phase != "analyzing" {
            break view;
        }
        assert!(std::time::Instant::now() < deadline, "matching timed out");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    assert_eq!(result.phase, "ready", "{}", result.reason);
    assert_eq!(
        result.presets.len(),
        2,
        "expected a longest interval and separated shared sections"
    );
    assert!(result.presets[1].placements.len() >= 2);
    assert_eq!(result.applied.as_deref(), Some(result.presets[0].id.as_str()));
    let p = m.snapshot().projects[0].clone();
    assert!(p.revision > 2, "the first choice is saved without a client applying it");
    let positioned = p.layers.iter().find(|l| l.id == layer.id).unwrap();
    assert_eq!(positioned.clips.len(), 1);
    assert!((positioned.clips[0].start_ms - result.presets[0].placements[0].start_ms).abs() < 0.01);
    assert_eq!(positioned.clips[0].source_out_ms, layer.clips[0].source_out_ms);
    assert!(!m.journal.lock().unwrap().pending_positions.contains_key(&format!("{}:{}", p.id, layer.id)));
    let mut e = edit(&p);
    let c = &mut e
        .layers
        .iter_mut()
        .find(|l| l.id == layer.id)
        .unwrap()
        .clips[0];
    c.picture.opacity = 0.37;
    c.sound.gain = 0.63;
    let snapshot = m.patch(&p.id, p.revision, e).unwrap();
    let p = &snapshot.projects[0];
    let one = m
        .apply_positions(&p.id, p.revision, &layer.id, &result.id, "longest")
        .unwrap();
    assert_eq!(
        one.projects[0]
            .layers
            .iter()
            .find(|l| l.id == layer.id)
            .unwrap()
            .clips
            .len(),
        1
    );
    let all = m
        .apply_positions(
            &p.id,
            one.projects[0].revision,
            &layer.id,
            &result.id,
            "sections",
        )
        .unwrap();
    let clips = &all.projects[0]
        .layers
        .iter()
        .find(|l| l.id == layer.id)
        .unwrap()
        .clips;
    assert!(clips.len() >= 2);
    for c in clips {
        assert_eq!(c.picture.opacity, 0.37);
        assert_eq!(c.sound.gain, 0.63);
        assert_eq!(c.speed.start, 1.);
    }
    assert!(
        clips
            .windows(2)
            .all(|v| v[0].start_ms + v[0].duration() <= v[1].start_ms + 0.01)
    );
    let mut changed = edit(&all.projects[0]);
    changed
        .layers
        .iter_mut()
        .find(|l| l.id == layer.id)
        .unwrap()
        .clips[0]
        .start_ms += 100.;
    let newer = m.patch(&p.id, all.projects[0].revision, changed).unwrap();
    assert!(
        m.apply_positions(
            &p.id,
            newer.projects[0].revision,
            &layer.id,
            &result.id,
            "longest"
        )
        .is_err(),
        "manual edits invalidate old suggestions"
    );
    m.cancel_positions(&p.id);
    // Rebuild analysis after a manual move, then apply the shorter alternative.
    // Neither an edit nor a process restart may make the other alternative vanish.
    m.prepare_positions(&p.id).unwrap();
    let wait_ready = |manager: Arc<Workshop>, pid: String, lid: String| async move {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
        loop {
            let view = manager
                .position_views(&pid)
                .into_iter()
                .find(|v| v.layer_id == lid)
                .unwrap();
            if view.phase != "analyzing" {
                break view;
            }
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    };
    let current = wait_ready(m.clone(), p.id.clone(), layer.id.clone()).await;
    assert!(current.applied.is_none(), "manual moves must not be automatically replaced");
    assert_eq!(m.snapshot().projects[0].revision, newer.projects[0].revision);
    assert_eq!(
        current.presets.len(),
        2,
        "manual move retains material analysis domain"
    );
    let one = m
        .apply_positions(
            &p.id,
            newer.projects[0].revision,
            &layer.id,
            &current.id,
            "longest",
        )
        .unwrap();
    m.cancel_positions(&p.id);
    let restarted = Workshop::open(
        m.state.clone(),
        &CompositionManager::open(m.state.clone()).unwrap(),
    )
    .unwrap();
    restarted.prepare_positions(&p.id).unwrap();
    let restored = wait_ready(restarted.clone(), p.id.clone(), layer.id.clone()).await;
    assert!(restored.applied.is_none(), "reopening must not apply the first choice again");
    assert_eq!(restarted.snapshot().projects[0].revision, one.projects[0].revision);
    assert_eq!(
        restored.presets.len(),
        2,
        "restart after longest retains segmented alternative"
    );
    let recovered = restarted
        .apply_positions(
            &p.id,
            one.projects[0].revision,
            &layer.id,
            &restored.id,
            "sections",
        )
        .unwrap();
    assert!(
        recovered.projects[0]
            .layers
            .iter()
            .find(|l| l.id == layer.id)
            .unwrap()
            .clips
            .len()
            >= 2
    );
    restarted.cancel_positions(&p.id);
    // Music-first batch import: each untouched video gets its own first choice,
    // even when another row's completion advances the shared project revision.
    let batch = restarted.create().unwrap().projects.last().unwrap().clone();
    let snapshot = restarted.add(&batch.id, batch.revision, &[b, a, a], 0.).await.unwrap();
    let batch = snapshot.projects.iter().find(|p| p.id == batch.id).unwrap();
    for layer in batch.layers.iter().filter(|l| batch.source(&l.source_id).unwrap().video) {
        let result = wait_ready(restarted.clone(), batch.id.clone(), layer.id.clone()).await;
        assert_eq!(result.applied.as_deref(), Some(result.presets[0].id.as_str()));
    }
    let saved = restarted.snapshot();
    let saved = saved.projects.iter().find(|p| p.id == batch.id).unwrap();
    assert_eq!(saved.revision, batch.revision + 2);
    assert!(saved.layers.iter().filter(|l| saved.source(&l.source_id).unwrap().video)
        .all(|l| l.clips.len() == 1 && l.clips[0].source_in_ms == 0.));
    restarted.cancel_positions(&batch.id);
}

#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn adjacent_cuts_and_smooth_fades_export_without_black_frames() {
    let f = Fixture::new();
    let m = manager(&f);
    let blue = f.video("join-blue.mp4", "blue", 440, 2.);
    let red = f.video("fade-red.mp4", "red", 880, 1.);
    let a = m.state.library.upsert_file(&blue, "local", "").unwrap();
    let b = m.state.library.upsert_file(&red, "local", "").unwrap();
    let p = m.create().unwrap().projects[0].clone();
    let mut p = m.add(&p.id, 0, &[a, b], 0.).await.unwrap().projects[0].clone();
    p.canvas.fps = 30.;
    let base = p.layers[1].clips[0].clone();
    let mut first = base.clone();
    first.source_out_ms = 417.;
    let mut second = base;
    second.id = id();
    second.start_ms = 417.;
    second.source_in_ms = 417.;
    p.layers[1].clips = vec![first, second];
    let top = &mut p.layers[0].clips[0];
    top.start_ms = 800.;
    top.fades = Fades::new(1000., true);
    top.fades.video_in_ms = 400.;
    top.fades.video_out_ms = 400.;
    for c in p.layers.iter_mut().flat_map(|l| &mut l.clips) {
        c.sound.muted = true;
    }
    p.output.acceleration = kdj_core::composition::EncodingAcceleration::Software;
    let jid = id();
    m.change(|j| {
        j.jobs.push(Job {
            id: jid.clone(),
            project_id: p.id.clone(),
            revision: p.revision,
            phase: "queued".into(),
            progress: 0.,
            detail: String::new(),
            error: String::new(),
            path: String::new(),
            signature: None,
            track_id: None,
        });
        Ok(())
    })
    .unwrap();
    m.render_export(&p, &jid, &CancellationToken::new())
        .await
        .unwrap();
    let job = m.snapshot().jobs[0].clone();
    let output = std::process::Command::new(kdj_providers::ffmpeg::binary().unwrap())
        .args([
            "-v",
            "error",
            "-threads",
            "1",
            "-i",
            &job.path,
            "-vf",
            "scale=1:1,format=rgb24",
            "-filter_threads",
            "1",
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let frames: Vec<_> = output.stdout.chunks_exact(3).collect();
    assert_eq!(frames.len(), 60);
    for (n, pixel) in frames.iter().enumerate() {
        assert!(
            pixel[0] as u16 + pixel[2] as u16 > 170,
            "unexpected black/dark frame {n}: {pixel:?}"
        );
    }
    assert!(
        frames[30][0] > 80 && frames[30][2] > 80,
        "S fade midpoint: {:?}",
        frames[30]
    );
    assert!(
        frames[39][0] > 180 && frames[39][2] < 60,
        "fade plateau: {:?}",
        frames[39]
    );
    assert!(
        frames[48][0] > 80 && frames[48][2] > 80,
        "S fade out midpoint: {:?}",
        frames[48]
    );
}

#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn fractional_speed_cuts_preserve_picture_and_intentional_gaps() {
    let f = Fixture::new();
    let m = manager(&f);
    let path = f.video("fractional-cuts.mp4", "blue", 440, 2.);
    let track = m.state.library.upsert_file(&path, "local", "").unwrap();
    let p = m.create().unwrap().projects[0].clone();
    let mut p = m.add(&p.id, 0, &[track], 0.).await.unwrap().projects[0].clone();
    p.canvas.fps = 30.;
    let mut first = p.layers[0].clips[0].clone();
    first.source_out_ms = 970.;
    first.speed.start = 0.985;
    first.sound.muted = true;
    first.fades = Fades::new(first.duration(), false);
    let mut second = first.clone();
    second.id = id();
    second.start_ms = first.duration();
    second.source_in_ms = 970.;
    second.source_out_ms = 1940.;
    second.fades = Fades::new(second.duration(), false);
    let gap_start = second.start_ms + second.duration();
    let mut third = first.clone();
    third.id = id();
    third.start_ms = gap_start + 250.;
    third.source_out_ms = 500.;
    third.fades = Fades::new(third.duration(), false);
    let gap_end = third.start_ms;
    p.layers[0].clips = vec![first, second, third];
    p.output.acceleration = kdj_core::composition::EncodingAcceleration::Software;
    p.validate().unwrap();
    let jid = id();
    m.change(|j| {
        j.jobs.push(Job { id: jid.clone(), project_id: p.id.clone(), revision: p.revision,
            phase: "queued".into(), progress: 0., detail: String::new(), error: String::new(),
            path: String::new(), signature: None, track_id: None });
        Ok(())
    }).unwrap();
    m.render_export(&p, &jid, &CancellationToken::new()).await.unwrap();
    let job = m.snapshot().jobs[0].clone();
    let output = std::process::Command::new(kdj_providers::ffmpeg::binary().unwrap())
        .args(["-v", "error", "-threads", "1", "-i", &job.path, "-vf", "scale=1:1,format=rgb24",
            "-filter_threads", "1", "-f", "rawvideo", "pipe:1"]).output().unwrap();
    assert!(output.status.success());
    let mut gap_frames = 0;
    for (n, pixel) in output.stdout.chunks_exact(3).enumerate() {
        let time = n as f64 * 1000. / p.canvas.fps;
        if time < gap_start || (time >= gap_end && time < p.duration()) {
            assert!(pixel[2] > 170, "unexpected black frame at {time}: {pixel:?}");
        } else if time >= gap_start && time < gap_end {
            assert!(pixel.iter().all(|v| *v < 10), "frame leaked into the gap at {time}: {pixel:?}");
            gap_frames += 1;
        }
    }
    assert!(gap_frames >= 7);
}

/// Read-only local diagnosis: render a short copy into an isolated fixture.
#[tokio::test]
#[ignore = "requires KDJ_WORKSHOP_CHECK_JOURNAL and local source media"]
async fn local_cut_export_check() {
    let path = std::env::var("KDJ_WORKSHOP_CHECK_JOURNAL").expect("explicit project journal required");
    let journal: Journal = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut p = std::env::var("KDJ_WORKSHOP_CHECK_PROJECT").ok()
        .map(|id| journal.projects.iter().find(|p| p.id == id).expect("requested project exists"))
        .unwrap_or(&journal.projects[0]).clone();
    let f = Fixture::new();
    let m = manager(&f);
    p.canvas.width = 640;
    p.canvas.height = 360;
    p.canvas.fps = 30.;
    p.output.directory = f.path("outputs").to_string_lossy().into_owned();
    p.output.name = "cut-check".into();
    let bound = |name: &str, default: f64| std::env::var(name).ok()
        .map(|v| v.parse::<f64>().expect("valid check range")).unwrap_or(default);
    p.output.in_ms = bound("KDJ_WORKSHOP_CHECK_IN_MS", 24_100.);
    p.output.out_ms = Some(bound("KDJ_WORKSHOP_CHECK_OUT_MS", 24_900.));
    p.validate().unwrap();
    let expected_frames = ((p.output.out_ms.unwrap() - p.output.in_ms) * p.canvas.fps / 1000.).round() as usize;
    p.output.acceleration = kdj_core::composition::EncodingAcceleration::Auto;
    let jid = id();
    m.change(|j| {
        j.jobs.push(Job { id: jid.clone(), project_id: p.id.clone(), revision: p.revision,
            phase: "queued".into(), progress: 0., detail: String::new(), error: String::new(),
            path: String::new(), signature: None, track_id: None });
        Ok(())
    }).unwrap();
    m.render_export(&p, &jid, &CancellationToken::new()).await.unwrap();
    let job = m.snapshot().jobs[0].clone();
    let decoded = std::process::Command::new(kdj_providers::ffmpeg::binary().unwrap())
        .args(["-v", "error", "-threads", "1", "-i", &job.path, "-vf", "scale=1:1,format=rgb24", "-filter_threads", "1", "-f", "rawvideo", "pipe:1"])
        .output().unwrap();
    assert!(decoded.status.success());
    let frames: Vec<_> = decoded.stdout.chunks_exact(3).collect();
    assert_eq!(frames.len(), expected_frames);
    let minimum = frames.iter().map(|p| p.iter().map(|v| *v as u16).sum::<u16>()).min().unwrap();
    println!("local cut: {} frames, minimum RGB sum {minimum}; {}", frames.len(), job.detail);
    // Dark authored scenes must not be mistaken for renderer-inserted black.
    // Inspect the corresponding source frame for every near-black output frame.
    for (n, frame) in frames.iter().enumerate().filter(|(_, frame)| frame.iter().map(|v| *v as u16).sum::<u16>() <= 12) {
        let time = p.output.in_ms + n as f64 * 1000. / p.canvas.fps;
        let c = p.layers.iter().flat_map(|l| &l.clips).find(|c| {
            p.source(&c.source_id).is_some_and(|s| s.video)
                && time >= c.start_ms && time < c.start_ms + c.duration()
        }).expect("dark output should have a source frame");
        let s = p.source(&c.source_id).unwrap();
        // fps chooses a neighboring source frame, whereas input -ss selects the
        // first frame after its target. Include one source frame on either side.
        let source_time = (c.source_at(time - c.start_ms) / 1000. - 1. / s.fps.max(1.)).max(0.);
        let source = std::process::Command::new(kdj_providers::ffmpeg::binary().unwrap())
            .args(["-v", "error", "-threads", "1", "-ss", &source_time.to_string(), "-i", &s.path,
                "-vf", "scale=1:1,format=rgb24", "-filter_threads", "1", "-frames:v", "3", "-an", "-f", "rawvideo", "pipe:1"])
            .output().unwrap();
        assert!(source.status.success());
        assert!(source.stdout.len() >= 3);
        let source_sum = source.stdout.chunks_exact(3).map(|f| f.iter().map(|v| *v as u16).sum::<u16>()).min().unwrap();
        println!("dark frame at {time:.3} ms: output {frame:?}, neighboring source frames {:?}", source.stdout);
        assert!(source_sum <= 24, "export introduced a black frame at {time} ms while the source is bright ({source_sum})");
    }
    #[cfg(target_os = "macos")]
    assert!(job.detail.contains("h264_videotoolbox"), "hardware path was not used: {}", job.detail);
}

#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn audition_next_audio_is_preview_only_and_restores_saved_mix() {
    let f = Fixture::new();
    let m = manager(&f);
    let music = f.generate("music.wav", &["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2"]);
    let video = f.video("video.mp4", "blue", 880, 2.);
    let a = m.state.library.upsert_file(&music, "local", "").unwrap();
    let b = m.state.library.upsert_file(&video, "local", "").unwrap();
    let p = m.create().unwrap().projects[0].clone();
    let mut p = m.add(&p.id, 0, &[a, b], 0.).await.unwrap().projects[0].clone();
    m.cancel_positions(&p.id);
    // Match the music-first timeline.
    p.layers.sort_by_key(|l| p.sources.iter().find(|s| s.id == l.source_id).unwrap().video);
    let music_layer = p.layers[0].id.clone();
    let video_layer = p.layers[1].id.clone();
    // Distinct trim/rate/gain/fades must survive switching the audition source.
    let clip = &mut p.layers.last_mut().unwrap().clips[0];
    clip.start_ms = 100.;
    clip.source_in_ms = 200.;
    clip.speed.start = 0.98;
    clip.sound.gain = 0.7;
    clip.fades.audio_in_ms = 80.;
    let p = m.patch(&p.id, p.revision, edit(&p)).unwrap().projects[0].clone();
    let saved = serde_json::to_value(&p).unwrap();
    let normal_ticket = m.preview(&p.id, p.revision, None).unwrap();
    let normal = m.ticket(&normal_ticket).unwrap().project;
    let normal_audio = m.audio_chunk(&normal, 0, &CancellationToken::new()).await.unwrap();
    let ticket = m.preview(&p.id, p.revision, Some(&music_layer)).unwrap();
    let audition = m.ticket(&ticket).unwrap().project;
    assert!(m.ticket(&normal_ticket).is_ok(), "audio audition must retain the live video/audio lease");
    let mut expected = p.clone();
    for layer in &mut expected.layers {
        for clip in &mut layer.clips { clip.sound.muted = layer.id != video_layer; }
    }
    assert_eq!(serde_json::to_value(&audition).unwrap(), serde_json::to_value(&expected).unwrap());
    let audition_audio = m.audio_chunk(&audition, 0, &CancellationToken::new()).await.unwrap();
    assert_ne!(audition_audio, normal_audio, "audition actually changes rendered sound");
    assert!(audition_audio.iter().any(|b| *b != 0), "video original audio is audible");
    assert_eq!(serde_json::to_value(m.project(&p.id, p.revision).unwrap()).unwrap(), saved);
    let restored = m.preview(&p.id, p.revision, None).unwrap();
    let restored = m.ticket(&restored).unwrap().project;
    assert_eq!(serde_json::to_value(&restored).unwrap(), saved);
    assert_eq!(m.audio_chunk(&restored, 0, &CancellationToken::new()).await.unwrap(), normal_audio);
    let mut skipped = p.clone();
    let mut silent_source = skipped.sources[1].clone();
    silent_source.id = id();
    silent_source.audio = false;
    let silent = Layer { id: id(), source_id: silent_source.id.clone(), clips: vec![new_clip(&silent_source, 0.)] };
    skipped.sources.push(silent_source);
    skipped.layers.insert(1, silent);
    skipped.layers.insert(2, Layer { id: id(), source_id: skipped.layers[2].source_id.clone(), clips: vec![] });
    audition_next_layer(&mut skipped, &music_layer);
    for layer in &skipped.layers {
        assert!(layer.clips.iter().all(|c| c.sound.muted == (layer.id != video_layer)), "skip silent and empty rows");
    }
    let mut no_next = p.clone();
    audition_next_layer(&mut no_next, &video_layer);
    assert!(no_next.layers.iter().flat_map(|l| &l.clips).all(|c| c.sound.muted));
    let mut deleted_layer = p.clone();
    audition_next_layer(&mut deleted_layer, "removed");
    assert_eq!(serde_json::to_value(&deleted_layer).unwrap(), saved);
}

#[tokio::test]
async fn image_intake_never_imports_siblings_or_registers_a_directory() {
    let f = Fixture::new();
    let m = manager(&f);
    let selected = f.path("selected.PNG");
    image::RgbaImage::from_pixel(8, 8, image::Rgba([255, 0, 0, 128])).save(&selected).unwrap();
    let sibling = f.path("unselected.png");
    image::RgbaImage::new(8, 8).save(&sibling).unwrap();
    let directory = f.path("folder.png");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("song.mp3"), b"unselected").unwrap();
    let roots = m.state.config.to_settings().library_dirs;
    let result = m.intake(intake::Intake { project_id: None, revision: None, track_ids: vec![],
        paths: vec![selected.to_string_lossy().into_owned(), directory.to_string_lossy().into_owned()], at_ms: 1250. }).await.unwrap();
    assert_eq!(result.errors.len(), 1);
    let project = &result.snapshot.projects[0];
    assert_eq!(project.layers.len(), 1);
    assert_eq!(project.layers[0].clips[0].start_ms, 1250.);
    assert_eq!(project.sources[0].kind, "image");
    assert_eq!(m.state.library.all_paths().unwrap().len(), 1);
    assert_eq!(m.state.config.to_settings().library_dirs, roots);
    assert!(m.state.library.pending_analysis_ids(None, true).unwrap().is_empty());
}

#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn image_gif_intake_alpha_loop_and_restart() {
    use image::{Rgba, RgbaImage, Frame, Delay, codecs::gif::GifEncoder};
    let f=Fixture::new(); let m=manager(&f);
    let png=f.path("透明 图片.png");
    let mut img=RgbaImage::from_pixel(64,64,Rgba([0,0,0,0]));
    for y in 16..48 { for x in 16..48 { img.put_pixel(x,y,Rgba([255,0,0,128])); } }
    img.save(&png).unwrap();
    let gif=f.path("动画.gif");
    let mut encoder=GifEncoder::new(std::fs::File::create(&gif).unwrap());
    encoder.encode_frames([
        Frame::from_parts(RgbaImage::from_pixel(64,64,Rgba([0,255,0,255])),0,0,Delay::from_numer_denom_ms(100,1)),
        Frame::from_parts(RgbaImage::from_pixel(64,64,Rgba([0,0,255,255])),0,0,Delay::from_numer_denom_ms(200,1)),
    ]).unwrap();drop(encoder);
    let broken=f.path("bad.png");std::fs::write(&broken,b"bad").unwrap();
    let result=m.intake(intake::Intake {project_id:None,revision:None,track_ids:vec![],paths:vec![gif.to_string_lossy().into_owned(),png.to_string_lossy().into_owned(),broken.to_string_lossy().into_owned()],at_ms:0.}).await.unwrap();
    assert_eq!(result.errors.len(),1);assert_eq!(result.snapshot.projects.len(),1);
    let mut p=result.snapshot.projects[0].clone();
    assert_eq!(p.sources.len(),2);assert_eq!(p.layers.len(),2);assert_eq!(p.duration(),5000.);
    assert!(!p.canvas.initialized);assert!(p.sources.iter().all(|s|!s.audio && !s.video && s.visual()));
    let animated=p.sources.iter().find(|s|s.kind=="gif").unwrap();
    assert_eq!(animated.frame_ends_ms,vec![100.,300.]);
    let a=m.source_frame(&p.id,&animated.id,110.,160).await.unwrap();
    let b=m.source_frame(&p.id,&animated.id,410.,160).await.unwrap();assert_eq!(a,b);
    assert_eq!(image::load_from_memory(&a).unwrap().to_rgba8().get_pixel(10,10).0,[0,0,255,255]);
    let image=p.sources.iter().find(|s|s.kind=="image").unwrap();
    let raw=m.source_frame(&p.id,&image.id,0.,160).await.unwrap();
    assert_eq!(image::load_from_memory(&raw).unwrap().to_rgba8().get_pixel(0,0).0[3],0);
    assert!(m.state.library.pending_analysis_ids(None,true).unwrap().is_empty());
    assert!(m.state.library.pending_bpm_key_analysis_v2_ids(None,true,None,None).unwrap().is_empty());
    assert!(m.state.library.pending_bpm_key_analysis_v3_ids(None,true,None,None).unwrap().is_empty());
    p.canvas=Canvas {width:64,height:64,fps:30.,initialized:true,..Canvas::default()};
    for l in &mut p.layers {l.clips[0].fades=Fades::new(5000.,false);}
    p.output.out_ms=Some(600.);
    p=m.patch(&p.id,p.revision,edit(&p)).unwrap().projects[0].clone();
    let restored=Workshop::open(m.state.clone(),&CompositionManager::open(m.state.clone()).unwrap()).unwrap();
    assert_eq!(restored.snapshot().projects[0].sources[0].kind,p.sources[0].kind);
    let snapshot=m.export(&p.id,p.revision).unwrap();let jid=snapshot.jobs.last().unwrap().id.clone();
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(60);
    let job=loop {assert!(std::time::Instant::now()<deadline,"image export timed out");let j=m.snapshot().jobs.into_iter().find(|j|j.id==jid).unwrap();if ["complete","failed","import_failed"].contains(&j.phase.as_str()){break j;}tokio::time::sleep(std::time::Duration::from_millis(50)).await;};
    assert_eq!(job.phase,"complete","{}",job.error);
    let green=sample(Path::new(&job.path),0.05,4,4);assert!(green[1]>180,"{green:?}");
    let blue=sample(Path::new(&job.path),0.15,4,4);assert!(blue[2]>180,"{blue:?}");
    let looped=sample(Path::new(&job.path),0.35,4,4);assert!(looped[1]>180,"{looped:?}");
    let mixed=sample(Path::new(&job.path),0.15,32,32);assert!(mixed[0]>90 && mixed[2]>90,"alpha multiplied: {mixed:?}");
    let again=m.intake(intake::Intake {project_id:Some(p.id.clone()),revision:Some(p.revision),track_ids:vec![],paths:vec![png.to_string_lossy().into_owned()],at_ms:1000.}).await.unwrap();
    let updated=&again.snapshot.projects[0];assert_eq!(updated.sources.len(),2);assert_eq!(updated.layers.len(),3);
    assert_eq!(updated.layers[0].clips[0].start_ms,1000.);
    let all_bad=m.intake(intake::Intake {project_id:None,revision:None,track_ids:vec![],paths:vec![broken.to_string_lossy().into_owned()],at_ms:0.}).await.unwrap();assert_eq!(all_bad.snapshot.projects.len(),1);
}

#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn image_corner_positions_export_without_clipping() {
    let f = Fixture::new();
    let m = manager(&f);
    let source = f.path("corner.png");
    image::RgbaImage::from_pixel(64, 32, image::Rgba([255, 0, 0, 255])).save(&source).unwrap();
    let result = m.intake(intake::Intake { project_id: None, revision: None, track_ids: vec![],
        paths: vec![source.to_string_lossy().into_owned()], at_ms: 0. }).await.unwrap();
    let mut p = result.snapshot.projects[0].clone();
    p.canvas = Canvas { width: 64, height: 64, fps: 30., initialized: true, ..Canvas::default() };
    let original = p.layers[0].clips[0].clone();
    let mut checks = vec![];
    p.layers[0].clips.clear();
    for rotation in [0., 90.] {
        for (x, y) in [(0., 0.), (1., 0.), (0., 1.), (1., 1.)] {
            let mut clip = original.clone();
            let n = checks.len();
            clip.id = format!("corner-{n}");
            clip.start_ms = n as f64 * 400.;
            clip.display_duration_ms = Some(400.);
            clip.fades = Fades::new(400., false);
            clip.picture = Picture { x, y, scale: 0.5, rotation, ..Picture::default() };
            p.layers[0].clips.push(clip);
            let (width, height) = if rotation == 0. { (32, 16) } else { (16, 32) };
            let left = if x == 0. { 0 } else { 64-width };
            let top = if y == 0. { 0 } else { 64-height };
            checks.push((n as f64 * 0.4 + 0.2, left, top, width, height));
        }
    }
    p = m.patch(&p.id, p.revision, edit(&p)).unwrap().projects[0].clone();
    let snapshot = m.export(&p.id, p.revision).unwrap();
    let jid = &snapshot.jobs.last().unwrap().id;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let job = loop {
        assert!(std::time::Instant::now() < deadline, "image corner export timed out");
        let job = m.snapshot().jobs.into_iter().find(|j| &j.id == jid).unwrap();
        if ["complete", "failed", "import_failed"].contains(&job.phase.as_str()) { break job; }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    };
    assert_eq!(job.phase, "complete", "{}", job.error);
    for (time, left, top, width, height) in checks {
        for (x, y) in [(left+3, top+3), (left+width-4, top+height-4)] {
            let pixel = sample(Path::new(&job.path), time, x, y);
            assert!(pixel[0] > 200 && pixel[1] < 20, "full image at {time}s ({x},{y}): {pixel:?}");
        }
        let pixel = sample(Path::new(&job.path), time, if left == 0 { 60 } else { 3 }, if top == 0 { 60 } else { 3 });
        assert!(pixel.iter().all(|v| *v < 10), "outside stays empty: {pixel:?}");
    }
}

#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn image_crop_flip_rotate_and_fade_export_in_order() {
    use image::{Rgba,RgbaImage};
    let f=Fixture::new();let m=manager(&f);let path=f.path("quadrants.png");
    let image=RgbaImage::from_fn(64,64,|x,y| if x>=32 {Rgba([0,0,255,255])} else if y<32 {Rgba([255,0,0,255])} else {Rgba([0,255,0,255])});
    image.save(&path).unwrap();
    let result=m.intake(intake::Intake {project_id:None,revision:None,paths:vec![path.to_string_lossy().into_owned()],track_ids:vec![],at_ms:0.}).await.unwrap();
    let mut p=result.snapshot.projects[0].clone();p.canvas=Canvas {width:64,height:64,fps:30.,initialized:true,..Canvas::default()};
    let c=&mut p.layers[0].clips[0];c.display_duration_ms=Some(400.);c.fades=Fades::new(400.,false);c.fades.video_in_ms=200.;
    c.picture.crop=[0.,0.,0.5,0.];c.picture.flip_y=true;c.picture.rotation=90.;c.picture.opacity=0.5;
    // Keep rendering long after the faded still ends: both alpha branches must
    // terminate without buffering frames or leaving the picture on the canvas.
    let mut tail=c.clone();tail.id="transparent-tail".into();tail.start_ms=4600.;tail.picture.opacity=0.;
    p.layers[0].clips.push(tail);
    p=m.patch(&p.id,p.revision,edit(&p)).unwrap().projects[0].clone();
    let snapshot=m.export(&p.id,p.revision).unwrap();let jid=snapshot.jobs.last().unwrap().id.clone();
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(60);
    let job=loop {assert!(std::time::Instant::now()<deadline);let j=m.snapshot().jobs.into_iter().find(|j|j.id==jid).unwrap();if ["complete","failed","import_failed"].contains(&j.phase.as_str()){break j;}tokio::time::sleep(std::time::Duration::from_millis(25)).await;};
    assert_eq!(job.phase,"complete","{}",job.error);
    let path=Path::new(&job.path);
    let left=sample(path,0.3,8,32);let right=sample(path,0.3,56,32);let outside=sample(path,0.3,32,4);let fading=sample(path,0.1,8,32);
    assert!(left[0]>100 && left[0]<155 && left[1]<20,"{left:?}");
    assert!(right[1]>100 && right[1]<155 && right[0]<20,"{right:?}");
    assert!(outside.iter().all(|v|*v<10),"{outside:?}");
    assert!(fading[0]>35 && fading[0]<90,"{fading:?}");
    let after=sample(path,4.8,8,32);
    assert!(after.iter().all(|v|*v<10),"ended image must disappear: {after:?}");
}
