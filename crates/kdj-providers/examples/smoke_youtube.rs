//! 联网冒烟：cargo run -p kdj-providers --example smoke_youtube -- <关键词或链接>
use std::sync::Arc;

use futures_util::StreamExt as _;
use kdj_core::models::{Quality, VideoDownloadRequest};
use kdj_providers::provider::noop_progress;
use kdj_providers::{
    youtube::YoutubeProvider, youtubemusic::auth::YoutubeAuth, MusicProvider, ProviderContext,
    ProviderLiveSettings, VideoPreviewTrack,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir = std::env::temp_dir().join("kdj-smoke-youtube");
    let ctx = ProviderContext::new(
        dir.clone(),
        ProviderLiveSettings {
            download_dir: dir.join("dl"),
            filename_template: "{title} - {artist}".into(),
            default_quality: Quality::Flac,
            netease_use_download_api: false,
            soundcloud_enabled: false,
            soundcloud_client_id: String::new(),
            soundcloud_client_secret: String::new(),
            ytm_enabled: false,
            youtube_enabled: true,
            video_dir: Some(dir.join("video")),
            video_format: "mp4".into(),
        },
    );
    let auth = Arc::new(YoutubeAuth::new(&ctx, kdj_core::models::Platform::Youtube)?);
    let provider = YoutubeProvider::new(ctx, auth)?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let input = args
        .iter()
        .find(|arg| arg.as_str() != "--download")
        .cloned()
        .unwrap_or_else(|| "lofi hip hop".into());
    if let Some(query) = input.strip_prefix("playlist:") {
        let rows = provider
            .search_collections(query, kdj_core::models::SearchKind::Playlist, 5)
            .await?;
        println!("{rows:#?}");
        if let Some(first) = rows.first() {
            println!(
                "resolved {} items",
                provider
                    .resolve_collection(first.kind, &first.key, 0)
                    .await?
                    .map(|response| response.sources.len())
                    .unwrap_or(0)
            );
        }
    } else if input.starts_with("http://") || input.starts_with("https://") {
        let resolved = provider.resolve(&input, 0).await?;
        if let Some(response) = &resolved {
            println!(
                "{:?} | {} | {} items",
                response.kind,
                response.title,
                response.sources.len()
            );
        }
        if args.iter().any(|arg| arg == "--preview") {
            for track in [VideoPreviewTrack::Video, VideoPreviewTrack::Audio] {
                let mut preview = provider
                    .preview_stream_at_height(&input, 720, track, Some("bytes=0-65535"))
                    .await?;
                let mut bytes = 0usize;
                while let Some(chunk) = preview.body.next().await {
                    bytes += chunk?.len();
                }
                println!(
                    "preview {track:?}: HTTP {} | {} | {:?} | {} bytes",
                    preview.status, preview.content_type, preview.codec, bytes
                );
            }
        }
        if args.iter().any(|arg| arg == "--download") {
            let path = provider
                .download_video(
                    &VideoDownloadRequest {
                        platform: kdj_core::models::Platform::Youtube,
                        url: input,
                        audio_only: true,
                        ..Default::default()
                    },
                    &tokio_util::sync::CancellationToken::new(),
                    &noop_progress(),
                )
                .await?;
            println!("downloaded: {}", path.display());
        }
    } else {
        for source in provider.search(&input, 5).await? {
            println!(
                "{} | {} | {}",
                source.title,
                source.artist_text(),
                source.key
            );
        }
    }
    Ok(())
}
