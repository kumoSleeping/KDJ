//! One native run-loop owns every inbound channel. Connections are standby
//! until the operator selects a DJ; neither reconnect nor STREAM can select it.
use super::{
    protocol::*,
    transport::{canceled, Connection, Native},
    Inbox, LinkStatus, Observation, PeerStatus,
};
use crate::live_vj::{
    clock_ms,
    diagnostics::{InputState, InputStatus},
    LiveVj,
};
use anyhow::{bail, Context, Result};
use kdj_analysis::alignment::LiveFeatures;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
pub struct Receiver {
    pub inbox: Arc<Mutex<Inbox>>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Receiver {
    pub fn start(app: tauri::AppHandle) -> Result<Self> {
        let inbox = app.state::<LiveVj>().connections.inbox.clone();
        *inbox.lock().unwrap() = Inbox::default();
        let stop = Arc::new(AtomicBool::new(false));
        let cancel = stop.clone();
        let shared = inbox.clone();
        let worker = std::thread::Builder::new()
            .name("vj-rfcomm-receive".into())
            .spawn(move || {
                let mut delay = 2;
                while !cancel.load(Ordering::Relaxed) {
                    let started = Instant::now();
                    let result = run(&app, &shared, &cancel);
                    let mut state = shared.lock().unwrap();
                    state.listening = false;
                    state.reset_source();
                    state.selected = None;
                    for peer in state.peers.values_mut() {
                        peer.link.state = "disconnected".into();
                        peer.selected = false;
                    }
                    if let Err(error) = result {
                        if !cancel.load(Ordering::Relaxed) {
                            state.error = format!("{error:#}；正在重新监听");
                        }
                    }
                    drop(state);
                    super::route_changed(&app);
                    if started.elapsed() > Duration::from_secs(30) {
                        delay = 2;
                    }
                    let deadline = Instant::now() + Duration::from_secs(delay);
                    while !cancel.load(Ordering::Relaxed) && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    delay = (delay * 2).min(30);
                }
            })?;
        Ok(Self {
            inbox,
            stop,
            worker: Some(worker),
        })
    }
}
impl Drop for Receiver {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
struct Peer {
    id: String,
    connection: Connection,
    ready: bool,
    selected: bool,
    streaming: bool,
    lease: u64,
    seen: Instant,
    ping_at: Instant,
    ping: Option<f64>,
    clock: Clock,
    window: LiveFeatures,
    next: Option<(u64, u64)>,
    endpoint: Option<f64>,
    generation: u64,
}
impl Peer {
    fn new(id: String, native: Native) -> Self {
        Self {
            id,
            connection: Connection::new(native),
            ready: false,
            selected: false,
            streaming: false,
            lease: 0,
            seen: Instant::now(),
            ping_at: Instant::now() - Duration::from_secs(2),
            ping: None,
            clock: Clock::default(),
            window: LiveFeatures::default(),
            next: None,
            endpoint: None,
            generation: 1,
        }
    }
    fn reset(&mut self) {
        self.window = LiveFeatures::default();
        self.next = None;
        self.endpoint = None;
        self.generation += 1;
    }
    fn tick(&mut self, shared: &Mutex<Inbox>, cancel: &AtomicBool) -> Result<bool> {
        anyhow::ensure!(
            self.seen.elapsed() < Duration::from_secs(6),
            "蓝牙设备心跳超时"
        );
        let (selected, lease) = {
            let inbox = shared.lock().unwrap();
            (inbox.selected.as_deref() == Some(&self.id), inbox.lease)
        };
        if self.ready && (self.selected != selected || selected && self.lease != lease) {
            let mut grant = vec![u8::from(selected)];
            grant.extend(if selected { lease } else { 0 }.to_le_bytes());
            self.connection.send(SELECT, &grant, cancel)?;
            self.selected = selected;
            self.lease = if selected { lease } else { 0 };
            self.streaming = false;
            self.reset();
            if let Some(peer) = shared.lock().unwrap().peers.get_mut(&self.id) {
                peer.link.state = "connected".into();
            }
        }
        if self.ready && self.ping.is_none() && self.ping_at.elapsed() >= Duration::from_secs(1) {
            let sent = clock_ms();
            self.connection.send(PING, &sent.to_le_bytes(), cancel)?;
            self.ping = Some(sent);
            self.ping_at = Instant::now();
        }
        anyhow::ensure!(
            self.ping.is_none() || self.ping_at.elapsed() < Duration::from_secs(3),
            "蓝牙时钟应答超时"
        );
        let Some((kind, body)) = self.connection.receive()? else {
            return Ok(false);
        };
        self.seen = Instant::now();
        if !self.ready {
            anyhow::ensure!(kind == HELLO, "蓝牙握手失败");
            check_hello(&body, 1)?;
            self.connection.send(HELLO, &hello(2), cancel)?;
            self.connection.send(SELECT, &[0; 9], cancel)?;
            self.ready = true;
            let mut inbox = shared.lock().unwrap();
            let peer = inbox.peers.get_mut(&self.id).context("设备已移除")?;
            peer.link.state = "connected".into();
            peer.link.error.clear();
            return Ok(false);
        }
        match kind {
            PONG => {
                anyhow::ensure!(body.len() == 24, "蓝牙时钟消息无效");
                let t1 = number(&body[..8])?;
                anyhow::ensure!(self.ping == Some(t1), "蓝牙时钟序号无效");
                self.ping = None;
                if self.clock.observe(
                    t1,
                    number(&body[8..16])?,
                    number(&body[16..])?,
                    clock_ms(),
                )? {
                    self.reset();
                }
                if let Some(peer) = shared.lock().unwrap().peers.get_mut(&self.id) {
                    peer.link.rtt_ms = Some(self.clock.rtt);
                    peer.link.clock_uncertainty_ms = Some(self.clock.rtt / 2.);
                }
            }
            STREAM => {
                anyhow::ensure!(body.len() == 9 && body[0] <= 1, "发送状态无效");
                let lease = u64::from_le_bytes(body[1..].try_into()?);
                if !self.selected || lease != self.lease {
                    return Ok(false);
                }
                self.streaming = body[0] == 1;
                self.reset();
                let mut inbox = shared.lock().unwrap();
                if let Some(peer) = inbox.peers.get_mut(&self.id) {
                    peer.link.state = if self.streaming {
                        "receiving"
                    } else {
                        "connected"
                    }
                    .into();
                }
                if inbox.selected.as_deref() == Some(&self.id) && inbox.lease == lease {
                    inbox.reset_source();
                    inbox.streaming = self.streaming;
                    if !self.streaming {
                        inbox.selected = None;
                    }
                    return Ok(true);
                }
            }
            FEATURES => {
                anyhow::ensure!(body.len() >= 52, "蓝牙特征消息过短");
                let lease = u64::from_le_bytes(body[..8].try_into()?);
                let gen = u64::from_le_bytes(body[8..16].try_into()?);
                let first = u64::from_le_bytes(body[16..24].try_into()?);
                let captured = number(&body[24..32])?;
                let rms = f32::from_le_bytes(body[32..36].try_into()?) as f64;
                let peak = f32::from_le_bytes(body[36..40].try_into()?) as f64;
                anyhow::ensure!(
                    rms.is_finite()
                        && peak.is_finite()
                        && (-240. ..=120.).contains(&rms)
                        && (-240. ..=120.).contains(&peak),
                    "输入电平无效"
                );
                let count = u32::from_le_bytes(body[48..52].try_into()?) as usize;
                anyhow::ensure!(
                    (1..=100).contains(&count) && body.len() == 52 + count * 72,
                    "蓝牙特征帧数无效"
                );
                let chunk = LiveFeatures::read_from(&body[40..])?;
                let end = first.checked_add(count as u64).context("特征序号溢出")?;
                self.connection.send(ACK, &end.to_le_bytes(), cancel)?;
                if !self.selected || !self.streaming || lease != self.lease {
                    return Ok(false);
                }
                let Some(offset) = self.clock.offset else {
                    return Ok(false);
                };
                let endpoint = captured + offset;
                let age = clock_ms() - endpoint;
                if age > 750. || age < -100. || self.clock.rtt > 300. {
                    self.reset();
                    let mut inbox = shared.lock().unwrap();
                    inbox.latest = None;
                    if let Some(peer) = inbox.peers.get_mut(&self.id) {
                        peer.link.gaps += 1;
                        peer.link.error = "数据过期或时钟误差过大，正在重新同步".into();
                    }
                    return Ok(false);
                }
                let at = if age >= 0. {
                    Instant::now() - Duration::from_secs_f64(age / 1000.)
                } else {
                    Instant::now() + Duration::from_secs_f64(-age / 1000.)
                };
                let gap = self.next.is_some_and(|n| n != (gen, first))
                    || self
                        .endpoint
                        .is_some_and(|old| (endpoint - old - count as f64 * 10.).abs() > 20.);
                if gap {
                    self.reset();
                }
                self.next = Some((gen, end));
                self.endpoint = Some(endpoint);
                self.window.append(chunk, 100);
                let mut inbox = shared.lock().unwrap();
                // Selection may have changed while a native write was in progress.
                if inbox.selected.as_deref() != Some(&self.id) || inbox.lease != lease {
                    return Ok(false);
                }
                let peer = inbox.peers.get_mut(&self.id).context("设备已移除")?;
                peer.link.packets += 1;
                peer.link.bytes += body.len() as u64 + 5;
                peer.link.data_age_ms = Some(age.max(0.));
                peer.link.error.clear();
                if gap {
                    peer.link.gaps += 1;
                }
                let query = self.window.recent(0.55);
                let input = InputStatus {
                    state: if rms < -70. {
                        InputState::Quiet
                    } else if query.is_some() {
                        InputState::Receiving
                    } else {
                        InputState::Buffering
                    },
                    source: format!("蓝牙接收 · {}", peer.device.name),
                    sample_rate: 8000,
                    channels: vec![],
                    rms_dbfs: Some(rms),
                    peak_dbfs: Some(peak),
                    buffered_seconds: self.window.duration_ms() / 1000.,
                    packet_age_ms: Some(age.max(0.)),
                    packets: peer.link.packets,
                    gaps: peer.link.gaps,
                };
                inbox.input = Some(input);
                inbox.captured_at = Some(at);
                inbox.received_at = Some(Instant::now());
                inbox.latest = query.filter(|_| rms >= -70.).map(|query| Observation {
                    query,
                    at,
                    generation: self.generation,
                });
            }
            _ => bail!("蓝牙消息类型无效"),
        }
        Ok(false)
    }
}
fn run(app: &tauri::AppHandle, shared: &Mutex<Inbox>, cancel: &AtomicBool) -> Result<()> {
    let mut listener = Native::listen()?;
    let known = super::transport::scan(false).unwrap_or_default();
    {
        let mut inbox = shared.lock().unwrap();
        inbox.listening = true;
        inbox.error.clear();
    }
    let mut peers: Vec<Peer> = Vec::new();
    loop {
        canceled(cancel)?;
        if let Some((native, id)) = listener.accept()? {
            if peers.len() < 8 && !peers.iter().any(|p| p.id == id) {
                let device = known
                    .iter()
                    .find(|d| super::device_key(&d.id) == super::device_key(&id))
                    .cloned()
                    .unwrap_or(super::Device {
                        id: id.clone(),
                        name: id.clone(),
                        paired: true,
                    });
                let mut inbox = shared.lock().unwrap();
                if inbox.peers.len() >= 32 {
                    if let Some(key) = inbox
                        .peers
                        .iter()
                        .find(|(_, p)| p.link.state == "disconnected")
                        .map(|(id, _)| id.clone())
                    {
                        inbox.peers.remove(&key);
                    }
                }
                inbox.peers.insert(
                    id.clone(),
                    PeerStatus {
                        device,
                        selected: false,
                        link: LinkStatus {
                            state: "connecting".into(),
                            peer: Some(id.clone()),
                            ..Default::default()
                        },
                    },
                );
                peers.push(Peer::new(id, native));
            }
        }
        let mut index = 0;
        while index < peers.len() {
            match peers[index].tick(shared, cancel) {
                Ok(changed) => {
                    if changed {
                        super::route_changed(app);
                    }
                    index += 1;
                }
                Err(error) => {
                    let peer = peers.remove(index);
                    let mut inbox = shared.lock().unwrap();
                    if let Some(status) = inbox.peers.get_mut(&peer.id) {
                        status.link.state = "disconnected".into();
                        status.link.error = format!("{error:#}");
                    }
                    let changed = inbox.selected.as_deref() == Some(&peer.id);
                    if changed {
                        inbox.selected = None;
                        inbox.reset_source();
                    }
                    drop(inbox);
                    if changed {
                        super::route_changed(app);
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
