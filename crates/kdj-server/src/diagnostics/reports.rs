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
    // The trail of what the user did is the last 50 of their actions; the errors keep their room.
    let mut surplus = entries.iter().filter(|e| e.category == "action").count().saturating_sub(50);
    entries.retain(|e| {
        let drop = surplus > 0 && e.category == "action";
        surplus -= usize::from(drop);
        !drop
    });
    let left_out = super::repeats();
    if !left_out.is_empty() {
        let message = left_out
            .iter()
            .take(40)
            .map(|(source, count)| format!("{source} ×{count}"))
            .collect::<Vec<_>>()
            .join("\n");
        entries.push(Entry {
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            session: store.session.clone(),
            level: "info".into(),
            category: "diagnostics".into(),
            source: "repeats".into(),
            message: redact::text(&format!("本次运行里同样的记录超过 3 次后只计数，省略了：\n{message}"), 8_000),
        });
    }
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

/// How a report travels. `Usual` is the way every other request of the app goes: the system's
/// certificates, IPv6 or IPv4, HTTP/2 where offered. `Other` is tried once when that cannot
/// connect: HTTP/1.1 to the collector's IPv4 addresses, checked against the Mozilla roots built
/// into KDJ. A phone whose system store lacks the collector's root, or whose VPN drops IPv6 or
/// HTTP/2, still reaches it; the browser on the same phone does, with its own roots and stack.
#[derive(Clone, Copy, PartialEq)]
enum Route {
    Usual,
    Other,
}

async fn client(route: Route) -> reqwest::Result<reqwest::Client> {
    kdj_core::ensure_rustls_ring();
    let builder = reqwest::Client::builder()
        .user_agent(concat!("KDJ/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30));
    if route == Route::Usual {
        return builder.build();
    }
    let roots = webpki_root_certs::TLS_SERVER_ROOT_CERTS
        .iter()
        .filter_map(|der| reqwest::Certificate::from_der(der.as_ref()).ok());
    let mut builder = builder.http1_only().tls_certs_only(roots);
    let host = ENDPOINT
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or_default();
    // No IPv4 address found: the lookup is left to the client, which says why it failed.
    let v4: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host, 443))
        .await
        .map(|addrs| addrs.filter(std::net::SocketAddr::is_ipv4).collect())
        .unwrap_or_default();
    if !v4.is_empty() {
        builder = builder.resolve_to_addrs(host, &v4);
    }
    builder.build()
}

/// What a request that got no answer says: every cause in the chain (DNS, TLS, refused…).
fn cause(error: &reqwest::Error) -> String {
    let mut cause = String::new();
    let mut source: Option<&dyn std::error::Error> = Some(error);
    while let Some(current) = source {
        cause.push_str(if cause.is_empty() { "" } else { "：" });
        cause.push_str(&current.to_string());
        source = current.source();
    }
    cause
}

async fn post(route: Route, body: String) -> Result<reqwest::Response, reqwest::Error> {
    client(route)
        .await?
        .post(ENDPOINT)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
}

async fn send(body: String, expected_id: &str) -> anyhow::Result<String> {
    let mut response = match post(Route::Usual, body.clone()).await {
        Ok(response) => response,
        // A timeout has already waited its 30 seconds: it is not waited for twice.
        Err(first) if first.is_timeout() => anyhow::bail!(
            "上报超时，未自动重试；可手动重试同一报告（{}）",
            cause(&first)
        ),
        Err(first) => match post(Route::Other, body).await {
            Ok(response) => response,
            // Both ways are named: which one failed how is what tells a phone's network apart.
            Err(second) => {
                let kind = if second.is_timeout() { "超时" } else { "连接失败" };
                anyhow::bail!(
                    "上报{kind}，已换 IPv4 / HTTP/1.1 / 内置根证书重试一次；可手动重试同一报告（第一次：{}；第二次：{}）",
                    cause(&first),
                    cause(&second)
                )
            }
        },
    };
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
