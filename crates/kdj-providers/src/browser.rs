//! 桌面浏览器登录的复用：枚举本机浏览器和它们的配置，从用户选定的那一个里读限定域名的
//! Cookie。读不到磁盘配置的两种情况（Arc 的系统自动化、临时登录窗口）在 `authorization`。
//! 哪条路都读不了的浏览器，KDJ 只替用户在它里面打开网页（`open_page`），登录由用户自己用
//! 扩展导出再交回来。
//!
//! 前端只接触短 id 和可读名称；数据库路径、Cookie 内容与解密过程始终留在 Rust 进程内。
//! 所有 provider 共用这里，避免各自维护一份浏览器名单和配置选择规则。

use serde::Serialize;

pub mod authorization;
pub mod discovery;
pub mod login_trace;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod gecko_profiles;

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod profile_tests;

#[derive(Debug, Clone, Serialize)]
pub struct BrowserProfileOption {
    pub id: String,
    pub label: String,
}

/// 一个可以拿来登录的浏览器。`reuse`：它已有的登录可以直接读；`open`：KDJ 能在它里面打开一个
/// 网页。都是能力，不代表这一次一定成功。KDJ 不开自己的登录窗口。
#[derive(Debug, Clone, Serialize)]
pub struct LoginBrowser {
    pub id: String,
    pub label: String,
    pub profiles: Vec<BrowserProfileOption>,
    pub reuse: bool,
    pub open: bool,
}

/// 用户自己交来的登录（扩展导出的、从请求头里取的）在给用户看的话里叫什么，对应读取时的
/// 「Chrome · 默认」。
pub(crate) const IMPORTED_LOGIN: &str = "导入的内容";

/// 浏览器开发者工具里复制出来的请求头（或只有 Cookie 那一行）里的 Cookie，名字 → 值。
/// 内容不进日志，报错里也不引用它。
pub fn cookies_from_headers(raw: &str) -> anyhow::Result<std::collections::BTreeMap<String, String>> {
    let raw = raw.trim();
    anyhow::ensure!(!raw.is_empty(), "请粘贴请求头");
    anyhow::ensure!(
        raw.len() <= 256 * 1024,
        "请求头内容过大，请只粘贴这个站点的请求头"
    );
    let headers = crate::youtubemusic::auth::parse_headers(raw)?;
    let cookie = match headers.get("cookie") {
        Some(cookie) => cookie.as_str(),
        // 只粘了 Cookie 的值，没有带名字的那一行。
        None if !raw.contains('\n') && raw.contains('=') => raw,
        None => anyhow::bail!("请求头里没有 Cookie 这一行"),
    };
    let cookies: std::collections::BTreeMap<String, String> = cookie
        .split(';')
        .filter_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            let (name, value) = (name.trim(), value.trim());
            (!name.is_empty() && !value.is_empty()).then(|| (name.to_owned(), value.to_owned()))
        })
        .collect();
    anyhow::ensure!(!cookies.is_empty(), "请求头里没有 Cookie 这一行");
    Ok(cookies)
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserCatalog {
    pub supported: bool,
    pub platform: String,
    pub browsers: Vec<LoginBrowser>,
}

/// 只枚举本机实际存在的浏览器和配置，不打开 Cookie 数据库，也不会触发钥匙串。
/// 认得出是浏览器的安装都列出来：读不了已有登录的那些，用户仍可以在里面导出登录。
/// `arc_automation`：这个平台的登录在 Arc 里走它的系统自动化读取（SoundCloud），不选配置。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn catalog(arc_automation: bool) -> BrowserCatalog {
    let mut browsers = Vec::new();
    let mut covered = std::collections::HashSet::new();
    for installation in discovery::installed() {
        if let Some(adapter) = &installation.adapter_id {
            covered.insert(adapter.clone());
        }
        let automated = arc_automation && authorization::automated(&installation);
        let profiles = if automated {
            Vec::new()
        } else {
            installation_profiles(&installation)
        };
        // Windows 上的 Chromium 运行时锁住 Cookie 库，密钥又绑定在浏览器自身：不去试。
        let locked = cfg!(target_os = "windows")
            && installation.engine == Some(discovery::BrowserEngine::Chromium);
        let reuse = automated || (!profiles.is_empty() && !locked);
        // 系统登记的网页处理应用不都是浏览器：认得内核或认得厂商的才算。
        let open = installation.engine.is_some() || installation.adapter_id.is_some();
        if reuse || open {
            let (newest, mut browser) =
                login_browser(installation.id, installation.label, profiles, reuse);
            browser.open = open;
            browsers.push((newest, browser));
        }
    }
    // 配置数据可以比应用活得久，Linux 上也没有安装登记可查：按 vendor id 补上其余的。
    for (id, label) in supported_browsers() {
        if covered.contains(id) {
            continue;
        }
        let profiles = rookie::browser_profiles(id).unwrap_or_default();
        if !profiles.is_empty() {
            browsers.push(login_browser(id.into(), label.into(), profiles, true));
        }
    }
    // 最近使用的 Cookie 库排前面，通常就是用户此刻登录目标站点的那个浏览器。
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
pub fn catalog(_arc_automation: bool) -> BrowserCatalog {
    BrowserCatalog {
        supported: false,
        platform: std::env::consts::OS.into(),
        browsers: Vec::new(),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn installation_profiles(installation: &discovery::InstalledBrowser) -> Vec<rookie::BrowserProfile> {
    if installation.engine == Some(discovery::BrowserEngine::Gecko) {
        return gecko_profiles::profiles(installation).unwrap_or_default();
    }
    installation
        .adapter_id
        .as_deref()
        .filter(|adapter| browser_label(adapter).is_some())
        .and_then(|adapter| rookie::browser_profiles(adapter).ok())
        .unwrap_or_default()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn login_browser(
    id: String,
    label: String,
    profiles: Vec<rookie::BrowserProfile>,
    reuse: bool,
) -> (u64, LoginBrowser) {
    let newest = profiles
        .iter()
        .map(|profile| profile.last_modified)
        .max()
        .unwrap_or(0);
    let profiles = profiles
        .into_iter()
        .map(|profile| BrowserProfileOption {
            id: profile.id,
            label: profile.name,
        })
        .collect();
    (
        newest,
        LoginBrowser {
            id,
            label,
            profiles,
            reuse,
            open: false,
        },
    )
}

/// 在用户选定的那个浏览器里打开一个网页：它平时的窗口、平时的配置。KDJ 不带任何启动参数，
/// 也不从它读回任何东西。`url` 由调用方从固定的表里取，不来自请求。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn open_page(browser: &str, url: &str) -> anyhow::Result<()> {
    use anyhow::Context as _;
    use std::process::{Command, Stdio};

    let installation = discovery::installed()
        .into_iter()
        .find(|installation| installation.id == browser)
        .context("没有找到这个浏览器，请重新检测")?;
    // macOS 的安装是一个应用包，交给系统去打开；别处直接启动它的程序，已在运行的浏览器会
    // 把网址接过去。
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("/usr/bin/open");
        command.arg("-a").arg(&installation.executable);
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new(discovery::plain_path(&installation.executable));
    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let failed = || format!("没能打开 {}", installation.label);
    #[cfg(target_os = "macos")]
    anyhow::ensure!(command.status().with_context(failed)?.success(), failed());
    #[cfg(not(target_os = "macos"))]
    command.spawn().with_context(failed)?;
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn open_page(_browser: &str, _url: &str) -> anyhow::Result<()> {
    anyhow::bail!("移动端没有可选的浏览器")
}

/// 从用户明确选择的一个配置读取限定域名的 Cookie；没选配置就是最近用过的那个。调用方
/// 仍需只挑自己需要的 Cookie，不能把整份结果保存或返回前端。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn profile_cookies(
    browser: &str,
    profile_id: Option<&str>,
    domains: Vec<String>,
) -> anyhow::Result<BrowserProfileCookies> {
    use anyhow::Context as _;

    let profile_id = profile_id.map(str::trim).filter(|id| !id.is_empty());
    // 每次都重新查一遍安装：请求里的 id 只能选中一个已登记的浏览器，变不成任意路径。
    let installation = discovery::installed()
        .into_iter()
        .find(|installation| installation.id == browser);
    if let Some(installation) = installation
        .as_ref()
        .filter(|installation| installation.engine == Some(discovery::BrowserEngine::Gecko))
    {
        return gecko_profiles::read(installation, profile_id, domains);
    }
    let (adapter, label) = match installation {
        Some(installation) => (
            installation
                .adapter_id
                .context("这个浏览器没有可读取的登录数据")?,
            installation.label,
        ),
        None => {
            let adapter = browser.trim().to_ascii_lowercase();
            let label = browser_label(&adapter)
                .with_context(|| format!("不支持的浏览器：{adapter}"))?;
            (adapter, label.to_string())
        }
    };
    anyhow::ensure!(
        browser_label(&adapter).is_some(),
        "这个浏览器没有可读取的登录数据"
    );
    let profiles =
        rookie::browser_profiles(&adapter).map_err(|err| anyhow::anyhow!(err.to_string()))?;
    let selected_id = profile_id
        .map(str::to_string)
        .or_else(|| profiles.first().map(|profile| profile.id.clone()))
        .context("没有检测到这个浏览器的配置")?;
    let (profile, cookies) = rookie::browser_profile_cookies(&adapter, &selected_id, Some(domains))
        .map_err(|err| {
            let cause = err.to_string();
            // 读取层自己写给用户看的话（Safari 的权限提示）原样给；其余是库的内部报错，
            // 留在日志里，界面上说人话。
            if cause.is_ascii() {
                tracing::warn!(target: "kdj::login", browser = adapter, cause, "browser profile not readable");
                anyhow::anyhow!("没能读到 {label} 里的登录：它运行时会锁住登录数据，或由它自己加密")
            } else {
                anyhow::anyhow!(cause)
            }
        })?;
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

/// 站点的登录就是几个具名 Cookie 时（网易云、QQ 音乐、哔哩哔哩）用这个：只留名单里的、
/// 属于这些域名的、没过期的 Cookie；同名的取域名更具体、过期更晚的那一个。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn named_cookies(
    imported: BrowserProfileCookies,
    domains: &[&str],
    names: &[&str],
) -> (std::collections::BTreeMap<String, String>, String) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let mut chosen: std::collections::BTreeMap<String, (usize, u64, String)> = Default::default();
    for cookie in imported.cookies {
        let domain = cookie.domain.trim_start_matches('.');
        let in_site = domains
            .iter()
            .any(|site| domain == *site || domain.ends_with(&format!(".{site}")));
        let live = cookie.expires.is_none_or(|expires| expires == 0 || expires > now);
        let Some(name) = names
            .iter()
            .find(|name| name.eq_ignore_ascii_case(&cookie.name))
        else {
            continue;
        };
        if !in_site || !live || cookie.value.trim().is_empty() {
            continue;
        }
        let rank = (domain.len(), cookie.expires.unwrap_or(u64::MAX));
        if chosen
            .get(*name)
            .is_none_or(|(length, expires, _)| (*length, *expires) < rank)
        {
            chosen.insert((*name).to_string(), (rank.0, rank.1, cookie.value));
        }
    }
    (
        chosen
            .into_iter()
            .map(|(name, (_, _, value))| (name, value))
            .collect(),
        imported.imported_from,
    )
}

/// 读这个浏览器的登录不会弹出任何东西：Gecko 内核的 Cookie 库不加密，Safari 只看完全磁盘访问权限。
/// Chromium 内核要钥匙串 / 系统密钥环（可能弹授权框），Arc 走它的自动化，都不算。
/// 账号掉线后后台自动从原来的浏览器再读一次，只对这些浏览器做。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn reads_without_prompt(browser: &str) -> bool {
    if let Some(installation) = discovery::installed()
        .into_iter()
        .find(|installation| installation.id == browser)
    {
        return installation.engine == Some(discovery::BrowserEngine::Gecko)
            || installation.adapter_id.as_deref() == Some("safari");
    }
    matches!(
        browser.trim().to_ascii_lowercase().as_str(),
        "firefox" | "zen" | "librewolf" | "cachy" | "safari"
    )
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn reads_without_prompt(_browser: &str) -> bool {
    false
}

/// 读选定配置里一个站点的具名登录 Cookie；磁盘读取放在 blocking 线程。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) async fn reuse_named_cookies(
    browser: &str,
    profile: Option<&str>,
    domains: &'static [&'static str],
    names: &'static [&'static str],
) -> anyhow::Result<(std::collections::BTreeMap<String, String>, String)> {
    use anyhow::Context as _;

    let (browser, profile) = (browser.to_owned(), profile.map(str::to_owned));
    let imported = tokio::task::spawn_blocking(move || {
        profile_cookies(
            &browser,
            profile.as_deref(),
            domains.iter().map(|domain| domain.to_string()).collect(),
        )
    })
    .await
    .context("读取浏览器登录状态任务失败")??;
    Ok(named_cookies(imported, domains, names))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) async fn reuse_named_cookies(
    _browser: &str,
    _profile: Option<&str>,
    _domains: &'static [&'static str],
    _names: &'static [&'static str],
) -> anyhow::Result<(std::collections::BTreeMap<String, String>, String)> {
    anyhow::bail!("移动端无法读取其它应用的浏览器登录")
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

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::*;

    fn cookie(name: &str, value: &str, domain: &str, expires: Option<u64>) -> rookie::enums::Cookie {
        rookie::enums::Cookie {
            domain: domain.into(),
            path: "/".into(),
            secure: true,
            expires,
            name: name.into(),
            value: value.into(),
            http_only: true,
            same_site: 0,
        }
    }

    #[test]
    fn cookies_come_out_of_pasted_headers_or_a_bare_cookie_line() {
        let pasted = "accept: */*\ncookie: MUSIC_U=abc; __csrf=def\nuser-agent: test";
        let expected: std::collections::BTreeMap<String, String> =
            [("MUSIC_U", "abc"), ("__csrf", "def")].map(|(name, value)| (name.to_owned(), value.to_owned())).into();
        assert_eq!(cookies_from_headers(pasted).unwrap(), expected);
        assert_eq!(cookies_from_headers("MUSIC_U=abc; __csrf=def").unwrap(), expected);
        assert_eq!(cookies_from_headers("Cookie: MUSIC_U=abc; __csrf=def").unwrap(), expected);
        for refused in ["", "accept: */*\nuser-agent: test", "plain words"] {
            assert!(cookies_from_headers(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn named_cookies_keep_only_the_live_login_cookies_of_the_site() {
        let (cookies, source) = named_cookies(
            BrowserProfileCookies {
                imported_from: "测试浏览器 · 用户".into(),
                cookies: vec![
                    cookie("SESSDATA", "site-wide", ".bilibili.com", Some(u64::MAX - 1)),
                    cookie("SESSDATA", "expired", "www.bilibili.com", Some(1)),
                    cookie("sessdata", "other-site", ".bilibili.com.evil.test", None),
                    cookie("bili_jct", "", ".bilibili.com", None),
                    cookie("unrelated", "x", ".bilibili.com", None),
                    cookie("DedeUserID", "42", ".bilibili.com", None),
                ],
            },
            &["bilibili.com"],
            &["SESSDATA", "bili_jct", "DedeUserID"],
        );
        assert_eq!(source, "测试浏览器 · 用户");
        assert_eq!(
            cookies.into_iter().collect::<Vec<_>>(),
            vec![
                ("DedeUserID".to_string(), "42".to_string()),
                ("SESSDATA".to_string(), "site-wide".to_string()),
            ]
        );
    }

    #[test]
    fn named_cookies_prefer_the_more_specific_domain() {
        let (cookies, _) = named_cookies(
            BrowserProfileCookies {
                imported_from: String::new(),
                cookies: vec![
                    cookie("uin", "o0123", ".qq.com", None),
                    cookie("uin", "123", ".y.qq.com", None),
                ],
            },
            &["qq.com"],
            &["uin"],
        );
        assert_eq!(cookies["uin"], "123");
    }
}
