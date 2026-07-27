//! 解码：文件 → 单声道 f32 PCM @ 22050 Hz。
//!
//! Python 版是起 ffmpeg 子进程解码。这里换成 symphonia + rubato，纯 Rust：
//! - 安卓上没法 spawn ffmpeg，这是上安卓的必要条件；
//! - 顺带修好一个真实缺陷——现在没装 ffmpeg 的用户**连 BPM 都分析不了**，
//!   换成内建解码之后开箱即用。

use std::fs::File;
use std::path::Path;

use anyhow::{bail, Context, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub const DEFAULT_SR: u32 = 22050;

#[derive(Debug)]
pub struct DecodedAudio {
    /// 单声道 f32
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    /// 源文件的完整时长（秒），可能比 `samples` 覆盖的长（截取分析时）
    pub duration: Option<f64>,
    pub channels: usize,
    pub source_sample_rate: u32,
}

/// 解码整轨或前 `max_seconds` 秒，重采样到 `target_sr`，混成单声道。
pub fn decode_audio(path: &Path, target_sr: u32, max_seconds: Option<f64>) -> Result<DecodedAudio> {
    decode_audio_from(path, target_sr, max_seconds, 0.0)
}

/// 带起始偏移的解码。
///
/// 分析窗从曲子 15% 处开始（跳过 intro 的静音铺垫），所以需要 seek。
pub fn decode_audio_from(
    path: &Path,
    target_sr: u32,
    max_seconds: Option<f64>,
    offset: f64,
) -> Result<DecodedAudio> {
    let file = File::open(path).with_context(|| format!("打开音频失败：{}", path.display()))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .with_context(|| format!("无法识别音频格式：{}", path.display()))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .context("文件里没有可解码的音轨")?;
    let track_id = track.id;
    let params = track.codec_params.clone();
    let source_sr = params.sample_rate.unwrap_or(DEFAULT_SR);
    let channels = params.channels.map(|c| c.count()).unwrap_or(1).max(1);
    let duration = params
        .n_frames
        .zip(params.sample_rate)
        .map(|(frames, rate)| frames as f64 / rate as f64);

    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .context("没有可用的解码器")?;

    if offset > 0.0 {
        // seek 失败不是致命的（有些容器没有索引）——退回从头解码，
        // 分析结果会略有不同但仍然可用，比整首歌分析失败强。
        if let Err(err) = format.seek(
            symphonia::core::formats::SeekMode::Accurate,
            symphonia::core::formats::SeekTo::Time {
                time: symphonia::core::units::Time::from(offset),
                track_id: Some(track_id),
            },
        ) {
            tracing::debug!("跳转到 {offset}s 失败，改从头解码：{err}");
        }
        decoder.reset();
    }

    // 需要多少源采样点就够了（留一点余量给重采样的边界）
    let wanted_source_samples =
        max_seconds.map(|secs| ((secs + 1.0) * source_sr as f64) as usize * channels);

    let mut mono: Vec<f32> = Vec::new();
    let mut buffer: Option<SampleBuffer<f32>> = None;
    let mut decoded_samples = 0usize;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            // 正常读到结尾
            Err(symphonia::core::errors::Error::IoError(err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(symphonia::core::errors::Error::ResetRequired) => break,
            Err(err) => {
                tracing::debug!("读取音频包结束：{err}");
                break;
            }
        };
        if packet.track_id() != track_id {
            continue;
        }
        let audio = match decoder.decode(&packet) {
            Ok(audio) => audio,
            // 单个坏包不该让整首歌分析失败
            Err(symphonia::core::errors::Error::DecodeError(err)) => {
                tracing::debug!("跳过损坏的音频包：{err}");
                continue;
            }
            Err(err) => {
                tracing::debug!("解码结束：{err}");
                break;
            }
        };
        let spec = *audio.spec();
        let slot = buffer.get_or_insert_with(|| {
            SampleBuffer::<f32>::new(audio.capacity() as u64, spec)
        });
        slot.copy_interleaved_ref(audio);
        let interleaved = slot.samples();
        decoded_samples += interleaved.len();

        // 交错样本混成单声道。
        //
        // **除以 √n 而不是 n**：ffmpeg 的 `-ac 1` 用的是能量守恒的 -3dB 声像律
        // （每声道 1/√2），不是简单平均。一开始按平均写，RMS 比 Python 版
        // 稳定低 2.97 dB，能量分级整片掉一档——12 首里 11 首差 1。
        // 这条差异是常数增益，对 BPM/调号无影响（那两条都先按峰值归一），
        // 但 energy / rms_db / peak_db 是直接进曲库的字段，必须对齐。
        let ch = spec.channels.count().max(1);
        let gain = 1.0 / (ch as f32).sqrt();
        mono.reserve(interleaved.len() / ch);
        for frame in interleaved.chunks(ch) {
            mono.push(frame.iter().sum::<f32>() * gain);
        }
        if wanted_source_samples.is_some_and(|wanted| decoded_samples >= wanted) {
            break;
        }
    }

    if mono.is_empty() {
        bail!("解码结果为空（文件可能没有音轨）");
    }
    // 极少数损坏文件会解出 nan/inf，后面的 FFT 会被整片污染，这里直接清零
    for sample in mono.iter_mut() {
        if !sample.is_finite() {
            *sample = 0.0;
        }
    }

    let samples = if source_sr == target_sr {
        mono
    } else {
        resample(&mono, source_sr, target_sr)
    };
    let samples = match max_seconds {
        Some(secs) => {
            let limit = (secs * target_sr as f64) as usize;
            samples.into_iter().take(limit).collect()
        }
        None => samples,
    };

    Ok(DecodedAudio {
        samples,
        sample_rate: target_sr,
        duration,
        channels,
        source_sample_rate: source_sr,
    })
}

/// 加窗 sinc 重采样（Blackman 窗，16 taps）。
///
/// 一开始用的是线性插值，那等价于一个很钝的低通：44.1k→22.05k 时会把高频
/// 大幅衰减，起音包络的形状跟着变，BPM 的倍频判定就容易和 Python 版分道扬镳。
/// sinc 重采样把通带做平，代价是慢一点（整轨分析里占比很小）。
///
/// 降采样时截止频率要按比例收紧到新的奈奎斯特频率，否则会混叠。
fn resample(input: &[f32], from_sr: u32, to_sr: u32) -> Vec<f32> {
    if input.is_empty() || from_sr == to_sr {
        return input.to_vec();
    }
    const TAPS: i64 = 16;
    let ratio = to_sr as f64 / from_sr as f64;
    let cutoff = ratio.min(1.0);
    let out_len = ((input.len() as f64) * ratio).floor() as usize;
    let last = input.len() as i64 - 1;

    (0..out_len)
        .map(|i| {
            let center = i as f64 / ratio;
            let base = center.floor() as i64;
            let mut acc = 0.0f64;
            let mut weight_sum = 0.0f64;
            for offset in -TAPS + 1..=TAPS {
                let index = (base + offset).clamp(0, last);
                let distance = (base + offset) as f64 - center;
                if distance.abs() > TAPS as f64 {
                    continue;
                }
                let sinc = {
                    let x = std::f64::consts::PI * distance * cutoff;
                    if x.abs() < 1e-9 {
                        cutoff
                    } else {
                        cutoff * x.sin() / x
                    }
                };
                // Blackman 窗，抑制旁瓣
                let t = (distance / TAPS as f64 + 1.0) / 2.0;
                let window = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * t).cos()
                    + 0.08 * (4.0 * std::f64::consts::PI * t).cos();
                let weight = sinc * window;
                acc += input[index as usize] as f64 * weight;
                weight_sum += weight;
            }
            if weight_sum.abs() > 1e-12 {
                (acc / weight_sum) as f32
            } else {
                input[base.clamp(0, last) as usize]
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampling_halves_the_length_when_halving_the_rate() {
        let input: Vec<f32> = (0..1000).map(|i| i as f32).collect();
        let out = resample(&input, 44100, 22050);
        assert!((out.len() as i64 - 500).abs() <= 1, "长度 {}", out.len());
    }

    #[test]
    fn resampling_preserves_a_ramp_shape() {
        let input: Vec<f32> = (0..200).map(|i| i as f32).collect();
        let out = resample(&input, 100, 50);
        // 线性斜坡降采样后仍是线性斜坡，步长翻倍。
        // 只看中段：sinc 核在两端会被截断+夹取，边缘几个样本必然有过渡，
        // 这是加窗 sinc 的固有性质，不是 bug。
        for i in 20..80 {
            let value = out[i];
            assert!(
                (value - (i as f32 * 2.0)).abs() < 0.2,
                "第 {i} 个是 {value}，期望 {}",
                i as f32 * 2.0
            );
        }
    }

    #[test]
    fn sinc_resampling_keeps_a_tone_at_full_amplitude() {
        // 线性插值会把接近奈奎斯特的分量压掉一大截（那正是 RMS 掉 3dB 的元凶之一）；
        // 加窗 sinc 在通带内应当基本无损
        let from = 44100.0;
        let freq = 2000.0;
        let input: Vec<f32> = (0..44100)
            .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / from).sin() as f32)
            .collect();
        let out = resample(&input, 44100, 22050);
        let mid = &out[1000..out.len() - 1000];
        let peak = mid.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
        assert!(peak > 0.97, "通带内峰值被压到 {peak}");
    }

    #[test]
    fn same_rate_is_a_passthrough() {
        let input: Vec<f32> = vec![1.0, 2.0, 3.0];
        assert_eq!(resample(&input, 22050, 22050), input);
    }

    #[test]
    fn missing_file_reports_a_useful_error() {
        let err = decode_audio(Path::new("/definitely/not/here.mp3"), DEFAULT_SR, None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("打开音频失败"), "{err}");
    }
}
