//! Desktop MIDI input/output. Mapping lives in the frontend JSON; this crate only
//! enumerates CoreMIDI/WinMM/ALSA ports, forwards raw messages, and writes LEDs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub const MESSAGE_EVENT: &str = "midi-message";
pub const DEVICES_EVENT: &str = "midi-devices";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiDevices {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiMessageEvent {
    pub port: String,
    pub bytes: Vec<u8>,
    /// Device callback time in microseconds. Only differences are consumed by the WebView.
    pub timestamp_micros: u64,
}

struct MidiPorts {
    inputs: HashMap<String, MidiInputConnection<()>>,
    outputs: HashMap<String, MidiOutputConnection>,
}

pub struct MidiHub {
    app: AppHandle,
    ports: Mutex<MidiPorts>,
}

impl MidiHub {
    pub fn spawn(app: AppHandle) -> Arc<Self> {
        let hub = Arc::new(Self {
            app,
            ports: Mutex::new(MidiPorts {
                inputs: HashMap::new(),
                outputs: HashMap::new(),
            }),
        });
        hub.sync_ports();
        let poller = Arc::clone(&hub);
        let _ = std::thread::Builder::new()
            .name("kdj-midi".into())
            .spawn(move || loop {
                poller.sync_ports();
                std::thread::sleep(Duration::from_millis(1500));
            });
        hub
    }

    fn snapshot(&self) -> MidiDevices {
        let ports = self.ports.lock().unwrap_or_else(|error| error.into_inner());
        let mut inputs: Vec<String> = ports.inputs.keys().cloned().collect();
        let mut outputs: Vec<String> = ports.outputs.keys().cloned().collect();
        inputs.sort();
        outputs.sort();
        MidiDevices { inputs, outputs }
    }

    fn emit_devices(&self) {
        let devices = self.snapshot();
        if let Err(error) = self.app.emit(DEVICES_EVENT, &devices) {
            tracing::warn!("发送 MIDI 设备列表失败：{error}");
        }
    }

    fn sync_ports(&self) {
        let input_names = match list_input_names() {
            Ok(names) => names,
            Err(error) => {
                tracing::debug!("枚举 MIDI 输入失败：{error}");
                return;
            }
        };
        let output_names = match list_output_names() {
            Ok(names) => names,
            Err(error) => {
                tracing::debug!("枚举 MIDI 输出失败：{error}");
                Vec::new()
            }
        };

        let mut changed = false;
        {
            let mut ports = self.ports.lock().unwrap_or_else(|error| error.into_inner());
            let stale_inputs: Vec<String> = ports
                .inputs
                .keys()
                .filter(|name| !input_names.iter().any(|available| available == *name))
                .cloned()
                .collect();
            for name in stale_inputs {
                ports.inputs.remove(&name);
                tracing::info!("MIDI 输入断开：{name}");
                changed = true;
            }
            let stale_outputs: Vec<String> = ports
                .outputs
                .keys()
                .filter(|name| !output_names.iter().any(|available| available == *name))
                .cloned()
                .collect();
            for name in stale_outputs {
                ports.outputs.remove(&name);
                tracing::info!("MIDI 输出断开：{name}");
                changed = true;
            }

            for name in &input_names {
                if ports.inputs.contains_key(name) {
                    continue;
                }
                match connect_input(self.app.clone(), name) {
                    Ok(connection) => {
                        ports.inputs.insert(name.clone(), connection);
                        tracing::info!("MIDI 输入接入：{name}");
                        changed = true;
                    }
                    Err(error) => tracing::warn!("打开 MIDI 输入 {name} 失败：{error}"),
                }
            }
            for name in &output_names {
                if ports.outputs.contains_key(name) {
                    continue;
                }
                match connect_output(name) {
                    Ok(connection) => {
                        ports.outputs.insert(name.clone(), connection);
                        tracing::info!("MIDI 输出接入：{name}");
                        changed = true;
                    }
                    Err(error) => tracing::warn!("打开 MIDI 输出 {name} 失败：{error}"),
                }
            }
        }
        if changed {
            self.emit_devices();
        }
    }

    fn send(&self, port: Option<String>, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        let mut ports = self.ports.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(name) = port {
            let connection = ports
                .outputs
                .get_mut(&name)
                .ok_or_else(|| format!("MIDI 输出不存在：{name}"))?;
            connection
                .send(&bytes)
                .map_err(|error| format!("发送 MIDI 失败：{error}"))?;
            return Ok(());
        }
        let mut last_error = None;
        let mut sent = false;
        for connection in ports.outputs.values_mut() {
            match connection.send(&bytes) {
                Ok(()) => sent = true,
                Err(error) => last_error = Some(error.to_string()),
            }
        }
        if sent {
            Ok(())
        } else {
            Err(last_error.unwrap_or_else(|| "没有可用的 MIDI 输出".into()))
        }
    }
}

fn ignore_virtual(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("kdj") || lower.contains("iac driver")
}

fn list_input_names() -> Result<Vec<String>, String> {
    let mut midi = MidiInput::new("kdj-midi-scan-in").map_err(|error| error.to_string())?;
    midi.ignore(Ignore::TimeAndActiveSense);
    Ok(midi
        .ports()
        .iter()
        .filter_map(|port| midi.port_name(port).ok())
        .filter(|name| !ignore_virtual(name))
        .collect())
}

fn list_output_names() -> Result<Vec<String>, String> {
    let midi = MidiOutput::new("kdj-midi-scan-out").map_err(|error| error.to_string())?;
    Ok(midi
        .ports()
        .iter()
        .filter_map(|port| midi.port_name(port).ok())
        .filter(|name| !ignore_virtual(name))
        .collect())
}

fn connect_input(app: AppHandle, name: &str) -> Result<MidiInputConnection<()>, String> {
    let mut midi =
        MidiInput::new(&format!("kdj-midi-in-{name}")).map_err(|error| error.to_string())?;
    midi.ignore(Ignore::TimeAndActiveSense);
    let port = midi
        .ports()
        .into_iter()
        .find(|port| midi.port_name(port).ok().as_deref() == Some(name))
        .ok_or_else(|| format!("找不到 MIDI 输入：{name}"))?;
    let port_name = name.to_string();
    midi.connect(
        &port,
        "kdj-midi-in",
        move |timestamp, message, _| {
            if message.is_empty() || message[0] >= 0xf0 {
                return;
            }
            if let Err(error) = app.emit(
                MESSAGE_EVENT,
                MidiMessageEvent {
                    port: port_name.clone(),
                    bytes: message.to_vec(),
                    timestamp_micros: timestamp,
                },
            ) {
                tracing::debug!("转发 MIDI 失败：{error}");
            }
        },
        (),
    )
    .map_err(|error| error.to_string())
}

fn connect_output(name: &str) -> Result<MidiOutputConnection, String> {
    let midi =
        MidiOutput::new(&format!("kdj-midi-out-{name}")).map_err(|error| error.to_string())?;
    let port = midi
        .ports()
        .into_iter()
        .find(|port| midi.port_name(port).ok().as_deref() == Some(name))
        .ok_or_else(|| format!("找不到 MIDI 输出：{name}"))?;
    midi.connect(&port, "kdj-midi-out")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn midi_devices(hub: State<'_, Arc<MidiHub>>) -> MidiDevices {
    hub.snapshot()
}

#[tauri::command]
pub fn midi_send(
    hub: State<'_, Arc<MidiHub>>,
    bytes: Vec<u8>,
    port: Option<String>,
) -> Result<(), String> {
    hub.send(port, bytes)
}
