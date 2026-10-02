//! Native RFCOMM handles stay on their owning worker (and macOS run loop).
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Clone, Deserialize, Serialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub paired: bool,
}

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::*;
    pub fn scan(_: bool) -> Result<Vec<Device>> {
        bail!("蓝牙音频特征传输目前支持 macOS 和 Windows")
    }
    pub struct Native;
    impl Native {
        pub fn listen() -> Result<Self> {
            bail!("此平台不支持 RFCOMM")
        }
        pub fn connect(_: &str, _: &AtomicBool) -> Result<Self> {
            bail!("此平台不支持 RFCOMM")
        }
        pub fn accept(&mut self) -> Result<Option<(Self, String)>> {
            Ok(None)
        }
        pub fn read(&mut self, _: &mut [u8]) -> Result<usize> {
            bail!("此平台不支持 RFCOMM")
        }
        pub fn write(&mut self, _: &[u8], _: &AtomicBool) -> Result<()> {
            bail!("此平台不支持 RFCOMM")
        }
    }
}
pub use platform::{scan, Native};

pub const MAX_FRAME: usize = 16 * 1024;
pub struct Connection {
    pub native: Native,
    bytes: Vec<u8>,
    partial_since: Option<Instant>,
}
impl Connection {
    pub fn new(native: Native) -> Self {
        Self {
            native,
            bytes: Vec::new(),
            partial_since: None,
        }
    }
    pub fn send(&mut self, kind: u8, body: &[u8], cancel: &AtomicBool) -> Result<()> {
        anyhow::ensure!(body.len() < MAX_FRAME, "蓝牙消息过大");
        let mut frame = Vec::with_capacity(body.len() + 5);
        frame.extend_from_slice(&((body.len() + 1) as u32).to_le_bytes());
        frame.push(kind);
        frame.extend_from_slice(body);
        self.native.write(&frame, cancel)
    }
    fn take_frame(&mut self) -> Result<Option<(u8, Vec<u8>)>> {
        if self.bytes.len() >= 4 {
            let len = u32::from_le_bytes(self.bytes[..4].try_into()?) as usize;
            anyhow::ensure!((1..=MAX_FRAME).contains(&len), "蓝牙消息长度无效");
            if self.bytes.len() >= len + 4 {
                let kind = self.bytes[4];
                let body = self.bytes[5..len + 4].to_vec();
                self.bytes.drain(..len + 4);
                self.partial_since = if self.bytes.is_empty() {
                    None
                } else {
                    Some(Instant::now())
                };
                return Ok(Some((kind, body)));
            }
        }
        Ok(None)
    }
    pub fn receive(&mut self) -> Result<Option<(u8, Vec<u8>)>> {
        if let Some(frame) = self.take_frame()? {
            return Ok(Some(frame));
        }
        anyhow::ensure!(
            self.partial_since
                .is_none_or(|t| t.elapsed() < Duration::from_secs(2)),
            "蓝牙数据积压或消息接收超时"
        );
        let mut buffer = [0; 4096];
        let count = self.native.read(&mut buffer)?;
        if count > 0 {
            self.partial_since.get_or_insert_with(Instant::now);
            self.bytes.extend_from_slice(&buffer[..count]);
            anyhow::ensure!(self.bytes.len() <= MAX_FRAME + 4096, "蓝牙接收缓冲溢出");
        }
        // Decode immediately rather than adding another full sweep of all
        // idle peers before acknowledging the active DJ's feature message.
        self.take_frame()
    }
}
pub fn canceled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        bail!("已停止");
    }
    Ok(())
}
