//! seek 到/越过流末尾的回归测试：曾经以 “seek audio to ...s: end of stream”
//! 失败，现在应收敛到末尾余量内（或逐级提前重试）成功起播。
use std::io::Write;
use std::path::{Path, PathBuf};

use kdj_player::{decode_file_scratch_window, decode_file_streaming, StreamSource};

fn write_wav(path: &Path, seconds: f64) {
    let rate = 44_100u32;
    let frames = (seconds * f64::from(rate)) as u32;
    let mut data = Vec::with_capacity(44 + frames as usize * 4);
    let byte_len = frames * 4;
    data.extend_from_slice(b"RIFF");
    data.extend_from_slice(&(36 + byte_len).to_le_bytes());
    data.extend_from_slice(b"WAVEfmt ");
    data.extend_from_slice(&16u32.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes()); // PCM
    data.extend_from_slice(&2u16.to_le_bytes()); // stereo
    data.extend_from_slice(&rate.to_le_bytes());
    data.extend_from_slice(&(rate * 4).to_le_bytes());
    data.extend_from_slice(&4u16.to_le_bytes());
    data.extend_from_slice(&16u16.to_le_bytes());
    data.extend_from_slice(b"data");
    data.extend_from_slice(&byte_len.to_le_bytes());
    for i in 0..frames {
        let sample = ((i as f64 * 440.0 * 2.0 * std::f64::consts::PI / f64::from(rate)).sin()
            * 0.5
            * f64::from(i16::MAX)) as i16;
        data.extend_from_slice(&sample.to_le_bytes());
        data.extend_from_slice(&sample.to_le_bytes());
    }
    let mut file = std::fs::File::create(path).unwrap();
    file.write_all(&data).unwrap();
}

fn decode_at(path: &Path, position: f64) -> (String, u64) {
    let (source, writer) = StreamSource::bounded(44_100 * 8);
    let result = decode_file_streaming(path, position, 44_100, writer, || false);
    let buffered = source.buffered_frames();
    drop(source);
    match result {
        Ok(meta) => (format!("OK duration={:?}", meta.duration), buffered),
        Err(error) => (format!("ERR {error:#}"), buffered),
    }
}

/// WAV（PCM）精确 seek 到正好结尾会被 symphonia 判 out-of-range；
/// 收敛后应能从末尾余量处起播，且实际解出了最后那一小段。
#[test]
fn seek_to_and_past_the_end_falls_back_near_the_end() {
    let path: PathBuf = std::env::temp_dir().join("kdj-seek-end-regression.wav");
    write_wav(&path, 3.0);

    let (at_end, buffered_at_end) = decode_at(&path, 3.0);
    let (past_end, buffered_past_end) = decode_at(&path, 3.001);
    let (far_past, buffered_far) = decode_at(&path, 30.0);
    eprintln!("pos=3.0   -> {at_end} buffered={buffered_at_end}");
    eprintln!("pos=3.001 -> {past_end} buffered={buffered_past_end}");
    eprintln!("pos=30.0  -> {far_past} buffered={buffered_far}");

    for (label, result, buffered) in [
        ("3.0", at_end, buffered_at_end),
        ("3.001", past_end, buffered_past_end),
        ("30.0", far_past, buffered_far),
    ] {
        assert!(result.starts_with("OK"), "pos={label} 不应失败：{result}");
        assert!(buffered > 0, "pos={label} 应解出末尾附近的音频");
        // 余量 0.25s：缓冲量必须明显小于 1s，证明确实从接近末尾处起播。
        assert!(buffered < 44_100, "pos={label} 不应从头解码整曲");
    }
}

/// 有损格式（时长常虚高）在本地有样本时顺带验证；没有样本就跳过。
#[test]
fn seek_past_end_compressed_samples() {
    for file in ["/tmp/kdj-seek-test.mp3", "/tmp/kdj-seek-test.flac"] {
        let path = Path::new(file);
        if !path.exists() {
            eprintln!("跳过 {file}（样本不存在）");
            continue;
        }
        for position in [3.0, 3.05, 5.0] {
            let (result, buffered) = decode_at(path, position);
            eprintln!("{file} pos={position} -> {result} buffered={buffered}");
            assert!(
                result.starts_with("OK"),
                "{file} pos={position} 不应失败：{result}"
            );
            assert!(buffered > 0);
        }
    }
}

#[test]
fn scratch_window_keeps_absolute_output_frame_alignment_after_seek() {
    let path = std::env::temp_dir().join("kdj-scratch-window-regression.wav");
    write_wav(&path, 3.0);
    let rate = 48_000;
    let requested = 1.25;
    let window = decode_file_scratch_window(&path, requested, rate, rate as usize, || false)
        .expect("bounded random PCM decode");
    let expected = (requested * f64::from(rate)).round() as i64;
    assert!(
        (window.start_frame - expected).abs() <= 1,
        "random cache index must use decoder media time: {} vs {expected}",
        window.start_frame
    );
    assert_eq!(window.frames.len(), rate as usize);
    assert!(window
        .frames
        .iter()
        .any(|frame| frame[0].abs() > 0.01 || frame[1].abs() > 0.01));
}
