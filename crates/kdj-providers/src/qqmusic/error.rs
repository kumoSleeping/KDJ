//! Stable, credential-free QQ failures. A missing quality is represented by an empty purl,
//! never by swallowing an authorization, rate-limit or transport error.
#[derive(Debug, Clone, thiserror::Error)]
pub enum QqError {
    #[error("登录凭证已过期，请重新扫码")]
    AuthExpired,
    #[error("QQ 音乐请求过于频繁；当前操作已停止且不会自动重试")]
    RateLimited,
    #[error("QQ 音乐请求超时；登录状态已保留")]
    Timeout,
    #[error("QQ 音乐网络连接失败；登录状态已保留")]
    Transport,
    #[error("QQ 音乐响应格式异常")]
    InvalidResponse,
    #[error("QQ 音乐接口返回 code={0}")]
    Upstream(i64),
    #[error("QQ 音乐账号已变化，旧请求已取消")]
    AccountChanged,
    #[error("QQ 音乐没有返回可用音频地址；平台未说明具体原因")]
    Unavailable,
}
impl QqError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::AuthExpired => "AUTH_EXPIRED",
            Self::RateLimited => "RATE_LIMITED",
            Self::Timeout => "UPSTREAM_TIMEOUT",
            Self::Transport => "UPSTREAM_TRANSPORT",
            Self::InvalidResponse => "INVALID_RESPONSE",
            Self::Upstream(_) => "UPSTREAM_ERROR",
            Self::AccountChanged => "ACCOUNT_CHANGED",
            Self::Unavailable => "MEDIA_UNAVAILABLE",
        }
    }
    pub fn status(&self) -> u16 {
        match self {
            Self::AuthExpired => 401,
            Self::RateLimited => 429,
            Self::Timeout => 504,
            Self::AccountChanged => 409,
            Self::Unavailable => 422,
            _ => 502,
        }
    }
}
pub(super) fn business_code(code: i64) -> Result<(), QqError> {
    match code {
        0 => Ok(()),
        1000 | 104400 | 104401 => Err(QqError::AuthExpired),
        2001 => Err(QqError::RateLimited),
        other => Err(QqError::Upstream(other)),
    }
}
pub(super) fn network_error(error: reqwest::Error) -> QqError {
    // Do not include error.url(): signed URLs and API auth parameters are not diagnostic data.
    if error.is_timeout() {
        QqError::Timeout
    } else {
        QqError::Transport
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rate_and_auth_codes_are_terminal_for_both_envelopes() {
        for code in [1000, 104400, 104401] {
            assert!(matches!(business_code(code), Err(QqError::AuthExpired)));
        }
        assert!(matches!(business_code(2001), Err(QqError::RateLimited)));
        assert!(business_code(0).is_ok());
        assert!(matches!(business_code(123), Err(QqError::Upstream(123))));
    }
}
