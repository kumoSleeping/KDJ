//! 检查更新：问 GitHub 的最新 Release，和本机版本比。
//!
//! 只做"检查 + 告诉前端有没有新版"。**真正的替换**分平台走：
//! 桌面是 tauri-plugin-updater（minisign 校验 + 原地替换 + 重启），
//! 安卓/浏览器只能开 Release 页让用户自己下——所以这个接口的职责
//! 止步于"版本号 + 下载页 URL"，别把安装逻辑塞进来。

use anyhow::{Context, Result};
use semver::{Prerelease, Version};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AndroidAbi {
    Arm64,
    Arm32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AndroidApkKind {
    Arm64,
    Arm32,
    Universal,
}

fn host_android_abi() -> AndroidAbi {
    // 与 rustc target 一致：aarch64-linux-android → "aarch64"；
    // armv7-linux-androideabi → "arm"。
    match std::env::consts::ARCH {
        "aarch64" => AndroidAbi::Arm64,
        "arm" => AndroidAbi::Arm32,
        other if other.contains("64") => AndroidAbi::Arm64,
        _ => AndroidAbi::Arm32,
    }
}

/// 按文件名识别 APK ABI。必须先判 arm64，否则 `arm64` 会被 `arm` 误吃。
fn classify_android_apk(name: &str) -> Option<AndroidApkKind> {
    let lower = name.to_ascii_lowercase();
    if !lower.ends_with(".apk") || lower.contains("unsigned") {
        return None;
    }
    if lower.contains("arm64") || lower.contains("aarch64") {
        return Some(AndroidApkKind::Arm64);
    }
    if lower.contains("armeabi")
        || lower.contains("armv7")
        || lower.contains("-arm-")
        || lower.contains("_arm_")
        || lower.contains("-arm.")
        || lower.contains("_arm.")
    {
        return Some(AndroidApkKind::Arm32);
    }
    if lower.contains("universal") {
        return Some(AndroidApkKind::Universal);
    }
    None
}

/// Android 的 GitHub 渠道只认正式签名 APK，并按本机 ABI 选包。
/// Release 可能先创建、APK 十几分钟后才传完；这段窗口里宁可提示「发布中」
/// 也不能把 unsigned 包、错 ABI 包或 Release 首页当成可安装更新交给用户。
fn signed_android_apk_url(body: &serde_json::Value, prefer: AndroidAbi) -> Option<&str> {
    let assets = body["assets"].as_array()?;
    let mut preferred = None;
    let mut universal = None;
    for asset in assets {
        let name = asset["name"].as_str()?;
        let Some(kind) = classify_android_apk(name) else {
            continue;
        };
        let url = asset["browser_download_url"].as_str()?;
        match kind {
            AndroidApkKind::Arm64 if prefer == AndroidAbi::Arm64 && preferred.is_none() => {
                preferred = Some(url);
            }
            AndroidApkKind::Arm32 if prefer == AndroidAbi::Arm32 && preferred.is_none() => {
                preferred = Some(url);
            }
            AndroidApkKind::Universal if universal.is_none() => {
                universal = Some(url);
            }
            _ => {}
        }
    }
    preferred.or(universal)
}

/// GitHub tag → 可比较的版本。tag 写作 `v1.1.0-rc19`，semver 会把 `rc19`
/// 当成一个字母数字标识按字符串比（`rc10 < rc9`），所以把 `alpha`/`beta`/`rc`
/// 后面直接跟的序号拆成 `rc.19`，让序号按数字比；规则与桌面
/// `src-tauri/src/release_version.rs` 一致。解析不了返回 None。
fn release_version(version: &str) -> Option<Version> {
    let mut version = Version::parse(version.trim().trim_start_matches('v')).ok()?;
    for stage in ["alpha", "beta", "rc"] {
        let Some(sequence) = version.pre.as_str().strip_prefix(stage) else {
            continue;
        };
        if !sequence.is_empty() && sequence.bytes().all(|byte| byte.is_ascii_digit()) {
            if let Ok(pre) = Prerelease::new(&format!("{stage}.{sequence}")) {
                version.pre = pre;
            }
        }
        break;
    }
    Some(version)
}

/// `candidate` 是否比 `current` 新。任一边解析不了都算"不新"——
/// 宁可把奇形怪状的 tag 当旧版本忽略，也别在这里 panic 或误报更新。
fn is_newer(current: &str, candidate: &str) -> bool {
    match (release_version(current), release_version(candidate)) {
        (Some(current), Some(candidate)) => candidate > current,
        _ => false,
    }
}

pub async fn check(current: &str) -> Result<UpdateInfo> {
    kdj_core::ensure_rustls_ring();
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
    let newer = is_newer(current, &tag);
    let release_url = body["html_url"].as_str().unwrap_or_default();
    let url = if cfg!(target_os = "android") {
        match signed_android_apk_url(&body, host_android_abi()) {
            Some(url) => url,
            None if newer => anyhow::bail!("新版本正在生成签名 APK，请稍后再检查"),
            None => release_url,
        }
    } else {
        release_url
    };
    Ok(UpdateInfo {
        newer,
        latest: tag.trim_start_matches('v').to_string(),
        current: current.to_string(),
        url: url.to_string(),
        name: body["name"].as_str().unwrap_or(&tag).to_string(),
        published_at: body["published_at"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        notes: body["body"].as_str().unwrap_or_default().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_like_humans_expect() {
        assert!(is_newer("0.2.1", "v0.3.0"));
        assert!(is_newer("0.2.9", "0.2.10"), "逐段数值比，不是字符串比");
        assert!(is_newer("0.99.99", "1.0.0"));
        assert!(!is_newer("0.2.1", "v0.2.1"), "v 前缀不参与比较");
        assert!(!is_newer("v0.2.1", "0.2.1"));
    }

    #[test]
    fn rc_tags_are_compared_by_sequence_number() {
        for (current, tag, expected) in [
            // 1.1.0-rc18 → rc19：曾经被当成同一个 (1,1,0)，安卓收不到提示
            ("1.1.0-rc18", "v1.1.0-rc19", true),
            ("1.1.0-rc19", "v1.1.0-rc18", false),
            ("1.1.0-rc19", "v1.1.0-rc19", false),
            // rc9 → rc10：semver 原样按字符串比会得出 rc10 < rc9
            ("1.1.0-rc9", "v1.1.0-rc10", true),
            ("1.1.0-rc10", "v1.1.0-rc9", false),
            // 预发布 → 同号正式版是升级，反过来不是
            ("1.1.0-rc19", "v1.1.0", true),
            ("1.1.0", "v1.1.0-rc19", false),
            // 正式版 → 下一个 patch 的 rc 是升级，不是回退
            ("1.1.0", "v1.1.1-rc1", true),
            ("1.1.1-rc1", "v1.1.0", false),
            ("1.0.2", "v1.1.0-rc1", true),
            ("1.1.0-rc19", "v1.0.9", false),
        ] {
            assert_eq!(is_newer(current, tag), expected, "{current} -> {tag}");
        }
    }

    #[test]
    fn unparseable_tags_are_never_newer() {
        for tag in ["nightly", "", "v", "1.1", "v1.1.0-", "1.1.0-rc19 beta", "release-1.2.0", "latest"] {
            assert!(!is_newer("1.1.0-rc19", tag), "{tag:?}");
            assert!(!is_newer("0.0.1", tag), "{tag:?}");
        }
        assert!(!is_newer("not-a-version", "v9.9.9"), "本机版本解析不了时也不报更新");
    }

    #[test]
    fn classify_distinguishes_arm_from_arm64() {
        assert_eq!(
            classify_android_apk("app-arm64-release.apk"),
            Some(AndroidApkKind::Arm64)
        );
        assert_eq!(
            classify_android_apk("app-arm-release.apk"),
            Some(AndroidApkKind::Arm32)
        );
        assert_eq!(
            classify_android_apk("app-universal-release.apk"),
            Some(AndroidApkKind::Universal)
        );
        assert_eq!(classify_android_apk("app-arm-release-unsigned.apk"), None);
        assert_eq!(classify_android_apk("KDJ.dmg"), None);
    }

    #[test]
    fn android_prefers_matching_abi_over_asset_order() {
        // 真实 Release 里 arm 常排在 arm64 前面；旧逻辑 find_map 会误下 32 位包。
        let release = serde_json::json!({
            "assets": [
                {"name": "app-arm-release.apk", "browser_download_url": "arm32"},
                {"name": "app-arm64-release.apk", "browser_download_url": "arm64"},
                {"name": "app-universal-release-unsigned.apk", "browser_download_url": "bad"}
            ]
        });
        assert_eq!(
            signed_android_apk_url(&release, AndroidAbi::Arm64),
            Some("arm64")
        );
        assert_eq!(
            signed_android_apk_url(&release, AndroidAbi::Arm32),
            Some("arm32")
        );
    }

    #[test]
    fn android_falls_back_to_universal_not_wrong_abi() {
        let only_arm32 = serde_json::json!({
            "assets": [
                {"name": "app-arm-release.apk", "browser_download_url": "arm32"}
            ]
        });
        assert_eq!(
            signed_android_apk_url(&only_arm32, AndroidAbi::Arm64),
            None,
            "64 位机不能回落到 32 位包"
        );

        let with_universal = serde_json::json!({
            "assets": [
                {"name": "app-arm-release.apk", "browser_download_url": "arm32"},
                {"name": "app-universal-release.apk", "browser_download_url": "uni"}
            ]
        });
        assert_eq!(
            signed_android_apk_url(&with_universal, AndroidAbi::Arm64),
            Some("uni")
        );
        assert_eq!(
            signed_android_apk_url(&serde_json::json!({"assets": []}), AndroidAbi::Arm64),
            None
        );
    }
}
