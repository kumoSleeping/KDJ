//! Pure-Rust download path for the one protected YouTube HLS rendition exposed by KDJ.
//!
//! The server has already reduced the master playlist to one muxed H.264/AAC rendition and
//! replaced every upstream URI with an opaque loopback capability. This module deliberately
//! accepts only that capability family, downloads playlists/segments with a hardened loopback-only
//! HTTP client, and transmuxes MPEG-TS or CMAF/fMP4 segments into a streaming fragmented MP4.
//! No codec is decoded and no FFmpeg process or library is involved.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use futures_util::StreamExt as _;
use hls_transmux::{
    transmux_hls_to_mp4_async, ByteRange, CancelToken, Error as TransmuxError, HlsInput,
    OutputFormat, Source, SourceLocation, TextResource, TransmuxOptions, VariantSelection,
};
use reqwest::header::RANGE;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::provider::ProgressSink;

const PLAYLIST_LIMIT: usize = 2 * 1024 * 1024;
const SEGMENT_LIMIT: usize = 256 * 1024 * 1024;
const HLS_PATH_PREFIX: &str = "/api/video/youtube/hls/";

fn normalize_youtube_playlist(content: String) -> String {
    // YouTube masters commonly advertise this RFC 8216 playback hint. It changes neither the
    // selected rendition nor any media timestamp, while hls-transmux intentionally rejects tags
    // outside its narrow media slice. Remove only this one semantically inert tag; encryption,
    // discontinuities, alternate media, live/event playlists, and unknown tags still fail closed.
    if !content
        .lines()
        .any(|line| line.trim() == "#EXT-X-INDEPENDENT-SEGMENTS")
    {
        return content;
    }
    let mut normalized = content
        .lines()
        .filter(|line| line.trim() != "#EXT-X-INDEPENDENT-SEGMENTS")
        .collect::<Vec<_>>()
        .join("\n");
    normalized.push('\n');
    normalized
}

#[derive(Clone)]
struct ProtectedHlsScope {
    scheme: String,
    host: String,
    port: u16,
    media_token: String,
}

impl std::fmt::Debug for ProtectedHlsScope {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProtectedHlsScope")
            .field("scheme", &self.scheme)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("media_token", &"<redacted>")
            .finish()
    }
}

impl ProtectedHlsScope {
    fn from_root(value: &str) -> Result<(Self, Url)> {
        let url = Url::parse(value).context("YouTube 本地 HLS 下载来源无效")?;
        let host = url.host_str().unwrap_or_default();
        let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1");
        anyhow::ensure!(
            url.scheme() == "http"
                && loopback
                && url.port().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none(),
            "YouTube 本地 HLS 下载来源不受信任"
        );
        let mut query = url.query_pairs();
        let Some((name, media_token)) = query.next() else {
            bail!("YouTube 本地 HLS 下载来源缺少媒体凭证");
        };
        anyhow::ensure!(
            name == "kdj_media_token" && !media_token.is_empty() && query.next().is_none(),
            "YouTube 本地 HLS 下载来源不受信任"
        );
        let scope = Self {
            scheme: url.scheme().to_string(),
            host: host.to_string(),
            port: url.port().expect("checked above"),
            media_token: media_token.into_owned(),
        };
        scope.validate(&url)?;
        Ok((scope, url))
    }

    fn validate(&self, url: &Url) -> Result<()> {
        let ticket = url.path().strip_prefix(HLS_PATH_PREFIX).unwrap_or_default();
        let mut query = url.query_pairs();
        let media_capability = query.next().is_some_and(|(name, token)| {
            name == "kdj_media_token" && token.as_ref() == self.media_token
        });
        anyhow::ensure!(
            url.scheme() == self.scheme
                && url.host_str() == Some(self.host.as_str())
                && url.port() == Some(self.port)
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
                && ticket.len() == 64
                && ticket.bytes().all(|byte| byte.is_ascii_hexdigit())
                && media_capability
                && query.next().is_none(),
            "YouTube HLS 子资源离开了受保护的本地会话"
        );
        Ok(())
    }
}

#[derive(Clone)]
struct ProtectedHlsSource {
    http: reqwest::Client,
    scope: ProtectedHlsScope,
}

impl std::fmt::Debug for ProtectedHlsSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProtectedHlsSource")
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

impl ProtectedHlsSource {
    fn url<'a>(&self, location: &'a SourceLocation) -> std::result::Result<&'a Url, TransmuxError> {
        let SourceLocation::Url(url) = location else {
            return Err(TransmuxError::InvalidInput(
                "KDJ YouTube HLS 只接受本地会话 URL".into(),
            ));
        };
        self.scope
            .validate(url)
            .map_err(|error| TransmuxError::InvalidInput(error.to_string()))?;
        Ok(url)
    }

    async fn response(
        &self,
        location: &SourceLocation,
        range: Option<&ByteRange>,
    ) -> std::result::Result<reqwest::Response, TransmuxError> {
        let url = self.url(location)?;
        let mut request = self.http.get(url.clone());
        if let Some(range) = range {
            let end = range
                .offset
                .checked_add(range.length)
                .and_then(|value| value.checked_sub(1))
                .ok_or_else(|| TransmuxError::InvalidInput("HLS 字节范围溢出".into()))?;
            request = request.header(RANGE, format!("bytes={}-{}", range.offset, end));
        }
        let response = request
            .send()
            .await
            .map_err(|_| TransmuxError::Http("读取 YouTube HLS 本地资源失败".into()))?;
        self.scope
            .validate(response.url())
            .map_err(|error| TransmuxError::Http(error.to_string()))?;
        if range.is_some() {
            if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                return Err(TransmuxError::Http(format!(
                    "YouTube HLS 字节范围返回 HTTP {}",
                    response.status().as_u16()
                )));
            }
        } else if !response.status().is_success() {
            return Err(TransmuxError::Http(format!(
                "YouTube HLS 本地资源返回 HTTP {}",
                response.status().as_u16()
            )));
        }
        Ok(response)
    }

    async fn read_limited(
        &self,
        response: reqwest::Response,
        limit: usize,
    ) -> std::result::Result<Vec<u8>, TransmuxError> {
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|_| TransmuxError::Http("读取 YouTube HLS 本地响应失败".into()))?;
            if bytes.len().saturating_add(chunk.len()) > limit {
                return Err(TransmuxError::InvalidInput(
                    "YouTube HLS 本地资源大小异常".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

impl Source for ProtectedHlsSource {
    fn read_text<'a>(
        &'a self,
        location: &'a SourceLocation,
    ) -> Pin<Box<dyn Future<Output = std::result::Result<TextResource, TransmuxError>> + Send + 'a>>
    {
        Box::pin(async move {
            let response = self.response(location, None).await?;
            let final_location = SourceLocation::Url(response.url().clone());
            let bytes = self.read_limited(response, PLAYLIST_LIMIT).await?;
            let content = String::from_utf8(bytes)
                .map_err(|_| TransmuxError::InvalidInput("YouTube HLS 清单不是 UTF-8".into()))?;
            Ok(TextResource {
                content: normalize_youtube_playlist(content),
                location: final_location,
            })
        })
    }

    fn read_bytes<'a>(
        &'a self,
        location: &'a SourceLocation,
        range: Option<&'a ByteRange>,
    ) -> Pin<Box<dyn Future<Output = std::result::Result<Vec<u8>, TransmuxError>> + Send + 'a>>
    {
        Box::pin(async move {
            let response = self.response(location, range).await?;
            let bytes = self.read_limited(response, SEGMENT_LIMIT).await?;
            if let Some(range) = range {
                if bytes.len() as u64 != range.length {
                    return Err(TransmuxError::Http("YouTube HLS 字节范围长度不完整".into()));
                }
            }
            Ok(bytes)
        })
    }
}

#[derive(Debug, Clone)]
struct KdjCancel(CancellationToken);

impl CancelToken for KdjCancel {
    fn is_cancelled(&self) -> bool {
        self.0.is_cancelled()
    }

    fn cancelled(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(self.0.cancelled())
    }
}

pub async fn download_muxed_h264_aac(
    source_url: &str,
    output: &std::path::Path,
    cancel: &CancellationToken,
    progress: &ProgressSink,
) -> Result<()> {
    let (scope, root) = ProtectedHlsScope::from_root(source_url)?;
    // The KDJ loopback service never redirects. Disabling redirects prevents a compromised or
    // stale local endpoint from causing even one outbound request before final-URL validation.
    let http = crate::net::http_timeouts(
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none()),
    )
    .build()
    .context("创建 YouTube 本地 HLS 客户端失败")?;
    let source = Arc::new(ProtectedHlsSource { http, scope });
    let progress_sink = Arc::clone(progress);
    let options = TransmuxOptions {
        // The protected server keeps at most one variant in a master playlist. If the root is
        // already a media playlist this value is ignored by hls-transmux.
        variant: Some(VariantSelection::Index(0)),
        // Streaming fMP4 stays bounded by one segment, supports files beyond 4 GiB, and is a
        // normal MP4-family file WebKit can seek without a second defragmentation pass.
        output_format: OutputFormat::FragmentedMp4,
        on_progress: Some(Arc::new(move |event| {
            progress_sink(event.downloaded_bytes, 0);
        })),
        cancel: Some(Arc::new(KdjCancel(cancel.clone()))),
        ..TransmuxOptions::default()
    };
    let report = transmux_hls_to_mp4_async(
        HlsInput::custom(source, SourceLocation::Url(root)),
        output,
        options,
    )
    .await
    .map_err(|error| match error {
        TransmuxError::Cancelled => anyhow::anyhow!("下载已取消"),
        other => anyhow::anyhow!(other),
    })
    .context("原生下载 YouTube HLS 失败")?;
    anyhow::ensure!(
        report.segment_count > 0 && report.bytes_written > 0,
        "YouTube HLS 下载没有产生有效媒体数据"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket(character: char) -> String {
        std::iter::repeat_n(character, 64).collect()
    }

    #[test]
    fn protected_scope_accepts_only_the_same_loopback_capability_family() {
        let root = format!(
            "http://127.0.0.1:41234/api/video/youtube/hls/{}?kdj_media_token=secret",
            ticket('a')
        );
        let (scope, _) = ProtectedHlsScope::from_root(&root).unwrap();
        let sibling = Url::parse(&format!(
            "http://127.0.0.1:41234/api/video/youtube/hls/{}?kdj_media_token=secret",
            ticket('b')
        ))
        .unwrap();
        assert!(scope.validate(&sibling).is_ok());

        for invalid in [
            format!(
                "http://localhost:41234/api/video/youtube/hls/{}?kdj_media_token=secret",
                ticket('b')
            ),
            format!(
                "http://127.0.0.1:41235/api/video/youtube/hls/{}?kdj_media_token=secret",
                ticket('b')
            ),
            format!(
                "http://127.0.0.1:41234/api/video/youtube/hls/{}?kdj_media_token=other",
                ticket('b')
            ),
            "https://example.com/playlist.m3u8".into(),
        ] {
            assert!(scope.validate(&Url::parse(&invalid).unwrap()).is_err());
        }
    }

    #[test]
    fn normalization_removes_only_the_inert_youtube_master_hint() {
        let playlist =
            "#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n";
        let normalized = normalize_youtube_playlist(playlist.into());
        assert!(!normalized.contains("INDEPENDENT-SEGMENTS"));
        assert!(normalized.contains("#EXT-X-KEY:"));
    }
}
