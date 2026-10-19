//! The AI's history (docs/ai-dock.md, the AI drawer's 历史 page): pi keeps every conversation as
//! a JSONL file in KDJ's own sessions folder (`--session-dir`); these are read here, never
//! written. A session is shown as what the listener asked and what the AI did — the AI writes no
//! text of its own, so its steps are its tool calls.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// How many sessions the history lists, newest first.
const LIST_LIMIT: usize = 200;
/// A step's details travel along only while they are small (a search's whole result list does not).
const DETAILS_LIMIT: usize = 4096;
const TITLE_CHARS: usize = 80;

#[derive(Debug, Serialize)]
pub struct Summary {
    pub path: String,
    pub id: String,
    /// When the session began (ISO 8601).
    pub started: String,
    /// When it last changed (Unix ms).
    pub updated: u64,
    /// The first request, cut short.
    pub title: String,
    pub requests: usize,
    pub steps: usize,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step {
    /// What the listener asked, with the names of what they dragged in.
    Request { text: String, attached: Vec<String>, at: String },
    /// One tool call and how it ended.
    Tool { tool: String, args: Value, failed: bool, text: String, details: Value },
}

/// The listener's words without the blocks KDJ adds (aiAttachments.ts, aiStatus.ts), and the
/// titles of what was attached.
fn request_text(raw: &str) -> (String, Vec<String>) {
    // Where the listener was (aiStatus.ts) is for the AI, not part of what they asked.
    let raw = raw.find("<kdj-status>").map_or(raw, |at| &raw[..at]);
    let Some(start) = raw.find("<kdj-attachments>") else {
        return (raw.trim().to_string(), vec![]);
    };
    let block = &raw[start..];
    let titles = block
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|item| item["title"].as_str().map(str::to_string))
        .collect();
    (raw[..start].trim().to_string(), titles)
}

fn message_text(message: &Value) -> String {
    match &message["content"] {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// A line KDJ itself told the AI (the listener changed the page), not a request.
fn is_note(text: &str) -> bool {
    text.starts_with("用户改变了页面：")
}

fn entries(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

/// Every session file under the folder (pi may keep them one level down).
fn files(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut stack = vec![(dir.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_dir() && depth < 2 {
                stack.push((path, depth + 1));
            } else if path.extension().is_some_and(|e| e == "jsonl") {
                out.push(path);
            }
        }
    }
    out
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0)
}

fn summary(path: &Path) -> Option<Summary> {
    let lines = entries(path);
    let header = lines.iter().find(|line| line["type"] == "session")?;
    let mut title = String::new();
    let mut requests = 0;
    let mut steps = 0;
    for line in lines.iter().filter(|line| line["type"] == "message") {
        let message = &line["message"];
        match message["role"].as_str() {
            Some("user") => {
                let text = message_text(message);
                if is_note(&text) {
                    continue;
                }
                requests += 1;
                if title.is_empty() {
                    title = request_text(&text).0.chars().take(TITLE_CHARS).collect();
                }
            }
            Some("toolResult") => steps += 1,
            _ => {}
        }
    }
    // A session pi opened but nothing was asked in is not history.
    if requests == 0 {
        return None;
    }
    Some(Summary {
        path: path.to_string_lossy().into_owned(),
        id: header["id"].as_str().unwrap_or_default().to_string(),
        started: header["timestamp"].as_str().unwrap_or_default().to_string(),
        updated: modified_ms(path),
        title,
        requests,
        steps,
    })
}

/// The sessions in the folder, the most recently changed first.
pub fn list(dir: &Path) -> Vec<Summary> {
    let mut found: Vec<Summary> = files(dir).iter().filter_map(|path| summary(path)).collect();
    found.sort_by(|a, b| b.updated.cmp(&a.updated));
    found.truncate(LIST_LIMIT);
    found
}

/// A session file named by the window, if it is one of the folder's.
pub fn inside(dir: &Path, path: &str) -> Option<PathBuf> {
    let dir = std::fs::canonicalize(dir).ok()?;
    let path = std::fs::canonicalize(path).ok()?;
    (path.starts_with(&dir) && path.extension().is_some_and(|e| e == "jsonl")).then_some(path)
}

/// What was asked and what the AI did, in order.
pub fn detail(path: &Path) -> Vec<Step> {
    let lines = entries(path);
    let mut calls: Vec<(String, String, Value)> = vec![];
    let mut out = vec![];
    for line in lines.iter().filter(|line| line["type"] == "message") {
        let message = &line["message"];
        match message["role"].as_str() {
            Some("user") => {
                let text = message_text(message);
                if is_note(&text) {
                    continue;
                }
                let (text, attached) = request_text(&text);
                out.push(Step::Request { text, attached, at: line["timestamp"].as_str().unwrap_or_default().to_string() });
            }
            Some("assistant") => {
                for block in message["content"].as_array().into_iter().flatten().filter(|block| block["type"] == "toolCall") {
                    calls.push((
                        block["id"].as_str().unwrap_or_default().to_string(),
                        block["name"].as_str().unwrap_or_default().to_string(),
                        block["arguments"].clone(),
                    ));
                }
            }
            Some("toolResult") => {
                let id = message["toolCallId"].as_str().unwrap_or_default();
                let (tool, args) = calls
                    .iter()
                    .find(|(call, _, _)| call == id)
                    .map(|(_, name, args)| (name.clone(), args.clone()))
                    .unwrap_or_else(|| (message["toolName"].as_str().unwrap_or_default().to_string(), Value::Null));
                let details = message.get("details").cloned().unwrap_or(Value::Null);
                let small = serde_json::to_string(&details).map_or(0, |text| text.len()) <= DETAILS_LIMIT;
                out.push(Step::Tool {
                    tool,
                    args,
                    failed: message["isError"].as_bool().unwrap_or(false),
                    text: message_text(message).chars().take(400).collect(),
                    details: if small { details } else { Value::Null },
                });
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = r#"{"type":"session","version":3,"id":"s-1","timestamp":"2026-10-19T08:00:00.000Z","cwd":"/w"}
{"type":"message","id":"a","parentId":null,"timestamp":"2026-10-19T08:00:01.000Z","message":{"role":"system","content":""}}
{"type":"message","id":"b","parentId":"a","timestamp":"2026-10-19T08:00:02.000Z","message":{"role":"user","content":"把这段换成城市夜景\n\n<kdj-attachments>\n{\"kind\":\"video\",\"title\":\"Set A\",\"range\":[83,101]}\n</kdj-attachments>\n\n<kdj-status>\n{\"page\":\"本地曲库\",\"folder\":null,\"playing\":{\"track_id\":7,\"title\":\"Set B\"}}\n</kdj-status>"}}
{"type":"message","id":"c","parentId":"b","timestamp":"2026-10-19T08:00:03.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"kdj_search","arguments":{"text":"city night"}}]}}
{"type":"message","id":"d","parentId":"c","timestamp":"2026-10-19T08:00:04.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"kdj_search","content":[{"type":"text","text":"{}"}],"details":{"items":[]},"isError":false}}
{"type":"message","id":"e","parentId":"d","timestamp":"2026-10-19T08:00:05.000Z","message":{"role":"user","content":"用户改变了页面：用户切到了本地曲库。以用户为准，接着完成任务。"}}
"#;

    #[test]
    fn a_session_is_what_was_asked_and_what_the_ai_did() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("2026_s-1.jsonl");
        std::fs::write(&path, SESSION).unwrap();
        std::fs::write(dir.path().join("empty.jsonl"), r#"{"type":"session","version":3,"id":"s-2","timestamp":"x"}"#).unwrap();
        let listed = list(dir.path());
        assert_eq!(listed.len(), 1, "a session nothing was asked in is not listed");
        assert_eq!(listed[0].title, "把这段换成城市夜景");
        assert_eq!((listed[0].requests, listed[0].steps), (1, 1), "KDJ's own notes are not requests");
        let steps = detail(&path);
        assert!(matches!(&steps[0], Step::Request { text, attached, .. } if text == "把这段换成城市夜景" && attached == &vec!["Set A".to_string()]));
        assert!(matches!(&steps[1], Step::Tool { tool, failed: false, .. } if tool == "kdj_search"));
        assert_eq!(steps.len(), 2);
        assert!(inside(dir.path(), path.to_str().unwrap()).is_some());
        assert!(inside(dir.path(), "/etc/hosts").is_none());
    }
}
