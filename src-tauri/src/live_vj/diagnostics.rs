//! Bounded, session-scoped diagnostics. Only metadata is retained, never captured PCM.
use super::now_ms;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

const LOG_LIMIT: usize = 300;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Info,
    Warn,
    Error,
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Session,
    Index,
    Input,
    Scan,
    Decision,
    Output,
}
#[derive(Clone, Serialize)]
pub struct LogEntry {
    pub id: u64,
    pub at_ms: f64,
    pub level: Level,
    pub stage: Stage,
    pub message: String,
}
#[derive(Default)]
pub struct Diagnostics {
    session: String,
    next_id: u64,
    entries: VecDeque<LogEntry>,
}
impl Diagnostics {
    pub fn reset(&mut self, session: &str) {
        self.session = session.into();
        self.entries.clear();
        // IDs remain monotonic across sessions so an in-flight poll cannot reuse a cursor.
    }
    pub fn push(&mut self, session: &str, level: Level, stage: Stage, message: String) {
        if self.session != session {
            return;
        }
        let message: String = message.chars().take(1600).collect();
        self.next_id += 1;
        tracing::debug!(target: "kdj_live_vj", session, ?level, ?stage, %message);
        if self.entries.len() == LOG_LIMIT {
            self.entries.pop_front();
        }
        self.entries.push_back(LogEntry {
            id: self.next_id,
            at_ms: now_ms(),
            level,
            stage,
            message,
        });
    }
    pub fn since(&self, session: &str, after: Option<u64>) -> Vec<LogEntry> {
        match after {
            Some(after) if self.session == session => self
                .entries
                .iter()
                .filter(|entry| entry.id > after)
                .cloned()
                .collect(),
            _ => vec![],
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InputState {
    Waiting,
    Buffering,
    Receiving,
    Quiet,
    Stalled,
}
#[derive(Clone, Serialize)]
pub struct InputChannel {
    pub name: String,
    pub rms_dbfs: f64,
    pub peak_dbfs: f64,
}
#[derive(Clone, Serialize)]
pub struct InputStatus {
    pub state: InputState,
    pub source: String,
    pub sample_rate: u32,
    pub channels: Vec<InputChannel>,
    pub rms_dbfs: Option<f64>,
    pub peak_dbfs: Option<f64>,
    pub buffered_seconds: f64,
    pub packet_age_ms: Option<f64>,
    pub packets: u64,
    pub gaps: u64,
}
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ListenerState {
    #[default]
    Waiting,
    Preparing,
    Retrieving,
    Verifying,
    Quiet,
    Interrupted,
    Tracking,
    Searching,
    Confirming,
    Locked,
}

/// Fixed-position status for the two listeners; measurements are not event logs.
#[derive(Clone, Default, Serialize)]
pub struct ListenerStatus {
    pub state: ListenerState,
    pub target: Option<String>,
    pub runs: u64,
    pub elapsed_ms: f64,
    pub query_seconds: f64,
    pub position: Option<f64>,
    pub rate: Option<f64>,
    pub error_ms: Option<f64>,
}

#[derive(Clone, Serialize)]
pub struct ScanResult {
    pub entry_id: String,
    pub title: String,
    pub block_start: f64,
    pub elapsed_ms: f64,
    pub matched: bool,
    pub reason: String,
}
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputState {
    Loading,
    Ready,
    Visible,
    Failed,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct OutputMetrics {
    pub error_ms: Option<f64>,
    pub frame_gap_ms: f64,
    pub seeks: u64,
    pub rate_changes: u64,
    pub playback_rate: f64,
    pub base_rate: f64,
    pub preparation_ms: f64,
    pub seek_ms: f64,
    pub attempts: u64,
}
#[derive(Clone, Serialize)]
pub struct OutputStatus {
    pub entry_id: String,
    pub state: OutputState,
    pub error: String,
    pub reported_at_ms: f64,
    pub metrics: Option<OutputMetrics>,
}
