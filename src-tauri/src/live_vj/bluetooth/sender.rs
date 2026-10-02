//! Connection lifetime is independent of capture. Heartbeats continue through
//! microphone consent, standby, stop and bounded reconnect attempts.
use super::{
    protocol::*,
    transport::{canceled, Connection, Native},
    Device, LinkStatus, LiveVj, PeerStatus,
};
use crate::live_vj::{audio_input, clock_ms};
use anyhow::{bail, Context, Result};
use kdj_analysis::alignment::LiveFeatureStream;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
struct Packet {
    body: Vec<u8>,
    end: u64,
    at: Instant,
}
struct Stream {
    session: String,
    lease: u64,
    cancel: Arc<AtomicBool>,
    ready: bool,
    queue: VecDeque<Packet>,
}
pub(crate) struct Shared {
    pub status: PeerStatus,
    lease: u64,
    stream: Option<Stream>,
}
pub struct Sender {
    pub(super) shared: Arc<Mutex<Shared>>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Sender {
    pub fn connect(app: tauri::AppHandle, device: Device) -> Result<Self> {
        let shared = Arc::new(Mutex::new(Shared {
            status: PeerStatus {
                device: device.clone(),
                selected: false,
                link: LinkStatus {
                    state: "connecting".into(),
                    peer: Some(device.name.clone()),
                    ..Default::default()
                },
            },
            lease: 0,
            stream: None,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let cancel = stop.clone();
        let state = shared.clone();
        let worker = std::thread::Builder::new()
            .name("vj-rfcomm-connect".into())
            .spawn(move || {
                let mut delay = 2;
                while !cancel.load(Ordering::Relaxed) {
                    let connected_at = Instant::now();
                    let result = connection_loop(&device, &state, &cancel);
                    if connected_at.elapsed() > Duration::from_secs(30) {
                        delay = 2;
                    }
                    let message = result.err().map(|e| format!("{e:#}")).unwrap_or_default();
                    let session = {
                        let mut s = state.lock().unwrap();
                        s.status.selected = false;
                        s.status.link.state = if cancel.load(Ordering::Relaxed) {
                            "disconnected"
                        } else {
                            "reconnecting"
                        }
                        .into();
                        s.status.link.error = message.clone();
                        s.stream.take().map(|stream| {
                            stream.cancel.store(true, Ordering::Relaxed);
                            stream.session
                        })
                    };
                    if let Some(session) = session {
                        app.state::<LiveVj>().update(&session, |v| {
                            v.phase = "failed".into();
                            v.error = message.clone();
                        });
                    }
                    let deadline = Instant::now() + Duration::from_secs(delay);
                    while !cancel.load(Ordering::Relaxed) && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    delay = (delay * 2).min(30);
                }
            })?;
        Ok(Self {
            shared,
            stop,
            worker: Some(worker),
        })
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(stream) = &self.shared.lock().unwrap().stream {
            stream.cancel.store(true, Ordering::Relaxed);
        }
    }
    pub fn ready(&self) -> Result<Arc<Mutex<Shared>>> {
        let s = self.shared.lock().unwrap();
        anyhow::ensure!(
            s.status.link.state == "connected",
            "请先连接设备并等待握手完成"
        );
        anyhow::ensure!(s.status.selected, "请先在接收端将本设备指定为当前 DJ");
        Ok(self.shared.clone())
    }
}
impl Drop for Sender {
    fn drop(&mut self) {
        self.stop();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn connection_loop(device: &Device, shared: &Mutex<Shared>, cancel: &AtomicBool) -> Result<()> {
    let mut connection = Connection::new(Native::connect(&device.id, cancel)?);
    connection.send(HELLO, &hello(1), cancel)?;
    let start = Instant::now();
    loop {
        canceled(cancel)?;
        anyhow::ensure!(start.elapsed() < Duration::from_secs(6), "KDJ 蓝牙握手超时");
        if let Some((kind, body)) = connection.receive()? {
            anyhow::ensure!(kind == HELLO, "对方不是 KDJ 接收端");
            check_hello(&body, 2)?;
            break;
        }
    }
    {
        let mut s = shared.lock().unwrap();
        s.status.link.state = "connected".into();
        s.status.link.error.clear();
        s.status.selected = false;
    }
    let mut seen = Instant::now();
    let mut pending: Option<(u64, Instant)> = None;
    let mut streaming: Option<u64> = None;
    loop {
        canceled(cancel)?;
        anyhow::ensure!(
            seen.elapsed() < Duration::from_secs(6),
            "蓝牙接收端心跳超时"
        );
        anyhow::ensure!(
            pending.is_none_or(|(_, sent)| sent.elapsed() < Duration::from_millis(1500)),
            "蓝牙发送积压，已停止发送并重新连接"
        );
        if let Some((kind, body)) = connection.receive()? {
            seen = Instant::now();
            match kind {
                PING => pong(&mut connection, body, cancel)?,
                ACK => {
                    let end = u64::from_le_bytes(body.as_slice().try_into()?);
                    anyhow::ensure!(
                        pending.is_some_and(|(expected, _)| expected == end),
                        "蓝牙应答序号无效"
                    );
                    pending = None;
                }
                SELECT => {
                    anyhow::ensure!(body.len() == 9 && body[0] <= 1, "DJ 选择消息无效");
                    let mut s = shared.lock().unwrap();
                    s.status.selected = body[0] == 1;
                    s.lease = u64::from_le_bytes(body[1..].try_into()?);
                    if let Some(stream) = &s.stream {
                        if !s.status.selected || stream.lease != s.lease {
                            stream.cancel.store(true, Ordering::Relaxed);
                        }
                    }
                }
                _ => bail!("蓝牙接收端消息无效"),
            }
        }
        let (wanted, packet) = {
            let mut s = shared.lock().unwrap();
            let selected = s.status.selected;
            let wanted = s
                .stream
                .as_ref()
                .filter(|stream| {
                    stream.ready
                        && !stream.cancel.load(Ordering::Relaxed)
                        && selected
                        && stream.lease == s.lease
                })
                .map(|stream| stream.lease);
            let packet = if wanted.is_some() && pending.is_none() {
                s.stream
                    .as_mut()
                    .and_then(|stream| stream.queue.pop_front())
            } else {
                None
            };
            (wanted, packet)
        };
        if wanted != streaming {
            let mut message = vec![u8::from(wanted.is_some())];
            message.extend(wanted.or(streaming).unwrap_or(0).to_le_bytes());
            connection.send(STREAM, &message, cancel)?;
            streaming = wanted;
            shared.lock().unwrap().status.link.state = if wanted.is_some() {
                "sending"
            } else {
                "connected"
            }
            .into();
        }
        if let Some(packet) = packet.filter(|p| p.at.elapsed() < Duration::from_millis(500)) {
            connection.send(FEATURES, &packet.body, cancel)?;
            pending = Some((packet.end, Instant::now()));
            let mut s = shared.lock().unwrap();
            s.status.link.packets += 1;
            s.status.link.bytes += packet.body.len() as u64 + 5;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
pub(super) fn reserve(
    shared: &Mutex<Shared>,
    session: &str,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let mut s = shared.lock().unwrap();
    anyhow::ensure!(
        s.status.selected && s.status.link.state == "connected",
        "设备尚未连接或未被指定为当前 DJ"
    );
    anyhow::ensure!(s.stream.is_none(), "当前发送尚未结束");
    s.stream = Some(Stream {
        session: session.into(),
        lease: s.lease,
        cancel,
        ready: false,
        queue: VecDeque::new(),
    });
    Ok(())
}
pub(super) fn capture(
    app: tauri::AppHandle,
    session: String,
    input: audio_input::Selection,
    shared: Arc<Mutex<Shared>>,
    cancel: Arc<AtomicBool>,
) {
    let result = canceled(&cancel)
        .and_then(|_| reserve(&shared, &session, cancel.clone()))
        .and_then(|_| capture_inner(&app, &session, &input, &shared, &cancel));
    {
        let mut s = shared.lock().unwrap();
        if s.stream.as_ref().is_some_and(|s| s.session == session) {
            s.stream = None;
        }
    }
    app.state::<LiveVj>().update(&session, |v| {
        if v.phase != "failed" {
            v.phase = if cancel.load(Ordering::Relaxed) {
                "stopped"
            } else {
                "failed"
            }
            .into();
        }
        if !cancel.load(Ordering::Relaxed) {
            if let Err(error) = result {
                v.error = format!("{error:#}");
            }
        }
    });
}
fn capture_inner(
    app: &tauri::AppHandle,
    session: &str,
    input: &audio_input::Selection,
    shared: &Mutex<Shared>,
    cancel: &AtomicBool,
) -> Result<()> {
    let _ = clock_ms();
    app.state::<LiveVj>()
        .update(session, |v| v.phase = "permission".into());
    let (_capture, ring) = audio_input::Capture::start(input)?;
    canceled(cancel)?;
    let lease = {
        let mut s = shared.lock().unwrap();
        anyhow::ensure!(s.status.selected, "当前 DJ 已切换");
        let stream = s.stream.as_mut().context("发送已取消")?;
        stream.ready = true;
        stream.lease
    };
    app.state::<LiveVj>()
        .update(session, |v| v.phase = "sending".into());
    let mut features = LiveFeatureStream::new(100);
    let mut generation = 0;
    let mut captured = Instant::now();
    let mut seen = Instant::now();
    let mut sent = Instant::now();
    let mut published = Instant::now() - Duration::from_secs(1);
    loop {
        canceled(cancel)?;
        let (packet, status) = {
            let mut ring = ring.lock().unwrap();
            if let Some(error) = &ring.error {
                bail!("{error}");
            }
            (ring.take(), ring.status())
        };
        if let Some((pcm, at, next)) = packet {
            if next != generation {
                features.reset();
                generation = next;
            }
            features.push(&pcm, &|| cancel.load(Ordering::Relaxed))?;
            captured = at;
            seen = Instant::now();
        }
        anyhow::ensure!(seen.elapsed() < Duration::from_secs(3), "声音输入已断流");
        if sent.elapsed() >= Duration::from_millis(50) {
            if let Some((chunk, first, tail)) = features.take_committed() {
                let at = captured - Duration::from_secs_f64(tail);
                let mut body = Vec::with_capacity(8192);
                body.extend(lease.to_le_bytes());
                body.extend(generation.to_le_bytes());
                body.extend(first.to_le_bytes());
                body.extend((clock_ms() - at.elapsed().as_secs_f64() * 1000.).to_le_bytes());
                body.extend((status.rms_dbfs.unwrap_or(-120.) as f32).to_le_bytes());
                body.extend((status.peak_dbfs.unwrap_or(-120.) as f32).to_le_bytes());
                let end = first + chunk.frame_count() as u64;
                chunk.write_to(&mut body)?;
                let mut s = shared.lock().unwrap();
                let stream = s.stream.as_mut().context("连接已中断")?;
                if stream.queue.len() >= 16 {
                    stream.queue.pop_front();
                }
                stream.queue.push_back(Packet { body, end, at });
                sent = Instant::now();
            }
        }
        if published.elapsed() >= Duration::from_millis(250) {
            let link = shared.lock().unwrap().status.link.clone();
            app.state::<LiveVj>().update(session, |v| {
                v.input = Some(status);
                v.bluetooth = Some(link);
            });
            published = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
