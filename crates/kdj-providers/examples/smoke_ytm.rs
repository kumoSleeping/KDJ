//! 真机冒烟：cargo run -p kdj-providers --example smoke_ytm -- <关键词或链接>
use kdj_core::models::Quality;
use kdj_providers::{
    youtubemusic::{auth::YoutubeAuth, YoutubeMusicProvider},
    DownloadJob, MusicProvider, ProviderContext,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir = std::env::temp_dir().join("kdj-smoke-ytm");
    let ctx = ProviderContext::new(
        dir.clone(),
        kdj_providers::ProviderLiveSettings {
            download_dir: dir.join("dl"),
            filename_template: "{title} - {artist}".into(),
            default_quality: Quality::Flac,
            netease_use_download_api: false,
            soundcloud_enabled: false,
            soundcloud_client_id: String::new(),
            soundcloud_client_secret: String::new(),
            ytm_enabled: true,
            youtube_enabled: false,
            video_dir: None,
            video_format: "mp4".into(),
        },
    );
    let auth = std::sync::Arc::new(YoutubeAuth::new(&ctx, kdj_core::models::Platform::Ytm)?);
    let provider = YoutubeMusicProvider::new(ctx, auth)?;
    let keyword = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "lofi hip hop".into());

    println!("== account ==\n{:?}\n", provider.account().await);

    println!("== search {keyword} ==");
    let sources = provider.search(&keyword, 5).await?;
    for source in &sources {
        println!(
            "- {} | {} | {:.0}s | {}",
            source.title,
            source.artist_text(),
            source.duration.unwrap_or(0.0),
            source.key
        );
    }
    let Some(first) = sources.first() else {
        println!("没有结果");
        return Ok(());
    };

    println!("\n== preview ==");
    if let Some(url) = provider.preview_url(first).await? {
        println!("{url}");
    }

    println!("\n== download ==");
    let path = provider
        .download(DownloadJob::new(first, Quality::Q320))
        .await?;
    println!("downloaded: {}", path.display());
    Ok(())
}
