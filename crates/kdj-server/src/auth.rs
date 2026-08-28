use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use subtle::ConstantTimeEq;

const CAPABILITY_PREFIX: &str = "/_kdj/";

#[derive(Clone)]
pub(crate) struct Capability(Arc<str>);

impl Capability {
    pub(crate) fn new(token: &str) -> Result<Self, &'static str> {
        let valid = (8..=128).contains(&token.len())
            && token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
        valid
            .then(|| Self(Arc::<str>::from(token)))
            .ok_or("token 必须是 8..=128 位 URL-safe ASCII")
    }

    pub(crate) fn mount_path(&self) -> String {
        format!("{CAPABILITY_PREFIX}{}", self.0)
    }

    fn matches_path(&self, path: &str) -> bool {
        let Some(candidate) = path
            .strip_prefix(CAPABILITY_PREFIX)
            .and_then(|rest| rest.split('/').next())
        else {
            return false;
        };
        candidate.len() == self.0.len() && bool::from(self.0.as_bytes().ct_eq(candidate.as_bytes()))
    }
}

pub(crate) fn random_token() -> String {
    let bytes = rand::random::<[u8; 32]>();
    let mut token = String::with_capacity(bytes.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        token.push(HEX[usize::from(byte >> 4)] as char);
        token.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    token
}

pub(crate) async fn require_capability(
    State(capability): State<Capability>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if capability.matches_path(request.uri().path()) {
        return next.run(request).await;
    }
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "detail": "本地服务鉴权失败" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_random_url_safe_and_256_bit() {
        let first = random_token();
        let second = random_token();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn capability_matches_only_its_first_path_segment() {
        let capability = Capability::new("private-token").unwrap();
        assert!(capability.matches_path("/_kdj/private-token/api/health"));
        assert!(capability.matches_path("/_kdj/private-token/ws"));
        assert!(!capability.matches_path("/api/health"));
        assert!(!capability.matches_path("/_kdj/private-tokeN/api/health"));
        assert!(!capability.matches_path("/_kdj/private-token-suffix/api/health"));
    }
}
