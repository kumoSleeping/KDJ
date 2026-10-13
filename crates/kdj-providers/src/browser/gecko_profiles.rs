//! Gecko's existing profiles, used only after explicit KDJ consent. Discovery reads application
//! metadata and profiles.ini, never cookies. Unknown forks do not inherit Firefox's profile root.
use super::{
    discovery::{BrowserEngine, InstalledBrowser},
    BrowserProfileOption,
};
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

fn profiles(browser: &InstalledBrowser) -> Result<Vec<rookie::BrowserProfile>> {
    anyhow::ensure!(
        browser.engine == Some(BrowserEngine::Gecko),
        "此浏览器不支持已有配置授权"
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

pub(super) fn options(browser: &InstalledBrowser) -> Vec<BrowserProfileOption> {
    profiles(browser)
        .unwrap_or_default()
        .into_iter()
        .map(|p| BrowserProfileOption {
            id: p.id,
            label: p.name,
            requires_elevation: false,
        })
        .collect()
}

pub(super) fn read(
    browser: &InstalledBrowser,
    profile: Option<&str>,
    confirmed: bool,
    domains: Vec<String>,
) -> Result<super::BrowserProfileCookies> {
    anyhow::ensure!(confirmed, "请先允许 KDJ 读取所选浏览器的站点登录状态");
    let profile = profile
        .filter(|id| !id.is_empty())
        .context("请选择浏览器配置；请先在该浏览器的普通标签页登录")?;
    let selected = profiles(browser)?
        .into_iter()
        .find(|p| p.id == profile)
        .context("所选浏览器配置已不可用，请重新检测")?;
    let cookies = rookie::mozilla_profile_cookies(&selected, domains)
        .map_err(|_| anyhow::anyhow!("读取浏览器登录状态失败；请稍后重试"))?;
    Ok(super::BrowserProfileCookies {
        imported_from: format!("{} · {} · KDJ 确认读取", browser.label, selected.name),
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
    #[test]
    fn unconfirmed_read_stops_before_discovery_or_database_access() {
        let browser = InstalledBrowser {
            id: "missing".into(),
            label: "Mystery".into(),
            adapter_id: None,
            direct_read_supported: false,
            authorization_supported: true,
            engine: Some(BrowserEngine::Gecko),
            executable: "/missing".into(),
        };
        let error = read(&browser, Some("missing"), false, vec!["youtube.com".into()])
            .err()
            .unwrap();
        assert!(error.to_string().contains("请先允许"));
    }
}
