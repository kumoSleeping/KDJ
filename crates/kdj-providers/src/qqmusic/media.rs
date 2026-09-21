//! QQ media boundary shared by preview and download.
use anyhow::{bail, Result};
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT_ENCODING, COOKIE, RANGE, REFERER, USER_AGENT,
};

pub(super) fn is_qq_audio_url(raw: &str) -> bool {
    let Ok(url) = crate::net::parse_guarded_media_url(raw) else {
        return false;
    };
    url.port_or_known_default() == Some(443)
        && url.host_str().is_some_and(|host| {
            host == "stream.qqmusic.qq.com" || host.ends_with(".stream.qqmusic.qq.com")
        })
}
pub(super) fn media_headers(cookie: &str, range: Option<&str>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(super::client::DESKTOP_UA),
    );
    headers.insert(REFERER, HeaderValue::from_static("http://y.qq.com"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    if !cookie.is_empty() {
        headers.insert(COOKIE, HeaderValue::from_str(cookie)?);
    }
    if let Some(range) = range {
        headers.insert(RANGE, HeaderValue::from_str(range)?);
    }
    Ok(headers)
}
pub(super) fn audio_content_type(value: &str) -> bool {
    let mime = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    mime.is_empty()
        || mime.starts_with("audio/")
        || matches!(
            mime.as_str(),
            "application/octet-stream" | "binary/octet-stream"
        )
}
pub(super) fn validate_audio(
    prefix: &[u8],
    ext: &str,
    downloaded: u64,
    expected: Option<u64>,
) -> Result<()> {
    if downloaded < 128 || expected.is_some_and(|length| downloaded != length) {
        bail!("QQ 音乐音频长度不完整，未提交下载文件");
    }
    let valid = valid_audio_prefix(prefix, ext);
    if !valid {
        bail!("QQ 音乐返回的内容不是有效的 {ext} 音频，未提交下载文件");
    }
    Ok(())
}
/// Lightweight container signature check; it does not replace full decoding.
pub fn valid_audio_prefix(prefix: &[u8], ext: &str) -> bool {
    if ext == "flac" {
        prefix.starts_with(b"fLaC")
    } else {
        // MP3: a well-formed ID3v2 header or an MPEG Layer III frame sync. Not an expensive decode.
        (prefix.len() >= 10
            && prefix.starts_with(b"ID3")
            && (2..=4).contains(&prefix[3])
            && prefix[6..10].iter().all(|b| b & 0x80 == 0))
            || (prefix.len() >= 4
                && prefix[0] == 0xff
                && prefix[1] & 0xe0 == 0xe0
                && prefix[1] & 0x18 != 0x08
                && prefix[1] & 0x06 == 0x02
                && prefix[2] & 0xf0 != 0xf0
                && prefix[2] & 0x0c != 0x0c)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_untrusted_hosts_credentials_fragments_ports_and_downgrades() {
        assert!(is_qq_audio_url(
            "https://isure.stream.qqmusic.qq.com/M500x.mp3?vkey=secret"
        ));
        for bad in [
            "http://isure.stream.qqmusic.qq.com/a",
            "https://stream.qqmusic.qq.com.evil.test/a",
            "https://user@stream.qqmusic.qq.com/a",
            "https://stream.qqmusic.qq.com/a#secret",
            "https://stream.qqmusic.qq.com:444/a",
            "https://127.0.0.1/a",
        ] {
            assert!(!is_qq_audio_url(bad), "{bad}");
        }
    }
    #[test]
    fn preview_and_download_share_context_but_range_is_explicit() {
        let download = media_headers("test-cookie", None).unwrap();
        let preview = media_headers("test-cookie", Some("bytes=0-1023")).unwrap();
        for key in [USER_AGENT, REFERER, COOKIE, ACCEPT_ENCODING] {
            assert_eq!(download.get(&key), preview.get(&key));
        }
        assert!(!download.contains_key(RANGE));
        assert_eq!(preview[RANGE], "bytes=0-1023");
    }
    #[test]
    fn rejects_successful_error_pages_empty_and_truncated_audio() {
        assert!(!audio_content_type("text/html; charset=utf-8"));
        assert!(!audio_content_type("application/json"));
        assert!(audio_content_type("application/octet-stream"));
        assert!(validate_audio(b"<html>error", "mp3", 2048, Some(2048)).is_err());
        assert!(validate_audio(b"fLaC", "flac", 2048, Some(4096)).is_err());
        assert!(validate_audio(b"fLaC", "flac", 2048, Some(2048)).is_ok());
        assert!(validate_audio(&[0xff, 0xfb, 0x90, 0x00], "mp3", 2048, None).is_ok());
    }
}
