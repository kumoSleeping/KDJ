//! 网易云的会话与请求层（替代 pyncm 的 `Session`）。
//!
//! Cookie 自己管而不是交给 reqwest 的 cookie jar：登录态要落盘、要能从旧的
//! `netease.pyncm` 文件迁移过来，jar 不提供遍历接口。

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use anyhow::{Context, Result};
use base64::Engine as _;
#[cfg(test)]
use serde_json::json;
use serde_json::{Map, Value};

use super::crypto::{eapi_encrypt, weapi_encrypt};

pub const HOST: &str = "https://music.163.com";
/// weapi 用的 UA。伪装成 pyncm 反而更稳（这个 UA 已经在生产里跑了很久）。
const UA_DEFAULT: &str = "Mozilla/5.0 (linux@github.com/mos9527/pyncm) Chrome/PyNCM.1.8.1";
const UA_EAPI: &str =
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) \
                       Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/2.10.2.200154";
const DEVICE_ID: &str = "pyncm!";
/// eapi 请求的 header 字段，同时也作为 Cookie 发出去。
fn eapi_config() -> BTreeMap<String, String> {
    [
        ("os", "iPhone OS"),
        ("appver", "10.0.0"),
        ("osver", "16.2"),
        ("channel", "distribution"),
        ("deviceId", DEVICE_ID),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionState {
    /// 登录相关 cookie：MUSIC_U / __csrf / NMTID ...
    #[serde(default)]
    pub cookies: BTreeMap<String, String>,
    #[serde(default)]
    pub csrf_token: String,
    /// 上次拿到的 profile，重启后不用发请求就能显示昵称
    #[serde(default)]
    pub profile: Option<Value>,
}

impl SessionState {
    pub fn logged_in(&self) -> bool {
        self.cookies
            .get("MUSIC_U")
            .is_some_and(|v| !v.trim().is_empty())
    }
}

pub struct NeteaseClient {
    http: reqwest::Client,
    session_path: PathBuf,
    state: RwLock<SessionState>,
}

impl NeteaseClient {
    pub fn new(session_dir: &Path) -> Result<Self> {
        crate::session_fs::ensure_private_dir(session_dir)?;
        let http = crate::net::http_timeouts(reqwest::Client::builder().user_agent(UA_DEFAULT))
            .build()
            .context("构建网易云 HTTP 客户端失败")?;
        let session_path = session_dir.join("netease.json");
        crate::session_fs::protect_existing_private_file(&session_path)?;
        let client = NeteaseClient {
            http,
            session_path,
            state: RwLock::new(SessionState::default()),
        };
        client.load_session(session_dir);
        Ok(client)
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub fn logged_in(&self) -> bool {
        self.state.read().unwrap().logged_in()
    }

    pub fn profile(&self) -> Option<Value> {
        self.state.read().unwrap().profile.clone()
    }

    pub fn set_profile(&self, profile: Option<Value>) -> Result<()> {
        let mut current = self.state.write().unwrap();
        let mut next = current.clone();
        next.profile = profile;
        self.persist_state(&next)?;
        *current = next;
        Ok(())
    }

    // ------------------------------------------------------------ 登录态落盘

    fn load_session(&self, session_dir: &Path) {
        if let Ok(text) = std::fs::read_to_string(&self.session_path) {
            if let Ok(state) = serde_json::from_str::<SessionState>(&text) {
                *self.state.write().unwrap() = state;
                return;
            }
        }
        // 迁移：v0.1.x 的 pyncm 会话文件。迁移成功就地写成新格式，
        // 让升级上来的用户不用重新扫码。
        let legacy = session_dir.join("netease.pyncm");
        if let Ok(dump) = std::fs::read_to_string(&legacy) {
            match parse_pyncm_dump(&dump) {
                Ok(state) => {
                    tracing::info!("已从 netease.pyncm 迁移网易云登录态");
                    if let Err(err) = self.persist_state(&state) {
                        tracing::warn!("保存迁移后的网易云登录态失败：{err:#}");
                    }
                    *self.state.write().unwrap() = state;
                }
                Err(err) => tracing::warn!("迁移 netease.pyncm 失败：{err}"),
            }
        }
    }

    fn persist_state(&self, state: &SessionState) -> Result<()> {
        let body = serde_json::to_string_pretty(state).context("序列化网易云登录态失败")?;
        crate::session_fs::write_private_atomic(&self.session_path, body.as_bytes())
            .context("写入网易云登录态失败")
    }

    pub fn save_session(&self) -> Result<()> {
        let current = self.state.read().unwrap();
        self.persist_state(&current)
    }

    pub fn clear_session(&self) -> Result<()> {
        let mut current = self.state.write().unwrap();
        crate::session_fs::remove_private_file(&self.session_path)?;
        *current = SessionState::default();
        Ok(())
    }

    // ------------------------------------------------------------ Cookie

    fn cookie_header(&self) -> String {
        let state = self.state.read().unwrap();
        let mut parts: Vec<String> = eapi_config()
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        for (name, value) in &state.cookies {
            parts.push(format!("{name}={value}"));
        }
        parts.join("; ")
    }

    /// 从响应里收 Set-Cookie。登录成功的 MUSIC_U 就是这么进来的。
    fn absorb_cookies(&self, response: &reqwest::Response) -> Result<()> {
        let mut current = self.state.write().unwrap();
        let mut state = current.clone();
        let mut changed = false;
        for value in response.headers().get_all(reqwest::header::SET_COOKIE) {
            let Ok(text) = value.to_str() else { continue };
            let Some(pair) = text.split(';').next() else {
                continue;
            };
            let Some((name, value)) = pair.split_once('=') else {
                continue;
            };
            let (name, value) = (name.trim(), value.trim());
            if name.is_empty() {
                continue;
            }
            if value.is_empty() || value.eq_ignore_ascii_case("EXPIRED") {
                changed |= state.cookies.remove(name).is_some();
                if name == "__csrf" && !state.csrf_token.is_empty() {
                    state.csrf_token.clear();
                    changed = true;
                }
                continue;
            }
            if state
                .cookies
                .get(name)
                .is_none_or(|current| current != value)
            {
                state.cookies.insert(name.to_string(), value.to_string());
                changed = true;
            }
            if name == "__csrf" {
                if state.csrf_token != value {
                    state.csrf_token = value.to_string();
                    changed = true;
                }
            }
        }
        if changed {
            self.persist_state(&state)?;
            *current = state;
        }
        Ok(())
    }

    // ------------------------------------------------------------ 请求

    /// 登录态明文 API GET。只用于网易云仍由网页直接调用、无需 weapi 加密的接口。
    pub async fn api_get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        let response = self
            .http
            .get(format!("{HOST}{path}"))
            .query(query)
            .header(reqwest::header::USER_AGENT, UA_DEFAULT)
            .header(reqwest::header::REFERER, HOST)
            .header(reqwest::header::COOKIE, self.cookie_header())
            .send()
            .await
            .with_context(|| format!("网易云请求失败：{path}"))?;
        self.absorb_cookies(&response)?;
        let text = response.text().await.context("读取网易云响应失败")?;
        parse_json_body(&text)
    }

    /// weapi 请求。`path` 形如 `/weapi/v3/song/detail`。
    pub async fn weapi(&self, path: &str, mut payload: Map<String, Value>) -> Result<Value> {
        let csrf = self.state.read().unwrap().csrf_token.clone();
        payload.insert("csrf_token".into(), Value::String(csrf.clone()));
        let plain = serde_json::to_string(&Value::Object(payload))?;
        let encrypted = weapi_encrypt(&plain, None);

        let response = self
            .http
            .post(format!("{HOST}{path}"))
            .query(&[("csrf_token", csrf.as_str())])
            .header(reqwest::header::USER_AGENT, UA_DEFAULT)
            .header(reqwest::header::REFERER, HOST)
            .header(reqwest::header::COOKIE, self.cookie_header())
            .form(&[
                ("params", encrypted.params.as_str()),
                ("encSecKey", encrypted.enc_sec_key.as_str()),
            ])
            .send()
            .await
            .with_context(|| format!("网易云请求失败：{path}"))?;
        self.absorb_cookies(&response)?;
        let text = response.text().await.context("读取网易云响应失败")?;
        parse_json_body(&text)
    }

    /// eapi 请求。`path` 形如 `/eapi/song/enhance/player/url/v1`。
    ///
    /// 摘要用的是把 `/eapi/` 换成 `/api/` 之后的路径——这是服务端的约定，不是笔误。
    pub async fn eapi(&self, path: &str, mut payload: Map<String, Value>) -> Result<Value> {
        let mut header = Map::new();
        for (key, value) in eapi_config() {
            header.insert(key, Value::String(value));
        }
        // requestId 是个随机数，服务端只看格式
        let request_id = 20_000_000 + (rand::random::<u32>() % 10_000_000);
        header.insert("requestId".into(), Value::String(request_id.to_string()));
        payload.insert(
            "header".into(),
            Value::String(serde_json::to_string(&Value::Object(header))?),
        );

        let digest_path = path.replace("/eapi/", "/api/");
        let plain = serde_json::to_string(&Value::Object(payload))?;
        let params = eapi_encrypt(&digest_path, &plain);

        let response = self
            .http
            .post(format!("{HOST}{path}"))
            .header(reqwest::header::USER_AGENT, UA_EAPI)
            .header(reqwest::header::COOKIE, self.cookie_header())
            .form(&[("params", params.as_str())])
            .send()
            .await
            .with_context(|| format!("网易云请求失败：{path}"))?;
        self.absorb_cookies(&response)?;
        let body = response.bytes().await.context("读取网易云响应失败")?;

        // eapi 响应通常是 AES-ECB 密文，但有些端点直接回明文 JSON，两种都要认。
        match super::crypto::eapi_decrypt(&body) {
            Some(plain) => parse_json_body(&plain),
            None => parse_json_body(&String::from_utf8_lossy(&body)),
        }
    }
}

/// 响应偶尔带 `\x10` 之类的尾巴，pyncm 是 `payload.strip("\x10")` 之后再解析。
fn parse_json_body(text: &str) -> Result<Value> {
    let trimmed = text.trim_matches(|c: char| c == '\u{10}' || c.is_whitespace());
    serde_json::from_str(trimmed)
        .with_context(|| format!("网易云响应不是合法 JSON：{}", snippet(trimmed)))
}

fn snippet(text: &str) -> String {
    text.chars().take(160).collect()
}

/// 解析 v0.1.x 的 `netease.pyncm`：`"PYNCM" + base64(zlib(json))`。
fn parse_pyncm_dump(dump: &str) -> Result<SessionState> {
    let body = dump
        .trim()
        .strip_prefix("PYNCM")
        .context("不是 PYNCM 格式的会话文件")?;
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(body)
        .context("PYNCM 会话 base64 解码失败")?;
    let mut decoder = flate2::read::ZlibDecoder::new(&compressed[..]);
    let mut json_text = String::new();
    decoder
        .read_to_string(&mut json_text)
        .context("PYNCM 会话解压失败")?;
    let parsed: Value = serde_json::from_str(&json_text).context("PYNCM 会话不是合法 JSON")?;

    let mut cookies = BTreeMap::new();
    if let Some(list) = parsed.get("cookies").and_then(Value::as_array) {
        for item in list {
            let (Some(name), Some(value)) = (
                item.get("name").and_then(Value::as_str),
                item.get("value").and_then(Value::as_str),
            ) else {
                continue;
            };
            if !value.is_empty() {
                cookies.insert(name.to_string(), value.to_string());
            }
        }
    }
    let csrf_token = parsed
        .get("csrf_token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let profile = parsed
        .get("login_info")
        .and_then(|info| info.get("content"))
        .cloned();

    anyhow::ensure!(
        cookies.contains_key("MUSIC_U"),
        "PYNCM 会话里没有 MUSIC_U，视为未登录"
    );
    Ok(SessionState {
        cookies,
        csrf_token,
        profile,
    })
}

/// 请求体构造糖：`payload!{"ids" => json!([1]), "level" => "lossless".into()}`
pub fn payload(pairs: impl IntoIterator<Item = (&'static str, Value)>) -> Map<String, Value> {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect()
}

/// 网易云的成功码。非 200 一律当失败。
pub fn expect_ok(value: &Value, what: &str) -> Result<()> {
    let code = value.get("code").and_then(Value::as_i64).unwrap_or(200);
    anyhow::ensure!(code == 200, "{what}失败：code={code}");
    Ok(())
}

pub fn dummy_login_url(unikey: &str) -> String {
    format!("https://music.163.com/login?codekey={unikey}")
}

/// 给测试用：伪造一份 pyncm 会话文件内容。
#[cfg(test)]
pub fn make_pyncm_dump(cookies: &[(&str, &str)], csrf: &str) -> String {
    use flate2::write::ZlibEncoder;
    use std::io::Write as _;

    let value = json!({
        "cookies": cookies.iter().map(|(name, value)| json!({
            "name": name, "value": value, "domain": ".music.163.com", "path": "/"
        })).collect::<Vec<_>>(),
        "csrf_token": csrf,
        "login_info": {"success": true, "content": {"profile": {"nickname": "DJ"}}},
        "eapi_config": {},
    });
    let mut encoder = ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(value.to_string().as_bytes()).unwrap();
    let compressed = encoder.finish().unwrap();
    format!(
        "PYNCM{}",
        base64::engine::general_purpose::STANDARD.encode(compressed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kdj-ncm-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn migrates_the_old_pyncm_session_so_users_need_not_rescan() {
        let dir = scratch("migrate");
        std::fs::write(
            dir.join("netease.pyncm"),
            make_pyncm_dump(&[("MUSIC_U", "abc123"), ("__csrf", "tok")], "tok"),
        )
        .unwrap();

        let client = NeteaseClient::new(&dir).unwrap();
        assert!(client.logged_in(), "迁移后应当还是登录态");
        assert!(
            dir.join("netease.json").exists(),
            "迁移完要就地写成新格式，下次启动不用再解一遍"
        );
        assert_eq!(client.state.read().unwrap().csrf_token, "tok");
    }

    #[test]
    fn pyncm_session_without_music_u_is_not_treated_as_logged_in() {
        let dir = scratch("nomusicu");
        std::fs::write(
            dir.join("netease.pyncm"),
            make_pyncm_dump(&[("NMTID", "x")], ""),
        )
        .unwrap();
        let client = NeteaseClient::new(&dir).unwrap();
        assert!(!client.logged_in());
    }

    #[test]
    fn new_format_roundtrips_and_clears() {
        let dir = scratch("roundtrip");
        {
            let client = NeteaseClient::new(&dir).unwrap();
            client
                .state
                .write()
                .unwrap()
                .cookies
                .insert("MUSIC_U".into(), "zzz".into());
            client.save_session().unwrap();
        }
        let reopened = NeteaseClient::new(&dir).unwrap();
        assert!(reopened.logged_in());
        reopened.clear_session().unwrap();
        assert!(!reopened.logged_in());
        assert!(!dir.join("netease.json").exists());
    }

    #[test]
    fn failed_session_commit_does_not_publish_new_profile() {
        let dir = scratch("failed-commit");
        let client = NeteaseClient::new(&dir).unwrap();
        std::fs::create_dir(dir.join("netease.json")).unwrap();

        assert!(client
            .set_profile(Some(serde_json::json!({ "nickname": "not-saved" })))
            .is_err());
        assert!(client.profile().is_none(), "磁盘失败时内存不能伪装成已保存");
    }

    #[test]
    fn cookie_header_carries_both_device_config_and_login_cookies() {
        let dir = scratch("cookies");
        let client = NeteaseClient::new(&dir).unwrap();
        client
            .state
            .write()
            .unwrap()
            .cookies
            .insert("MUSIC_U".into(), "zzz".into());
        let header = client.cookie_header();
        assert!(header.contains("os=iPhone OS"));
        assert!(header.contains("deviceId=pyncm!"));
        assert!(header.contains("MUSIC_U=zzz"));
    }

    #[test]
    fn strips_the_trailing_control_byte_before_parsing() {
        let value = parse_json_body("{\"code\":200}\u{10}").unwrap();
        assert_eq!(value["code"], 200);
    }
}
