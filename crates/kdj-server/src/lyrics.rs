//! 按曲名 / 艺人自动搜歌词：可指定引擎与显示来源，优先直取曲库来源。

use std::sync::Arc;

use kdj_core::models::{LyricsRequest, LyricsResponse, LyricText, Platform, SongSource};
use kdj_providers::MusicProvider;

use crate::aggregate::{artist_similarity, duration_similarity, title_similarity};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// 本地曲 ↔ 在线候选的匹配门槛；略低于同曲去重阈值，方便本地文件元数据不齐时仍能命中。
const LYRIC_MATCH_THRESHOLD: f64 = 0.55;

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

fn response_of(text: LyricText, platform: Platform, key: String, title: String, artist: String, score: f64) -> LyricsResponse {
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

/// 只保留网易云 / QQ，去重且保序；空则默认网易云 → QQ。
fn normalize_engines(engines: &[Platform]) -> Vec<Platform> {
    let mut out = Vec::new();
    for platform in engines {
        if matches!(platform, Platform::Wyy | Platform::Qqm) && !out.contains(platform) {
            out.push(*platform);
        }
    }
    if out.is_empty() {
        out.extend([Platform::Wyy, Platform::Qqm]);
    }
    out
}

fn parse_prefer(raw: &str) -> Option<Platform> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "wyy" => Some(Platform::Wyy),
        "qqm" => Some(Platform::Qqm),
        _ => None, // follow / 空 / 未知
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
            matches!(platform, Platform::Wyy | Platform::Qqm)
                && engines.contains(platform)
                && !req.key.trim().is_empty()
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
            if score >= LYRIC_MATCH_THRESHOLD {
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
        .map(|platform| match platform {
            Platform::Wyy => "网易云",
            Platform::Qqm => "QQ 音乐",
            _ => "其它",
        })
        .collect::<Vec<_>>()
        .join(" / ");
    Err(ApiError::not_found(format!(
        "没找到「{title}」的歌词（已查{engine_label}）"
    )))
}
