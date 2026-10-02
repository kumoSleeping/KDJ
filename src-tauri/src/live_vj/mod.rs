//! Live VJ owns its Set document, native output window and a single cancellable
//! matching session. It never edits the mixing workshop's projects.
#[cfg(target_os = "macos")]
mod capture;
mod audio_input;
#[cfg(target_os = "macos")]
mod output_tap;
pub(crate) mod bluetooth;
mod feature_input;
pub(crate) mod projection;
mod diagnostics;
mod display;
mod document;
mod index;
mod runtime;
use super::Bridge;
use diagnostics::{
    Diagnostics, InputStatus, Level, ListenerStatus, LogEntry, OutputMetrics, OutputState,
    OutputStatus, ScanResult, Stage,
};
use document::{Document, Entry, Store};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.
}
fn clock_ms() -> f64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    ORIGIN.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.
}
#[derive(Clone, Serialize)]
pub struct Match {
    pub entry: Entry,
    pub position: f64,
    pub observed_at_ms: f64,
    pub clock_at_ms: f64,
    pub rate: f64,
    /// Acoustic similarity and competitor margin, not calibrated probabilities.
    pub confidence: f64,
    pub margin: f64,
    pub rate_confidence: f64,
    /// Rescue owns discontinuities. Fine corrections never advance this revision.
    pub lock_revision: u64,
}
#[derive(Clone, Default, Serialize)]
pub struct View {
    pub session: String,
    pub mode: String,
    pub bluetooth: Option<bluetooth::LinkStatus>,
    pub connections: bluetooth::ConnectionStatus,
    pub presentation_epoch: u64,
    pub input_device: String,
    pub input_channel_start: u16,
    pub send_target: Option<String>,
    pub standby: Option<document::Standby>,
    pub projection_open: bool,
    pub projection_error: String,
    pub revision: u64,
    pub clock_ms: f64,
    pub set_id: String,
    pub phase: String,
    pub error: String,
    pub indexed: usize,
    pub total: usize,
    pub preparing: Option<String>,
    pub matched: Option<Match>,
    pub candidate: Option<Match>,
    pub priority: Vec<String>,
    pub scan: u64,
    pub scan_ms: f64,
    pub rescue: Option<ListenerStatus>,
    pub tracking: Option<ListenerStatus>,
    pub scanned: Vec<ScanResult>,
    pub scanning: Option<String>,
    pub input: Option<InputStatus>,
    pub output: Option<OutputStatus>,
}
#[derive(Serialize)]
pub struct Status {
    #[serde(flatten)]
    view: View,
    logs: Vec<LogEntry>,
}
struct Session {
    cancel: Arc<AtomicBool>,
    worker: std::thread::JoinHandle<()>,
}
#[derive(Default)]
pub struct LiveVj {
    store: Mutex<Option<Store>>,
    view: Mutex<View>,
    diagnostics: Mutex<Diagnostics>,
    prepared: Mutex<Option<Arc<index::PreparedSet>>>,
    session: Mutex<Option<Session>>,
    gate: tokio::sync::Mutex<()>,
    connections: bluetooth::Hub,
    projection_target: Mutex<Option<String>>,
}
impl LiveVj {
    pub fn shutdown_connections(&self) { self.connections.shutdown(); }
    fn with_store<T>(
        &self,
        data: &std::path::Path,
        f: impl FnOnce(&mut Store) -> anyhow::Result<T>,
    ) -> Result<T, String> {
        let mut store = self.store.lock().unwrap();
        if store.is_none() {
            *store = Some(Store::open(data).map_err(|e| format!("{e:#}"))?);
        }
        f(store.as_mut().unwrap()).map_err(|e| format!("{e:#}"))
    }
    fn update(&self, id: &str, edit: impl FnOnce(&mut View)) {
        let mut v = self.view.lock().unwrap();
        if v.session == id && v.phase != "stopped" {
            edit(&mut v);
            v.revision += 1;
        }
    }
    fn present(&self, app: &tauri::AppHandle, id: &str, edit: impl FnOnce(&mut View)) {
        let snapshot = {
            let mut view = self.view.lock().unwrap();
            if view.session != id || view.phase == "stopped" {
                return;
            }
            edit(&mut view);
            view.revision += 1;
            view.clock_ms = clock_ms();
            view.clone()
        };
        if let Err(error) = app.emit_to("live-vj-output", "live-vj-presentation", snapshot) {
            self.log(
                id,
                Level::Warn,
                Stage::Output,
                format!("即时输出通知失败，回退轮询：{error}"),
            );
        }
    }
    fn log(&self, session: &str, level: Level, stage: Stage, message: String) {
        self.diagnostics
            .lock()
            .unwrap()
            .push(session, level, stage, message);
    }
    fn invalidate_prepared(&self) {
        self.prepared.lock().unwrap().take();
        let mut view = self.view.lock().unwrap();
        if view.phase == "prepared" {
            view.phase.clear();
            view.indexed = 0;
            self.log(
                &view.session,
                Level::Info,
                Stage::Index,
                "Set 已修改，预处理索引已失效".into(),
            );
        }
    }
    pub fn cancel(&self) {
        if let Some(s) = self.session.lock().unwrap().as_ref() {
            s.cancel.store(true, Ordering::Relaxed);
        }
        let mut v = self.view.lock().unwrap();
        if !v.session.is_empty() && v.phase != "stopped" {
            self.log(&v.session, Level::Info, Stage::Session, "会话已停止".into());
        }
        v.phase = "stopped".into();
        if let Some(link) = &mut v.bluetooth { link.state = "stopped".into(); }
        v.scanning = None;
        v.matched = None;
        v.candidate = None;
        v.preparing = None;
        v.output = None;
        v.revision += 1;
        v.clock_ms = clock_ms();
    }
}
fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("此操作仅允许主窗口调用".into());
    }
    Ok(())
}
#[tauri::command]
pub fn live_vj_document(
    window: tauri::WebviewWindow,
    bridge: State<Bridge>,
    live: State<LiveVj>,
) -> Result<Document, String> {
    main_window(&window)?;
    live.with_store(&bridge.config.data_dir, |s| Ok(s.doc.clone()))
}
#[tauri::command]
pub async fn live_vj_edit(
    window: tauri::WebviewWindow,
    bridge: State<'_, Bridge>,
    live: State<'_, LiveVj>,
    revision: u64,
    edit: document::Edit,
) -> Result<Document, String> {
    main_window(&window)?;
    let _gate = live.gate.lock().await;
    if live
        .session
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| !s.worker.is_finished())
    {
        return Err("请先停止实时 VJ 再编辑 Set".into());
    }
    let document = live.with_store(&bridge.config.data_dir, |s| {
        anyhow::ensure!(s.doc.revision == revision, "Set 已更新，请重试");
        let mut next = s.doc.clone();
        next.edit(edit)?;
        s.commit(next)
    })?;
    live.invalidate_prepared();
    Ok(document)
}
#[tauri::command]
pub async fn live_vj_pick_files(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    main_window(&window)?;
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(
            "音视频",
            &[
                "mp4", "m4v", "mkv", "mov", "webm", "mp3", "m4a", "flac", "wav", "aac", "ogg",
                "opus",
            ],
        )
        .pick_files(move |picked| {
            let _ = tx.send(picked);
        });
    let picked = rx.await.map_err(|e| e.to_string())?.unwrap_or_default();
    let bridge = app.state::<Bridge>();
    picked
        .into_iter()
        .map(|p| {
            let path = p.into_path().map_err(|e| e.to_string())?;
            bridge.grant_picked_path(&path);
            Ok(path.to_string_lossy().into_owned())
        })
        .collect()
}
#[tauri::command]
pub async fn live_vj_import(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    set_id: String,
    revision: u64,
    paths: Vec<String>,
    track_ids: Vec<i64>,
) -> Result<Document, String> {
    main_window(&window)?;
    let live = app.state::<LiveVj>();
    let _gate = live.gate.lock().await;
    if live
        .session
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| !s.worker.is_finished())
    {
        return Err("请先停止实时 VJ 再导入素材".into());
    }
    if paths.len() + track_ids.len() > 500 {
        return Err("一次最多导入 500 个素材".into());
    }
    let (base, token, data, accepted) = {
        let b = app.state::<Bridge>();
        let accepted = paths
            .iter()
            .map(|p| b.authorize_existing_path(p, true))
            .collect::<Result<Vec<_>, _>>()?;
        (
            b.base_url.clone(),
            b.auth_token.clone(),
            b.config.data_dir.clone(),
            accepted,
        )
    };
    live.with_store(&data, |s| {
        anyhow::ensure!(s.doc.revision == revision, "Set 已更新，请重试");
        s.doc.set_mut(&set_id)?;
        Ok(())
    })?;
    #[derive(serde::Deserialize)]
    struct Source {
        track: kdj_core::models::Track,
        video: bool,
        audio_offset: f64,
        duration: f64,
    }
    let response = super::local_api_client()?
        .post(format!("{base}/api/live-vj/intake"))
        .bearer_auth(token)
        .json(&serde_json::json!({"paths": accepted, "track_ids": track_ids}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(value
            .get("detail")
            .or_else(|| value.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("素材导入失败")
            .into());
    }
    let sources: Vec<Source> = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let entries = sources
        .into_iter()
        .map(|s| Entry::new(s.track, s.video, s.audio_offset, s.duration))
        .collect::<anyhow::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let document = live.with_store(&data, |s| {
        anyhow::ensure!(s.doc.revision == revision, "Set 已更新，素材未加入，请重试");
        let mut next = s.doc.clone();
        next.set_mut(&set_id)?.entries.extend(entries);
        s.commit(next)
    })?;
    live.invalidate_prepared();
    Ok(document)
}
#[derive(Serialize)]
pub struct Output {
    id: String,
    label: String,
}
fn monitor_id(m: &tauri::Monitor) -> String {
    format!(
        "{}:{}:{}:{}",
        m.position().x,
        m.position().y,
        m.size().width,
        m.size().height
    )
}
// Hardware classification is only an automatic-placement hint. In particular,
// Windows QueryDisplayConfig can fail in remote sessions; manual outputs and
// the local window must remain usable even when this metadata is unavailable.
fn automatic_monitor(monitors: &[tauri::Monitor]) -> Option<String> {
    display::external(monitors).unwrap_or_else(|error| {
        tracing::warn!(%error, "实时 VJ 无法识别外接显示器，自动输出使用本机小窗");
        None
    })
}
#[tauri::command]
pub async fn live_vj_inputs(window: tauri::WebviewWindow) -> Result<Vec<audio_input::InputDevice>, String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(audio_input::devices)
        .await.map_err(|e| e.to_string())?.map_err(|e| format!("{e:#}"))
}
#[tauri::command]
pub fn live_vj_outputs(window: tauri::WebviewWindow) -> Result<Vec<Output>, String> {
    main_window(&window)?;
    let mut choices = vec![
        Output { id: "auto".into(), label: "自动 · 外接优先".into() },
        Output {
            id: "window".into(),
            label: "独立置顶窗口".into(),
        },
        Output {
            id: "fullscreen".into(),
            label: "当前屏幕全屏".into(),
        },
    ];
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let external = automatic_monitor(&monitors);
    choices[0].label = external.as_ref().and_then(|id| monitors.iter().find(|m| monitor_id(m) == *id))
        .map(|m| format!("自动 · {}", m.name().map(String::as_str).unwrap_or("外接显示器")))
        .unwrap_or_else(|| "自动 · 本机小窗".into());
    for monitor in monitors {
        choices.push(Output {
            id: monitor_id(&monitor),
            label: format!("{} · {}×{}", monitor.name().map(String::as_str).unwrap_or("显示器"), monitor.size().width, monitor.size().height),
        });
    }
    Ok(choices)
}
// Keep the native WebView alive between sessions. Force-destroying it on stop
// has crashed WebKit's display-link / scrolling-tree callback on macOS.
// The stopped presentation unmounts the media elements and their observers.
fn hide_output(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("live-vj-output") {
        let snapshot = app.state::<LiveVj>().view.lock().unwrap().clone();
        if let Err(error) = window.emit("live-vj-presentation", snapshot) {
            tracing::warn!(%error, "实时 VJ 停止通知失败，回退状态轮询");
        }
        // Hiding a fullscreen macOS window alone can leave its Space/presentation behind.
        // Restore window mode as part of stop, including native title-bar close requests.
        let fullscreen = window.set_fullscreen(false);
        let always_on_top = window.set_always_on_top(false);
        window.hide().map_err(|e| e.to_string())?;
        fullscreen.map_err(|e| e.to_string())?;
        always_on_top.map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn open_output(app: &tauri::AppHandle, mode: &str) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("主窗口不存在")?;
    let automatic;
    let mode = if mode == "auto" {
        automatic = automatic_monitor(&main.available_monitors().map_err(|e| e.to_string())?)
            .unwrap_or_else(|| "window".into());
        automatic.as_str()
    } else { mode };
    // A new DJ/session on the same screen must not exit/re-enter macOS
    // fullscreen or expose the desktop. Reuse the already-placed window.
    if let Some(window) = app.get_webview_window("live-vj-output") {
        if app.state::<LiveVj>().projection_target.lock().unwrap().as_deref() == Some(mode)
            && window.is_visible().unwrap_or(false)
            && (mode == "window" || window.is_fullscreen().unwrap_or(false)) { return Ok(()); }
    }
    let monitor = if mode == "window" {
        None
    } else if mode == "fullscreen" {
        main.current_monitor().map_err(|e| e.to_string())?
    } else {
        Some(
            main.available_monitors()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|m| monitor_id(m) == mode)
                .ok_or("输出显示器已断开")?,
        )
    };
    if mode != "window" && monitor.is_none() {
        return Err("没有可用显示器".into());
    }
    let window = if let Some(window) = app.get_webview_window("live-vj-output") {
        window
    } else {
        let window = tauri::WebviewWindowBuilder::new(
            app,
            "live-vj-output",
            tauri::WebviewUrl::App("index.html?window=live-vj".into()),
        )
        .title("KDJ · 实时 VJ")
        .background_color(tauri::window::Color(0, 0, 0, 255))
        // This is a standalone output window, not an in-app floating preview.
        .decorations(true)
        .inner_size(800., 450.)
        .min_inner_size(320., 180.)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
        let handle = app.clone();
        let closing = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = handle.clone();
                let window = closing.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = projection::live_vj_projection_close(window, app).await {
                        tracing::error!(%error, "实时 VJ 关闭失败");
                    }
                });
            }
        });
        window
    };
    // Also restore decorations on an already-created output window.
    window.set_decorations(true).map_err(|e| e.to_string())?;
    window
        .set_always_on_top(mode == "window")
        .map_err(|e| e.to_string())?;
    if let Some(monitor) = monitor {
        // Exit a previous fullscreen session before moving to another monitor.
        window.set_fullscreen(false).map_err(|e| e.to_string())?;
        // On macOS Tao converts physical coordinates using the window's CURRENT
        // scale, not the target monitor's. Moving from Retina to a 1x display
        // would halve the destination and leave the output on the built-in panel.
        #[cfg(target_os = "macos")]
        {
            window
                .set_position(monitor.position().to_logical::<f64>(monitor.scale_factor()))
                .map_err(|e| e.to_string())?;
            window
                .set_size(monitor.size().to_logical::<f64>(monitor.scale_factor()))
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(target_os = "macos"))]
        {
            window
                .set_position(*monitor.position())
                .map_err(|e| e.to_string())?;
            window
                .set_size(*monitor.size())
                .map_err(|e| e.to_string())?;
        }
        window.set_fullscreen(true).map_err(|e| e.to_string())?;
    } else {
        window.set_fullscreen(false).map_err(|e| e.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(800., 450.))
            .map_err(|e| e.to_string())?;
        window.center().map_err(|e| e.to_string())?;
    }
    window.show().map_err(|e| e.to_string())?;
    *app.state::<LiveVj>().projection_target.lock().unwrap() = Some(mode.into());
    Ok(())
}
#[tauri::command]
pub async fn live_vj_start(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    set_id: String,
    output: String,
    input: String,
    channel_start: Option<u16>,
) -> Result<View, String> {
    begin_session(window, app, set_id, Some(output), audio_input::Selection {
        device: input, channel_start: channel_start.unwrap_or(0),
    }).await
}
#[tauri::command]
pub async fn live_vj_prepare(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    set_id: String,
) -> Result<View, String> {
    begin_session(window, app, set_id, None, audio_input::Selection {
        device: "auto".into(), channel_start: 0,
    }).await
}
async fn begin_session(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    set_id: String,
    output: Option<String>,
    input: audio_input::Selection,
) -> Result<View, String> {
    main_window(&window)?;
    let input = if output.is_some() {
        tauri::async_runtime::spawn_blocking(move || {
            // Bluetooth is an explicit, mutually exclusive input source.
            if input.device != "bluetooth" {

                input.validate().map_err(|e| format!("{e:#}"))?;
            }
            Ok::<_, String>(input)
        }).await.map_err(|e| e.to_string())??
    } else { input };
    let prepare_only = output.is_none();
    let live = app.state::<LiveVj>();
    let _gate = live.gate.lock().await;
    if live
        .session
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| !s.worker.is_finished())
    {
        return Err("请先停止当前实时 VJ 会话".into());
    }
    let bridge = app.state::<Bridge>();
    let set = live.with_store(&bridge.config.data_dir, |s| {
        Ok(s.doc
            .sets
            .iter()
            .find(|s| s.id == set_id)
            .ok_or_else(|| anyhow::anyhow!("Set 不存在"))?
            .clone())
    })?;
    if set.entries.is_empty() {
        return Err("Set 没有素材".into());
    }
    let standby = projection::load(&app)?;
    let projection_open = output.is_some() || live.view.lock().unwrap().projection_open;
    let session = document::id();
    let view = View {
        session: session.clone(),
        mode: "vj".into(),
        input_device: input.device.clone(), input_channel_start: input.channel_start,
        standby,
        projection_open,
        set_id,
        phase: "indexing".into(),
        total: set.entries.len(),
        ..Default::default()
    };
    {
        let mut state = live.view.lock().unwrap();
        live.diagnostics.lock().unwrap().reset(&session);
        *state = view.clone();
    }
    projection::broadcast(&app);
    if let Some(output) = &output {
        if let Err(error) = open_output(&app, output) {
            let mut state = live.view.lock().unwrap(); state.phase = "failed".into(); state.error = error.clone();
            return Err(error);
        }
    }
    live.log(
        &session,
        Level::Info,
        Stage::Session,
        format!(
            "{} {} · {} 个素材 · 救场监听 + 局部微调 · 0.80–1.25×",
            if prepare_only { "预处理" } else { "开始" },
            set.name,
            set.entries.len()
        ),
    );
    let cache: PathBuf = bridge.config.data_dir.join("cache/live-vj");
    let cancel = Arc::new(AtomicBool::new(false));
    let stop = cancel.clone();
    let handle = app.clone();
    let worker = std::thread::Builder::new()
        .name("live-vj".into())
        .spawn(move || runtime::run(handle, session, set, cache, stop, prepare_only, input))
        .map_err(|e| e.to_string())?;
    *live.session.lock().unwrap() = Some(Session { cancel, worker });
    Ok(view)
}
/// Audio-only sessions share the lifecycle gate, so sending can never open a
/// video output or run alongside recognition/capture from another VJ session.
#[tauri::command]
pub async fn live_vj_send_start(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    input: String,
    channel_start: u16,
    peer: bluetooth::Device,
) -> Result<View, String> {
    main_window(&window)?;
    if !cfg!(any(target_os = "macos", windows)) { return Err("蓝牙发送目前支持 macOS 和 Windows".into()); }
    if peer.id.len() > 32 || peer.name.len() > 512 || peer.id.is_empty() { return Err("蓝牙目标设备无效".into()); }
    if !peer.paired { return Err("请先在系统蓝牙设置中配对这两台电脑，再重新扫描并开始发送".into()); }
    let live = app.state::<LiveVj>();
    let _gate = live.gate.lock().await;
    if live.session.lock().unwrap().as_ref().is_some_and(|s| !s.worker.is_finished()) {
        return Err("请先停止当前运行".into());
    }
    let selection = audio_input::Selection { device: input, channel_start };
    let selection = tauri::async_runtime::spawn_blocking(move || {
        selection.validate().map_err(|e| format!("{e:#}"))?; Ok::<_, String>(selection)
    }).await.map_err(|e| e.to_string())??;
    let session = document::id();
    let cancel = Arc::new(AtomicBool::new(false));
    let shared = live.connections.prepare_send(&peer.id).map_err(|e| format!("{e:#}"))?;
    let previous = live.view.lock().unwrap().clone();
    let view = View {
        standby: previous.standby, projection_open: previous.projection_open,
        input_device: selection.device.clone(), input_channel_start: selection.channel_start,
        send_target: Some(peer.id.clone()),
        session: session.clone(), mode: "send".into(), phase: "connecting".into(),
        bluetooth: Some(bluetooth::LinkStatus { state: "connecting".into(), peer: Some(peer.name.clone()), ..Default::default() }),
        ..Default::default()
    };
    live.diagnostics.lock().unwrap().reset(&session);
    *live.view.lock().unwrap() = view.clone();
    let stop = cancel.clone(); let handle = app.clone();
    let worker = std::thread::Builder::new().name("vj-rfcomm-send".into())
        .spawn(move || bluetooth::capture(handle, session, selection, shared, stop))
        .map_err(|e| {
            let mut failed = live.view.lock().unwrap();
            failed.phase = "failed".into(); failed.error = e.to_string();
            if let Some(link) = &mut failed.bluetooth { link.state = "failed".into(); link.error = e.to_string(); }
            e.to_string()
        })?;
    *live.session.lock().unwrap() = Some(Session { cancel, worker });
    Ok(view)
}
#[tauri::command]
pub async fn live_vj_stop(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if !["main", "live-vj-output"].contains(&window.label()) {
        return Err("窗口无权控制实时 VJ".into());
    }
    tracing::info!(window = window.label(), "live VJ stop requested");
    let live = app.state::<LiveVj>();
    let _gate = live.gate.lock().await;
    stop_session(&app).await
}
// Caller owns the lifecycle gate through stop AND any subsequent window action.
async fn stop_session(app: &tauri::AppHandle) -> Result<(), String> {
    let live = app.state::<LiveVj>();
    live.cancel();
    // Stopping recognition/sending must not expose the venue desktop.
    projection::broadcast(&app);
    let session = live.session.lock().unwrap().take();
    if let Some(session) = session {
        tauri::async_runtime::spawn_blocking(move || session.worker.join())
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| "实时 VJ 工作线程异常".to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn live_vj_status(
    window: tauri::WebviewWindow,
    live: State<LiveVj>,
    after_log_id: Option<u64>,
) -> Result<Status, String> {
    if !["main", "live-vj-output"].contains(&window.label()) {
        return Err("窗口无权读取实时 VJ".into());
    }
    let view = live.view.lock().unwrap();
    let logs = live
        .diagnostics
        .lock()
        .unwrap()
        .since(&view.session, after_log_id);
    let mut snapshot = view.clone();
    snapshot.clock_ms = clock_ms();
    snapshot.connections = live.connections.snapshot();
    Ok(Status {
        view: snapshot,
        logs,
    })
}

#[tauri::command]
pub fn live_vj_output_status(
    window: tauri::WebviewWindow,
    live: State<LiveVj>,
    session: String,
    entry_id: String,
    lock_revision: u64,
    state: OutputState,
    error: Option<String>,
    metrics: Option<OutputMetrics>,
) -> Result<(), String> {
    if window.label() != "live-vj-output" {
        return Err("窗口无权报告实时 VJ 输出".into());
    }
    let mut view = live.view.lock().unwrap();
    if view.session != session || view.phase == "stopped" {
        return Ok(());
    }
    let Some(matched) = view
        .matched
        .as_ref()
        .filter(|m| m.entry.id == entry_id && m.lock_revision == lock_revision)
    else {
        return Ok(());
    };
    let error: String = error.unwrap_or_default().chars().take(1000).collect();
    if metrics.as_ref().is_some_and(|m| {
        m.error_ms.is_some_and(|v| !v.is_finite())
            || !m.frame_gap_ms.is_finite()
            || !m.playback_rate.is_finite()
            || !m.base_rate.is_finite()
            || !m.preparation_ms.is_finite()
            || !m.seek_ms.is_finite()
    }) {
        return Err("画面计时无效".into());
    }
    let reported_at_ms = clock_ms();
    let same = view
        .output
        .as_ref()
        .is_some_and(|old| old.entry_id == entry_id && old.state == state && old.error == error);
    if same
        && (metrics.is_none()
            || view
                .output
                .as_ref()
                .is_some_and(|old| reported_at_ms - old.reported_at_ms < 900.))
    {
        return Ok(());
    }
    let title = &matched.entry.title;
    let (level, message) = match state {
        OutputState::Loading => (Level::Info, format!("加载画面：{title}")),
        OutputState::Ready => (Level::Info, format!("备用画面可切入：{title}")),
        OutputState::Visible => (Level::Info, format!("画面已切入：{title}")),
        OutputState::Failed => (Level::Error, format!("画面输出失败：{title} · {error}")),
    };
    if let Some(m) = &metrics {
        tracing::debug!(target: "kdj_live_vj_probe", session, lock_revision, error_ms = m.error_ms,
            frame_gap_ms = m.frame_gap_ms, seeks = m.seeks, rate_changes = m.rate_changes,
            playback_rate = m.playback_rate, base_rate = m.base_rate,
            preparation_ms = m.preparation_ms, seek_ms = m.seek_ms, attempts = m.attempts,
            visible = state == OutputState::Visible, "presentation");
    }
    // Numerical feedback belongs in the fixed status, not an auto-scrolling log.
    if !same {
        live.log(&session, level, Stage::Output, message);
    }
    view.output = Some(OutputStatus {
        entry_id,
        state,
        error,
        reported_at_ms,
        metrics,
    });
    Ok(())
}
