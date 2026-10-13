//! Fixed-vocabulary login diagnostics. Never record request bodies, cookie values or page output.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub struct LoginTrace {
    id: String,
    site: &'static str,
    method: &'static str,
    started: Instant,
    stage: Mutex<&'static str>,
    finished: AtomicBool,
}

impl LoginTrace {
    pub fn new(site: &'static str, method: &'static str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let trace = Self {
            id: format!(
                "{now:x}{:08x}{:04x}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ),
            site,
            method,
            started: Instant::now(),
            stage: Mutex::new("start"),
            finished: AtomicBool::new(false),
        };
        trace.step("start");
        trace
    }

    pub fn step(&self, stage: &'static str) {
        *self.stage.lock().unwrap_or_else(|p| p.into_inner()) = stage;
        tracing::info!(target: "kdj::login", attempt_id = %self.id, site = self.site,
            method = self.method, os = std::env::consts::OS, arch = std::env::consts::ARCH, stage,
            elapsed_ms = self.started.elapsed().as_millis() as u64, "account login");
    }

    pub fn browser(&self, browser: &str) {
        // Installed ids and profile names may contain arbitrary user data. Log only the adapter.
        let browser = match browser {
            "Chrome" | "chrome" => "chrome",
            "Edge" | "edge" => "edge",
            "Arc" | "arc" => "arc",
            _ => "other",
        };
        tracing::info!(target: "kdj::login", attempt_id = %self.id, browser, "login browser");
    }

    pub fn detail(&self, stage: &'static str, code: &'static str) {
        tracing::info!(target: "kdj::login", attempt_id = %self.id, stage, code, "login progress");
    }

    pub async fn run<T>(
        &self,
        work: impl std::future::Future<Output = anyhow::Result<T>>,
    ) -> anyhow::Result<T> {
        let result = work.await;
        self.finished.store(true, Ordering::Relaxed);
        let stage = *self.stage.lock().unwrap_or_else(|p| p.into_inner());
        let elapsed_ms = self.started.elapsed().as_millis() as u64;
        match &result {
            Ok(_) => tracing::info!(target: "kdj::login", attempt_id = %self.id, site = self.site,
                method = self.method, stage, elapsed_ms, outcome = "success", "account login complete"),
            Err(error) => {
                tracing::warn!(target: "kdj::login", attempt_id = %self.id, site = self.site,
                method = self.method, os = std::env::consts::OS, stage, elapsed_ms,
                code = failure_code(error, stage), outcome = "failed", "account login failed")
            }
        }
        result
    }
}

impl Drop for LoginTrace {
    fn drop(&mut self) {
        if !self.finished.load(Ordering::Relaxed) {
            let stage = *self.stage.lock().unwrap_or_else(|p| p.into_inner());
            tracing::warn!(target: "kdj::login", attempt_id = %self.id, site = self.site,
                method = self.method, stage, code = "interrupted",
                elapsed_ms = self.started.elapsed().as_millis() as u64, "account login interrupted");
        }
    }
}

fn failure_code(error: &anyhow::Error, stage: &str) -> &'static str {
    // Inspect locally to classify; never format the original error into a log event.
    let text = format!("{error:#}").to_ascii_lowercase();
    if text.contains("403") {
        if stage == "wait_browser_permission" {
            "browser_rejected"
        } else {
            "http_forbidden"
        }
    } else if text.contains("超时") || text.contains("timeout") || text.contains("未及时") {
        "timeout"
    } else if text.contains("javascript") {
        "javascript_permission"
    } else if text.contains("未允许") || text.contains("permission") || text.contains("-1743") {
        "permission_denied"
    } else if text.contains("多个") || text.contains("ambiguous") {
        "ambiguous_account"
    } else if text.contains("其他浏览器") || text.contains("无法核实") {
        "browser_identity"
    } else if text.contains("未登录") || text.contains("尚未登录") || text.contains("sapisid")
    {
        "no_session"
    } else if text.contains("decrypt") || text.contains("解密") || text.contains("应用绑定") {
        "decryption"
    } else if text.contains("断开") {
        "disconnected"
    } else if text.contains("验证")
        || text.contains("核验")
        || text.contains("会话无效")
        || text.contains("已失效")
    {
        "validation"
    } else if text.contains("请求头") {
        "invalid_headers"
    } else {
        "operation_failed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn errors_are_classified_without_returning_arbitrary_secret_text() {
        assert_eq!(
            failure_code(
                &anyhow::anyhow!("403 Cookie: secret"),
                "wait_browser_permission"
            ),
            "browser_rejected"
        );
        assert_eq!(
            failure_code(&anyhow::anyhow!("403"), "validate_account"),
            "http_forbidden"
        );
        assert_eq!(
            failure_code(&anyhow::anyhow!("secret credential value"), "read_profile"),
            "operation_failed"
        );
        assert_eq!(
            failure_code(&anyhow::anyhow!("等待授权超时"), "read_profile"),
            "timeout"
        );
    }
}
