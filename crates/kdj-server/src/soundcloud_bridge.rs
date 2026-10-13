//! Explicit, short-lived pairing with the SoundCloud-only browser extension.
//! This listener has no access to the general control API and never logs credentials.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
    Extension, Json, Router,
};
use kdj_providers::MusicProvider;
use serde::{Deserialize, Serialize};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::{
    error::{ApiError, ApiResult},
    AppState, AuthToken,
};

const TTL: Duration = Duration::from_secs(300);

#[derive(Default)]
struct PairingTask(Mutex<Option<ActivePairing>>);

struct ActivePairing {
    gate: Arc<Gate>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ActivePairing {
    fn drop(&mut self) {
        // Also revoke existing keep-alive connections when replacing the listener.
        self.gate.used.store(true, Ordering::SeqCst);
        self.task.abort();
    }
}

impl Drop for PairingTask {
    fn drop(&mut self) {
        if let Ok(task) = self.0.get_mut() {
            drop(task.take());
        }
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/accounts/soundcloud/login/extension", post(start))
        .layer(Extension(Arc::new(PairingTask::default())))
}

#[derive(Serialize)]
struct PairingCode {
    code: String,
    expires_in: u64,
}

async fn start(
    State(app): State<Arc<AppState>>,
    Extension(task): Extension<Arc<PairingTask>>,
) -> ApiResult<Json<PairingCode>> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| ApiError::bad_request("无法启动浏览器配对"))?;
    let port = listener
        .local_addr()
        .map_err(|_| ApiError::bad_request("无法读取配对端口"))?
        .port();
    let token = AuthToken::generate();
    let code = format!("KDJ-SC1:{port}:{}", token.expose());
    let gate = Arc::new(Gate {
        token,
        expires: Instant::now() + TTL,
        used: AtomicBool::new(false),
    });
    let router = Router::new()
        .route("/connect", post(connect))
        .with_state(app)
        .layer(DefaultBodyLimit::max(8192))
        .layer(middleware::from_fn_with_state(gate.clone(), authorize))
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::predicate(|origin, _| extension_origin(origin)))
                .allow_methods([Method::POST])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
        )
        .layer(middleware::from_fn(no_store));
    let mut previous = task
        .0
        .lock()
        .map_err(|_| ApiError::bad_request("配对状态不可用"))?;
    drop(previous.take());
    let task = tokio::spawn(async move {
        use std::future::IntoFuture;
        let _ = tokio::time::timeout(TTL, axum::serve(listener, router).into_future()).await;
    });
    *previous = Some(ActivePairing { gate, task });
    Ok(Json(PairingCode {
        code,
        expires_in: TTL.as_secs(),
    }))
}

struct Gate {
    token: AuthToken,
    expires: Instant,
    used: AtomicBool,
}

fn extension_origin(origin: &HeaderValue) -> bool {
    origin
        .to_str()
        .ok()
        .and_then(|origin| origin.strip_prefix("chrome-extension://"))
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|ch| (b'a'..=b'p').contains(&ch)))
}

async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn authorize(State(gate): State<Arc<Gate>>, request: Request, next: Next) -> Response {
    if request.method() != Method::POST || request.uri().path() != "/connect" {
        return StatusCode::NOT_FOUND.into_response();
    }
    if request
        .headers()
        .get(header::ORIGIN)
        .is_some_and(|origin| !extension_origin(origin))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !crate::bearer(request.headers()).is_some_and(|token| gate.token.matches(token)) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if Instant::now() >= gate.expires || gate.used.swap(true, Ordering::SeqCst) {
        return StatusCode::GONE.into_response();
    }
    next.run(request).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Session {
    access_token: String,
    expires_at: i64,
}

async fn connect(State(app): State<Arc<AppState>>, Json(session): Json<Session>) -> Response {
    // Fixed SoundCloud endpoint; no extension-supplied host or user identity is trusted.
    match tokio::time::timeout(Duration::from_secs(30), app.soundcloud.import_extension_session(session.access_token, session.expires_at)).await {
        Ok(Ok(())) => {
            let account = app.soundcloud.cached_account().await;
            app.hub.publish("account.changed", &account);
            StatusCode::NO_CONTENT.into_response()
        }
        // Do not reflect third-party error bodies that might contain a credential.
        _ => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"detail":"SoundCloud 未接受该会话，请检查网络、来源开关和浏览器登录，再生成新的配对码"}))).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    #[tokio::test]
    async fn pairing_rejects_other_origins_wrong_secrets_expiry_and_replay() {
        let token = AuthToken::generate();
        let gate = Arc::new(Gate {
            token: token.clone(),
            expires: Instant::now() + TTL,
            used: AtomicBool::new(false),
        });
        let app = Router::new()
            .route("/connect", post(|| async { StatusCode::NO_CONTENT }))
            .layer(middleware::from_fn_with_state(gate.clone(), authorize));
        for (secret, origin, expected) in [
            (
                "wrong",
                "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                StatusCode::UNAUTHORIZED,
            ),
            (
                token.expose(),
                "https://soundcloud.com",
                StatusCode::FORBIDDEN,
            ),
            (
                token.expose(),
                "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.evil",
                StatusCode::FORBIDDEN,
            ),
            (
                token.expose(),
                "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                StatusCode::NO_CONTENT,
            ),
            (
                token.expose(),
                "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                StatusCode::GONE,
            ),
        ] {
            let request = Request::builder()
                .method("POST")
                .uri("/connect")
                .header(header::ORIGIN, origin)
                .header(header::AUTHORIZATION, format!("Bearer {secret}"))
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                expected
            );
        }
        let expired = Arc::new(Gate {
            token: token.clone(),
            expires: Instant::now(),
            used: AtomicBool::new(false),
        });
        let app = Router::new()
            .route("/connect", post(|| async { StatusCode::NO_CONTENT }))
            .layer(middleware::from_fn_with_state(expired, authorize));
        let request = Request::builder()
            .method("POST")
            .uri("/connect")
            .header(header::AUTHORIZATION, format!("Bearer {}", token.expose()))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.oneshot(request).await.unwrap().status(),
            StatusCode::GONE
        );
    }
}
