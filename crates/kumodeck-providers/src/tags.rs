//! 下载完写入标题 / 艺人 / 专辑 / 封面。
//!
//! Python 版是 mutagen，按扩展名分成 mp3 / flac / m4a / ogg / opus 五个分支各写各的。
//! lofty 把这些统一到一个抽象上，所以这里只有一份代码——但**格式覆盖必须一致**，
//! 少一种格式就意味着那个平台下下来的文件没有封面。
//!
//! 分析结果（BPM / KEY）不在这里写，那是 library 层 `write-tags` 的活。

use std::path::Path;

use anyhow::{Context, Result};
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, TagExt};

/// 支持的音频扩展名。曲库扫描也用这一份，两边必须一致。
pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "m4a", "mp4", "aac", "ogg", "opus", "wav", "aiff", "aif", "wma", "alac",
];

pub fn is_audio_extension(ext: &str) -> bool {
    let lower = ext.trim_start_matches('.').to_ascii_lowercase();
    AUDIO_EXTENSIONS.contains(&lower.as_str())
}

fn cover_mime(data: &[u8]) -> MimeType {
    if data.starts_with(b"\x89PNG") {
        MimeType::Png
    } else {
        MimeType::Jpeg
    }
}

/// 写入标题 / 艺人 / 专辑 / 封面。
///
/// 写标签失败**不该让下载算失败**——文件本身已经好了。调用方负责只记一条 warn。
pub fn embed_metadata(
    path: &Path,
    title: &str,
    artists: &[String],
    album: &str,
    cover: Option<&[u8]>,
) -> Result<()> {
    let mut tagged = Probe::open(path)
        .with_context(|| format!("打开音频文件失败：{}", path.display()))?
        .read()
        .with_context(|| format!("解析音频文件失败：{}", path.display()))?;

    let tag_type = tagged.primary_tag_type();
    if tagged.primary_tag_mut().is_none() {
        tagged.insert_tag(lofty::tag::Tag::new(tag_type));
    }
    let tag = tagged.primary_tag_mut().expect("刚插入过一定存在");

    tag.set_title(title.to_string());
    if !album.is_empty() {
        tag.set_album(album.to_string());
    }
    // 多艺人：mutagen 写的是多值帧，lofty 这边用 `/` 连接是各家播放器最通用的读法。
    let artist_text = if artists.is_empty() {
        "Unknown".to_string()
    } else {
        artists.join("/")
    };
    tag.insert_text(ItemKey::TrackArtist, artist_text);

    if let Some(data) = cover {
        if !data.is_empty() {
            let picture = Picture::unchecked(data.to_vec())
                .pic_type(PictureType::CoverFront)
                .mime_type(cover_mime(data))
                .description("Cover")
                .build();
            // 先清掉旧封面，否则某些容器会累积成一堆图片
            while tag.pictures().first().is_some() {
                tag.remove_picture(0);
            }
            tag.push_picture(picture);
        }
    }

    tag.save_to_path(path, WriteOptions::default())
        .with_context(|| format!("写标签失败：{}", path.display()))?;
    Ok(())
}

/// 读时长（秒）。用于"试听片段"检测和曲库扫描。
pub fn read_duration_secs(path: &Path) -> Option<f64> {
    let tagged = Probe::open(path).ok()?.read().ok()?;
    let secs = tagged.properties().duration().as_secs_f64();
    if secs > 0.0 {
        Some(secs)
    } else {
        None
    }
}

/// 扫描入库时读到的元数据。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TrackTags {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub year: String,
    pub duration: Option<f64>,
    pub bitrate: Option<i64>,
    pub samplerate: Option<i64>,
    pub channels: Option<i64>,
    pub format: String,
}

/// 读一个音频文件的标签与技术参数。
///
/// 读不出来**不报错**，返回尽可能填满的结构——扫描里遇到一个怪文件
/// 不该让整次扫描中断，标题退回文件名即可。
pub fn read_tags(path: &Path) -> TrackTags {
    let mut out = TrackTags {
        format: path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase(),
        ..Default::default()
    };
    let Ok(tagged) = Probe::open(path).and_then(|probe| probe.read()) else {
        return out;
    };

    let properties = tagged.properties();
    let secs = properties.duration().as_secs_f64();
    if secs > 0.0 {
        out.duration = Some(secs);
    }
    out.bitrate = properties.audio_bitrate().map(|value| value as i64);
    out.samplerate = properties.sample_rate().map(|value| value as i64);
    out.channels = properties.channels().map(|value| value as i64);

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        out.title = tag.title().unwrap_or_default().trim().to_string();
        out.artist = tag.artist().unwrap_or_default().trim().to_string();
        out.album = tag.album().unwrap_or_default().trim().to_string();
        out.genre = tag.genre().unwrap_or_default().trim().to_string();
        out.year = tag
            .get_string(ItemKey::Year)
            .or_else(|| tag.get_string(ItemKey::RecordingDate))
            .unwrap_or_default()
            .trim()
            .to_string();
    }
    out
}

/// 把分析结果写进文件标签（BPM / KEY / 能量）。
///
/// 用户点「写入标签」时调用。写的是各家 DJ 软件都认的通用键。
pub fn write_analysis_tags(
    path: &Path,
    bpm: Option<f64>,
    camelot: &str,
    music_key: &str,
    energy: Option<i64>,
) -> Result<()> {
    let mut tagged = Probe::open(path)
        .with_context(|| format!("打开音频文件失败：{}", path.display()))?
        .read()
        .with_context(|| format!("解析音频文件失败：{}", path.display()))?;
    let tag_type = tagged.primary_tag_type();
    if tagged.primary_tag_mut().is_none() {
        tagged.insert_tag(lofty::tag::Tag::new(tag_type));
    }
    let tag = tagged.primary_tag_mut().expect("刚插入过一定存在");

    if let Some(bpm) = bpm.filter(|value| *value > 0.0) {
        // BPM 写整数：ID3 的 TBPM 规范上就是整数，写小数有些软件会读成 0
        tag.insert_text(ItemKey::Bpm, format!("{}", bpm.round() as i64));
    }
    if !camelot.is_empty() {
        tag.insert_text(ItemKey::InitialKey, camelot.to_string());
    }
    if !music_key.is_empty() {
        // Comment 里补一份人类可读的，方便在没有 KEY 字段的播放器里看
        let mut note = music_key.to_string();
        if let Some(energy) = energy {
            note.push_str(&format!(" · Energy {energy}"));
        }
        tag.insert_text(ItemKey::Comment, note);
    }

    tag.save_to_path(path, WriteOptions::default())
        .with_context(|| format!("写标签失败：{}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_extension_check_is_case_insensitive_and_dot_tolerant() {
        assert!(is_audio_extension("FLAC"));
        assert!(is_audio_extension(".Mp3"));
        assert!(is_audio_extension("opus"));
        assert!(!is_audio_extension("mp4v"));
        assert!(!is_audio_extension("txt"));
    }

    #[test]
    fn cover_mime_is_sniffed_from_magic_bytes_not_the_url() {
        assert!(matches!(cover_mime(b"\x89PNG\r\n\x1a\n"), MimeType::Png));
        assert!(matches!(cover_mime(b"\xff\xd8\xff\xe0"), MimeType::Jpeg));
    }
}
