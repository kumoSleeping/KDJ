//! 真机冒烟：cargo run -p kdj-providers --example smoke_netease -- <关键词>
use kdj_core::models::Quality;
use kdj_providers::{netease::NeteaseProvider, MusicProvider, ProviderContext};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir = std::env::temp_dir().join("kdj-smoke");
    let ctx = ProviderContext::new(
        dir.clone(),
        kdj_providers::ProviderLiveSettings {
            download_dir: dir.join("dl"),
            filename_template: "{title} - {artist}".into(),
            default_quality: Quality::Flac,
            netease_use_download_api: false,
            soundcloud_enabled: false,
            video_dir: None,
            video_format: "mp4".into(),
        },
    );
    let provider = NeteaseProvider::new(ctx)?;
    let keyword = std::env::args().nth(1).unwrap_or_else(|| "Supernova".into());

    println!("== account ==\n{:?}\n", provider.account().await);

    let results = provider.search(&keyword, 5).await?;
    println!("== search «{keyword}» -> {} 条 ==", results.len());
    for item in &results {
        println!(
            "  {} | {} | {} | {:?} | vip={} | {:?}s",
            item.key, item.title, item.artist_text(), item.max_quality, item.vip, item.duration
        );
    }

    if let Some(first) = results.first() {
        let url = format!("https://music.163.com/song?id={}", first.key);
        match provider.resolve(&url, 10).await {
            Ok(Some(res)) => println!("\n== resolve {url} -> {:?} «{}» ==", res.kind, res.title),
            Ok(None) => println!("\n== resolve 没认领这个链接 =="),
            Err(err) => println!("\n== resolve 失败：{err:#} =="),
        }
    }
    Ok(())
}
