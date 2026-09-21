//! Isolated full-stack acceptance server. Never opens the production library.
//! Usage: visualizer_studio_acceptance /new/test/directory /test/audio.wav
use anyhow::{Context, Result, ensure};
use kdj_core::AppConfig;
use kdj_server::{AppState, AuthToken, MediaToken};
use std::{path::PathBuf, sync::Arc, io::Write};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(args.len() == 2, "usage: visualizer_studio_acceptance /new/test/directory /test/audio.wav");
    let directory = PathBuf::from(&args[0]);
    ensure!(directory.is_absolute() && !directory.exists(), "测试目录必须是尚不存在的绝对路径");
    std::fs::create_dir(&directory)?;
    let audio = PathBuf::from(&args[1]).canonicalize()?;
    let downloads = directory.join("outputs");
    std::fs::create_dir(&downloads)?;
    let config = Arc::new(AppConfig::create(directory.join("data"), downloads.clone(), 0));
    let state = AppState::new(config)?;
    let track_id = state.library.upsert_file(&audio, "local", "")?;
    let track = state.library.get(track_id)?.context("测试曲目未入库")?;
    let control = AuthToken::generate();
    let media = MediaToken::generate();
    let app = kdj_server::build_app(state, control.clone(), media.clone())?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let mut options = std::fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(directory.join("bridge.json"))?;
    file.write_all(&serde_json::to_vec(&serde_json::json!({
        "baseUrl": format!("http://127.0.0.1:{port}"), "authToken": control.expose(), "mediaToken": media.expose(),
        "platform": "darwin", "track": track, "directory": downloads,
    }))?)?;
    file.sync_all()?;
    println!("isolated acceptance server ready on loopback port {port}");
    axum::serve(listener, app).with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; }).await?;
    Ok(())
}
