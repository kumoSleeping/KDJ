//! SeekLab 批量基准：随机跳转 → 即时输出 + 渐进精修的类 Neural Mix 调度实验。
//!
//! 用法：
//! ```bash
//! cargo run -p kdj-stems --release --example seeklab_bench -- \
//!   --track "流行:/path/a.mp3" --track "EDM:/path/b.mp3" \
//!   --seeks 30,60,50% --backends cpu,coreml-gpu \
//!   --out research/stems/results/m2-seeklab-<date>.json
//! ```

use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result};
use kdj_stems::seeklab::{
    lab_catalog, LabBackend, LabPcm, SeekLab, SeekTrialOptions, SeekTrialReport,
};
use serde::Serialize;

#[derive(Serialize)]
struct BenchTrack {
    label: String,
    path: String,
    duration_seconds: f64,
    decode_ms: f64,
}

#[derive(Serialize)]
struct BenchOutput {
    captured_at: String,
    machine: MachineInfo,
    catalog: serde_json::Value,
    tracks: Vec<BenchTrack>,
    trials: Vec<TrialEntry>,
}

#[derive(Serialize)]
struct MachineInfo {
    chip: String,
    os: String,
    cores: usize,
}

#[derive(Serialize)]
struct TrialEntry {
    track: String,
    report: SeekTrialReport,
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut tracks: Vec<(String, PathBuf)> = Vec::new();
    let mut seeks = vec![30.0_f64, 60.0, -1.0]; // -1 = 50%
    let mut backends = vec![LabBackend::Cpu, LabBackend::CoreMlGpu];
    let mut out: Option<PathBuf> = None;
    let mut quick = false;

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--track" => {
                let value = args.get(index + 1).context("--track 需要 label:path")?;
                let (label, path) = value
                    .split_once(':')
                    .map(|(label, path)| {
                        // Windows 盘符兼容：label 后必须跟 / 开头路径。
                        if path.starts_with('/') {
                            (label.to_string(), PathBuf::from(path))
                        } else {
                            (String::new(), PathBuf::from(value))
                        }
                    })
                    .unwrap_or_else(|| (String::new(), PathBuf::from(value)));
                tracks.push((label, path));
                index += 2;
            }
            "--seeks" => {
                let value = args.get(index + 1).context("--seeks 需要逗号列表")?;
                // 负值表示时长比例（如 50% → -0.5）。
                seeks = value
                    .split(',')
                    .map(|item| {
                        let item = item.trim();
                        if let Some(percent) = item.strip_suffix('%') {
                            -percent.parse::<f64>().unwrap_or(50.0) / 100.0
                        } else {
                            item.parse::<f64>().unwrap_or(30.0)
                        }
                    })
                    .collect();
                index += 2;
            }
            "--backends" => {
                let value = args.get(index + 1).context("--backends 需要逗号列表")?;
                backends = value
                    .split(',')
                    .map(|item| match item.trim() {
                        "cpu" => LabBackend::Cpu,
                        "coreml-gpu" => LabBackend::CoreMlGpu,
                        "coreml-all" => LabBackend::CoreMlAll,
                        other => panic!("未知 backend：{other}"),
                    })
                    .collect();
                index += 2;
            }
            "--out" => {
                out = Some(PathBuf::from(args.get(index + 1).context("--out 需要路径")?));
                index += 2;
            }
            "--quick" => {
                quick = true;
                index += 1;
            }
            other => anyhow::bail!("未知参数：{other}"),
        }
    }
    if tracks.is_empty() {
        anyhow::bail!("至少提供一个 --track label:path");
    }

    let catalog = lab_catalog();
    println!("== SeekLab 模型目录 ==");
    println!(
        "  HS-TasNet: {} ({})",
        catalog.hstasnet.ready,
        catalog.hstasnet.path.clone().unwrap_or_default()
    );
    println!(
        "  Spleeter4: {} ({})",
        catalog.spleeter4.ready,
        catalog.spleeter4.path.clone().unwrap_or_default()
    );
    if !catalog.hstasnet.ready || !catalog.spleeter4.ready {
        anyhow::bail!("模型未就绪，无法运行基准");
    }
    let spleeter_dir = PathBuf::from(catalog.spleeter4.path.clone().unwrap());
    let hstasnet_dir = PathBuf::from(catalog.hstasnet.path.clone().unwrap());

    // 每个 backend 一套常驻 session，跨曲目/跳转复用（模拟真实 DJ 软件常驻模型）。
    let mut labs = backends
        .iter()
        .map(|backend| (*backend, SeekLab::new(*backend, &spleeter_dir, &hstasnet_dir)))
        .collect::<Vec<_>>();

    let options = SeekTrialOptions {
        instant_repeats: Some(if quick { 3 } else { 7 }),
        stream_steps: Some(if quick { 16 } else { 48 }),
        ..SeekTrialOptions::default()
    };

    let mut bench_tracks = Vec::new();
    let mut trials = Vec::new();

    for (label, path) in &tracks {
        let decode_start = Instant::now();
        let pcm = LabPcm::decode(path).with_context(|| format!("解码失败：{}", path.display()))?;
        let decode_ms = decode_start.elapsed().as_secs_f64() * 1_000.0;
        let duration = pcm.duration_seconds();
        let label = if label.is_empty() {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "track".into())
        } else {
            label.clone()
        };
        println!("\n== {label} ({duration:.1}s, 解码 {decode_ms:.0}ms) ==");
        bench_tracks.push(BenchTrack {
            label: label.clone(),
            path: path.display().to_string(),
            duration_seconds: duration,
            decode_ms,
        });

        // 跳转位置：30s / 60s / 50%，并保证完整 tile 可容纳。
        let max_seek = (duration - 8.0).max(1.0);
        let seek_points: Vec<f64> = seeks
            .iter()
            .map(|seek| {
                if *seek < 0.0 {
                    (duration * (-seek)).min(max_seek)
                } else {
                    seek.min(max_seek)
                }
            })
            .map(|seek| seek.max(5.0))
            .collect();

        for (backend, lab) in &mut labs {
            for &seek_seconds in &seek_points {
                let seek_frame = (seek_seconds * kdj_stems::SAMPLE_RATE as f64) as usize;
                print!("  [{backend:?}] seek {seek_seconds:.1}s … ");
                let started = Instant::now();
                match lab.run_trial(&pcm, seek_frame, &options) {
                    Ok(mut outcome) => {
                        outcome.report.source = path.display().to_string();
                        let schedule = &outcome.report.schedule;
                        println!(
                            "首输出 {:.1}ms · 流式 p95 {:.1}ms · 精修 {:.0}ms · 替换余量 {:.0}ms · 总耗时 {:.1}s",
                            schedule.first_output_ms,
                            schedule.stream_step_p95_ms,
                            schedule.refined_tile_wall_ms,
                            schedule.replace_margin_ms,
                            started.elapsed().as_secs_f64()
                        );
                        trials.push(TrialEntry {
                            track: label.clone(),
                            report: outcome.report,
                        });
                    }
                    Err(error) => {
                        println!("失败：{error:#}");
                        eprintln!("trial error ({label} {seek_seconds}s {backend:?}): {error:#}");
                    }
                }
            }
        }
    }

    let output = BenchOutput {
        captured_at: iso_now(),
        machine: MachineInfo {
            chip: sysctl("machdep.cpu.brand_string"),
            os: format!("{} {}", std::env::consts::OS, sysctl("kern.osproductversion")),
            cores: std::thread::available_parallelism()
                .map(|cores| cores.get())
                .unwrap_or(0),
        },
        catalog: serde_json::to_value(&catalog)?,
        tracks: bench_tracks,
        trials,
    };
    let json = serde_json::to_string_pretty(&output)?;
    if let Some(out) = out {
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&out, &json).with_context(|| format!("写入结果失败：{}", out.display()))?;
        println!("\n结果已写入 {}", out.display());
    } else {
        println!("\n{json}");
    }
    Ok(())
}

fn sysctl(key: &str) -> String {
    std::process::Command::new("sysctl")
        .args(["-n", key])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let secs_of_day = secs % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        secs_of_day / 3_600,
        (secs_of_day % 3_600) / 60,
        secs_of_day % 60
    )
}

fn civil_from_days(days: i64) -> (i64, u64, u64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = (days - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}
