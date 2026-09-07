use super::*;

#[cfg(test)]
mod tests;

/// One presentation timeline, with independent evidence from each audible clip.
/// Overlaps are deliberately not matching evidence: neither stem alone is what
/// the audience hears there. Ranges remain in absolute project milliseconds.
#[derive(Clone, Serialize)]
pub(super) struct ReferenceTimeline {
    pub parts: Vec<ReferencePart>,
    pub composite: bool,
}
#[derive(Clone, Serialize)]
pub(super) struct ReferencePart {
    pub clip: Clip,
    pub ranges: Vec<[f64; 2]>,
}
impl ReferenceTimeline {
    pub fn id(&self) -> String {
        if self.composite {
            "audio-timeline".into()
        } else {
            self.parts
                .first()
                .map(|p| p.clip.id.clone())
                .unwrap_or_default()
        }
    }
    pub fn title(&self, p: &CompositionProject) -> String {
        if self.composite {
            "音频时间轴".into()
        } else {
            self.parts
                .first()
                .and_then(|r| p.source(&r.clip.source_id))
                .map(|s| s.title.clone())
                .unwrap_or_default()
        }
    }
}

pub(super) fn reference(p: &CompositionProject, layer: &Layer) -> Option<ReferenceTimeline> {
    let has_music = p.music_reference().is_some();
    if has_music && !p.source(&layer.source_id).is_some_and(|s| s.video) {
        return None;
    }
    let mut clips: Vec<_> = p
        .layers
        .iter()
        .filter(|l| l.id != layer.id)
        .flat_map(|l| &l.clips)
        .filter(|c| !c.sound.muted && c.sound.gain > 0. && c.duration() > 0.)
        .filter(|c| {
            p.source(&c.source_id)
                .is_some_and(|s| s.audio && (!has_music || !s.video))
        })
        .cloned()
        .collect();
    if clips.is_empty() {
        return None;
    }
    // Preserve video-to-video alignment when the project has no standalone music.
    if !has_music {
        let longest = clips
            .into_iter()
            .filter(|c| c.duration() >= 6000.)
            .max_by(|a, b| a.duration().total_cmp(&b.duration()))?;
        clips = vec![longest];
    }
    clips.sort_by(|a, b| {
        a.start_ms
            .total_cmp(&b.start_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    let composite = clips.len() > 1;
    let mut boundaries: Vec<_> = clips
        .iter()
        .flat_map(|c| [c.start_ms, c.start_ms + c.duration()])
        .collect();
    boundaries.sort_by(f64::total_cmp);
    boundaries.dedup_by(|a, b| (*a - *b).abs() < 0.001);
    let mut parts: Vec<_> = clips
        .into_iter()
        .map(|clip| ReferencePart {
            clip,
            ranges: vec![],
        })
        .collect();
    for pair in boundaries.windows(2) {
        let mid = (pair[0] + pair[1]) / 2.;
        let owners: Vec<_> = parts
            .iter()
            .enumerate()
            .filter(|(_, r)| r.clip.start_ms <= mid && mid < r.clip.start_ms + r.clip.duration())
            .map(|(i, _)| i)
            .collect();
        if let [owner] = owners.as_slice() {
            let ranges = &mut parts[*owner].ranges;
            if let Some(last) = ranges.last_mut().filter(|r| (r[1] - pair[0]).abs() < 0.001) {
                last[1] = pair[1];
            } else {
                ranges.push([pair[0], pair[1]]);
            }
        }
    }
    // Keep fully overlapping parts in the fingerprint as well, so all audible
    // material changes invalidate stale analysis even if it owns no interval.
    Some(ReferenceTimeline { parts, composite })
}

/// Match the recording before projecting the user's cuts. Cropped references
/// otherwise fit the same source independently, inventing rate changes and losing
/// evidence near each edit. Placement still stays inside owned timeline ranges.
pub(super) fn context_clip(clip: &Clip) -> Clip {
    if clip.speed.preset == "constant"
        && (clip.speed.domain_end_ms - clip.speed.domain_start_ms) / clip.speed.start <= 1_800_000.
    {
        let mut full = clip.clone();
        full.source_in_ms = clip.speed.domain_start_ms;
        full.source_out_ms = clip.speed.domain_end_ms;
        full.start_ms -= full.output_at(clip.source_in_ms);
        return full;
    }
    if clip.duration() >= 6000. {
        return clip.clone();
    }
    let mut full = clip.clone();
    full.source_in_ms = clip.speed.domain_start_ms;
    full.source_out_ms = clip.speed.domain_end_ms;
    let offset = full.output_at(clip.source_in_ms);
    let end = full.output_at(clip.source_out_ms);
    let length = full.duration();
    let lo = (offset - (6000. - clip.duration()) / 2.)
        .max(0.)
        .min((length - 6000.).max(0.));
    let hi = (lo + 6000.).max(end).min(length);
    let mut result = clip.clone();
    result.source_in_ms = full.source_at(lo);
    result.source_out_ms = full.source_at(hi);
    result.start_ms -= offset - lo;
    result
}

/// A crossfade is excluded from alignment evidence, but need not become a black
/// hole once the mappings on BOTH sides are known. Hand off to the incoming
/// picture at the outgoing owned range's end; never fill an actual music gap.
pub(super) fn bridge_crossfades(base: &Layer, reference: &ReferenceTimeline, placements: &mut [Placement]) {
    placements.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    for index in 1..placements.len() {
        let previous = &placements[index - 1];
        let Some(previous_clip) = base.clips.iter().find(|c| c.id == previous.clip_id) else { continue };
        let end = previous.start_ms + (previous_clip.output_at(previous.source_out_ms)
            - previous_clip.output_at(previous.source_in_ms)) / previous.speed_multiplier.unwrap_or(1.);
        let next = &mut placements[index];
        let gap = next.start_ms - end;
        if !(0.01..=6000.).contains(&gap) { continue; }
        let owners = reference.parts.iter().filter(|part| part.clip.start_ms <= end + 0.01
            && part.clip.start_ms + part.clip.duration() >= next.start_ms - 0.01).count();
        if owners < 2 { continue; }
        let Some(clip) = base.clips.iter().find(|c| c.id == next.clip_id) else { continue };
        let source_time = clip.output_at(next.source_in_ms) - gap * next.speed_multiplier.unwrap_or(1.);
        if source_time < 0. { continue; }
        next.source_in_ms = clip.source_at(source_time);
        next.start_ms = end;
    }
}

/// A bridged audio overlap needs a picture dissolve as well as contiguous
/// timing. Store it on the incoming edit so native preview and export use the
/// same derived handles. Explicit picture transitions remain user-owned.
pub(super) fn apply_reference_crossfades(reference: &ReferenceTimeline, clips: &mut [Clip]) {
    clips.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    for i in 1..clips.len() {
        let (left, right) = clips.split_at_mut(i);
        let previous = &left[i - 1];
        let next = &mut right[0];
        let at = next.start_ms;
        if next.video_transition.is_some()
            || (previous.start_ms + previous.duration() - at).abs() > 0.01
            || (previous.source_out_ms - next.source_in_ms).abs() < 0.01
        { continue; }
        let duration = reference.parts.iter()
            .filter(|incoming| (incoming.clip.start_ms - at).abs() < 0.01)
            .flat_map(|incoming| reference.parts.iter().filter_map(move |outgoing| {
                let end = (outgoing.clip.start_ms + outgoing.clip.duration())
                    .min(incoming.clip.start_ms + incoming.clip.duration());
                (outgoing.clip.start_ms < at && end > at + 0.01).then_some(end - at)
            }))
            .fold(0., f64::max).min(10000.);
        if duration > 0.01 {
            next.video_transition = Some(kdj_core::workshop::VideoTransition {
                duration_ms: duration, alignment: 1,
            });
        }
    }
}

/// Intersect independently found correspondences with the audible timeline.
/// Source reuse is valid (repeated musical phrases); output overlap is not.
pub(super) fn restrict_placement(
    base: &Clip,
    candidate: &Placement,
    ranges: &[[f64; 2]],
) -> Vec<Placement> {
    let rate = candidate.speed_multiplier.unwrap_or(1.);
    let source_start = base.output_at(candidate.source_in_ms);
    let duration = (base.output_at(candidate.source_out_ms) - source_start) / rate;
    ranges
        .iter()
        .filter_map(|[lo, hi]| {
            let start = candidate.start_ms.max(*lo);
            let end = (candidate.start_ms + duration).min(*hi);
            if end - start < 100. {
                return None;
            }
            Some(Placement {
                clip_id: candidate.clip_id.clone(),
                source_in_ms: base.source_at(source_start + (start - candidate.start_ms) * rate),
                source_out_ms: base.source_at(source_start + (end - candidate.start_ms) * rate),
                start_ms: start,
                speed_multiplier: candidate.speed_multiplier,
            })
        })
        .collect()
}
