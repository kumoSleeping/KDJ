//! 本地 HTTP + WebSocket 服务。
//!
//! 只绑 127.0.0.1。保留 HTTP 而不是全走 Tauri IPC
//! 的理由见 `docs/rust-port/00-architecture.md`：前端 `api.ts` 几乎不用动，
//! 播放器也要靠 Range 请求才能拖进度条。

pub mod aggregate;
pub mod downloads;
pub mod error;
pub mod jobs;
pub mod lyrics;
pub mod routes;
pub mod state;
pub mod stream_cache;
pub mod waveform;
pub mod ws;

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::Router;
use kdj_core::AppConfig;
use tower_http::cors::{Any, CorsLayer};

pub use state::AppState;

/// 组装完整的应用路由。
pub fn build_app(state: Arc<AppState>) -> Router {
    let settings = state.config.to_settings();
    let downloads = Arc::new(downloads::DownloadManager::new(
        state.hub.clone(),
        settings.concurrent_downloads,
        // 「开始下载」现在是一次性放行当前队列，不再持久化成未来任务自动开始。
        // 旧 settings.json 即使残留 true，也不能把新入队任务直接启动。
        false,
    ));
    let ctx = routes::Ctx {
        state: state.clone(),
        downloads,
    };

    routes::router(ctx)
        .route("/ws", axum::routing::get(ws::handler))
        // 服务只监听 127.0.0.1；开放 CORS 让 Tauri WebView 和本机浏览器调试都能直连。
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any)
                .expose_headers([
                    axum::http::header::CONTENT_RANGE,
                    axum::http::header::ACCEPT_RANGES,
                    axum::http::header::CONTENT_LENGTH,
                ]),
        )
        .with_state(state)
}

/// 起服务，返回实际监听的端口（传 0 时由系统分配）。
pub async fn serve(config: Arc<AppConfig>) -> Result<(u16, tokio::task::JoinHandle<()>)> {
    let state = AppState::new(config.clone())?;
    let app = build_app(state);

    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port))
        .await
        .with_context(|| format!("绑定 {}:{} 失败", config.host, config.port))?;
    let port = listener.local_addr()?.port();

    let handle = tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            tracing::error!("HTTP 服务退出：{err}");
        }
    });
    Ok((port, handle))
}
