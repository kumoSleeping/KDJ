//! B 站的登录态与 API 调用。
//!
//! 登录态就是几个 cookie（sessdata / bili_jct / buvid3 / dedeuserid ...），
//! 文件格式和 v0.1.x 的 `bilibili.json` 完全一致，老用户升级上来不用重新扫码。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::Value;

use super::url::USER_AGENT;
use super::wbi::{now_secs, sign_params, WbiKeyCache};

/// 会被持久化的 cookie 名单。多存无益，少存会掉登录态。
const COOKIE_KEYS: [&str; 7] = [
    "sessdata",
    "bili_jct",
    "buvid3",
    "buvid4",
    "b_nut",
    "dedeuserid",
    "ac_time_value",
];

/// B 站账号 API 串行且限速。媒体 CDN 不走这里，不会拖慢实际视频传输。
const API_MIN_INTERVAL: Duration = Duration::from_millis(250);
pub struct BiliClient {
    http: reqwest::Client,
    session_path: PathBuf,
    cookies: RwLock<BTreeMap<String, String>>,
    wbi: WbiKeyCache,
    api_gate: tokio::sync::Mutex<Instant>,
    device_cookie_init: tokio::sync::Mutex<()>,
}

impl BiliClient {
    pub fn new(session_dir: &Path) -> Result<Self> {
        crate::session_fs::ensure_private_dir(session_dir)?;
        let http = crate::net::http_timeouts(reqwest::Client::builder().user_agent(USER_AGENT))
            .build()
            .context("构建 B 站 HTTP 客户端失败")?;
        let session_path = session_dir.join("bilibili.json");
        crate::session_fs::protect_existing_private_file(&session_path)?;
        let client = BiliClient {
            http,
            session_path,
            cookies: RwLock::new(BTreeMap::new()),
            wbi: WbiKeyCache::new(),
            api_gate: tokio::sync::Mutex::new(
                Instant::now()
                    .checked_sub(API_MIN_INTERVAL)
                    .unwrap_or_else(Instant::now),
            ),
            device_cookie_init: tokio::sync::Mutex::new(()),
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

    pub fn credential_user_id(&self) -> String {
        self.cookies
            .read()
            .unwrap()
            .get("dedeuserid")
            .cloned()
            .unwrap_or_default()
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

    fn csrf_token(&self) -> String {
        self.cookies
            .read()
            .unwrap()
            .get("bili_jct")
            .cloned()
            .unwrap_or_default()
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

    pub fn store_cookies(&self, incoming: &BTreeMap<String, String>) -> Result<()> {
        let mut current = self.cookies.write().unwrap();
        let mut cookies = current.clone();
        for (name, value) in incoming {
            let name = name.to_ascii_lowercase();
            if COOKIE_KEYS.contains(&name.as_str()) && !value.is_empty() {
                cookies.insert(name, value.clone());
            }
        }
        self.save_session(&cookies)?;
        *current = cookies;
        // 登录态变了，nav 回的 wbi key 也可能变
        self.wbi.invalidate();
        Ok(())
    }

    fn save_session(&self, cookies: &BTreeMap<String, String>) -> Result<()> {
        let body = serde_json::to_vec_pretty(cookies).context("序列化 B 站登录态失败")?;
        crate::session_fs::write_private_atomic(&self.session_path, &body)
            .context("写入 B 站登录态失败")
    }

    pub fn clear_session(&self) -> Result<()> {
        let mut current = self.cookies.write().unwrap();
        crate::session_fs::remove_private_file(&self.session_path)?;
        current.clear();
        self.wbi.invalidate();
        Ok(())
    }

    async fn api_slot(&self) -> Result<tokio::sync::MutexGuard<'_, Instant>> {
        let mut gate = self.api_gate.lock().await;
        let elapsed = gate.elapsed();
        if elapsed < API_MIN_INTERVAL {
            tokio::time::sleep(API_MIN_INTERVAL - elapsed).await;
        }
        *gate = Instant::now();
        Ok(gate)
    }

    /// 搜索等 Web 接口会校验浏览器设备 Cookie。只在本地没有 `buvid3` 时访问一次
    /// B 站首页，让服务端通过正常的 Set-Cookie 链路下发 `buvid3` / `b_nut`；不在
    /// 客户端伪造指纹，也不会为每次请求重新生成设备标识。
    async fn ensure_device_cookie(&self) -> Result<()> {
        if self.has_cookie("buvid3") {
            return Ok(());
        }
        let _init = self.device_cookie_init.lock().await;
        if self.has_cookie("buvid3") {
            return Ok(());
        }

        let _slot = self.api_slot().await?;
        let mut request = self
            .http
            .head("https://www.bilibili.com/")
            .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml");
        let cookie = self.cookie_header();
        if !cookie.is_empty() {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        let response = request.send().await.context("初始化 B 站浏览器会话失败")?;
        anyhow::ensure!(
            response.status().is_success(),
            "初始化 B 站浏览器会话失败：HTTP {}",
            response.status().as_u16()
        );
        let incoming = collect_response_cookies(&response);
        anyhow::ensure!(
            incoming
                .keys()
                .any(|name| name.eq_ignore_ascii_case("buvid3")),
            "B 站没有返回浏览器设备 Cookie，请稍后重试"
        );
        self.store_cookies(&incoming)
    }

    fn has_cookie(&self, name: &str) -> bool {
        self.cookies
            .read()
            .unwrap()
            .get(name)
            .is_some_and(|value| !value.is_empty())
    }

    // ------------------------------------------------------------ API

    async fn get_json(&self, url: &str) -> Result<Value> {
        // guard 保留到响应解析结束，避免收藏夹分页和列表操作并发冲击账号接口。
        let _slot = self.api_slot().await?;
        let label = request_label(url);
        let mut request = self
            .http
            .get(url)
            .header(reqwest::header::REFERER, "https://www.bilibili.com/")
            .header(reqwest::header::ORIGIN, "https://www.bilibili.com")
            .header(reqwest::header::ACCEPT, "application/json, text/plain, */*");
        let cookie = self.cookie_header();
        if !cookie.is_empty() {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("B 站请求失败：{label}"))?;
        let status = response.status();
        let voucher_header = has_voucher_header(response.headers());
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let bytes = response
            .bytes()
            .await
            .with_context(|| format!("读取 B 站响应失败：{label}"))?;
        let parsed = serde_json::from_slice::<Value>(&bytes);
        let body_ref = parsed.as_ref().ok();
        let code = response_code(body_ref);
        if is_risk_response(status, body_ref, voucher_header) {
            let code = code.map_or_else(|| "未知".to_string(), |value| value.to_string());
            anyhow::bail!(
                "B 站触发风控（HTTP {} / code={}）；当前操作已停止且不会自动重试",
                status.as_u16(),
                code
            );
        }

        let body = match parsed {
            Ok(body) => body,
            Err(_) => {
                let preview = String::from_utf8_lossy(&bytes)
                    .chars()
                    .filter(|ch| !ch.is_control())
                    .take(120)
                    .collect::<String>();
                anyhow::bail!(
                    "B 站响应不是合法 JSON：HTTP {status} content-type={content_type} {preview}"
                );
            }
        };
        let code = body.get("code").and_then(Value::as_i64).unwrap_or(0);
        if code == 0 && status.is_success() {
            return Ok(body.get("data").cloned().unwrap_or(Value::Null));
        }
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        anyhow::bail!("B 站接口 {label} 返回 HTTP {status} code={code}：{message}")
    }

    /// 已登录写接口。写操作不做自动重试：如果连接在服务端提交后断开，重复发送会
    /// 模糊真实结果；调用方应刷新收藏夹确认后再决定是否重试。
    async fn post_form_json(&self, url: &str, form: &[(&str, String)]) -> Result<Value> {
        anyhow::ensure!(self.has_credential(), "请先登录哔哩哔哩");
        let _slot = self.api_slot().await?;
        let label = request_label(url);
        let response = self
            .http
            .post(url)
            .header(reqwest::header::REFERER, "https://www.bilibili.com/")
            .header(reqwest::header::ORIGIN, "https://www.bilibili.com")
            .header(reqwest::header::COOKIE, self.cookie_header())
            .form(form)
            .send()
            .await
            .with_context(|| format!("B 站写接口请求失败：{label}"))?;
        let status = response.status();
        let voucher_header = has_voucher_header(response.headers());
        let bytes = response
            .bytes()
            .await
            .with_context(|| format!("读取 B 站写接口响应失败：{label}"))?;
        let parsed = serde_json::from_slice::<Value>(&bytes);
        let body_ref = parsed.as_ref().ok();
        let code = response_code(body_ref);
        if is_risk_response(status, body_ref, voucher_header) {
            anyhow::bail!(
                "B 站触发风控（HTTP {} / code={}）；写操作未自动重试",
                status.as_u16(),
                code.map_or_else(|| "未知".to_string(), |value| value.to_string())
            );
        }
        let body = parsed.with_context(|| format!("B 站写接口响应不是合法 JSON：{label}"))?;
        let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        anyhow::ensure!(
            status.is_success() && code == 0,
            "B 站接口返回 HTTP {status} code={code}：{message}"
        );
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    }

    /// 当前是否登录（顺带拿昵称/头像）。
    pub async fn nav(&self) -> Result<Value> {
        self.get_json("https://api.bilibili.com/x/web-interface/nav")
            .await
    }

    async fn wbi_key(&self) -> Result<String> {
        self.wbi.get(|| async { self.nav().await }).await
    }

    /// 视频详情（标题、分 P、cid、封面、UP 主）。
    pub async fn view(&self, bvid: &str) -> Result<Value> {
        self.get_json(&format!(
            "https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
        ))
        .await
    }

    /// 用旧版 AV 号查询视频详情。响应里会带规范的 BV 号，供后续播放与下载统一使用。
    pub async fn view_by_aid(&self, aid: u64) -> Result<Value> {
        self.get_json(&format!(
            "https://api.bilibili.com/x/web-interface/view?aid={aid}"
        ))
        .await
    }

    /// 取播放地址。`want_dash = false` 时要 durl 单文件（安卓上没有 ffmpeg 走这条）。
    pub async fn playurl(&self, bvid: &str, cid: i64, qn: i64, want_dash: bool) -> Result<Value> {
        self.ensure_device_cookie().await?;
        let mixin = self.wbi_key().await?;
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
                ("web_location", "1315873".to_string()),
            ],
            &mixin,
            now_secs(),
        );
        self.get_json(&format!(
            "https://api.bilibili.com/x/player/wbi/playurl?{query}"
        ))
        .await
    }

    /// 当前用户创建的全部收藏夹。`up_mid` 来自已登录账号的 nav 回包；返回项里的
    /// `id` 才是后续 `fav/resource/list` 所需的完整 media_id。
    pub async fn fav_created_folders(&self, up_mid: i64) -> Result<Vec<Value>> {
        self.ensure_device_cookie().await?;
        let url = query_url(
            "https://api.bilibili.com/x/v3/fav/folder/created/list-all",
            &[
                ("up_mid", up_mid.to_string()),
                ("type", "2".to_string()),
                ("web_location", "333.1387".to_string()),
            ],
        )?;
        let data = self.get_json(&url).await?;
        Ok(data
            .get("list")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// 收藏夹内容列表。这个接口是普通 Cookie GET，不是 WBI 接口；给它附加
    /// `w_rid/wts` 或 JSONP 参数会形成与 Web 端不一致的请求形状。
    /// 公开收藏夹匿名可读；私有的需要登录 Cookie，未登录时接口回 code=-403。
    /// 每页最多 20 条（B 站硬限制），翻页由调用方拼 medias。
    pub async fn fav_resource_list(&self, media_id: &str, page: i64) -> Result<Value> {
        self.ensure_device_cookie().await?;
        let url = query_url(
            "https://api.bilibili.com/x/v3/fav/resource/list",
            &[
                ("media_id", media_id.to_string()),
                ("pn", page.to_string()),
                ("ps", "20".to_string()),
                ("order", "mtime".to_string()),
                ("type", "0".to_string()),
                ("tid", "0".to_string()),
                ("platform", "web".to_string()),
                ("web_location", "333.1387".to_string()),
            ],
        )?;
        self.get_json(&url).await
    }

    /// 从当前账号创建的收藏夹移除一个资源。资源形如 `aid:type`，普通视频 type=2。
    pub async fn fav_delete_resource(
        &self,
        media_id: &str,
        resource_id: i64,
        resource_type: i64,
    ) -> Result<()> {
        let csrf = self.csrf_token();
        anyhow::ensure!(!csrf.is_empty(), "B 站登录态缺少 bili_jct，请重新登录");
        self.post_form_json(
            "https://api.bilibili.com/x/v3/fav/resource/batch-del",
            &[
                ("media_id", media_id.to_string()),
                ("resources", format!("{resource_id}:{resource_type}")),
                ("platform", "web".into()),
                ("csrf", csrf.clone()),
                ("csrf_token", csrf),
            ],
        )
        .await?;
        Ok(())
    }

    pub async fn search_videos(&self, keyword: &str) -> Result<Vec<Value>> {
        self.ensure_device_cookie().await?;
        let mixin = self.wbi_key().await?;
        let query = sign_params(
            &[
                ("search_type", "video".to_string()),
                ("keyword", keyword.to_string()),
                ("page", "1".to_string()),
                ("web_location", "1550101".to_string()),
            ],
            &mixin,
            now_secs(),
        );
        // 匿名也能搜索，但仍先建立稳定的 buvid3 设备 Cookie；UA 的格式要求见 url.rs。
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

fn response_code(body: Option<&Value>) -> Option<i64> {
    body.and_then(|body| body.get("code"))
        .and_then(Value::as_i64)
}

fn body_has_voucher(body: Option<&Value>) -> bool {
    body.and_then(|body| body.pointer("/data/v_voucher"))
        .and_then(Value::as_str)
        .is_some_and(|voucher| !voucher.is_empty())
}

fn has_voucher_header(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get("x-bili-gaia-vvoucher")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|voucher| !voucher.is_empty())
}

fn is_risk_response(
    status: reqwest::StatusCode,
    body: Option<&Value>,
    voucher_header: bool,
) -> bool {
    let code = response_code(body);
    matches!(
        status,
        reqwest::StatusCode::PRECONDITION_FAILED | reqwest::StatusCode::TOO_MANY_REQUESTS
    ) || matches!(code, Some(-352 | -412 | -509 | -799))
        || voucher_header
        || body_has_voucher(body)
}

fn query_url(base: &str, params: &[(&str, String)]) -> Result<String> {
    let mut url = reqwest::Url::parse(base).context("B 站接口地址无效")?;
    url.query_pairs_mut()
        .extend_pairs(params.iter().map(|(name, value)| (*name, value.as_str())));
    Ok(url.into())
}

pub(super) fn collect_response_cookies(response: &reqwest::Response) -> BTreeMap<String, String> {
    response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|text| text.split(';').next())
        .filter_map(|pair| pair.split_once('='))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .filter(|(name, value)| !name.is_empty() && !value.is_empty())
        .collect()
}

/// 错误信息只保留主机和路径。WBI URL 的 query 含时间戳与签名，把整条 URL 写进
/// 日志既没排障价值，也容易被后续代码误拿去重放。
fn request_label(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| {
            parsed
                .host_str()
                .map(|host| format!("{host}{}", parsed.path()))
        })
        .unwrap_or_else(|| "B 站 API".to_string())
}

/// 落盘用小写键（和 v0.1.x 的 `bilibili.json` 一致），发请求时还原成 B 站认的大小写。
fn wire_cookie_name(name: &str) -> &str {
    match name {
        "sessdata" => "SESSDATA",
        "bili_jct" => "bili_jct",
        "dedeuserid" => "DedeUserID",
        "buvid3" => "buvid3",
        "buvid4" => "buvid4",
        "b_nut" => "b_nut",
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
            client
                .store_cookies(&BTreeMap::from([
                    ("SESSDATA".to_string(), "zzz".to_string()),
                    ("ignored".to_string(), "no".to_string()),
                ]))
                .unwrap();
            assert!(client.has_credential());
        }
        let reopened = BiliClient::new(&dir).unwrap();
        assert!(reopened.has_credential());
        assert!(reopened.cookie_header().contains("SESSDATA=zzz"));
        reopened.clear_session().unwrap();
        assert!(!reopened.has_credential());
        assert!(!dir.join("bilibili.json").exists());
    }

    #[test]
    fn failed_cookie_commit_does_not_publish_login_state() {
        let dir = scratch("failed-commit");
        let client = BiliClient::new(&dir).unwrap();
        std::fs::create_dir(dir.join("bilibili.json")).unwrap();

        assert!(client
            .store_cookies(&BTreeMap::from([(
                "SESSDATA".to_string(),
                "not-saved".to_string(),
            )]))
            .is_err());
        assert!(!client.has_credential());
    }

    #[test]
    fn missing_session_file_is_not_an_error() {
        let dir = scratch("missing");
        let client = BiliClient::new(&dir).unwrap();
        assert!(!client.has_credential());
        assert_eq!(client.cookie_header(), "");
    }

    #[test]
    fn anti_abuse_responses_are_recognized() {
        let blocked = serde_json::json!({"code": -412});
        let wbi_failure = serde_json::json!({"code": -352});
        let too_frequent = serde_json::json!({"code": -799});
        let permission_denied = serde_json::json!({"code": -403});
        let soft_challenge = serde_json::json!({
            "code": 0,
            "data": {"v_voucher": "voucher_example"}
        });
        assert!(is_risk_response(
            reqwest::StatusCode::PRECONDITION_FAILED,
            Some(&blocked),
            false,
        ));
        assert!(is_risk_response(
            reqwest::StatusCode::OK,
            Some(&wbi_failure),
            false,
        ));
        assert!(is_risk_response(
            reqwest::StatusCode::OK,
            Some(&too_frequent),
            false,
        ));
        assert!(is_risk_response(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            None,
            false,
        ));
        assert!(is_risk_response(
            reqwest::StatusCode::OK,
            Some(&soft_challenge),
            false,
        ));
        assert!(is_risk_response(
            reqwest::StatusCode::OK,
            Some(&serde_json::json!({"code": 0})),
            true,
        ));
        assert!(!is_risk_response(
            reqwest::StatusCode::OK,
            Some(&permission_denied),
            false,
        ));
    }

    #[test]
    fn favorite_list_query_matches_the_plain_web_request_shape() {
        let url = query_url(
            "https://api.bilibili.com/x/v3/fav/resource/list",
            &[
                ("media_id", "12345".to_string()),
                ("pn", "2".to_string()),
                ("ps", "20".to_string()),
                ("order", "mtime".to_string()),
                ("type", "0".to_string()),
                ("tid", "0".to_string()),
                ("platform", "web".to_string()),
                ("web_location", "333.1387".to_string()),
            ],
        )
        .unwrap();
        let parsed = reqwest::Url::parse(&url).unwrap();
        let query: BTreeMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(
            query.get("web_location").map(String::as_str),
            Some("333.1387")
        );
        for forbidden in ["w_rid", "wts", "jsonp", "callback", "keyword"] {
            assert!(!query.contains_key(forbidden), "不应发送 {forbidden}");
        }
    }

    #[test]
    fn device_cookie_fields_survive_session_storage() {
        let dir = scratch("device-cookie");
        let client = BiliClient::new(&dir).unwrap();
        client
            .store_cookies(&BTreeMap::from([
                ("buvid3".to_string(), "device-id".to_string()),
                ("b_nut".to_string(), "123".to_string()),
            ]))
            .unwrap();
        let header = client.cookie_header();
        assert!(header.contains("buvid3=device-id"));
        assert!(header.contains("b_nut=123"));
    }

    #[test]
    fn signed_query_is_removed_from_request_labels() {
        assert_eq!(
            request_label(
                "https://api.bilibili.com/x/v3/fav/resource/list?pn=2&w_rid=secret&wts=1"
            ),
            "api.bilibili.com/x/v3/fav/resource/list"
        );
    }
}
