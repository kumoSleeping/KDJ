//! 本地 HTTP + WebSocket 服务。
//!
//! 只绑 127.0.0.1。保留 HTTP 而不是全走 Tauri IPC
//! 的理由见 `docs/rust-port/00-architecture.md`：前端 `api.ts` 几乎不用动，
//! 播放器也要靠 Range 请求才能拖进度条。

pub mod activity_log;
pub mod aggregate;
pub mod cache_overview;
pub mod downloads;
pub mod error;
pub mod jobs;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod library_watch;
pub mod lyrics;
pub mod protected_media;
pub mod routes;
pub mod state;
pub mod stream_cache;
pub mod stream_waveform;
pub mod waveform;
pub mod ws;
pub mod youtube_hls;

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json, Router};
use kdj_core::AppConfig;
use serde_json::json;
use subtle::ConstantTimeEq as _;
use tower_http::cors::{AllowOrigin, CorsLayer};

pub use state::AppState;

/// 每次启动重新生成的本机控制面凭证。不要为它派生 `Debug`/`Serialize`，避免误入日志。
#[derive(Clone)]
pub struct AuthToken(Arc<str>);

impl AuthToken {
    pub fn generate() -> Self {
        // `rand::random` 使用线程级密码学安全 RNG；四段 u64 合计 256 bit。
        Self(Arc::from(format!(
            "{:016x}{:016x}{:016x}{:016x}",
            rand::random::<u64>(),
            rand::random::<u64>(),
            rand::random::<u64>(),
            rand::random::<u64>()
        )))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    fn matches(&self, candidate: &str) -> bool {
        candidate.len() == self.0.len() && bool::from(self.0.as_bytes().ct_eq(candidate.as_bytes()))
    }
}

/// 只允许读取显式媒体端点的独立 capability。即使媒体 URL 被复制或进入诊断信息，
/// 也不能升级成 settings/accounts/delete 等控制面权限。
#[derive(Clone)]
pub struct MediaToken(Arc<str>);

impl MediaToken {
    pub fn generate() -> Self {
        Self(AuthToken::generate().0)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    fn matches(&self, candidate: &str) -> bool {
        candidate.len() == self.0.len() && bool::from(self.0.as_bytes().ct_eq(candidate.as_bytes()))
    }
}

#[derive(Clone)]
struct AuthState {
    control: AuthToken,
    media: MediaToken,
}

const TAURI_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];
const DEV_ORIGINS: [&str; 2] = ["http://localhost:5274", "http://127.0.0.1:5274"];

pub(crate) fn origin_allowed(origin: &HeaderValue) -> bool {
    origin.to_str().ok().is_some_and(|value| {
        TAURI_ORIGINS.contains(&value) || (cfg!(debug_assertions) && DEV_ORIGINS.contains(&value))
    })
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, credential) = value.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer") && !credential.is_empty()).then_some(credential)
}

fn media_query_token(request: &Request<Body>) -> Option<&str> {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return None;
    }
    request.uri().query()?.split('&').find_map(|part| {
        let (name, value) = part.split_once('=')?;
        (name == "kdj_media_token").then_some(value)
    })
}

fn media_path_allowed(path: &str) -> bool {
    if path == "/api/video/preview" {
        return true;
    }
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    matches!(
        segments.as_slice(),
        ["api", "library", "audio", id]
            | ["api", "library", "video", id]
            | ["api", "library", "cover", id]
            if !id.is_empty()
    ) || matches!(
        segments.as_slice(),
        ["api", "song", "preview", ticket] if !ticket.is_empty()
    ) || matches!(
        segments.as_slice(),
        ["api", "video", "youtube", "hls", ticket] if !ticket.is_empty()
    )
}

fn request_authorized(request: &Request<Body>, auth: &AuthState) -> bool {
    if bearer(request.headers()).is_some_and(|candidate| auth.control.matches(candidate)) {
        return true;
    }
    media_path_allowed(request.uri().path())
        && media_query_token(request).is_some_and(|candidate| auth.media.matches(candidate))
}

async fn require_auth(
    State(auth): State<AuthState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    // CORS 的预检本身不携带 Authorization；精确 Origin 由外层 CorsLayer 判定。
    if request.method() == Method::OPTIONS {
        return next.run(request).await;
    }
    // WebSocket 的浏览器 API 不能设置 Authorization；ws::handler 会在 upgrade 前同时
    // 校验 Origin 和 Sec-WebSocket-Protocol 中的凭证。
    if request.uri().path() == "/ws" {
        return next.run(request).await;
    }
    if request
        .headers()
        .get(header::ORIGIN)
        .is_some_and(|origin| !origin_allowed(origin))
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "detail": "请求来源不受信任" })),
        )
            .into_response();
    }
    if !request_authorized(&request, &auth) {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer realm=\"kdj-local\"")],
            Json(json!({ "detail": "本地服务认证失败" })),
        )
            .into_response();
    }
    next.run(request).await
}

const ACTIVITY_RECORDED_HEADER: &str = "x-kdj-activity-recorded";

fn http_activity(
    method: &Method,
    path: &str,
) -> Option<(
    activity_log::ActivityCategory,
    &'static str,
    &'static str,
    bool,
)> {
    use activity_log::ActivityCategory::{Analysis, Network, User};
    let route = path.strip_prefix("/api").unwrap_or(path);
    let network = |action, target| Some((Network, action, target, false));
    let user = |action| Some((User, action, "", false));
    let analysis = |action| Some((Analysis, action, "", true));

    match (method, route) {
        (&Method::POST, "/search") => network("搜索 API", "已启用音乐平台"),
        (&Method::POST, "/search/collection") => network("集合展开 API", "音乐平台"),
        (&Method::POST, "/search/cover") => network("在线封面 API", "音乐平台图片服务"),
        (&Method::POST, "/lyrics") => network("歌词 API", "音乐平台"),
        (&Method::POST, "/resolve") => network("链接解析 API", "音乐平台"),
        (&Method::POST, "/intake") => network("批量检索 API", "音乐平台"),
        (&Method::POST, "/downloads") => network("下载 API", "音乐平台"),
        (&Method::POST, "/downloads/start") => network("启动下载 API", "音乐平台"),
        (&Method::POST, "/video/download") => network("视频下载 API", "视频平台"),
        (&Method::POST, "/video/resolve") => network("视频解析 API", "视频平台"),
        (&Method::POST, "/video/calibrate") => network("视频校准 API", "bilibili.com"),
        (&Method::POST, "/song/preview") => network("在线预览 API", "音乐平台"),
        (&Method::POST, "/song/preview/ytm/sabr/spools") => {
            network("在线预览 API", "music.youtube.com")
        }
        (&Method::POST, "/video/youtube/hls/begin") => network("视频在线播放 API", "youtube.com"),
        (&Method::GET, "/accounts") => network("账号状态 API", "已连接音乐平台"),
        (&Method::GET, "/update/check") => network("更新检查 API", "github.com"),
        (&Method::POST, "/library/tracks/delete") => user("批量删除本地曲目"),
        (&Method::POST, "/library/scan") => user("扫描本地曲库"),
        (&Method::DELETE, "/song/cache") => user("清理在线媒体缓存"),
        _ if method == Method::POST && route.starts_with("/accounts/") => {
            network("账号 API", "音乐平台")
        }
        _ if method == Method::GET && route.starts_with("/stream/playlists/") => {
            network("在线歌单 API", "音乐平台")
        }
        _ if method == Method::POST && route == "/stream/playlist" => {
            network("在线歌单内容 API", "音乐平台")
        }
        _ if method == Method::POST && route == "/stream/playlist/remove-track" => {
            network("在线歌单移除 API", "音乐平台")
        }
        _ if method == Method::POST
            && route.starts_with("/downloads/")
            && route.ends_with("/retry") =>
        {
            network("重试下载 API", "音乐平台")
        }
        _ if route.starts_with("/library/analyze")
            || route.starts_with("/library/duplicates/analyze")
            || route.starts_with("/library/waveforms/upgrade")
            || route.starts_with("/library/waveform/") =>
        {
            analysis("分析请求异常")
        }
        _ if method == Method::DELETE && route.starts_with("/library/tracks/") => {
            user("删除本地曲目")
        }
        _ if method == Method::PATCH && route.starts_with("/library/tracks/") => {
            user("修改本地曲目信息")
        }
        _ if method == Method::PUT && route.starts_with("/library/cover/") => user("更换本地封面"),
        _ if method == Method::PUT && route.starts_with("/library/lyrics/") => user("保存本地歌词"),
        _ if method == Method::POST
            && route.starts_with("/library/tracks/")
            && (route.ends_with("/write-tags") || route.ends_with("/reread-tags")) =>
        {
            user(if route.ends_with("/write-tags") {
                "写入本地文件标签"
            } else {
                "重读本地文件标签"
            })
        }
        _ if method == Method::POST && route.starts_with("/library/folders/") => {
            let action = route.trim_start_matches("/library/folders/");
            match action {
                "create" => user("创建本地文件夹"),
                "rename" => user("重命名本地文件夹"),
                "delete" => user("删除本地文件夹"),
                "forget" => user("从曲库移出文件夹"),
                "init" => user("初始化本地文件夹"),
                "upgrade" => user("升级文件夹元数据"),
                "move" => user("移动本地文件夹"),
                "merge" => user("合并本地文件夹"),
                "order" => user("调整本地文件夹顺序"),
                "undo" => user("撤回本地文件操作"),
                "apply" => user("复制或移动本地文件"),
                _ => None,
            }
        }
        _ if method == Method::DELETE
            && matches!(
                route,
                "/cache/media" | "/cache/waveform" | "/cache/lyrics" | "/cache/basic"
            ) =>
        {
            user("清理本地存储")
        }
        _ if method == Method::POST
            && route.ends_with("/cancel")
            && route.starts_with("/downloads/") =>
        {
            user("取消下载任务")
        }
        _ if method == Method::DELETE && route.starts_with("/downloads/") => user("移除下载记录"),
        (&Method::POST, "/downloads/cancel-all") => user("取消全部下载任务"),
        (&Method::POST, "/downloads/clear") => user("清理下载记录"),
        _ => None,
    }
}

async fn record_activity_requests(
    State(state): State<Arc<AppState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if request.headers().contains_key(ACTIVITY_RECORDED_HEADER) {
        return next.run(request).await;
    }
    let activity = http_activity(request.method(), request.uri().path());
    let started = std::time::Instant::now();
    let response = next.run(request).await;
    let Some((category, action, target, only_failures)) = activity else {
        return response;
    };
    let status = response.status();
    if only_failures && status.is_success() {
        return response;
    }
    let level = if status == StatusCode::TOO_MANY_REQUESTS {
        activity_log::ActivityLevel::Warn
    } else if status.is_success() {
        activity_log::ActivityLevel::Info
    } else {
        activity_log::ActivityLevel::Error
    };
    state.activity_log.record(activity_log::ActivityLogDraft {
        category,
        level,
        action: action.into(),
        detail: String::new(),
        target: target.into(),
        status: Some(status.as_u16()),
        duration_ms: Some(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)),
        count: 1,
    });
    response
}

/// 组装完整的应用路由。
pub fn build_app(state: Arc<AppState>, control: AuthToken, media: MediaToken) -> Result<Router> {
    let settings = state.config.to_settings();
    let downloads = Arc::new(downloads::DownloadManager::open(
        state.hub.clone(),
        settings.concurrent_downloads,
        // 「开始下载」现在是一次性放行当前队列，不再持久化成未来任务自动开始。
        // 旧 settings.json 即使残留 true，也不能把新入队任务直接启动。
        false,
        state.config.data_dir.join("download-queue.json"),
    )?);
    let ctx = routes::Ctx {
        state: state.clone(),
        downloads,
    };

    let auth = AuthState {
        control: control.clone(),
        media: media.clone(),
    };
    let router = routes::router(ctx)
        .route("/ws", axum::routing::get(ws::handler))
        .layer(Extension(control))
        .layer(Extension(media))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            record_activity_requests,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
        // 只允许 Tauri 资产 origin 和仓库固定的 Vite 开发 origin。loopback 不是认证边界，
        // 所有实际请求仍必须通过上面的 bearer/capability 校验。
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::predicate(|origin, _| origin_allowed(origin)))
                .allow_methods([
                    Method::GET,
                    Method::HEAD,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                ])
                .allow_headers([
                    header::ACCEPT,
                    header::AUTHORIZATION,
                    header::CACHE_CONTROL,
                    header::CONTENT_TYPE,
                    axum::http::HeaderName::from_static(ACTIVITY_RECORDED_HEADER),
                    header::IF_MODIFIED_SINCE,
                    header::IF_NONE_MATCH,
                    header::RANGE,
                    // The SABR worker never talks to Google directly. It identifies the already
                    // validated upstream endpoint to this loopback proxy with one opaque header.
                    axum::http::HeaderName::from_static("x-kdj-sabr-url"),
                ])
                .expose_headers([
                    axum::http::header::CONTENT_RANGE,
                    axum::http::header::ACCEPT_RANGES,
                    axum::http::header::CONTENT_LENGTH,
                    axum::http::HeaderName::from_static("x-kdj-media-codec"),
                    axum::http::HeaderName::from_static("x-kdj-media-init-range"),
                    axum::http::HeaderName::from_static("x-kdj-media-index-range"),
                    axum::http::HeaderName::from_static("x-kdj-media-duration-ms"),
                    axum::http::HeaderName::from_static("x-kdj-waveform-profile"),
                    axum::http::HeaderName::from_static("x-kdj-waveform-revision"),
                ]),
        )
        .with_state(state);
    Ok(router)
}

/// 起服务，返回实际监听的端口（传 0 时由系统分配）。
pub async fn serve(
    config: Arc<AppConfig>,
) -> Result<(
    u16,
    AuthToken,
    MediaToken,
    activity_log::ActivityLog,
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::UnboundedReceiver<state::UiControl>,
)> {
    let (state, control_rx) = AppState::new_with_control(config.clone())?;
    // 先挂监听再起 HTTP：这样 WebView 启动期间发生的文件变化也不会漏掉。
    // 首轮补扫会等 WebSocket 连好再做，避免刷新事件发在前端订阅之前。
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    library_watch::spawn(state.clone());
    let control = AuthToken::generate();
    let media = MediaToken::generate();
    let activity_log = state.activity_log.clone();
    let app = build_app(state, control.clone(), media.clone())?;

    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port))
        .await
        .with_context(|| format!("绑定 {}:{} 失败", config.host, config.port))?;
    let port = listener.local_addr()?.port();

    let handle = tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            tracing::error!("HTTP 服务退出：{err}");
        }
    });
    Ok((port, control, media, activity_log, handle, control_rx))
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    use tower::ServiceExt as _;

    fn request(method: Method, uri: &str, authorization: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(value) = authorization {
            builder = builder.header(header::AUTHORIZATION, value);
        }
        builder.body(Body::empty()).unwrap()
    }

    #[test]
    fn bearer_and_media_capability_have_separate_scopes() {
        let auth = AuthState {
            control: AuthToken(Arc::from("control-token")),
            media: MediaToken(Arc::from("media-token")),
        };
        assert!(request_authorized(
            &request(Method::POST, "/api/settings", Some("Bearer control-token")),
            &auth
        ));
        assert!(request_authorized(
            &request(
                Method::GET,
                "/api/library/audio/1?kdj_media_token=media-token",
                None
            ),
            &auth
        ));
        assert!(request_authorized(
            &request(
                Method::GET,
                "/api/video/youtube/hls/opaque-ticket?kdj_media_token=media-token",
                None
            ),
            &auth
        ));
        assert!(!request_authorized(
            &request(
                Method::GET,
                "/api/settings?kdj_media_token=media-token",
                None
            ),
            &auth
        ));
        assert!(!request_authorized(
            &request(
                Method::GET,
                "/api/song/preview/ticket/waveform?kdj_media_token=media-token",
                None
            ),
            &auth
        ));
        assert!(!request_authorized(
            &request(Method::GET, "/api/health", Some("Bearer media-token")),
            &auth
        ));
    }

    #[test]
    fn origins_are_an_exact_allowlist() {
        assert!(origin_allowed(&HeaderValue::from_static(
            "tauri://localhost"
        )));
        assert!(origin_allowed(&HeaderValue::from_static(
            "http://localhost:5274"
        )));
        assert!(!origin_allowed(&HeaderValue::from_static(
            "https://evil.example"
        )));
        assert!(!origin_allowed(&HeaderValue::from_static("null")));
    }

    #[test]
    fn generated_token_has_256_bits_of_hex_material() {
        let token = AuthToken::generate();
        assert_eq!(token.expose().len(), 64);
        assert!(token.expose().bytes().all(|byte| byte.is_ascii_hexdigit()));
        let media = MediaToken::generate();
        assert_eq!(media.expose().len(), 64);
        assert_ne!(token.expose(), media.expose());
    }

    #[test]
    fn activity_routes_capture_semantics_without_interface_or_analysis_noise() {
        let search = http_activity(&Method::POST, "/api/search").unwrap();
        assert_eq!(search.0, activity_log::ActivityCategory::Network);
        assert_eq!(search.1, "搜索 API");
        assert!(!search.3);

        let analysis = http_activity(&Method::POST, "/api/library/analyze").unwrap();
        assert_eq!(analysis.0, activity_log::ActivityCategory::Analysis);
        assert!(analysis.3);

        let local = http_activity(&Method::POST, "/api/library/folders/apply").unwrap();
        assert_eq!(local.0, activity_log::ActivityCategory::User);
        assert_eq!(local.1, "复制或移动本地文件");

        assert!(http_activity(&Method::GET, "/api/settings").is_none());
        assert!(http_activity(&Method::PUT, "/api/settings").is_none());
        assert!(http_activity(&Method::GET, "/api/activity/logs").is_none());
        assert!(http_activity(&Method::GET, "/api/accounts/qqm/login/qr/session-id").is_none());
    }

    #[tokio::test]
    async fn router_rejects_missing_or_untrusted_credentials_and_hides_paths() {
        let root = std::env::temp_dir().join(format!(
            "kdj-auth-router-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let config = Arc::new(AppConfig::create(
            root.join("data"),
            root.join("downloads"),
            0,
        ));
        let state = AppState::new(config).unwrap();
        let token = AuthToken(Arc::from("0123456789abcdef"));
        let media = MediaToken(Arc::from("fedcba9876543210"));
        let app = build_app(state, token, media).unwrap();

        let unauthenticated = app
            .clone()
            .oneshot(request(Method::GET, "/api/health", None))
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

        let generic_media_query = app
            .clone()
            .oneshot(request(
                Method::GET,
                "/api/health?kdj_media_token=fedcba9876543210",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(generic_media_query.status(), StatusCode::UNAUTHORIZED);

        let media_read = app
            .clone()
            .oneshot(request(
                Method::GET,
                "/api/library/audio/1?kdj_media_token=fedcba9876543210",
                None,
            ))
            .await
            .unwrap();
        assert_ne!(media_read.status(), StatusCode::UNAUTHORIZED);

        let hls_media_read = app
            .clone()
            .oneshot(request(
                Method::GET,
                "/api/video/youtube/hls/not-a-real-ticket?kdj_media_token=fedcba9876543210",
                None,
            ))
            .await
            .unwrap();
        assert_ne!(hls_media_read.status(), StatusCode::UNAUTHORIZED);

        let mut preflight = request(Method::OPTIONS, "/api/settings", None);
        preflight.headers_mut().insert(
            header::ORIGIN,
            HeaderValue::from_static("tauri://localhost"),
        );
        preflight.headers_mut().insert(
            header::ACCESS_CONTROL_REQUEST_METHOD,
            HeaderValue::from_static("PUT"),
        );
        preflight.headers_mut().insert(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            HeaderValue::from_static(
                "authorization,content-type,x-kdj-activity-recorded,x-kdj-sabr-url",
            ),
        );
        let preflight = app.clone().oneshot(preflight).await.unwrap();
        assert_eq!(preflight.status(), StatusCode::OK);
        assert_eq!(
            preflight.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("tauri://localhost"))
        );
        assert!(preflight
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value
                .split(',')
                .any(|name| name.trim().eq_ignore_ascii_case("x-kdj-sabr-url"))));
        assert!(preflight
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value
                .split(',')
                .any(|name| name.trim().eq_ignore_ascii_case(ACTIVITY_RECORDED_HEADER))));

        let mut hostile = request(Method::GET, "/api/health", Some("Bearer 0123456789abcdef"));
        hostile.headers_mut().insert(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example"),
        );
        let hostile = app.clone().oneshot(hostile).await.unwrap();
        assert_eq!(hostile.status(), StatusCode::FORBIDDEN);

        let authorized = app
            .oneshot(request(
                Method::GET,
                "/api/health",
                Some("Bearer 0123456789abcdef"),
            ))
            .await
            .unwrap();
        assert_eq!(authorized.status(), StatusCode::OK);
        let body = axum::body::to_bytes(authorized.into_body(), 64 * 1024)
            .await
            .unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(!body.contains("data_dir"));
        assert!(!body.contains("download_dir"));
        assert!(!body.contains(&root.to_string_lossy().into_owned()));

        let _ = std::fs::remove_dir_all(root);
    }
}
