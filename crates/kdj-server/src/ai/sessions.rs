//! The AI corner's history (docs/ai-dock.md): pi's own session files in `<data>/ai/sessions`,
//! read only to list them. A session is one JSONL file — a header line, then entries; a
//! `session_info` entry may name it, otherwise its first line from the listener does.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

/// How many sessions the history lists, newest first.
const LISTED: usize = 60;
const TITLE_CHARS: usize = 60;

/// The text of a message's content: a string, or the text blocks of an array.
fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn shorten(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= TITLE_CHARS {
        return line;
    }
    let mut short: String = line.chars().take(TITLE_CHARS).collect();
    short.push('…');
    short
}

/// One session file as the history shows it; None when it holds no conversation.
pub fn describe(path: &Path, text: &str) -> Option<Value> {
    let mut id = String::new();
    let mut name = String::new();
    let mut first = String::new();
    let mut messages = 0usize;
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        match entry["type"].as_str() {
            Some("session") => id = entry["id"].as_str().unwrap_or_default().to_string(),
            Some("session_info") => {
                if let Some(value) = entry["name"].as_str().filter(|value| !value.is_empty()) {
                    name = value.to_string();
                }
            }
            Some("message") => {
                let message = &entry["message"];
                if matches!(message["role"].as_str(), Some("user" | "assistant")) {
                    messages += 1;
                }
                if first.is_empty() && message["role"] == "user" {
                    first = content_text(&message["content"]);
                }
            }
            _ => {}
        }
    }
    if messages == 0 {
        return None;
    }
    let updated = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|age| age.as_millis() as u64)
        .unwrap_or(0);
    Some(json!({
        "path": path.display().to_string(),
        "id": id,
        "title": shorten(if name.is_empty() { &first } else { &name }),
        "messages": messages,
        "updated": updated,
    }))
}

fn files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && depth > 0 {
            files(&path, depth - 1, out);
        } else if path.extension().is_some_and(|ext| ext == "jsonl") {
            out.push(path);
        }
    }
}

/// The sessions under `dir` (pi may group them in a folder per working directory).
pub fn list(dir: &Path) -> Vec<Value> {
    let mut paths = Vec::new();
    files(dir, 2, &mut paths);
    let mut sessions: Vec<Value> = paths
        .iter()
        .filter_map(|path| describe(path, &std::fs::read_to_string(path).ok()?))
        .collect();
    sessions.sort_by(|a, b| b["updated"].as_u64().cmp(&a["updated"].as_u64()));
    sessions.truncate(LISTED);
    sessions
}

/// A path the history may open: an existing session file inside `dir`.
pub fn inside(dir: &Path, path: &str) -> Option<PathBuf> {
    let root = dir.canonicalize().ok()?;
    let file = Path::new(path).canonicalize().ok()?;
    (file.starts_with(&root) && file.extension().is_some_and(|ext| ext == "jsonl")).then_some(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-10-19T00:00:00.000Z","cwd":"/w"}
{"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"帮我下载最近新番 FX 战士里的歌","timestamp":1}}
{"type":"message","id":"b","parentId":"a","message":{"role":"assistant","content":[{"type":"text","text":"好"}]}}
"#;

    #[test]
    fn a_session_is_titled_by_its_first_line() {
        let session = describe(Path::new("/nowhere.jsonl"), SESSION).unwrap();
        assert_eq!(session["id"], "s1");
        assert_eq!(session["title"], "帮我下载最近新番 FX 战士里的歌");
        assert_eq!(session["messages"], 2);
    }

    #[test]
    fn a_name_wins_over_the_first_line() {
        let named = format!("{SESSION}{}\n", r#"{"type":"session_info","id":"c","parentId":"b","name":"新番歌曲"}"#);
        assert_eq!(describe(Path::new("/x.jsonl"), &named).unwrap()["title"], "新番歌曲");
    }

    #[test]
    fn an_empty_session_is_not_listed() {
        let header = r#"{"type":"session","version":3,"id":"s2","timestamp":"t","cwd":"/w"}"#;
        assert!(describe(Path::new("/y.jsonl"), header).is_none());
    }

    #[test]
    fn only_session_files_inside_the_directory_open() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("--w--");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("1_s1.jsonl");
        std::fs::write(&file, SESSION).unwrap();
        assert!(inside(dir.path(), &file.display().to_string()).is_some());
        assert!(inside(dir.path(), "/etc/hosts").is_none());
        assert_eq!(list(dir.path()).len(), 1);
    }
}
