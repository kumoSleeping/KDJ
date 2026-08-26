//! 按曲名 / 艺人自动搜歌词：可指定引擎与显示来源，优先直取曲库来源。

use std::sync::Arc;

use kdj_core::models::{LyricText, LyricsRequest, LyricsResponse, Platform, SongSource};
use kdj_providers::MusicProvider;

use crate::aggregate::{
    artist_similarity, duration_similarity, normalize_artists, title_similarity,
};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// 本地曲 ↔ 在线候选的匹配门槛。歌词一旦命中就会被显示/缓存，不能像普通搜索
/// 那样只凭“标题相似”放过明显不同的艺人。
const LYRIC_MATCH_THRESHOLD: f64 = 0.65;

fn artists_compatible(requested: &[String], source: &SongSource) -> bool {
    let requested = normalize_artists(requested);
    let source = normalize_artists(&source.artists);
    // 本地文件没有艺人标签，或平台候选没有艺人时，仍允许标题 + 时长匹配。
    requested.is_empty() || source.is_empty() || !requested.is_disjoint(&source)
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
    score: f64,
) -> Option<LyricsResponse> {
    let provider = state.provider(source.platform)?;
    let text = fetch_lyric(provider, &source.key).await?;
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
    let title = req.title.trim().to_string();
    if title.is_empty() {
        return Err(ApiError::bad_request("缺少曲名，无法搜歌词"));
    }
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
                return Ok(response_of(
                    text,
                    platform,
                    req.key.trim().to_string(),
                    title.clone(),
                    artist.clone(),
                    1.0,
                ));
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
            if artists_compatible(&artists, &source) && score >= LYRIC_MATCH_THRESHOLD {
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
        if let Some(hit) = lyrics_for_source(state, &source, score).await {
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
}
