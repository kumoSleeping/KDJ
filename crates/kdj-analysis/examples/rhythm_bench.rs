//! Repeatable V4 timing/accuracy probe; synthesized fixtures are removed on every exit path.
use std::{io::Write, path::PathBuf, time::Instant};
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let precise = args.iter().any(|s| s == "--precise");
    let mut temp = None;
    let path = if let Some(path) = args.iter().find(|s| !s.starts_with("--")) {
        PathBuf::from(path)
    } else {
        let path =
            std::env::temp_dir().join(format!("kdj-rhythm-bench-{}.wav", std::process::id()));
        temp = Some(Temporary(path.clone()));
        let seconds = 300;
        let sr = 22050u32;
        let samples = sr * seconds;
        let bytes = samples * 2;
        let mut file = std::io::BufWriter::new(std::fs::File::create(&path)?);
        file.write_all(b"RIFF")?;
        file.write_all(&(bytes + 36).to_le_bytes())?;
        file.write_all(b"WAVEfmt ")?;
        file.write_all(&16u32.to_le_bytes())?;
        file.write_all(&1u16.to_le_bytes())?;
        file.write_all(&1u16.to_le_bytes())?;
        file.write_all(&sr.to_le_bytes())?;
        file.write_all(&(sr * 2).to_le_bytes())?;
        file.write_all(&2u16.to_le_bytes())?;
        file.write_all(&16u16.to_le_bytes())?;
        file.write_all(b"data")?;
        file.write_all(&bytes.to_le_bytes())?;
        for n in 0..samples {
            let t = n as f64 / sr as f64;
            let age = (t - 0.13).rem_euclid(60. / 127.93);
            let signal = if t >= 0.13 && age < 0.045 {
                (-age * 100.).exp() * (std::f64::consts::TAU * 100. * age).sin() * 0.8
            } else {
                0.
            };
            file.write_all(&((signal * 32767.) as i16).to_le_bytes())?;
        }
        file.flush()?;
        path
    };
    let started = Instant::now();
    let result = kdj_analysis::rhythm::analyze(&path, precise, &|| false)?.unwrap();
    let elapsed = started.elapsed().as_millis();
    let evaluation = if let Some(path) = args.iter().find_map(|s| s.strip_prefix("--truth=")) {
        let truth: Truth = serde_json::from_slice(&std::fs::read(path)?)?;
        Some(evaluate(&result, &truth))
    } else {
        None
    };
    let errors: Vec<_> = result
        .beats
        .iter()
        .map(|&t| {
            let phase = (t - 0.13).rem_euclid(60. / 127.93);
            phase.min(60. / 127.93 - phase)
        })
        .collect();
    let mut sorted = errors.clone();
    sorted.sort_by(f64::total_cmp);
    println!(
        "{}",
        serde_json::json!({"seconds":result.duration,"elapsed_ms":elapsed,"evaluation":evaluation,"bpm":result.bpm,"beats":result.beats.len(),"segments":result.segments.len(),"precise":precise,"synthetic_phase_p95_ms":if temp.is_some()&&!sorted.is_empty(){Some(sorted[(sorted.len() as f64*0.95)as usize]*1000.)}else{None}})
    );
    drop(temp);
    Ok(())
}

#[derive(serde::Deserialize)]
struct Truth {
    beats: Vec<f64>,
    #[serde(default)]
    downbeats: Vec<f64>,
    segments: Vec<TruthSegment>,
}
#[derive(serde::Deserialize)]
struct TruthSegment {
    start_seconds: f64,
    end_seconds: f64,
    bpm: f64,
}
fn events(predicted: &[f64], truth: &[f64], tolerance: f64) -> serde_json::Value {
    let (mut p, mut t) = (0, 0);
    let mut errors = Vec::new();
    while p < predicted.len() && t < truth.len() {
        let delta = predicted[p] - truth[t];
        if delta.abs() <= tolerance {
            errors.push(delta);
            p += 1;
            t += 1;
        } else if delta < 0. {
            p += 1;
        } else {
            t += 1;
        }
    }
    let count = errors.len();
    let drift = errors
        .last()
        .zip(errors.first())
        .map(|(a, b)| (a - b) * 1000.);
    let mut absolute: Vec<_> = errors.iter().map(|v| v.abs()).collect();
    absolute.sort_by(f64::total_cmp);
    serde_json::json!({"predicted":predicted.len(),"annotated":truth.len(),"matched":count,
        "precision":count as f64/predicted.len().max(1)as f64,"recall":count as f64/truth.len().max(1)as f64,
        "f1":2.*count as f64/(predicted.len()+truth.len()).max(1)as f64,
        "matched_p95_ms":absolute.get(((count.saturating_sub(1))as f64*0.95)as usize).map(|t|t*1000.),
        "first_to_last_drift_ms":drift,"tolerance_ms":tolerance*1000.})
}
fn evaluate(result: &kdj_analysis::rhythm::RhythmAnalysis, truth: &Truth) -> serde_json::Value {
    let total = truth
        .segments
        .iter()
        .map(|s| s.end_seconds - s.start_seconds)
        .sum::<f64>();
    let mut correct = 0.;
    for a in &truth.segments {
        for b in &result.segments {
            if (a.bpm - b.bpm).abs() <= 0.1 {
                correct += (a.end_seconds.min(b.end_seconds)
                    - a.start_seconds.max(b.start_seconds))
                .max(0.);
            }
        }
    }
    let predicted: Vec<_> = result
        .segments
        .iter()
        .skip(1)
        .map(|s| s.start_seconds)
        .collect();
    let boundaries: Vec<_> = truth
        .segments
        .iter()
        .skip(1)
        .map(|s| s.start_seconds)
        .collect();
    serde_json::json!({"bpm_correct_duration_ratio":correct/total.max(1e-9),"bpm_tolerance":0.1,"octave_tolerance":false,
        "beats":events(&result.beats,&truth.beats,0.07),"downbeats":events(&result.downbeats,&truth.downbeats,0.07),
        "boundaries":events(&predicted,&boundaries,0.5)})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn octave_errors_are_not_accepted_as_correct() {
        let truth = Truth {
            beats: vec![0., 0.5, 1., 1.5],
            downbeats: vec![0.],
            segments: vec![TruthSegment {
                start_seconds: 0.,
                end_seconds: 2.,
                bpm: 120.,
            }],
        };
        let result = kdj_analysis::rhythm::RhythmAnalysis {
            beats: vec![0., 1.],
            segments: vec![kdj_analysis::rhythm::Segment {
                start_seconds: 0.,
                end_seconds: 2.,
                bpm: 60.,
                confidence: 1.,
            }],
            ..Default::default()
        };
        let score = evaluate(&result, &truth);
        assert_eq!(score["bpm_correct_duration_ratio"], 0.);
        assert_eq!(score["beats"]["recall"], 0.5);
        assert_eq!(score["downbeats"]["f1"], 0.);
    }
}
