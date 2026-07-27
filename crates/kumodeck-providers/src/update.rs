//! 检查更新：问 GitHub 的最新 Release，和本机版本比。
//!
//! 只做"检查 + 告诉前端有没有新版"。**真正的替换**分平台走：
//! 桌面是 tauri-plugin-updater（minisign 校验 + 原地替换 + 重启），
//! 安卓/浏览器只能开 Release 页让用户自己下——所以这个接口的职责
//! 止步于"版本号 + 下载页 URL"，别把安装逻辑塞进来。

use anyhow::{Context, Result};
use serde::Serialize;

const RELEASES_LATEST: &str = "https://api.github.com/repos/kumoSleeping/KDJ/releases/latest";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub newer: bool,
    /// Release 页 URL，桌面之外的平台点它去下载
    pub url: String,
    pub name: String,
    pub published_at: String,
}

/// "v0.2.1" / "0.2.1" → (0, 2, 1)。解析不了当 (0,0,0)——
/// 宁可把奇形怪状的 tag 当旧版本忽略，也别在这里 panic。
fn triple(version: &str) -> (u64, u64, u64) {
    let clean = version.trim().trim_start_matches('v');
    let mut parts = clean
        .split(['.', '-', '+'])
        .map_while(|part| part.parse::<u64>().ok());
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

pub async fn check(current: &str) -> Result<UpdateInfo> {
    let client = reqwest::Client::builder()
        // GitHub API 拒绝没有 UA 的请求（403），这不是可选项
        .user_agent(format!("KDJ/{current}"))
        .build()?;
    let response = client
        .get(RELEASES_LATEST)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .context("连不上 GitHub，检查网络后重试")?;
    if !response.status().is_success() {
        anyhow::bail!("GitHub 接口返回 {}", response.status());
    }
    let body: serde_json::Value = response.json().await.context("GitHub 返回的不是 JSON")?;
    let tag = body["tag_name"].as_str().unwrap_or_default().to_string();
    if tag.is_empty() {
        anyhow::bail!("GitHub 返回里没有 tag_name，可能还没有任何 Release");
    }
    Ok(UpdateInfo {
        newer: triple(&tag) > triple(current),
        latest: tag.trim_start_matches('v').to_string(),
        current: current.to_string(),
        url: body["html_url"].as_str().unwrap_or_default().to_string(),
        name: body["name"].as_str().unwrap_or(&tag).to_string(),
        published_at: body["published_at"].as_str().unwrap_or_default().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_triples_compare_like_humans_expect() {
        assert!(triple("v0.3.0") > triple("0.2.1"));
        assert!(triple("0.2.10") > triple("0.2.9"), "逐段数值比，不是字符串比");
        assert!(triple("1.0.0") > triple("0.99.99"));
        assert_eq!(triple("v0.2.1"), triple("0.2.1"), "v 前缀不参与比较");
        // 解析不了的当 (0,0,0)：奇形怪状的 tag 永远不会被当成"新版本"
        assert_eq!(triple("nightly"), (0, 0, 0));
        assert!(!(triple("nightly") > triple("0.0.1")));
    }
}
