//! B 站的登录态与 API 调用。
//!
//! 登录态就是几个 cookie（sessdata / bili_jct / buvid3 / dedeuserid ...），
//! 文件格式和 v0.1.x 的 `bilibili.json` 完全一致，老用户升级上来不用重新扫码。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use anyhow::{Context, Result};
use serde_json::Value;

use super::url::USER_AGENT;
use super::wbi::{now_secs, sign_params, WbiKeyCache};

/// 会被持久化的 cookie 名单。多存无益，少存会掉登录态。
const COOKIE_KEYS: [&str; 6] = [
    "sessdata",
    "bili_jct",
    "buvid3",
    "buvid4",
    "dedeuserid",
    "ac_time_value",
];

pub struct BiliClient {
    http: reqwest::Client,
    session_path: PathBuf,
    cookies: RwLock<BTreeMap<String, String>>,
    wbi: WbiKeyCache,
}

impl BiliClient {
    pub fn new(session_dir: &Path) -> Result<Self> {
        let http = crate::net::http_timeouts(reqwest::Client::builder().user_agent(USER_AGENT))
            .build()
            .context("构建 B 站 HTTP 客户端失败")?;
        let client = BiliClient {
            http,
            session_path: session_dir.join("bilibili.json"),
            cookies: RwLock::new(BTreeMap::new()),
            wbi: WbiKeyCache::new(),
        };
        client.load_session();
        Ok(client)
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub fn has_credential(&self) -> bool {
        self.cookies
            .read()
            .unwrap()
            .get("sessdata")
            .is_some_and(|value| !value.is_empty())
    }

    pub fn cookie_header(&self) -> String {
        let cookies = self.cookies.read().unwrap();
        cookies
            .iter()
            .filter(|(_, value)| !value.is_empty())
            // B 站认的是大写的 SESSDATA / DedeUserID，落盘用小写、发出去时还原
            .map(|(name, value)| format!("{}={}", wire_cookie_name(name), value))
            .collect::<Vec<_>>()
            .join("; ")
    }

    fn load_session(&self) {
        let Ok(text) = std::fs::read_to_string(&self.session_path) else {
            return;
        };
        let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&text) else {
            return;
        };
        let mut cookies = self.cookies.write().unwrap();
        for (key, value) in map {
            let key = key.to_ascii_lowercase();
            if COOKIE_KEYS.contains(&key.as_str()) {
                if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
                    cookies.insert(key, text.to_string());
                }
            }
        }
    }

    pub fn store_cookies(&self, incoming: &BTreeMap<String, String>) {
        {
            let mut cookies = self.cookies.write().unwrap();
            for (name, value) in incoming {
                let name = name.to_ascii_lowercase();
                if COOKIE_KEYS.contains(&name.as_str()) && !value.is_empty() {
                    cookies.insert(name, value.clone());
                }
            }
        }
        self.save_session();
        // 登录态变了，nav 回的 wbi key 也可能变
        self.wbi.invalidate();
    }

    fn save_session(&self) {
        let cookies = self.cookies.read().unwrap().clone();
        if let Some(parent) = self.session_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let Ok(body) = serde_json::to_string_pretty(&cookies) else {
            return;
        };
        let tmp = self.session_path.with_extension("json.tmp");
        if let Err(err) =
            std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &self.session_path))
        {
            tracing::warn!("写入 B 站登录态失败：{err}");
            return;
        }
        // 登录态是敏感文件，别让同机其他用户读到
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(
                &self.session_path,
                std::fs::Permissions::from_mode(0o600),
            );
        }
    }

    pub fn clear_session(&self) {
        self.cookies.write().unwrap().clear();
        let _ = std::fs::remove_file(&self.session_path);
        self.wbi.invalidate();
    }

    // ------------------------------------------------------------ API

    async fn get_json(&self, url: &str) -> Result<Value> {
        let mut request = self.http.get(url).header(reqwest::header::REFERER, "https://www.bilibili.com/");
        let cookie = self.cookie_header();
        if !cookie.is_empty() {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        let body: Value = request
            .send()
            .await
            .with_context(|| format!("B 站请求失败：{url}"))?
            .json()
            .await
            .with_context(|| format!("B 站响应不是合法 JSON：{url}"))?;
        let code = body.get("code").and_then(Value::as_i64).unwrap_or(0);
        if code != 0 {
            let message = body
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("未知错误");
            anyhow::bail!("B 站接口返回 code={code}：{message}");
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    }

    /// 当前是否登录（顺带拿昵称/头像）。
    pub async fn nav(&self) -> Result<Value> {
        self.get_json("https://api.bilibili.com/x/web-interface/nav")
            .await
    }

    /// 视频详情（标题、分 P、cid、封面、UP 主）。
    pub async fn view(&self, bvid: &str) -> Result<Value> {
        self.get_json(&format!(
            "https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
        ))
        .await
    }

    /// 取播放地址。`want_dash = false` 时要 durl 单文件（安卓上没有 ffmpeg 走这条）。
    pub async fn playurl(&self, bvid: &str, cid: i64, qn: i64, want_dash: bool) -> Result<Value> {
        let mixin = self.wbi.get(&self.http, &self.cookie_header()).await?;
        // fnval=4048 = DASH + HDR + 4K + 杜比 + 8K + AV1；1 = mp4 单流
        let fnval = if want_dash { "4048" } else { "1" };
        let query = sign_params(
            &[
                ("bvid", bvid.to_string()),
                ("cid", cid.to_string()),
                ("qn", qn.to_string()),
                ("fnval", fnval.to_string()),
                ("fnver", "0".to_string()),
                ("fourk", "1".to_string()),
                ("otype", "json".to_string()),
                ("platform", "pc".to_string()),
            ],
            &mixin,
            now_secs(),
        );
        self.get_json(&format!(
            "https://api.bilibili.com/x/player/wbi/playurl?{query}"
        ))
        .await
    }

    pub async fn search_videos(&self, keyword: &str) -> Result<Vec<Value>> {
        let mixin = self.wbi.get(&self.http, &self.cookie_header()).await?;
        let query = sign_params(
            &[
                ("search_type", "video".to_string()),
                ("keyword", keyword.to_string()),
                ("page", "1".to_string()),
            ],
            &mixin,
            now_secs(),
        );
        // 匿名也能搜：实测二分过，cookie 不是搜索通过与否的因素，UA 才是（见 url.rs）
        let data = self
            .get_json(&format!(
                "https://api.bilibili.com/x/web-interface/wbi/search/type?{query}"
            ))
            .await?;
        Ok(data
            .get("result")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

}

/// 落盘用小写键（和 v0.1.x 的 `bilibili.json` 一致），发请求时还原成 B 站认的大小写。
fn wire_cookie_name(name: &str) -> &str {
    match name {
        "sessdata" => "SESSDATA",
        "bili_jct" => "bili_jct",
        "dedeuserid" => "DedeUserID",
        "buvid3" => "buvid3",
        "buvid4" => "buvid4",
        "ac_time_value" => "ac_time_value",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kdj-bili-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn loads_the_v01_session_file_unchanged() {
        let dir = scratch("legacy");
        std::fs::write(
            dir.join("bilibili.json"),
            r#"{"sessdata": "abc", "bili_jct": "jct", "dedeuserid": "42", "junk": "x"}"#,
        )
        .unwrap();
        let client = BiliClient::new(&dir).unwrap();
        assert!(client.has_credential());
        let header = client.cookie_header();
        assert!(header.contains("SESSDATA=abc"), "发出去要用大写：{header}");
        assert!(header.contains("DedeUserID=42"), "{header}");
        assert!(!header.contains("junk"), "白名单之外的键不该带出去");
    }

    #[test]
    fn stored_cookies_roundtrip_and_clear() {
        let dir = scratch("store");
        {
            let client = BiliClient::new(&dir).unwrap();
            client.store_cookies(&BTreeMap::from([
                ("SESSDATA".to_string(), "zzz".to_string()),
                ("ignored".to_string(), "no".to_string()),
            ]));
            assert!(client.has_credential());
        }
        let reopened = BiliClient::new(&dir).unwrap();
        assert!(reopened.has_credential());
        assert!(reopened.cookie_header().contains("SESSDATA=zzz"));
        reopened.clear_session();
        assert!(!reopened.has_credential());
        assert!(!dir.join("bilibili.json").exists());
    }

    #[test]
    fn missing_session_file_is_not_an_error() {
        let dir = scratch("missing");
        let client = BiliClient::new(&dir).unwrap();
        assert!(!client.has_credential());
        assert_eq!(client.cookie_header(), "");
    }
}
