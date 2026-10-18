//! `kdj peek` / `kdj align`：给 AI 的眼睛和耳朵。媒体可以是曲库曲目、本地文件或
//! 尚未下载的 B 站视频；在线视频只按需读取画面帧或音轨，不下载成品。
//! 请求被中断（CLI 退出）时，handler 被丢弃，取消令牌随之触发，ffmpeg 与分析一并停下。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use axum::{extract::State, Json};
use kdj_analysis::alignment::{self, AudioFeatures, FuzzyPlacement, RecordingMatch};
use kdj_core::models::Platform;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::cli_api::{bilibili_video_input, recall, video_ref_source, Cached};
use crate::compositions::media::{capture, probe};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const MAX_FRAMES: usize = 48;
const SHEET_COLUMNS: usize = 4;
/// 对齐读取的最长音频，和工坊单段匹配的上限一致。
const MAX_AUDIO_SECONDS: usize = 1800;
const PEEK_KEEP: Duration = Duration::from_secs(24 * 3600);

enum Media {
    File { path: PathBuf, title: String, duration: Option<f64>, track_id: Option<i64> },
    Bilibili { bvid: String, page: usize, title: String, duration: Option<f64> },
}

impl Media {
    fn describe(&self) -> Value {
        match self {
            Media::File { path, title, duration, track_id } => {
                json!({ "path": path, "title": title, "duration": duration.map(round), "track_id": track_id })
            }
            Media::Bilibili { bvid, page, title, duration } => json!({
                "ref": if *page > 0 { format!("bilibili:{bvid}:p{}", page + 1) } else { format!("bilibili:{bvid}") },
                "title": title,
                "duration": duration.map(round),
                "online": true,
            }),
        }
    }

    fn duration(&self) -> Option<f64> {
        match self {
            Media::File { duration, .. } | Media::Bilibili { duration, .. } => *duration,
        }
    }
}

fn round(seconds: f64) -> f64 {
    (seconds * 1000.).round() / 1000.
}

fn url_page(text: &str) -> usize {
    reqwest::Url::parse(text)
        .ok()
        .and_then(|url| url.query_pairs().find(|(k, _)| k == "p").and_then(|(_, v)| v.parse::<usize>().ok()))
        .and_then(|p| p.checked_sub(1))
        .unwrap_or(0)
}

/// 曲库 id、本地路径、B 站引用或链接。YouTube 在线视频需要界面准备来源，先 download。
async fn resolve_media(state: &Arc<AppState>, source: &str, cancel: &CancellationToken) -> ApiResult<Media> {
    let source = source.trim();
    if let Ok(id) = source.parse::<i64>() {
        let track = state.library.get(id)?.ok_or_else(|| ApiError::not_found(format!("曲库里没有 id {id}")))?;
        return Ok(Media::File {
            path: PathBuf::from(&track.path),
            title: track.title,
            duration: track.duration,
            track_id: Some(id),
        });
    }
    let path = Path::new(source);
    if path.is_absolute() {
        if !path.is_file() {
            return Err(ApiError::not_found(format!("文件不存在：{source}")));
        }
        let duration = probe(path, cancel)
            .await
            .ok()
            .and_then(|p| p.format.duration.parse::<f64>().ok());
        return Ok(Media::File {
            path: path.to_path_buf(),
            title: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            duration,
            track_id: None,
        });
    }
    let (bvid, page) = if let Some(Cached::Song(song)) = recall(source).filter(|c| matches!(c, Cached::Song(s) if s.platform == Platform::Bilibili)) {
        let page = song.payload.get("page_index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let bvid = song.payload.get("bvid").and_then(Value::as_str).unwrap_or(&song.key).to_string();
        (bvid, page)
    } else if let Some(song) = video_ref_source(source) {
        if song.platform != Platform::Bilibili {
            return Err(ApiError::bad_request("YouTube 在线视频请先 download，再用曲库 id 或文件路径"));
        }
        let page = song.payload.get("page_index").and_then(Value::as_u64).unwrap_or(0) as usize;
        (song.key, page)
    } else if bilibili_video_input(source) {
        (String::new(), url_page(source))
    } else {
        return Err(ApiError::bad_request(format!(
            "无法识别的媒体：{source}；可用曲库 id、绝对路径、bilibili 引用或链接"
        )));
    };
    let provider = state
        .video_provider(Platform::Bilibili)
        .ok_or_else(|| ApiError::bad_request("哔哩哔哩不可用"))?;
    let info = provider.resolve_video(if bvid.is_empty() { source } else { bvid.as_str() }).await?;
    let duration = info
        .pages
        .iter()
        .find(|p| p.index == page)
        .map(|p| p.duration as f64)
        .or(Some(info.duration as f64))
        .filter(|d| *d > 0.);
    Ok(Media::Bilibili { bvid: info.bvid, page, title: info.title, duration })
}

fn bilibili_headers(cookies: &str) -> String {
    let mut headers = "Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0\r\n".to_string();
    if !cookies.is_empty() {
        headers.push_str(&format!("Cookie: {cookies}\r\n"));
    }
    headers
}

/// ffmpeg 的输入参数：本地文件直接读；B 站带防盗链头读 CDN。`audio` 只取音轨流。
async fn input_args(state: &Arc<AppState>, media: &Media, audio: bool) -> ApiResult<Vec<String>> {
    Ok(match media {
        Media::File { path, .. } => vec!["-i".into(), path.to_string_lossy().into_owned()],
        Media::Bilibili { bvid, page, .. } => {
            let (url, cookies) = if audio {
                state.bilibili_preview.calibration_audio_source(bvid, *page).await
            } else {
                state.bilibili_preview.preview_source(bvid, *page).await
            }
            .map_err(|error| ApiError::bad_request(format!("读取哔哩哔哩视频失败：{error:#}")))?;
            vec!["-headers".into(), bilibili_headers(&cookies), "-i".into(), url]
        }
    })
}

// ---------------------------------------------------------------- peek

#[derive(Deserialize)]
pub struct PeekBody {
    source: String,
    #[serde(default)]
    at: Vec<f64>,
    #[serde(default)]
    every: Option<f64>,
    #[serde(default)]
    width: Option<u32>,
}

fn peek_root() -> PathBuf {
    std::env::temp_dir().join("kdj-peek")
}

/// 截图只给 AI 当场看，留一天就清掉。
fn sweep_old_peeks() {
    let Ok(entries) = std::fs::read_dir(peek_root()) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > PEEK_KEEP);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn peek_times(body: &PeekBody, duration: Option<f64>) -> ApiResult<Vec<f64>> {
    let mut times: Vec<f64> = body.at.iter().copied().filter(|t| t.is_finite() && *t >= 0.).collect();
    if let Some(every) = body.every {
        if !(every.is_finite() && every > 0.) {
            return Err(ApiError::bad_request("--every 必须大于 0"));
        }
        let duration = duration.ok_or_else(|| ApiError::bad_request("读不到时长，请改用 --at"))?;
        let mut t = 0.;
        while t < duration && times.len() < MAX_FRAMES {
            times.push(t);
            t += every;
        }
    }
    if times.is_empty() {
        return Err(ApiError::bad_request("需要 --at 或 --every"));
    }
    if let Some(duration) = duration {
        // 末尾那一帧往前收一点，避免 seek 到结尾取不到画面。
        for t in &mut times {
            *t = t.min((duration - 0.1).max(0.));
        }
    }
    times.truncate(MAX_FRAMES);
    Ok(times)
}

pub async fn peek(State(state): State<Arc<AppState>>, Json(body): Json<PeekBody>) -> ApiResult<Json<Value>> {
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    let media = resolve_media(&state, &body.source, &cancel).await?;
    let times = peek_times(&body, media.duration())?;
    let width = body.width.unwrap_or(480).clamp(160, 1280);
    sweep_old_peeks();
    let dir = peek_root().join(format!("{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(&dir).map_err(|e| ApiError::bad_request(format!("创建截图目录失败：{e}")))?;
    let ffmpeg = kdj_providers::ffmpeg::binary()?;
    let input = input_args(&state, &media, false).await?;
    let mut frames = Vec::new();
    let mut failed = Vec::new();
    for t in &times {
        let file = dir.join(format!("frame-{:02}.jpg", frames.len() + 1));
        let mut args: Vec<String> = vec!["-v".into(), "error".into(), "-nostdin".into(), "-ss".into(), format!("{t:.3}")];
        args.extend(input.iter().cloned());
        args.extend(
            ["-an", "-frames:v", "1", "-vf"]
                .map(str::to_owned)
                .into_iter()
                .chain([format!("scale={width}:-2"), "-q:v".into(), "4".into(), "-y".into()])
                .chain([file.to_string_lossy().into_owned()]),
        );
        match capture(&ffmpeg, &args, 1024, Duration::from_secs(60), &cancel).await {
            Ok(_) if file.is_file() => frames.push(json!({ "at": round(*t), "path": file })),
            Ok(_) => failed.push(json!({ "at": round(*t), "error": "没有取到画面" })),
            Err(error) => {
                if cancel.is_cancelled() {
                    return Err(ApiError::bad_request("已取消"));
                }
                failed.push(json!({ "at": round(*t), "error": format!("{error:#}") }));
            }
        }
    }
    let mut result = json!({ "source": media.describe(), "frames": frames, "dir": dir });
    if !failed.is_empty() {
        result["failed"] = json!(failed);
    }
    if frames.len() > 1 {
        let columns = SHEET_COLUMNS.min(frames.len());
        let rows = frames.len().div_ceil(columns);
        let sheet = dir.join("sheet.jpg");
        let args: Vec<String> = [
            "-v", "error", "-nostdin", "-framerate", "1", "-start_number", "1", "-i",
        ]
        .map(str::to_owned)
        .into_iter()
        .chain([dir.join("frame-%02d.jpg").to_string_lossy().into_owned()])
        .chain(["-vf".into(), format!("tile={columns}x{rows}:padding=4:margin=4"), "-frames:v".into(), "1".into()])
        .chain(["-q:v".into(), "4".into(), "-y".into(), sheet.to_string_lossy().into_owned()])
        .collect();
        if capture(&ffmpeg, &args, 1024, Duration::from_secs(60), &cancel).await.is_ok() && sheet.is_file() {
            result["sheet"] = json!({
                "path": sheet,
                "columns": columns,
                "rows": rows,
                "order": "从左到右、从上到下，与 frames 顺序一致",
            });
        }
    }
    Ok(Json(result))
}

// ---------------------------------------------------------------- align

#[derive(Deserialize)]
pub struct AlignBody {
    reference: String,
    video: String,
}

async fn pcm(state: &Arc<AppState>, media: &Media, cancel: &CancellationToken) -> ApiResult<Vec<f32>> {
    let mut args: Vec<String> = ["-v", "error", "-nostdin", "-threads", "1"].map(str::to_owned).to_vec();
    args.extend(input_args(state, media, true).await?);
    args.extend(["-map", "0:a:0", "-t"].map(str::to_owned));
    args.push(MAX_AUDIO_SECONDS.to_string());
    args.extend(["-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"].map(str::to_owned));
    let data = capture(
        &kdj_providers::ffmpeg::binary()?,
        &args,
        (alignment::SAMPLE_RATE * 4 * MAX_AUDIO_SECONDS + 4096) as u64,
        Duration::from_secs(600),
        cancel,
    )
    .await
    .map_err(|error| ApiError::bad_request(format!("读取音轨失败：{error:#}")))?;
    Ok(data.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect())
}

struct Segment {
    video_in: f64,
    video_out: f64,
    ref_at: f64,
    speed: f64,
}

impl Segment {
    fn from_fuzzy(p: &FuzzyPlacement) -> Self {
        Segment { video_in: p.source_start_ms, video_out: p.source_end_ms, ref_at: p.reference_start_ms, speed: p.speed }
    }
}

/// 参考曲的小节号（1 起，带小数）。没有节拍网格时不给。
fn bar_at(downbeats: &[f64], seconds: f64) -> Option<f64> {
    if downbeats.len() < 2 || seconds < downbeats[0] {
        return None;
    }
    let i = downbeats.partition_point(|d| *d <= seconds).saturating_sub(1);
    let start = downbeats[i];
    // 最后一小节沿用前一小节的长度。
    let next = downbeats.get(i + 1).copied().unwrap_or_else(|| start + (start - downbeats[i - 1]));
    let fraction = ((seconds - start) / (next - start).max(0.001)).clamp(0., 0.999);
    Some((((i + 1) as f64 + fraction) * 100.).round() / 100.)
}

fn plan(id: &str, label: &str, evidence: &str, auto: bool, similarity: Option<f64>, segments: &[Segment], downbeats: &[f64]) -> Value {
    let first = &segments[0];
    let speed = first.speed;
    let mut value = json!({
        "id": id,
        "label": label,
        "evidence": evidence,
        "auto": auto,
        "speed": (speed * 10000.).round() / 10000.,
        // 视频 0 秒对应参考曲的时间（秒）。
        "offset": round((first.ref_at - first.video_in / speed) / 1000.),
        "segments": segments.iter().map(|s| {
            let ref_at = s.ref_at / 1000.;
            let mut seg = json!({
                "video_in": round(s.video_in / 1000.),
                "video_out": round(s.video_out / 1000.),
                "ref_at": round(ref_at),
                "speed": (s.speed * 10000.).round() / 10000.,
            });
            if let Some(bar) = bar_at(downbeats, ref_at) {
                seg["ref_bar"] = json!(bar);
            }
            seg
        }).collect::<Vec<_>>(),
    });
    if let Some(similarity) = similarity {
        value["similarity"] = json!((similarity * 1000.).round() / 1000.);
    }
    value
}

fn plans(found: &RecordingMatch, video_ms: f64, reference_ms: f64, downbeats: &[f64]) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(offset) = found.offset_ms {
        let video_in = (-offset).max(0.);
        let video_out = video_ms.min(reference_ms - offset);
        if video_out > video_in {
            out.push(plan("whole", "完整对齐", "verified", true, None,
                &[Segment { video_in, video_out, ref_at: video_in + offset, speed: 1. }], downbeats));
        }
    }
    if found.sections.len() > 1 {
        let segments: Vec<Segment> = found
            .sections
            .iter()
            .map(|s| Segment {
                video_in: s.video_start_ms as f64,
                video_out: (s.video_start_ms + s.duration_ms) as f64,
                ref_at: s.audio_start_ms as f64,
                speed: 1.,
            })
            .collect();
        out.push(plan("sections", "裁切匹配段", "verified", true, None, &segments, downbeats));
    }
    let verified = &found.fuzzy.verified;
    if let Some(longest) = verified
        .iter()
        .max_by(|a, b| (a.source_end_ms - a.source_start_ms).total_cmp(&(b.source_end_ms - b.source_start_ms)))
    {
        let similarity = verified.iter().map(|p| p.similarity).sum::<f64>() / verified.len() as f64;
        let mut whole = plan(
            "speed-whole",
            "变速对齐 · 保留完整",
            "verified",
            true,
            Some(similarity),
            &[Segment {
                video_in: 0.,
                video_out: video_ms,
                ref_at: longest.reference_start_ms - longest.source_start_ms / longest.speed,
                speed: longest.speed,
            }],
            downbeats,
        );
        whole["verified"] = json!(verified
            .iter()
            .map(|p| [round(p.source_start_ms / 1000.), round(p.source_end_ms / 1000.)])
            .collect::<Vec<_>>());
        out.push(whole);
        if verified.len() > 1 {
            let segments: Vec<Segment> = verified.iter().map(Segment::from_fuzzy).collect();
            out.push(plan("speed-sections", "变速分段匹配", "verified", true, Some(similarity), &segments, downbeats));
        }
    }
    for (n, candidate) in found.fuzzy.review.iter().enumerate() {
        out.push(plan(&format!("melody-{}", n + 1), &format!("旋律候选 {}", n + 1), "melody", false,
            Some(candidate.similarity), &[Segment::from_fuzzy(candidate)], downbeats));
    }
    for (n, pieces) in found.short_review.iter().enumerate().filter(|(_, p)| !p.is_empty()) {
        let segments: Vec<Segment> = pieces.iter().map(Segment::from_fuzzy).collect();
        let similarity = pieces.iter().map(|p| p.similarity).sum::<f64>() / pieces.len() as f64;
        out.push(plan(&format!("short-{}", n + 1), "短版分段匹配", "partial", false, Some(similarity), &segments, downbeats));
    }
    out
}

pub async fn align(State(state): State<Arc<AppState>>, Json(body): Json<AlignBody>) -> ApiResult<Json<Value>> {
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    let reference = resolve_media(&state, &body.reference, &cancel).await?;
    let video = resolve_media(&state, &body.video, &cancel).await?;
    let (reference_pcm, video_pcm) = tokio::try_join!(pcm(&state, &reference, &cancel), pcm(&state, &video, &cancel))?;
    let reference_ms = reference_pcm.len() as f64 * 1000. / alignment::SAMPLE_RATE as f64;
    let video_ms = video_pcm.len() as f64 * 1000. / alignment::SAMPLE_RATE as f64;
    let worker_cancel = cancel.clone();
    let found = tokio::task::spawn_blocking(move || -> anyhow::Result<RecordingMatch> {
        let _background = kdj_core::thread_qos::prefer_background();
        let canceled = || worker_cancel.is_cancelled();
        let source = AudioFeatures::prepare(&video_pcm, canceled)?;
        let target = AudioFeatures::prepare(&reference_pcm, canceled)?;
        let mut found = alignment::compare_blocks(&source, &target, true, false, &canceled)?;
        if found.fuzzy.verified.len() == 1 {
            for candidate in found.fuzzy.review.clone() {
                if let Some(plan) = alignment::short_review_pair(&source, &target, &found.fuzzy.verified[0], &candidate, &canceled)? {
                    found.short_review.push(plan);
                }
            }
        }
        Ok(found)
    })
    .await
    .map_err(|error| ApiError::bad_request(format!("对齐任务失败：{error}")))??;
    let downbeats = match &reference {
        Media::File { track_id: Some(id), .. } => state.library.rhythm(*id).ok().flatten().map(|r| r.downbeats).unwrap_or_default(),
        _ => Vec::new(),
    };
    let plans = plans(&found, video_ms, reference_ms, &downbeats);
    let mut result = json!({
        "reference": reference.describe(),
        "video": video.describe(),
        "matched": !plans.is_empty(),
        "formula": "ref = ref_at + (video - video_in) / speed，单位秒",
        "plans": plans,
    });
    if !found.reason.is_empty() {
        result["reason"] = json!(found.reason);
    }
    if downbeats.is_empty() {
        result["note"] = json!("参考曲没有小节线（还没分析，或网格里没有找到小节），ref_bar 未给出；可先 kdj library get 该曲目");
    }
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kdj_core::composition::CompositionVideoSection;

    #[test]
    fn bars_count_from_one_with_a_fraction() {
        let downbeats = [1.0, 3.0, 5.0, 7.0];
        assert_eq!(bar_at(&downbeats, 0.5), None);
        assert_eq!(bar_at(&downbeats, 1.0), Some(1.0));
        assert_eq!(bar_at(&downbeats, 4.0), Some(2.5));
        assert_eq!(bar_at(&[], 4.0), None);
    }

    #[test]
    fn an_exact_offset_becomes_one_whole_segment_in_seconds() {
        let found = RecordingMatch { offset_ms: Some(-12_000.), ..Default::default() };
        let plans = plans(&found, 200_000., 300_000., &[]);
        assert_eq!(plans.len(), 1);
        let whole = &plans[0];
        assert_eq!(whole["id"], "whole");
        assert_eq!(whole["offset"], json!(-12.0));
        assert_eq!(whole["segments"][0]["video_in"], json!(12.0));
        assert_eq!(whole["segments"][0]["ref_at"], json!(0.0));
        assert_eq!(whole["segments"][0]["video_out"], json!(200.0));
    }

    #[test]
    fn sections_and_speed_plans_keep_their_evidence() {
        let found = RecordingMatch {
            offset_ms: Some(0.),
            sections: vec![
                CompositionVideoSection { audio_start_ms: 0, video_start_ms: 0, duration_ms: 10_000 },
                CompositionVideoSection { audio_start_ms: 20_000, video_start_ms: 10_000, duration_ms: 10_000 },
            ],
            ..Default::default()
        };
        let ids: Vec<_> = plans(&found, 20_000., 40_000., &[]).iter().map(|p| p["id"].clone()).collect();
        assert_eq!(ids, vec![json!("whole"), json!("sections")]);

        let mut found = RecordingMatch::default();
        let span = FuzzyPlacement {
            source_start_ms: 10_000., source_end_ms: 70_000., reference_start_ms: 30_000.,
            speed: 1.02, similarity: 0.8, anchors: 4,
        };
        found.fuzzy.verified = vec![span.clone()];
        found.fuzzy.review = vec![FuzzyPlacement { similarity: 0.4, ..span }];
        let plans = plans(&found, 100_000., 200_000., &[]);
        assert_eq!(plans[0]["id"], "speed-whole");
        assert_eq!(plans[0]["auto"], true);
        assert_eq!(plans[0]["verified"], json!([[10.0, 70.0]]));
        assert_eq!(plans[1]["id"], "melody-1");
        assert_eq!(plans[1]["evidence"], "melody");
        assert_eq!(plans[1]["auto"], false);
    }
}
