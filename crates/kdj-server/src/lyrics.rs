//! 按曲名 / 艺人自动搜歌词：可指定引擎与显示来源，优先直取曲库来源。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use kdj_core::models::{LyricText, LyricsRequest, LyricsResponse, Platform, SongSource};
use kdj_providers::MusicProvider;
use tokio::sync::OnceCell;

use crate::aggregate::{
    artist_similarity, duration_similarity, normalize_artists, title_similarity,
};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// 本地曲 ↔ 在线候选的匹配门槛。歌词一旦命中就会被显示/缓存，不能像普通搜索
/// 那样只凭“标题相似”放过明显不同的艺人。
const LYRIC_MATCH_THRESHOLD: f64 = 0.65;
/// 歌词时间轴比音频略长几秒，通常只是平台取整或文件尾部裁切；再长就已经是
/// 另一个版本（edit / live / sped-up 等），不能继续当成可同步歌词。
const LYRIC_DURATION_TOLERANCE_SECONDS: f64 = 8.0;

/// 在线试听没有歌词 sidecar；进程内成功缓存覆盖一个正常听歌会话即可。
const LYRIC_SUCCESS_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// “没找到”必须记住，避免悬浮窗、切歌和重新挂载反复扫三个平台；又不能永久
/// 阻止平台后来补上的歌词，所以使用有限负缓存。
const LYRIC_MISSING_TTL: Duration = Duration::from_secs(2 * 60 * 60);
const MAX_LYRIC_CACHE_ENTRIES: usize = 1_024;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct LyricsCacheKey {
    title: String,
    artist: String,
    duration_seconds: Option<i64>,
    platform: Option<Platform>,
    source_key: String,
    engines: Vec<Platform>,
    prefer: String,
}

#[derive(Debug, Clone)]
struct CachedLyricsError {
    status: StatusCode,
    detail: String,
}

type CachedLyricsResult = Result<LyricsResponse, CachedLyricsError>;

struct LyricsCacheEntry {
    created_at: Instant,
    result: Arc<OnceCell<CachedLyricsResult>>,
}

/// 所有 WebView 共用的歌词单飞与结果缓存。前端的 Zustand store 只能约束单个
/// WebView；悬浮歌词是另一张 WebView，必须在共享的 Rust 进程再守一次边界。
pub struct LyricsLookupCache {
    entries: Mutex<HashMap<LyricsCacheKey, LyricsCacheEntry>>,
}

impl Default for LyricsLookupCache {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl LyricsLookupCache {
    fn result_ttl(result: &CachedLyricsResult) -> Option<Duration> {
        match result {
            Ok(_) => Some(LYRIC_SUCCESS_TTL),
            Err(error) if error.status == StatusCode::NOT_FOUND => Some(LYRIC_MISSING_TTL),
            Err(_) => None,
        }
    }

    fn entry(&self, key: LyricsCacheKey) -> Arc<OnceCell<CachedLyricsResult>> {
        let now = Instant::now();
        let mut entries = self.entries.lock().unwrap_or_else(|lock| lock.into_inner());
        entries.retain(|_, entry| match entry.result.get() {
            None => true,
            Some(result) => Self::result_ttl(result)
                .is_some_and(|ttl| now.saturating_duration_since(entry.created_at) < ttl),
        });
        if let Some(entry) = entries.get(&key) {
            return entry.result.clone();
        }
        while entries.len() >= MAX_LYRIC_CACHE_ENTRIES {
            let victim = entries
                .iter()
                .filter(|(_, entry)| entry.result.get().is_some())
                .min_by_key(|(_, entry)| entry.created_at)
                .map(|(key, _)| key.clone());
            let Some(victim) = victim else { break };
            entries.remove(&victim);
        }
        let result = Arc::new(OnceCell::new());
        entries.insert(
            key,
            LyricsCacheEntry {
                created_at: now,
                result: result.clone(),
            },
        );
        result
    }

    fn remove_if_uncacheable(
        &self,
        key: &LyricsCacheKey,
        result: &Arc<OnceCell<CachedLyricsResult>>,
        value: &CachedLyricsResult,
    ) {
        if Self::result_ttl(value).is_some() {
            return;
        }
        let mut entries = self.entries.lock().unwrap_or_else(|lock| lock.into_inner());
        if entries
            .get(key)
            .is_some_and(|entry| Arc::ptr_eq(&entry.result, result))
        {
            entries.remove(key);
        }
    }
}

fn artists_compatible(requested: &[String], source: &SongSource) -> bool {
    let requested = normalize_artists(requested);
    let source = normalize_artists(&source.artists);
    // 本地文件没有艺人标签，或平台候选没有艺人时，仍允许标题 + 时长匹配。
    requested.is_empty() || source.is_empty() || !requested.is_disjoint(&source)
}

fn durations_compatible(requested: Option<f64>, candidate: Option<f64>) -> bool {
    let (Some(requested), Some(candidate)) = (
        requested.filter(|value| value.is_finite() && *value > 0.0),
        candidate.filter(|value| value.is_finite() && *value > 0.0),
    ) else {
        return true;
    };
    (requested - candidate).abs() <= LYRIC_DURATION_TOLERANCE_SECONDS
}

fn latest_lrc_timestamp(raw: &str) -> Option<f64> {
    let mut latest: Option<f64> = None;
    for row in raw.lines() {
        let bytes = row.trim().as_bytes();
        let mut cursor = 0;
        while bytes.get(cursor) == Some(&b'[') {
            let Some(relative_end) = bytes[cursor + 1..].iter().position(|byte| *byte == b']')
            else {
                break;
            };
            let end = cursor + 1 + relative_end;
            let stamp = std::str::from_utf8(&bytes[cursor + 1..end]).ok()?;
            let Some((minutes, seconds)) = stamp.split_once(':') else {
                cursor = end + 1;
                continue;
            };
            if let (Ok(minutes), Ok(seconds)) =
                (minutes.trim().parse::<f64>(), seconds.trim().parse::<f64>())
            {
                let time = minutes * 60.0 + seconds;
                if time.is_finite() && time >= 0.0 {
                    latest = Some(latest.map_or(time, |value| value.max(time)));
                }
            }
            cursor = end + 1;
        }
    }
    latest
}

fn latest_yrc_timestamp(raw: &str) -> Option<f64> {
    let mut latest: Option<f64> = None;
    for row in raw.lines() {
        let row = row.trim();
        let Some(header_end) = row.find(']') else {
            continue;
        };
        let Some(header) = row.get(1..header_end) else {
            continue;
        };
        let Some((start, duration)) = header.split_once(',') else {
            continue;
        };
        let (Ok(start), Ok(duration)) =
            (start.trim().parse::<f64>(), duration.trim().parse::<f64>())
        else {
            continue;
        };
        let end = (start + duration.max(0.0)) / 1_000.0;
        if end.is_finite() && end >= 0.0 {
            latest = Some(latest.map_or(end, |value| value.max(end)));
        }
    }
    latest
}

/// 防止短 edit / remix 沿用来源 key 后直取到原版长歌词。标题和艺人完全一致时，
/// 普通匹配分仍会很高，只有候选时长与歌词自身时间轴能识别这种版本错配。
pub(crate) fn lyric_timeline_compatible(duration: Option<f64>, lrc: &str, word_lrc: &str) -> bool {
    let Some(duration) = duration.filter(|value| value.is_finite() && *value > 0.0) else {
        return true;
    };
    let latest = [latest_lrc_timestamp(lrc), latest_yrc_timestamp(word_lrc)]
        .into_iter()
        .flatten()
        .max_by(f64::total_cmp);
    latest.is_none_or(|time| time <= duration + LYRIC_DURATION_TOLERANCE_SECONDS)
}

fn match_score(title: &str, artists: &[String], duration: Option<f64>, source: &SongSource) -> f64 {
    0.6 * title_similarity(title, &source.title)
        + 0.3 * artist_similarity(artists, &source.artists)
        + 0.1 * duration_similarity(duration, source.duration)
}

fn query_of(title: &str, artist: &str) -> String {
    let title = title.trim();
    let artist = artist.trim();
    if artist.is_empty() || artist.eq_ignore_ascii_case("unknown") {
        title.to_string()
    } else {
        format!("{title} {artist}")
    }
}

fn response_of(
    text: LyricText,
    platform: Platform,
    key: String,
    title: String,
    artist: String,
    score: f64,
) -> LyricsResponse {
    LyricsResponse {
        lrc: text.lrc,
        word_lrc: text.word_lrc,
        translated_lrc: text.translated_lrc,
        romaji_lrc: text.romaji_lrc,
        platform,
        key,
        title,
        artist,
        score,
    }
}

fn is_lyric_engine(platform: Platform) -> bool {
    matches!(platform, Platform::Wyy | Platform::Qqm | Platform::Ytm)
}

/// 只保留网易云 / QQ / YouTube Music，去重且保序；空则默认三家。
fn normalize_engines(engines: &[Platform]) -> Vec<Platform> {
    let mut out = Vec::new();
    for platform in engines {
        if is_lyric_engine(*platform) && !out.contains(platform) {
            out.push(*platform);
        }
    }
    if out.is_empty() {
        out.extend([Platform::Wyy, Platform::Qqm, Platform::Ytm]);
    }
    out
}

fn parse_prefer(raw: &str) -> Option<Platform> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "wyy" => Some(Platform::Wyy),
        "qqm" => Some(Platform::Qqm),
        "ytm" => Some(Platform::Ytm),
        _ => None, // follow / 空 / 未知
    }
}

fn normalized_identity(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn cache_key(req: &LyricsRequest) -> LyricsCacheKey {
    LyricsCacheKey {
        title: normalized_identity(&req.title),
        artist: normalized_identity(&req.artist),
        duration_seconds: req
            .duration
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value.round() as i64),
        platform: req.platform,
        source_key: req.key.trim().to_string(),
        engines: normalize_engines(&req.engines),
        prefer: parse_prefer(&req.prefer)
            .map(Platform::as_str)
            .unwrap_or("follow")
            .to_string(),
    }
}

fn engine_label(platform: Platform) -> &'static str {
    match platform {
        Platform::Wyy => "网易云",
        Platform::Qqm => "QQ 音乐",
        Platform::Ytm => "YouTube Music",
        _ => "其它",
    }
}

fn engine_rank(engines: &[Platform], platform: Platform) -> usize {
    engines
        .iter()
        .position(|item| *item == platform)
        .unwrap_or(usize::MAX)
}

async fn fetch_lyric(provider: &Arc<dyn MusicProvider>, key: &str) -> Option<LyricText> {
    match provider.lyric(key).await {
        Ok(text) => text,
        Err(err) => {
            tracing::warn!("{} 取歌词失败：{err:#}", provider.label());
            None
        }
    }
}

async fn lyrics_for_source(
    state: &AppState,
    source: &SongSource,
    requested_duration: Option<f64>,
    score: f64,
) -> Option<LyricsResponse> {
    let provider = state.provider(source.platform)?;
    let text = fetch_lyric(provider, &source.key).await?;
    if !lyric_timeline_compatible(requested_duration, &text.lrc, &text.word_lrc) {
        tracing::warn!(
            platform = source.platform.as_str(),
            key = source.key,
            "忽略超出音频时长的歌词时间轴"
        );
        return None;
    }
    Some(response_of(
        text,
        source.platform,
        source.key.clone(),
        source.title.clone(),
        source.artist_text(),
        score,
    ))
}

pub async fn lookup(state: &AppState, req: LyricsRequest) -> ApiResult<LyricsResponse> {
    if req.title.trim().is_empty() {
        return Err(ApiError::bad_request("缺少曲名，无法搜歌词"));
    }
    let key = cache_key(&req);
    let cell = state.lyric_lookups.entry(key.clone());
    let cached = cell
        .get_or_init(|| async {
            lookup_uncached(state, req)
                .await
                .map_err(|error| CachedLyricsError {
                    status: error.status,
                    detail: error.detail,
                })
        })
        .await
        .clone();
    state
        .lyric_lookups
        .remove_if_uncacheable(&key, &cell, &cached);
    cached.map_err(|error| ApiError::new(error.status, error.detail))
}

async fn lookup_uncached(state: &AppState, req: LyricsRequest) -> ApiResult<LyricsResponse> {
    let title = req.title.trim().to_string();
    let artist = req.artist.trim().to_string();
    let artists: Vec<String> = if artist.is_empty() {
        Vec::new()
    } else {
        artist
            .split(['/', ',', '、', ';'])
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect()
    };

    let engines = normalize_engines(&req.engines);
    let prefer = parse_prefer(&req.prefer);

    // 强制显示来源时，只走那一家；跟随则尊重曲库来源（且该引擎已启用）。
    let direct_platform = match prefer {
        Some(forced) if engines.contains(&forced) => {
            if req.platform == Some(forced) && !req.key.trim().is_empty() {
                Some(forced)
            } else {
                None
            }
        }
        None => req.platform.filter(|platform| {
            is_lyric_engine(*platform) && engines.contains(platform) && !req.key.trim().is_empty()
        }),
        _ => None,
    };

    if let Some(platform) = direct_platform {
        if let Some(provider) = state.provider(platform) {
            if let Some(text) = fetch_lyric(provider, req.key.trim()).await {
                if lyric_timeline_compatible(req.duration, &text.lrc, &text.word_lrc) {
                    return Ok(response_of(
                        text,
                        platform,
                        req.key.trim().to_string(),
                        title.clone(),
                        artist.clone(),
                        1.0,
                    ));
                }
                tracing::warn!(
                    platform = platform.as_str(),
                    key = req.key.trim(),
                    "来源 key 的歌词时间轴与音频时长不符，降级为重新搜索"
                );
            }
        }
    }

    let search_platforms: Vec<Platform> = match prefer {
        Some(forced) if engines.contains(&forced) => vec![forced],
        _ => engines.clone(),
    };

    let query = query_of(&title, &artist);
    let mut candidates: Vec<(SongSource, f64)> = Vec::new();

    let mut searches = Vec::new();
    for platform in &search_platforms {
        let Some(provider) = state.provider(*platform).cloned() else {
            continue;
        };
        let q = query.clone();
        searches.push(async move {
            match provider.search(&q, 8).await {
                Ok(sources) => sources,
                Err(err) => {
                    tracing::warn!("{} 搜歌词候选失败：{err:#}", provider.label());
                    Vec::new()
                }
            }
        });
    }
    let batches = futures_util::future::join_all(searches).await;
    for sources in batches {
        for source in sources {
            if !engines.contains(&source.platform) {
                continue;
            }
            if let Some(forced) = prefer {
                if source.platform != forced {
                    continue;
                }
            }
            let score = match_score(&title, &artists, req.duration, &source);
            if artists_compatible(&artists, &source)
                && durations_compatible(req.duration, source.duration)
                && score >= LYRIC_MATCH_THRESHOLD
            {
                candidates.push((source, score));
            }
        }
    }

    // 高分优先；同分按引擎顺序（设置里的先后）。
    candidates.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                engine_rank(&engines, a.0.platform).cmp(&engine_rank(&engines, b.0.platform))
            })
    });

    for (source, score) in candidates {
        if let Some(hit) = lyrics_for_source(state, &source, req.duration, score).await {
            return Ok(hit);
        }
    }

    let engine_label = search_platforms
        .iter()
        .map(|platform| engine_label(*platform))
        .collect::<Vec<_>>()
        .join(" / ");
    Err(ApiError::not_found(format!(
        "没找到「{title}」的歌词（已查{engine_label}）"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(title: &str, artist: &str, duration: Option<f64>) -> SongSource {
        SongSource {
            platform: Platform::Wyy,
            key: "123".into(),
            title: title.into(),
            artists: if artist.is_empty() {
                Vec::new()
            } else {
                vec![artist.into()]
            },
            album: String::new(),
            duration,
            cover: String::new(),
            max_quality: None,
            vip: false,
            payload: Default::default(),
        }
    }

    #[test]
    fn lyric_search_rejects_same_title_from_a_different_artist() {
        let requested = vec!["EXIT TRANCE".to_string()];
        let original = source("only my railgun", "fripSide", Some(257.0));
        assert!(!artists_compatible(&requested, &original));
        assert!(
            match_score("only my railgun", &requested, Some(270.0), &original)
                < LYRIC_MATCH_THRESHOLD
        );
    }

    #[test]
    fn lyric_search_allows_exact_remix_and_missing_artist_metadata() {
        let requested = vec!["EXIT TRANCE".to_string()];
        let remix = source("only my railgun", "EXIT TRANCE", Some(270.0));
        assert!(artists_compatible(&requested, &remix));
        assert!(
            match_score("only my railgun", &requested, Some(270.0), &remix)
                >= LYRIC_MATCH_THRESHOLD
        );

        let unknown = vec!["Unknown".to_string()];
        let candidate_without_artist = source("only my railgun", "", Some(270.0));
        assert!(artists_compatible(&unknown, &candidate_without_artist));
    }

    #[test]
    fn lyric_search_rejects_a_long_original_for_a_short_edit() {
        let requested = vec!["下川みくに".to_string()];
        let original = source("もう一度君に会いたい", "下川みくに", Some(256.0));
        assert!(
            match_score(
                "もう一度君に会いたい(ebisu edit)",
                &requested,
                Some(124.7),
                &original,
            ) >= LYRIC_MATCH_THRESHOLD,
            "标题和艺人足以让旧逻辑误判为同一版本"
        );
        assert!(!durations_compatible(Some(124.7), original.duration));
    }

    #[test]
    fn lyric_timeline_rejects_lines_beyond_the_audio_duration() {
        let original = "[01:58.00]还在短版内\n[04:16.67]原版末句";
        assert!(!lyric_timeline_compatible(Some(124.7), original, ""));
        assert!(lyric_timeline_compatible(
            Some(124.7),
            "[01:58.00]短版末句",
            ""
        ));
        assert!(!lyric_timeline_compatible(
            Some(124.7),
            "",
            "[240000,16670](240000,16670,0)原版末句"
        ));
    }

    fn request(title: &str, duration: f64) -> LyricsRequest {
        LyricsRequest {
            title: title.into(),
            artist: "  ReoNa  ".into(),
            duration: Some(duration),
            platform: Some(Platform::Wyy),
            key: "12345".into(),
            engines: vec![Platform::Wyy, Platform::Wyy, Platform::Qqm],
            prefer: "FOLLOW".into(),
        }
    }

    #[test]
    fn lyric_cache_key_is_stable_across_window_metadata_noise() {
        assert_eq!(
            cache_key(&request("  TearJerker ", 178.1)),
            cache_key(&request("tearjerker", 178.4))
        );
    }

    #[test]
    fn lyric_missing_result_reuses_the_same_cache_cell() {
        let cache = LyricsLookupCache::default();
        let key = cache_key(&request("missing", 180.0));
        let first = cache.entry(key.clone());
        first
            .set(Err(CachedLyricsError {
                status: StatusCode::NOT_FOUND,
                detail: "没找到".into(),
            }))
            .unwrap();
        let second = cache.entry(key);
        assert!(Arc::ptr_eq(&first, &second));
    }
}
