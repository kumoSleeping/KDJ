//! QQ media boundary shared by preview and download.
use anyhow::{bail, Result};
use bytes::Bytes;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT_ENCODING, COOKIE, RANGE, REFERER, USER_AGENT,
};

use super::error::QqError;

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
/// 依次打开 vkey 给出的各个 CDN 地址，用首包字节而不是 Content-Type 判定是不是音频：
/// 第一个回 HTTP 200 且开头是 `ext` 容器签名的就用，已读到的开头一并交回给调用方。
/// 一家节点回 HTML 不等于这首歌下不了；全都不行时把各家的回答列进错误，用户和维护者
/// 才看得出 QQ 到底回了什么。响应正文只进日志，不进任务错误。
pub(super) async fn open_audio_download<F, Fut>(
    candidates: impl IntoIterator<Item = String>,
    ext: &str,
    fetch: F,
) -> Result<(reqwest::Response, Bytes)>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response>>,
{
    let mut rejected: Vec<String> = Vec::new();
    let mut answered = false;
    let mut last_error = None;
    for url in candidates {
        let mut response = match fetch(url).await {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(stage = "download", error = %error, "QQ 音乐 CDN 请求失败");
                rejected.push(error.to_string());
                last_error = Some(error);
                continue;
            }
        };
        answered = true;
        let status = response.status().as_u16();
        if status == 429 {
            return Err(QqError::RateLimited.into());
        }
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .trim()
            .to_string();
        let answer = if mime.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status} {mime}")
        };
        if status != 200 {
            tracing::warn!(stage = "download", status, content_type = %mime, "QQ 音乐 CDN 没有返回音频");
            rejected.push(answer);
            continue;
        }
        let head = match read_head(&mut response).await {
            Ok(head) => head,
            Err(error) => {
                tracing::warn!(stage = "download", error = %error, "QQ 音乐 CDN 读取首包失败");
                rejected.push(error.to_string());
                last_error = Some(error);
                continue;
            }
        };
        if valid_audio_prefix(&head, ext) {
            return Ok((response, head));
        }
        let excerpt: String = String::from_utf8_lossy(&head)
            .chars()
            .filter(|c| !c.is_control())
            .take(120)
            .collect();
        tracing::warn!(
            stage = "download",
            status,
            content_type = %mime,
            excerpt,
            "QQ 音乐 CDN 没有返回音频"
        );
        rejected.push(format!("{answer}，开头不是 {ext} 音频"));
    }
    if !answered {
        return Err(last_error.unwrap_or_else(|| QqError::Unavailable.into()));
    }
    rejected.dedup();
    bail!(
        "QQ 音乐没有返回音频内容（{}），未提交下载文件",
        rejected.join("；")
    )
}

/// 容器签名判定需要的开头字节数；流在此之前结束的也照样交给判定。
const HEAD_BYTES: usize = 16;

async fn read_head(response: &mut reqwest::Response) -> Result<Bytes> {
    let mut head = Vec::new();
    while head.len() < HEAD_BYTES {
        match response.chunk().await.map_err(super::error::network_error)? {
            Some(chunk) => head.extend_from_slice(&chunk),
            None => break,
        }
    }
    Ok(Bytes::from(head))
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
    /// One-shot loopback responder; the real guard refuses loopback CDN hosts, so the
    /// download loop is exercised through its fetch seam instead. Gives up after two
    /// seconds so a candidate the loop never reaches does not leave a thread in accept().
    fn serve(status: u16, content_type: &str, body: &[u8]) -> String {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/M500FILE.mp3?vkey=fixture", listener.local_addr().unwrap());
        let head = format!(
            "HTTP/1.1 {status} Mock\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let body = body.to_vec();
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                let Ok((mut socket, _)) = listener.accept() else {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                    continue;
                };
                socket.set_nonblocking(false).unwrap();
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request);
                let _ = socket.write_all(head.as_bytes());
                let _ = socket.write_all(&body);
                break;
            }
        });
        url
    }
    type Fetch = Box<dyn Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<reqwest::Response>> + Send>>>;
    fn plain_fetch() -> (Fetch, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        kdj_core::ensure_rustls_ring();
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(std::time::Duration::from_secs(2))
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let fetched = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = fetched.clone();
        let fetch: Fetch = Box::new(move |url: String| {
            log.lock().unwrap().push(url.clone());
            let request = client.get(&url);
            Box::pin(async move { Ok(request.send().await?) })
        });
        (fetch, fetched)
    }
    const MP3: &[u8] = &[0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const FLAC: &[u8] = b"fLaC\x00\x00\x00\x22\x10\x00\x10\x00";
    #[tokio::test]
    async fn download_moves_on_to_the_next_cdn_node_when_one_answers_without_audio() {
        let html = serve(200, "text/html; charset=utf-8", b"<html>403 Forbidden</html>");
        let refused = "http://127.0.0.1:1/M500FILE.mp3".to_string();
        let audio = serve(200, "audio/mpeg", MP3);
        let (fetch, fetched) = plain_fetch();
        let (response, head) = open_audio_download([html, refused, audio.clone()], "mp3", fetch)
            .await
            .unwrap();
        assert_eq!(response.url().as_str(), audio);
        assert_eq!(&head[..], MP3);
        assert_eq!(fetched.lock().unwrap().len(), 3);
    }
    #[tokio::test]
    async fn download_trusts_the_first_bytes_over_the_content_type() {
        let mislabeled = serve(200, "audio/flac", b"<html>error page sent as audio</html>");
        let unlabeled = serve(200, "application/x-flac", FLAC);
        let (fetch, fetched) = plain_fetch();
        let (response, head) = open_audio_download([mislabeled, unlabeled.clone()], "flac", fetch)
            .await
            .unwrap();
        assert_eq!(response.url().as_str(), unlabeled);
        assert_eq!(&head[..], FLAC);
        assert_eq!(fetched.lock().unwrap().len(), 2);
    }
    #[tokio::test]
    async fn download_error_names_what_every_cdn_node_answered() {
        let html = serve(200, "text/html; charset=utf-8", b"<html>403 Forbidden</html>");
        let json = serve(200, "application/json", b"{\"code\":-1}");
        let forbidden = vec![serve(403, "", b""), serve(403, "", b"")];
        let (fetch, _) = plain_fetch();
        let error = open_audio_download([html, json, forbidden[0].clone(), forbidden[1].clone()], "mp3", fetch)
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "QQ 音乐没有返回音频内容（HTTP 200 text/html; charset=utf-8，开头不是 mp3 音频；HTTP 200 application/json，开头不是 mp3 音频；HTTP 403），未提交下载文件"
        );
    }
    #[tokio::test]
    async fn download_stops_at_the_first_rate_limit_and_keeps_transport_errors_typed() {
        let limited = serve(429, "", b"");
        let audio = serve(200, "audio/mpeg", MP3);
        let (fetch, fetched) = plain_fetch();
        let error = open_audio_download([limited, audio], "mp3", fetch).await.unwrap_err();
        assert!(matches!(error.downcast_ref::<QqError>(), Some(QqError::RateLimited)));
        assert_eq!(fetched.lock().unwrap().len(), 1);

        let typed = |fetch: Fetch| {
            move |url: String| {
                let pending = fetch(url);
                async move { pending.await.map_err(|_| QqError::Transport.into()) }
            }
        };
        let refused = "http://127.0.0.1:1/M500FILE.mp3".to_string();
        let (fetch, _) = plain_fetch();
        let error = open_audio_download([refused.clone()], "mp3", typed(fetch)).await.unwrap_err();
        assert!(matches!(error.downcast_ref::<QqError>(), Some(QqError::Transport)));

        let html = serve(200, "text/html", b"<html>");
        let (fetch, _) = plain_fetch();
        let error = open_audio_download([refused, html], "mp3", typed(fetch)).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "QQ 音乐没有返回音频内容（QQ 音乐网络连接失败；登录状态已保留；HTTP 200 text/html，开头不是 mp3 音频），未提交下载文件"
        );
    }
    #[test]
    fn rejects_successful_error_pages_empty_and_truncated_audio() {
        assert!(validate_audio(b"<html>error", "mp3", 2048, Some(2048)).is_err());
        assert!(validate_audio(b"fLaC", "flac", 2048, Some(4096)).is_err());
        assert!(validate_audio(b"fLaC", "flac", 2048, Some(2048)).is_ok());
        assert!(validate_audio(&[0xff, 0xfb, 0x90, 0x00], "mp3", 2048, None).is_ok());
    }
}
