use std::collections::{BTreeMap, HashMap};
use std::io::{self, Read, Seek, SeekFrom};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use kdj_player::StreamingMediaSource;
use reqwest::blocking::{Client, Response};
use reqwest::header::{CONTENT_RANGE, CONTENT_TYPE, RANGE};
use reqwest::{StatusCode, Url};

// The currently audible decoder and a seek shadow are separate readers. Without a shared encoded
// cache, a shadow re-downloads bytes which the audible reader has already consumed, even when the
// UI correctly reports that time range as buffered. Keep this cache bounded: it is a seek cushion,
// not a second whole-library cache (the server owns persistent complete-file caching).
const RANGE_CACHE_SOURCE_LIMIT: usize = 8;
const RANGE_CACHE_SOURCE_BYTES: usize = 32 * 1024 * 1024;
const RANGE_CACHE_TOTAL_BYTES: usize = 128 * 1024 * 1024;
/// Symphonia probes from the beginning for every shadow. Retaining a small prefix removes that
/// otherwise unconditional HTTP request even after the per-source cache starts evicting old data.
const RANGE_CACHE_PROTECTED_PREFIX_BYTES: u64 = 512 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
struct RangeCacheMetadata {
    total: u64,
    hint_extension: Option<String>,
}

#[derive(Debug)]
struct CachedRange {
    bytes: Box<[u8]>,
    touched: u64,
}

#[derive(Debug)]
struct SourceRangeCache {
    metadata: RangeCacheMetadata,
    ranges: BTreeMap<u64, CachedRange>,
    bytes: usize,
    touched: u64,
}

#[derive(Default, Debug)]
struct SharedRangeCache {
    sources: HashMap<String, SourceRangeCache>,
    bytes: usize,
    clock: u64,
}

impl SharedRangeCache {
    fn tick(&mut self) -> u64 {
        self.clock = self.clock.wrapping_add(1).max(1);
        self.clock
    }

    fn metadata(&mut self, key: &str) -> Option<RangeCacheMetadata> {
        let touched = self.tick();
        let source = self.sources.get_mut(key)?;
        source.touched = touched;
        Some(source.metadata.clone())
    }

    fn observe_metadata(&mut self, key: &str, total: u64, hint_extension: Option<&str>) {
        let touched = self.tick();
        match self.sources.get_mut(key) {
            Some(source) if source.metadata.total == total => {
                source.touched = touched;
                if source.metadata.hint_extension.is_none() {
                    source.metadata.hint_extension = hint_extension.map(str::to_string);
                }
            }
            Some(_) => {
                if let Some(previous) = self.sources.remove(key) {
                    self.bytes = self.bytes.saturating_sub(previous.bytes);
                }
                self.sources.insert(
                    key.to_string(),
                    SourceRangeCache {
                        metadata: RangeCacheMetadata {
                            total,
                            hint_extension: hint_extension.map(str::to_string),
                        },
                        ranges: BTreeMap::new(),
                        bytes: 0,
                        touched,
                    },
                );
            }
            None => {
                self.sources.insert(
                    key.to_string(),
                    SourceRangeCache {
                        metadata: RangeCacheMetadata {
                            total,
                            hint_extension: hint_extension.map(str::to_string),
                        },
                        ranges: BTreeMap::new(),
                        bytes: 0,
                        touched,
                    },
                );
            }
        }
        self.prune_sources();
    }

    fn read(&mut self, key: &str, position: u64, output: &mut [u8]) -> usize {
        if output.is_empty() {
            return 0;
        }
        let touched = self.tick();
        let Some(source) = self.sources.get_mut(key) else {
            return 0;
        };
        source.touched = touched;
        let Some((start, range)) = source.ranges.range_mut(..=position).next_back() else {
            return 0;
        };
        let offset = position.saturating_sub(*start);
        if offset >= range.bytes.len() as u64 {
            return 0;
        }
        let offset = offset as usize;
        let count = output.len().min(range.bytes.len() - offset);
        output[..count].copy_from_slice(&range.bytes[offset..offset + count]);
        range.touched = touched;
        count
    }

    fn insert(
        &mut self,
        key: &str,
        position: u64,
        bytes: &[u8],
        total: u64,
        hint_extension: Option<&str>,
    ) {
        if bytes.is_empty() || position >= total {
            return;
        }
        self.observe_metadata(key, total, hint_extension);
        let end = position.saturating_add(bytes.len() as u64).min(total);
        let touched = self.tick();
        let source = self.sources.get_mut(key).expect("metadata observed above");
        source.touched = touched;

        // Keep ranges non-overlapping. A concurrent old/new shadow may read the same CDN bytes;
        // only uncovered gaps consume cache memory.
        let mut cursor = position;
        let mut additions = Vec::new();
        while cursor < end {
            let covered_until =
                source
                    .ranges
                    .range(..=cursor)
                    .next_back()
                    .and_then(|(start, range)| {
                        let range_end = start.saturating_add(range.bytes.len() as u64);
                        (cursor < range_end).then_some(range_end)
                    });
            if let Some(covered_until) = covered_until {
                cursor = covered_until.min(end);
                continue;
            }
            let next_start = source
                .ranges
                .range(cursor..)
                .next()
                .map(|(start, _)| *start)
                .unwrap_or(end);
            let gap_end = next_start.min(end);
            let from = (cursor - position) as usize;
            let to = (gap_end - position) as usize;
            if from < to {
                additions.push((cursor, bytes[from..to].to_vec().into_boxed_slice()));
            }
            cursor = gap_end;
        }

        for (start, bytes) in additions {
            source.bytes = source.bytes.saturating_add(bytes.len());
            self.bytes = self.bytes.saturating_add(bytes.len());
            source.ranges.insert(start, CachedRange { bytes, touched });
        }
        let removed = prune_source_ranges(source);
        self.bytes = self.bytes.saturating_sub(removed);
        self.prune_sources();
    }

    fn prune_sources(&mut self) {
        while self.sources.len() > RANGE_CACHE_SOURCE_LIMIT || self.bytes > RANGE_CACHE_TOTAL_BYTES
        {
            let Some(key) = self
                .sources
                .iter()
                .min_by_key(|(_, source)| source.touched)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(source) = self.sources.remove(&key) {
                self.bytes = self.bytes.saturating_sub(source.bytes);
            }
        }
    }
}

fn prune_source_ranges(source: &mut SourceRangeCache) -> usize {
    let mut removed = 0usize;
    while source.bytes > RANGE_CACHE_SOURCE_BYTES {
        let candidate = source
            .ranges
            .iter()
            .filter(|(start, _)| **start >= RANGE_CACHE_PROTECTED_PREFIX_BYTES)
            .min_by_key(|(_, range)| range.touched)
            .or_else(|| source.ranges.iter().min_by_key(|(_, range)| range.touched))
            .map(|(start, _)| *start);
        let Some(start) = candidate else {
            break;
        };
        if let Some(range) = source.ranges.remove(&start) {
            source.bytes = source.bytes.saturating_sub(range.bytes.len());
            removed = removed.saturating_add(range.bytes.len());
        }
    }
    removed
}

fn shared_range_cache() -> &'static Mutex<SharedRangeCache> {
    static CACHE: OnceLock<Mutex<SharedRangeCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(SharedRangeCache::default()))
}

fn cached_metadata(key: &str) -> Option<RangeCacheMetadata> {
    shared_range_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .metadata(key)
}

fn shared_http_client() -> io::Result<Client> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| error.to_string())
        })
        .clone()
        .map_err(io_other)
}

/// Seekable reader over the app's loopback preview proxy.
///
/// Symphonia performs ordinary `Read + Seek` calls. Each non-contiguous seek becomes one HTTP
/// Range request; sequential reads keep consuming the same response. The local proxy owns provider
/// authentication, URL refresh and encoded-byte caching, so playback never contacts a CDN itself.
pub(crate) struct HttpRangeSource {
    client: Client,
    url: Url,
    cache_key: String,
    hint_extension: Option<String>,
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
        let client = shared_http_client()?;
        let cache_key = url.as_str().to_string();
        let cached = cached_metadata(&cache_key);
        let opened = if cached.is_none() {
            Some(open_range(&client, &url, 0, None)?)
        } else {
            None
        };
        let total = opened
            .as_ref()
            .map(|opened| opened.total)
            .or_else(|| cached.as_ref().map(|cached| cached.total))
            .expect("cached or opened metadata");
        let hint_extension = opened
            .as_ref()
            .and_then(|opened| opened.hint_extension.clone())
            .or_else(|| cached.and_then(|cached| cached.hint_extension));
        if let Some(opened) = opened.as_ref() {
            shared_range_cache()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .observe_metadata(&cache_key, opened.total, opened.hint_extension.as_deref());
        }
        Ok(OpenedHttpRangeSource {
            source: Self {
                client,
                url,
                cache_key,
                hint_extension: hint_extension.clone(),
                position: 0,
                length: total,
                response: Mutex::new(opened.map(|opened| opened.response)),
                revision_fence,
                revision,
            },
            hint_extension,
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
            shared_range_cache()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .observe_metadata(
                    &self.cache_key,
                    opened.total,
                    opened.hint_extension.as_deref(),
                );
            if self.hint_extension.is_none() {
                self.hint_extension = opened.hint_extension.clone();
            }
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
        let cached = shared_range_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .read(&self.cache_key, self.position, &mut buffer[..limit]);
        if cached > 0 {
            // A response body has its own cursor. It cannot remain attached after the logical
            // cursor advances through shared cache bytes or the next miss would return old data.
            self.discard_response();
            self.position = self.position.saturating_add(cached as u64);
            return Ok(cached);
        }
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
                        shared_range_cache()
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .insert(
                                &self.cache_key,
                                self.position,
                                &buffer[..read],
                                self.length,
                                self.hint_extension.as_deref(),
                            );
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
        "audio/webm" => Some("webm"),
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
    fn a_seek_shadow_reuses_bytes_consumed_by_the_audible_reader() {
        let data = Arc::new(
            (0..4_096)
                .map(|index| (index % 239) as u8)
                .collect::<Vec<_>>(),
        );
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server_data = Arc::clone(&data);
        // Exactly one request is accepted. If the second reader contacts HTTP instead of the
        // shared encoded cache, the test fails rather than silently proving only correctness.
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let end = server_data.len() - 1;
            write!(
                socket,
                "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/mpeg\r\nContent-Length: {}\r\nContent-Range: bytes 0-{end}/{}\r\nConnection: close\r\n\r\n",
                server_data.len(),
                server_data.len(),
            )
            .unwrap();
            socket.write_all(&server_data).unwrap();
        });

        let url = format!("http://{address}/api/song/preview/shared");
        let fence = Arc::new(AtomicU64::new(11));
        let mut audible = HttpRangeSource::open(&url, Arc::clone(&fence), 11).unwrap();
        let mut first = vec![0u8; data.len()];
        audible.source.read_exact(&mut first).unwrap();
        assert_eq!(first, *data);
        drop(audible);
        server.join().unwrap();

        let mut shadow = HttpRangeSource::open(&url, fence, 11).unwrap();
        let mut cached = vec![0u8; data.len()];
        shadow.source.read_exact(&mut cached).unwrap();
        assert_eq!(cached, *data);
    }

    #[test]
    fn overlapping_network_reads_do_not_duplicate_range_cache_memory() {
        let mut cache = SharedRangeCache::default();
        cache.insert("track", 0, &[1, 2, 3, 4, 5, 6], 10, Some("mp3"));
        cache.insert("track", 3, &[4, 5, 6, 7, 8], 10, Some("mp3"));
        assert_eq!(cache.bytes, 8);
        assert_eq!(cache.sources["track"].bytes, 8);

        let mut output = [0u8; 5];
        let first = cache.read("track", 2, &mut output);
        let second = cache.read("track", 6, &mut output[first..]);
        assert_eq!(first + second, 5);
        assert_eq!(output, [3, 4, 5, 6, 7]);
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
        assert_eq!(
            extension_for_content_type("audio/webm; codecs=opus"),
            Some("webm")
        );
        assert_eq!(extension_for_content_type("application/octet-stream"), None);
    }
}
