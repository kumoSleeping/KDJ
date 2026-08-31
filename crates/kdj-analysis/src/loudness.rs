//! 响度：RMS / 峰值 / 波峰因数 / 1–10 能量分级。

/// 数字静音的下限，避免 log10(0) 得 -inf
const FLOOR: f64 = 1e-10;
/// 能量分级的两端锚点：-30 dBFS → 1，-6 dBFS → 10
const ENERGY_MIN_DB: f64 = -30.0;
const ENERGY_MAX_DB: f64 = -6.0;

#[derive(Debug, Clone, PartialEq)]
pub struct LoudnessResult {
    pub rms_db: f64,
    pub peak_db: f64,
    pub crest_db: f64,
    pub energy: i64,
}

/// RMS dBFS → 1..10 线性分档并夹取。
pub fn energy_from_rms_db(rms_db: f64) -> i64 {
    let span = ENERGY_MAX_DB - ENERGY_MIN_DB;
    let ratio = (rms_db - ENERGY_MIN_DB) / span;
    let value = (1.0 + ratio * 9.0).round() as i64;
    value.clamp(1, 10)
}

/// numpy 的 `round` 是 banker's rounding，Rust 的 `f64::round` 是 half-away-from-zero。
/// 这里只在小数点后两位上用，差异不会影响 energy 分档（分档另有 round 且已夹取）。
fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub fn analyze_loudness(samples: &[f32]) -> LoudnessResult {
    analyze_loudness_cancellable(samples, &|| false).expect("不可取消的响度分析不应提前退出")
}

pub fn analyze_loudness_cancellable(
    samples: &[f32],
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<LoudnessResult> {
    if cancelled() {
        return None;
    }
    if samples.is_empty() {
        let floor_db = 20.0 * FLOOR.log10();
        return Some(LoudnessResult {
            rms_db: floor_db,
            peak_db: floor_db,
            crest_db: 0.0,
            energy: 1,
        });
    }
    let mut sum_sq = 0.0f64;
    let mut peak = 0.0f64;
    for (index, sample) in samples.iter().enumerate() {
        if index % 16_384 == 0 && cancelled() {
            return None;
        }
        let value = *sample as f64;
        sum_sq += value * value;
        peak = peak.max(value.abs());
    }
    let rms = (sum_sq / samples.len() as f64).sqrt();
    let rms_db = 20.0 * rms.max(FLOOR).log10();
    let peak_db = 20.0 * peak.max(FLOOR).log10();
    if cancelled() {
        return None;
    }
    Some(LoudnessResult {
        rms_db: round2(rms_db),
        peak_db: round2(peak_db),
        crest_db: round2(peak_db - rms_db),
        energy: energy_from_rms_db(rms_db),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_scale_sine_reads_about_minus_three_db() {
        let sr = 22050.0;
        let samples: Vec<f32> = (0..22050)
            .map(|i| (2.0 * std::f64::consts::PI * 440.0 * i as f64 / sr).sin() as f32)
            .collect();
        let got = analyze_loudness(&samples);
        // 满幅正弦的 RMS 是 1/√2 → -3.01 dBFS
        assert!((got.rms_db + 3.01).abs() < 0.05, "{}", got.rms_db);
        assert!((got.peak_db - 0.0).abs() < 0.05, "{}", got.peak_db);
        assert!((got.crest_db - 3.01).abs() < 0.05, "{}", got.crest_db);
    }

    #[test]
    fn energy_anchors_match_the_contract() {
        // 契约：-30 dBFS → 1，-6 dBFS → 10
        assert_eq!(energy_from_rms_db(-30.0), 1);
        assert_eq!(energy_from_rms_db(-6.0), 10);
        assert_eq!(energy_from_rms_db(-18.0), 6, "中点");
    }

    #[test]
    fn energy_is_clamped_outside_the_anchors() {
        assert_eq!(energy_from_rms_db(-90.0), 1);
        assert_eq!(energy_from_rms_db(0.0), 10);
    }

    #[test]
    fn silence_does_not_produce_negative_infinity() {
        let got = analyze_loudness(&[0.0; 1024]);
        assert!(got.rms_db.is_finite(), "{}", got.rms_db);
        assert_eq!(got.rms_db, -200.0);
        assert_eq!(got.energy, 1);
    }

    #[test]
    fn empty_input_is_treated_as_silence() {
        let got = analyze_loudness(&[]);
        assert_eq!(got.energy, 1);
        assert_eq!(got.crest_db, 0.0);
    }
}
