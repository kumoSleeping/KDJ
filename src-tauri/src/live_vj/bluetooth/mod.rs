//! Bluetooth connection preparation is separate from audio capture and VJ.
//! The operator, never discovery/reconnection, owns the active DJ selection.
mod protocol;
mod receiver;
mod sender;
mod transport;
use super::{diagnostics::InputStatus, LiveVj};
use anyhow::Result;
use kdj_analysis::alignment::LiveFeatures;
pub use receiver::Receiver;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Instant,
};
use tauri::Manager;
pub use transport::Device;
#[derive(Clone, Default, Serialize)]
pub struct LinkStatus {
    pub state: String,
    pub peer: Option<String>,
    pub error: String,
    pub packets: u64,
    pub bytes: u64,
    pub rtt_ms: Option<f64>,
    pub clock_uncertainty_ms: Option<f64>,
    pub data_age_ms: Option<f64>,
    pub gaps: u64,
}
#[derive(Clone, Serialize)]
pub struct PeerStatus {
    pub device: Device,
    pub selected: bool,
    pub link: LinkStatus,
}
#[derive(Clone, Default, Serialize)]
pub struct ConnectionStatus {
    pub listening: bool,
    pub selected: Option<String>,
    pub incoming: Vec<PeerStatus>,
    pub outgoing: Vec<PeerStatus>,
    pub error: String,
}
pub struct Observation {
    pub query: LiveFeatures,
    pub at: Instant,
    pub generation: u64,
}
#[derive(Default)]
pub struct Inbox {
    pub listening: bool,
    pub error: String,
    pub peers: BTreeMap<String, PeerStatus>,
    pub selected: Option<String>,
    pub lease: u64,
    pub streaming: bool,
    pub epoch: u64,
    pub input: Option<InputStatus>,
    pub latest: Option<Observation>,
    pub received_at: Option<Instant>,
    pub captured_at: Option<Instant>,
}
impl Inbox {
    pub fn reset_source(&mut self) {
        self.epoch += 1;
        self.streaming = false;
        self.input = None;
        self.latest = None;
        self.received_at = None;
        self.captured_at = None;
    }
}
#[derive(Default)]
pub struct Hub {
    pub inbox: Arc<Mutex<Inbox>>,
    senders: Mutex<BTreeMap<String, sender::Sender>>,
}
impl Hub {
    pub fn snapshot(&self) -> ConnectionStatus {
        let inbox = self.inbox.lock().unwrap();
        let mut incoming: Vec<_> = inbox.peers.values().cloned().collect();
        for peer in &mut incoming {
            peer.selected =
                inbox.selected.as_deref() == Some(&peer.link.peer.clone().unwrap_or_default());
        }
        let result = ConnectionStatus {
            listening: inbox.listening,
            selected: inbox.selected.clone(),
            incoming,
            error: inbox.error.clone(),
            ..Default::default()
        };
        drop(inbox);
        ConnectionStatus {
            outgoing: self
                .senders
                .lock()
                .unwrap()
                .values()
                .map(|s| s.shared.lock().unwrap().status.clone())
                .collect(),
            ..result
        }
    }
    pub fn shutdown(&self) {
        for sender in self.senders.lock().unwrap().values() {
            sender.stop();
        }
    }
    pub(super) fn prepare_send(&self, id: &str) -> Result<Arc<Mutex<sender::Shared>>> {
        let senders = self.senders.lock().unwrap();
        let sender = senders
            .get(&device_key(id))
            .ok_or_else(|| anyhow::anyhow!("请先连接目标设备"))?;
        sender.ready()
    }
}
pub(super) fn device_key(id: &str) -> String {
    id.replace([':', '-'], "").to_ascii_uppercase()
}
pub(super) fn route_changed(app: &tauri::AppHandle) {
    let live = app.state::<LiveVj>();
    let epoch = live.connections.inbox.lock().unwrap().epoch;
    let session = live.view.lock().unwrap().session.clone();
    live.present(app, &session, |v| {
        if v.mode == "vj" && v.presentation_epoch < epoch {
            v.presentation_epoch = epoch;
            v.matched = None;
            v.candidate = None;
            v.priority.clear();
            v.output = None;
            if ["matched", "searching"].contains(&v.phase.as_str()) {
                v.phase = "listening".into();
            }
        }
    });
}
pub(super) fn capture(
    app: tauri::AppHandle,
    session: String,
    input: super::audio_input::Selection,
    shared: Arc<Mutex<sender::Shared>>,
    cancel: Arc<AtomicBool>,
) {
    sender::capture(app, session, input, shared, cancel);
}

static SCAN_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[tauri::command]
pub async fn live_vj_bluetooth_scan(
    window: tauri::WebviewWindow,
    live: tauri::State<'_, LiveVj>,
    inquiry: Option<bool>,
) -> Result<Vec<Device>, String> {
    super::main_window(&window)?;
    let inquiry = inquiry.unwrap_or(false);
    // Inquiry shares radio airtime. Cached paired-device listing is harmless;
    // don't start a fresh radio scan during an active performance/stream.
    if inquiry
        && live
            .session
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|s| !s.worker.is_finished())
    {
        return Err("运行中仅可读取已添加设备，请停止后扫描新设备".into());
    }
    let _scan = SCAN_GATE.try_lock().map_err(|_| "蓝牙扫描正在进行")?;
    tauri::async_runtime::spawn_blocking(move || transport::scan(inquiry))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
pub async fn live_vj_bluetooth_connect(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    device: Device,
) -> Result<(), String> {
    super::main_window(&window)?;
    let key = device_key(&device.id);
    if key.len() != 12 || !key.bytes().all(|b| b.is_ascii_hexdigit()) || device.name.len() > 512 {
        return Err("蓝牙设备无效".into());
    }
    if !device.paired {
        return Err("请先通过系统配对添加设备，再刷新设备列表".into());
    }
    let live = app.state::<LiveVj>();
    let _gate = live.gate.lock().await;
    let mut senders = live.connections.senders.lock().unwrap();
    if senders.contains_key(&key) {
        return Ok(());
    }
    if senders.len() >= 8 {
        return Err("最多准备 8 台设备连接".into());
    }
    senders.insert(
        key,
        sender::Sender::connect(app.clone(), device).map_err(|e| format!("{e:#}"))?,
    );
    Ok(())
}
#[tauri::command]
pub async fn live_vj_bluetooth_disconnect(
    window: tauri::WebviewWindow,
    live: tauri::State<'_, LiveVj>,
    id: String,
) -> Result<(), String> {
    super::main_window(&window)?;
    let _gate = live.gate.lock().await;
    let sender = live
        .connections
        .senders
        .lock()
        .unwrap()
        .remove(&device_key(&id));
    tauri::async_runtime::spawn_blocking(move || drop(sender))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn live_vj_bluetooth_select(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: Option<String>,
) -> Result<(), String> {
    super::main_window(&window)?;
    let live = app.state::<LiveVj>();
    let mut inbox = live.connections.inbox.lock().unwrap();
    if !inbox.listening {
        return Err("请先选择蓝牙接收并开始运行".into());
    }
    if let Some(id) = &id {
        if !inbox
            .peers
            .get(id)
            .is_some_and(|p| ["connected", "receiving"].contains(&p.link.state.as_str()))
        {
            return Err("设备尚未连接".into());
        }
    }
    if inbox.selected == id {
        return Ok(());
    }
    inbox.reset_source();
    inbox.lease = if id.is_some() {
        rand::random::<u64>().max(1)
    } else {
        0
    };
    inbox.selected = id;
    drop(inbox);
    route_changed(&app);
    Ok(())
}
#[tauri::command]
pub async fn live_vj_bluetooth_pair(window: tauri::WebviewWindow) -> Result<(), String> {
    super::main_window(&window)?;
    // Pairing credentials and numeric confirmation belong to the OS. Do not
    // invent a silent pairing flow or store Bluetooth link keys in KDJ.
    tauri::async_runtime::spawn_blocking(|| -> Result<(), String> {
        #[cfg(target_os = "macos")]
        let result = std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.BluetoothSettings")
            .status();
        #[cfg(windows)]
        let result = std::process::Command::new("cmd.exe")
            .args(["/C", "start", "", "ms-settings:bluetooth"])
            .status();
        #[cfg(not(any(target_os = "macos", windows)))]
        return Err("此平台不支持蓝牙配对入口".into());
        #[cfg(any(target_os = "macos", windows))]
        {
            if !result.map_err(|e| e.to_string())?.success() {
                return Err("无法打开系统蓝牙设置".into());
            }
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
