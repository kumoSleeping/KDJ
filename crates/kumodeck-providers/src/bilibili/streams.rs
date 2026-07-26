//! playurl 响应解析：DASH 双流选择 + 画质选项。
//!
//! Python 版这里踩过一个真实的 bug：`detect_best_streams` 的返回是
//! **定长二元组语义** `[视频流, 音频流]`，未命中的位置是 `None`。
//! 当时的代码 `[s for s in streams if s]` 先过滤掉 None 再按下标取，
//! 于是"没有视频流但有音频流"时，音频流滑到了下标 0，被当成视频流下载。
//!
//! Rust 这边直接用 `(Option<Stream>, Option<Stream>)`，
//! 下标错位这件事在类型上就不可能发生。

use kumodeck_core::models::VideoStreamOption;
use serde_json::Value;

/// 清晰度 id → (展示名, 画面高度)。
/// 比 bilibili_api 的 VideoQuality 枚举更全：6/74 会出现在 accept_quality 里但枚举没有。
const QUALITY_META: &[(i64, &str, i64)] = &[
    (6, "极速 240P", 240),
    (16, "流畅 360P", 360),
    (32, "清晰 480P", 480),
    (64, "高清 720P", 720),
    (74, "高清 720P60", 720),
    (80, "高清 1080P", 1080),
    (100, "智能修复", 1080),
    (112, "高清 1080P 高码率", 1080),
    (116, "高清 1080P60", 1080),
    (120, "超清 4K", 2160),
    (125, "真彩 HDR", 2160),
    (126, "杜比视界", 2160),
    (127, "超高清 8K", 4320),
];

/// 编码兼容性排序：同一档位有 AVC/HEV/AV1 三份时优先 AVC。
/// DJ 软件和 QuickTime 对 HEVC/AV1 的支持都很参差。
const CODEC_PRIORITY: [&str; 3] = ["avc", "hev", "av01"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaStream {
    pub url: String,
    pub quality_id: i64,
    pub codec: String,
    pub height: i64,
    pub bandwidth: i64,
}

/// playurl 的两种形态。
#[derive(Debug, Clone)]
pub enum PlayUrlData {
    /// DASH：视频和音频分开，要混流
    Dash {
        videos: Vec<MediaStream>,
        audios: Vec<MediaStream>,
    },
    /// durl：单文件 flv/mp4，直接就能用（安卓上没有 ffmpeg 时走这条）
    Single { url: String, container: String },
}

pub fn quality_meta(quality_id: i64, fallback_height: i64) -> (String, i64) {
    if let Some((_, label, height)) = QUALITY_META.iter().find(|(id, _, _)| *id == quality_id) {
        return ((*label).to_string(), *height);
    }
    let height = fallback_height;
    let label = if height > 0 {
        format!("{height}P")
    } else {
        format!("QN {quality_id}")
    };
    (label, height)
}

fn codec_rank(codec: &str) -> usize {
    let lower = codec.to_ascii_lowercase();
    CODEC_PRIORITY
        .iter()
        .position(|prefix| lower.starts_with(prefix))
        .unwrap_or(CODEC_PRIORITY.len())
}

/// 解析 playurl 的 data 段。
pub fn parse_playurl(data: &Value) -> PlayUrlData {
    // 有的接口把内容套在 video_info 里
    let root = data.get("video_info").unwrap_or(data);

    if let Some(dash) = root.get("dash").filter(|value| value.is_object()) {
        let videos = parse_streams(dash.get("video"));
        let audios = parse_streams(dash.get("audio"));
        if !videos.is_empty() || !audios.is_empty() {
            return PlayUrlData::Dash { videos, audios };
        }
    }
    if let Some(first) = root
        .get("durl")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
    {
        if let Some(url) = first.get("url").and_then(Value::as_str) {
            let container = if url.contains(".flv") { "flv" } else { "mp4" };
            return PlayUrlData::Single {
                url: url.to_string(),
                container: container.to_string(),
            };
        }
    }
    PlayUrlData::Dash {
        videos: Vec::new(),
        audios: Vec::new(),
    }
}

fn parse_streams(list: Option<&Value>) -> Vec<MediaStream> {
    let Some(list) = list.and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|item| {
            let url = item
                .get("baseUrl")
                .or_else(|| item.get("base_url"))
                .and_then(Value::as_str)
                .filter(|url| !url.is_empty())?;
            Some(MediaStream {
                url: url.to_string(),
                quality_id: item.get("id").and_then(Value::as_i64).unwrap_or(0),
                codec: item
                    .get("codecs")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                height: item.get("height").and_then(Value::as_i64).unwrap_or(0),
                bandwidth: item.get("bandwidth").and_then(Value::as_i64).unwrap_or(0),
            })
        })
        .collect()
}

/// 挑出最合适的一对流。
///
/// 返回 `(视频流, 音频流)`——**位置固定**，缺哪个哪个是 `None`。
pub fn pick_best(
    data: &PlayUrlData,
    max_height: i64,
) -> (Option<MediaStream>, Option<MediaStream>) {
    match data {
        PlayUrlData::Single { url, .. } => (
            Some(MediaStream {
                url: url.clone(),
                quality_id: 0,
                codec: String::new(),
                height: 0,
                bandwidth: 0,
            }),
            None,
        ),
        PlayUrlData::Dash { videos, audios } => {
            let video = videos
                .iter()
                .filter(|stream| stream.height <= max_height || stream.height == 0)
                .min_by_key(|stream| {
                    // 先要最接近上限的高度，再要兼容性最好的编码，最后要码率最高的
                    (
                        max_height.saturating_sub(stream.height),
                        codec_rank(&stream.codec),
                        -stream.bandwidth,
                    )
                })
                .or_else(|| {
                    // 全都超过上限时退而求其次，取最低的那档，别直接失败
                    videos.iter().min_by_key(|stream| stream.height)
                })
                .cloned();
            // 音频挑码率最高的；杜比全景声/Hi-Res 不是 AAC，塞进 m4a 后 DJ 软件读不了，
            // 而且没法 `-c:a copy`，所以只从常规 audio 数组里选（不碰 dolby/flac 分支）。
            let audio = audios
                .iter()
                .max_by_key(|stream| stream.bandwidth)
                .cloned();
            (video, audio)
        }
    }
}

/// 整理成前端画质下拉框用的选项，按 height 降序。
pub fn stream_options(data: &Value) -> Vec<VideoStreamOption> {
    let root = data.get("video_info").unwrap_or(data);
    let mut options: std::collections::BTreeMap<i64, VideoStreamOption> = Default::default();

    if let PlayUrlData::Dash { videos, .. } = parse_playurl(data) {
        for stream in videos {
            let (label, height) = quality_meta(stream.quality_id, stream.height);
            let entry = options.entry(stream.quality_id);
            // 同一档位可能有 AVC/HEV/AV1 三份，只留兼容性最好的那个编码名
            match entry {
                std::collections::btree_map::Entry::Vacant(slot) => {
                    slot.insert(VideoStreamOption {
                        quality_id: stream.quality_id,
                        label,
                        height,
                        codec: stream.codec,
                    });
                }
                std::collections::btree_map::Entry::Occupied(mut slot) => {
                    if codec_rank(&stream.codec) < codec_rank(&slot.get().codec) {
                        slot.get_mut().codec = stream.codec;
                    }
                }
            }
        }
    }

    if options.is_empty() {
        // flv / mp4 单流时退回接口自报的可选清晰度
        let ids = root
            .get("accept_quality")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let descriptions = root
            .get("accept_description")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (position, raw) in ids.iter().enumerate() {
            let Some(quality_id) = raw.as_i64() else {
                continue;
            };
            let (mut label, height) = quality_meta(quality_id, 0);
            if let Some(text) = descriptions
                .get(position)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                label = text.to_string();
            }
            options.insert(
                quality_id,
                VideoStreamOption {
                    quality_id,
                    label,
                    height,
                    codec: String::new(),
                },
            );
        }
    }

    let mut list: Vec<VideoStreamOption> = options.into_values().collect();
    list.sort_by(|a, b| {
        (b.height, b.quality_id)
            .partial_cmp(&(a.height, a.quality_id))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dash_payload() -> Value {
        json!({
            "dash": {
                "video": [
                    {"id": 80, "baseUrl": "https://cdn/v-1080-avc.m4s", "codecs": "avc1.640032", "height": 1080, "bandwidth": 3000},
                    {"id": 80, "baseUrl": "https://cdn/v-1080-hev.m4s", "codecs": "hev1.1.6.L120", "height": 1080, "bandwidth": 2500},
                    {"id": 120, "baseUrl": "https://cdn/v-4k.m4s", "codecs": "avc1.640033", "height": 2160, "bandwidth": 9000},
                    {"id": 32, "baseUrl": "https://cdn/v-480.m4s", "codecs": "avc1.64001f", "height": 480, "bandwidth": 800}
                ],
                "audio": [
                    {"id": 30216, "baseUrl": "https://cdn/a-64.m4s", "codecs": "mp4a.40.5", "bandwidth": 64000},
                    {"id": 30280, "baseUrl": "https://cdn/a-192.m4s", "codecs": "mp4a.40.2", "bandwidth": 192000}
                ]
            },
            "accept_quality": [120, 80, 32],
            "accept_description": ["超清 4K", "高清 1080P", "清晰 480P"]
        })
    }

    #[test]
    fn picks_the_highest_allowed_height_and_the_friendliest_codec() {
        let parsed = parse_playurl(&dash_payload());
        let (video, audio) = pick_best(&parsed, 1080);
        let video = video.expect("应当选出视频流");
        assert_eq!(video.height, 1080);
        assert_eq!(
            video.url, "https://cdn/v-1080-avc.m4s",
            "同一档位要挑 AVC，HEVC 很多 DJ 软件读不了"
        );
        assert_eq!(audio.unwrap().url, "https://cdn/a-192.m4s", "音频取最高码率");
    }

    #[test]
    fn respects_the_height_ceiling() {
        let parsed = parse_playurl(&dash_payload());
        let (video, _) = pick_best(&parsed, 480);
        assert_eq!(video.unwrap().height, 480);
    }

    #[test]
    fn falls_back_to_the_lowest_stream_when_everything_exceeds_the_ceiling() {
        let payload = json!({"dash": {"video": [
            {"id": 120, "baseUrl": "https://cdn/4k.m4s", "codecs": "avc1", "height": 2160}
        ], "audio": []}});
        let (video, audio) = pick_best(&parse_playurl(&payload), 360);
        assert!(video.is_some(), "宁可给个超规格的也不要直接失败");
        assert!(audio.is_none());
    }

    #[test]
    fn video_and_audio_positions_never_swap() {
        // 这就是 Python 版踩过的坑：只有音频没有视频时，
        // 过滤掉 None 会让音频滑到视频的位置上被当成视频下载。
        let payload = json!({"dash": {"video": [], "audio": [
            {"id": 30280, "baseUrl": "https://cdn/only-audio.m4s", "codecs": "mp4a.40.2", "bandwidth": 192000}
        ]}});
        let (video, audio) = pick_best(&parse_playurl(&payload), 1080);
        assert!(video.is_none(), "没有视频流就必须是 None");
        assert_eq!(audio.unwrap().url, "https://cdn/only-audio.m4s");
    }

    #[test]
    fn durl_single_stream_is_reported_as_video_only() {
        let payload = json!({"durl": [{"url": "https://cdn/whole.flv", "size": 123}]});
        let parsed = parse_playurl(&payload);
        assert!(matches!(parsed, PlayUrlData::Single { .. }));
        let (video, audio) = pick_best(&parsed, 1080);
        assert_eq!(video.unwrap().url, "https://cdn/whole.flv");
        assert!(audio.is_none(), "单流里音画已经在一起了");
    }

    #[test]
    fn options_are_deduped_per_quality_and_sorted_by_height() {
        let options = stream_options(&dash_payload());
        let ids: Vec<i64> = options.iter().map(|option| option.quality_id).collect();
        assert_eq!(ids, vec![120, 80, 32], "按高度降序");
        let p1080 = options.iter().find(|option| option.quality_id == 80).unwrap();
        assert!(p1080.codec.starts_with("avc"), "同档位只留最兼容的编码");
        assert_eq!(p1080.label, "高清 1080P");
    }

    #[test]
    fn options_fall_back_to_accept_quality_for_single_stream_videos() {
        let payload = json!({
            "durl": [{"url": "https://cdn/whole.mp4"}],
            "accept_quality": [80, 32],
            "accept_description": ["高清 1080P", "清晰 480P"]
        });
        let options = stream_options(&payload);
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].quality_id, 80);
        assert_eq!(options[0].label, "高清 1080P");
    }

    #[test]
    fn unknown_quality_ids_still_get_a_usable_label() {
        assert_eq!(quality_meta(74, 0), ("高清 720P60".to_string(), 720));
        assert_eq!(quality_meta(999, 540), ("540P".to_string(), 540));
        assert_eq!(quality_meta(999, 0), ("QN 999".to_string(), 0));
    }
}
