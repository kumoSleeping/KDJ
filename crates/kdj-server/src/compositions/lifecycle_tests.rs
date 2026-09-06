use super::media_tests::Fixture;
use super::*;
use kdj_core::{AppConfig, models::TrackPatch};

fn manager(f: &Fixture) -> Arc<CompositionManager> {
    let config = Arc::new(AppConfig::create(f.path("data"), f.path("outputs"), 0));
    CompositionManager::open(AppState::new(config).unwrap()).unwrap()
}
async fn idle(manager: &CompositionManager) {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if manager.inner.lock().unwrap().runs.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("composition workers settled");
}

#[tokio::test]
#[ignore = "local FFmpeg lifecycle acceptance"]
async fn drag_only_pairing_versions_cancel_restart_and_import_receipts() {
    let f = Fixture::new();
    let m = manager(&f);
    let v1 = f.video("one.mp4", "red", 440, 2.);
    let v2 = f.video("two.mp4", "blue", 440, 2.);
    let v1id = m.state.library.upsert_file(&v1, "local", "").unwrap();
    let v2id = m.state.library.upsert_file(&v2, "local", "").unwrap();
    let rows = m.enqueue(&[v1id, v2id]).unwrap().tasks;
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| row.audio.is_none()));
    let target = rows[0].id.clone();
    m.stack_video(&rows[1].video.as_ref().unwrap().id, &target)
        .unwrap();
    idle(&m).await;
    let row = m.snapshot().tasks[0].clone();
    assert_eq!(m.snapshot().tasks.len(), 1);
    assert_eq!(row.audio.as_ref().unwrap().track_id, v2id);
    assert_eq!(row.phase, CompositionPhase::NeedsReview);
    assert!(
        m.patch(&target, row.generation, None, Some(5000), Some(true))
            .is_err(),
        "cannot confirm no overlap"
    );
    m.patch(&target, row.generation, None, Some(0), Some(true))
        .unwrap();
    assert!(
        m.patch(&target, row.generation, None, Some(0), Some(true))
            .is_err(),
        "reject old generation"
    );
    let generation = m.snapshot().tasks[0].generation;
    m.reanalyze(&target, generation).unwrap();
    m.cancel(None).unwrap();
    idle(&m).await;
    assert!(
        m.update(&target, generation, |record| {
            record.task.force_confirmed = true;
            Ok(())
        })
        .is_err()
    );
    assert_eq!(m.snapshot().tasks[0].phase, CompositionPhase::Canceled);
    let restored = CompositionManager::open(m.state.clone()).unwrap();
    assert!(!restored.snapshot().tasks[0].released);
    assert_ne!(restored.snapshot().session_id, m.snapshot().session_id);
    restored
        .reanalyze(&target, restored.snapshot().tasks[0].generation)
        .unwrap();
    idle(&restored).await;
    let row = restored.snapshot().tasks[0].clone();
    let mut options = row.video.as_ref().unwrap().options.clone();
    options.output_mode = OutputMode::Overwrite;
    restored
        .state
        .library
        .patch(
            v1id,
            &TrackPatch {
                rating: Some(4),
                comment: Some("保留人工备注".into()),
                cue_ms: Some(300),
                ..Default::default()
            },
        )
        .unwrap();
    restored
        .patch(&target, row.generation, Some(options), Some(0), Some(true))
        .unwrap();
    let original = media::signature(&v1).unwrap();
    restored.start(None).unwrap();
    idle(&restored).await;
    assert!(
        restored.snapshot().tasks.is_empty(),
        "{:?}",
        restored.snapshot().tasks
    );
    assert_ne!(media::signature(&v1).unwrap(), original);
    let track = restored.state.library.get(v1id).unwrap().unwrap();
    assert_eq!(track.rating, 4);
    assert_eq!(track.comment, "保留人工备注");
    assert_eq!(track.id, v1id);
    // The receipt transaction is idempotent: a recovery retry cannot shift cues twice.
    restored
        .state
        .library
        .replace_media_content(v1id, &v1, 1000, "test-idempotent")
        .unwrap();
    let once = restored.state.library.get(v1id).unwrap().unwrap();
    restored
        .state
        .library
        .replace_media_content(v1id, &v1, 1000, "test-idempotent")
        .unwrap();
    assert_eq!(
        restored.state.library.get(v1id).unwrap().unwrap().cue_ms,
        once.cue_ms
    );
    assert_eq!(once.cue_ms, Some(1300));
}

#[tokio::test]
#[ignore = "local FFmpeg lifecycle acceptance"]
async fn import_failure_retry_keeps_the_committed_file_and_original_identity() {
    let f = Fixture::new();
    let m = manager(&f);
    let source = f.video("original.mp4", "red", 440, 2.);
    let replacement = f.generate(
        "replacement.wav",
        &["-f", "lavfi", "-i", "sine=frequency=1000:duration=2"],
    );
    let video = m.state.library.upsert_file(&source, "local", "").unwrap();
    let audio = m
        .state
        .library
        .upsert_file(&replacement, "local", "")
        .unwrap();
    m.state
        .library
        .patch(
            video,
            &TrackPatch {
                title: Some("人工标题".into()),
                rating: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
    m.enqueue(&[video, audio]).unwrap();
    idle(&m).await;
    let row = m.snapshot().tasks[0].clone();
    let mut options = row.video.as_ref().unwrap().options.clone();
    options.output_mode = OutputMode::Overwrite;
    m.patch(&row.id, row.generation, Some(options), Some(0), Some(true))
        .unwrap();
    // Deliberately corrupt an authored field so the import transaction fails closed.
    let db = kdj_library::Database::open(&m.state.config.db_path()).unwrap();
    db.conn()
        .unwrap()
        .execute(
            "UPDATE tracks SET cue_points_json = 'invalid' WHERE id = ?",
            [video],
        )
        .unwrap();
    m.start(None).unwrap();
    idle(&m).await;
    let failed = m.snapshot().tasks[0].clone();
    assert_eq!(failed.phase, CompositionPhase::ImportFailed, "{failed:?}");
    let committed = media::signature(&source).unwrap();
    // A watcher cannot rewrite authored metadata during the recoverable import failure.
    assert_eq!(
        m.state.library.upsert_file(&source, "local", "").unwrap(),
        video
    );
    db.conn()
        .unwrap()
        .execute(
            "UPDATE tracks SET cue_points_json = '[]' WHERE id = ?",
            [video],
        )
        .unwrap();
    let recovered = CompositionManager::open(m.state.clone()).unwrap();
    assert_eq!(
        recovered.snapshot().tasks[0].phase,
        CompositionPhase::ImportFailed
    );
    assert!(!recovered.snapshot().tasks[0].released);
    recovered.start(None).unwrap();
    idle(&recovered).await;
    assert!(
        recovered.snapshot().tasks.is_empty(),
        "{:?}",
        recovered.snapshot().tasks
    );
    assert_eq!(
        media::signature(&source).unwrap(),
        committed,
        "retry must not render again"
    );
    let track = m.state.library.get(video).unwrap().unwrap();
    assert_eq!(track.title, "人工标题");
    assert_eq!(track.rating, 5);
}

#[tokio::test]
async fn at_most_two_workers_and_cancellation_preserves_all_pairs() {
    let f = Fixture::new();
    let m = manager(&f);
    m.change(|journal| {
        for index in 0..4 {
            let entry = |lane: &str| CompositionEntry {
                id: format!("{lane}{index}"),
                track_id: index + 1,
                path: f
                    .path(&format!("{lane}{index}"))
                    .to_string_lossy()
                    .into_owned(),
                title: lane.into(),
                artist: String::new(),
                format: "mp4".into(),
                is_video: lane == "v",
                duration_ms: 1000,
                options: journal.defaults.clone(),
            };
            journal
                .records
                .push(new_record(Some(entry("v")), Some(entry("a")), 1));
        }
        Ok(())
    })
    .unwrap();
    m.kick();
    {
        let inner = m.inner.lock().unwrap();
        assert_eq!(inner.runs.len(), 2);
        assert!(inner.journal.records[..2].iter().all(|r| r.task.busy));
        assert!(!inner.journal.records[2].task.busy);
    }
    m.cancel(None).unwrap();
    idle(&m).await;
    assert_eq!(m.snapshot().tasks.len(), 4);
    assert!(
        m.snapshot()
            .tasks
            .iter()
            .all(|t| t.phase == CompositionPhase::Canceled && t.complete_pair())
    );
}

#[tokio::test]
#[ignore = "local FFmpeg lifecycle acceptance"]
async fn released_snapshot_excludes_later_enqueues_and_new_file_names_do_not_clobber() {
    let f = Fixture::new();
    let m = manager(&f);
    let video = f.video("main.mp4", "red", 440, 2.);
    let audio = f.generate(
        "sound.wav",
        &["-f", "lavfi", "-i", "sine=frequency=1000:duration=2"],
    );
    let vid = m.state.library.upsert_file(&video, "local", "").unwrap();
    let aid = m.state.library.upsert_file(&audio, "local", "").unwrap();
    m.enqueue(&[vid, aid]).unwrap();
    idle(&m).await;
    let row = m.snapshot().tasks[0].clone();
    m.patch(&row.id, row.generation, None, Some(0), Some(true))
        .unwrap();
    let target = f.path("outputs").join("main [合成].mp4");
    std::fs::write(&target, b"existing user file").unwrap();
    m.start(None).unwrap();
    m.enqueue(&[vid, aid]).unwrap();
    idle(&m).await;
    let rows = m.snapshot().tasks;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(!rows[0].released);
    assert_ne!(rows[0].id, row.id);
    assert_eq!(std::fs::read(&target).unwrap(), b"existing user file");
    assert!(f.path("outputs").join("main [合成] (1).mp4").is_file());
    assert!(std::fs::read_dir(f.path("outputs")).unwrap().all(|e| {
        !e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".kdj-composition-")
    }));
    m.remove(None, None).unwrap();
    assert!(m.snapshot().tasks.is_empty());
}

#[tokio::test]
#[ignore = "local FFmpeg lifecycle acceptance"]
async fn silent_overlay_can_be_manually_placed_and_invalid_trim_is_transactional() {
    let f = Fixture::new();
    let m = manager(&f);
    let main = f.video("main.mp4", "red", 440, 4.);
    let clip = f.generate(
        "silent.mp4",
        &[
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=160x90:r=25:d=3",
            "-an",
            "-c:v",
            "libx264",
            "-threads",
            "1",
        ],
    );
    let main_id = m.state.library.upsert_file(&main, "local", "").unwrap();
    let clip_id = m.state.library.upsert_file(&clip, "local", "").unwrap();
    let rows = m.enqueue(&[main_id, clip_id]).unwrap().tasks;
    m.stack_video(&rows[1].video.as_ref().unwrap().id, &rows[0].id)
        .unwrap();
    idle(&m).await;
    let row = m.snapshot().tasks[0].clone();
    assert_eq!(row.phase, CompositionPhase::NeedsReview);
    assert!(row.error.contains("声音"));
    let mut options = row.video.as_ref().unwrap().options.clone();
    options.segment = CompositionSegment {
        source_start_ms: 1_000,
        source_end_ms: Some(10_000),
    };
    assert!(
        m.patch(
            &row.id,
            row.generation,
            Some(options.clone()),
            Some(1_000),
            Some(true)
        )
        .is_err()
    );
    assert_eq!(m.snapshot().tasks[0].generation, row.generation);
    assert_eq!(
        m.snapshot().tasks[0]
            .video
            .as_ref()
            .unwrap()
            .options
            .segment,
        CompositionSegment::default()
    );
    options.segment.source_end_ms = Some(3_000);
    m.patch(
        &row.id,
        row.generation,
        Some(options),
        Some(1_000),
        Some(true),
    )
    .unwrap();
    let updated = m.snapshot().tasks[0].clone();
    assert_eq!(updated.timeline.unwrap().audio_start_ms, 2_000);
    assert_eq!(updated.phase, CompositionPhase::Ready);
    assert!(
        m.patch(&row.id, row.generation, None, Some(0), Some(true))
            .is_err()
    );
    m.start(None).unwrap();
    idle(&m).await;
    assert!(m.snapshot().tasks.is_empty(), "{:?}", m.snapshot().tasks);
}
