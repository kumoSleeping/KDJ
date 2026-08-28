//! 本地 HTTP + WebSocket 服务。
//!
//! 只绑 127.0.0.1。保留 HTTP 而不是全走 Tauri IPC
//! 的理由见 `docs/rust-port/00-architecture.md`：前端 `api.ts` 几乎不用动，
//! 播放器也要靠 Range 请求才能拖进度条。

pub mod aggregate;
mod auth;
pub mod downloads;
pub mod error;
pub mod jobs;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod library_watch;
pub mod lyrics;
#[cfg(all(
    feature = "onelibrary",
    not(any(target_os = "android", target_os = "ios"))
))]
mod one_library_analysis;
pub mod protected_media;
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
use axum::http::{header, HeaderValue, Method};
use axum::middleware;
use axum::Router;
use kdj_core::AppConfig;
use tower_http::cors::{AllowOrigin, CorsLayer};

pub use state::AppState;

/// 组装完整的应用路由。所有端点都挂在一次性 capability 路径下；
/// `<audio>/<video>`、普通 fetch、WebSocket 与 CLI 因而共享同一套鉴权。
pub fn build_app(state: Arc<AppState>, auth_token: &str) -> Router {
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

    let protected = routes::router(ctx)
        .route(
            "/api/stems/runtime",
            axum::routing::get(stems::runtime_status),
        )
        .route(
            "/api/stems/runtime/reset",
            axum::routing::post(stems::reset_runtime),
        )
        .route(
            "/api/tracks/{id}/stems",
            axum::routing::get(stems::track_status),
        )
        .route("/ws", axum::routing::get(ws::handler))
        .with_state(state);
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| allowed_origin(origin)))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::ACCEPT,
            header::CACHE_CONTROL,
            header::CONTENT_TYPE,
            header::IF_MATCH,
            header::IF_MODIFIED_SINCE,
            header::IF_NONE_MATCH,
            header::IF_RANGE,
            header::RANGE,
            axum::http::HeaderName::from_static("x-kdj-sabr-url"),
        ])
        .expose_headers([
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
            header::CONTENT_LENGTH,
            axum::http::HeaderName::from_static("x-kdj-waveform-profile"),
            axum::http::HeaderName::from_static("x-kdj-waveform-revision"),
        ]);
    let capability = auth::Capability::new(auth_token)
        .expect("serve/build_app 必须传入合法的本地 API capability");
    Router::new()
        .nest(&capability.mount_path(), protected)
        // 后加的 CORS 在最外层，鉴权失败也会返回正确的跨域错误响应。
        .layer(middleware::from_fn_with_state(
            capability,
            auth::require_capability,
        ))
        .layer(cors)
}

fn allowed_origin(origin: &HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    if cfg!(debug_assertions) {
        return matches!(
            origin,
            "http://localhost:5274"
                | "http://127.0.0.1:5274"
                | "https://localhost:5274"
                | "https://127.0.0.1:5274"
        ) || origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"))
            .is_some_and(|authority| authority.ends_with(":5274") && !authority.contains('/'));
    }
    false
}

/// 起服务，返回实际监听的端口（传 0 时由系统分配）。
pub async fn serve(
    config: Arc<AppConfig>,
) -> Result<(
    u16,
    String,
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::UnboundedReceiver<state::UiControl>,
)> {
    serve_with_token(config, auth::random_token()).await
}

/// 仅供独立开发 server 注入与 Vite 一致的 token；正式 Tauri 启动必须调用 `serve`。
pub async fn serve_with_token(
    config: Arc<AppConfig>,
    auth_token: String,
) -> Result<(
    u16,
    String,
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::UnboundedReceiver<state::UiControl>,
)> {
    auth::Capability::new(&auth_token)
        .map_err(anyhow::Error::msg)
        .context("本地 API capability 无效")?;
    let (state, control_rx) = AppState::new_with_control(config.clone())?;
    // 先挂监听再起 HTTP：这样 WebView 启动期间发生的文件变化也不会漏掉。
    // 首轮补扫会等 WebSocket 连好再做，避免刷新事件发在前端订阅之前。
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    library_watch::spawn(state.clone());
    let app = build_app(state, &auth_token);

    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port))
        .await
        .with_context(|| format!("绑定 {}:{} 失败", config.host, config.port))?;
    let port = listener.local_addr()?.port();

    let handle = tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            tracing::error!("HTTP 服务退出：{err}");
        }
    });
    Ok((port, auth_token, handle, control_rx))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_origins_are_narrow() {
        assert!(allowed_origin(&HeaderValue::from_static(
            "tauri://localhost"
        )));
        assert!(!allowed_origin(&HeaderValue::from_static(
            "https://evil.example"
        )));
    }
}
