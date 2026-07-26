//! 统一错误响应：`{"detail": "..."}`，和 FastAPI 版一致。
//!
//! 前端 `api.ts` 就是读 `detail` 字段来显示错误的，形状不能变。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

pub struct ApiError {
    pub status: StatusCode,
    pub detail: String,
}

impl ApiError {
    pub fn new(status: StatusCode, detail: impl Into<String>) -> Self {
        ApiError {
            status,
            detail: detail.into(),
        }
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
        (
            self.status,
            Json(serde_json::json!({ "detail": self.detail })),
        )
            .into_response()
    }
}

/// 任何 `anyhow::Error` 默认转成 400。
///
/// 曲库/provider 层抛出来的基本都是"用户给的输入有问题"（越界路径、非法名字、
/// 平台不支持），当成 500 会让前端把它显示成"内部错误"，不利于排查。
impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        ApiError::new(StatusCode::BAD_REQUEST, format!("{err:#}"))
    }
}

pub type ApiResult<T> = std::result::Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

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
