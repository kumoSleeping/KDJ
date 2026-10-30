//! 哔哩哔哩's single-stream FLV into MP4, M4A and MP3, on the samples in `tests/fixtures`
//! (fixtures/README.md). The FLV's tags are walked here independently of `kdj_media::flv`, and
//! the results are read back with kdj-media's MP4 reader and decoded by symphonia.

use kdj_media::{flv, mp4, pcm};
use std::path::{Path, PathBuf};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kdj-media-flv-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn never() -> bool {
    false
}

/// Payloads of the FLV's tags: (video NAL unit payloads, AAC raw frames, MP3 data).
fn tags(path: &Path) -> (Vec<Vec<u8>>, Vec<Vec<u8>>, Vec<u8>) {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[..3], b"FLV");
    let mut at = u32::from_be_bytes(bytes[5..9].try_into().unwrap()) as usize + 4;
    let (mut video, mut aac, mut mp3) = (Vec::new(), Vec::new(), Vec::new());
    while at + 11 <= bytes.len() {
        let kind = bytes[at];
        let size = u32::from_be_bytes([0, bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
        let data = &bytes[at + 11..at + 11 + size];
        match kind {
            9 if data[1] == 1 => video.push(data[5..].to_vec()),
            8 if data[0] >> 4 == 10 && data[1] == 1 => aac.push(data[2..].to_vec()),
            8 if data[0] >> 4 == 2 => mp3.extend_from_slice(&data[1..]),
            _ => {}
        }
        at += 11 + size + 4;
    }
    (video, aac, mp3)
}

fn sample_bytes(path: &Path, track: &mp4::read::Track) -> Vec<Vec<u8>> {
    let file = std::fs::read(path).unwrap();
    track.samples.iter().map(|s| file[s.offset as usize..s.offset as usize + s.size as usize].to_vec()).collect()
}

/// Seconds of sound symphonia decodes from `path`, after the priming.
fn decoded_secs(path: &Path) -> f64 {
    let source = pcm::inspect(path).unwrap();
    let mut frames = 0u64;
    pcm::decode_played(path, None, None, &never, &mut |chunk| {
        frames += (chunk.len() / source.channels as usize) as u64;
        Ok(())
    })
    .unwrap();
    frames as f64 / source.sample_rate as f64
}

#[test]
fn h264_and_aac_become_an_mp4_packet_for_packet() {
    let dir = scratch("aac");
    let source = fixture("flv-aac.flv");
    let output = dir.join("out.mp4");
    flv::to_mp4(&source, &output, true, true, &never).unwrap();
    let (video, aac, _) = tags(&source);
    let movie = mp4::read::Movie::open(&output).unwrap();
    let picture = movie.video().unwrap();
    assert_eq!(&picture.codec(), b"avc1");
    assert_eq!((picture.width, picture.height), (96, 64));
    assert_eq!(sample_bytes(&output, picture), video);
    assert_eq!(picture.samples.len(), 30);
    assert!(picture.samples.iter().filter(|s| s.sync).count() >= 2, "keyframes are marked");
    assert!(picture.samples.iter().any(|s| s.cts != 0), "B-frames keep their composition times");
    assert!((picture.duration_secs() - 1.0).abs() < 0.05, "{}", picture.duration_secs());
    let sound = movie.audio().unwrap();
    assert_eq!(sound.aac().unwrap().sample_rate, 44100);
    assert_eq!(sample_bytes(&output, sound), aac);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_audio_alone_becomes_an_m4a_and_decodes() {
    let dir = scratch("m4a");
    let source = fixture("flv-aac.flv");
    let output = dir.join("out.m4a");
    flv::to_mp4(&source, &output, false, true, &never).unwrap();
    let movie = mp4::read::Movie::open(&output).unwrap();
    assert!(movie.video().is_none());
    assert_eq!(sample_bytes(&output, movie.audio().unwrap()), tags(&source).1);
    let seconds = decoded_secs(&output);
    assert!((seconds - 1.0).abs() < 0.1, "{seconds}");
    let video = dir.join("video.mp4");
    flv::to_mp4(&source, &video, true, false, &never).unwrap();
    let movie = mp4::read::Movie::open(&video).unwrap();
    assert!(movie.audio().is_none() && movie.video().is_some());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn mp3_is_kept_as_mp3_or_carried_in_mp4() {
    let dir = scratch("mp3");
    let source = fixture("flv-mp3.flv");
    let (_, _, frames) = tags(&source);
    let mp3 = dir.join("out.mp3");
    flv::to_mp3(&source, &mp3, &never).unwrap();
    assert_eq!(std::fs::read(&mp3).unwrap(), frames);
    let seconds = decoded_secs(&mp3);
    assert!((seconds - 1.0).abs() < 0.1, "{seconds}");
    assert_eq!(flv::Flv::open(&source).unwrap().audio_codec(), Some(flv::AudioCodec::Mp3));
    // In MP4 the frames are `mp4a` MPEG-1 audio (0x6B), which symphonia decodes.
    let output = dir.join("out.mp4");
    flv::to_mp4(&source, &output, true, true, &never).unwrap();
    let movie = mp4::read::Movie::open(&output).unwrap();
    let sound = movie.audio().unwrap();
    assert_eq!(&sound.codec(), b"mp4a");
    assert_eq!(sample_bytes(&output, sound).concat(), frames);
    assert_eq!(movie.video().unwrap().samples.len(), 30);
    let audio_only = dir.join("audio.m4a");
    flv::to_mp4(&source, &audio_only, false, true, &never).unwrap();
    let seconds = decoded_secs(&audio_only);
    assert!((seconds - 1.0).abs() < 0.1, "{seconds}");
    let _ = std::fs::remove_dir_all(dir);
}

/// MP3 out of an FLV into M4A means re-encoding it with the system AAC encoder.
#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn mp3_goes_into_m4a_as_aac_with_an_offset() {
    let dir = scratch("mp3-aac");
    let audio = dir.join("audio.m4a");
    flv::to_mp4(&fixture("flv-mp3.flv"), &audio, false, true, &never).unwrap();
    let output = dir.join("out.m4a");
    let job = kdj_media::remux::Job { output: &output, scratch: &dir, offset_ms: 250, cancelled: &never };
    kdj_media::remux::extract_audio(&audio, &job).unwrap();
    let movie = mp4::read::Movie::open(&output).unwrap();
    let sound = movie.audio().unwrap();
    assert!(sound.aac().is_some());
    let source = mp4::read::Movie::open(&audio).unwrap().audio().unwrap().duration_secs();
    assert!((sound.duration_secs() - (source - 0.25)).abs() < 0.002, "{} vs {source}", sound.duration_secs());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_picture_that_is_not_h264_is_refused() {
    let dir = scratch("hevc");
    let path = dir.join("hevc.flv");
    let mut bytes = b"FLV\x01\x01\x00\x00\x00\x09\x00\x00\x00\x00".to_vec();
    // One video tag: key frame, codec 12 (the HEVC extension of FLV), a sequence header.
    let data = [0x1c, 0x00, 0x00, 0x00, 0x00, 0x01];
    bytes.extend_from_slice(&[9, 0, 0, data.len() as u8, 0, 0, 0, 0, 0, 0, 0]);
    bytes.extend_from_slice(&data);
    bytes.extend_from_slice(&(11 + data.len() as u32).to_be_bytes());
    std::fs::write(&path, bytes).unwrap();
    let error = flv::to_mp4(&path, &dir.join("out.mp4"), true, true, &never).unwrap_err().to_string();
    assert!(error.contains("HEVC"), "{error}");
    let _ = std::fs::remove_dir_all(dir);
}
