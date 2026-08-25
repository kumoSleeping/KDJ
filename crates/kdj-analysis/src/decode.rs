//! 解码：文件 → 单声道 f32 PCM（分析用 22050 Hz；展示波形可保留源采样率）。
//!
//! Python 版是起 ffmpeg 子进程解码。这里换成 symphonia + rubato，纯 Rust：
//! - 安卓上没法 spawn ffmpeg，这是上安卓的必要条件；
//! - 顺带修好一个真实缺陷——现在没装 ffmpeg 的用户**连 BPM 都分析不了**，
//!   换成内建解码之后开箱即用。

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{bail, Context, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub const DEFAULT_SR: u32 = 22050;

fn known_sample_rate(rate: Option<u32>) -> Option<u32> {
    rate.filter(|rate| *rate > 0)
}

fn track_duration(params: &symphonia::core::codecs::CodecParameters) -> Option<f64> {
    params
        .n_frames
        .zip(known_sample_rate(params.sample_rate))
        .map(|(frames, rate)| frames as f64 / rate as f64)
}

/// 只读容器头拿总时长，不解 PCM、不重采样。
///
/// 分析窗要从 15% 处起跳，必须先知道全曲多长。旧实现为此先解 50ms 再 sinc，
/// 等于每首歌多打开一次解码器。时长在 Xing/容器头里，probe 就够了。
pub fn probe_duration(path: &Path) -> Result<Option<f64>> {
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
    let track = probed
        .format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .context("文件里没有可解码的音轨")?;
    Ok(track_duration(&track.codec_params))
}

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

/// 展示波形只需要峰值包络，不需要 BPM/Key 所要求的带限重采样。保留源采样率可以
/// 省掉整轨 32-tap sinc（4 分钟 MP3 在 M2 上约 7 秒），也是装轨即时显示的快路径。
pub fn decode_audio_native(path: &Path, max_seconds: Option<f64>) -> Result<DecodedAudio> {
    decode_audio_inner(path, None, max_seconds, 0.0)
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
    decode_audio_inner(path, Some(target_sr), max_seconds, offset)
}

fn decode_audio_inner(
    path: &Path,
    target_sr: Option<u32>,
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
    // 部分 FFmpeg 生成的 AAC（实际 96 kHz）在 MP4 codec params 里会暂时报 0 Hz，
    // 真正解出首包后 `SignalSpec::rate` 才是正确值。0 不能参与时长或重采样：
    // target / 0 会变成 inf，随后 Vec 按 usize::MAX 预分配并以 capacity overflow panic。
    let mut source_sr = known_sample_rate(params.sample_rate).unwrap_or(DEFAULT_SR);
    let channels = params.channels.map(|c| c.count()).unwrap_or(1).max(1);
    let duration = track_duration(&params);

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
        // codec params 缺失/报 0 时，以解码器首包的真实采样率为准。wanted 的上限也
        // 必须用这份值算，否则 96 kHz 素材会只截到预期时长的约四分之一。
        if spec.rate > 0 {
            source_sr = spec.rate;
        }
        let slot =
            buffer.get_or_insert_with(|| SampleBuffer::<f32>::new(audio.capacity() as u64, spec));
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
        let wanted_source_samples =
            max_seconds.map(|secs| ((secs + 1.0) * source_sr as f64) as usize * ch);
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

    let output_sr = target_sr.filter(|rate| *rate > 0).unwrap_or(source_sr);
    let samples = if source_sr == output_sr {
        mono
    } else {
        resample_mono(&mono, source_sr, output_sr)
    };
    let samples = match max_seconds {
        Some(secs) => {
            let limit = (secs * output_sr as f64) as usize;
            samples.into_iter().take(limit).collect()
        }
        None => samples,
    };

    Ok(DecodedAudio {
        samples,
        sample_rate: output_sr,
        duration,
        channels,
        source_sample_rate: source_sr,
    })
}

/// 加窗 sinc 重采样（Blackman 窗，16 taps）。
///
/// 一开始用的是线性插值，那等价于一个很钝的低通：44.1k→22.05k 时会把高频
/// 大幅衰减，起音包络的形状跟着变，BPM 的倍频判定就容易和 Python 版分道扬镳。
///
/// 采样率是整数比，分数相位会周期性重复。例如 44.1k→16k 只有 160 种相位。
/// 旧实现却为整首歌的每一个输出样本重复计算 32 次 sin/cos；四分钟就是上亿次。
/// 这里把完全相同的 Blackman-sinc 权重按采样率对预计算并复用，逐样本只剩 32 项
/// 点积。滤波器、tap 数与截止频率不变，不用降低频谱质量换速度。
const RESAMPLE_TAPS: i64 = 16;
const RESAMPLE_KERNEL_WIDTH: usize = (RESAMPLE_TAPS as usize) * 2;

struct SincKernel {
    phase_count: usize,
    /// Integer source frames advanced after every output sample.
    base_step: usize,
    /// Fractional rational phase advanced after every output sample.
    phase_step: usize,
    weights: Vec<f64>,
}

static SINC_KERNELS: OnceLock<Mutex<HashMap<(u32, u32), Arc<SincKernel>>>> = OnceLock::new();

fn greatest_common_divisor(mut left: u32, mut right: u32) -> u32 {
    while right != 0 {
        (left, right) = (right, left % right);
    }
    left.max(1)
}

fn build_sinc_kernel(from_sr: u32, to_sr: u32) -> SincKernel {
    let gcd = greatest_common_divisor(from_sr, to_sr);
    let phase_count = (to_sr / gcd) as usize;
    let cutoff = (to_sr as f64 / from_sr as f64).min(1.0);
    let mut weights = Vec::with_capacity(phase_count * RESAMPLE_KERNEL_WIDTH);

    for phase in 0..phase_count {
        let fraction = phase as f64 / phase_count as f64;
        let start = weights.len();
        let mut sum = 0.0;
        for offset in -RESAMPLE_TAPS + 1..=RESAMPLE_TAPS {
            let distance = offset as f64 - fraction;
            let x = std::f64::consts::PI * distance * cutoff;
            let sinc = if x.abs() < 1e-9 {
                cutoff
            } else {
                cutoff * x.sin() / x
            };
            let t = (distance / RESAMPLE_TAPS as f64 + 1.0) / 2.0;
            let window = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * t).cos()
                + 0.08 * (4.0 * std::f64::consts::PI * t).cos();
            let weight = sinc * window;
            weights.push(weight);
            sum += weight;
        }
        if sum.abs() > 1e-12 {
            for weight in &mut weights[start..] {
                *weight /= sum;
            }
        }
    }

    let reduced_from = (from_sr / gcd) as usize;
    SincKernel {
        phase_count,
        base_step: reduced_from / phase_count,
        phase_step: reduced_from % phase_count,
        weights,
    }
}

fn sinc_kernel(from_sr: u32, to_sr: u32) -> Arc<SincKernel> {
    let kernels = SINC_KERNELS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(kernel) = kernels
        .lock()
        .expect("sinc kernel cache")
        .get(&(from_sr, to_sr))
        .cloned()
    {
        return kernel;
    }
    let built = Arc::new(build_sinc_kernel(from_sr, to_sr));
    let mut cache = kernels.lock().expect("sinc kernel cache");
    Arc::clone(cache.entry((from_sr, to_sr)).or_insert(built))
}

/// 用同一条缓存 polyphase sinc 把 mono PCM 转到目标采样率。
///
/// 截止频率按比例收紧到新的奈奎斯特频率，避免降采样混叠。源/目标采样率约分后，
/// `base_step + phase_step` 递推的正是 `floor(i × from / to)` 及其余数；热循环不再为
/// 每个输出样本执行一次 `u128` 乘除和取模，结果仍与逐样本坐标公式一致。
/// 采样率必须非零。
pub fn resample_mono(input: &[f32], from_sr: u32, to_sr: u32) -> Vec<f32> {
    assert!(from_sr > 0 && to_sr > 0, "重采样率必须非零");
    if input.is_empty() || from_sr == to_sr {
        return input.to_vec();
    }
    let kernel = sinc_kernel(from_sr, to_sr);
    let out_len = ((input.len() as u128 * to_sr as u128) / from_sr as u128) as usize;
    let last = input.len() as i64 - 1;
    let mut output = Vec::with_capacity(out_len);
    let mut base = 0usize;
    let mut phase = 0usize;

    for _ in 0..out_len {
        let weights =
            &kernel.weights[phase * RESAMPLE_KERNEL_WIDTH..(phase + 1) * RESAMPLE_KERNEL_WIDTH];
        let first = base as i64 - RESAMPLE_TAPS + 1;
        let mut value = 0.0;
        if first >= 0 && first + RESAMPLE_KERNEL_WIDTH as i64 <= input.len() as i64 {
            for (&sample, &weight) in input[first as usize..first as usize + RESAMPLE_KERNEL_WIDTH]
                .iter()
                .zip(weights)
            {
                value += sample as f64 * weight;
            }
        } else {
            for (offset, &weight) in weights.iter().enumerate() {
                let source = (first + offset as i64).clamp(0, last) as usize;
                value += input[source] as f64 * weight;
            }
        }
        output.push(value as f32);

        base += kernel.base_step;
        phase += kernel.phase_step;
        if phase >= kernel.phase_count {
            phase -= kernel.phase_count;
            base += 1;
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference_resample(input: &[f32], from_sr: u32, to_sr: u32) -> Vec<f32> {
        if input.is_empty() || from_sr == to_sr {
            return input.to_vec();
        }
        let ratio = to_sr as f64 / from_sr as f64;
        let cutoff = ratio.min(1.0);
        let out_len = ((input.len() as f64) * ratio).floor() as usize;
        let last = input.len() as i64 - 1;
        (0..out_len)
            .map(|index| {
                let center = index as f64 / ratio;
                let base = center.floor() as i64;
                let mut value = 0.0;
                let mut weight_sum = 0.0;
                for offset in -RESAMPLE_TAPS + 1..=RESAMPLE_TAPS {
                    let source = (base + offset).clamp(0, last) as usize;
                    let distance = (base + offset) as f64 - center;
                    let x = std::f64::consts::PI * distance * cutoff;
                    let sinc = if x.abs() < 1e-9 {
                        cutoff
                    } else {
                        cutoff * x.sin() / x
                    };
                    let t = (distance / RESAMPLE_TAPS as f64 + 1.0) / 2.0;
                    let window = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * t).cos()
                        + 0.08 * (4.0 * std::f64::consts::PI * t).cos();
                    let weight = sinc * window;
                    value += input[source] as f64 * weight;
                    weight_sum += weight;
                }
                (value / weight_sum) as f32
            })
            .collect()
    }

    #[test]
    fn phase_accumulated_sinc_matches_the_original_per_sample_kernel() {
        let input: Vec<f32> = (0..10_003)
            .map(|index| {
                let time = index as f64 / 44_100.0;
                ((time * 440.0 * std::f64::consts::TAU).sin()
                    + 0.31 * (time * 3_700.0 * std::f64::consts::TAU).sin()) as f32
            })
            .collect();
        for (from_sr, to_sr) in [
            (44_100, 16_000),
            (48_000, 16_000),
            (44_100, 22_050),
            (16_000, 44_100),
        ] {
            let expected = reference_resample(&input, from_sr, to_sr);
            let actual = resample_mono(&input, from_sr, to_sr);
            assert_eq!(actual.len(), expected.len());
            let max_error = actual
                .iter()
                .zip(expected)
                .map(|(left, right)| (left - right).abs())
                .fold(0.0f32, f32::max);
            assert!(max_error < 1e-5, "{from_sr}→{to_sr} 最大误差 {max_error}");
        }
    }

    #[test]
    fn zero_container_sample_rates_fall_back_instead_of_overflowing() {
        assert_eq!(known_sample_rate(Some(0)), None);
        let rate = known_sample_rate(Some(0)).unwrap_or(DEFAULT_SR);
        let out = resample_mono(&[0.0, 1.0, 0.0], rate, DEFAULT_SR);
        assert_eq!(out, vec![0.0, 1.0, 0.0]);
    }

    #[test]
    fn resampling_halves_the_length_when_halving_the_rate() {
        let input: Vec<f32> = (0..1000).map(|i| i as f32).collect();
        let out = resample_mono(&input, 44100, 22050);
        assert!((out.len() as i64 - 500).abs() <= 1, "长度 {}", out.len());
    }

    #[test]
    fn resampling_preserves_a_ramp_shape() {
        let input: Vec<f32> = (0..200).map(|i| i as f32).collect();
        let out = resample_mono(&input, 100, 50);
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
        let out = resample_mono(&input, 44100, 22050);
        let mid = &out[1000..out.len() - 1000];
        let peak = mid.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
        assert!(peak > 0.97, "通带内峰值被压到 {peak}");
    }

    #[test]
    fn same_rate_is_a_passthrough() {
        let input: Vec<f32> = vec![1.0, 2.0, 3.0];
        assert_eq!(resample_mono(&input, 22050, 22050), input);
    }

    #[test]
    fn missing_file_reports_a_useful_error() {
        let err = decode_audio(Path::new("/definitely/not/here.mp3"), DEFAULT_SR, None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("打开音频失败"), "{err}");
    }

    fn write_silence_wav(path: &Path, sample_rate: u32, frames: u32) {
        let data_bytes = frames * 2;
        let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
        bytes.extend(b"RIFF");
        bytes.extend(&(36 + data_bytes).to_le_bytes());
        bytes.extend(b"WAVEfmt ");
        bytes.extend(&16u32.to_le_bytes());
        bytes.extend(&1u16.to_le_bytes());
        bytes.extend(&1u16.to_le_bytes());
        bytes.extend(&sample_rate.to_le_bytes());
        bytes.extend(&(sample_rate * 2).to_le_bytes());
        bytes.extend(&2u16.to_le_bytes());
        bytes.extend(&16u16.to_le_bytes());
        bytes.extend(b"data");
        bytes.extend(&data_bytes.to_le_bytes());
        bytes.resize(bytes.len() + data_bytes as usize, 0);
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn probe_duration_reads_the_header_without_decoding_pcm() {
        let path =
            std::env::temp_dir().join(format!("kdj-probe-duration-{}.wav", std::process::id()));
        write_silence_wav(&path, 22_050, 22_050 * 8);
        let duration = probe_duration(&path).unwrap().expect("wav 头应有时长");
        assert!(
            (duration - 8.0).abs() < 0.02,
            "probe 时长 {duration}，期望 8s"
        );
        let _ = std::fs::remove_file(&path);
    }
}
