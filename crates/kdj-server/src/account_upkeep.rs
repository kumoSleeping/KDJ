//! 登录的长期维护（桌面版）。
//!
//! 各平台的续期都在自己的 `account()` 里：QQ 音乐和 B 站的扫码登录按平台的做法续期，YouTube、
//! B 站、网易云在每次请求里收下网站轮换的 Cookie。可这些都要有请求才会发生，所以这里在启动后
//! 不久、之后每隔 [`INTERVAL`] 把有登录的平台核验一遍，状态变了推 `account.changed`。
//!
//! 用「复用浏览器」登录的账号，登录其实还活在那个浏览器里：KDJ 这份失效了，就从同一个浏览器
//! 再读一次。只对读取时不弹任何东西的浏览器这么做（[`kdj_providers::browser::reads_without_prompt`]），
//! 后台不能冒出钥匙串授权框。来源记在 `sessions/login-sources.json`，只有浏览器 id 和配置 id。
//!
//! YouTube 还要更勤一些：浏览器里开着的 YouTube 标签页会不断轮换账号 Cookie，同一份登录 KDJ
//! 手里那份很快就成了旧的，被 Google 收回，所以它看上去比在浏览器里短命得多。复用来的 YouTube
//! 登录每隔 [`YOUTUBE_FRESHEN`] 从原来的浏览器安静地读一次，那边轮换过才重新验证、换上。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use kdj_core::models::Platform;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReuseSource {
    pub browser: String,
    #[serde(default)]
    pub profile: Option<String>,
}

/// 每个平台当前的登录是从哪个浏览器复用来的；用别的方式登录或退出后就没有了。
pub struct LoginSources {
    path: PathBuf,
    sources: Mutex<BTreeMap<String, ReuseSource>>,
}

impl LoginSources {
    pub fn load(path: PathBuf) -> Self {
        let sources = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self { path, sources: Mutex::new(sources) }
    }

    pub fn get(&self, platform: Platform) -> Option<ReuseSource> {
        self.lock().get(platform.as_str()).cloned()
    }

    /// 这个平台换了一份登录：`source` 是复用来的浏览器，别的方式登录或退出时为 None。
    pub fn set(&self, platform: Platform, source: Option<ReuseSource>) {
        let mut sources = self.lock();
        let before = sources.clone();
        match source {
            Some(source) => sources.insert(platform.as_str().to_owned(), source),
            None => sources.remove(platform.as_str()),
        };
        if *sources == before {
            return;
        }
        let written = serde_json::to_vec_pretty(&*sources)
            .map_err(anyhow::Error::from)
            .and_then(|body| {
                let temp = self.path.with_extension("json.tmp");
                std::fs::write(&temp, body)?;
                std::fs::rename(&temp, &self.path)?;
                Ok(())
            });
        if let Err(error) = written {
            tracing::warn!("保存登录来源失败：{error:#}");
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, ReuseSource>> {
        self.sources.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use desktop::{resync_from_browser, spawn};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use kdj_core::models::{Account, AccountState, Platform};

    use crate::state::{AppState, PLATFORMS};

    /// 启动后先等界面连上、首屏的请求过去再核验。
    const FIRST_CHECK: Duration = Duration::from_secs(20);
    /// 之后的间隔。各平台自己的续期另有节奏（B 站 6 小时问一次），这里只保证隔一阵就有请求。
    const INTERVAL: Duration = Duration::from_secs(3 * 60 * 60);
    /// 复用来的 YouTube 登录多久跟浏览器对一次。只读本机的 Cookie 库，没变就不发请求。
    pub(super) const YOUTUBE_FRESHEN: Duration = Duration::from_secs(20 * 60);

    pub fn spawn(state: Arc<AppState>) {
        let youtube = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(FIRST_CHECK + YOUTUBE_FRESHEN).await;
            loop {
                freshen_youtube(&youtube).await;
                tokio::time::sleep(YOUTUBE_FRESHEN).await;
            }
        });
        tokio::spawn(async move {
            tokio::time::sleep(FIRST_CHECK).await;
            let mut published: HashMap<Platform, serde_json::Value> = HashMap::new();
            loop {
                for platform in PLATFORMS {
                    check(&state, platform, &mut published).await;
                }
                tokio::time::sleep(INTERVAL).await;
            }
        });
    }

    async fn check(
        state: &Arc<AppState>,
        platform: Platform,
        published: &mut HashMap<Platform, serde_json::Value>,
    ) {
        let Some(provider) = state.provider(platform) else {
            return;
        };
        if provider.cached_account().await.state == AccountState::Missing {
            published.remove(&platform);
            return;
        }
        let mut account = provider.account().await;
        if account.state == AccountState::Expired {
            if let Some(fresh) = resync_from_browser(state, platform).await {
                account = fresh;
            }
        }
        let Ok(value) = serde_json::to_value(&account) else {
            return;
        };
        if published.get(&platform) != Some(&value) {
            state.hub.publish("account.changed", &account);
            published.insert(platform, value);
        }
    }

    /// 复用来的 YouTube 登录在原来的浏览器里轮换过，就换上那边的新一份。读不到、那边已经退出、
    /// 或者新的验证不过，都留着手里这份。
    async fn freshen_youtube(state: &Arc<AppState>) {
        let Some((platform, source)) = [Platform::Youtube, Platform::Ytm]
            .into_iter()
            .find_map(|platform| state.login_sources.get(platform).map(|source| (platform, source)))
        else {
            return;
        };
        if kdj_providers::browser::authorization::reads_existing(&source.browser) {
            return;
        }
        let auth = if platform == Platform::Ytm { state.ytm_auth.clone() } else { state.youtube_auth.clone() };
        let Some(held) = auth.snapshot() else {
            return;
        };
        let (browser, profile) = (source.browser.clone(), source.profile.clone());
        let read = tokio::task::spawn_blocking(move || {
            kdj_providers::browser::reads_without_prompt(&browser)
                .then(|| auth.import_browser(&browser, profile.as_deref()).ok())
                .flatten()
        })
        .await
        .ok()
        .flatten();
        let Some(read) = read else {
            return;
        };
        if !super::youtube_login_moved(&held.cookie, &read.cookie) {
            return;
        }
        match crate::routes::reuse_browser_login(state, platform, source.browser, source.profile).await {
            Ok(account) if account.state == AccountState::Valid => {
                tracing::info!("YouTube 的登录在浏览器里轮换过，已换上新的一份");
            }
            Ok(_) => {}
            Err(error) => tracing::warn!("换上浏览器里轮换过的 YouTube 登录失败：{error:#}"),
        }
    }

    /// 失效的登录是从浏览器复用来的、那个浏览器又能安静地读，就再读一次。拿到有效登录才返回。
    pub async fn resync_from_browser(state: &Arc<AppState>, platform: Platform) -> Option<Account> {
        let source = state.login_sources.get(platform)?;
        let browser = source.browser.clone();
        let quiet = tokio::task::spawn_blocking(move || {
            kdj_providers::browser::reads_without_prompt(&browser)
        })
        .await
        .unwrap_or(false);
        if !quiet {
            return None;
        }
        match crate::routes::reuse_browser_login(state, platform, source.browser, source.profile)
            .await
        {
            Ok(account) if account.state == AccountState::Valid => {
                tracing::info!(platform = platform.as_str(), "已从原来的浏览器重新读到登录");
                Some(account)
            }
            Ok(_) => None,
            Err(error) => {
                tracing::warn!(platform = platform.as_str(), "从原来的浏览器重新读取登录失败：{error:#}");
                None
            }
        }
    }
}

/// The cookies that name a youtube.com login and the turn of its rotation it is on.
const YOUTUBE_LOGIN_COOKIES: &[&str] = &[
    "SID", "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDTS", "__Secure-3PSIDTS",
    "SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID", "LOGIN_INFO",
];

/// The browser holds a login whose cookies differ from the ones KDJ sends: it has rotated (or is
/// another login). A browser that holds none of them has nothing to offer.
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
fn youtube_login_moved(held: &str, browser: &str) -> bool {
    let login = |cookie: &str| -> BTreeMap<String, String> {
        cookie
            .split(';')
            .filter_map(|pair| pair.trim().split_once('='))
            .filter(|(name, _)| YOUTUBE_LOGIN_COOKIES.contains(name))
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect()
    };
    let browser = login(browser);
    !browser.is_empty() && login(held) != browser
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_rotated_browser_login_replaces_the_one_kdj_holds() {
        let held = "SID=a; __Secure-1PSIDTS=t1; SAPISID=s; PREF=x; __Secure-3PSIDCC=c1";
        assert!(!youtube_login_moved(held, "SID=a; __Secure-1PSIDTS=t1; SAPISID=s; PREF=y; __Secure-3PSIDCC=c2"));
        assert!(youtube_login_moved(held, "SID=a; __Secure-1PSIDTS=t2; SAPISID=s"));
        assert!(youtube_login_moved(held, "SID=b; __Secure-1PSIDTS=t1; SAPISID=s"));
        assert!(!youtube_login_moved(held, "PREF=x; YSC=y"));
    }

    #[test]
    fn sources_persist_and_are_dropped_by_other_logins() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("login-sources.json");
        let zen = ReuseSource { browser: "zen".into(), profile: Some("default".into()) };

        let sources = LoginSources::load(path.clone());
        sources.set(Platform::Ytm, Some(zen.clone()));
        sources.set(Platform::Bilibili, Some(zen.clone()));
        let reopened = LoginSources::load(path.clone());
        assert_eq!(reopened.get(Platform::Ytm), Some(zen.clone()));

        reopened.set(Platform::Ytm, None);
        let reopened = LoginSources::load(path);
        assert_eq!(reopened.get(Platform::Ytm), None);
        assert_eq!(reopened.get(Platform::Bilibili), Some(zen));
    }
}
