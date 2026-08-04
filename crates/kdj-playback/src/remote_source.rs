use std::io::{self, Read, Seek, SeekFrom};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kdj_player::StreamingMediaSource;
use reqwest::blocking::{Client, Response};
use reqwest::header::{CONTENT_RANGE, CONTENT_TYPE, RANGE};
use reqwest::{StatusCode, Url};

/// Seekable reader over the app's loopback preview proxy.
///
/// Symphonia performs ordinary `Read + Seek` calls. Each non-contiguous seek becomes one HTTP
/// Range request; sequential reads keep consuming the same response. The local proxy owns provider
/// authentication, URL refresh and encoded-byte caching, so playback never contacts a CDN itself.
pub(crate) struct HttpRangeSource {
    client: Client,
    url: Url,
    position: u64,
    length: u64,
    response: Mutex<Option<Response>>,
    revision_fence: Arc<AtomicU64>,
    revision: u64,
}

pub(crate) struct OpenedHttpRangeSource {
    pub source: HttpRangeSource,
    pub hint_extension: Option<String>,
}

impl HttpRangeSource {
    pub fn open(
        url: &str,
        revision_fence: Arc<AtomicU64>,
        revision: u64,
    ) -> io::Result<OpenedHttpRangeSource> {
        let url = parse_loopback_url(url)?;
        if revision_fence.load(Ordering::Acquire) != revision {
            return Err(cancelled_error());
        }
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(io_other)?;
        let opened = open_range(&client, &url, 0, None)?;
        Ok(OpenedHttpRangeSource {
            source: Self {
                client,
                url,
                position: 0,
                length: opened.total,
                response: Mutex::new(Some(opened.response)),
                revision_fence,
                revision,
            },
            hint_extension: opened.hint_extension,
        })
    }

    fn cancelled(&self) -> bool {
        self.revision_fence.load(Ordering::Acquire) != self.revision
    }

    fn ensure_response(&mut self) -> io::Result<()> {
        if self.cancelled() {
            return Err(cancelled_error());
        }
        if self
            .response
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none()
        {
            let opened = open_range(&self.client, &self.url, self.position, Some(self.length))?;
            *self
                .response
                .get_mut()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(opened.response);
        }
        Ok(())
    }

    fn discard_response(&mut self) {
        *self
            .response
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

impl Read for HttpRangeSource {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.position >= self.length {
            return Ok(0);
        }
        let remaining = self.length - self.position;
        let limit = buffer.len().min(remaining.min(usize::MAX as u64) as usize);
        let mut first_error = None;
        for attempt in 0..2 {
            self.ensure_response()?;
            if self.cancelled() {
                return Err(cancelled_error());
            }
            let result = self
                .response
                .get_mut()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_mut()
                .expect("response ensured")
                .read(&mut buffer[..limit]);
            match result {
                Ok(read) => {
                    if read > 0 {
                        self.position = self.position.saturating_add(read as u64);
                        return Ok(read);
                    }
                    if self.position >= self.length {
                        return Ok(0);
                    }
                    first_error.get_or_insert_with(|| {
                        io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "online audio response ended before Content-Length",
                        )
                    });
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
            self.discard_response();
            if attempt == 0 && !self.cancelled() {
                continue;
            }
        }
        Err(first_error.unwrap_or_else(|| io::Error::other("online audio read failed")))
    }
}

impl Seek for HttpRangeSource {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        if self.cancelled() {
            return Err(cancelled_error());
        }
        let target = match position {
            SeekFrom::Start(value) => i128::from(value),
            SeekFrom::Current(delta) => i128::from(self.position) + i128::from(delta),
            SeekFrom::End(delta) => i128::from(self.length) + i128::from(delta),
        };
        if !(0..=i128::from(self.length)).contains(&target) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "online audio seek is outside the media length",
            ));
        }
        let target = target as u64;
        if target != self.position {
            self.position = target;
            self.discard_response();
        }
        Ok(self.position)
    }
}

impl StreamingMediaSource for HttpRangeSource {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.length)
    }
}

struct OpenedRange {
    response: Response,
    total: u64,
    hint_extension: Option<String>,
}

fn open_range(
    client: &Client,
    url: &Url,
    start: u64,
    expected_total: Option<u64>,
) -> io::Result<OpenedRange> {
    let response = client
        .get(url.clone())
        .header(RANGE, format!("bytes={start}-"))
        .send()
        .map_err(io_other)?;
    let status = response.status();
    let hint_extension = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(extension_for_content_type)
        .map(str::to_string);

    let total = if status == StatusCode::PARTIAL_CONTENT {
        let value = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| invalid_response("206 response omitted Content-Range"))?;
        let (actual_start, _end, total) = parse_content_range(value)
            .ok_or_else(|| invalid_response("invalid Content-Range from preview proxy"))?;
        if actual_start != start {
            return Err(invalid_response(
                "preview proxy returned the wrong byte range",
            ));
        }
        total
    } else if status.is_success() && start == 0 {
        response
            .content_length()
            .ok_or_else(|| invalid_response("online audio response omitted Content-Length"))?
    } else if status.is_success() {
        return Err(invalid_response(
            "preview source ignored a non-zero Range request",
        ));
    } else {
        return Err(io::Error::other(format!(
            "online audio proxy returned HTTP {status}"
        )));
    };
    if total == 0 {
        return Err(invalid_response("online audio response is empty"));
    }
    if expected_total.is_some_and(|expected| expected != total) {
        return Err(invalid_response(
            "online audio length changed between Range requests",
        ));
    }
    Ok(OpenedRange {
        response,
        total,
        hint_extension,
    })
}

pub(crate) fn is_loopback_http_url(value: &str) -> bool {
    parse_loopback_url(value).is_ok()
}

fn parse_loopback_url(value: &str) -> io::Result<Url> {
    let url = Url::parse(value).map_err(|_| invalid_response("online audio URL is invalid"))?;
    if url.scheme() != "http" {
        return Err(invalid_response(
            "online audio must use the app's HTTP loopback proxy",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| invalid_response("online audio URL omitted its host"))?;
    let address = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    let loopback = address.eq_ignore_ascii_case("localhost")
        || address
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    if !loopback {
        return Err(invalid_response(
            "online audio URL must target the app's loopback proxy",
        ));
    }
    Ok(url)
}

fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let value = value.trim();
    let range = value.strip_prefix("bytes ")?;
    let (span, total) = range.split_once('/')?;
    let (start, end) = span.split_once('-')?;
    let start = start.parse().ok()?;
    let end = end.parse().ok()?;
    let total = total.parse().ok()?;
    (start <= end && end < total).then_some((start, end, total))
}

fn extension_for_content_type(value: &str) -> Option<&'static str> {
    match value
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        "audio/flac" | "audio/x-flac" => Some("flac"),
        "audio/aac" | "audio/aacp" => Some("aac"),
        "audio/mp4" | "audio/x-m4a" | "video/mp4" => Some("m4a"),
        "audio/ogg" | "application/ogg" => Some("ogg"),
        "audio/wav" | "audio/wave" | "audio/x-wav" => Some("wav"),
        _ => None,
    }
}

fn cancelled_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::Interrupted,
        "online audio preparation cancelled",
    )
}

fn invalid_response(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn io_other(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn range_reader_reuses_sequential_response_and_reopens_at_seek_targets() {
        let data = Arc::new(
            (0..2_048)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>(),
        );
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server_data = Arc::clone(&data);
        let server = thread::spawn(move || {
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while !request.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let request = String::from_utf8(request).unwrap();
                let start = request
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("range: bytes=")
                            .or_else(|| line.strip_prefix("Range: bytes="))
                    })
                    .and_then(|value| value.strip_suffix('-'))
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                let end = server_data.len() - 1;
                write!(
                    socket,
                    "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/mpeg\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\nConnection: close\r\n\r\n",
                    server_data.len() - start,
                    server_data.len(),
                )
                .unwrap();
                socket.write_all(&server_data[start..]).unwrap();
            }
        });

        let fence = Arc::new(AtomicU64::new(7));
        let mut opened =
            HttpRangeSource::open(&format!("http://{address}/api/song/preview/test"), fence, 7)
                .unwrap();
        assert_eq!(opened.hint_extension.as_deref(), Some("mp3"));
        let mut first = [0u8; 8];
        opened.source.read_exact(&mut first).unwrap();
        assert_eq!(&first, &data[..8]);
        opened.source.seek(SeekFrom::Start(500)).unwrap();
        let mut middle = [0u8; 8];
        opened.source.read_exact(&mut middle).unwrap();
        assert_eq!(&middle, &data[500..508]);
        opened.source.seek(SeekFrom::End(-4)).unwrap();
        let mut tail = [0u8; 4];
        opened.source.read_exact(&mut tail).unwrap();
        assert_eq!(&tail, &data[data.len() - 4..]);
        server.join().unwrap();
    }

    #[test]
    fn content_range_parser_rejects_inconsistent_bounds() {
        assert_eq!(parse_content_range("bytes 10-19/100"), Some((10, 19, 100)));
        assert_eq!(parse_content_range("bytes 20-10/100"), None);
        assert_eq!(parse_content_range("bytes 0-100/100"), None);
        assert_eq!(parse_content_range("items 0-9/100"), None);
    }

    #[test]
    fn only_loopback_http_urls_cross_the_native_playback_boundary() {
        assert!(is_loopback_http_url(
            "http://127.0.0.1:8788/api/song/preview/ticket"
        ));
        assert!(is_loopback_http_url("http://localhost:8788/media"));
        assert!(is_loopback_http_url("http://[::1]:8788/media"));
        assert!(!is_loopback_http_url("https://127.0.0.1/media"));
        assert!(!is_loopback_http_url("http://example.com/media"));
    }

    #[test]
    fn content_types_supply_probe_hints_without_trusting_url_extensions() {
        assert_eq!(extension_for_content_type("audio/mpeg"), Some("mp3"));
        assert_eq!(
            extension_for_content_type("audio/mp4; charset=binary"),
            Some("m4a")
        );
        assert_eq!(extension_for_content_type("application/octet-stream"), None);
    }
}
