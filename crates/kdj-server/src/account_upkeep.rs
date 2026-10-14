//! 登录的长期维护（桌面版）。
//!
//! 各平台的续期都在自己的 `account()` 里：QQ 音乐和 B 站的扫码登录按平台的做法续期，YouTube、
//! B 站、网易云在每次请求里收下网站轮换的 Cookie。可这些都要有请求才会发生，所以这里在启动后
//! 不久、之后每隔 [`INTERVAL`] 把有登录的平台核验一遍，状态变了推 `account.changed`。
//!
//! 用「复用浏览器」登录的账号，登录其实还活在那个浏览器里：KDJ 这份失效了，就从同一个浏览器
//! 再读一次。只对读取时不弹任何东西的浏览器这么做（[`kdj_providers::browser::reads_without_prompt`]），
//! 后台不能冒出钥匙串授权框。来源记在 `sessions/login-sources.json`，只有浏览器 id 和配置 id。

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

    pub fn spawn(state: Arc<AppState>) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
