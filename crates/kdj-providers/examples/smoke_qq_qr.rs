use kdj_providers::qqmusic::login;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    kdj_core::ensure_rustls_ring();
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .build()?;
    println!("creating dual QR…");
    let dual = login::create_dual_qr(&http).await?;
    if let Some(qq) = &dual.qq {
        println!(
            "QQ connect png={}B qrsig_len={}",
            qq.png.len(),
            qq.qrsig.len()
        );
        std::fs::write("/tmp/kdj-qq-connect.png", &qq.png)?;
    } else {
        println!("QQ connect: unavailable");
    }
    if let Some(mobile) = &dual.mobile {
        println!(
            "QQ Music app png={}B qrcode_id_len={}",
            mobile.png.len(),
            mobile.qrcode_id.len()
        );
        std::fs::write("/tmp/kdj-qqmusic-app.png", &mobile.png)?;
    } else {
        println!("QQ Music app: unavailable");
    }

    // one poll cycle
    let outcome = login::poll_dual_qr(&http, &dual).await?;
    println!("poll => {outcome:?}");
    if let Some(mobile) = &dual.mobile {
        mobile.abort();
    }
    Ok(())
}
