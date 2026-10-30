//! End-to-end checks on small samples in `tests/fixtures` (fixtures/README.md says where each
//! comes from). Everything is read back with kdj-media's own MP4 reader and decoded by
//! symphonia; no outside tool is needed.

use kdj_media::{audio, export, h264, mp4, pcm, remux, webm};
use std::path::{Path, PathBuf};

struct Dir(PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        if std::env::var_os("KDJ_MEDIA_KEEP").is_none() {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn dir(name: &str) -> Dir {
    let path = std::env::temp_dir().join(format!("kdj-media-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    Dir(path)
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn never() -> bool {
    false
}

/// The video track's frame count and the audio's presented length (its edit list), after
/// decoding every audio packet: symphonia drops the priming, not the end padding, so what it
/// decodes may only be longer than what is presented, by less than four frames.
fn decode_counts(path: &Path) -> (u64, f64) {
    let movie = mp4::read::Movie::open(path).unwrap();
    let frames = movie.video().map_or(0, |v| v.samples.len() as u64);
    let presented = movie.audio().unwrap().duration_secs();
    let source = pcm::inspect(path).unwrap();
    let mut samples = 0u64;
    pcm::decode_played(path, None, None, &never, &mut |chunk| {
        samples += (chunk.len() / source.channels as usize) as u64;
        Ok(())
    })
    .unwrap();
    let decoded = samples as f64 / source.sample_rate as f64;
    let padding = 4. * 1024. / source.sample_rate as f64;
    assert!(decoded >= presented - 0.001 && decoded < presented + padding, "decoded {decoded} presented {presented}");
    (frames, presented)
}

/// A 16-bit PCM WAV of `seconds` at `rate`, both channels the same `sample(t)`.
fn wav(path: &Path, rate: u32, seconds: f64, sample: impl Fn(f64) -> f64) {
    let frames = (rate as f64 * seconds) as u32;
    let mut data = Vec::with_capacity(frames as usize * 4);
    for n in 0..frames {
        let value = (sample(n as f64 / rate as f64).clamp(-1., 1.) * i16::MAX as f64) as i16;
        data.extend_from_slice(&value.to_le_bytes());
        data.extend_from_slice(&value.to_le_bytes());
    }
    let mut out = Vec::with_capacity(44 + data.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 4).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    std::fs::write(path, out).unwrap();
}

/// The bytes of every sample of a track, in order.
fn sample_bytes(path: &Path, track: &mp4::read::Track) -> Vec<Vec<u8>> {
    let file = std::fs::read(path).unwrap();
    track.samples.iter().map(|s| file[s.offset as usize..s.offset as usize + s.size as usize].to_vec()).collect()
}

#[test]
fn dash_tracks_merge_into_one_mp4() {
    let d = dir("mux");
    let (video, audio) = (fixture("video.m4s"), fixture("audio.m4s"));
    let movie = mp4::read::Movie::open(&video).unwrap();
    assert_eq!(movie.video().unwrap().samples.len(), 60);
    let output = d.0.join("out.mp4");
    remux::mux(Some(&video), Some(&audio), &remux::Job { output: &output, scratch: &d.0, offset_ms: 0, cancelled: &never }).unwrap();
    let (frames, seconds) = decode_counts(&output);
    assert_eq!(frames, 60);
    assert!((seconds - 2.0).abs() < 0.05, "audio {seconds}");
    let duration = mp4::read::Movie::open(&output).unwrap().duration_secs();
    assert!((duration - 2.0).abs() < 0.1, "{duration}");
    assert!((remux::duration_secs(&audio).unwrap() - 2.0).abs() < 0.05);
}

#[test]
fn audio_comes_out_as_m4a_by_copy() {
    let d = dir("extract");
    let (video, audio) = (fixture("video.m4s"), fixture("audio.m4s"));
    let muxed = d.0.join("muxed.mp4");
    remux::mux(Some(&video), Some(&audio), &remux::Job { output: &muxed, scratch: &d.0, offset_ms: 0, cancelled: &never }).unwrap();
    let output = d.0.join("out.m4a");
    remux::extract_audio(&muxed, &remux::Job { output: &output, scratch: &d.0, offset_ms: 0, cancelled: &never }).unwrap();
    let movie = mp4::read::Movie::open(&output).unwrap();
    assert!(movie.video().is_none());
    let track = movie.audio().unwrap();
    assert!(track.aac().is_some());
    // Bit-exact: the same packets as the source.
    let source = mp4::read::Movie::open(&audio).unwrap();
    assert_eq!(sample_bytes(&output, track), sample_bytes(&audio, source.audio().unwrap()));
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn offsets_cut_and_pad_to_the_millisecond() {
    let d = dir("offset");
    let (video, audio) = (fixture("video.m4s"), fixture("audio.m4s"));
    for offset in [450i64, -300] {
        let output = d.0.join(format!("off{offset}.mp4"));
        remux::mux(Some(&video), Some(&audio), &remux::Job { output: &output, scratch: &d.0, offset_ms: offset, cancelled: &never }).unwrap();
        let movie = mp4::read::Movie::open(&output).unwrap();
        let duration = movie.duration_secs();
        let expected = 2.0 - offset as f64 / 1000.;
        assert!((duration - expected).abs() < 0.06, "offset {offset}: {duration} vs {expected}");
        // The audio presents the source's own length minus the offset, to the millisecond.
        let source = remux::duration_secs(&audio).unwrap();
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
    let d = dir("align");
    let source = d.0.join("click.wav");
    wav(&source, 48_000, 3.0, |t| if (1.0..1.05).contains(&t) { (2. * std::f64::consts::PI * 1000. * t).sin() } else { 0. });
    let scratch = d.0.join("aac.raw");
    let track = audio::encode(&source, &scratch, 0, None, 256_000, audio::Shape::default(), &never).unwrap();
    let output = d.0.join("click.m4a");
    mp4::write::write(&output, &[scratch.as_path()], &[track], mp4::write::Brand::M4a, &never).unwrap();
    let mut mono = Vec::new();
    pcm::decode_played(&output, Some(48_000), None, &never, &mut |chunk| {
        mono.extend(chunk.chunks(2).map(|f| f[0]));
        Ok(())
    })
    .unwrap();
    let onset = mono.iter().position(|s| s.abs() > 0.3).unwrap();
    assert!((onset as i64 - 48_000).abs() < 64, "onset at {onset}");
    // The file presents exactly the source's length; decoding keeps the end padding.
    let presented = mp4::read::Movie::open(&output).unwrap().audio().unwrap().duration_secs();
    assert!((presented - 3.0).abs() < 0.001, "presented {presented}");
    assert!((144_000..144_000 + 4 * 1024).contains(&mono.len()), "length {}", mono.len());
}

#[test]
fn editor_gops_become_an_h264_track() {
    let d = dir("export");
    let bytes = std::fs::read(fixture("video.h264")).unwrap();
    let scratch = d.0.join("video.samples");
    let mut track = export::VideoTrack::create(&scratch, 0, 160, 90, 30).unwrap();
    // Split at each IDR's leading SPS into GOPs, as the visualizer's encoder uploads them.
    let mut starts: Vec<usize> = (0..bytes.len().saturating_sub(4)).filter(|&i| bytes[i..i + 4] == [0, 0, 0, 1] && bytes[i + 4] & 0x1f == 7).collect();
    starts.push(bytes.len());
    for pair in starts.windows(2) {
        assert_eq!(track.push_gop(&bytes[pair[0]..pair[1]]).unwrap(), 30);
    }
    let video = track.finish().unwrap();
    let tone = d.0.join("tone.wav");
    wav(&tone, 48_000, 2.0, |t| 0.5 * (2. * std::f64::consts::PI * 440. * t).sin());
    let aac = d.0.join("audio.raw");
    let sound = audio::copy(&tone, 1, Some(48000), None).map(Ok).unwrap_or_else(|| {
        if kdj_media::aac::available() { audio::encode(&tone, &aac, 1, Some(48000), 256_000, audio::Shape::default(), &never) } else { Err(anyhow::anyhow!("no encoder")) }
    });
    let Ok(sound) = sound else { return };
    let output = d.0.join("export.mp4");
    mp4::write::write(&output, &[scratch.as_path(), aac.as_path()], &[video, sound], mp4::write::Brand::Mp4, &never).unwrap();
    // The sample entry says BT.709 in limited range, in its `colr` box and in its SPS, whatever
    // range the encoder wrote (the fixture is full range).
    let movie = mp4::read::Movie::open(&output).unwrap();
    let entry = &movie.video().unwrap().entries[0];
    let colr = entry.windows(4).position(|w| w == b"nclx").expect("colr nclx");
    assert_eq!(&entry[colr + 4..colr + 11], &[0, 1, 0, 1, 0, 1, 0]);
    let first = sample_bytes(&output, movie.video().unwrap()).remove(0);
    let mut at = 0;
    let mut sps = None;
    while at + 4 <= first.len() {
        let len = u32::from_be_bytes(first[at..at + 4].try_into().unwrap()) as usize;
        let unit = &first[at + 4..at + 4 + len];
        if h264::nal_type(unit) == 7 {
            sps = Some(unit.to_vec());
        }
        at += 4 + len;
    }
    let avcc = entry.windows(4).position(|w| w == b"avcC").expect("avcC");
    let sps_len = u16::from_be_bytes([entry[avcc + 10], entry[avcc + 11]]) as usize;
    let written = &entry[avcc + 12..avcc + 12 + sps_len];
    assert_eq!(h264::sps_bt709_limited(written).unwrap(), written, "the entry's SPS is already BT.709 limited");
    if let Some(sps) = sps {
        assert_eq!(sps, written, "in-band SPS matches the entry");
    }
    let (frames, seconds) = decode_counts(&output);
    assert_eq!(frames, 60);
    assert!((seconds - 2.0).abs() < 0.01, "{seconds}");
    let checked = export::check(&output).unwrap();
    assert_eq!((checked.width, checked.height, checked.frames, checked.audio_rate), (160, 90, 60, 48000));
    assert!((checked.fps - 30.0).abs() < 0.001, "{checked:?}");
    assert!((checked.audio_secs - 2.0).abs() < 0.001 && (checked.video_secs - 2.0).abs() < 0.001, "{checked:?}");
}

/// Ogg pages of a stream: (granule position, segment payloads joined into packets).
fn ogg_packets(bytes: &[u8]) -> (Vec<Vec<u8>>, i64) {
    let mut packets = Vec::new();
    let mut current = Vec::new();
    let mut granule = 0;
    let mut at = 0;
    while at < bytes.len() {
        assert_eq!(&bytes[at..at + 4], b"OggS", "page at {at}");
        granule = i64::from_le_bytes(bytes[at + 6..at + 14].try_into().unwrap());
        let count = bytes[at + 26] as usize;
        let lacing = &bytes[at + 27..at + 27 + count];
        let mut body = at + 27 + count;
        for &len in lacing {
            current.extend_from_slice(&bytes[body..body + len as usize]);
            body += len as usize;
            if len < 255 {
                packets.push(std::mem::take(&mut current));
            }
        }
        at = body;
    }
    (packets, granule)
}

#[test]
fn webm_opus_becomes_ogg_opus() {
    let d = dir("opus");
    let output = d.0.join("out.opus");
    webm::opus_to_ogg(&fixture("opus.webm"), &output, &never).unwrap();
    let (packets, granule) = ogg_packets(&std::fs::read(&output).unwrap());
    assert!(packets[0].starts_with(b"OpusHead"), "first packet");
    assert!(packets[1].starts_with(b"OpusTags"), "second packet");
    // 20 ms frames: one second of sound and the encoder's delay in 50 or 51 packets.
    assert!((50..=51).contains(&(packets.len() - 2)), "{} packets", packets.len() - 2);
    let pre_skip = u16::from_le_bytes([packets[0][10], packets[0][11]]) as i64;
    let seconds = (granule - pre_skip) as f64 / 48_000.;
    assert!((seconds - 1.0).abs() < 0.03, "{seconds}");
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

/// `decode_played` starts where players start an M4A: after its priming.
#[test]
fn played_decode_skips_the_priming() {
    let song = fixture("click.m4a");
    let onset = |played: bool| {
        let mut mono = Vec::new();
        let mut take = |pcm: &[f32]| { mono.extend(pcm.chunks(2).map(|f| f[0])); Ok(()) };
        if played { pcm::decode_played(&song, Some(8000), None, &never, &mut take).unwrap(); } else { pcm::decode(&song, Some(8000), None, &never, &mut take).unwrap(); }
        mono.iter().position(|s| s.abs() > 0.3).unwrap() as i64
    };
    let (played, raw) = (onset(true), onset(false));
    assert!((played - 8000).abs() <= 3, "played onset {played}");
    // The raw decode keeps the encoder's 1024-sample priming: 186 samples at 8 kHz.
    assert!((raw - played - 186).abs() <= 3, "raw {raw} played {played}");
}
