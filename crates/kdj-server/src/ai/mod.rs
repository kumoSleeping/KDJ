//! The AI corner (docs/ai-dock.md): kdj-server runs the user's pi (`pi --mode rpc`) for the
//! window's conversation and forwards every line of its stream to the window as `ai.event`.
//!
//! pi runs in KDJ's own directory, never the user's global one: `PI_CODING_AGENT_DIR` is
//! `<data>/ai/pi-agent` (its `auth.json` holds the key the listener gave in 设置 → AI), the work
//! directory is `<data>/ai/workspace`, sessions go to `<data>/ai/sessions`, and the global
//! skills and context files are left out. The tools are KDJ's own — the `kdj` CLI's commands
//! (kdj-tools.ts) — and a web search: pi-web-access, which KDJ installs into its own directory on
//! request and locks down (web-search.json), or one of KDJ's built-in ways (kdj-web.ts: DeepSeek's
//! Search / Fetch, DeepSeek with Jina Reader, Jina with a key). The prompt is KDJ's (kdj-prompt.md).

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
const WEB: &str = include_str!("kdj-web.ts");
const FOLDERS: &str = include_str!("kdj-folders.ts");
const PROMPT: &str = include_str!("kdj-prompt.md");
const VIDEO: &str = include_str!("kdj-video.ts");
/// The kdj-video skill (skills/kdj-video), as files under the skill's directory.
const SKILL: &[(&str, &str)] = &[
    ("SKILL.md", include_str!("skills/kdj-video/SKILL.md")),
    ("references/kdjv.md", include_str!("skills/kdj-video/references/kdjv.md")),
    ("references/ffmpeg.md", include_str!("skills/kdj-video/references/ffmpeg.md")),
    ("references/remotion.md", include_str!("skills/kdj-video/references/remotion.md")),
    ("references/preset-vj.md", include_str!("skills/kdj-video/references/preset-vj.md")),
    ("references/preset-cut.md", include_str!("skills/kdj-video/references/preset-cut.md")),
    ("references/preset-merge.md", include_str!("skills/kdj-video/references/preset-merge.md")),
    ("references/preset-visualizer.md", include_str!("skills/kdj-video/references/preset-visualizer.md")),
];
/// What the Remotion project holds: Remotion's packages move in lockstep, so `latest` of each
/// is one release.
const REMOTION_PACKAGES: &[&str] = &[
    "remotion@latest",
    "@remotion/cli@latest",
    "@remotion/transitions@latest",
    "react@19",
    "react-dom@19",
];
/// How long installing Remotion and its browser may take.
const REMOTION_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long a command waits for pi's response. `prompt` answers when the run is accepted, not
/// when it ends.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a detected pi stays detected before `status` looks again.
const STATUS_TTL: Duration = Duration::from_secs(60);
const STDERR_LINES: usize = 20;
/// How long installing pi-web-access may take.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// pi-web-access, the default web search: installed by pi into KDJ's own directory.
const ACCESS_PACKAGE: &str = "npm:pi-web-access";
/// Its tools, hidden while another way of searching is chosen.
const ACCESS_TOOLS: &str = "web_search,fetch_content,get_search_content,source_check";
/// The reasoning efforts the listener steps through (the key beside Agent Mode), pi's names.
const THINKING_LEVELS: &[&str] = &["low", "medium", "high", "xhigh"];
const DEFAULT_THINKING: &str = "high";
/// The ways of searching the web: pi-web-access, or KDJ's own (kdj-web.ts).
const WEB_MODES: &[&str] = &["access", "deepseek", "deepseek-jina", "jina"];

/// pi-web-access with everything but searching and reading pages turned off: no browser cookies,
/// no video, GitHub clones, PDFs or commands, and no requests to this machine. Its domain policy
/// takes host names and IPv4 only — an IPv6 entry such as `::1` makes it refuse the whole file, and
/// every page read fails — while its own guard already refuses loopback and private addresses.
const ACCESS_CONFIG: &str = r#"{
  "allowBrowserCookies": false,
  "video": { "enabled": false },
  "youtube": { "enabled": false },
  "githubClone": { "enabled": false },
  "githubPrIssue": { "enabled": false },
  "pdf": { "enabled": false },
  "workflow": "none",
  "fetchRouting": { "allowRemoteHostedProviders": true },
  "fetchContent": { "domainPolicy": { "deny": ["localhost", "127.0.0.1", "0.0.0.0"] } },
  "commands": {
    "websearch": { "enabled": false },
    "curator": { "enabled": false },
    "search": { "enabled": false },
    "google-account": { "enabled": false }
  }
}
"#;

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
    fn web(&self) -> PathBuf {
        self.agent.join("kdj").join("kdj-web.ts")
    }
    fn folders(&self) -> PathBuf {
        self.agent.join("kdj").join("kdj-folders.ts")
    }
    fn prompt(&self) -> PathBuf {
        self.agent.join("kdj").join("kdj-prompt.md")
    }
    fn video(&self) -> PathBuf {
        self.agent.join("kdj").join("kdj-video.ts")
    }
    /// The kdj-video skill: the only skill pi is given (`--skill`; `--no-skills` keeps out the rest).
    fn skill(&self) -> PathBuf {
        self.agent.join("kdj").join("skills").join("kdj-video")
    }
    /// The Remotion project the AI renders with, its packages installed by KDJ.
    fn remotion(&self) -> PathBuf {
        self.workspace.join("remotion")
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
    /// The open session has had no request yet (pi just started, or a new session was opened):
    /// the next request needs no new one.
    fresh: AtomicBool,
    /// The listener chose an earlier session to go on with (历史 → 继续): the next request
    /// continues it instead of starting its own.
    resume: AtomicBool,
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
    /// pi-web-access is being installed; and why the last try failed.
    installing: AtomicBool,
    install_error: Mutex<String>,
    /// Remotion is being installed into the workspace; and why the last try failed.
    remotion_installing: AtomicBool,
    remotion_error: Mutex<String>,
}

fn bridge(state: &AppState) -> &'static AiBridge {
    static BRIDGE: OnceLock<AiBridge> = OnceLock::new();
    BRIDGE.get_or_init(|| AiBridge {
        paths: Paths::new(&state.config.data_dir),
        process: tokio::sync::Mutex::new(None),
        detected: Mutex::new(None),
        installing: AtomicBool::new(false),
        install_error: Mutex::new(String::new()),
        remotion_installing: AtomicBool::new(false),
        remotion_error: Mutex::new(String::new()),
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

    /// Opens a new session in a running pi. pi builds it from its start-up arguments, so the model
    /// and the reasoning effort chosen since in 设置 are given to it again.
    async fn new_session(&self, process: &PiProcess) -> ApiResult<()> {
        process.send(json!({ "type": "new_session" })).await?;
        let choice = self.choice();
        if let (Some(provider), Some(model)) = (&choice.provider, &choice.model) {
            process.send(json!({ "type": "set_model", "provider": provider, "modelId": model })).await?;
        }
        process.send(json!({ "type": "set_thinking_level", "level": self.thinking() })).await?;
        process.fresh.store(true, Ordering::Relaxed);
        process.resume.store(false, Ordering::Relaxed);
        Ok(())
    }

    /// How hard the model thinks (`thinking` in kdj-ai.json): high unless the listener chose
    /// otherwise. pi fits it to what the model can do.
    fn thinking(&self) -> String {
        read_object(&self.paths.config)
            .ok()
            .and_then(|config| config.get("thinking").and_then(Value::as_str).map(str::to_string))
            .filter(|level| THINKING_LEVELS.contains(&level.as_str()))
            .unwrap_or_else(|| DEFAULT_THINKING.to_string())
    }

    /// How the AI searches the web (`web` in kdj-ai.json); pi-web-access when nothing was chosen.
    fn web_mode(&self) -> String {
        read_object(&self.paths.config)
            .ok()
            .and_then(|config| config.get("web").and_then(Value::as_str).map(str::to_string))
            .filter(|mode| WEB_MODES.contains(&mode.as_str()))
            .unwrap_or_else(|| "access".into())
    }

    /// pi-web-access is in KDJ's pi directory: pi lists it in that directory's settings.json.
    fn access_installed(&self) -> bool {
        read_object(&self.paths.agent.join("settings.json"))
            .ok()
            .and_then(|settings| settings.get("packages").cloned())
            .and_then(|packages| packages.as_array().cloned())
            .is_some_and(|packages| {
                packages.iter().any(|package| {
                    package.as_str().or_else(|| package["source"].as_str()).is_some_and(|source| source.contains("pi-web-access"))
                })
            })
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
        // Jina's key lives beside the providers' in auth.json but is not one of them.
        providers.retain(|provider| provider["id"] != "jina");
        json!({
            "pi": pi,
            "providers": providers,
            "provider": choice.provider,
            "model": choice.model,
            "running": running,
            "web": {
                "mode": self.web_mode(),
                "access": self.access_installed(),
                "installing": self.installing.load(Ordering::Relaxed),
                "error": self.install_error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
                "jina": configured.iter().any(|id| id == "jina"),
            },
            "thinking": self.thinking(),
            "remotion": {
                "version": self.remotion_version(),
                "installing": self.remotion_installing.load(Ordering::Relaxed),
                "error": self.remotion_error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            },
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
        Ok(process)
    }

    /// KDJ's extension, prompt and skill, written into its pi directory where they differ.
    fn write_extension(&self) -> anyhow::Result<()> {
        let paths = &self.paths;
        write_if_changed(&paths.tools(), TOOLS)?;
        write_if_changed(&paths.web(), WEB)?;
        write_if_changed(&paths.folders(), FOLDERS)?;
        write_if_changed(&paths.video(), VIDEO)?;
        write_if_changed(&paths.prompt(), PROMPT)?;
        write_if_changed(&paths.agent.join("web-search.json"), ACCESS_CONFIG)?;
        for (name, contents) in SKILL {
            write_if_changed(&paths.skill().join(name), contents)?;
        }
        Ok(())
    }

    /// Remotion's version when it is installed in the workspace (its CLI is there to render with).
    fn remotion_version(&self) -> Option<String> {
        let modules = self.paths.remotion().join("node_modules");
        if !modules.join("@remotion").join("cli").join("remotion-cli.js").is_file() {
            return None;
        }
        let package = read_object(&modules.join("remotion").join("package.json")).ok()?;
        package.get("version").and_then(Value::as_str).map(str::to_string)
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
        self.write_extension()?;
        // The browser earlier versions drove is gone, with what it left behind.
        let _ = std::fs::remove_file(paths.agent.join("kdj").join("kdj-browser.ts"));
        let _ = std::fs::remove_dir_all(paths.data.join("ai").join("browser-profile"));
        let web_mode = self.web_mode();

        let choice = self.choice();
        let cli = std::env::var_os("KDJ_CLI_PATH")
            .map(PathBuf::from)
            .or_else(|| std::env::current_exe().ok())
            .unwrap_or_else(|| PathBuf::from("kdj"));
        let mut command = pi::command(&path);
        command
            // Extensions stay on: the only package in KDJ's directory is the one KDJ installs.
            .args(["--mode", "rpc", "--no-skills", "--no-context-files", "--no-builtin-tools"])
            // Add only pi's shell; retain KDJ/web extensions and KDJ's scoped read/write.
            .args(["--tools", "+bash"])
            .arg("--session-dir")
            .arg(&paths.sessions)
            .arg("--extension")
            .arg(paths.tools())
            // The one skill: listed by name, read by the model only for video work.
            .arg("--skill")
            .arg(paths.skill())
            .arg("--append-system-prompt")
            .arg(paths.prompt());
        if let (Some(provider), Some(model)) = (&choice.provider, &choice.model) {
            command.args(["--provider", provider.as_str(), "--model", model.as_str()]);
        }
        command.args(["--thinking", self.thinking().as_str()]);
        if web_mode != "access" && self.access_installed() {
            command.args(["--exclude-tools", ACCESS_TOOLS]);
        }
        command
            .current_dir(&paths.workspace)
            .env("PI_CODING_AGENT_DIR", &paths.agent)
            .env("PI_SKIP_VERSION_CHECK", "1")
            .env("PI_TELEMETRY", "0")
            .env("KDJ_CLI", &cli)
            .env("KDJ_DATA_DIR", &paths.data)
            .env("KDJ_WEB_MODE", &web_mode)
            // The video tools (kdj-video.ts): where they may read and write, and KDJ's FFmpeg.
            .env("KDJ_WORKSPACE", &paths.workspace)
            .env("KDJ_SKILLS", paths.skill())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Without FFmpeg the video tools say so when they run; the rest of the AI works as before.
        if let Ok(ffmpeg) = kdj_providers::ffmpeg::binary() {
            command.env("KDJ_FFMPEG", ffmpeg);
        }
        if let Ok(ffprobe) = kdj_providers::ffmpeg::probe_binary() {
            command.env("KDJ_FFPROBE", ffprobe);
        }
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
            fresh: AtomicBool::new(true),
            resume: AtomicBool::new(false),
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
    /// Pictures that go with the request (pasted, or image files dragged in), by path: the model
    /// sees them with the words.
    #[serde(default)]
    images: Vec<String>,
    /// A supplement to the task under way (or one sent again after a take-back), not a request of
    /// its own: it goes on in the open session.
    #[serde(default)]
    follow: bool,
}

/// A picture is handed to the model at most this wide and tall.
const PROMPT_IMAGE_PX: u32 = 1600;
/// More pictures than this in one request are left out.
const PROMPT_IMAGES: usize = 8;
/// A pasted picture larger than this is refused.
pub const PASTE_BYTES: usize = 30 * 1024 * 1024;

/// One picture for pi's `prompt`: decoded and fitted into PROMPT_IMAGE_PX, as PNG.
fn prompt_image(path: &Path) -> anyhow::Result<Value> {
    use base64::Engine;
    anyhow::ensure!(kdj_providers::workshop_images::is_image_path(path), "不是图片：{}", path.display());
    let png = kdj_providers::workshop_images::frame_png(path, false, 0, PROMPT_IMAGE_PX)?;
    Ok(json!({ "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(png), "mimeType": "image/png" }))
}

pub async fn prompt(State(state): State<Arc<AppState>>, Json(body): Json<PromptBody>) -> ApiResult<Json<Value>> {
    let message = body.message.trim();
    if message.is_empty() {
        return Err(ApiError::bad_request("消息为空"));
    }
    let paths: Vec<PathBuf> = body.images.iter().take(PROMPT_IMAGES).map(PathBuf::from).collect();
    let images = tokio::task::spawn_blocking(move || paths.iter().map(|path| prompt_image(path)).collect::<anyhow::Result<Vec<_>>>())
        .await
        .map_err(anyhow::Error::from)?
        .map_err(|error| ApiError::bad_request(format!("图片读不出来：{error:#}")))?;
    let bridge = bridge(&state);
    let process = bridge.process(&state).await?;
    let mut command = json!({ "type": "prompt", "message": message });
    if !images.is_empty() {
        command["images"] = json!(images);
    }
    // Every request is a session of its own; a supplement joins the open one (steering it while
    // the AI works), and so does the first request after 历史 → 继续.
    let fresh = process.fresh.swap(false, Ordering::Relaxed);
    let resume = process.resume.swap(false, Ordering::Relaxed);
    if process.streaming.load(Ordering::Relaxed) {
        command["streamingBehavior"] = json!("steer");
    } else if !body.follow && !fresh && !resume {
        bridge.new_session(&process).await?;
        process.fresh.store(false, Ordering::Relaxed);
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

/// Takes back the lines still waiting for pi (steering not yet handed to the model); the window
/// sends again the ones the listener kept.
pub async fn clear_queue(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let running = bridge(&state).process.lock().await.clone();
    let Some(process) = running else {
        return Ok(Json(json!({ "steering": [], "followUp": [] })));
    };
    Ok(Json(process.send(json!({ "type": "clear_queue" })).await?))
}

pub async fn reset(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let bridge = bridge(&state);
    let running = bridge.process.lock().await.clone();
    if let Some(process) = running {
        if process.streaming.load(Ordering::Relaxed) {
            process.send(json!({ "type": "abort" })).await?;
        }
        bridge.new_session(&process).await?;
    }
    Ok(Json(json!({})))
}

// ---------------------------------------------------------------- reasoning effort

#[derive(Deserialize)]
pub struct ThinkingBody {
    level: String,
}

/// Sets how hard the model thinks: kept in kdj-ai.json for every start of pi, and given to a pi
/// that runs now, so the next request already thinks this hard.
pub async fn set_thinking(State(state): State<Arc<AppState>>, Json(body): Json<ThinkingBody>) -> ApiResult<Json<Value>> {
    let bridge = bridge(&state);
    if !THINKING_LEVELS.contains(&body.level.as_str()) {
        return Err(ApiError::bad_request(format!("未知的推理强度：{}", body.level)));
    }
    update_object(&bridge.paths.config, |config| {
        config.insert("thinking".into(), json!(body.level));
    })?;
    let running = bridge.process.lock().await.clone();
    if let Some(process) = running {
        process.send(json!({ "type": "set_thinking_level", "level": body.level })).await?;
    }
    let status = bridge.status(false).await;
    state.hub.publish("ai.status", &status);
    Ok(Json(status))
}

// ---------------------------------------------------------------- pasted pictures

/// The file name a pasted picture keeps in the workspace's `pasted/`, by its type.
fn pasted_extension(content_type: &str) -> Option<&'static str> {
    match content_type.split(';').next().unwrap_or("").trim() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/bmp" => Some("bmp"),
        _ => None,
    }
}

/// A picture pasted into Agent Mode: kept in the AI's workspace (`pasted/`), where the AI can use
/// it as a source as well as look at it. Returns its path.
pub async fn paste(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    bytes: axum::body::Bytes,
) -> ApiResult<Json<Value>> {
    let content_type = headers.get(axum::http::header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("");
    let extension = pasted_extension(content_type).ok_or_else(|| ApiError::bad_request("只能粘贴图片"))?;
    if bytes.is_empty() || bytes.len() > PASTE_BYTES {
        return Err(ApiError::bad_request("图片为空或太大"));
    }
    let dir = bridge(&state).paths.workspace.join("pasted");
    std::fs::create_dir_all(&dir).map_err(anyhow::Error::from)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let path = (1..)
        .map(|n| dir.join(if n == 1 { format!("{stamp}.{extension}") } else { format!("{stamp}-{n}.{extension}") }))
        .find(|path| !path.exists())
        .expect("a free name");
    std::fs::write(&path, &bytes).map_err(anyhow::Error::from)?;
    Ok(Json(json!({ "path": path })))
}

// ---------------------------------------------------------------- the history

/// The sessions in KDJ's sessions folder (sessions.rs), and the one the AI is in: the session of
/// the task under way, or the one the next request continues (历史 → 继续). Between tasks there
/// is none, as the next request starts its own.
pub async fn list_sessions(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let bridge = bridge(&state);
    let running = bridge.process.lock().await.clone();
    let current = match running {
        Some(process) if process.streaming.load(Ordering::Relaxed) || process.resume.load(Ordering::Relaxed) => {
            process.send(json!({ "type": "get_state" })).await.ok().and_then(|data| data["sessionId"].as_str().map(str::to_string))
        }
        _ => None,
    };
    let dir = bridge.paths.sessions.clone();
    let listed = tokio::task::spawn_blocking(move || sessions::list(&dir)).await.map_err(anyhow::Error::from)?;
    Ok(Json(json!({ "current": current, "sessions": listed })))
}

#[derive(Deserialize)]
pub struct SessionQuery {
    path: String,
}

/// What was asked and what the AI did in one session.
pub async fn session_detail(State(state): State<Arc<AppState>>, Query(query): Query<SessionQuery>) -> ApiResult<Json<Value>> {
    let bridge = bridge(&state);
    let path = sessions::inside(&bridge.paths.sessions, &query.path).ok_or_else(|| ApiError::bad_request("不是 AI 的会话"))?;
    let steps = tokio::task::spawn_blocking(move || sessions::detail(&path)).await.map_err(anyhow::Error::from)?;
    Ok(Json(json!({ "steps": steps })))
}

/// Goes on with an earlier session: the next request continues it.
pub async fn switch_session(State(state): State<Arc<AppState>>, Json(body): Json<SessionQuery>) -> ApiResult<Json<Value>> {
    let bridge = bridge(&state);
    let path = sessions::inside(&bridge.paths.sessions, &body.path).ok_or_else(|| ApiError::bad_request("不是 AI 的会话"))?;
    let process = bridge.process(&state).await?;
    if process.streaming.load(Ordering::Relaxed) {
        return Err(ApiError::bad_request("AI 正在做事，停下后再切换"));
    }
    process.send(json!({ "type": "switch_session", "sessionPath": path })).await?;
    process.fresh.store(false, Ordering::Relaxed);
    process.resume.store(true, Ordering::Relaxed);
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

// ---------------------------------------------------------------- the web search

/// Installs pi-web-access into KDJ's pi directory, in the background; `ai.status` tells when it
/// is done or why it failed.
pub async fn install_access(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let bridge = bridge(&state);
    let pi = bridge.pi(false).await;
    let Some(path) = pi.path.filter(|_| pi.state == PiState::Ready).map(PathBuf::from) else {
        return Err(ApiError::bad_request("请先安装 pi"));
    };
    if bridge.installing.swap(true, Ordering::Relaxed) {
        return Ok(Json(bridge.status(false).await));
    }
    *bridge.install_error.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
    std::fs::create_dir_all(&bridge.paths.agent).map_err(anyhow::Error::from)?;
    let state = state.clone();
    tokio::spawn(async move {
        let mut command = pi::command(&path);
        command
            .args(["install", ACCESS_PACKAGE])
            .current_dir(&bridge.paths.agent)
            .env("PI_CODING_AGENT_DIR", &bridge.paths.agent)
            .env("PI_SKIP_VERSION_CHECK", "1")
            .env("PI_TELEMETRY", "0")
            .stdin(Stdio::null());
        let error = match tokio::time::timeout(INSTALL_TIMEOUT, command.output()).await {
            Ok(Ok(output)) if output.status.success() && bridge.access_installed() => String::new(),
            Ok(Ok(output)) => {
                let text = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
                text.trim().lines().last().unwrap_or("安装失败").to_string()
            }
            Ok(Err(error)) => error.to_string(),
            Err(_) => "安装超时".to_string(),
        };
        *bridge.install_error.lock().unwrap_or_else(|e| e.into_inner()) = error;
        bridge.installing.store(false, Ordering::Relaxed);
        // pi picks the package up when it starts again.
        bridge.stop().await;
        state.hub.publish("ai.status", &bridge.status(false).await);
    });
    Ok(Json(bridge.status(false).await))
}

// ---------------------------------------------------------------- Remotion

/// Installs Remotion into the workspace's Remotion project with the npm of the node that runs
/// pi, then the browser Remotion renders with; in the background, `ai.status` tells when it is
/// done or why it failed. Installing again updates it.
pub async fn install_remotion(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let bridge = bridge(&state);
    let pi = bridge.pi(false).await;
    let Some(pi_path) = pi.path.filter(|_| pi.state == PiState::Ready).map(PathBuf::from) else {
        return Err(ApiError::bad_request("请先安装 pi"));
    };
    let (Some(npm), Some(node)) = (pi::beside(&pi_path, "npm"), pi::beside(&pi_path, "node")) else {
        return Err(ApiError::bad_request("没有找到 Node.js 的 npm"));
    };
    if bridge.remotion_installing.swap(true, Ordering::Relaxed) {
        return Ok(Json(bridge.status(false).await));
    }
    *bridge.remotion_error.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
    let project = bridge.paths.remotion();
    std::fs::create_dir_all(&project).map_err(anyhow::Error::from)?;
    // A package.json of its own keeps npm from walking up to some other project.
    update_object(&project.join("package.json"), |package| {
        package.entry("name").or_insert_with(|| json!("kdj-ai-remotion"));
        package.entry("private").or_insert_with(|| json!(true));
    })?;
    let state = state.clone();
    state.hub.publish("ai.status", &bridge.status(false).await);
    tokio::spawn(async move {
        let run = |program: &Path, args: Vec<String>| {
            let mut command = pi::command(program);
            command
                .env("PATH", pi::child_path(&pi_path))
                .args(args)
                .current_dir(&project)
                .stdin(Stdio::null());
            command
        };
        let mut install = vec!["install".to_string(), "--no-audit".into(), "--no-fund".into(), "--save-exact".into()];
        install.extend(REMOTION_PACKAGES.iter().map(|p| p.to_string()));
        let cli = project.join("node_modules").join("@remotion").join("cli").join("remotion-cli.js");
        let steps = async {
            for (program, args) in [
                (npm.clone(), install),
                (node.clone(), vec![cli.to_string_lossy().into_owned(), "browser".into(), "ensure".into()]),
            ] {
                let output = run(&program, args).output().await?;
                if !output.status.success() {
                    let text = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
                    anyhow::bail!("{}", text.trim().lines().last().unwrap_or("安装失败"));
                }
            }
            anyhow::Ok(())
        };
        let error = match tokio::time::timeout(REMOTION_TIMEOUT, steps).await {
            Ok(Ok(())) if bridge.remotion_version().is_some() => String::new(),
            Ok(Ok(())) => "安装后没有找到 Remotion".to_string(),
            Ok(Err(error)) => error.to_string(),
            Err(_) => "安装超时".to_string(),
        };
        *bridge.remotion_error.lock().unwrap_or_else(|e| e.into_inner()) = error;
        bridge.remotion_installing.store(false, Ordering::Relaxed);
        state.hub.publish("ai.status", &bridge.status(false).await);
    });
    Ok(Json(bridge.status(false).await))
}

#[derive(Deserialize)]
pub struct WebBody {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    jina_key: Option<String>,
}

/// Chooses how the AI searches the web, and keeps Jina's key.
pub async fn set_web(State(state): State<Arc<AppState>>, Json(body): Json<WebBody>) -> ApiResult<Json<Value>> {
    let bridge = bridge(&state);
    if let Some(mode) = &body.mode {
        if !WEB_MODES.contains(&mode.as_str()) {
            return Err(ApiError::bad_request(format!("未知的搜索方式：{mode}")));
        }
        update_object(&bridge.paths.config, |config| {
            config.insert("web".into(), json!(mode));
        })?;
    }
    if let Some(key) = body.jina_key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
        update_object(&bridge.paths.auth(), |auth| {
            auth.insert("jina".into(), json!({ "type": "api_key", "key": key }));
        })?;
    }
    bridge.stop().await;
    let status = bridge.status(false).await;
    state.hub.publish("ai.status", &status);
    Ok(Json(status))
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

    fn bridge_in(dir: &Path) -> AiBridge {
        AiBridge {
            paths: Paths::new(dir),
            process: tokio::sync::Mutex::new(None),
            detected: Mutex::new(None),
            installing: AtomicBool::new(false),
            install_error: Mutex::new(String::new()),
            remotion_installing: AtomicBool::new(false),
            remotion_error: Mutex::new(String::new()),
        }
    }

    #[test]
    fn the_model_thinks_hard_unless_the_listener_chose_otherwise() {
        let dir = tempfile::tempdir().unwrap();
        let bridge = bridge_in(dir.path());
        assert_eq!(bridge.thinking(), "high");
        update_object(&bridge.paths.config, |config| { config.insert("thinking".into(), json!("low")); }).unwrap();
        assert_eq!(bridge.thinking(), "low");
        update_object(&bridge.paths.config, |config| { config.insert("thinking".into(), json!("ludicrous")); }).unwrap();
        assert_eq!(bridge.thinking(), "high", "a level pi does not know is not passed on");
    }

    #[test]
    fn a_pasted_picture_goes_to_the_model_as_a_png() {
        use base64::Engine;
        // The smallest PNG there is: one transparent pixel.
        let pixel = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pasted.png");
        std::fs::write(&path, pixel).unwrap();
        let image = prompt_image(&path).unwrap();
        assert_eq!((image["type"].as_str(), image["mimeType"].as_str()), (Some("image"), Some("image/png")));
        assert!(!image["data"].as_str().unwrap().is_empty());
        assert!(prompt_image(&dir.path().join("notes.txt")).is_err(), "only pictures go along");
        assert_eq!(pasted_extension("image/jpeg"), Some("jpg"));
        assert_eq!(pasted_extension("image/png; charset=binary"), Some("png"));
        assert_eq!(pasted_extension("text/plain"), None);
    }

    #[test]
    fn remotion_is_installed_when_its_cli_is_in_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let bridge = bridge_in(dir.path());
        assert_eq!(bridge.remotion_version(), None);
        let cli = bridge.paths.remotion().join("node_modules/@remotion/cli");
        std::fs::create_dir_all(&cli).unwrap();
        std::fs::write(cli.join("remotion-cli.js"), "").unwrap();
        let core = bridge.paths.remotion().join("node_modules/remotion");
        std::fs::create_dir_all(&core).unwrap();
        std::fs::write(core.join("package.json"), r#"{"name":"remotion","version":"4.0.300"}"#).unwrap();
        assert_eq!(bridge.remotion_version().as_deref(), Some("4.0.300"));
    }

    #[test]
    fn the_video_skill_and_tools_are_written_beside_the_others() {
        let dir = tempfile::tempdir().unwrap();
        let bridge = bridge_in(dir.path());
        bridge.write_extension().unwrap();
        let skill = std::fs::read_to_string(bridge.paths.skill().join("SKILL.md")).unwrap();
        assert!(skill.starts_with("---\nname: kdj-video\n"), "{skill}");
        for reference in ["kdjv.md", "ffmpeg.md", "remotion.md"] {
            assert!(bridge.paths.skill().join("references").join(reference).is_file(), "{reference}");
        }
        assert!(bridge.paths.agent.join("kdj").join("kdj-video.ts").is_file());
    }

    #[test]
    fn pi_web_access_is_found_in_kdjs_own_settings() {
        let dir = tempfile::tempdir().unwrap();
        let bridge = bridge_in(dir.path());
        assert!(!bridge.access_installed());
        std::fs::create_dir_all(&bridge.paths.agent).unwrap();
        std::fs::write(bridge.paths.agent.join("settings.json"), r#"{"packages":["npm:pi-web-access"]}"#).unwrap();
        assert!(bridge.access_installed());
        std::fs::write(bridge.paths.agent.join("settings.json"), r#"{"packages":[{"source":"npm:pi-web-access@0.42.0"}]}"#).unwrap();
        assert!(bridge.access_installed());
    }

    #[test]
    fn the_web_search_is_pi_web_access_unless_another_is_chosen() {
        let dir = tempfile::tempdir().unwrap();
        let bridge = bridge_in(dir.path());
        assert_eq!(bridge.web_mode(), "access");
        std::fs::create_dir_all(dir.path().join("ai")).unwrap();
        std::fs::write(&bridge.paths.config, r#"{"web":"deepseek-jina"}"#).unwrap();
        assert_eq!(bridge.web_mode(), "deepseek-jina");
        std::fs::write(&bridge.paths.config, r#"{"web":"browser"}"#).unwrap();
        assert_eq!(bridge.web_mode(), "access");
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
