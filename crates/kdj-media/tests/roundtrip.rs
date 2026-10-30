//! End-to-end checks against FFmpeg as the reference reader. FFmpeg only makes the
//! inputs and inspects the outputs; without it on PATH every test returns early.

use kdj_media::{audio, export, mp4, remux, webm};
use std::path::{Path, PathBuf};
use std::process::Command;

struct Dir(PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        if std::env::var_os("KDJ_MEDIA_KEEP").is_none() {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn dir(name: &str) -> Option<Dir> {
    if Command::new("ffmpeg").arg("-version").output().is_err() {
        eprintln!("ffmpeg not found; skipping");
        return None;
    }
    let path = std::env::temp_dir().join(format!("kdj-media-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    Some(Dir(path))
}

fn ffmpeg(args: &[&str]) {
    let out = Command::new("ffmpeg").args(["-v", "error", "-y"]).args(args).output().unwrap();
    assert!(out.status.success(), "ffmpeg {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn probe(path: &Path, entries: &str) -> String {
    let out = Command::new("ffprobe").args(["-v", "error", "-show_entries", entries, "-of", "default=noprint_wrappers=1"]).arg(path).output().unwrap();
    assert!(out.status.success(), "ffprobe: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn field(text: &str, key: &str) -> Vec<String> {
    text.lines().filter_map(|l| l.strip_prefix(&format!("{key}="))).map(str::to_string).collect()
}

/// Decodes every frame to check the file is whole; returns (video frames, audio seconds).
fn decode_counts(path: &Path) -> (u64, f64) {
    let out = Command::new("ffprobe").args(["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames,duration", "-of", "default=noprint_wrappers=1"]).arg(path).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    let frames = field(&text, "nb_read_frames");
    let kinds = field(&text, "codec_type");
    let durations = field(&text, "duration");
    let mut video = 0;
    let mut audio = 0.;
    for (n, kind) in kinds.iter().enumerate() {
        if kind == "video" {
            video = frames[n].parse().unwrap_or(0);
        } else if kind == "audio" {
            audio = durations[n].parse().unwrap_or(0.);
        }
    }
    (video, audio)
}

fn never() -> bool {
    false
}

fn dash_inputs(d: &Path) -> (PathBuf, PathBuf) {
    let video = d.join("video.m4s");
    let audio = d.join("audio.m4s");
    ffmpeg(&["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-t", "6", "-c:v", "libx264", "-g", "30", "-bf", "2", "-pix_fmt", "yuv420p", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", video.to_str().unwrap()]);
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "6", "-c:a", "aac", "-b:a", "128k", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000", "-f", "mp4", audio.to_str().unwrap()]);
    (video, audio)
}

#[test]
fn dash_tracks_merge_into_one_mp4() {
    let Some(d) = dir("mux") else { return };
    let (video, audio) = dash_inputs(&d.0);
    let movie = mp4::read::Movie::open(&video).unwrap();
    assert_eq!(movie.video().unwrap().samples.len(), 180);
    let output = d.0.join("out.mp4");
    remux::mux(Some(&video), Some(&audio), &remux::Job { output: &output, scratch: &d.0, offset_ms: 0, cancelled: &never }).unwrap();
    let (frames, seconds) = decode_counts(&output);
    assert_eq!(frames, 180);
    assert!((seconds - 6.0).abs() < 0.05, "audio {seconds}");
    let text = probe(&output, "format=duration");
    let duration: f64 = field(&text, "duration")[0].parse().unwrap();
    assert!((duration - 6.0).abs() < 0.1, "{duration}");
    assert!((remux::duration_secs(&audio).unwrap() - 6.0).abs() < 0.05);
}

#[test]
fn audio_comes_out_as_m4a_by_copy() {
    let Some(d) = dir("extract") else { return };
    let (video, audio) = dash_inputs(&d.0);
    let muxed = d.0.join("muxed.mp4");
    ffmpeg(&["-i", video.to_str().unwrap(), "-i", audio.to_str().unwrap(), "-c", "copy", muxed.to_str().unwrap()]);
    let output = d.0.join("out.m4a");
    remux::extract_audio(&muxed, &remux::Job { output: &output, scratch: &d.0, offset_ms: 0, cancelled: &never }).unwrap();
    let text = probe(&output, "stream=codec_name,codec_type");
    assert_eq!(field(&text, "codec_type"), ["audio"]);
    assert_eq!(field(&text, "codec_name"), ["aac"]);
    // Bit-exact: the same packets as the source.
    let hash = |p: &Path| String::from_utf8_lossy(&Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(p).args(["-map", "0:a", "-c", "copy", "-f", "md5", "-"]).output().unwrap().stdout).into_owned();
    assert_eq!(hash(&output), hash(&audio));
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn offsets_cut_and_pad_to_the_millisecond() {
    let Some(d) = dir("offset") else { return };
    let (video, audio) = dash_inputs(&d.0);
    for offset in [1250i64, -800] {
        let output = d.0.join(format!("off{offset}.mp4"));
        remux::mux(Some(&video), Some(&audio), &remux::Job { output: &output, scratch: &d.0, offset_ms: offset, cancelled: &never }).unwrap();
        let text = probe(&output, "format=duration");
        let duration: f64 = field(&text, "duration")[0].parse().unwrap();
        let expected = 6.0 - offset as f64 / 1000.;
        assert!((duration - expected).abs() < 0.06, "offset {offset}: {duration} vs {expected}");
        // The audio presents the source's own length minus the offset, to the millisecond.
        let source = remux::duration_secs(&audio).unwrap();
        let movie = mp4::read::Movie::open(&output).unwrap();
        let shifted = movie.audio().unwrap();
        let presented = shifted.edit_duration.unwrap() as f64 / shifted.movie_timescale as f64;
        assert!((presented - (source - offset as f64 / 1000.)).abs() < 0.0015, "{presented} vs {source}");
        let m4a = d.0.join(format!("off{offset}.m4a"));
        remux::extract_audio(&output, &remux::Job { output: &m4a, scratch: &d.0, offset_ms: 0, cancelled: &never }).unwrap();
    }
    let leftovers: Vec<_> = std::fs::read_dir(&d.0).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("kdj-media-")).collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

/// The click of a 1 kHz tone burst at 1.000 s must come out at 1.000 s.
#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn encoded_audio_stays_sample_aligned() {
    let Some(d) = dir("align") else { return };
    let wav = d.0.join("click.wav");
    ffmpeg(&["-f", "lavfi", "-i", "aevalsrc='if(between(t,1,1.05),sin(2*PI*1000*t),0)':s=48000:c=stereo", "-t", "3", wav.to_str().unwrap()]);
    let scratch = d.0.join("aac.raw");
    let track = audio::encode(&wav, &scratch, 0, None, 256_000, audio::Shape::default(), &never).unwrap();
    let output = d.0.join("click.m4a");
    mp4::write::write(&output, &[scratch.as_path()], &[track], mp4::write::Brand::M4a, &never).unwrap();
    let pcm = Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&output).args(["-ac", "1", "-f", "f32le", "-"]).output().unwrap().stdout;
    let samples: Vec<f32> = pcm.chunks(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
    let onset = samples.iter().position(|s| s.abs() > 0.3).unwrap();
    assert!((onset as i64 - 48_000).abs() < 64, "onset at {onset}");
    // FFmpeg applies an edit's start but not its end: up to one frame of padding remains.
    assert!((144_000..144_000 + 1024).contains(&samples.len()), "length {}", samples.len());
}

#[test]
fn editor_gops_become_an_h264_track() {
    let Some(d) = dir("export") else { return };
    let stream = d.0.join("video.h264");
    ffmpeg(&["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "4", "-c:v", "libx264", "-g", "30", "-bf", "0", "-x264-params", "keyint=30:min-keyint=30:scenecut=0", "-pix_fmt", "yuv420p", "-color_range", "pc", "-bsf:v", "h264_mp4toannexb", "-f", "h264", stream.to_str().unwrap()]);
    let bytes = std::fs::read(&stream).unwrap();
    let scratch = d.0.join("video.samples");
    let mut track = export::VideoTrack::create(&scratch, 0, 640, 360, 30).unwrap();
    // Split at each IDR's leading SPS into GOPs, as the editor uploads them.
    let mut starts: Vec<usize> = (0..bytes.len().saturating_sub(4)).filter(|&i| bytes[i..i + 4] == [0, 0, 0, 1] && bytes[i + 4] & 0x1f == 7).collect();
    starts.push(bytes.len());
    for pair in starts.windows(2) {
        assert_eq!(track.push_gop(&bytes[pair[0]..pair[1]]).unwrap(), 30);
    }
    let video = track.finish().unwrap();
    let wav = d.0.join("tone.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", wav.to_str().unwrap()]);
    let aac = d.0.join("audio.raw");
    let sound = audio::copy(&wav, 1, Some(48000), None).map(Ok).unwrap_or_else(|| {
        if kdj_media::aac::available() { audio::encode(&wav, &aac, 1, Some(48000), 256_000, audio::Shape::default(), &never) } else { Err(anyhow::anyhow!("no encoder")) }
    });
    let Ok(sound) = sound else { return };
    let output = d.0.join("export.mp4");
    mp4::write::write(&output, &[scratch.as_path(), aac.as_path()], &[video, sound], mp4::write::Brand::Mp4, &never).unwrap();
    let text = probe(&output, "stream=codec_name,width,height,color_range,color_primaries,color_transfer,color_space,avg_frame_rate,nb_frames");
    assert_eq!(field(&text, "color_range")[0], "tv", "{text}");
    assert_eq!(field(&text, "color_primaries")[0], "bt709");
    assert_eq!(field(&text, "color_space")[0], "bt709");
    assert_eq!(field(&text, "avg_frame_rate")[0], "30/1");
    let (frames, seconds) = decode_counts(&output);
    assert_eq!(frames, 120);
    assert!((seconds - 4.0).abs() < 0.01, "{seconds}");
    let checked = export::check(&output).unwrap();
    assert_eq!((checked.width, checked.height, checked.frames, checked.audio_rate), (640, 360, 120, 48000));
    assert!((checked.audio_secs - 4.0).abs() < 0.001 && (checked.video_secs - 4.0).abs() < 0.001, "{checked:?}");
}

#[test]
fn webm_opus_becomes_ogg_opus() {
    let Some(d) = dir("opus") else { return };
    let input = d.0.join("in.webm");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "5", "-c:a", "libopus", "-b:a", "96k", input.to_str().unwrap()]);
    let output = d.0.join("out.opus");
    webm::opus_to_ogg(&input, &output, &never).unwrap();
    let text = probe(&output, "stream=codec_name:format=format_name,duration");
    assert_eq!(field(&text, "codec_name"), ["opus"]);
    let duration: f64 = field(&text, "duration")[0].parse().unwrap();
    assert!((duration - 5.0).abs() < 0.03, "{duration}");
    let hash = |p: &Path| String::from_utf8_lossy(&Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(p).args(["-map", "0:a", "-c", "copy", "-f", "md5", "-"]).output().unwrap().stdout).into_owned();
    assert_eq!(hash(&output), hash(&input));
    let out = Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&output).args(["-f", "null", "-"]).output().unwrap();
    assert!(out.status.success() && out.stderr.is_empty(), "{}", String::from_utf8_lossy(&out.stderr));
}

/// AudioToolbox reports its priming; the measurement used for every encoder must agree.
#[cfg(target_os = "macos")]
#[test]
fn measured_priming_matches_audiotoolbox() {
    for (rate, channels) in [(48_000, 2), (44_100, 2), (44_100, 1)] {
        let opened = kdj_media::aac::open(rate, channels, 192_000).unwrap();
        let reported = opened.encoder.priming();
        assert!((opened.priming as i64 - reported as i64).abs() <= 1, "{rate}/{channels}: measured {} reported {reported}", opened.priming);
    }
}

/// `decode_played` starts where FFmpeg (and players) start an M4A: after its priming.
#[test]
fn played_decode_skips_the_priming_like_ffmpeg() {
    let Some(d) = dir("played") else { return };
    let song = d.0.join("click.m4a");
    ffmpeg(&["-f", "lavfi", "-i", "aevalsrc='if(between(t,1,1.01),0.9*sin(2*PI*2000*t),0)':s=44100:c=stereo", "-t", "3", "-c:a", "aac", "-b:a", "192k", song.to_str().unwrap()]);
    let onset = |played: bool| {
        let mut mono = Vec::new();
        let mut take = |pcm: &[f32]| { mono.extend(pcm.chunks(2).map(|f| f[0])); Ok(()) };
        if played { kdj_media::pcm::decode_played(&song, Some(8000), None, &never, &mut take).unwrap(); } else { kdj_media::pcm::decode(&song, Some(8000), None, &never, &mut take).unwrap(); }
        mono.iter().position(|s| s.abs() > 0.3).unwrap() as i64
    };
    let (played, raw) = (onset(true), onset(false));
    assert!((played - 8000).abs() <= 3, "played onset {played}");
    // The raw decode keeps FFmpeg's 1024-sample priming: 186 samples at 8 kHz.
    assert!((raw - played - 186).abs() <= 3, "raw {raw} played {played}");
}
