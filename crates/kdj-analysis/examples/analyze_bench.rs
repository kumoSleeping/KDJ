//! 分析耗时与窗长对比。
//!
//! cargo run --release -p kdj-analysis --example analyze_bench -- <audio>...

use std::path::Path;
use std::time::Instant;

use kdj_analysis::decode::{decode_audio, decode_audio_from, DEFAULT_SR};
use kdj_analysis::engine::{analysis_window, analyze_file, analyze_samples};
use kdj_analysis::key::analyze_key;
use kdj_analysis::loudness::analyze_loudness;
use kdj_analysis::tempo::analyze_tempo;

const LIMITS: [f64; 5] = [45.0, 60.0, 90.0, 120.0, 240.0];

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("用法：analyze_bench <audio-file>...");
        std::process::exit(2);
    }

    for path in paths {
        bench_one(Path::new(&path));
    }
}

fn bench_one(path: &Path) {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("?");
    println!("\n=== {name} ===");

    let t0 = Instant::now();
    let probe = decode_audio(path, DEFAULT_SR, Some(0.05));
    let probe_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let duration = probe.ok().and_then(|audio| audio.duration);
    println!("probe_0.05s  {probe_ms:7.0} ms  duration={:.1?}", duration);

    let t0 = Instant::now();
    let full = analyze_file(path, 240.0);
    let full_ms = t0.elapsed().as_secs_f64() * 1000.0;
    println!(
        "analyze_240  {full_ms:7.0} ms  bpm={:?}  {}  energy={:?}",
        full.bpm, full.camelot, full.energy
    );

    let (offset, max_seconds) = analysis_window(duration, 240.0);
    let t0 = Instant::now();
    let decoded = match decode_audio_from(path, DEFAULT_SR, max_seconds, offset) {
        Ok(decoded) => decoded,
        Err(err) => {
            println!("decode failed: {err}");
            return;
        }
    };
    let decode_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let decoded_s = decoded.samples.len() as f64 / decoded.sample_rate as f64;
    let sr = decoded.sample_rate as f64;
    println!(
        "decode_240   {decode_ms:7.0} ms  audio={decoded_s:.1}s  offset={offset:.1}s  sr={}",
        decoded.sample_rate
    );

    let t0 = Instant::now();
    let _tempo = analyze_tempo(&decoded.samples, sr);
    let tempo_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let t0 = Instant::now();
    let _key = analyze_key(&decoded.samples, sr);
    let key_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let t0 = Instant::now();
    let _loud = analyze_loudness(&decoded.samples);
    let loud_ms = t0.elapsed().as_secs_f64() * 1000.0;
    println!("  tempo {tempo_ms:7.0} ms  key {key_ms:7.0} ms  loud {loud_ms:5.0} ms");

    println!("window    ms   bpm           camelot  vs240");
    for limit in LIMITS {
        let n = ((limit * sr) as usize).min(decoded.samples.len());
        let slice = &decoded.samples[..n];
        let t0 = Instant::now();
        let result = analyze_samples(slice, sr, offset);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let bpm_ok = bpm_close(full.bpm, result.bpm);
        let key_ok = full.camelot == result.camelot;
        let mark = match (bpm_ok, key_ok) {
            (true, true) => "ok",
            (true, false) => "key!",
            (false, true) => "bpm!",
            (false, false) => "both!",
        };
        println!(
            "{limit:5.0}s {ms:7.0}  {:>8} {:>8}  {mark}",
            fmt_bpm(result.bpm),
            result.camelot
        );
    }
}

fn fmt_bpm(bpm: Option<f64>) -> String {
    bpm.map(|value| format!("{value:.2}"))
        .unwrap_or_else(|| "-".into())
}

fn bpm_close(left: Option<f64>, right: Option<f64>) -> bool {
    match (left, right) {
        (Some(a), Some(b)) => {
            let ratio = (a / b).max(b / a);
            (a - b).abs() < 0.8 || (ratio - 2.0).abs() < 0.04 || (ratio - 1.5).abs() < 0.04
        }
        (None, None) => true,
        _ => false,
    }
}
