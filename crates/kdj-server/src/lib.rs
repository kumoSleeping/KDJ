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
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod one_library_analysis;
pub mod routes;
pub mod state;
pub mod stems;
pub mod stream_cache;
pub mod stream_waveform;
pub mod usb_library;
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

    let router = routes::router(ctx)
        .route("/api/stems/model", axum::routing::get(stems::model_status))
        .route(
            "/api/stems/runtime",
            axum::routing::post(stems::activate_runtime),
        )
        .route(
            "/api/stems/model/download",
            axum::routing::post(stems::download_model),
        )
        .route(
            "/api/stems/debug/model",
            axum::routing::get(stems::debug_model_status),
        )
        .route(
            "/api/stems/debug",
            axum::routing::post(stems::debug_separate),
        )
        .route(
            "/api/stems/debug/{session}",
            axum::routing::delete(stems::debug_release),
        )
        .route(
            "/api/stems/debug/{session}/{lane}",
            axum::routing::get(stems::debug_audio),
        );
    // SeekLab 依赖平台 ONNX 后端，仅在 macOS / Windows / Android 提供。
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
    let router = router
        .route(
            "/api/stems/lab/catalog",
            axum::routing::get(stems::lab_catalog),
        )
        .route("/api/stems/lab/seek", axum::routing::post(stems::lab_seek))
        .route(
            "/api/stems/lab/{session}/{name}",
            axum::routing::get(stems::lab_audio),
        )
        .route(
            "/api/stems/lab/{session}",
            axum::routing::delete(stems::lab_release),
        );
    router
        .route(
            "/api/tracks/{id}/stems",
            axum::routing::get(stems::track_status)
                .post(stems::separate_track)
                .delete(stems::release_track),
        )
        .route(
            "/api/tracks/{id}/stems/waveform/{stem}",
            axum::routing::get(stems::stem_waveform),
        )
        .route(
            "/api/tracks/{id}/stems/waveform",
            axum::routing::get(stems::live_stem_waveform),
        )
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
