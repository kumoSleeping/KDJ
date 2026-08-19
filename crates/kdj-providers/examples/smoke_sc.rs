//! 真机冒烟：cargo run -p kdj-providers --example smoke_sc -- <关键词>
use kdj_core::models::Quality;
use kdj_providers::{soundcloud::SoundCloudProvider, DownloadJob, MusicProvider, ProviderContext};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir = std::env::temp_dir().join("kdj-smoke-sc");
    let ctx = ProviderContext::new(
        dir.clone(),
        kdj_providers::ProviderLiveSettings {
            download_dir: dir.join("dl"),
            filename_template: "{title} - {artist}".into(),
            default_quality: Quality::Flac,
            netease_use_download_api: false,
            soundcloud_enabled: true,
            soundcloud_client_id: String::new(),
            soundcloud_client_secret: String::new(),
            ytm_enabled: false,
            video_dir: None,
            video_format: "mp4".into(),
        },
    );
    let provider = SoundCloudProvider::new(ctx)?;
    let keyword = std::env::args().nth(1).unwrap_or_else(|| "lofi".into());

    println!("== account ==\n{:?}\n", provider.account().await);

    let results = provider.search(&keyword, 5).await?;
    println!("== search «{keyword}» -> {} 条 ==", results.len());
    for item in &results {
        println!(
            "  {} | {} | {} | {:?}s | cover={}",
            item.key,
            item.title,
            item.artist_text(),
            item.duration,
            !item.cover.is_empty()
        );
    }

    if let Some(first) = results.first() {
        let link = first.payload_str("permalink_url");
        match provider.resolve(&link, 10).await {
            Ok(Some(res)) => println!("\n== resolve -> {:?} «{}» ==", res.kind, res.title),
            Ok(None) => println!("\n== resolve 没认领 =="),
            Err(err) => println!("\n== resolve 失败：{err:#} =="),
        }
        match provider
            .download(DownloadJob::new(first, Quality::Q128))
            .await
        {
            Ok(path) => {
                let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                println!("\n== download OK: {} ({size} bytes) ==", path.display());
                println!(
                    "   duration={:?}",
                    kdj_providers::tags::read_duration_secs(&path)
                );
            }
            Err(err) => println!("\n== download 失败：{err:#} =="),
        }
    }
    Ok(())
}
