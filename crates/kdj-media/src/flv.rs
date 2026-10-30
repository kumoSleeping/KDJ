//! FLV, as 哔哩哔哩 serves a video it has only as one stream (`durl`), into MP4 by stream
//! copy: H.264 video with AAC or MP3 audio. The samples are not copied out first: the MP4's
//! sample table points into the FLV's own tags, and the writer copies them once.
//!
//! The two tracks start together: the one that starts earlier in the FLV is trimmed to the
//! other's start by its edit list (a few milliseconds at most), which keeps their sync through
//! every later step (`remux` keeps an edit's media time).

use crate::audio::LANGUAGE_UND;
use crate::mp4::boxes::{full_box, mp4_box, BoxBuf};
use crate::mp4::write::{self, Brand, Edit, OutSample, OutTrack};
use anyhow::{bail, ensure, Context, Result};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// The audio of an FLV.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioCodec {
    Aac,
    Mp3,
}

#[derive(Clone, Copy, Debug)]
struct VideoFrame {
    offset: u64,
    size: u32,
    dts: i64,
    cts: i32,
    sync: bool,
}

#[derive(Clone, Copy, Debug)]
struct AudioFrame {
    offset: u64,
    size: u32,
    /// The tag's time (ms) for the first frame of a tag; later frames of the tag follow it.
    time: i64,
    samples: u32,
}

struct Video {
    record: Vec<u8>,
    frames: Vec<VideoFrame>,
}

struct Audio {
    codec: AudioCodec,
    rate: u32,
    channels: u32,
    /// AudioSpecificConfig (AAC only).
    asc: Vec<u8>,
    /// MPEG-1 audio (MP3 only), else MPEG-2 / 2.5.
    mpeg1: bool,
    frames: Vec<AudioFrame>,
}

/// An FLV's tracks, read from its tag headers and parameter sets.
pub struct Flv {
    video: Option<Video>,
    audio: Option<Audio>,
}

/// Whether a file starts like an FLV.
pub fn looks_like_flv(path: &Path) -> bool {
    let mut head = [0u8; 3];
    File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == b"FLV"
}

fn be(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0, |acc, &b| (acc << 8) | b as u32)
}

impl Flv {
    pub fn open(path: &Path) -> Result<Self> {
        let file = File::open(path).with_context(|| format!("打开 FLV 失败：{}", path.display()))?;
        let length = file.metadata()?.len();
        let mut reader = BufReader::new(file);
        let mut header = [0u8; 9];
        reader.read_exact(&mut header).context("FLV 文件头不完整")?;
        ensure!(&header[..3] == b"FLV", "不是 FLV 文件");
        let mut pos = be(&header[5..9]) as u64 + 4;
        let mut video: Option<Video> = None;
        let mut record = None;
        let mut video_frames = Vec::new();
        let mut audio: Option<Audio> = None;
        let mut asc = None;
        let mut audio_frames = Vec::new();
        let mut mp3: Option<(u32, u32, bool)> = None;
        while pos + 11 <= length {
            reader.seek(SeekFrom::Start(pos))?;
            let mut tag = [0u8; 11];
            if reader.read_exact(&mut tag).is_err() {
                break;
            }
            let kind = tag[0] & 0x1f;
            ensure!(tag[0] & 0x20 == 0, "FLV 里有加密的数据，不能转封装");
            let size = be(&tag[1..4]) as u64;
            let time = (be(&tag[4..7]) | (tag[7] as u32) << 24) as i32 as i64;
            let data = pos + 11;
            // A file cut short (an interrupted download) keeps the tags that are whole.
            if data + size > length {
                break;
            }
            match kind {
                9 if size >= 1 => {
                    let mut head = [0u8; 5];
                    reader.read_exact(&mut head[..size.min(5) as usize])?;
                    ensure!(head[0] & 0x80 == 0, "这个视频是 HEVC 或 AV1（增强 FLV），不能转封装成 MP4");
                    let frame_type = (head[0] >> 4) & 0x07;
                    let codec = head[0] & 0x0f;
                    if frame_type == 5 {
                        // Video info / command frame: no picture.
                    } else if codec == 12 {
                        bail!("这个视频是 HEVC（FLV 扩展），不能转封装成 MP4");
                    } else if codec != 7 {
                        bail!("FLV 里的视频编码不是 H.264（编号 {codec}），不能转封装成 MP4");
                    } else if size > 5 {
                        let cts = (be(&head[2..5]) << 8) as i32 >> 8;
                        match head[1] {
                            0 if record.is_none() => {
                                let mut bytes = vec![0u8; (size - 5) as usize];
                                reader.read_exact(&mut bytes)?;
                                record = Some(bytes);
                            }
                            1 => video_frames.push(VideoFrame { offset: data + 5, size: (size - 5) as u32, dts: time, cts, sync: frame_type == 1 }),
                            _ => {}
                        }
                    }
                }
                8 if size >= 2 => {
                    let mut payload = vec![0u8; size as usize];
                    reader.read_exact(&mut payload)?;
                    match payload[0] >> 4 {
                        10 => match payload[1] {
                            0 if asc.is_none() => asc = Some(payload[2..].to_vec()),
                            1 if size > 2 => audio_frames.push(AudioFrame { offset: data + 2, size: (size - 2) as u32, time, samples: 1024 }),
                            _ => {}
                        },
                        2 | 14 => {
                            let mut at = 1usize;
                            let mut first = true;
                            while at + 4 <= payload.len() {
                                let Some(header) = mp3_header(&payload[at..at + 4]) else { break };
                                let len = header.length.min(payload.len() - at);
                                mp3.get_or_insert((header.rate, header.channels, header.mpeg1));
                                audio_frames.push(AudioFrame { offset: data + at as u64, size: len as u32, time: if first { time } else { -1 }, samples: header.samples });
                                first = false;
                                at += len;
                            }
                        }
                        other => bail!("FLV 里的音频编码不是 AAC 或 MP3（编号 {other}），不能转封装"),
                    }
                }
                _ => {}
            }
            pos = data + size + 4;
        }
        if !video_frames.is_empty() {
            let record = record.context("FLV 缺少 H.264 参数集（AVC sequence header）")?;
            video = Some(Video { record, frames: video_frames });
        }
        if !audio_frames.is_empty() {
            audio = Some(if let Some(asc) = asc {
                let (rate, channels) = asc_info(&asc)?;
                Audio { codec: AudioCodec::Aac, rate, channels, asc, mpeg1: false, frames: audio_frames }
            } else if let Some((rate, channels, mpeg1)) = mp3 {
                Audio { codec: AudioCodec::Mp3, rate, channels, asc: Vec::new(), mpeg1, frames: audio_frames }
            } else {
                bail!("FLV 缺少 AAC 配置（AAC sequence header）");
            });
        }
        ensure!(video.is_some() || audio.is_some(), "FLV 里没有音频或视频");
        Ok(Flv { video, audio })
    }

    pub fn has_video(&self) -> bool {
        self.video.is_some()
    }

    pub fn audio_codec(&self) -> Option<AudioCodec> {
        self.audio.as_ref().map(|a| a.codec)
    }

    /// Where both tracks start together, in ms of the FLV's clock.
    fn start(&self, video: bool, audio: bool) -> i64 {
        let v = self.video.as_ref().filter(|_| video).and_then(|v| v.frames.first()).map(|f| f.dts);
        let a = self.audio.as_ref().filter(|_| audio).and_then(|a| a.frames.first()).map(|f| f.time);
        v.into_iter().chain(a).max().unwrap_or(0)
    }

    fn video_track(&self, start: i64) -> Result<OutTrack> {
        let video = self.video.as_ref().context("FLV 里没有画面")?;
        let (entry, width, height) = crate::h264::record_sample_entry(&video.record)?;
        let frames = &video.frames;
        let mut samples = Vec::with_capacity(frames.len());
        let mut last = 33u32;
        for (n, frame) in frames.iter().enumerate() {
            let duration = match frames.get(n + 1) {
                // Timestamps that stand still or step back still move the track on.
                Some(next) => (next.dts - frame.dts).max(1) as u32,
                None => last,
            };
            last = duration;
            samples.push(OutSample { source: 0, offset: frame.offset, size: frame.size, duration, cts: frame.cts, sync: frame.sync });
        }
        Ok(OutTrack {
            handler: *b"vide",
            timescale: 1000,
            language: LANGUAGE_UND,
            width,
            height,
            entries: vec![entry],
            samples,
            edit: Edit { lead: 0, media_time: (start - frames[0].dts).max(0), duration: None },
        })
    }

    fn audio_track(&self, start: i64) -> Result<OutTrack> {
        let audio = self.audio.as_ref().context("FLV 里没有音轨")?;
        let entry = match audio.codec {
            AudioCodec::Aac => crate::aac::sample_entry(audio.rate, audio.channels, &audio.asc, 0),
            AudioCodec::Mp3 => mp3_sample_entry(audio.rate, audio.channels, audio.mpeg1),
        };
        let samples = audio.frames.iter().map(|f| OutSample { source: 0, offset: f.offset, size: f.size, duration: f.samples, cts: 0, sync: true }).collect();
        let first = audio.frames[0].time;
        Ok(OutTrack {
            handler: *b"soun",
            timescale: audio.rate,
            language: LANGUAGE_UND,
            width: 0,
            height: 0,
            entries: vec![entry],
            samples,
            edit: Edit { lead: 0, media_time: (start - first).max(0) * audio.rate as i64 / 1000, duration: None },
        })
    }
}

/// The FLV at `path` as an MP4 (with video) or M4A (audio alone) at `output`, with the tracks
/// asked for. Both start where the later of them starts.
pub fn to_mp4(path: &Path, output: &Path, video: bool, audio: bool, cancelled: &dyn Fn() -> bool) -> Result<()> {
    let flv = Flv::open(path)?;
    let video = video && flv.has_video();
    let audio = audio && flv.audio.is_some();
    ensure!(video || audio, "FLV 里没有要的轨道");
    let start = flv.start(video, audio);
    let mut tracks = Vec::new();
    if video {
        tracks.push(flv.video_track(start)?);
    }
    if audio {
        tracks.push(flv.audio_track(start)?);
    }
    let result = write::write(output, &[path], &tracks, if video { Brand::Mp4 } else { Brand::M4a }, cancelled);
    if result.is_err() {
        let _ = std::fs::remove_file(output);
    }
    result
}

/// The MP3 frames of the FLV at `path`, end to end, as an `.mp3` file: nothing re-encoded.
pub fn to_mp3(path: &Path, output: &Path, cancelled: &dyn Fn() -> bool) -> Result<()> {
    let flv = Flv::open(path)?;
    let audio = flv.audio.as_ref().filter(|a| a.codec == AudioCodec::Mp3).context("FLV 的音轨不是 MP3")?;
    let mut source = BufReader::new(File::open(path)?);
    let mut out = std::io::BufWriter::new(File::create(output).with_context(|| format!("创建文件失败：{}", output.display()))?);
    let result = (|| -> Result<()> {
        let mut buffer = Vec::new();
        for frame in &audio.frames {
            ensure!(!cancelled(), "已取消");
            buffer.resize(frame.size as usize, 0);
            source.seek(SeekFrom::Start(frame.offset))?;
            source.read_exact(&mut buffer)?;
            out.write_all(&buffer)?;
        }
        out.flush()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(output);
    }
    result
}

/// Rate and channels of an AudioSpecificConfig.
fn asc_info(asc: &[u8]) -> Result<(u32, u32)> {
    let mut r = crate::bits::BitReader::new(asc);
    if r.bits(5)? == 31 {
        r.bits(6)?;
    }
    let index = r.bits(4)?;
    let rate = if index == 15 {
        r.bits(24)?
    } else {
        *crate::mp4::read::AAC_RATES.get(index as usize).context("AAC 采样率无效")?
    };
    let channels = r.bits(4)?;
    Ok((rate, if channels == 0 { 2 } else { channels.min(8) }))
}

struct Mp3Header {
    rate: u32,
    channels: u32,
    mpeg1: bool,
    samples: u32,
    length: usize,
}

/// An MPEG audio frame header (layer I, II or III).
fn mp3_header(h: &[u8]) -> Option<Mp3Header> {
    if h[0] != 0xff || h[1] & 0xe0 != 0xe0 {
        return None;
    }
    let version = (h[1] >> 3) & 3; // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5
    let layer = (h[1] >> 1) & 3; // 3 I, 2 II, 1 III
    if version == 1 || layer == 0 {
        return None;
    }
    let mpeg1 = version == 3;
    let bitrate_index = (h[2] >> 4) as usize;
    let rate_index = ((h[2] >> 2) & 3) as usize;
    if bitrate_index == 0 || bitrate_index == 15 || rate_index == 3 {
        return None;
    }
    const RATES: [[u32; 3]; 3] = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];
    let rate = RATES[match version { 3 => 0, 2 => 1, _ => 2 }][rate_index];
    const V1_L1: [u32; 15] = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
    const V1_L2: [u32; 15] = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
    const V1_L3: [u32; 15] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const V2_L1: [u32; 15] = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
    const V2_L23: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    let kbps = match (mpeg1, layer) {
        (true, 3) => V1_L1,
        (true, 2) => V1_L2,
        (true, _) => V1_L3,
        (false, 3) => V2_L1,
        (false, _) => V2_L23,
    }[bitrate_index];
    let bitrate = kbps * 1000;
    let padding = ((h[2] >> 1) & 1) as u32;
    let (samples, length) = match layer {
        3 => (384, (12 * bitrate / rate + padding) * 4),
        2 => (1152, 144 * bitrate / rate + padding),
        _ if mpeg1 => (1152, 144 * bitrate / rate + padding),
        _ => (576, 72 * bitrate / rate + padding),
    };
    Some(Mp3Header { rate, channels: if h[3] >> 6 == 3 { 1 } else { 2 }, mpeg1, samples, length: length as usize })
}

/// The `mp4a` sample entry for MPEG audio: an `esds` naming MPEG-1 (0x6B) or MPEG-2 (0x69)
/// audio, which carries no decoder configuration of its own.
fn mp3_sample_entry(rate: u32, channels: u32, mpeg1: bool) -> Vec<u8> {
    fn descriptor(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![tag, body.len() as u8];
        out.extend_from_slice(body);
        out
    }
    let mut config = BoxBuf::default();
    config.u8(if mpeg1 { 0x6b } else { 0x69 });
    config.u8(0x15);
    config.bytes(&[0, 0, 0]);
    config.u32(0);
    config.u32(0);
    let mut es = BoxBuf::default();
    es.u16(1);
    es.u8(0);
    es.bytes(&descriptor(4, &config.0));
    es.bytes(&descriptor(6, &[2]));
    let esds = full_box(b"esds", 0, 0, &descriptor(3, &es.0));
    let mut entry = BoxBuf::default();
    entry.bytes(&[0; 6]);
    entry.u16(1);
    entry.bytes(&[0; 8]);
    entry.u16(channels as u16);
    entry.u16(16);
    entry.u32(0);
    entry.u32(if rate < 65536 { rate << 16 } else { 0 });
    entry.bytes(&esds);
    mp4_box(b"mp4a", &entry.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_specific_config_gives_rate_and_channels() {
        // AAC-LC, 44.1 kHz, stereo.
        assert_eq!(asc_info(&[0x12, 0x10]).unwrap(), (44100, 2));
        // AAC-LC, 48 kHz, mono.
        assert_eq!(asc_info(&[0x11, 0x88]).unwrap(), (48000, 1));
    }

    #[test]
    fn mpeg_audio_headers_give_their_frame_length() {
        // MPEG-1 layer III, 128 kb/s, 44.1 kHz, no padding, stereo: 417 bytes, 1152 samples.
        let header = mp3_header(&[0xff, 0xfb, 0x90, 0x00]).unwrap();
        assert_eq!((header.rate, header.channels, header.samples, header.length, header.mpeg1), (44100, 2, 1152, 417, true));
        // MPEG-2 layer III, 64 kb/s, 22.05 kHz, mono: 576 samples.
        let header = mp3_header(&[0xff, 0xf3, 0x80, 0xc0]).unwrap();
        assert_eq!((header.rate, header.channels, header.samples), (22050, 1, 576));
        assert!(mp3_header(&[0x00, 0xfb, 0x90, 0x00]).is_none());
    }
}
