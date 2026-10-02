//! Local-only, bounded diagnostics. The ONLY remote call is reports::submit, after user review.
mod redact;
mod reports;

use crate::{
    error::{ApiError, ApiResult},
    state::AppState,
};
use axum::{
    extract::{DefaultBodyLimit, MatchedPath},
    http::Request,
    middleware::Next,
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
};
use tracing::{
    field::{Field, Visit},
    Event, Subscriber,
};
use tracing_subscriber::{layer::Context, registry::LookupSpan, Layer};

const SEGMENT_BYTES: u64 = 4 * 1024 * 1024;
const RECENT_BYTES: u64 = 256 * 1024;
const MEMORY_LIMIT: usize = 300;
static STORE: OnceLock<Store> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub timestamp: String,
    pub session: String,
    pub level: String,
    pub category: String,
    pub source: String,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientEntry {
    pub level: String,
    pub category: String,
    pub source: String,
    pub message: String,
}

struct Store {
    directory: PathBuf,
    session: String,
    recent: Arc<Mutex<VecDeque<Entry>>>,
    writer: mpsc::SyncSender<Entry>,
    pending: Mutex<Option<reports::Prepared>>,
}

fn private_file(path: &Path) -> std::io::Result<std::fs::File> {
    if fs::symlink_metadata(path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err(std::io::Error::other("诊断文件不是普通文件"));
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// First successful initialization owns the directory (desktop starts before the backend).
pub fn initialize(directory: PathBuf) -> anyhow::Result<()> {
    if STORE.get().is_some() {
        return Ok(());
    }
    if fs::symlink_metadata(&directory).is_ok_and(|m| !m.is_dir() || m.file_type().is_symlink()) {
        anyhow::bail!("诊断目录不是普通目录");
    }
    fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    }
    let path = directory.join("errors.jsonl");
    let previous = directory.join("errors.previous.jsonl");
    let crash = directory.join("last-panic.jsonl");
    let mut recent = VecDeque::new();
    for path in [&previous, &path, &crash] {
        if !fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()) {
            continue;
        }
        if let Ok(mut file) = fs::File::open(path) {
            let size = file.metadata()?.len();
            file.seek(SeekFrom::Start(size.saturating_sub(RECENT_BYTES)))?;
            let mut tail = String::new();
            let mut bytes = Vec::new();
            file.take(RECENT_BYTES).read_to_end(&mut bytes)?;
            tail.push_str(&String::from_utf8_lossy(&bytes));
            for line in tail.lines() {
                if let Ok(entry) = serde_json::from_str::<Entry>(line) {
                    recent.push_back(entry);
                }
            }
        }
    }
    while recent.len() > MEMORY_LIMIT {
        recent.pop_front();
    }
    let file = private_file(&path)?;
    let (writer, receiver) = mpsc::sync_channel::<Entry>(512);
    let store = Store {
        directory,
        session: format!("{:032x}", rand::random::<u128>()),
        recent: Arc::new(Mutex::new(recent)),
        writer,
        pending: Mutex::new(None),
    };
    if STORE.set(store).is_err() {
        return Ok(());
    }
    std::thread::Builder::new()
        .name("kdj-errors".into())
        .spawn(move || {
            let mut file = Some(file);
            let mut bytes = file
                .as_ref()
                .and_then(|f| f.metadata().ok())
                .map_or(0, |m| m.len());
            for entry in receiver {
                let result = (|| -> anyhow::Result<()> {
                    let mut encoded = serde_json::to_vec(&entry)?;
                    encoded.push(b'\n');
                    if bytes + encoded.len() as u64 > SEGMENT_BYTES {
                        file.take();
                        if previous.exists() {
                            fs::remove_file(&previous)?;
                        }
                        fs::rename(&path, &previous)?;
                        bytes = 0;
                    }
                    if file.is_none() {
                        file = Some(private_file(&path)?);
                    }
                    if let Some(file) = file.as_mut() {
                        file.write_all(&encoded)?;
                        bytes += encoded.len() as u64;
                    }
                    Ok(())
                })();
                if result.is_err() {
                    DROPPED.fetch_add(1, Ordering::Relaxed);
                } // Never recursively log writer failures.
            }
        })?;
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = redact::text(
            &format!("{info}\n{}", std::backtrace::Backtrace::force_capture()),
            8_000,
        );
        record("error", "runtime", "rust-panic", &message);
        // A fatal panic can exit before the queue drains. Keep one bounded synchronous
        // crash record, separately from the writer's rotating segments; never lock here.
        if let Some(store) = STORE.get() {
            let entry = Entry {
                timestamp: chrono::Utc::now().to_rfc3339(),
                session: store.session.clone(),
                level: "error".into(),
                category: "runtime".into(),
                source: "rust-panic".into(),
                message,
            };
            if let (Ok(mut file), Ok(bytes)) = (private_file(&crash), serde_json::to_vec(&entry)) {
                if file.set_len(0).is_ok() {
                    let _ = file.write_all(&bytes);
                    let _ = file.sync_data();
                }
            }
        }
        previous_hook(info);
    }));
    record(
        "info",
        "runtime",
        "startup",
        &format!(
            "version={} os={} arch={} cpu_threads={}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::thread::available_parallelism().map_or(0, |n| n.get())
        ),
    );
    Ok(())
}

pub fn record(level: &str, category: &str, source: &str, message: &str) {
    let Some(store) = STORE.get() else {
        return;
    };
    let entry = Entry {
        timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        session: store.session.clone(),
        level: redact::text(level, 8),
        category: redact::text(category, 40),
        source: redact::text(source, 200),
        message: redact::text(message, 8_000),
    };
    if let Ok(mut recent) = store.recent.try_lock() {
        recent.push_back(entry.clone());
        while recent.len() > MEMORY_LIMIT {
            recent.pop_front();
        }
    } else {
        DROPPED.fetch_add(1, Ordering::Relaxed);
    }
    if store.writer.try_send(entry).is_err() {
        DROPPED.fetch_add(1, Ordering::Relaxed);
    }
}

pub fn category(source: &str) -> &'static str {
    if source.contains("theme") {
        "theme"
    } else if source.contains("visualizer") {
        "visualizer-export"
    } else if source.contains("workshop") || source.contains("composition") {
        "workshop-export"
    } else if source.contains("provider")
        || source.contains("search")
        || source.contains("download")
        || source.contains("account")
    {
        "platform"
    } else if source.contains("video")
        || source.contains("player")
        || source.contains("playback")
        || source.contains("media")
    {
        "playback"
    } else if source.contains("gpu") || source.contains("hardware") {
        "hardware"
    } else {
        "local"
    }
}

/// Records WARN/ERROR independently of the terminal's RUST_LOG filter.
pub struct DiagnosticLayer;
#[derive(Default)]
struct Fields(String);
impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if self.0.len() > 16_000 {
            return;
        }
        if redact::sensitive_field(field.name()) {
            self.0.push_str(&format!(" {}=[redacted]", field.name()));
        } else {
            self.0.push_str(&format!(" {}={value:?}", field.name()));
        }
    }
}
impl<S: Subscriber + for<'a> LookupSpan<'a>> Layer<S> for DiagnosticLayer {
    fn on_event(&self, event: &Event<'_>, context: Context<'_, S>) {
        let meta = event.metadata();
        if *meta.level() > tracing::Level::WARN {
            return;
        }
        let mut fields = Fields::default();
        event.record(&mut fields);
        if let Some(scope) = context.event_scope(event) {
            for span in scope.from_root() {
                fields.0.push_str(&format!(" span={}", span.name()));
            }
        }
        record(
            meta.level().as_str(),
            category(meta.target()),
            &format!("{}:{}", meta.target(), meta.line().unwrap_or(0)),
            &fields.0,
        );
    }
}

#[derive(Clone)]
pub(crate) struct DiagnosticDetail(pub String);

pub async fn capture_requests(request: Request<axum::body::Body>, next: Next) -> Response {
    // MatchedPath contains the route template, never query strings or user path parameters.
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_else(|| "unmatched".into());
    let method = request.method().to_string();
    let started = std::time::Instant::now();
    let response = next.run(request).await;
    if (response.status().is_client_error() || response.status().is_server_error())
        && !route.starts_with("/api/diagnostics")
    {
        let detail = response
            .extensions()
            .get::<DiagnosticDetail>()
            .map(|d| d.0.as_str())
            .unwrap_or("");
        record(
            "error",
            category(&route),
            &route,
            &format!(
                "{method} status={} duration_ms={} {detail}",
                response.status().as_u16(),
                started.elapsed().as_millis()
            ),
        );
    }
    response
}

async fn append(Json(entries): Json<Vec<ClientEntry>>) -> ApiResult<Json<serde_json::Value>> {
    if entries.len() > 50 {
        return Err(ApiError::bad_request("单批诊断最多 50 条"));
    }
    for entry in entries {
        if !matches!(entry.level.as_str(), "error" | "warn" | "info") {
            return Err(ApiError::bad_request("诊断级别无效"));
        }
        record(&entry.level, &entry.category, &entry.source, &entry.message);
    }
    Ok(Json(serde_json::json!({"ok":true})))
}
async fn directory() -> ApiResult<Json<serde_json::Value>> {
    let store = STORE
        .get()
        .ok_or_else(|| ApiError::bad_request("诊断日志未初始化"))?;
    Ok(Json(serde_json::json!({"path":store.directory})))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/diagnostics/entries", post(append))
        .route("/api/diagnostics/directory", get(directory))
        .route("/api/diagnostics/prepare", post(reports::prepare))
        .route("/api/diagnostics/submit", post(reports::submit))
        .layer(DefaultBodyLimit::max(512 * 1024))
}
