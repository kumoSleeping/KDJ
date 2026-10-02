//! Exactly one input owner: native capture OR the explicitly selected Bluetooth
//! source. Local device errors never enable Bluetooth as a fallback.
use super::{
    audio_input::{Capture, Ring, Selection},
    bluetooth::{LinkStatus, Observation, Receiver},
    diagnostics::{InputState, InputStatus},
};
use anyhow::{bail, Result};
use kdj_analysis::alignment::LiveFeatureStream;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
pub struct Input {
    local: Option<(Capture, Arc<Mutex<Ring>>)>,
    remote: Option<Receiver>,
    stream: LiveFeatureStream,
    generation: u64,
}
pub struct Poll {
    pub observation: Option<Observation>,
    pub status: Option<InputStatus>,
    pub bluetooth: Option<LinkStatus>,
    pub feature_ms: f64,
    pub epoch: u64,
    /// Capture continuity break reported by the audio backend since the last poll.
    pub notice: Option<String>,
}
impl Input {
    pub fn start(app: &tauri::AppHandle, selection: &Selection) -> Result<Self> {
        let (local, remote) = if selection.device == "bluetooth" {
            anyhow::ensure!(
                cfg!(any(target_os = "macos", windows)),
                "此平台不支持蓝牙接收"
            );
            (None, Some(Receiver::start(app.clone())?))
        } else {
            (Some(Capture::start(selection)?), None)
        };
        Ok(Self {
            local,
            remote,
            stream: LiveFeatureStream::new(300),
            generation: 0,
        })
    }
    pub fn poll(&mut self, cancel: &AtomicBool) -> Result<Poll> {
        if let Some(receiver) = &self.remote {
            let mut inbox = receiver.inbox.lock().unwrap();
            let link = inbox
                .selected
                .as_ref()
                .and_then(|id| inbox.peers.get(id))
                .map(|p| p.link.clone())
                .unwrap_or_else(|| LinkStatus {
                    state: if inbox.listening {
                        "listening"
                    } else if inbox.error.is_empty() {
                        "connecting"
                    } else {
                        "failed"
                    }
                    .into(),
                    error: inbox.error.clone(),
                    ..Default::default()
                });
            let mut status = inbox.input.clone();
            let age = inbox
                .captured_at
                .map(|at| at.elapsed().as_secs_f64() * 1000.);
            if let Some(status) = &mut status {
                status.packet_age_ms = age;
                if inbox
                    .received_at
                    .is_none_or(|at| at.elapsed() > Duration::from_secs(1))
                {
                    status.state = InputState::Stalled;
                }
            }
            let observation = inbox
                .latest
                .take()
                .filter(|o| o.at.elapsed() <= Duration::from_millis(750))
                .map(|mut o| {
                    o.generation |= 1 << 63;
                    o
                });
            return Ok(Poll {
                observation,
                status,
                bluetooth: Some(LinkStatus {
                    data_age_ms: age,
                    ..link
                }),
                feature_ms: 0.,
                epoch: inbox.epoch,
                notice: None,
            });
        }
        let Some((_, ring)) = &self.local else {
            bail!("没有声音输入");
        };
        let (packet, status, notice) = {
            let mut ring = ring.lock().unwrap();
            if let Some(error) = &ring.error {
                bail!("{error}");
            }
            (ring.take(), ring.status(), ring.notice.take())
        };
        let started = Instant::now();
        let mut observation = None;
        if let Some((pcm, at, generation)) = packet {
            if generation != self.generation {
                self.stream.reset();
                self.generation = generation;
            }
            self.stream.push(&pcm, &|| cancel.load(Ordering::Relaxed))?;
            if !matches!(
                status.state,
                InputState::Quiet | InputState::Stalled | InputState::Waiting
            ) {
                observation = self.stream.recent(0.55).map(|(query, tail)| Observation {
                    query,
                    at: at - Duration::from_secs_f64(tail),
                    generation,
                });
            }
        }
        Ok(Poll {
            observation,
            status: Some(status),
            bluetooth: None,
            feature_ms: started.elapsed().as_secs_f64() * 1000.,
            epoch: 0,
            notice,
        })
    }
}
