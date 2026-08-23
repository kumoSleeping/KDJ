//! 真机冒烟：cargo run -p kdj-providers --example smoke_qq -- <关键词>
use kdj_core::models::Quality;
use kdj_providers::{qqmusic::QqMusicProvider, MusicProvider, ProviderContext};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir = std::env::temp_dir().join("kdj-smoke-qq");
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
            ytm_enabled: false,
            video_dir: None,
            video_format: "mp4".into(),
        },
    );
    let provider = QqMusicProvider::new(ctx)?;
    let keyword = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "Supernova".into());

    println!("== account ==\n{:?}\n", provider.account().await);

    let results = provider.search(&keyword, 5).await?;
    println!("== search «{keyword}» -> {} 条 ==", results.len());
    for item in &results {
        println!(
            "  {} | {} | {} | {:?} | vip={} | {:?}s | cover={}",
            item.key,
            item.title,
            item.artist_text(),
            item.max_quality,
            item.vip,
            item.duration,
            !item.cover.is_empty()
        );
    }

    if let Some(first) = results.first() {
        let url = format!("https://y.qq.com/n/ryqq/songDetail/{}", first.key);
        match provider.resolve(&url, 10).await {
            Ok(Some(res)) => println!("\n== resolve -> {:?} «{}» ==", res.kind, res.title),
            Ok(None) => println!("\n== resolve 没认领这个链接 =="),
            Err(err) => println!("\n== resolve 失败：{err:#} =="),
        }
    }

    // 下载管线冒烟：挑一首非 VIP 的
    if let Some(free) = results.iter().find(|item| !item.vip) {
        use kdj_providers::DownloadJob;
        let job = DownloadJob::new(free, Quality::Flac);
        match provider.download(job).await {
            Ok(path) => {
                let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                println!("\n== download OK: {} ({} bytes) ==", path.display(), size);
                println!(
                    "   duration={:?}",
                    kdj_providers::tags::read_duration_secs(&path)
                );
            }
            Err(err) => println!("\n== download 失败：{err:#} =="),
        }
    }

    match provider.create_qr().await {
        Ok(qr) => println!("\n== QR OK, image {} bytes ==", qr.image.len()),
        Err(err) => println!("\n== QR 失败：{err:#} =="),
    }
    Ok(())
}
