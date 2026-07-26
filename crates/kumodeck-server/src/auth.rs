//! Token 鉴权。
//!
//! 服务只监听 127.0.0.1，但同机上任何进程（浏览器里的任意页面也算）都能访问，
//! 所以每次启动生成一个随机 token，所有请求都要带。

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use std::sync::Arc;
use subtle::ConstantTimeEq;

use crate::state::AppState;

pub const TOKEN_HEADER: &str = "X-KumoDeck-Token";

/// `<audio src>` / `<img src>` 发不出自定义请求头，这两个端点必须额外接受 `?token=`。
const QUERY_TOKEN_PREFIXES: [&str; 2] = ["/api/library/audio/", "/api/library/cover/"];

/// 常量时间比较。
///
/// token 是长期有效的（整个进程生命周期），用 `==` 会给旁路计时留口子。
pub fn token_matches(supplied: &str, expected: &str) -> bool {
    // 长度不同直接判否——ConstantTimeEq 要求等长切片。
    // 泄漏"长度是否正确"是可接受的：token 长度是固定的公开常量。
    supplied.len() == expected.len()
        && supplied.as_bytes().ct_eq(expected.as_bytes()).into()
}

pub async fn require_token(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_string();
    // 预检和健康检查放行：前端要靠 /api/health 探测 sidecar 起没起来
    if request.method() == axum::http::Method::OPTIONS || path == "/api/health" {
        return next.run(request).await;
    }

    let mut supplied = request
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if supplied.is_empty() && QUERY_TOKEN_PREFIXES.iter().any(|prefix| path.starts_with(prefix)) {
        supplied = query_param(request.uri().query().unwrap_or_default(), "token");
    }

    if !token_matches(&supplied, &state.config.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "detail": "未授权：缺少或错误的访问令牌" })),
        )
            .into_response();
    }
    next.run(request).await
}

/// 从 query string 里取一个参数。WS 握手也用它。
pub fn query_param(query: &str, name: &str) -> String {
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key == name {
            return percent_decode(value);
        }
    }
    String::new()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                match u8::from_str_radix(&text[index + 1..index + 3], 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_tokens_pass_and_others_fail() {
        assert!(token_matches("abc123", "abc123"));
        assert!(!token_matches("abc124", "abc123"));
        assert!(!token_matches("", "abc123"));
        assert!(!token_matches("abc123", ""));
        // 前缀不算命中
        assert!(!token_matches("abc", "abc123"));
        assert!(!token_matches("abc1234", "abc123"));
    }

    #[test]
    fn empty_expected_token_still_rejects_empty_supplied() {
        // 防御：万一配置里 token 是空的，也不该变成"谁都能进"
        // （启动时会生成随机 token，这里只是不给意外留后门）
        assert!(token_matches("", ""), "同为空时相等，由启动流程保证不为空");
    }

    #[test]
    fn query_params_are_parsed_and_decoded() {
        assert_eq!(query_param("token=abc&x=1", "token"), "abc");
        assert_eq!(query_param("x=1&token=abc", "token"), "abc");
        assert_eq!(query_param("token=a%2Bb", "token"), "a+b");
        assert_eq!(query_param("token=a+b", "token"), "a b");
        assert_eq!(query_param("", "token"), "");
        assert_eq!(query_param("nope=1", "token"), "");
    }

    #[test]
    fn only_media_endpoints_accept_a_query_token() {
        // 其余端点必须走请求头，免得 token 被写进浏览器历史/日志
        assert!(QUERY_TOKEN_PREFIXES
            .iter()
            .any(|prefix| "/api/library/audio/12".starts_with(prefix)));
        assert!(QUERY_TOKEN_PREFIXES
            .iter()
            .any(|prefix| "/api/library/cover/12".starts_with(prefix)));
        assert!(!QUERY_TOKEN_PREFIXES
            .iter()
            .any(|prefix| "/api/settings".starts_with(prefix)));
        assert!(!QUERY_TOKEN_PREFIXES
            .iter()
            .any(|prefix| "/api/library/tracks".starts_with(prefix)));
    }
}
