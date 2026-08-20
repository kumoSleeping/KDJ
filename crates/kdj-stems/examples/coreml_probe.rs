//! CoreML EP 崩溃定位探针：分阶段打印，确认崩溃在 session 创建还是推理。

use kdj_stems::seeklab::{hstasnet_model_dir, spleeter_model_dir, LabBackend};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let model = args.get(1).map(String::as_str).unwrap_or("spleeter");
    let backend = match args.get(2).map(String::as_str) {
        Some("coreml-all") => LabBackend::CoreMlAll,
        _ => LabBackend::CoreMlGpu,
    };
    eprintln!("[probe] model={model} backend={backend:?}");
    match model {
        "spleeter" => {
            let dir = spleeter_model_dir().expect("spleeter dir");
            let path = dir.join("vocals.fp16.onnx");
            eprintln!("[probe] building session: {}", path.display());
            let session = kdj_stems::seeklab::probe_build_session(&path, backend, true);
            match session {
                Ok(_) => eprintln!("[probe] session OK"),
                Err(error) => {
                    eprintln!("[probe] session FAILED: {error:#}");
                    std::process::exit(2);
                }
            }
        }
        "hstasnet" => {
            let dir = hstasnet_model_dir().expect("hstasnet dir");
            let path = dir.join("model.onnx");
            eprintln!("[probe] building session: {}", path.display());
            let session = kdj_stems::seeklab::probe_build_session(&path, backend, false);
            match session {
                Ok(_) => eprintln!("[probe] session OK"),
                Err(error) => {
                    eprintln!("[probe] session FAILED: {error:#}");
                    std::process::exit(2);
                }
            }
        }
        other => eprintln!("unknown model {other}"),
    }
    eprintln!("[probe] done");
}
