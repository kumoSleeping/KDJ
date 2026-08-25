//! 桌面浏览器 Profile 枚举与定点 Cookie 读取。
//!
//! 前端只接触短 id 和可读名称；数据库路径、Cookie 内容与解密过程始终留在
//! Rust 进程内。YouTube、SoundCloud 等 provider 共用这里，避免各自维护一份
//! 浏览器名单和 Profile 选择规则。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct BrowserProfileOption {
    pub id: String,
    pub label: String,
    pub requires_elevation: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserOption {
    pub id: String,
    pub label: String,
    pub profiles: Vec<BrowserProfileOption>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserCatalog {
    pub supported: bool,
    pub platform: String,
    pub browsers: Vec<BrowserOption>,
}

/// 只枚举本机实际存在的浏览器 Profile，不打开 Cookie 数据库，也不会触发钥匙串。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn catalog() -> BrowserCatalog {
    let mut browsers = supported_browsers()
        .into_iter()
        .filter_map(|(id, label)| {
            let profiles = rookie::browser_profiles(id).ok()?;
            if profiles.is_empty() {
                return None;
            }
            let newest = profiles
                .iter()
                .map(|profile| profile.last_modified)
                .max()
                .unwrap_or(0);
            Some((
                newest,
                BrowserOption {
                    id: id.into(),
                    label: label.into(),
                    profiles: profiles
                        .into_iter()
                        .map(|profile| BrowserProfileOption {
                            id: profile.id,
                            label: profile.name,
                            requires_elevation: profile.requires_elevation,
                        })
                        .collect(),
                },
            ))
        })
        .collect::<Vec<_>>();
    // 最近使用的 Cookie 库排前面，通常就是用户此刻登录目标站点的 Profile。
    browsers.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.label.cmp(&right.1.label))
    });
    BrowserCatalog {
        supported: true,
        platform: std::env::consts::OS.into(),
        browsers: browsers.into_iter().map(|(_, browser)| browser).collect(),
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn catalog() -> BrowserCatalog {
    BrowserCatalog {
        supported: false,
        platform: std::env::consts::OS.into(),
        browsers: Vec::new(),
    }
}

/// 从用户明确选择的一个 Profile 读取限定域名的 Cookie。调用方仍需只挑自己需要
/// 的 Cookie，不能把整份结果保存或返回前端。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn profile_cookies(
    browser: &str,
    profile_id: Option<&str>,
    domains: Vec<String>,
) -> anyhow::Result<BrowserProfileCookies> {
    use anyhow::Context as _;

    let browser = browser.trim().to_ascii_lowercase();
    let label =
        browser_label(&browser).ok_or_else(|| anyhow::anyhow!("不支持的浏览器：{browser}"))?;
    let profiles =
        rookie::browser_profiles(&browser).map_err(|err| anyhow::anyhow!(err.to_string()))?;
    let selected_id = profile_id
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .or_else(|| profiles.first().map(|profile| profile.id.clone()))
        .context("没有检测到这个浏览器的 Profile")?;
    let (profile, cookies) = rookie::browser_profile_cookies(&browser, &selected_id, Some(domains))
        .map_err(|err| anyhow::anyhow!(err.to_string()))?;
    Ok(BrowserProfileCookies {
        imported_from: format!("{label} · {}", profile.name),
        cookies,
    })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) struct BrowserProfileCookies {
    pub imported_from: String,
    pub cookies: Vec<rookie::enums::Cookie>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn supported_browsers() -> Vec<(&'static str, &'static str)> {
    let mut browsers = vec![
        ("arc", "Arc"),
        ("chrome", "Chrome"),
        ("edge", "Edge"),
        ("firefox", "Firefox"),
        ("brave", "Brave"),
        ("chromium", "Chromium"),
        ("vivaldi", "Vivaldi"),
        ("opera", "Opera"),
        ("opera_gx", "Opera GX"),
        ("zen", "Zen"),
        ("librewolf", "LibreWolf"),
    ];
    #[cfg(target_os = "macos")]
    browsers.push(("safari", "Safari"));
    #[cfg(target_os = "linux")]
    browsers.push(("cachy", "Cachy Browser"));
    #[cfg(target_os = "windows")]
    browsers.push(("octo_browser", "Octo Browser"));
    browsers
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn browser_label(browser: &str) -> Option<&'static str> {
    match browser.trim().to_ascii_lowercase().as_str() {
        "arc" => Some("Arc"),
        "chrome" => Some("Chrome"),
        "edge" => Some("Edge"),
        "firefox" => Some("Firefox"),
        "brave" => Some("Brave"),
        "chromium" => Some("Chromium"),
        "vivaldi" => Some("Vivaldi"),
        "opera" => Some("Opera"),
        "opera_gx" => Some("Opera GX"),
        "zen" => Some("Zen"),
        "librewolf" => Some("LibreWolf"),
        "safari" => Some("Safari"),
        "cachy" => Some("Cachy Browser"),
        "octo_browser" => Some("Octo Browser"),
        _ => None,
    }
}
