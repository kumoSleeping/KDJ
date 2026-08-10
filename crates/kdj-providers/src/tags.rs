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
///
/// 和 v0.1.0 的 `tagging.py::AUDIO_EXTENSIONS` **逐项相同**，一个都别多：
/// 早先这里多了 `wma`/`alac`，后果是这些文件被扫进曲库、symphonia 又解不了，
/// 永远挂着"分析失败"。`mp4` 也不在这里——它在 [`VIDEO_EXTENSIONS`]，
/// 入库判定走 `is_media_extension`（音频 ∪ 视频），不受影响。
pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "aiff", "aif",
];

/// 视频容器也进曲库：现场素材、MV 常常只有视频版。
/// 分析和播放都只取它的音轨（播放期由 `/api/library/audio` 先抽轨缓存），
/// 文件本身永远保留完整画面。
pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "webm", "mkv"];

pub fn is_audio_extension(ext: &str) -> bool {
    let lower = ext.trim_start_matches('.').to_ascii_lowercase();
    AUDIO_EXTENSIONS.contains(&lower.as_str())
}

/// 曲库扫描认的后缀 = 音频 ∪ 视频。
///
/// 扫描和文件夹树的"磁盘上有几个"必须用同一份，否则树上显示 3 个待入库、
/// 扫完还是 3 个，用户会一直点「扫描」。
pub fn is_media_extension(ext: &str) -> bool {
    let lower = ext.trim_start_matches('.').to_ascii_lowercase();
    AUDIO_EXTENSIONS.contains(&lower.as_str()) || VIDEO_EXTENSIONS.contains(&lower.as_str())
}

/// 按魔数认封面格式。认不出来返回 None——**不要**默认成 JPEG：
/// 用户挑一张 webp/gif 进来时，标成 image/jpeg 写下去，各家播放器只会显示破图，
/// 而且是"写成功了但看不见"这种最难查的失败。
fn sniff_cover(data: &[u8]) -> Option<MimeType> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(MimeType::Png)
    } else if data.starts_with(b"\xff\xd8\xff") {
        Some(MimeType::Jpeg)
    } else {
        None
    }
}

/// 下载管线内部用：封面是各平台 CDN 给的，除了 PNG 就是 JPEG，
/// 认不出来时退回 JPEG 比丢掉封面强。用户手动换封面走 `write_cover`，那条路要严。
fn cover_mime(data: &[u8]) -> MimeType {
    sniff_cover(data).unwrap_or(MimeType::Jpeg)
}

/// 把封面塞进 tag，替换掉原有的所有图片。
fn replace_pictures(tag: &mut lofty::tag::Tag, data: &[u8], mime: MimeType) {
    let picture = Picture::unchecked(data.to_vec())
        .pic_type(PictureType::CoverFront)
        .mime_type(mime)
        .description("Cover")
        .build();
    // 先清掉旧封面，否则某些容器会累积成一堆图片
    while tag.pictures().first().is_some() {
        tag.remove_picture(0);
    }
    tag.push_picture(picture);
}

/// 打开文件并拿到可写的主 tag。没有 tag 的文件先补一个空的。
fn open_for_write(path: &Path) -> Result<lofty::file::TaggedFile> {
    let mut tagged = Probe::open(path)
        .with_context(|| format!("打开音频文件失败：{}", path.display()))?
        .read()
        .with_context(|| format!("解析音频文件失败：{}", path.display()))?;
    let tag_type = tagged.primary_tag_type();
    if tagged.primary_tag_mut().is_none() {
        tagged.insert_tag(lofty::tag::Tag::new(tag_type));
    }
    Ok(tagged)
}

/// 只在规范化后的文本真的变化时改 tag。lofty 的 save 可能重写整个标签区；
/// 对 U 盘上的大文件来说，“把同一个值再写一遍”也不是免费的。
fn set_text_if_changed(tag: &mut lofty::tag::Tag, key: ItemKey, value: &str) -> bool {
    let value = value.trim();
    let current = tag.get_string(key.clone()).unwrap_or_default().trim();
    if current == value {
        return false;
    }
    if value.is_empty() {
        tag.remove_key(key);
    } else {
        tag.insert_text(key, value.to_string());
    }
    true
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
    let mut tagged = open_for_write(path)?;
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
            replace_pictures(tag, data, cover_mime(data));
        }
    }

    tag.save_to_path(path, WriteOptions::default())
        .with_context(|| format!("写标签失败：{}", path.display()))?;
    Ok(())
}

/// 用户手改的文本元数据。
///
/// 每个字段都是 `Option`，语义是**这次有没有动过**——`None` 一律不碰文件里原有的值。
/// 不能拿库里那份整体覆盖：库里读失败退化成空串的字段（怪文件很常见）
/// 会把文件里好好的标签清掉。`Some("")` 才是"用户明确清空"。
#[derive(Debug, Clone, Default)]
pub struct MetadataEdit<'a> {
    pub title: Option<&'a str>,
    pub artist: Option<&'a str>,
    pub album: Option<&'a str>,
    pub genre: Option<&'a str>,
    pub year: Option<&'a str>,
}

impl MetadataEdit<'_> {
    /// 一个字段都没动 → 调用方可以整个跳过，别白白重写一遍文件（那会改 mtime）。
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.artist.is_none()
            && self.album.is_none()
            && self.genre.is_none()
            && self.year.is_none()
    }
}

/// 把用户改过的文本元数据写回文件标签。
///
/// DJ 会把这些文件直接拖进 Rekordbox / Serato，那边只认文件里的标签——
/// 只改数据库的话，改动一出这个 App 就没了。
pub fn write_metadata(path: &Path, edit: &MetadataEdit<'_>) -> Result<()> {
    if edit.is_empty() {
        return Ok(());
    }
    let mut tagged = open_for_write(path)?;
    let tag = tagged.primary_tag_mut().expect("刚插入过一定存在");

    let mut changed = false;
    for (key, value) in [
        (ItemKey::TrackTitle, edit.title),
        (ItemKey::TrackArtist, edit.artist),
        (ItemKey::AlbumTitle, edit.album),
        (ItemKey::Genre, edit.genre),
    ] {
        let Some(value) = value else { continue };
        changed |= set_text_if_changed(tag, key, value);
    }
    // Vorbis/APE 里 YEAR 和 DATE 是两个键，留着旧的 YEAR 会让读回来的是老值
    if let Some(year) = edit.year {
        let year = year.trim();
        let recording_date = tag
            .get_string(ItemKey::RecordingDate)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let legacy_year = tag
            .get_string(ItemKey::Year)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        // 有些容器只支持 YEAR，另一些支持 RecordingDate；任一规范位置已经是目标值
        // 且没有冲突副本时，都算真正的 no-op。
        let already_equal = (recording_date == Some(year) && legacy_year.is_none())
            || (recording_date.is_none() && legacy_year == Some(year))
            || (year.is_empty() && recording_date.is_none() && legacy_year.is_none());
        if already_equal {
            if !changed {
                return Ok(());
            }
        } else {
            // 年份统一写 RecordingDate：ID3v2 的映射表里根本没有 Year 这个键，
            // 写 ItemKey::Year 在 mp3 上会被静默丢弃。`read_tags` 两个键都读，对得上。
            changed |= set_text_if_changed(tag, ItemKey::RecordingDate, year);
            let had_legacy_year = tag.get_string(ItemKey::Year).is_some();
            tag.remove_key(ItemKey::Year);
            changed |= had_legacy_year;
            if let Some(year) = Some(year).filter(|value| !value.is_empty()) {
                // RecordingDate 在这个容器里没有对应键时（少数格式）退回 Year，别让年份整个丢掉
                if tag.get_string(ItemKey::RecordingDate).is_none() {
                    tag.insert_text(ItemKey::Year, year.to_string());
                    changed = true;
                }
            }
        }
    }

    if !changed {
        return Ok(());
    }

    tag.save_to_path(path, WriteOptions::default())
        .with_context(|| format!("写标签失败：{}", path.display()))?;
    Ok(())
}

/// 换封面：把 `data` 写成文件里唯一的正封面。
///
/// 只收 JPEG / PNG。转码需要一整个图像库，而这两种覆盖了所有实际场景
/// （截图是 PNG，网上扒的图是 JPEG），认不出来时明确报错比写一张打不开的图好。
pub fn write_cover(path: &Path, data: &[u8]) -> Result<()> {
    anyhow::ensure!(!data.is_empty(), "封面数据是空的");
    let mime = sniff_cover(data).context("封面只支持 JPEG / PNG")?;

    let mut tagged = open_for_write(path)?;
    let tag = tagged.primary_tag_mut().expect("刚插入过一定存在");
    if tag.pictures().len() == 1
        && tag.pictures()[0].pic_type() == PictureType::CoverFront
        && tag.pictures()[0].data() == data
        && tag.pictures()[0].mime_type() == Some(&mime)
    {
        return Ok(());
    }
    replace_pictures(tag, data, mime);
    tag.save_to_path(path, WriteOptions::default())
        .with_context(|| format!("写封面失败：{}", path.display()))?;
    Ok(())
}

/// 读时长（秒）。用于"试听片段"检测和曲库扫描。
///
/// **必须按内容嗅探格式，不能只信扩展名。** `Probe::open` 是从路径猜 `FileType` 的，
/// 而"试听片段"检测跑在 commit 之前，那时文件还叫 `xxx.flac.partial`——
/// 扩展名是 `partial`，猜不出格式，`read()` 直接报 UnknownFormat，
/// 于是时长永远读不到、检测退化成只看文件大小，30 秒的 VIP 试听片段就混进曲库了。
pub fn read_duration_secs(path: &Path) -> Option<f64> {
    let probe = Probe::open(path).ok()?;
    // guess_file_type 失败时会保留从路径猜出来的类型，所以这一步只会更准
    let probe = probe.guess_file_type().ok()?;
    let tagged = probe.read().ok()?;
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

/// "A minor" / "Am" / "Db major" → ID3 TKEY 形状（"Am" / "Db"）。
///
/// TKEY 规定最多 3 个字符：根音 A-G + 可选 `#`/`b` + 小调加 `m`。
/// 逐行对照 v0.1.0 的 `tagging.py::to_id3_key`——这是写进用户文件的东西，
/// 换了软件还得能读回来，形状不能私自发明。
pub fn to_id3_key(music_key: &str) -> String {
    let value = music_key.trim().replace('♯', "#").replace('♭', "b");
    if value.is_empty() {
        return String::new();
    }
    let normalized = value.replace('-', " ");
    let mut parts = normalized.split_whitespace();
    let mut root = parts.next().unwrap_or_default().to_string();
    let rest = parts.collect::<Vec<_>>().join(" ").to_lowercase();

    let minor = if !rest.is_empty() {
        rest.starts_with("min") || rest.starts_with("mol") || rest == "m"
    } else {
        // 无后缀写法："Am" / "F#m" / "C"
        let is_minor = root.len() > 1 && root.ends_with('m');
        if is_minor {
            root.pop();
        }
        is_minor
    };
    if root.is_empty() {
        return String::new();
    }

    let tail = &root[1..];
    let accidental = if tail.contains('#') {
        "#"
    } else if tail.to_lowercase().contains('b') {
        "b"
    } else {
        ""
    };
    let head = root
        .chars()
        .next()
        .map(|c| c.to_ascii_uppercase())
        .unwrap_or_default();
    format!("{head}{accidental}{}", if minor { "m" } else { "" })
}

/// Comment 的组法：`"8A - Energy 7 - 用户备注"`。
///
/// Mixed In Key 就是把 Camelot 写进 comment 的，DJ 软件间传文件时
/// 这是最通用的一条通道；用户自己的备注跟在最后，不能被吃掉。
/// 分隔符 `" - "` 与 v0.1.0 的 `_comment_text` 一致。
fn analysis_comment(camelot: &str, energy: Option<i64>, comment: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !camelot.is_empty() {
        parts.push(camelot.to_string());
    }
    if let Some(energy) = energy.filter(|value| *value > 0) {
        parts.push(format!("Energy {energy}"));
    }
    if !comment.is_empty() {
        parts.push(comment.to_string());
    }
    parts.join(" - ")
}

/// 把分析结果写进文件标签（BPM / KEY / 能量 / 备注）。
///
/// 和 v0.1.0 的 `tagging.py::write_analysis_tags` 对齐的两条硬规则：
/// 1. **调性字段写传统调名**（"Am"），不写 Camelot——Rekordbox 的 Key 列
///    不认识 "8A"，写进去用户看到的是一列乱码般的编号；
/// 2. Camelot 和能量走 comment（`"8A - Energy 7 - 用户备注"`），
///    用户自己的备注必须原样保留在最后。
///
/// Python 版还会写 TXXX:CAMELOT / TXXX:EnergyLevel 两个自定义字段；
/// lofty 的统一 `ItemKey` 是封闭枚举、写不了自定义描述的 TXXX，
/// 绕开统一 API 按格式各写一套的风险大于收益（同 `embed_metadata`
/// 对多艺人的取舍）。读这两个字段的基本只有 Mixed In Key 自己，
/// 它要的信息 comment 里都有。
pub fn write_analysis_tags(
    path: &Path,
    bpm: Option<f64>,
    camelot: &str,
    music_key: &str,
    energy: Option<i64>,
    comment: &str,
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

    let camelot = camelot.trim().to_uppercase();
    let key_text = to_id3_key(music_key);

    let mut changed = false;
    if let Some(bpm) = bpm.filter(|value| *value > 0.0) {
        // BPM 写整数：ID3 的 TBPM 规范上就是整数，写小数有些软件会读成 0
        changed |= set_text_if_changed(tag, ItemKey::Bpm, &format!("{}", bpm.round() as i64));
    }
    if !key_text.is_empty() {
        changed |= set_text_if_changed(tag, ItemKey::InitialKey, &key_text);
    }
    let note = analysis_comment(&camelot, energy, comment);
    if !note.is_empty() {
        changed |= set_text_if_changed(tag, ItemKey::Comment, &note);
    }
    if !changed {
        return Ok(());
    }

    tag.save_to_path(path, WriteOptions::default())
        .with_context(|| format!("写标签失败：{}", path.display()))?;
    Ok(())
}

/// 读内嵌封面，返回 `(字节, mime)`。
///
/// 曲库列表里每一行都要一张图，所以这里只取第一张、不做缩放——
/// 缩放交给浏览器，省一个图像处理依赖。
pub fn read_cover(path: &Path) -> Option<(Vec<u8>, String)> {
    let tagged = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    // 优先正封面，没有就拿第一张（有些文件只存了 Other 类型）
    let picture = tag
        .pictures()
        .iter()
        .find(|pic| pic.pic_type() == PictureType::CoverFront)
        .or_else(|| tag.pictures().first())?;
    let mime = picture
        .mime_type()
        .map(|mime| mime.to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    Some((picture.data().to_vec(), mime))
}

#[cfg(test)]
pub(crate) mod tests {
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
    fn media_extensions_cover_video_containers_too() {
        // 曲库扫描按 MEDIA（音频 ∪ 视频）判定，和 v0.1.0 的 tagging.py 一致
        for ext in ["mkv", "mov", "webm", "m4v", "mp4"] {
            assert!(is_media_extension(ext), "{ext} 应当算曲库媒体");
        }
        assert!(is_media_extension("FLAC"));
        assert!(!is_media_extension("txt"));
        assert!(!is_media_extension("jpg"));
    }

    /// 造一个 8000Hz / 8bit / 单声道的静音 WAV，用来测时长读取。
    pub(crate) fn silent_wav(seconds: u32) -> Vec<u8> {
        const RATE: u32 = 8000;
        let data_len = RATE * seconds;
        let mut out = Vec::with_capacity(44 + data_len as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk 大小
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&1u16.to_le_bytes()); // 单声道
        out.extend_from_slice(&RATE.to_le_bytes());
        out.extend_from_slice(&RATE.to_le_bytes()); // byte rate
        out.extend_from_slice(&1u16.to_le_bytes()); // block align
        out.extend_from_slice(&8u16.to_le_bytes()); // bits per sample
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        out.resize(44 + data_len as usize, 128);
        out
    }

    #[test]
    fn duration_is_readable_even_when_the_extension_is_partial() {
        // 试听片段检测跑在 commit 之前，那时文件还叫 `xxx.flac.partial`。
        // 只按扩展名猜格式的话这里会返回 None，检测就形同虚设。
        let dir = std::env::temp_dir().join(format!("kdj-dur-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("song.flac.partial");
        std::fs::write(&path, silent_wav(30)).unwrap();

        let secs = read_duration_secs(&path).expect("扩展名不认识也要能读出时长");
        assert!((secs - 30.0).abs() < 1.0, "读到 {secs} 秒");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cover_mime_is_sniffed_from_magic_bytes_not_the_url() {
        assert!(matches!(cover_mime(b"\x89PNG\r\n\x1a\n"), MimeType::Png));
        assert!(matches!(cover_mime(b"\xff\xd8\xff\xe0"), MimeType::Jpeg));
        assert!(
            sniff_cover(b"RIFF....WEBPVP8 ").is_none(),
            "webp 认不出来就该说认不出来"
        );
    }

    /// 造一张最小的合法 PNG（1x1），只用来验证"写进去能读回来"。
    fn tiny_png() -> Vec<u8> {
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        out.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
        out.extend_from_slice(&[
            0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
        ]);
        out.extend_from_slice(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82]);
        out
    }

    /// 每个测试自己一个目录：写标签会改文件，共用一份会互相踩。
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kdj-tags-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("song.wav");
        std::fs::write(&path, silent_wav(2)).unwrap();
        path
    }

    #[test]
    fn id3_key_conversion_matches_the_python_reference() {
        // 用例逐条取自 tagging.py::to_id3_key 的语义，别删也别"顺手美化"
        for (input, want) in [
            ("A minor", "Am"),
            ("A Minor", "Am"),
            ("Db major", "Db"),
            ("F# minor", "F#m"),
            ("Am", "Am"),
            ("F#m", "F#m"),
            ("C", "C"),
            ("c moll", "Cm"),
            ("E♭ major", "Eb"),
            // 参照实现的怪癖，照抄不修：`-` 换成空格后 root="B"、rest="flat minor"，
            // rest 不以 "min" 开头 → 判成大调，flat 也丢了。我们的分析引擎
            // 只产出 "A minor"/"Db major" 这种形状，这条输入实际到不了这里。
            ("B-flat minor", "B"),
            ("", ""),
            ("   ", ""),
        ] {
            assert_eq!(to_id3_key(input), want, "输入 {input:?}");
        }
    }

    #[test]
    fn analysis_comment_keeps_the_users_note_at_the_end() {
        assert_eq!(
            analysis_comment("8A", Some(7), "开场用"),
            "8A - Energy 7 - 开场用"
        );
        assert_eq!(analysis_comment("8A", None, ""), "8A");
        assert_eq!(analysis_comment("", Some(3), ""), "Energy 3");
        assert_eq!(analysis_comment("", None, ""), "");
        // energy=0 是"没有值"不是"能量为零"，Python 的 if energy 同款语义
        assert_eq!(analysis_comment("8A", Some(0), ""), "8A");
    }

    #[test]
    fn analysis_tags_write_the_traditional_key_not_camelot() {
        let path = scratch("analysis-key");
        write_analysis_tags(&path, Some(128.0), "8a", "A minor", Some(7), "收尾曲").unwrap();
        let back = read_tags(&path);
        // Rekordbox 的 Key 列读的就是这个字段，写 "8A" 它不认识
        let tagged = Probe::open(&path).unwrap().read().unwrap();
        let tag = tagged.primary_tag().unwrap();
        assert_eq!(tag.get_string(ItemKey::InitialKey), Some("Am"));
        assert_eq!(
            tag.get_string(ItemKey::Comment),
            Some("8A - Energy 7 - 收尾曲"),
            "Camelot 走 comment，用户备注在最后"
        );
        let secs = back.duration.expect("写完标签必须还读得出时长");
        assert_eq!(secs.round() as i64, 2, "写标签不能把音频本体写坏");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn video_extension_list_matches_the_frontend_copy() {
        // 这份表在 src/lib/format.ts 里还有一份手抄的。谁漂移了，表现是
        // "有的视频有角标有的没有"，从症状根本联想不到这里——所以用测试锁死。
        let ts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/lib/format.ts");
        let source = std::fs::read_to_string(&ts)
            .expect("src/lib/format.ts 应当存在（前端的视频后缀表在里面）");
        let mut in_front: Vec<String> = Vec::new();
        // 形状：const VIDEO_EXTENSIONS = new Set(["mp4", ...]);
        if let Some(start) = source.find("VIDEO_EXTENSIONS") {
            let tail = &source[start..];
            let open = tail
                .find('[')
                .expect("VIDEO_EXTENSIONS 后面应当是数组字面量");
            let close = tail[open..].find(']').unwrap() + open;
            for piece in tail[open + 1..close].split(',') {
                let name = piece.trim().trim_matches(|c| c == '"' || c == '\'');
                if !name.is_empty() {
                    in_front.push(name.to_string());
                }
            }
        }
        let mut ours: Vec<String> = VIDEO_EXTENSIONS.iter().map(|s| s.to_string()).collect();
        in_front.sort();
        ours.sort();
        assert_eq!(in_front, ours, "前后端的视频后缀表漂移了，两边要一起改");
    }

    #[test]
    fn write_metadata_only_touches_the_fields_the_user_changed() {
        let path = scratch("partial");
        write_metadata(
            &path,
            &MetadataEdit {
                title: Some("原标题"),
                artist: Some("原艺人"),
                album: Some("原专辑"),
                genre: Some("Techno"),
                year: Some("2021"),
            },
        )
        .unwrap();

        // 只改标题：其余字段没传 = 没动过，文件里那份必须原样留着
        write_metadata(
            &path,
            &MetadataEdit {
                title: Some("新标题"),
                ..Default::default()
            },
        )
        .unwrap();
        let tags = read_tags(&path);
        assert_eq!(tags.title, "新标题");
        assert_eq!(tags.artist, "原艺人");
        assert_eq!(tags.album, "原专辑");
        assert_eq!(tags.genre, "Techno");
        assert_eq!(
            tags.year, "2021",
            "年份要能被 read_tags 读回来，否则等于没写"
        );

        // Some("") 是"用户明确清空"，和 None 不是一回事
        write_metadata(
            &path,
            &MetadataEdit {
                album: Some("  "),
                ..Default::default()
            },
        )
        .unwrap();
        let tags = read_tags(&path);
        assert_eq!(tags.album, "");
        assert_eq!(tags.artist, "原艺人", "清空一个字段不该顺手清掉别的");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn empty_edit_is_a_no_op_so_the_file_is_not_rewritten() {
        // 空编辑照样重写文件的话 mtime 会变，扫描的增量跳过就白做了
        let path = scratch("noop");
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        write_metadata(&path, &MetadataEdit::default()).unwrap();
        let after = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(before, after);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn identical_metadata_analysis_and_cover_are_not_rewritten() {
        let path = scratch("same-values");
        let edit = MetadataEdit {
            title: Some("同一标题"),
            artist: Some("同一艺人"),
            album: Some("同一专辑"),
            genre: Some("House"),
            year: Some("2024"),
        };
        write_metadata(&path, &edit).unwrap();
        write_analysis_tags(&path, None, "8A", "A minor", Some(6), "备注").unwrap();
        let png = tiny_png();
        write_cover(&path, &png).unwrap();
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));

        write_metadata(&path, &edit).unwrap();
        let after_metadata = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(before, after_metadata, "相同文本标签不应再次写文件");
        write_analysis_tags(&path, None, "8A", "A minor", Some(6), "备注").unwrap();
        let after_analysis = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(before, after_analysis, "相同分析标签不应再次写文件");
        write_cover(&path, &png).unwrap();

        let after = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(before, after, "相同封面不应再次写文件");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn write_cover_replaces_the_old_one_and_rejects_unknown_formats() {
        let path = scratch("cover");
        write_cover(&path, &tiny_png()).unwrap();
        let (data, mime) = read_cover(&path).expect("写进去就该读得回来");
        assert_eq!(mime, "image/png");
        assert_eq!(data, tiny_png());

        // 换第二张：文件里只该剩一张，不然容器会越堆越大
        let jpeg = b"\xff\xd8\xff\xe0 fake jpeg".to_vec();
        write_cover(&path, &jpeg).unwrap();
        let tagged = Probe::open(&path).unwrap().read().unwrap();
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag()).unwrap();
        assert_eq!(tag.pictures().len(), 1);
        assert_eq!(read_cover(&path).unwrap().0, jpeg);

        assert!(
            write_cover(&path, b"GIF89a....").is_err(),
            "认不出来的格式要挡掉"
        );
        assert!(write_cover(&path, b"").is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
