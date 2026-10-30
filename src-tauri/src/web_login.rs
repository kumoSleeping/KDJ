//! 手机上的「网页登录」：在 App 里打开平台自己的登录页，用户登录完，把这个站点的 Cookie
//! （含 HttpOnly）交回前端，前端再走和 Cookie-Editor 导出同一个入口
//! `POST /api/accounts/{platform}/login/cookies`。
//!
//! 打开哪个网址、等哪个 Cookie 只在这张表里，前端只给平台名。页面由 native-audio 的
//! WebLoginActivity 打开：独立进程、独立 WebView 配置，打开前和关掉后都清空，
//! 和 App 自己的页面不共用 Cookie。
// 桌面只编进单元测试，命令本身只在安卓上。
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

/// 一个平台的登录页。
struct Site {
    url: &'static str,
    /// 出现其中任何一个，就算登录完成。
    done: &'static [&'static str],
    /// 交回这些网址上的 Cookie；同名的以前面的为准。
    cookie_urls: &'static [&'static str],
    /// 用桌面浏览器的 UA。默认是手机自己的 UA（去掉 WebView 的「; wv」）：网易云和 QQ 音乐
    /// 换成桌面 UA 只剩扫码，同一台手机扫不了自己的屏幕。
    desktop: bool,
}

const DESKTOP_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

fn site(platform: &str) -> Option<Site> {
    Some(match platform {
        // 手机版的登录（@music/ct-mobile-login）：手机号验证码或密码。
        "wyy" => Site {
            url: "https://music.163.com/m/login",
            done: &["MUSIC_U"],
            cookie_urls: &["https://music.163.com/"],
            desktop: false,
        },
        // 手机版「我的」页的登录：QQ 互联或 ptlogin2 的账号密码，回到 y.qq.com/m/login/redirect.html
        // 写下 qqmusic_key。QQ 一键登录跳 QQ App、微信授权只在微信里能用，都回不来。
        "qqm" => Site {
            url: "https://i.y.qq.com/n2/m/index.html",
            done: &["qqmusic_key", "qm_keyst"],
            cookie_urls: &["https://y.qq.com/", "https://i.y.qq.com/"],
            desktop: false,
        },
        "bilibili" => Site {
            url: "https://passport.bilibili.com/h5-app/passport/login",
            done: &["SESSDATA"],
            cookie_urls: &["https://www.bilibili.com/"],
            desktop: false,
        },
        // 手机 UA 会被转到 m.soundcloud.com；登录框在桌面站上。
        "soundcloud" => Site {
            url: "https://soundcloud.com/signin",
            done: &["oauth_token"],
            cookie_urls: &["https://soundcloud.com/"],
            desktop: true,
        },
        _ => return None,
    })
}

/// 各网址的 `Cookie` 值合成一行 `Cookie:`。同名的取第一个；后端整份拒收的
/// （空值、带空白或控制字符、名字不合规）这里先去掉，它们不是登录的一部分。
fn cookie_header(found: &[String]) -> Option<String> {
    let mut seen = std::collections::HashSet::new();
    let pairs: Vec<String> = found
        .iter()
        .flat_map(|cookies| cookies.split(';'))
        .filter_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            let (name, value) = (name.trim(), value.trim());
            let valid = !name.is_empty()
                && !value.is_empty()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b))
                && !value.chars().any(|c| c.is_control() || c.is_whitespace());
            (valid && seen.insert(name.to_owned())).then(|| format!("{name}={value}"))
        })
        .collect();
    (!pairs.is_empty()).then(|| format!("Cookie: {}", pairs.join("; ")))
}

/// 打开 `platform` 的登录页，等用户登录。返回一行 `Cookie:`；用户离开登录页时是 `None`。
#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn web_login(app: tauri::AppHandle, platform: String) -> Result<Option<String>, String> {
    use tauri::Manager;
    use tauri_plugin_native_audio::{NativeAudio, WebLoginArgs};

    let site = site(&platform).ok_or("这个平台不能在网页上登录")?;
    let args = WebLoginArgs {
        url: site.url.into(),
        done_cookies: site.done.iter().map(|name| (*name).into()).collect(),
        cookie_urls: site.cookie_urls.iter().map(|url| (*url).into()).collect(),
        user_agent: site.desktop.then(|| DESKTOP_UA.into()),
        third_party_cookies: true,
    };
    // 结果要等用户在登录页里做完，阻塞的是线程池里的一个线程。
    let found = tokio::task::spawn_blocking(move || app.state::<NativeAudio<tauri::Wry>>().web_login(&args))
        .await
        .map_err(|_| "登录页已退出".to_string())??;
    let Some(found) = found else { return Ok(None) };
    cookie_header(&found).map(Some).ok_or_else(|| "登录页没有留下登录状态".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_site_waits_for_a_cookie_it_reads() {
        for platform in ["wyy", "qqm", "bilibili", "soundcloud"] {
            let site = site(platform).unwrap();
            assert!(site.url.starts_with("https://"));
            assert!(!site.done.is_empty() && !site.cookie_urls.is_empty());
        }
        assert!(site("youtube").is_none());
    }

    #[test]
    fn cookies_of_several_addresses_become_one_line() {
        let found = [
            "MUSIC_U=abc; __csrf=def; empty=; NMTID=x y".to_string(),
            "MUSIC_U=other; JSESSIONID-WYYY=a%2Fb".to_string(),
        ];
        assert_eq!(
            cookie_header(&found).as_deref(),
            Some("Cookie: MUSIC_U=abc; __csrf=def; JSESSIONID-WYYY=a%2Fb")
        );
        assert_eq!(cookie_header(&[String::new()]), None);
    }
}
