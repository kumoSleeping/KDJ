//! 对拍工具：对一批文件跑 Rust 分析并输出 JSON，用于和 Python 版逐字段比对。
//! cargo run --release -p kumodeck-analysis --example golden -- <file>...
use kumodeck_analysis::engine::analyze_file;
use std::path::Path;

fn main() {
    let mut out = Vec::new();
    // 参数是"清单文件"而不是逐个路径：曲库文件名里全是空格和逗号，
    // 走 shell 展开必然被切碎。
    let list = std::env::args().nth(1).expect("用法：golden <清单文件>");
    let paths: Vec<String> = std::fs::read_to_string(&list)
        .expect("读不到清单文件")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    for arg in paths {
        let result = analyze_file(Path::new(&arg), 240.0);
        out.push(serde_json::json!({
            "path": arg,
            "duration": result.duration,
            "bpm": result.bpm,
            "bpm_raw": result.bpm_raw,
            "bpm_confidence": result.bpm_confidence,
            "first_beat": result.first_beat,
            "camelot": result.camelot,
            "key": result.key,
            "open_key": result.open_key,
            "key_confidence": result.key_confidence,
            "energy": result.energy,
            "rms_db": result.rms_db,
            "peak_db": result.peak_db,
            "beats": result.beat_times.len(),
            "errors": result.errors,
        }));
    }
    println!("{}", serde_json::to_string(&out).unwrap());
}
