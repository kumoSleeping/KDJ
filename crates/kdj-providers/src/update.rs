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
    pub notes: String,
}

/// Android 的 GitHub 渠道只认正式签名 APK。Release 可能先创建、APK 十几分钟后
/// 才传完；这段窗口里宁可提示「发布中」也不能把 unsigned 包或 Release 首页
/// 当成可安装更新交给用户。
fn signed_android_apk_url(body: &serde_json::Value) -> Option<&str> {
    body["assets"].as_array()?.iter().find_map(|asset| {
        let name = asset["name"].as_str()?;
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".apk") && !lower.contains("unsigned") {
            asset["browser_download_url"].as_str()
        } else {
            None
        }
    })
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
    let is_newer = triple(&tag) > triple(current);
    let release_url = body["html_url"].as_str().unwrap_or_default();
    let url = if cfg!(target_os = "android") {
        match signed_android_apk_url(&body) {
            Some(url) => url,
            None if is_newer => anyhow::bail!("新版本正在生成签名 APK，请稍后再检查"),
            None => release_url,
        }
    } else {
        release_url
    };
    Ok(UpdateInfo {
        newer: is_newer,
        latest: tag.trim_start_matches('v').to_string(),
        current: current.to_string(),
        url: url.to_string(),
        name: body["name"].as_str().unwrap_or(&tag).to_string(),
        published_at: body["published_at"].as_str().unwrap_or_default().to_string(),
        notes: body["body"].as_str().unwrap_or_default().to_string(),
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

    #[test]
    fn android_selects_only_a_signed_apk_asset() {
        let release = serde_json::json!({
            "assets": [
                {"name": "app-universal-release-unsigned.apk", "browser_download_url": "bad"},
                {"name": "KDJ_0.3.0_universal-release.apk", "browser_download_url": "good"},
                {"name": "KDJ.dmg", "browser_download_url": "other"}
            ]
        });
        assert_eq!(signed_android_apk_url(&release), Some("good"));
        assert_eq!(signed_android_apk_url(&serde_json::json!({"assets": []})), None);
    }
}
