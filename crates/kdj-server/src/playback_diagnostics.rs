//! Intentionally allowlisted export. Never export raw provider responses, signed URLs, paths,
//! cookies, account ids, song payloads, bearer tickets, or free-form log details.
use crate::activity_log::ActivityLogEntry;
use anyhow::{Context, Result};
use serde_json::{json, Value};

fn field<'a>(detail: &'a str, name: &str) -> Option<&'a str> {
    detail.split_whitespace().find_map(|part| {
        part.split_once('=')
            .filter(|(key, _)| *key == name)
            .map(|(_, value)| value)
    })
}
fn allowed_code(code: &str) -> bool {
    matches!(
        code,
        "AUTH_EXPIRED"
            | "RATE_LIMITED"
            | "UPSTREAM_TIMEOUT"
            | "UPSTREAM_TRANSPORT"
            | "INVALID_RESPONSE"
            | "UPSTREAM_ERROR"
            | "ACCOUNT_CHANGED"
            | "MEDIA_UNAVAILABLE"
            | "INVALID_MEDIA"
            | "INVALID_RANGE"
            | "UPSTREAM_HTTP"
            | "MEDIA_ENTITY_CHANGED"
    )
}
fn entry(entry: &ActivityLogEntry) -> Option<Value> {
    let action = match entry.action.as_str() {
        "试听地址申请" | "试听地址已申请" => "preview_resolve",
        "在线音频响应" => "media_response",
        "在线音频读取中断" => "media_read_error",
        "在线音频缓存失败" => "media_cache_error",
        _ => return None,
    };
    let mut value = json!({"time":entry.timestamp,"action":action,"level":entry.level,
        "status":entry.status,"duration_ms":entry.duration_ms,"count":entry.count});
    if let Some(attempt) = field(&entry.detail, "attempt")
        .filter(|s| s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        value["attempt_id"] = json!(attempt);
    }
    if let Some(code) = field(&entry.detail, "code").filter(|s| allowed_code(s)) {
        value["code"] = json!(code);
    }
    if let Some(stage) = field(&entry.detail, "stage")
        .filter(|s| matches!(*s, "resolve" | "media" | "media_read" | "cache"))
    {
        value["stage"] = json!(stage);
    }
    for quality in ["requested", "actual"] {
        if let Some(q) =
            field(&entry.detail, quality).filter(|s| matches!(*s, "flac" | "320" | "128"))
        {
            value[quality] = json!(q);
        }
    }
    Some(value)
}

pub async fn export(state: &crate::state::AppState) -> Result<std::path::PathBuf> {
    let logs = state.activity_log.overview(None, 500);
    let settings = state.config.to_settings();
    let report = json!({"schema":"kdj-playback-diagnostics-v1","generated_at":chrono::Utc::now().to_rfc3339(),
        "version":env!("CARGO_PKG_VERSION"),"os":std::env::consts::OS,
        "requested_quality":settings.stream_quality,"stream_cache_enabled":settings.stream_cache_enabled,
        "scope":"Recent application playback events; not a count of all QQ API/CDN requests and not proof of audible output.",
        "entries":logs.entries.iter().filter_map(entry).collect::<Vec<_>>()});
    let root = state.config.data_dir.join("diagnostics");
    let filename = format!(
        "KDJ-playback-{}-{:08x}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        rand::random::<u32>()
    );
    let bytes = serde_json::to_vec_pretty(&report)?;
    tokio::task::spawn_blocking(move || -> Result<_> {
        use std::io::Write;
        let mut directory = std::fs::DirBuilder::new();
        directory.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory.create(&root).context("创建诊断目录失败")?;
        let path = root.join(filename);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).context("创建诊断文件失败")?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(error.into());
        }
        Ok(path)
    })
    .await
    .context("诊断导出任务失败")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_drops_free_text_urls_cookies_account_and_capability_fields() {
        let log=ActivityLogEntry { id:1,timestamp:"2026-09-21T00:00:00Z".into(),category:crate::activity_log::ActivityCategory::Network,
            level:crate::activity_log::ActivityLevel::Error, action:"在线音频读取中断".into(),
            detail:"stage=media_read attempt=0123456789abcdef code=UPSTREAM_TRANSPORT https://audio.test/a?vkey=SECRET Cookie=HIDDEN musickey=PRIVATE requested=flac actual=320".into(),
            target:"/private/account-token".into(),status:Some(502),duration_ms:Some(10),count:1 };
        let safe = entry(&log).unwrap();
        let text = safe.to_string();
        for secret in ["SECRET", "HIDDEN", "PRIVATE", "account-token", "https://"] {
            assert!(!text.contains(secret));
        }
        assert_eq!(safe["attempt_id"], "0123456789abcdef");
        assert_eq!(safe["code"], "UPSTREAM_TRANSPORT");
        assert_eq!(safe["actual"], "320");
    }
}
