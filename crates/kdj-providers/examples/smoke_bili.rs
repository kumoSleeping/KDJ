//! 真机冒烟：cargo run -p kdj-providers --example smoke_bili -- <BV号或链接>
use kdj_core::models::{Quality, VideoDownloadRequest};
use kdj_providers::{
    bilibili::BilibiliProvider, provider::noop_progress, MusicProvider, ProviderContext,
};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir = std::env::temp_dir().join("kdj-smoke-bili");
    let ctx = ProviderContext {
        data_dir: dir.clone(),
        download_dir: dir.join("dl"),
        filename_template: "{title} - {artist}".into(),
        default_quality: Quality::Flac,
        netease_use_download_api: false,
        soundcloud_enabled: false,
        video_dir: Some(dir.join("video")),
        video_format: "mp4".into(),
    };
    let provider = BilibiliProvider::new(ctx)?;
    let target = std::env::args().nth(1).unwrap_or_else(|| "BV1GJ411x7h7".into());

    println!("== account ==\n{:?}\n", provider.account().await);

    match provider.search("音乐", 3).await {
        Ok(list) => {
            println!("== search -> {} 条 ==", list.len());
            for item in &list {
                println!("  {} | {} | {} | {:?}s", item.key, item.title, item.artist_text(), item.duration);
            }
        }
        Err(err) => println!("== search 失败：{err:#} =="),
    }

    match provider.resolve_video(&target).await {
        Ok(info) => {
            println!("\n== resolve «{}» ==", info.title);
            println!("  bvid={} author={} duration={}s pages={} logged_in={}",
                info.bvid, info.author, info.duration, info.pages.len(), info.logged_in);
            for option in info.options.iter().take(6) {
                println!("   qn={} {} {}p codec={}", option.quality_id, option.label, option.height, option.codec);
            }

            let req = VideoDownloadRequest {
                bvid: info.bvid.clone(), max_height: 360, ..Default::default()
            };
            let cancel = CancellationToken::new();
            match provider.download_video(&req, &cancel, &noop_progress()).await {
                Ok(path) => {
                    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    println!("\n== download OK: {} ({} bytes) ==", path.display(), size);
                }
                Err(err) => println!("\n== download 失败：{err:#} =="),
            }
        }
        Err(err) => println!("\n== resolve 失败：{err:#} =="),
    }

    match provider.create_qr().await {
        Ok(qr) => println!("\n== QR OK: {} ==", qr.url),
        Err(err) => println!("\n== QR 失败：{err:#} =="),
    }
    Ok(())
}
