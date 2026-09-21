//! Shared state for one logical preview attempt. Retry tokens and media identity survive Range
//! requests and ticket clones; a GET never resets its own budget.
use kdj_core::models::Quality;
use kdj_providers::provider::PreviewMedia;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

/// A media-response lifetime, keyed by the cache identity rather than the bearer ticket.
/// Inactive entries are removed on drop, including timeout/disconnect paths. No timer can expire
/// this guard while a slow foreground response is still open.
fn foreground_transfers() -> &'static Mutex<std::collections::HashMap<String, usize>> {
    static ACTIVE: std::sync::OnceLock<Mutex<std::collections::HashMap<String, usize>>> =
        std::sync::OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}
pub(crate) struct ForegroundTransfer {
    key: String,
}
pub(crate) fn begin_foreground(key: &str) -> ForegroundTransfer {
    let mut active = foreground_transfers()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *active.entry(key.to_string()).or_default() += 1;
    ForegroundTransfer {
        key: key.to_string(),
    }
}
pub(crate) fn foreground_active(key: &str) -> bool {
    foreground_transfers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(key)
}
impl Drop for ForegroundTransfer {
    fn drop(&mut self) {
        let mut active = foreground_transfers()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(count) = active.get_mut(&self.key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                active.remove(&self.key);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MediaEntity {
    pub path: String,
    pub mime: String,
    pub total: u64,
    pub validator: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PreviewContext {
    /// Correlation id, deliberately independent from the bearer ticket in the media URL.
    pub attempt_id: String,
    pub actual_quality: Option<Quality>,
    pub mime: Option<String>,
    pub alternatives: Vec<String>,
    pub account_epoch: u64,
    pub(crate) retries: Arc<AtomicU8>,
    rate_limited: Arc<AtomicBool>,
    pub(crate) entity: Arc<Mutex<Option<MediaEntity>>>,
    pub(crate) refresh_gate: Arc<tokio::sync::Mutex<()>>,
}
impl Default for PreviewContext {
    fn default() -> Self {
        Self {
            attempt_id: format!("{:016x}", rand::random::<u64>()),
            actual_quality: None,
            mime: None,
            alternatives: Vec::new(),
            account_epoch: 0,
            rate_limited: Arc::new(AtomicBool::new(false)),
            retries: Arc::new(AtomicU8::new(2)),
            entity: Arc::new(Mutex::new(None)),
            refresh_gate: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}
impl PreviewContext {
    pub fn set_media(&mut self, media: &PreviewMedia) {
        self.actual_quality = media.actual_quality;
        self.mime = media.mime.clone();
        self.alternatives = media.alternatives.iter().take(2).cloned().collect();
    }
    pub fn mark_rate_limited(&self) {
        self.rate_limited.store(true, Ordering::Release);
        self.disable_retries();
    }
    pub fn is_rate_limited(&self) -> bool {
        self.rate_limited.load(Ordering::Acquire)
    }
    pub fn disable_retries(&self) {
        self.retries.store(0, Ordering::Release);
    }
    pub fn claim_retry(&self) -> bool {
        self.retries
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
            .is_ok()
    }
    pub fn cacheable_as(&self, requested: Quality) -> bool {
        self.actual_quality.is_none_or(|actual| actual == requested)
    }
    pub fn cache_refresh_matches(&self, requested: Quality, media: &PreviewMedia) -> bool {
        if media
            .actual_quality
            .is_some_and(|actual| actual != requested)
        {
            return false;
        }
        if matches!((&self.mime, &media.mime), (Some(a), Some(b)) if a != b) {
            return false;
        }
        let entity = self.entity.lock().unwrap_or_else(|e| e.into_inner());
        entity.as_ref().is_none_or(|entity| {
            reqwest::Url::parse(&media.url).is_ok_and(|url| url.path() == entity.path)
        })
    }

    pub fn lower_quality(&self) -> Option<Quality> {
        match self.actual_quality? {
            Quality::Flac => Some(Quality::Q320),
            Quality::Q320 => Some(Quality::Q128),
            Quality::Q128 => None,
        }
    }
    pub(crate) fn observe_entity(&self, next: MediaEntity) -> bool {
        let mut entity = self.entity.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(previous) = entity.as_ref() {
            if previous.path != next.path
                || previous.mime != next.mime
                || previous.total != next.total
                || matches!((&previous.validator, &next.validator), (Some(a), Some(b)) if a != b)
            {
                return false;
            }
        } else {
            *entity = Some(next);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn foreground_guards_cover_overlapping_tickets_and_release_on_drop() {
        let key = format!("fixture-{:016x}", rand::random::<u64>());
        assert!(!foreground_active(&key));
        let first = begin_foreground(&key);
        let second = begin_foreground(&key);
        assert!(foreground_active(&key));
        drop(first);
        assert!(foreground_active(&key));
        drop(second);
        assert!(!foreground_active(&key));
    }
    #[test]
    fn background_refresh_cannot_relabel_quality_format_or_path() {
        let mut context = PreviewContext::default();
        context.actual_quality = Some(Quality::Flac);
        context.mime = Some("audio/flac".into());
        let media = PreviewMedia {
            url: "https://a.stream.qqmusic.qq.com/F000song.flac?vkey=fixture".into(),
            actual_quality: Some(Quality::Flac),
            mime: Some("audio/flac".into()),
            alternatives: Vec::new(),
        };
        assert!(context.cache_refresh_matches(Quality::Flac, &media));
        let lower = PreviewMedia {
            actual_quality: Some(Quality::Q128),
            ..media.clone()
        };
        assert!(!context.cache_refresh_matches(Quality::Flac, &lower));
        let wrong_mime = PreviewMedia {
            mime: Some("audio/mpeg".into()),
            ..media.clone()
        };
        assert!(!context.cache_refresh_matches(Quality::Flac, &wrong_mime));
        assert!(context.observe_entity(MediaEntity {
            path: "/F000song.flac".into(),
            mime: "audio/flac".into(),
            total: 1000,
            validator: None
        }));
        assert!(context.cache_refresh_matches(Quality::Flac, &media));
        let new_path = PreviewMedia {
            url: "https://a.stream.qqmusic.qq.com/other.flac".into(),
            ..media
        };
        assert!(!context.cache_refresh_matches(Quality::Flac, &new_path));
    }

    #[test]
    fn clones_share_a_finite_retry_budget() {
        let context = PreviewContext::default();
        let other = context.clone();
        assert!(context.claim_retry());
        assert!(other.claim_retry());
        assert!(!context.claim_retry());
        context.mark_rate_limited();
        assert!(other.is_rate_limited());
        let recovery = PreviewContext::default();
        recovery.disable_retries();
        assert!(!recovery.claim_retry());
    }
    #[test]
    fn degraded_audio_is_not_cached_as_the_requested_lossless_quality() {
        let mut context = PreviewContext::default();
        context.actual_quality = Some(Quality::Q128);
        assert!(!context.cacheable_as(Quality::Flac));
        assert!(context.cacheable_as(Quality::Q128));
    }
    #[test]
    fn range_entity_fence_rejects_format_length_path_and_validator_changes() {
        let context = PreviewContext::default();
        let entity = MediaEntity {
            path: "/M500song.mp3".into(),
            mime: "audio/mpeg".into(),
            total: 1000,
            validator: Some("etag-v1".into()),
        };
        assert!(context.observe_entity(entity.clone()));
        assert!(context.clone().observe_entity(entity.clone()));
        for changed in [
            MediaEntity {
                total: 1001,
                ..entity.clone()
            },
            MediaEntity {
                mime: "audio/flac".into(),
                ..entity.clone()
            },
            MediaEntity {
                path: "/M800song.mp3".into(),
                ..entity.clone()
            },
            MediaEntity {
                validator: Some("etag-v2".into()),
                ..entity.clone()
            },
        ] {
            assert!(!context.observe_entity(changed));
        }
    }
}
