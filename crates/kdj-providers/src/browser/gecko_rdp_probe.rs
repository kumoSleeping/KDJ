//! Read-only feasibility probe for Gecko's Browser Toolbox protocol.
//! No profile changes, cookie access, script evaluation, or browser restarts.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};

const MAX_PACKET: usize = 1024 * 1024;

async fn packet(stream: &mut TcpStream) -> Result<Value> {
    let mut length = String::new();
    loop {
        let byte = stream.read_u8().await?;
        if byte == b':' {
            break;
        }
        anyhow::ensure!(
            byte.is_ascii_digit() && length.len() < 7,
            "Invalid RDP frame"
        );
        length.push(char::from(byte));
    }
    let length: usize = length.parse()?;
    anyhow::ensure!(length > 0 && length <= MAX_PACKET, "RDP frame too large");
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn probe(port: u16) -> Result<usize> {
    // A single connection: denial/timeout must never cause repeated permission prompts.
    let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let greeting = packet(&mut stream).await?;
    anyhow::ensure!(
        greeting["from"] == "root" && greeting["applicationType"] == "browser",
        "Not a Gecko browser RDP endpoint"
    );
    let request = json!({"to":"root", "type":"listTabs"}).to_string();
    stream
        .write_all(format!("{}:{request}", request.len()).as_bytes())
        .await?;
    for _ in 0..32 {
        let response = packet(&mut stream).await?;
        if response["from"] != "root" {
            continue;
        }
        if response.get("error").is_some() {
            bail!("Browser refused tab discovery");
        }
        if let Some(tabs) = response["tabs"].as_array() {
            // Deliberately return only a count; never print titles, URLs or credentials.
            stream.shutdown().await?;
            return Ok(tabs.len());
        }
    }
    bail!("No tab discovery response")
}

#[tokio::test]
async fn probe_handles_fragmented_packets_and_unrelated_events() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let greeting = json!({"from":"root","applicationType":"browser"}).to_string();
        for byte in format!("{}:{greeting}", greeting.len()).bytes() {
            stream.write_all(&[byte]).await.unwrap();
        }
        assert_eq!(
            packet(&mut stream).await.unwrap(),
            json!({"to":"root","type":"listTabs"})
        );
        for value in [
            json!({"from":"other","type":"event"}),
            json!({"from":"root","tabs":[{},{}]}),
        ] {
            let body = value.to_string();
            stream
                .write_all(format!("{}:{body}", body.len()).as_bytes())
                .await
                .unwrap();
        }
    });
    assert_eq!(
        timeout(Duration::from_secs(2), probe(port))
            .await
            .unwrap()
            .unwrap(),
        2
    );
    server.await.unwrap();
}

#[tokio::test]
async fn probe_rejects_oversized_packets_without_allocating_the_payload() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        stream.write_all(b"9999999:").await.unwrap();
    });
    assert!(timeout(Duration::from_secs(2), probe(port))
        .await
        .unwrap()
        .is_err());
    server.await.unwrap();
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires an explicitly enabled local Browser Toolbox and browser connection approval"]
async fn live_selected_browser_toolbox() -> Result<()> {
    let browser_id =
        std::env::var("KDJ_TEST_RDP_BROWSER").context("Select a browser installation")?;
    let browser = super::discovery::installed()
        .into_iter()
        .find(|browser| {
            browser.id == browser_id || browser.adapter_id.as_deref() == Some(&browser_id)
        })
        .context("Selected browser is not installed")?;
    let port: u16 = std::env::var("KDJ_TEST_RDP_PORT")?.parse()?;
    // Verify ownership before sending even a metadata request. Do not scan unrelated ports.
    let output = tokio::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-a", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fp"])
        .output()
        .await?;
    let pids: Vec<u32> = String::from_utf8(output.stdout)?
        .lines()
        .filter_map(|line| line.strip_prefix('p').and_then(|pid| pid.parse().ok()))
        .collect();
    anyhow::ensure!(pids.len() == 1, "Ambiguous or missing listener");
    let mut bytes = [0u8; 4096];
    let count = unsafe {
        libc::proc_pidpath(
            pids[0] as i32,
            bytes.as_mut_ptr().cast(),
            bytes.len() as u32,
        )
    };
    anyhow::ensure!(count > 0, "Cannot verify browser process");
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .context("Invalid process path")?;
    use std::os::unix::ffi::OsStrExt;
    let executable =
        std::path::Path::new(std::ffi::OsStr::from_bytes(&bytes[..end])).canonicalize()?;
    anyhow::ensure!(
        executable.starts_with(browser.executable.join("Contents/MacOS")),
        "Listener belongs to another application"
    );
    let count = timeout(Duration::from_secs(60), probe(port))
        .await
        .context("Browser connection was not approved within 60 seconds")??;
    eprintln!("Gecko RDP connected; {count} tab descriptors available; no credentials read");
    Ok(())
}
