//! Local replacement-audio queue contracts. Offset here delays AUDIO; it is deliberately
//! independent of the older video-download offset (which trims the video).
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputMode {
    #[default]
    NewFile,
    Overwrite,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LengthPolicy {
    KeepVideo,
    #[default]
    FullAudio,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlignmentMode {
    #[default]
    Sections,
    SingleOffset,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CompositionOptions {
    pub output_mode: OutputMode,
    pub length_policy: LengthPolicy,
    #[serde(default)]
    pub alignment_mode: AlignmentMode,
    #[serde(default)]
    pub output_dir: String,
    #[serde(default)]
    pub overlay: OverlayOptions,
    #[serde(default)]
    pub acceleration: EncodingAcceleration,
    #[serde(default)]
    pub segment: CompositionSegment,
    #[serde(default)]
    pub audio: CompositionAudio,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncodingAcceleration {
    #[default]
    Auto,
    Software,
    VideoToolbox,
    Nvidia,
    Intel,
    Amd,
}

/// Source-zero offset remains stable when the selected source range is trimmed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompositionSegment {
    pub source_start_ms: i64,
    pub source_end_ms: Option<i64>,
}
impl CompositionSegment {
    pub fn valid(&self) -> bool {
        self.source_start_ms >= 0
            && self
                .source_end_ms
                .is_none_or(|end| end > self.source_start_ms)
    }
    pub fn bounds(&self, duration: i64) -> Option<(i64, i64)> {
        let end = self.source_end_ms.unwrap_or(duration);
        (self.valid() && end <= duration && self.source_start_ms < end)
            .then_some((self.source_start_ms, end))
    }
    pub fn timeline(
        &self,
        video: i64,
        audio: i64,
        offset: i64,
        policy: LengthPolicy,
    ) -> Option<CompositionTimeline> {
        let (start, end) = self.bounds(audio)?;
        CompositionTimeline::calculate(video, end - start, offset.checked_add(start)?, policy)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioMixMode {
    #[default]
    Replace,
    Mix,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompositionAudio {
    pub mode: AudioMixMode,
    pub gain: f64,
    pub main_gain: f64,
    pub fade_in_ms: i64,
    pub fade_out_ms: i64,
}
impl Default for CompositionAudio {
    fn default() -> Self {
        Self {
            mode: AudioMixMode::Replace,
            gain: 1.,
            main_gain: 1.,
            fade_in_ms: 0,
            fade_out_ms: 0,
        }
    }
}
impl CompositionAudio {
    pub fn valid(&self) -> bool {
        (0. ..=2.).contains(&self.gain)
            && (0. ..=2.).contains(&self.main_gain)
            && (0..=30_000).contains(&self.fade_in_ms)
            && (0..=30_000).contains(&self.fade_out_ms)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlayAudio {
    #[default]
    Main,
    ReplaceSegment,
    Mix,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OverlayOptions {
    /// Width fraction, normalized center coordinates, and alpha. Aspect ratio is retained.
    pub scale: f64,
    pub x: f64,
    pub y: f64,
    pub opacity: f64,
    pub fade_ms: i64,
    pub audio: OverlayAudio,
}
impl Default for OverlayOptions {
    fn default() -> Self {
        Self {
            scale: 0.5,
            x: 0.5,
            y: 0.5,
            opacity: 1.,
            fade_ms: 300,
            audio: OverlayAudio::Main,
        }
    }
}
impl OverlayOptions {
    pub fn valid(&self) -> bool {
        (0.1..=1.).contains(&self.scale)
            && (0. ..=1.).contains(&self.x)
            && (0. ..=1.).contains(&self.y)
            && (0. ..=1.).contains(&self.opacity)
            && (0..=5000).contains(&self.fade_ms)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompositionPhase {
    #[default]
    WaitingPair,
    PendingAnalysis,
    Analyzing,
    Ready,
    NeedsReview,
    Queued,
    Rendering,
    Validating,
    Committing,
    Importing,
    ImportFailed,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompositionEntry {
    pub id: String,
    pub track_id: i64,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub format: String,
    pub is_video: bool,
    pub duration_ms: i64,
    /// Defaults are frozen on enqueue and travel with the video occurrence.
    pub options: CompositionOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompositionTask {
    pub id: String,
    pub video: Option<CompositionEntry>,
    pub audio: Option<CompositionEntry>,
    pub phase: CompositionPhase,
    pub generation: u64,
    pub released: bool,
    pub busy: bool,
    pub offset_ms: Option<i64>,
    pub matched: bool,
    pub force_confirmed: bool,
    pub video_duration_ms: Option<i64>,
    pub audio_duration_ms: Option<i64>,
    pub timeline: Option<CompositionTimeline>,
    #[serde(default)]
    pub video_sections: Vec<CompositionVideoSection>,
    pub progress: Option<f64>,
    pub error: String,
    pub output_path: String,
}

impl CompositionTask {
    pub fn uses_video_sections(&self) -> bool {
        !self.video_sections.is_empty()
            && self.audio.as_ref().is_some_and(|a| !a.is_video)
            && self.video.as_ref().is_some_and(|v| {
                v.options.alignment_mode == AlignmentMode::Sections
                    && v.options.length_policy == LengthPolicy::FullAudio
            })
    }
    pub fn complete_pair(&self) -> bool {
        self.video.is_some() && self.audio.is_some()
    }

    pub fn editable(&self) -> bool {
        !self.released
            && !matches!(
                self.phase,
                CompositionPhase::Rendering
                    | CompositionPhase::Validating
                    | CompositionPhase::Committing
                    | CompositionPhase::Importing
                    | CompositionPhase::ImportFailed
            )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompositionVideoSection {
    pub audio_start_ms: i64,
    pub video_start_ms: i64,
    pub duration_ms: i64,
}

/// Source intervals are ordered and may be used only once. Audio gaps become black.
pub fn selected_video_sections(
    sections: &[CompositionVideoSection],
    video: i64,
    audio: i64,
    range: &CompositionSegment,
) -> Option<Vec<CompositionVideoSection>> {
    let (start, end) = range.bounds(audio)?;
    if sections.len() > 128 {
        return None;
    }
    let (mut audio_end, mut video_end) = (0, 0);
    let mut result = Vec::new();
    for s in sections {
        if s.duration_ms <= 0 || s.audio_start_ms < audio_end || s.video_start_ms < video_end {
            return None;
        }
        audio_end = s.audio_start_ms.checked_add(s.duration_ms)?;
        video_end = s.video_start_ms.checked_add(s.duration_ms)?;
        if audio_end > audio || video_end > video {
            return None;
        }
        let lo = start.max(s.audio_start_ms);
        let hi = end.min(audio_end);
        if lo < hi {
            result.push(CompositionVideoSection {
                audio_start_ms: lo,
                video_start_ms: s.video_start_ms + lo - s.audio_start_ms,
                duration_ms: hi - lo,
            });
        }
    }
    Some(result)
}

pub fn video_sections_timeline(
    sections: &[CompositionVideoSection],
    video: i64,
    audio: i64,
    range: &CompositionSegment,
) -> Option<CompositionTimeline> {
    let selected = selected_video_sections(sections, video, audio, range)?;
    let (start, end) = range.bounds(audio)?;
    Some(CompositionTimeline {
        start_ms: 0,
        duration_ms: end - start,
        video_start_ms: 0,
        audio_start_ms: 0,
        silence_head_ms: 0,
        silence_tail_ms: 0,
        crop_head_ms: 0,
        crop_tail_ms: 0,
        black_head_ms: selected.first().map_or(end, |s| s.audio_start_ms) - start,
        black_tail_ms: selected
            .last()
            .map_or(0, |s| end - s.audio_start_ms - s.duration_ms),
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompositionSnapshot {
    pub session_id: String,
    pub revision: u64,
    pub tasks: Vec<CompositionTask>,
    pub defaults: CompositionOptions,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CompositionTimeline {
    pub start_ms: i64,
    pub duration_ms: i64,
    pub video_start_ms: i64,
    pub audio_start_ms: i64,
    pub silence_head_ms: i64,
    pub silence_tail_ms: i64,
    pub crop_head_ms: i64,
    pub crop_tail_ms: i64,
    pub black_head_ms: i64,
    pub black_tail_ms: i64,
}

impl CompositionTimeline {
    pub fn calculate(video: i64, audio: i64, offset: i64, policy: LengthPolicy) -> Option<Self> {
        let audio_end = offset.checked_add(audio)?;
        if video <= 0 || audio <= 0 || video.min(audio_end) <= 0.max(offset) {
            return None;
        }
        let (start, end) = match policy {
            LengthPolicy::KeepVideo => (0, video),
            LengthPolicy::FullAudio => (0.min(offset), video.max(audio_end)),
        };
        Some(Self {
            start_ms: start,
            duration_ms: end.checked_sub(start)?,
            video_start_ms: -start,
            audio_start_ms: offset - start,
            silence_head_ms: (offset - start).max(0),
            silence_tail_ms: (end - audio_end).max(0),
            crop_head_ms: (start - offset).max(0).min(audio),
            crop_tail_ms: (audio_end - end).max(0).min(audio),
            black_head_ms: (-start).max(0),
            black_tail_ms: (end - video).max(0),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_source_range_has_one_shared_output_timeline() {
        let segment = CompositionSegment {
            source_start_ms: 2_000,
            source_end_ms: Some(5_000),
        };
        let t = segment
            .timeline(10_000, 8_000, 2_000, LengthPolicy::KeepVideo)
            .unwrap();
        assert_eq!((t.audio_start_ms, t.silence_tail_ms), (4_000, 3_000));
        let t = segment
            .timeline(10_000, 8_000, -3_000, LengthPolicy::KeepVideo)
            .unwrap();
        assert_eq!((t.crop_head_ms, t.silence_tail_ms), (1_000, 8_000));
        assert!(
            segment
                .timeline(10_000, 4_000, 0, LengthPolicy::KeepVideo)
                .is_none()
        );
        assert!(
            segment
                .timeline(10_000, 8_000, i64::MAX, LengthPolicy::KeepVideo)
                .is_none()
        );
        assert!(
            !CompositionSegment {
                source_start_ms: 4,
                source_end_ms: Some(4)
            }
            .valid()
        );
        assert!(
            !CompositionAudio {
                gain: f64::NAN,
                ..Default::default()
            }
            .valid()
        );
    }

    #[test]
    fn previous_queue_options_gain_safe_defaults() {
        let options: CompositionOptions = serde_json::from_str(
            r#"{"output_mode":"new_file","length_policy":"keep_video","output_dir":"/tmp"}"#,
        )
        .unwrap();
        assert_eq!(options.acceleration, EncodingAcceleration::Auto);
        assert_eq!(options.segment, CompositionSegment::default());
        assert_eq!(options.audio, CompositionAudio::default());
    }

    #[test]
    fn composition_timeline_preserves_video_and_clips_only_audio() {
        let t =
            CompositionTimeline::calculate(10_000, 12_000, -1000, LengthPolicy::KeepVideo).unwrap();
        assert_eq!(
            (t.duration_ms, t.crop_head_ms, t.crop_tail_ms),
            (10_000, 1000, 1000)
        );
        assert_eq!((t.black_head_ms, t.black_tail_ms), (0, 0));
        let t =
            CompositionTimeline::calculate(10_000, 6000, 1000, LengthPolicy::KeepVideo).unwrap();
        assert_eq!((t.silence_head_ms, t.silence_tail_ms), (1000, 3000));
    }

    #[test]
    fn composition_full_audio_pads_both_ends_and_rejects_no_overlap() {
        let t = CompositionTimeline::calculate(
            10_000,
            13_000,
            -1000,
            CompositionOptions::default().length_policy,
        )
        .unwrap();
        assert_eq!(
            (t.start_ms, t.duration_ms, t.black_head_ms, t.black_tail_ms),
            (-1000, 13_000, 1000, 2000)
        );
        assert_eq!((t.crop_head_ms, t.crop_tail_ms), (0, 0));
        assert!(
            CompositionTimeline::calculate(1000, 1000, 1000, LengthPolicy::KeepVideo).is_none()
        );
        assert!(
            CompositionTimeline::calculate(1000, 1000, i64::MAX, LengthPolicy::FullAudio).is_none()
        );
    }
}
