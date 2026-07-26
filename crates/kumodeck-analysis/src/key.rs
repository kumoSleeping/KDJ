//! 调性识别：chroma → Krumhansl-Schmuckler → 24 调 → Camelot / OpenKey。

use crate::dsp::{self, median, rfft_freqs};

/// 调性只关心频率分辨率，时间分辨率无所谓：tempo 用的 2048 在 180 Hz 以下
/// 已经宽过一个半音，低音区会整片糊掉，所以这里窗加到 4096（bin 宽 5.4 Hz）。
const N_FFT: usize = 4096;
const HOP: usize = 1024;
/// C2 ~ C7。低于 C2 基本是底鼓/低频噪声，高于 C7 是镲片噪声，都会污染 chroma。
const FMIN: f64 = 65.4;
const FMAX: f64 = 2093.0;
/// 谐波抑制：沿时间的中值滤波长度（帧）
const HARMONIC_MEDIAN: usize = 17;

/// Krumhansl-Schmuckler 模板（索引 0 = 主音）
const MAJOR_PROFILE: [f64; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE: [f64; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

/// 音级 → 显示名。大小调用同一张表（G#/Ab minor 取 Ab，C#/Db minor 取 Db）。
const NAMES: [&str; 12] = [
    "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
];

/// Camelot 轮盘。索引 = 音级（C=0 … B=11），`.0` 是小调、`.1` 是大调。
const CAMELOT: [(&str, &str); 12] = [
    ("5A", "8B"),   // C
    ("12A", "3B"),  // Db
    ("7A", "10B"),  // D
    ("2A", "5B"),   // Eb
    ("9A", "12B"),  // E
    ("4A", "7B"),   // F
    ("11A", "2B"),  // F#
    ("6A", "9B"),   // G
    ("1A", "4B"),   // Ab
    ("8A", "11B"),  // A
    ("3A", "6B"),   // Bb
    ("10A", "1B"),  // B
];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct KeyResult {
    pub key: String,
    pub key_short: String,
    pub camelot: String,
    pub open_key: String,
    pub confidence: f64,
    pub chroma: Vec<f64>,
}

/// Camelot → OpenKey。
///
/// 两套轮盘只差一个固定旋转量 7：Camelot 的 8B 是 C 大调、OpenKey 的 1d 也是 C 大调，
/// 所以 `open = ((n - 8) mod 12) + 1`；字母 A→m（小调）、B→d（大调）。
pub fn camelot_to_open_key(camelot: &str) -> String {
    if camelot.len() < 2 {
        return String::new();
    }
    let (number_part, letter) = camelot.split_at(camelot.len() - 1);
    let letter = letter.to_ascii_uppercase();
    let Ok(number) = number_part.parse::<i32>() else {
        return String::new();
    };
    if !(1..=12).contains(&number) || (letter != "A" && letter != "B") {
        return String::new();
    }
    let open_number = (number - 8).rem_euclid(12) + 1;
    format!("{open_number}{}", if letter == "A" { "m" } else { "d" })
}

/// 沿时间做中值滤波：谐波成分保留、瞬态打击成分被压掉。
fn median_filter_time(spec: &mut dsp::Spectrogram, size: usize) {
    if size <= 1 || spec.frames < size {
        return;
    }
    let pad = size / 2;
    let mut window = vec![0.0f64; size];
    let mut row_out = vec![0.0f32; spec.frames];
    for bin in 0..spec.bins {
        for frame in 0..spec.frames {
            for (slot, offset) in window.iter_mut().zip(0..size) {
                // edge 复制补齐
                let index = (frame + offset).saturating_sub(pad).min(spec.frames - 1);
                *slot = spec.at(bin, index) as f64;
            }
            row_out[frame] = median(&mut window) as f32;
        }
        spec.data[bin * spec.frames..(bin + 1) * spec.frames].copy_from_slice(&row_out);
    }
}

/// `(12, n_selected)` 的映射矩阵 + 选中的 bin 下标。
///
/// 每个 bin 按 `midi = 69 + 12*log2(f/440)` 折算到连续音高，用三角权重摊到相邻两个半音，
/// 比"四舍五入到最近半音"平滑，能吃掉一点音准偏差和频率量化误差。
pub fn chroma_weights(sr: f64, n_fft: usize) -> (Vec<[f32; 12]>, Vec<usize>) {
    let freqs = rfft_freqs(n_fft, sr);
    let selected: Vec<usize> = freqs
        .iter()
        .enumerate()
        .filter(|(_, f)| **f >= FMIN && **f <= FMAX)
        .map(|(i, _)| i)
        .collect();

    let weights = selected
        .iter()
        .map(|index| {
            let mut column = [0.0f32; 12];
            let midi = 69.0 + 12.0 * (freqs[*index] / 440.0).log2();
            let low = midi.floor();
            let frac = midi - low;
            let low_class = (low as i64).rem_euclid(12) as usize;
            let high_class = (low as i64 + 1).rem_euclid(12) as usize;
            column[low_class] += (1.0 - frac) as f32;
            column[high_class] += frac as f32;
            column
        })
        .collect();
    (weights, selected)
}

/// 12 维 chroma（已归一到最大值 1）。
pub fn compute_chroma(samples: &[f32], sr: f64) -> Vec<f64> {
    if samples.len() < N_FFT {
        return vec![0.0; 12];
    }
    let peak = samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
    let normalized: Vec<f32> = if peak > 0.0 {
        samples.iter().map(|s| s / peak).collect()
    } else {
        samples.to_vec()
    };

    let full = dsp::stft_magnitude(&normalized, N_FFT, HOP);
    let (weights, selected) = chroma_weights(sr, N_FFT);
    if selected.is_empty() || full.frames == 0 {
        return vec![0.0; 12];
    }
    // 只留选中的 bin，后续中值滤波和矩阵乘都在这个小得多的谱上做
    let mut spec = dsp::Spectrogram {
        bins: selected.len(),
        frames: full.frames,
        data: vec![0.0f32; selected.len() * full.frames],
    };
    for (row, bin) in selected.iter().enumerate() {
        let src = &full.data[bin * full.frames..(bin + 1) * full.frames];
        spec.data[row * full.frames..(row + 1) * full.frames].copy_from_slice(src);
    }
    median_filter_time(&mut spec, HARMONIC_MEDIAN);

    // 每帧 L2 归一（抵消音量起伏），再沿时间取中位数（比均值抗鼓点/瞬态干扰）
    let mut per_class: Vec<Vec<f64>> = vec![Vec::with_capacity(spec.frames); 12];
    for frame in 0..spec.frames {
        let mut acc = [0.0f64; 12];
        for (row, column) in weights.iter().enumerate() {
            let value = spec.at(row, frame) as f64;
            for class in 0..12 {
                acc[class] += column[class] as f64 * value;
            }
        }
        let norm = acc.iter().map(|v| v * v).sum::<f64>().sqrt();
        let norm = if norm > 0.0 { norm } else { 1.0 };
        for class in 0..12 {
            per_class[class].push(acc[class] / norm);
        }
    }

    let mut chroma: Vec<f64> = per_class.iter_mut().map(|values| median(values)).collect();
    let top = chroma.iter().cloned().fold(0.0f64, f64::max);
    if top > 0.0 {
        for value in chroma.iter_mut() {
            *value /= top;
        }
    }
    chroma
}

fn pearson(a: &[f64], b: &[f64]) -> f64 {
    let mean_a = a.iter().sum::<f64>() / a.len() as f64;
    let mean_b = b.iter().sum::<f64>() / b.len() as f64;
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for (x, y) in a.iter().zip(b) {
        let dx = x - mean_a;
        let dy = y - mean_b;
        dot += dx * dy;
        norm_a += dx * dx;
        norm_b += dy * dy;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom <= 0.0 {
        0.0
    } else {
        dot / denom
    }
}

/// `np.roll(profile, tonic)`：把模板的主音位置搬到 tonic 音级上。
fn roll(profile: &[f64; 12], tonic: usize) -> [f64; 12] {
    let mut out = [0.0f64; 12];
    for i in 0..12 {
        out[(i + tonic) % 12] = profile[i];
    }
    out
}

/// 对 24 个候选调（12 音级 × 大小调）求皮尔逊相关，取最大。
pub fn key_from_chroma(chroma: &[f64]) -> KeyResult {
    if chroma.len() != 12 || chroma.iter().fold(0.0f64, |acc, v| acc.max(v.abs())) <= 0.0 {
        return KeyResult {
            chroma: vec![0.0; 12],
            ..Default::default()
        };
    }
    let mut scores: Vec<(f64, usize, bool)> = Vec::with_capacity(24);
    for tonic in 0..12 {
        scores.push((pearson(chroma, &roll(&MAJOR_PROFILE, tonic)), tonic, false));
        scores.push((pearson(chroma, &roll(&MINOR_PROFILE, tonic)), tonic, true));
    }
    scores.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let (best_score, tonic, is_minor) = scores[0];
    let second = scores[1].0;
    let confidence = ((best_score - second) / (best_score.abs() + 1e-9)).clamp(0.0, 1.0);

    let name = NAMES[tonic];
    let camelot = if is_minor {
        CAMELOT[tonic].0
    } else {
        CAMELOT[tonic].1
    };
    KeyResult {
        key: format!("{name} {}", if is_minor { "minor" } else { "major" }),
        key_short: if is_minor {
            format!("{name}m")
        } else {
            name.to_string()
        },
        camelot: camelot.to_string(),
        open_key: camelot_to_open_key(camelot),
        confidence: (confidence * 1000.0).round() / 1000.0,
        chroma: chroma
            .iter()
            .map(|v| (v * 10_000.0).round() / 10_000.0)
            .collect(),
    }
}

pub fn analyze_key(samples: &[f32], sr: f64) -> KeyResult {
    key_from_chroma(&compute_chroma(samples, sr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camelot_table_matches_the_contract() {
        // 逐条对照契约 3.3 的表格
        assert_eq!(CAMELOT[8].0, "1A", "Ab minor");
        assert_eq!(CAMELOT[0].0, "5A", "C minor");
        assert_eq!(CAMELOT[9].0, "8A", "A minor");
        assert_eq!(CAMELOT[0].1, "8B", "C major");
        assert_eq!(CAMELOT[11].1, "1B", "B major");
        assert_eq!(CAMELOT[4].1, "12B", "E major");
    }

    #[test]
    fn every_camelot_slot_is_used_exactly_once() {
        // 打错一个格子就会让和声推荐把两首毫无关系的歌配到一起
        let mut seen: Vec<String> = CAMELOT
            .iter()
            .flat_map(|(minor, major)| [minor.to_string(), major.to_string()])
            .collect();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 24, "24 个格子必须互不重复");
    }

    #[test]
    fn open_key_conversion_matches_the_worked_examples() {
        // 注释里的两个校验例子
        assert_eq!(camelot_to_open_key("1A"), "6m");
        assert_eq!(camelot_to_open_key("6B"), "11d");
        // C 大调 8B → 1d，A 小调 8A → 1m
        assert_eq!(camelot_to_open_key("8B"), "1d");
        assert_eq!(camelot_to_open_key("8A"), "1m");
    }

    #[test]
    fn open_key_rejects_malformed_input() {
        assert_eq!(camelot_to_open_key(""), "");
        assert_eq!(camelot_to_open_key("13A"), "");
        assert_eq!(camelot_to_open_key("0A"), "");
        assert_eq!(camelot_to_open_key("8C"), "");
        assert_eq!(camelot_to_open_key("xA"), "");
    }

    #[test]
    fn a_pure_profile_recovers_its_own_key() {
        // 把 C 大调模板本身当 chroma 喂进去，必须得到 C major
        let chroma: Vec<f64> = MAJOR_PROFILE.to_vec();
        let got = key_from_chroma(&chroma);
        assert_eq!(got.key, "C major");
        assert_eq!(got.camelot, "8B");
        assert_eq!(got.open_key, "1d");

        // 移到 D 上就应该是 D major
        let shifted: Vec<f64> = roll(&MAJOR_PROFILE, 2).to_vec();
        let got = key_from_chroma(&shifted);
        assert_eq!(got.key, "D major");
        assert_eq!(got.camelot, "10B");
    }

    #[test]
    fn minor_profiles_are_not_confused_with_their_relative_major() {
        // A 小调和 C 大调用的是同一组音，靠模板权重区分，最容易出错的一对
        let chroma: Vec<f64> = roll(&MINOR_PROFILE, 9).to_vec();
        let got = key_from_chroma(&chroma);
        assert_eq!(got.key, "A minor");
        assert_eq!(got.camelot, "8A");
    }

    #[test]
    fn silence_yields_no_key_rather_than_a_wrong_one() {
        let got = key_from_chroma(&vec![0.0; 12]);
        assert_eq!(got.key, "");
        assert_eq!(got.camelot, "");
        assert_eq!(got.confidence, 0.0);
    }

    #[test]
    fn chroma_of_a_pure_tone_lands_on_that_pitch_class() {
        // 440 Hz = A4 → 音级 9
        let sr = 22050.0;
        let samples: Vec<f32> = (0..sr as usize * 2)
            .map(|i| (2.0 * std::f64::consts::PI * 440.0 * i as f64 / sr).sin() as f32)
            .collect();
        let chroma = compute_chroma(&samples, sr);
        let (peak_class, _) = chroma
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap();
        assert_eq!(peak_class, 9, "chroma = {chroma:?}");
    }

    #[test]
    fn short_input_returns_zeros_instead_of_panicking() {
        assert_eq!(compute_chroma(&[0.1; 100], 22050.0), vec![0.0; 12]);
    }
}
