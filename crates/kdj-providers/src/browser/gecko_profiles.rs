//! Gecko's existing profiles. Discovery reads application metadata and profiles.ini, never
//! cookies. Unknown forks do not inherit Firefox's profile root. A read covers ordinary tabs
//! only: containers, private windows and partitioned sessions are left out.
use super::discovery::{BrowserEngine, InstalledBrowser};
use anyhow::{Context, Result};
use ini::Ini;
use std::path::{Component, Path, PathBuf};

fn relative_path(value: &str) -> Option<PathBuf> {
    // Application metadata is data, not an arbitrary path supplied by the renderer.
    let value = value.trim().replace('\\', "/");
    let path = PathBuf::from(&value);
    (!value.is_empty()
        && !value.contains(':')
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_))))
    .then_some(path)
}

fn metadata_root(ini: &Ini, base: &Path, windows: bool) -> Option<PathBuf> {
    let app = ini.section(Some("App"))?;
    let relative = if let Some(profile) = app.get("Profile") {
        relative_path(profile)?
    } else {
        let name = relative_path(app.get("Name")?)?;
        if windows {
            match app.get("Vendor").filter(|v| !v.trim().is_empty()) {
                Some(vendor) => relative_path(vendor)?.join(name),
                None => name,
            }
        } else {
            name
        }
    };
    Some(base.join(relative))
}

pub(super) fn profiles(browser: &InstalledBrowser) -> Result<Vec<rookie::BrowserProfile>> {
    anyhow::ensure!(
        browser.engine == Some(BrowserEngine::Gecko),
        "此浏览器没有可读取的配置"
    );
    // Known stable installations retain their established, platform-specific profile discovery.
    if let Some(adapter @ ("firefox" | "zen" | "librewolf" | "cachy")) =
        browser.adapter_id.as_deref()
    {
        return rookie::browser_profiles(adapter)
            .map_err(|_| anyhow::anyhow!("无法查找浏览器配置"));
    }
    let (metadata, base) = if cfg!(target_os = "macos") {
        (
            browser
                .executable
                .join("Contents/Resources/application.ini"),
            PathBuf::from(std::env::var_os("HOME").context("无法定位浏览器配置")?)
                .join("Library/Application Support"),
        )
    } else {
        (
            browser
                .executable
                .parent()
                .context("浏览器路径无效")?
                .join("application.ini"),
            PathBuf::from(std::env::var_os("APPDATA").context("无法定位浏览器配置")?),
        )
    };
    let mut roots = Vec::new();
    if let Ok(ini) = Ini::load_from_file(&metadata) {
        if let Some(root) = metadata_root(&ini, &base, cfg!(target_os = "windows")) {
            roots.push(root);
        }
    }
    // Portable forks may explicitly keep their registry alongside their executable.
    if let Some(parent) = browser
        .executable
        .parent()
        .filter(|p| p.join("profiles.ini").is_file())
    {
        roots.push(parent.to_owned());
    }
    rookie::mozilla_profiles_from_roots(&browser.id, &roots)
        .map_err(|_| anyhow::anyhow!("无法查找浏览器配置"))
}

pub(super) fn read(
    browser: &InstalledBrowser,
    profile: Option<&str>,
    domains: Vec<String>,
) -> Result<super::BrowserProfileCookies> {
    let mut profiles = profiles(browser)?;
    // The catalog lists the most recently used profile first; no choice means that one.
    let selected = match profile {
        Some(id) => profiles
            .into_iter()
            .find(|p| p.id == id)
            .context("所选浏览器配置已不可用，请重新检测")?,
        None => {
            anyhow::ensure!(!profiles.is_empty(), "没有检测到这个浏览器的配置");
            profiles.remove(0)
        }
    };
    let cookies = rookie::mozilla_profile_cookies(&selected, domains)
        .map_err(|_| anyhow::anyhow!("读取浏览器登录状态失败；请稍后重试"))?;
    Ok(super::BrowserProfileCookies {
        imported_from: format!("{} · {}", browser.label, selected.name),
        cookies,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_fork_uses_its_own_metadata_not_firefox_or_brand_guessing() {
        let ini = Ini::load_from_str("[App]\nName=Mystery\nVendor=Example\n").unwrap();
        assert_eq!(
            metadata_root(&ini, Path::new("base"), false),
            Some(PathBuf::from("base/Mystery"))
        );
        assert_eq!(
            metadata_root(&ini, Path::new("base"), true),
            Some(PathBuf::from("base/Example/Mystery"))
        );
        let ini = Ini::load_from_str("[App]\nName=Mystery\nProfile=custom/profile\n").unwrap();
        assert_eq!(
            metadata_root(&ini, Path::new("base"), true),
            Some(PathBuf::from("base/custom/profile"))
        );
        for invalid in ["../Firefox", "/Firefox", "C:\\Firefox", "..\\Firefox", ""] {
            assert!(relative_path(invalid).is_none());
        }
    }
}
