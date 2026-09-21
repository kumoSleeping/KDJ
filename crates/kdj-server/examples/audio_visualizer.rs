//! Development acceptance entry; not a second application runtime.
//! cargo run -p kdj-server --example audio_visualizer -- request.json
//! cargo run -p kdj-server --example audio_visualizer -- --demo /absolute/new.mp4 [software]
use anyhow::{Context, Result, ensure};
use kdj_core::{audio_visualizer::Scene, composition::EncodingAcceleration};
use kdj_server::compositions::audio_visualizer::{ExportRequest, export};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU32, Ordering},
};
use tokio_util::sync::CancellationToken;

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn demo(output: &Path, software: bool) -> Result<(ExportRequest, Scratch)> {
    let path = std::env::temp_dir().join(format!(
        "kdj-visualizer-demo-{:016x}",
        rand::random::<u64>()
    ));
    std::fs::create_dir(&path)?;
    let scratch = Scratch(path);
    let cover = scratch.0.join("cover.png");
    image::RgbaImage::from_fn(960, 960, |x, y| {
        let dx = x as f64 - 480.;
        let dy = y as f64 - 480.;
        let r = (dx * dx + dy * dy).sqrt();
        if x < 35 || y < 35 || x > 925 || y > 925 {
            image::Rgba([0, 0, 0, 255])
        } else if ((r / 45.) as u32) % 2 == 0 {
            image::Rgba([
                (40 + x / 6).min(255) as u8,
                (60 + y / 6).min(255) as u8,
                210,
                255,
            ])
        } else {
            image::Rgba([
                210,
                (80 + x / 9).min(255) as u8,
                (40 + y / 8).min(255) as u8,
                if x > 600 && y < 360 { 120 } else { 255 },
            ])
        }
    })
    .save(&cover)?;
    let audio = scratch.0.join("audio.wav");
    let sr = 44100u32;
    let frames = sr * 8;
    let bytes = frames * 4;
    let mut file = std::io::BufWriter::new(std::fs::File::create(&audio)?);
    file.write_all(b"RIFF")?;
    file.write_all(&(36 + bytes).to_le_bytes())?;
    file.write_all(b"WAVEfmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&2u16.to_le_bytes())?;
    file.write_all(&sr.to_le_bytes())?;
    file.write_all(&(sr * 4).to_le_bytes())?;
    file.write_all(&4u16.to_le_bytes())?;
    file.write_all(&16u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&bytes.to_le_bytes())?;
    for index in 0..frames {
        let t = index as f64 / sr as f64;
        let beat = (t * 2.).fract();
        let pulse = (-beat * 12.).exp();
        let bass = (std::f64::consts::TAU * 80. * t).sin() * pulse * 0.32;
        let melody = (std::f64::consts::TAU * (220. * t + 55. * t * t)).sin() * 0.11;
        let fade = t.min(1.).min((8. - t).max(0.));
        let value = ((bass + melody) * fade * 32767.) as i16;
        file.write_all(&value.to_le_bytes())?;
        file.write_all(&value.to_le_bytes())?;
    }
    file.flush()?;
    drop(file);
    let mut scene = Scene::with_image(cover.to_string_lossy().into_owned());
    scene.right.mirror_x = true;
    scene.right.zoom = 1.35;
    let request = ExportRequest {
        scene,
        audio_path: audio.to_string_lossy().into_owned(),
        output_path: output.to_string_lossy().into_owned(),
        acceleration: if software {
            EncodingAcceleration::Software
        } else {
            EncodingAcceleration::Auto
        },
    };
    Ok((request, scratch))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(
        !args.is_empty(),
        "usage: audio_visualizer request.json | --demo /absolute/new.mp4 [software]"
    );
    if args[0] == "--features" {
        let input = args.get(1).context("缺少场景请求文件")?;
        let output = args.get(2).context("缺少时间序列输出文件")?;
        let request: ExportRequest = serde_json::from_slice(&std::fs::read(input)?)?;
        request.scene.validate().map_err(anyhow::Error::msg)?;
        let timeline = kdj_analysis::visualizer::analyze(
            Path::new(&request.audio_path),
            &request.scene.spectrum,
            &|| false,
        )?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)?;
        serde_json::to_writer(&mut file, &timeline)?;
        file.sync_all()?;
        return Ok(());
    }
    if args[0] == "--prepare-demo" {
        let directory = Path::new(args.get(1).context("缺少验收目录")?);
        ensure!(directory.is_absolute(), "验收目录需要绝对路径");
        std::fs::create_dir(directory).context("验收目录必须是尚不存在的新目录")?;
        let (mut request, scratch) = demo(&directory.join("render.mp4"), true)?;
        std::fs::copy(&request.audio_path, directory.join("audio.wav"))?;
        std::fs::copy(&request.scene.images[0], directory.join("cover.png"))?;
        request.audio_path = directory.join("audio.wav").to_string_lossy().into_owned();
        request.scene.images[0] = directory.join("cover.png").to_string_lossy().into_owned();
        let timeline = kdj_analysis::visualizer::analyze(
            Path::new(&request.audio_path),
            &request.scene.spectrum,
            &|| false,
        )?;
        std::fs::write(
            directory.join("request.json"),
            serde_json::to_vec_pretty(&request)?,
        )?;
        std::fs::write(
            directory.join("features.json"),
            serde_json::to_vec(&timeline)?,
        )?;
        drop(scratch);
        return Ok(());
    }
    let (request, _scratch) = if args[0] == "--demo" {
        let output = Path::new(args.get(1).context("缺少 MP4 输出路径")?);
        let (request, scratch) = demo(output, args.get(2).is_some_and(|s| s == "software"))?;
        (request, Some(scratch))
    } else {
        let bytes = std::fs::read(&args[0])?;
        (serde_json::from_slice::<ExportRequest>(&bytes)?, None)
    };
    let cancel = CancellationToken::new();
    let last = AtomicU32::new(u32::MAX);
    let run = export(
        &request,
        &cancel,
        |value| {
            let percent = (value * 100.) as u32;
            if last.swap(percent, Ordering::Relaxed) != percent {
                eprintln!("progress={percent}%");
            }
        },
        |message| eprintln!("status={message}"),
    );
    tokio::pin!(run);
    let result = tokio::select! {
        result = &mut run => result,
        _ = tokio::signal::ctrl_c() => { cancel.cancel(); run.await },
    }?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
