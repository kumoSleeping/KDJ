//! 统一错误响应：`{"detail": "..."}`，和 FastAPI 版一致。
//!
//! 前端 `api.ts` 就是读 `detail` 字段来显示错误的，形状不能变。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub detail: String,
    pub code: Option<&'static str>,
    pub stage: Option<&'static str>,
    pub attempt_id: Option<String>,
}

impl ApiError {
    pub fn new(status: StatusCode, detail: impl Into<String>) -> Self {
        ApiError {
            status,
            detail: detail.into(),
            code: None, stage: None, attempt_id: None,
        }
    }

    pub fn coded(mut self, code: &'static str) -> Self { self.code = Some(code); self }

    pub fn media_context(mut self, stage: &'static str, attempt: &str) -> Self {
        self.stage = Some(stage);
        self.attempt_id = Some(attempt.chars().filter(char::is_ascii_hexdigit).take(32).collect());
        self
    }

    pub fn not_found(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, detail)
    }

    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, detail)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if self.status.is_server_error() {
            tracing::error!("{} -> {}", self.status, self.detail);
        }
        let mut response = (self.status, Json(serde_json::json!({
            "detail": self.detail, "code": self.code, "stage": self.stage, "attempt_id": self.attempt_id,
        }))).into_response();
        if let Some(attempt) = self.attempt_id.and_then(|s| s.parse().ok()) {
            response.headers_mut().insert("x-kdj-attempt-id", attempt);
        }
        if let Some(code) = self.code {
            response.headers_mut().insert("x-kdj-error-code", axum::http::HeaderValue::from_static(code));
        }
        response
    }
}

/// 任何 `anyhow::Error` 默认转成 400。
///
/// 曲库/provider 层抛出来的基本都是"用户给的输入有问题"（越界路径、非法名字、
/// 平台不支持），当成 500 会让前端把它显示成"内部错误"，不利于排查。
impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        if let Some(error) = err.downcast_ref::<kdj_providers::qqmusic::error::QqError>() {
            return ApiError::new(StatusCode::from_u16(error.status()).unwrap_or(StatusCode::BAD_GATEWAY), error.to_string()).coded(error.code());
        }
        ApiError::new(StatusCode::BAD_REQUEST, format!("{err:#}"))
    }
}

pub type ApiResult<T> = std::result::Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn qq_failures_preserve_status_stage_and_safe_correlation_id() {
        let error = anyhow::Error::new(kdj_providers::qqmusic::error::QqError::RateLimited);
        let response = ApiError::from(error).media_context("resolve", "0123456789abcdef").into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["code"], "RATE_LIMITED"); assert_eq!(value["stage"], "resolve");
        assert_eq!(value["attempt_id"], "0123456789abcdef");
    }

    #[tokio::test]
    async fn error_body_uses_the_detail_field() {
        let response = ApiError::not_found("曲目不存在").into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["detail"], "曲目不存在");
    }

    #[tokio::test]
    async fn anyhow_errors_become_400_with_the_full_chain() {
        let err = anyhow::anyhow!("底层原因").context("上层说明");
        let response = ApiError::from(err).into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let detail = value["detail"].as_str().unwrap();
        assert!(detail.contains("上层说明"), "{detail}");
        assert!(detail.contains("底层原因"), "错误链要完整带出来：{detail}");
    }
}
