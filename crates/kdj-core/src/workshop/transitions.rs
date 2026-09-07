use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VideoTransition {
    pub duration_ms: f64,
    /// -1: before the cut, 0: centered, 1: after the cut.
    pub alignment: i8,
}

/// Presentation-only overlap. The nominal clips (including their audio and
/// alignment) remain untouched. Keep this quadrature identical to the editor.
pub fn video_transition_span(left: &Clip, right: &Clip) -> Option<(f64, f64)> {
    let transition = right.video_transition.as_ref()?;
    if transition.duration_ms <= 0. || (left.start_ms + left.duration() - right.start_ms).abs() > 0.01 {
        return None;
    }
    let full = |c: &Clip| {
        let mut full = c.clone();
        full.source_in_ms = c.speed.domain_start_ms;
        full.source_out_ms = c.speed.domain_end_ms;
        full
    };
    let a = full(left);
    let b = full(right);
    let before_fraction = (1. - transition.alignment as f64) / 2.;
    let after_fraction = 1. - before_fraction;
    // Half a nominal clip belongs to each joint: adjacent transitions never
    // create a three-way overlap, even on a very short middle clip.
    let before_max = b.output_at(right.source_in_ms).min(left.duration() / 2.);
    let after_max = (a.duration() - a.output_at(left.source_out_ms)).min(right.duration() / 2.);
    let mut duration = transition.duration_ms;
    if before_fraction > 0. { duration = duration.min(before_max / before_fraction); }
    if after_fraction > 0. { duration = duration.min(after_max / after_fraction); }
    (duration > 0.01).then_some((duration * before_fraction, duration * after_fraction))
}

impl CompositionProject {
    /// Only video consumers use this projection. Audio rendering must use self.
    pub fn video_project(&self) -> Self {
        let mut project = self.clone();
        for layer in &mut project.layers {
            if !self.source(&layer.source_id).is_some_and(|s| s.video) { continue; }
            layer.clips.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
            let original = layer.clips.clone();
            let mut heads = vec![None; original.len()];
            let mut tails = vec![None; original.len()];
            for i in 1..original.len() {
                if let Some((before, after)) = video_transition_span(&original[i - 1], &original[i]) {
                    heads[i] = Some((before, before + after));
                    tails[i - 1] = Some(after);
                }
            }
            for (i, clip) in layer.clips.iter_mut().enumerate() {
                if heads[i].is_none() && tails[i].is_none() { continue; }
                let old = &original[i];
                let mut full = old.clone();
                full.source_in_ms = old.speed.domain_start_ms;
                full.source_out_ms = old.speed.domain_end_ms;
                let before = heads[i].map_or(0., |h| h.0);
                let after = tails[i].unwrap_or(0.);
                clip.source_in_ms = full.source_at(full.output_at(old.source_in_ms) - before);
                clip.source_out_ms = full.source_at(full.output_at(old.source_out_ms) + after);
                clip.start_ms -= before;
                let visible_in = (old.fades.video_in_ms - old.fades.offset_ms).max(0.).min(old.duration());
                let visible_out = (old.fades.video_out_ms - (old.fades.span_ms - old.fades.offset_ms - old.duration())).max(0.).min(old.duration());
                clip.fades.offset_ms = 0.;
                clip.fades.span_ms = clip.duration();
                clip.fades.video_in_ms = heads[i].map_or(visible_in, |h| h.1);
                // Source-over composition: keep the lower outgoing picture
                // opaque; incoming smoothstep reveals it with complementary
                // weight. Fading BOTH alpha planes would dip to black midway.
                clip.fades.video_out_ms = if tails[i].is_some() { 0. } else { visible_out };
                clip.fades.linear = false;
            }
        }
        project
    }
}
