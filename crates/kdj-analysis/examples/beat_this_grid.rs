//! Beat This + DJ Grid Fitter 试验入口。
//!
//! cargo run --release -p kdj-analysis --features beat-this \
//!   --example beat_this_grid -- <mel.onnx> <beat.onnx> <audio-file>

#[cfg(all(
    feature = "beat-this",
    not(any(target_os = "android", target_os = "ios"))
))]
fn main() -> anyhow::Result<()> {
    use std::path::Path;

    use kdj_analysis::beat_this_backend::BeatThisAnalyzer;

    let mut args = std::env::args().skip(1);
    let mel = args.next().expect("缺少 mel.onnx 路径");
    let beat = args.next().expect("缺少 beat.onnx 路径");
    let audio = args.next().expect("缺少音频路径");

    let mut analyzer = BeatThisAnalyzer::new(Path::new(&mel), Path::new(&beat))?;
    let result = analyzer.analyze_file(Path::new(&audio))?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

#[cfg(not(all(
    feature = "beat-this",
    not(any(target_os = "android", target_os = "ios"))
)))]
fn main() {
    eprintln!("此入口仅支持桌面端，请增加 --features beat-this");
    std::process::exit(2);
}
