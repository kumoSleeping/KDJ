use anyhow::{Context, Result};

/// Accept copied request headers, JSON headers, or the site's oauth_token Cookie pair.
/// Never treat an arbitrary string or another site's Authorization scheme as a login token.
pub(super) fn token(raw: &str) -> Result<String> {
    anyhow::ensure!(
        !raw.trim().is_empty() && raw.len() <= 256 * 1024,
        "请粘贴有效的 SoundCloud 请求头"
    );
    let headers = crate::youtubemusic::auth::parse_headers(raw.trim())?;
    let cookie = headers
        .get("cookie")
        .map(String::as_str)
        .unwrap_or_else(|| {
            if !raw.contains(['\r', '\n']) && raw.trim().starts_with("oauth_token=") {
                raw.trim()
            } else {
                ""
            }
        });
    let mut tokens = Vec::new();
    for part in cookie.split(';') {
        if let Some(("oauth_token", value)) = part.trim().split_once('=') {
            tokens.push(value.to_string());
        }
    }
    if let Some(authorization) = headers.get("authorization") {
        if let Some((scheme, value)) = authorization.split_once(' ') {
            if scheme.eq_ignore_ascii_case("OAuth") || scheme.eq_ignore_ascii_case("Bearer") {
                tokens.push(value.trim().to_string());
            }
        }
    }
    tokens.sort();
    tokens.dedup();
    anyhow::ensure!(
        tokens.len() <= 1,
        "请求头包含不同的 SoundCloud 登录状态，请只复制一次请求的请求头"
    );
    let token = tokens
        .pop()
        .context("请求头中没有 SoundCloud 登录状态；需要 oauth_token Cookie 或 Authorization")?;
    anyhow::ensure!(
        !token.is_empty()
            && token.len() <= 4096
            && !token
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == ';'),
        "SoundCloud 请求头中的登录状态无效"
    );
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_site_cookie_or_authorization_without_echoing_input() {
        for raw in [
            "Cookie: other=ignored; oauth_token=test-only",
            "oauth_token=test-only",
            "Authorization: OAuth test-only",
            r#"{"Authorization":"Bearer test-only"}"#,
        ] {
            assert_eq!(token(raw).unwrap(), "test-only");
        }
        for raw in [
            "Cookie: SID=secret",
            "Authorization: Basic secret",
            "oauth_token=",
            "oauth_token=one; oauth_token=two",
            "Cookie: oauth_token=one\nAuthorization: OAuth two",
            "Authorization: Bearer bad value",
        ] {
            assert!(token(raw).is_err());
        }
    }
}
