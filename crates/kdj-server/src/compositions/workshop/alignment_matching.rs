//! Block retrieval owns IO; kdj-analysis owns acoustic acceptance. All returned
//! positions are in the original rendered clips' timelines, never block time.
use super::alignment_cache::{FeatureBlock, RecordingIndex};
use super::*;
use kdj_analysis::alignment::{self, FuzzyPlacement, RecordingMatch};
use kdj_core::composition::CompositionVideoSection;

const CANDIDATE_BLOCKS: usize = 8;
pub(super) type AlignmentCheckpoint = Arc<dyn Fn() -> bool + Send + Sync>;

impl Workshop {
    pub(super) async fn match_recordings(
        &self,
        p: &CompositionProject,
        source: &RecordingIndex,
        reference: &RecordingIndex,
        allow_fuzzy: bool,
        segment_only: bool,
        cancel: &CancellationToken,
        checkpoint: Option<AlignmentCheckpoint>,
    ) -> Result<RecordingMatch> {
        source.verify(p)?;
        reference.verify(p)?;
        let checkpoint = checkpoint.unwrap_or_else(|| {
            let cancel = cancel.clone();
            Arc::new(move || cancel.is_cancelled())
        });
        let mut spans = vec![];
        let mut reviews = vec![];
        let mut had_fuzzy = false;
        let mut reason = String::new();
        for block in &source.blocks {
            if cancel.is_cancelled() {
                bail!("匹配已取消")
            }
            let a = self.alignment_block(p, block, cancel).await?;
            let summary = Arc::new(a.summary());
            let search_started = std::time::Instant::now();
            let mut ranked = vec![];
            for (index, target) in reference.blocks.iter().enumerate() {
                let b = self.alignment_summary(p, target, cancel).await?;
                let summary = summary.clone();
                let checkpoint = checkpoint.clone();
                let score = tokio::task::spawn_blocking(move || {
                    kdj_core::thread_qos::prefer_background();
                    alignment::coarse_similarity(&summary, &b, allow_fuzzy, &|| checkpoint())
                })
                .await??;
                ranked.push((index, score));
                ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
                ranked.truncate(CANDIDATE_BLOCKS + 1);
            }
            tracing::debug!(source = %block.clip.source_id, source_start_ms = block.start_ms,
                reference_blocks = reference.blocks.len(), elapsed_ms = search_started.elapsed().as_millis() as u64,
                "workshop alignment coarse search finished");
            // If even the omitted candidate ties the strongest proposal, a
            // bounded shortlist cannot establish uniqueness. Do not auto-pick.
            if ranked
                .get(CANDIDATE_BLOCKS)
                .is_some_and(|last| ranked[0].1 - last.1 < 0.02)
            {
                reason = "存在多个相似片段，需确认对齐位置".into();
                continue;
            }
            ranked.truncate(CANDIDATE_BLOCKS);
            let prior_spans = spans.len();
            for fuzzy_pass in [false, true] {
                // Do not run the expensive remix search against unrelated blocks
                // once strict recording evidence has already located this source.
                if fuzzy_pass && (!allow_fuzzy || spans.len() > prior_spans) {
                    break;
                }
                for &(index, _) in &ranked {
                    if cancel.is_cancelled() {
                        bail!("匹配已取消")
                    }
                    let target = &reference.blocks[index];
                    let b = self.alignment_block(p, target, cancel).await?;
                    let source_length = a.duration_ms();
                    let target_length = b.duration_ms();
                    let a = a.clone();
                    let checkpoint = checkpoint.clone();
                    let pair_fuzzy = allow_fuzzy
                        && (fuzzy_pass
                            || (source.blocks.len() == 1 && reference.blocks.len() == 1));
                    let comparison_started = std::time::Instant::now();
                    let single_pair = source.blocks.len() == 1 && reference.blocks.len() == 1;
                    let found = tokio::task::spawn_blocking(move || -> Result<RecordingMatch> {
                        kdj_core::thread_qos::prefer_background();
                        let mut found = alignment::compare_blocks(&a, &b, pair_fuzzy, segment_only, &|| checkpoint())?;
                        if single_pair && !segment_only && found.fuzzy.verified.len() == 1 {
                            for candidate in &found.fuzzy.review {
                                if let Some(plan) = alignment::short_review_pair(&a, &b, &found.fuzzy.verified[0], candidate, &|| checkpoint())? {
                                    found.short_review.push(plan);
                                }
                            }
                        }
                        Ok(found)
                    })
                    .await??;
                    tracing::debug!(source = %block.clip.source_id, reference = %target.clip.source_id,
                        source_start_ms = block.start_ms, reference_start_ms = target.start_ms,
                        fuzzy = pair_fuzzy, elapsed_ms = comparison_started.elapsed().as_millis() as u64,
                        matched = found.offset_ms.is_some() || !found.sections.is_empty() || !found.fuzzy.verified.is_empty(),
                        "workshop alignment block comparison finished");
                    // Preserve the established short-recording behavior and preset
                    // semantics exactly when no block assembly is necessary.
                    if source.blocks.len() == 1 && reference.blocks.len() == 1 {
                        source.verify(p)?;
                        reference.verify(p)?;
                        return Ok(found);
                    }
                    if !found.reason.is_empty() {
                        reason = found.reason;
                    }
                    let mut exact = found.sections;
                    if exact.is_empty() {
                        if let Some(offset) = found.offset_ms {
                            let lo = (-offset).max(0.);
                            let hi = source_length.min(target_length - offset);
                            if hi > lo {
                                exact.push(CompositionVideoSection {
                                    video_start_ms: lo.round() as i64,
                                    audio_start_ms: (lo + offset).round() as i64,
                                    duration_ms: (hi - lo).round() as i64,
                                });
                            }
                        }
                    }
                    for section in exact {
                        let local = FuzzyPlacement {
                            source_start_ms: section.video_start_ms as f64,
                            source_end_ms: (section.video_start_ms + section.duration_ms) as f64,
                            reference_start_ms: section.audio_start_ms as f64,
                            speed: 1.,
                            similarity: 1.,
                            anchors: 0,
                        };
                        if let Some(global) = global_span(local, block, target) {
                            spans.push(global);
                        }
                    }
                    for candidate in found.fuzzy.verified {
                        if let Some(global) = global_span(candidate, block, target) {
                            had_fuzzy = true;
                            spans.push(global);
                        }
                    }
                    for candidate in found.fuzzy.review {
                        if let Some(global) = global_span(candidate, block, target) {
                            reviews.push(global);
                        }
                    }
                }
            }
        }
        if cancel.is_cancelled() {
            bail!("匹配已取消")
        }
        source.verify(p)?;
        reference.verify(p)?;
        let spans = alignment::unambiguous_spans(&spans);
        let mut found = RecordingMatch::default();
        // A prefix and its short tail may live in different retrieval blocks.
        // Assemble only after global timestamps/ambiguity have been resolved.
        if !segment_only && allow_fuzzy && source.blocks.len() == 1 && spans.len() == 1 {
            let before = &spans[0];
            let at = |m: &FuzzyPlacement, t: f64| m.reference_start_ms + (t - m.source_start_ms) / m.speed;
            for candidate in &reviews {
                if candidate.source_end_ms < before.source_end_ms + 8000.
                    || candidate.source_start_ms > before.source_end_ms
                    || at(candidate, before.source_end_ms) < at(before, before.source_end_ms) + 1000.
                { continue; }
                let lo = at(before, before.source_end_ms - 4500.);
                let hi = at(candidate, candidate.source_end_ms);
                let Some(target) = reference.blocks.iter().find(|b| b.start_ms <= lo
                    && b.start_ms + b.clip.duration() >= hi) else { continue };
                let a = self.alignment_block(p, &source.blocks[0], cancel).await?;
                let b = self.alignment_block(p, target, cancel).await?;
                let mut before = before.clone();
                let mut after = candidate.clone();
                before.reference_start_ms -= target.start_ms;
                after.reference_start_ms -= target.start_ms;
                let checkpoint = checkpoint.clone();
                let plan = tokio::task::spawn_blocking(move || {
                    kdj_core::thread_qos::prefer_background();
                    alignment::short_review_pair(&a, &b, &before, &after, &|| checkpoint())
                }).await??;
                if let Some(mut plan) = plan {
                    for piece in &mut plan { piece.reference_start_ms += target.start_ms; }
                    if !found.short_review.iter().any(|old| old.iter().zip(&plan).all(|(a, b)|
                        (a.source_start_ms-b.source_start_ms).abs() < 200.
                            && (a.reference_start_ms-b.reference_start_ms).abs() < 200.)) {
                        found.short_review.push(plan);
                    }
                }
                if found.short_review.len() == 3 { break; }
            }
            source.verify(p)?;
            reference.verify(p)?;
        }
        if segment_only {
            // Manual fixed-offset alignment may not silently substitute a
            // partial section or choose one of multiple edited correspondences.
            if let Some(first) = spans.first() {
                let offset = first.reference_start_ms - first.source_start_ms;
                let covered: f64 = spans
                    .iter()
                    .map(|s| s.source_end_ms - s.source_start_ms)
                    .sum();
                if covered >= source.duration_ms * 0.8
                    && spans
                        .iter()
                        .all(|s| (s.reference_start_ms - s.source_start_ms - offset).abs() <= 50.)
                {
                    found.offset_ms = Some(offset);
                }
            }
        } else if had_fuzzy {
            found.fuzzy.verified = spans;
        } else {
            found.sections = spans
                .into_iter()
                .map(|s| CompositionVideoSection {
                    video_start_ms: s.source_start_ms.round() as i64,
                    audio_start_ms: s.reference_start_ms.round() as i64,
                    duration_ms: (s.source_end_ms - s.source_start_ms).round() as i64,
                })
                .collect();
        }
        reviews.sort_by(|a, b| b.similarity.total_cmp(&a.similarity));
        // Review alternatives remain explicit and bounded, never automatic.
        reviews.truncate(8);
        found.fuzzy.review = reviews;
        if found.offset_ms.is_none() && found.sections.is_empty() && found.fuzzy.verified.is_empty()
        {
            found.reason = if reason.is_empty() {
                "没有唯一且可靠的匹配位置".into()
            } else {
                reason
            };
        }
        Ok(found)
    }
}

fn global_span(
    mut span: FuzzyPlacement,
    source: &FeatureBlock,
    reference: &FeatureBlock,
) -> Option<FuzzyPlacement> {
    span.source_start_ms += source.start_ms;
    span.source_end_ms += source.start_ms;
    span.reference_start_ms += reference.start_ms;
    let lo = span.source_start_ms.max(source.core_start_ms);
    let hi = span.source_end_ms.min(source.core_end_ms);
    if hi - lo < 0.01 {
        return None;
    }
    span.reference_start_ms += (lo - span.source_start_ms) / span.speed;
    span.source_start_ms = lo;
    span.source_end_ms = hi;
    Some(span)
}
