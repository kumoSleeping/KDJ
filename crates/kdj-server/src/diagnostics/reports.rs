use super::{redact, Entry, DROPPED, STORE};
use crate::error::{ApiError, ApiResult};
use axum::Json;
use serde::Deserialize;
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

const ENDPOINT: &str = "https://bug.kdj.kumo.ltd/v1/reports";
const MAX_REPORT_BYTES: usize = 256 * 1024;
pub(super) struct Prepared {
    id: String,
    body: String,
    expires: Instant,
    uploading: bool,
    receipt: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareRequest {
    note: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubmitRequest {
    id: String,
}

pub async fn prepare(Json(request): Json<PrepareRequest>) -> ApiResult<Json<serde_json::Value>> {
    let store = STORE
        .get()
        .ok_or_else(|| ApiError::bad_request("诊断日志未初始化"))?;
    let mut pending = store
        .pending
        .lock()
        .map_err(|_| ApiError::bad_request("诊断锁不可用"))?;
    if pending.as_ref().is_some_and(|p| p.uploading) {
        return Err(ApiError::bad_request("报告正在上传"));
    }
    let id = format!("{:032x}", rand::random::<u128>());
    let recent = store
        .recent
        .lock()
        .map_err(|_| ApiError::bad_request("诊断锁不可用"))?;
    // Re-scrub old segments with the current policy; never attach raw kdj.log, databases,
    // settings, media, screenshots, headers, account data, or environment variables.
    let mut entries: Vec<Entry> = recent
        .iter()
        .cloned()
        .map(|mut e| {
            e.message = redact::text(&e.message, 8_000);
            e.source = redact::text(&e.source, 200);
            e.category = redact::text(&e.category, 40);
            e
        })
        .collect();
    let mut report = serde_json::json!({
        "schema":1, "id":id, "app_version":env!("CARGO_PKG_VERSION"),
        "created_at":chrono::Utc::now().to_rfc3339(),
        "os":std::env::consts::OS, "arch":std::env::consts::ARCH,
        "cpu_threads":std::thread::available_parallelism().map_or(0, |n| n.get()),
        "dropped":DROPPED.load(Ordering::Relaxed), "note":redact::text(&request.note, 2_000),
        "entries":[], "omitted":0
    });
    let total = entries.len();
    let body = loop {
        report["omitted"] = (total - entries.len()).into();
        report["entries"] = serde_json::to_value(&entries).map_err(anyhow::Error::from)?;
        let body = serde_json::to_string_pretty(&report).map_err(anyhow::Error::from)?;
        if body.len() <= MAX_REPORT_BYTES {
            break body;
        }
        if entries.is_empty() {
            return Err(ApiError::bad_request("报告过大"));
        }
        entries.remove(0);
    };
    *pending = Some(Prepared {
        id: id.clone(),
        body: body.clone(),
        expires: Instant::now() + Duration::from_secs(15 * 60),
        uploading: false,
        receipt: None,
    });
    Ok(Json(
        serde_json::json!({"id":id,"body":body,"bytes":body.len(),"destination":ENDPOINT}),
    ))
}

/// Deliberately no scheduler, auto-retry, persistent consent setting, or startup invocation.
pub async fn submit(Json(request): Json<SubmitRequest>) -> ApiResult<Json<serde_json::Value>> {
    let store = STORE
        .get()
        .ok_or_else(|| ApiError::bad_request("诊断日志未初始化"))?;
    let body = {
        let mut pending = store
            .pending
            .lock()
            .map_err(|_| ApiError::bad_request("诊断锁不可用"))?;
        let prepared = pending
            .as_mut()
            .filter(|p| p.id == request.id && Instant::now() < p.expires)
            .ok_or_else(|| ApiError::bad_request("预览已过期，请重新生成并核对"))?;
        if let Some(receipt) = &prepared.receipt {
            return Ok(Json(serde_json::json!({"id":receipt})));
        }
        if prepared.uploading {
            return Err(ApiError::bad_request("报告正在上传"));
        }
        prepared.uploading = true;
        prepared.body.clone()
    };
    let result = send(body, &request.id).await;
    if let Ok(mut pending) = store.pending.lock() {
        if let Some(p) = pending.as_mut().filter(|p| p.id == request.id) {
            p.uploading = false;
            if let Ok(id) = &result {
                p.receipt = Some(id.clone());
            }
        }
    }
    result
        .map(|id| Json(serde_json::json!({"id":id})))
        .map_err(ApiError::from)
}

async fn send(body: String, expected_id: &str) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()?;
    let mut response = client
        .post(ENDPOINT)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("上报连接失败或超时，未自动重试；可手动重试同一报告"))?;
    anyhow::ensure!(
        response.status().is_success(),
        "收集器返回 HTTP {}，未自动重试",
        response.status().as_u16()
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(bytes.len() + chunk.len() <= 4096, "收集器回执过大");
        bytes.extend_from_slice(&chunk);
    }
    let receipt: serde_json::Value = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(
        receipt["id"].as_str() == Some(expected_id),
        "收集器回执不匹配"
    );
    Ok(expected_id.to_owned())
}
