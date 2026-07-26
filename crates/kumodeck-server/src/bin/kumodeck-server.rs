//! 开发用的独立服务进程。
//!
//! 正式桌面版里这个服务是编进 Tauri 进程内的；这个二进制只是为了
//! 让前端 `npm run dev` 能连上真正的 Rust 后端调试。
use std::sync::Arc;

use kumodeck_core::AppConfig;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info,kumodeck=debug".into()),
        )
        .init();

    let data_dir = std::env::var("KUMODECK_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            kumodeck_core::config::home_dir()
                .join("Library/Application Support/kumodeck/data")
        });
    let download_dir = std::env::var("KUMODECK_DOWNLOAD_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| kumodeck_core::config::home_dir().join("Downloads/KumoDeck"));
    // 开发时固定 token 和端口，省得每次改前端配置
    let token = std::env::var("KUMODECK_TOKEN").unwrap_or_else(|_| "dev-token".into());
    let port: u16 = std::env::var("KUMODECK_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8788);

    let config = Arc::new(AppConfig::create(data_dir, download_dir, token.clone(), port));
    let (port, handle) = kumodeck_server::serve(config.clone()).await?;

    println!("KumoDeck sidecar (Rust) 已启动");
    println!("  http://127.0.0.1:{port}");
    println!("  token = {token}");
    println!("  data  = {}", config.data_dir.display());
    handle.await?;
    Ok(())
}
