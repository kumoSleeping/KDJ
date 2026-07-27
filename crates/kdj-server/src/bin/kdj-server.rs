//! 开发用的独立服务进程。
//!
//! 正式桌面版里这个服务是编进 Tauri 进程内的；这个二进制只是为了
//! 让前端 `npm run dev` 能连上真正的 Rust 后端调试。
use std::sync::Arc;

use kdj_core::AppConfig;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info,kdj=debug".into()),
        )
        .init();

    let data_dir = std::env::var("KDJ_DATA_DIR")
        .or_else(|_| std::env::var("KDJ_DATA_DIR"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            kdj_core::config::home_dir()
                .join("Library/Application Support/kdj/data")
        });
    let download_dir = std::env::var("KDJ_DOWNLOAD_DIR")
        .or_else(|_| std::env::var("KDJ_DOWNLOAD_DIR"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| kdj_core::config::default_download_root());
    let port: u16 = std::env::var("KDJ_PORT")
        .or_else(|_| std::env::var("KDJ_PORT"))
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8788);

    let config = Arc::new(AppConfig::create(data_dir, download_dir, port));
    let (port, handle) = kdj_server::serve(config.clone()).await?;

    println!("KDJ Rust 服务已启动");
    println!("  http://127.0.0.1:{port}");
    println!("  data  = {}", config.data_dir.display());
    handle.await?;
    Ok(())
}
