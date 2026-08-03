//! 聚焦 BPM 与 Key 的命令行入口。
//!
//! cargo run --release -p kdj-analysis --example bpm_key -- <audio-file>...

use std::path::Path;

use kdj_analysis::engine::analyze_file;

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("用法：bpm_key <audio-file>...");
        std::process::exit(2);
    }

    let results: Vec<_> = paths
        .into_iter()
        .map(|path| {
            let result = analyze_file(Path::new(&path), 240.0);
            serde_json::json!({
                "path": path,
                "duration": result.duration,
                "bpm": result.bpm,
                "bpm_raw": result.bpm_raw,
                "bpm_confidence": result.bpm_confidence,
                "first_beat": result.first_beat,
                "beat_times": result.beat_times,
                "key": result.key,
                "key_short": result.key_short,
                "camelot": result.camelot,
                "open_key": result.open_key,
                "key_confidence": result.key_confidence,
                "chroma": result.chroma,
                "errors": result.errors,
            })
        })
        .collect();

    println!("{}", serde_json::to_string_pretty(&results).unwrap());
}
