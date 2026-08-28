//! 开发用的独立服务进程。
//!
//! 正式桌面版里这个服务是编进 Tauri 进程内的；这个二进制只是为了
//! 让前端 `npm run dev` 能连上真正的 Rust 后端调试。
use std::sync::Arc;

use kdj_core::AppConfig;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,kdj=debug".into()))
        .init();

    let data_dir = std::env::var("KUMODECK_DATA_DIR")
        .or_else(|_| std::env::var("KDJ_DATA_DIR"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            kdj_core::config::home_dir().join("Library/Application Support/kumodeck/data")
        });
    let download_dir = std::env::var("KUMODECK_DOWNLOAD_DIR")
        .or_else(|_| std::env::var("KDJ_DOWNLOAD_DIR"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| kdj_core::config::default_download_root());
    let port: u16 = std::env::var("KUMODECK_PORT")
        .or_else(|_| std::env::var("KDJ_PORT"))
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8788);

    let config = Arc::new(AppConfig::create(data_dir, download_dir, port));
    // 独立二进制只服务于本机 Vite 预览。默认值与 vite.rust.config.ts 对齐，
    // 需要共享调试服务时可显式设置 KDJ_AUTH_TOKEN。
    let auth_token = std::env::var("KDJ_AUTH_TOKEN").unwrap_or_else(|_| "dev-token".into());
    let (port, auth_token, handle, _control) =
        kdj_server::serve_with_token(config.clone(), auth_token).await?;

    println!("KDJ Rust 服务已启动");
    println!("  http://127.0.0.1:{port}/_kdj/{auth_token}");
    println!("  data  = {}", config.data_dir.display());
    handle.await?;
    Ok(())
}
