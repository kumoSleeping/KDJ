//! The AI corner (docs/ai-dock.md): kdj-server runs the user's pi (`pi --mode rpc`) for the
//! window's conversation and forwards every line of its stream to the window as `ai.event`.
//!
//! pi runs in KDJ's own directory, never the user's global one: `PI_CODING_AGENT_DIR` is
//! `<data>/ai/pi-agent` (its `auth.json` holds the key the listener gave in 设置 → AI), the work
//! directory is `<data>/ai/workspace`, sessions go to `<data>/ai/sessions`, and the global
//! extensions, skills and context files are left out. The only tools are KDJ's own — the `kdj`
//! CLI's commands and a browser that only reads pages (kdj-tools.ts, kdj-browser.ts) — under KDJ's
//! prompt (kdj-prompt.md).

mod pi;
mod sessions;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub use pi::{PiState, PiStatus};

const TOOLS: &str = include_str!("kdj-tools.ts");
const BROWSER: &str = include_str!("kdj-browser.ts");
const PROMPT: &str = include_str!("kdj-prompt.md");
/// How long a command waits for pi's response. `prompt` answers when the run is accepted, not
/// when it ends.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a detected pi stays detected before `status` looks again.
const STATUS_TTL: Duration = Duration::from_secs(60);
const STDERR_LINES: usize = 20;

/// The providers offered in 设置 → AI: pi's own ids (pi-ai `env-api-keys.ts`), those usable from
/// China first.
const PROVIDERS: &[(&str, &str)] = &[
    ("deepseek", "DeepSeek"),
    ("moonshotai-cn", "Kimi（Moonshot 中国）"),
    ("kimi-coding", "Kimi For Coding"),
    ("zai-coding-cn", "智谱 GLM Coding（中国）"),
    ("qwen-token-plan-cn", "通义千问 Token Plan（中国）"),
    ("minimax-cn", "MiniMax（中国）"),
    ("xiaomi", "小米 MiMo"),
    ("openrouter", "OpenRouter"),
    ("moonshotai", "Moonshot AI"),
    ("zai", "Z.ai"),
    ("minimax", "MiniMax"),
    ("openai", "OpenAI"),
    ("anthropic", "Anthropic"),
    ("google", "Google Gemini"),
    ("xai", "xAI"),
];

struct Paths {
    data: PathBuf,
    agent: PathBuf,
    workspace: PathBuf,
    sessions: PathBuf,
    /// KDJ's choice of provider and model.
    config: PathBuf,
}

impl Paths {
    fn new(data: &Path) -> Self {
        let ai = data.join("ai");
        Paths {
            data: data.to_path_buf(),
            agent: ai.join("pi-agent"),
            workspace: ai.join("workspace"),
            sessions: ai.join("sessions"),
            config: ai.join("kdj-ai.json"),
        }
    }
    fn auth(&self) -> PathBuf {
        self.agent.join("auth.json")
    }
    fn tools(&self) -> PathBuf {
        self.agent.join("kdj").join("kdj-tools.ts")
    }
    fn browser(&self) -> PathBuf {
        self.agent.join("kdj").join("kdj-browser.ts")
    }
    fn prompt(&self) -> PathBuf {
        self.agent.join("kdj").join("kdj-prompt.md")
    }
}

// ---------------------------------------------------------------- files

fn read_object(path: &Path) -> anyhow::Result<Map<String, Value>> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(Map::new()),
        Ok(text) => match serde_json::from_str::<Value>(&text)? {
            Value::Object(object) => Ok(object),
            _ => anyhow::bail!("{} 不是 JSON 对象", path.display()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(error.into()),
    }
}

/// Replaces `path` whole or not at all; private to the user where the system has such a thing
/// (auth.json holds a key).
fn write_private(path: &Path, contents: &[u8]) -> anyhow::Result<()> {
    let dir = path.parent().ok_or_else(|| anyhow::anyhow!("无效路径：{}", path.display()))?;
    std::fs::create_dir_all(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    std::io::Write::write_all(&mut file, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file().set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.persist(path)?;
    Ok(())
}

/// Changes some keys of a JSON object file and keeps every other key it holds. Nothing is
/// written when nothing changes (AGENTS.md: a write never holds less than what was read).
fn update_object(path: &Path, change: impl FnOnce(&mut Map<String, Value>)) -> anyhow::Result<Map<String, Value>> {
    let before = read_object(path)?;
    let mut after = before.clone();
    change(&mut after);
    if after != before {
        write_private(path, serde_json::to_string_pretty(&Value::Object(after.clone()))?.as_bytes())?;
    }
    Ok(after)
}

fn write_if_changed(path: &Path, contents: &str) -> anyhow::Result<()> {
    if std::fs::read_to_string(path).is_ok_and(|current| current == contents) {
        return Ok(());
    }
    write_private(path, contents.as_bytes())
}

// ---------------------------------------------------------------- the process

struct PiProcess {
    stdin: tokio::sync::Mutex<ChildStdin>,
    child: tokio::sync::Mutex<Child>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    /// From `agent_start` until `agent_settled`: a line sent now steers the run.
    streaming: AtomicBool,
    /// KDJ ended it (a new key or provider): its exit is not news.
    stopping: AtomicBool,
    stderr: Mutex<VecDeque<String>>,
}

impl PiProcess {
    async fn send(&self, mut command: Value) -> ApiResult<Value> {
        let id = format!("kdj-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        command["id"] = json!(id);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), tx);
        let mut line = command.to_string();
        line.push('\n');
        let written = self.stdin.lock().await.write_all(line.as_bytes()).await;
        if let Err(error) = written {
            self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            return Err(ApiError::bad_request(format!("pi 已退出：{error}")));
        }
        let response = match tokio::time::timeout(RESPONSE_TIMEOUT, rx).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => return Err(ApiError::bad_request("pi 已退出")),
            Err(_) => {
                self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                return Err(ApiError::bad_request("pi 没有响应"));
            }
        };
        if response["success"] == false {
            return Err(ApiError::bad_request(response["error"].as_str().unwrap_or("pi 拒绝了这个请求").to_string()));
        }
        Ok(response["data"].clone())
    }

    /// A line that needs no response (`extension_ui_response`).
    async fn tell(&self, message: Value) -> ApiResult<()> {
        let mut line = message.to_string();
        line.push('\n');
        self.stdin
            .lock()
            .await
            .write_all(line.as_bytes())
            .await
            .map_err(|error| ApiError::bad_request(format!("pi 已退出：{error}")))
    }

    async fn stop(&self) {
        self.stopping.store(true, Ordering::Relaxed);
        let _ = self.child.lock().await.start_kill();
    }
}

struct AiBridge {
    paths: Paths,
    process: tokio::sync::Mutex<Option<Arc<PiProcess>>>,
    detected: Mutex<Option<(Instant, PiStatus)>>,
}

fn bridge(state: &AppState) -> &'static AiBridge {
    static BRIDGE: OnceLock<AiBridge> = OnceLock::new();
    BRIDGE.get_or_init(|| AiBridge {
        paths: Paths::new(&state.config.data_dir),
        process: tokio::sync::Mutex::new(None),
        detected: Mutex::new(None),
    })
}

#[derive(Default, Clone)]
struct Choice {
    provider: Option<String>,
    model: Option<String>,
}

impl AiBridge {
    fn choice(&self) -> Choice {
        let config = read_object(&self.paths.config).unwrap_or_default();
        let text = |key: &str| config.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
        Choice { provider: text("provider"), model: text("model") }
    }

    fn save_choice(&self, choice: &Choice) -> anyhow::Result<()> {
        update_object(&self.paths.config, |config| {
            for (key, value) in [("provider", &choice.provider), ("model", &choice.model)] {
                match value {
                    Some(value) => config.insert(key.into(), json!(value)),
                    None => config.remove(key),
                };
            }
        })?;
        Ok(())
    }

    fn configured(&self) -> Vec<String> {
        read_object(&self.paths.auth()).map(|auth| auth.keys().cloned().collect()).unwrap_or_default()
    }

    async fn pi(&self, refresh: bool) -> PiStatus {
        if !refresh {
            if let Some((at, status)) = self.detected.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                if at.elapsed() < STATUS_TTL {
                    return status;
                }
            }
        }
        let status = pi::inspect().await;
        *self.detected.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), status.clone()));
        status
    }

    async fn status(&self, refresh: bool) -> Value {
        let pi = self.pi(refresh).await;
        let configured = self.configured();
        let choice = self.choice();
        let running = self.process.lock().await.is_some();
        // The offered providers, then any other one a key was brought in for (from the global pi).
        let mut providers: Vec<Value> = PROVIDERS
            .iter()
            .map(|(id, label)| json!({ "id": id, "label": label, "configured": configured.iter().any(|c| c == id) }))
            .collect();
        for id in configured.iter().filter(|id| !PROVIDERS.iter().any(|(known, _)| known == id)) {
            providers.push(json!({ "id": id, "label": id, "configured": true }));
        }
        json!({
            "pi": pi,
            "providers": providers,
            "provider": choice.provider,
            "model": choice.model,
            "running": running,
        })
    }

    /// The running pi, started when there is none.
    async fn process(&self, state: &Arc<AppState>) -> ApiResult<Arc<PiProcess>> {
        let mut slot = self.process.lock().await;
        if let Some(process) = slot.as_ref() {
            return Ok(process.clone());
        }
        let process = self.spawn(state).await?;
        *slot = Some(process.clone());
        drop(slot);
        state.hub.publish("ai.status", &self.status(false).await);
        self.settle_model(&process).await;
        Ok(process)
    }

    async fn spawn(&self, state: &Arc<AppState>) -> ApiResult<Arc<PiProcess>> {
        let pi = self.pi(false).await;
        let Some(path) = pi.path.filter(|_| pi.state == PiState::Ready).map(PathBuf::from) else {
            return Err(ApiError::bad_request(if pi.state == PiState::Missing { "未安装 pi" } else { "pi 无法运行" }));
        };
        let paths = &self.paths;
        for dir in [&paths.agent, &paths.workspace, &paths.sessions] {
            std::fs::create_dir_all(dir).map_err(anyhow::Error::from)?;
        }
        write_if_changed(&paths.tools(), TOOLS)?;
        write_if_changed(&paths.browser(), BROWSER)?;
        write_if_changed(&paths.prompt(), PROMPT)?;

        let choice = self.choice();
        let cli = std::env::var_os("KDJ_CLI_PATH")
            .map(PathBuf::from)
            .or_else(|| std::env::current_exe().ok())
            .unwrap_or_else(|| PathBuf::from("kdj"));
        let mut command = pi::command(&path);
        command
            .args(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files", "--no-builtin-tools"])
            .arg("--session-dir")
            .arg(&paths.sessions)
            .arg("--extension")
            .arg(paths.tools())
            .arg("--append-system-prompt")
            .arg(paths.prompt());
        if let (Some(provider), Some(model)) = (&choice.provider, &choice.model) {
            command.args(["--provider", provider.as_str(), "--model", model.as_str()]);
        }
        command
            .current_dir(&paths.workspace)
            .env("PI_CODING_AGENT_DIR", &paths.agent)
            .env("PI_SKIP_VERSION_CHECK", "1")
            .env("PI_TELEMETRY", "0")
            .env("KDJ_CLI", &cli)
            .env("KDJ_DATA_DIR", &paths.data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| ApiError::bad_request(format!("无法启动 pi：{error}")))?;
        let stdin = child.stdin.take().ok_or_else(|| ApiError::bad_request("无法连接 pi"))?;
        let stdout = child.stdout.take().ok_or_else(|| ApiError::bad_request("无法连接 pi"))?;
        let stderr = child.stderr.take().ok_or_else(|| ApiError::bad_request("无法连接 pi"))?;
        let process = Arc::new(PiProcess {
            stdin: tokio::sync::Mutex::new(stdin),
            child: tokio::sync::Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            streaming: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            stderr: Mutex::new(VecDeque::new()),
        });

        let keep = process.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "kdj::ai", "pi: {line}");
                let mut tail = keep.stderr.lock().unwrap_or_else(|e| e.into_inner());
                tail.push_back(line);
                while tail.len() > STDERR_LINES {
                    tail.pop_front();
                }
            }
        });

        let keep = process.clone();
        let state = state.clone();
        tokio::spawn(async move {
            // One JSON object per LF-terminated line; a CR before it is dropped by `lines`.
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
                match event["type"].as_str() {
                    Some("response") => {
                        let sender = event["id"]
                            .as_str()
                            .and_then(|id| keep.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(id));
                        if let Some(sender) = sender {
                            let _ = sender.send(event);
                        }
                    }
                    Some(kind) => {
                        match kind {
                            "agent_start" => keep.streaming.store(true, Ordering::Relaxed),
                            "agent_settled" => keep.streaming.store(false, Ordering::Relaxed),
                            _ => {}
                        }
                        state.hub.publish("ai.event", &event);
                    }
                    None => {}
                }
            }
            let code = keep.child.lock().await.wait().await.ok().and_then(|status| status.code());
            let last = keep.stderr.lock().unwrap_or_else(|e| e.into_inner()).back().cloned().unwrap_or_default();
            keep.pending.lock().unwrap_or_else(|e| e.into_inner()).clear();
            let bridge = bridge(&state);
            {
                let mut slot = bridge.process.lock().await;
                if slot.as_ref().is_some_and(|current| Arc::ptr_eq(current, &keep)) {
                    *slot = None;
                }
            }
            let message = match (code, last.is_empty()) {
                (Some(0), _) => String::new(),
                (Some(code), true) => format!("pi 已退出（{code}）"),
                (_, false) => format!("pi 已退出：{last}"),
                (None, true) => "pi 已退出".to_string(),
            };
            if !message.is_empty() && !keep.stopping.load(Ordering::Relaxed) {
                let at = chrono::Utc::now().timestamp_millis().to_string();
                state.hub.publish("ai.event", &json!({ "type": "kdj_exit", "at": at, "message": message }));
            }
            state.hub.publish("ai.status", &bridge.status(false).await);
        });
        Ok(process)
    }

    /// With a provider chosen and no model yet, the first model pi offers for it is taken and
    /// remembered.
    async fn settle_model(&self, process: &PiProcess) {
        let choice = self.choice();
        let (Some(provider), None) = (choice.provider.clone(), choice.model.as_ref()) else { return };
        let Ok(data) = process.send(json!({ "type": "get_available_models" })).await else { return };
        let Some(model) = data["models"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|model| model["provider"] == provider.as_str())
            .and_then(|model| model["id"].as_str())
            .map(str::to_string)
        else {
            return;
        };
        if process.send(json!({ "type": "set_model", "provider": provider, "modelId": model })).await.is_ok() {
            let _ = self.save_choice(&Choice { provider: Some(provider), model: Some(model) });
        }
    }

    async fn stop(&self) {
        if let Some(process) = self.process.lock().await.take() {
            process.stop().await;
        }
    }
}

// ---------------------------------------------------------------- routes

#[derive(Deserialize)]
pub struct StatusQuery {
    #[serde(default)]
    refresh: Option<String>,
}

pub async fn status(State(state): State<Arc<AppState>>, Query(query): Query<StatusQuery>) -> Json<Value> {
    Json(bridge(&state).status(query.refresh.is_some()).await)
}

#[derive(Deserialize)]
pub struct ModelsQuery {
    provider: String,
}

pub async fn models(State(state): State<Arc<AppState>>, Query(query): Query<ModelsQuery>) -> ApiResult<Json<Value>> {
    let process = bridge(&state).process(&state).await?;
    let data = process.send(json!({ "type": "get_available_models" })).await?;
    let models: Vec<Value> = data["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| model["provider"] == query.provider.as_str())
        .map(|model| json!({ "provider": model["provider"], "id": model["id"], "name": model["name"] }))
        .collect();
    Ok(Json(json!({ "models": models })))
}

#[derive(Deserialize)]
pub struct ProviderBody {
    provider: String,
    #[serde(default)]
    key: Option<String>,
    /// Absent: keep the model; null: let pi choose.
    #[serde(default, deserialize_with = "present")]
    model: Option<Option<String>>,
}

fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::deserialize(deserializer)?))
}

pub async fn set_provider(State(state): State<Arc<AppState>>, Json(body): Json<ProviderBody>) -> ApiResult<Json<Value>> {
    let bridge = bridge(&state);
    if !PROVIDERS.iter().any(|(id, _)| *id == body.provider) && !bridge.configured().contains(&body.provider) {
        return Err(ApiError::bad_request(format!("不支持的服务商：{}", body.provider)));
    }
    let before = bridge.choice();
    let mut choice = before.clone();
    let mut restart = false;
    if let Some(key) = body.key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
        update_object(&bridge.paths.auth(), |auth| {
            auth.insert(body.provider.clone(), json!({ "type": "api_key", "key": key }));
        })?;
        restart = true;
    }
    if before.provider.as_deref() != Some(body.provider.as_str()) {
        choice.provider = Some(body.provider.clone());
        choice.model = None;
        restart = true;
    }
    if let Some(model) = body.model {
        choice.model = model.filter(|model| !model.is_empty());
    }
    bridge.save_choice(&choice)?;
    if restart {
        // pi reads its key and provider when it starts; the next line starts it again.
        bridge.stop().await;
    } else if choice.model != before.model {
        let running = bridge.process.lock().await.clone();
        if let (Some(process), Some(provider), Some(model)) = (running, &choice.provider, &choice.model) {
            process.send(json!({ "type": "set_model", "provider": provider, "modelId": model })).await?;
        }
    }
    let status = bridge.status(false).await;
    state.hub.publish("ai.status", &status);
    Ok(Json(status))
}

#[derive(Deserialize)]
pub struct PromptBody {
    message: String,
}

pub async fn prompt(State(state): State<Arc<AppState>>, Json(body): Json<PromptBody>) -> ApiResult<Json<Value>> {
    let message = body.message.trim();
    if message.is_empty() {
        return Err(ApiError::bad_request("消息为空"));
    }
    let process = bridge(&state).process(&state).await?;
    let mut command = json!({ "type": "prompt", "message": message });
    if process.streaming.load(Ordering::Relaxed) {
        command["streamingBehavior"] = json!("steer");
    }
    let data = process.send(command).await?;
    Ok(Json(json!({ "disposition": data["disposition"] })))
}

pub async fn abort(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let running = bridge(&state).process.lock().await.clone();
    if let Some(process) = running {
        process.send(json!({ "type": "abort" })).await?;
    }
    Ok(Json(json!({})))
}

pub async fn reset(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let running = bridge(&state).process.lock().await.clone();
    if let Some(process) = running {
        if process.streaming.load(Ordering::Relaxed) {
            process.send(json!({ "type": "abort" })).await?;
        }
        process.send(json!({ "type": "new_session" })).await?;
    }
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
pub struct AnswerBody {
    id: String,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    confirmed: Option<bool>,
    #[serde(default)]
    cancelled: Option<bool>,
}

pub async fn answer(State(state): State<Arc<AppState>>, Json(body): Json<AnswerBody>) -> ApiResult<Json<Value>> {
    let running = bridge(&state).process.lock().await.clone();
    let Some(process) = running else {
        return Err(ApiError::bad_request("pi 没有在运行"));
    };
    let mut message = json!({ "type": "extension_ui_response", "id": body.id });
    if body.cancelled == Some(true) {
        message["cancelled"] = json!(true);
    } else if let Some(confirmed) = body.confirmed {
        message["confirmed"] = json!(confirmed);
    } else {
        message["value"] = json!(body.value.unwrap_or_default());
    }
    process.tell(message).await?;
    Ok(Json(json!({})))
}

// ---------------------------------------------------------------- history

pub async fn sessions_list(State(state): State<Arc<AppState>>) -> Json<Value> {
    let dir = bridge(&state).paths.sessions.clone();
    let sessions = tokio::task::spawn_blocking(move || sessions::list(&dir)).await.unwrap_or_default();
    Json(json!({ "sessions": sessions }))
}

#[derive(Deserialize)]
pub struct OpenBody {
    path: String,
}

/// Resumes an earlier conversation: pi switches to its session and gives back its messages, which
/// the window draws again.
pub async fn sessions_open(State(state): State<Arc<AppState>>, Json(body): Json<OpenBody>) -> ApiResult<Json<Value>> {
    let bridge = bridge(&state);
    let path = sessions::inside(&bridge.paths.sessions, &body.path).ok_or_else(|| ApiError::not_found("找不到这段对话"))?;
    let process = bridge.process(&state).await?;
    if process.streaming.load(Ordering::Relaxed) {
        process.send(json!({ "type": "abort" })).await?;
    }
    let switched = process.send(json!({ "type": "switch_session", "sessionPath": path })).await?;
    if switched["cancelled"] == true {
        return Err(ApiError::bad_request("pi 没有切换到这段对话"));
    }
    let messages = process.send(json!({ "type": "get_messages" })).await?;
    Ok(Json(json!({ "messages": messages["messages"] })))
}

// ---------------------------------------------------------------- the global pi's logins

/// The user's own pi directory: `PI_CODING_AGENT_DIR` when KDJ was started with one, else
/// `~/.pi/agent`.
fn global_agent_dir() -> Option<PathBuf> {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| pi::home().map(|home| home.join(".pi").join("agent")))
}

/// The logins in the global pi. A key can be brought into KDJ's directory; a subscription login
/// cannot, because both copies would renew the same token and log each other out.
pub async fn global_logins(State(state): State<Arc<AppState>>) -> Json<Value> {
    let ours = bridge(&state).paths.agent.clone();
    let Some(dir) = global_agent_dir().filter(|dir| *dir != ours) else {
        return Json(json!({ "logins": [] }));
    };
    let auth = read_object(&dir.join("auth.json")).unwrap_or_default();
    let logins: Vec<Value> = auth
        .iter()
        .map(|(id, entry)| {
            let kind = entry["type"].as_str().unwrap_or_default();
            let label = PROVIDERS.iter().find(|(known, _)| known == id).map(|(_, label)| *label).unwrap_or(id);
            json!({ "id": id, "label": label, "kind": kind, "importable": kind == "api_key" })
        })
        .collect();
    Json(json!({ "path": dir.display().to_string(), "logins": logins }))
}

#[derive(Deserialize)]
pub struct ImportBody {
    provider: String,
}

pub async fn import_login(State(state): State<Arc<AppState>>, Json(body): Json<ImportBody>) -> ApiResult<Json<Value>> {
    let bridge = bridge(&state);
    let dir = global_agent_dir().filter(|dir| *dir != bridge.paths.agent).ok_or_else(|| ApiError::not_found("没有找到全局 pi 的目录"))?;
    let auth = read_object(&dir.join("auth.json"))?;
    let entry = auth.get(&body.provider).ok_or_else(|| ApiError::not_found(format!("全局 pi 里没有 {} 的登录", body.provider)))?;
    if entry["type"] != "api_key" {
        return Err(ApiError::bad_request("订阅登录不能共用：两边会互相顶掉登录，请在 KDJ 里另填 API Key"));
    }
    update_object(&bridge.paths.auth(), |ours| {
        ours.insert(body.provider.clone(), entry.clone());
    })?;
    let before = bridge.choice();
    bridge.save_choice(&Choice {
        provider: Some(body.provider.clone()),
        model: if before.provider.as_deref() == Some(body.provider.as_str()) { before.model } else { None },
    })?;
    bridge.stop().await;
    let status = bridge.status(false).await;
    state.hub.publish("ai.status", &status);
    Ok(Json(status))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_added_beside_the_ones_already_there() {
        let dir = tempfile::tempdir().unwrap();
        let auth = dir.path().join("auth.json");
        std::fs::write(&auth, r#"{"anthropic":{"type":"oauth","access":"x"},"note":1}"#).unwrap();
        update_object(&auth, |auth| {
            auth.insert("deepseek".into(), json!({ "type": "api_key", "key": "sk-1" }));
        })
        .unwrap();
        let after = read_object(&auth).unwrap();
        assert_eq!(after["anthropic"]["access"], "x");
        assert_eq!(after["note"], 1);
        assert_eq!(after["deepseek"]["key"], "sk-1");
    }

    #[test]
    fn an_unchanged_document_is_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kdj-ai.json");
        std::fs::write(&path, "{\"provider\":\"deepseek\",\"extra\":true}").unwrap();
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(20));
        update_object(&path, |config| {
            config.insert("provider".into(), json!("deepseek"));
        })
        .unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"provider\":\"deepseek\",\"extra\":true}");
    }

    #[test]
    fn a_document_that_is_not_an_object_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        std::fs::write(&path, "[1,2]").unwrap();
        assert!(update_object(&path, |_| {}).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[1,2]");
    }

    #[test]
    fn the_model_field_tells_absent_from_null() {
        let absent: ProviderBody = serde_json::from_str(r#"{"provider":"deepseek"}"#).unwrap();
        assert!(absent.model.is_none());
        let cleared: ProviderBody = serde_json::from_str(r#"{"provider":"deepseek","model":null}"#).unwrap();
        assert_eq!(cleared.model, Some(None));
        let chosen: ProviderBody = serde_json::from_str(r#"{"provider":"deepseek","model":"deepseek-chat"}"#).unwrap();
        assert_eq!(chosen.model, Some(Some("deepseek-chat".into())));
    }
}
