use super::*;
use crate::compositions::workshop::naming::music_project;

fn composition() -> CompositionProject {
    let mut p = music_project();
    p.layers[1].clips[0].source_out_ms = 20000.;
    let mut second = p.layers[1].clone();
    second.id = "second".into();
    let c = &mut second.clips[0];
    c.id = "second-clip".into();
    c.source_in_ms = 40000.;
    c.source_out_ms = 70000.;
    c.start_ms = 19000.;
    p.layers.push(second);
    p
}

#[test]
fn recording_context_projects_three_audio_edits_to_two_continuous_video_pieces() {
    let mut p = composition();
    // Split the outgoing music again without removing any source time.
    let mut tail = p.layers[1].clips[0].clone();
    tail.id = "tail".into();
    tail.start_ms = 18000.;
    tail.source_in_ms = 18000.;
    p.layers[1].clips[0].source_out_ms = 18000.;
    p.layers[1].clips.push(tail);
    let base = &p.layers[0];
    let r = reference(&p, base).unwrap();
    let mut pieces = vec![];
    for part in &r.parts {
        let context = context_clip(&part.clip);
        assert_eq!(context.source_in_ms, 0.);
        assert_eq!(context.source_out_ms, 90000.);
        // One shared recording correspondence (video is 660ms later).
        let candidate = Placement { clip_id: base.clips[0].id.clone(), source_in_ms: 660.,
            source_out_ms: 90000., start_ms: context.start_ms, speed_multiplier: Some(1.) };
        pieces.extend(restrict_placement(&base.clips[0], &candidate, &part.ranges));
    }
    bridge_crossfades(base, &r, &mut pieces);
    let presets = make_remix_presets(base, pieces);
    let pieces = &presets[0].placements;
    assert_eq!(pieces.len(), 2);
    assert_eq!(pieces[0].start_ms, 0.);
    assert_eq!(pieces[0].source_out_ms, 19660.);
    assert_eq!(pieces[1].start_ms, 19000.);
    assert_eq!(pieces[1].source_in_ms, 40660.);

    let mut gap = pieces.clone();
    gap[1].start_ms = 25000.;
    gap[1].source_in_ms = 46660.;
    bridge_crossfades(base, &r, &mut gap);
    assert_eq!(gap[1].start_ms, 25000., "do not fill gaps outside a crossfade");
}

#[test]
fn bridged_music_overlap_gets_a_shared_picture_transition() {
    let mut p = composition();
    let reference = reference(&p, &p.layers[0]).unwrap();
    let mut left = p.layers[0].clips[0].clone();
    left.source_in_ms = 660.;
    left.source_out_ms = 19660.;
    let mut right = left.clone();
    right.id = "incoming-video".into();
    right.start_ms = 19000.;
    right.source_in_ms = 40660.;
    right.source_out_ms = 70660.;
    let mut clips = vec![left, right];
    apply_reference_crossfades(&reference, &mut clips);
    let transition = clips[1].video_transition.as_ref().unwrap();
    assert_eq!(transition.duration_ms, 1000.);
    assert_eq!(transition.alignment, 1);
    assert_eq!(kdj_core::workshop::video_transition_span(&clips[0], &clips[1]), Some((0., 1000.)));
    p.layers[0].clips = clips.clone();
    let visual = p.video_project();
    assert_eq!(visual.layers[0].clips[0].duration(), 20000.);
    assert_eq!(visual.layers[0].clips[1].fades.video_in_ms, 1000.);
    assert_eq!(p.layers[1].clips[0].source_out_ms, 20000., "music is untouched");
    clips[1].video_transition.as_mut().unwrap().duration_ms = 400.;
    apply_reference_crossfades(&reference, &mut clips);
    assert_eq!(clips[1].video_transition.as_ref().unwrap().duration_ms, 400., "keep explicit edits");
    clips[1].video_transition = None;
    clips[1].start_ms += 50.;
    apply_reference_crossfades(&reference, &mut clips);
    assert!(clips[1].video_transition.is_none(), "no transition across real gaps");
    clips[1].start_ms = 19000.;
    clips[1].source_in_ms = clips[0].source_out_ms;
    apply_reference_crossfades(&reference, &mut clips);
    assert!(clips[1].video_transition.is_none(), "no dissolve at a continuous source cut");
}

#[tokio::test]
#[ignore = "requires local ffmpeg"]
async fn imported_video_matches_the_whole_edited_audio_timeline() {
    use crate::compositions::media_tests::Fixture;
    let f = Fixture::new();
    let state = AppState::new(Arc::new(kdj_core::AppConfig::create(
        f.path("data"),
        f.path("outputs"),
        0,
    )))
    .unwrap();
    let legacy = CompositionManager::open(state.clone()).unwrap();
    let m = Workshop::open(state, &legacy).unwrap();
    let raw = f.path("recording.f32");
    let pcm: Vec<u8> = (0..60 * 8000)
        .flat_map(|i| {
            let t = i as f32 / 8000.;
            let freq = 180. + 140. * (t * 0.71).sin() + 65. * (t * t * 0.19).sin();
            let sample = (0.2 + 0.15 * (t * 3.7 + (t * 0.13).sin() * 4.).sin())
                * (std::f32::consts::TAU * freq * t).sin();
            sample.to_le_bytes()
        })
        .collect();
    std::fs::write(&raw, pcm).unwrap();
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
            raw.to_str().unwrap(),
            "-c:a",
            "pcm_s16le",
        ],
    );
    let video = f.generate(
        "video.mp4",
        &[
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=64x36:r=10:d=60",
            "-i",
            music.to_str().unwrap(),
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
    let audio_id = m.state.library.upsert_file(&music, "local", "").unwrap();
    let video_id = m.state.library.upsert_file(&video, "local", "").unwrap();
    let p = m.create().unwrap().projects[0].clone();
    let mut p = m
        .add(&p.id, p.revision, &[audio_id], 0.)
        .await
        .unwrap()
        .projects[0]
        .clone();
    let mut second = p.layers[0].clone();
    second.id = "second".into();
    second.clips[0].id = "second-clip".into();
    second.clips[0].start_ms = 19000.;
    second.clips[0].source_in_ms = 40000.;
    second.clips[0].source_out_ms = 60000.;
    let mut repeat = p.layers[0].clone();
    repeat.id = "repeat".into();
    repeat.clips[0].id = "repeat-clip".into();
    repeat.clips[0].start_ms = 45000.;
    repeat.clips[0].source_out_ms = 20000.;
    p.layers[0].clips[0].source_out_ms = 20000.;
    p.layers[0].clips[0].fades.audio_out_ms = 1000.;
    second.clips[0].fades.audio_in_ms = 1000.;
    p.layers.extend([second, repeat]);
    for c in p.layers.iter_mut().flat_map(|l| &mut l.clips) {
        c.fades.span_ms = c.duration();
    }
    let audio_layers = p.layers.clone();
    // Install the edit before import, as the desktop's normal edit endpoint does.
    m.change(|j| {
        *j.projects.iter_mut().find(|v| v.id == p.id).unwrap() = p.clone();
        Ok(())
    })
    .unwrap();
    let imported = m
        .add(&p.id, p.revision, &[video_id], 0.)
        .await
        .unwrap()
        .projects[0]
        .clone();
    let video_layer = imported.layers.last().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    let result = loop {
        let view = m
            .position_views(&p.id)
            .into_iter()
            .find(|v| v.layer_id == video_layer.id)
            .unwrap();
        if view.applied.is_some() || matches!(view.phase.as_str(), "failed" | "unmatched") {
            break view;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "matching timed out: {} {}",
            view.phase,
            view.reason
        );
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    };
    m.cancel_positions(&p.id);
    assert_eq!(result.phase, "ready", "{}", result.reason);
    assert_eq!(result.reference_id, "audio-timeline");
    assert_eq!(result.applied.as_deref(), Some("timeline-sections"));
    let current = m.snapshot().projects[0].clone();
    assert_eq!(
        &current.layers[..3],
        &audio_layers,
        "video matching never edits the audio presentation"
    );
    let clips = &current.layers.last().unwrap().clips;
    assert_eq!(
        clips.len(),
        3,
        "all nonoverlapping parts, including the repeated phrase, must be matched"
    );
    for (c, (start, source, end)) in clips.iter().zip([
        (0., 0., 19000.),
        (19000., 40000., 39000.),
        (45000., 0., 65000.),
    ]) {
        assert!(
            (c.start_ms - start).abs() < 150.,
            "wrong project position: {} vs {start}",
            c.start_ms
        );
        assert!(
            (c.source_in_ms - source).abs() < 150.,
            "wrong source position: {} vs {source}",
            c.source_in_ms
        );
        assert!((c.start_ms + c.duration() - end).abs() < 150.);
    }
    assert!(clips
        .windows(2)
        .all(|v| v[0].start_ms + v[0].duration() <= v[1].start_ms + 0.01));
}

#[test]
fn timeline_owns_every_nonoverlapping_part_and_excludes_crossfades() {
    let mut p = composition();
    let r = reference(&p, &p.layers[0]).unwrap();
    assert!(r.composite);
    assert_eq!(r.title(&p), "音频时间轴");
    assert_eq!(r.parts[0].ranges, vec![[0., 19000.]]);
    assert_eq!(r.parts[1].ranges, vec![[20000., 49000.]]);
    p.layers[2].clips[0].start_ms = 25000.;
    let r = reference(&p, &p.layers[0]).unwrap();
    assert_eq!(r.parts[0].ranges, vec![[0., 20000.]]);
    assert_eq!(r.parts[1].ranges, vec![[25000., 55000.]], "gaps stay gaps");
    p.layers[2].clips[0].sound.muted = true;
    let r = reference(&p, &p.layers[0]).unwrap();
    assert!(!r.composite);
    assert_eq!(r.parts.len(), 1);
    p.layers[1].clips[0].sound.gain = 0.;
    assert!(
        reference(&p, &p.layers[0]).is_none(),
        "video audio never substitutes for silent music"
    );
}

#[test]
fn multiple_sources_and_same_row_cuts_are_one_timeline() {
    let mut p = composition();
    let mut source = p.sources[1].clone();
    source.id = "other-song".into();
    p.sources.push(source);
    p.layers[2].source_id = "other-song".into();
    p.layers[2].clips[0].source_id = "other-song".into();
    p.layers[2].clips[0].start_ms = 25000.;
    let mut cut = p.layers[1].clips[0].clone();
    cut.id = "cut".into();
    cut.source_in_ms = 20000.;
    cut.source_out_ms = 25000.;
    cut.start_ms = 20000.;
    p.layers[1].clips.push(cut);
    let r = reference(&p, &p.layers[0]).unwrap();
    assert!(r.composite);
    assert_eq!(r.parts.len(), 3);
    assert_eq!(r.parts[1].ranges, vec![[20000., 25000.]]);
    assert_eq!(r.parts[2].clip.source_id, "other-song");
    assert_eq!(r.parts[2].ranges, vec![[25000., 55000.]]);
}

#[test]
fn nested_overlap_splits_owned_ranges_without_analyzing_the_owner_twice() {
    let mut p = composition();
    p.layers[1].clips[0].source_out_ms = 80000.;
    let r = reference(&p, &p.layers[0]).unwrap();
    assert_eq!(r.parts[0].ranges, vec![[0., 19000.], [49000., 80000.]]);
    assert!(r.parts[1].ranges.is_empty());
    p.layers[2].clips[0] = p.layers[1].clips[0].clone();
    let r = reference(&p, &p.layers[0]).unwrap();
    assert!(
        r.parts.iter().all(|p| p.ranges.is_empty()),
        "full overlaps produce no arbitrary winner"
    );
}

#[test]
fn any_audible_reference_edit_invalidates_analysis_not_only_the_longest() {
    let p = composition();
    let key = reference_key(&p, &p.layers[0], &reference(&p, &p.layers[0])).unwrap();
    let changes: Vec<Box<dyn Fn(&mut Clip)>> = vec![
        Box::new(|c| c.start_ms += 100.),
        Box::new(|c| c.source_out_ms -= 100.),
        Box::new(|c| c.sound.muted = true),
        Box::new(|c| c.sound.gain = 0.5),
        Box::new(|c| c.fades.audio_out_ms = 500.),
        Box::new(|c| {
            c.speed.start = 2.;
            c.speed.middle = 2.;
            c.speed.end = 2.;
        }),
    ];
    for change in changes {
        let mut changed = p.clone();
        change(&mut changed.layers[1].clips[0]);
        assert_ne!(
            key,
            reference_key(
                &changed,
                &changed.layers[0],
                &reference(&changed, &changed.layers[0])
            )
            .unwrap()
        );
        let mut pending = HashMap::from([(
            format!("{}:{}", p.id, p.layers[0].id),
            layout_key(&p.layers[0]).unwrap(),
        )]);
        retain_pending_after_edit(&mut pending, &p, &changed).unwrap();
        assert!(
            pending.is_empty(),
            "late auto-placement must not overwrite the new edit"
        );
    }
    let mut changed = p.clone();
    changed.layers[1].clips[0].picture.opacity = 0.2;
    assert_eq!(
        key,
        reference_key(
            &changed,
            &changed.layers[0],
            &reference(&changed, &changed.layers[0])
        )
        .unwrap()
    );
    changed.sources[1].signature = "replaced".into();
    assert_ne!(
        key,
        reference_key(
            &changed,
            &changed.layers[0],
            &reference(&changed, &changed.layers[0])
        )
        .unwrap()
    );
}

#[test]
fn short_edits_get_context_without_changing_source_to_timeline_mapping() {
    let p = music_project();
    for preset in ["constant", "ramp"] {
        for source_in in [0., 42000., 89700.] {
            let mut c = p.layers[1].clips[0].clone();
            c.source_in_ms = source_in;
            c.source_out_ms = source_in + 300.;
            c.start_ms = 1000.;
            c.speed.preset = preset.into();
            c.speed.start = 0.5;
            c.speed.middle = 1.;
            c.speed.end = if preset == "constant" { 0.5 } else { 2. };
            let context = context_clip(&c);
            assert!(context.duration() >= 5999.);
            assert!(
                (context.start_ms + context.output_at(c.source_in_ms) - c.start_ms).abs() < 0.01
            );
            assert!(
                (context.start_ms + context.output_at(c.source_out_ms) - c.start_ms - c.duration())
                    .abs()
                    < 0.01
            );
        }
    }
}

#[test]
fn combined_plan_retains_reordered_and_repeated_source_spans_without_output_overlap() {
    let p = composition();
    let base = &p.layers[0];
    let c = &base.clips[0];
    let first = Placement {
        clip_id: c.id.clone(),
        source_in_ms: 40000.,
        source_out_ms: 60000.,
        start_ms: 0.,
        speed_multiplier: None,
    };
    let second = Placement {
        clip_id: c.id.clone(),
        source_in_ms: 0.,
        source_out_ms: 30000.,
        start_ms: 19000.,
        speed_multiplier: None,
    };
    let repeated = Placement {
        start_ms: 55000.,
        ..first.clone()
    };
    let mut placements = restrict_placement(c, &first, &[[0., 19000.]]);
    placements.extend(restrict_placement(c, &second, &[[20000., 49000.]]));
    placements.extend(restrict_placement(c, &repeated, &[[55000., 75000.]]));
    let presets = make_timeline_presets(base, placements);
    assert_eq!(presets.len(), 1);
    assert_eq!(
        presets[0].id, "timeline-sections",
        "never fall back to positioning the full video against only the longest piece"
    );
    let (clips, _) = apply_preset(
        base,
        base,
        &presets[0],
        &HashMap::from([(c.id.clone(), c.id.clone())]),
    )
    .unwrap();
    assert_eq!(clips.len(), 3);
    assert_eq!(clips[0].source_in_ms, 40000.);
    assert_eq!(clips[0].source_out_ms, 59000.);
    assert_eq!(clips[1].source_in_ms, 1000.);
    assert_eq!(clips[2].source_in_ms, 40000.);
    assert!(clips
        .windows(2)
        .all(|c| c[0].start_ms + c[0].duration() <= c[1].start_ms));
    assert_eq!(
        clips
            .iter()
            .map(|c| &c.id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        3
    );
    let faster = Placement {
        speed_multiplier: Some(2.),
        source_in_ms: 0.,
        source_out_ms: 40000.,
        start_ms: 1000.,
        ..first
    };
    let restricted = restrict_placement(c, &faster, &[[2000., 5000.]]);
    assert_eq!(restricted[0].source_in_ms, 2000.);
    assert_eq!(restricted[0].source_out_ms, 8000.);
}
