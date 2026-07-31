//! QQ 音乐扫码登录：两路并行。
//!
//! 1. **QQ 互联**（`ptqrshow`）：用 **QQ App** 扫，五步 OAuth 换 musickey。
//! 2. **QQ 音乐客户端**（`CreateQRCode` + MQTT）：用 **QQ 音乐 App** 扫。
//!
//! `create_dual_qr` 同时拉两张码；`poll_dual_qr` 任一路成功即登录完成。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use rand::Rng as _;
use serde_json::{json, Value};
use tokio::task::JoinHandle;

use super::client::{hash33, now_secs, Credential};
use super::mqtt_ws::MqttWsClient;

const APP_ID: &str = "716027609";
const DAID: &str = "383";
const THIRD_AID: &str = "100497308";
const REDIRECT_URI: &str =
    "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/";

#[derive(Debug, Clone)]
pub struct QqQrSession {
    pub png: Vec<u8>,
    pub qrsig: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QrOutcome {
    Waiting,
    Scanned,
    Refused,
    Expired,
    Done { uin: String, sigx: String },
}

/// 双通道会话：QQ App 一路 + QQ 音乐 App 一路。
/// 任一路创建失败时对应字段为 `None`，只要至少一路成功就能登录。
#[derive(Clone)]
pub struct DualQrSession {
    pub qq: Option<QqQrSession>,
    pub mobile: Option<MobileQrSession>,
}

#[derive(Clone)]
pub struct MobileQrSession {
    pub png: Vec<u8>,
    pub qrcode_id: String,
    state: Arc<Mutex<MobileWatchState>>,
    watch: Arc<Mutex<Option<JoinHandle<()>>>>,
}

#[derive(Debug, Clone)]
enum MobileWatchState {
    Waiting,
    Scanned,
    Refused,
    Expired,
    Done(Credential),
    Error(String),
}

#[derive(Debug, Clone)]
pub enum DualQrOutcome {
    Waiting,
    Scanned,
    Refused,
    Expired,
    Done(Credential),
    Error(String),
}

impl MobileQrSession {
    pub fn abort(&self) {
        if let Some(handle) = self.watch.lock().unwrap().take() {
            handle.abort();
        }
    }
}

impl Drop for MobileQrSession {
    fn drop(&mut self) {
        if Arc::strong_count(&self.watch) == 1 {
            self.abort();
        }
    }
}

pub async fn create_qq_qr(http: &reqwest::Client) -> Result<QqQrSession> {
    let response = http
        .get("https://ssl.ptlogin2.qq.com/ptqrshow")
        .query(&[
            ("appid", APP_ID),
            ("e", "2"),
            ("l", "M"),
            ("s", "3"),
            ("d", "72"),
            ("v", "4"),
            ("t", &format!("0.{}", rand::random::<u32>())),
            ("daid", DAID),
            ("pt_3rd_aid", THIRD_AID),
        ])
        .header(reqwest::header::REFERER, "https://xui.ptlogin2.qq.com/")
        .send()
        .await
        .context("获取 QQ 二维码失败")?;

    let qrsig = cookie_from(&response, "qrsig").context("QQ 二维码响应里没有 qrsig")?;
    let png = response.bytes().await.context("读取二维码图片失败")?.to_vec();
    anyhow::ensure!(!png.is_empty(), "QQ 音乐二维码获取失败");
    Ok(QqQrSession { png, qrsig })
}

pub async fn check_qq_qr(http: &reqwest::Client, session: &QqQrSession) -> Result<QrOutcome> {
    let response = http
        .get("https://ssl.ptlogin2.qq.com/ptqrlogin")
        .query(&[
            ("u1", "https://graph.qq.com/oauth2.0/login_jump"),
            ("ptqrtoken", &hash33(&session.qrsig, 0).to_string()),
            ("ptredirect", "0"),
            ("h", "1"),
            ("t", "1"),
            ("g", "1"),
            ("from_ui", "1"),
            ("ptlang", "2052"),
            ("action", &format!("0-0-{}", now_secs() * 1000)),
            ("js_ver", "20102616"),
            ("js_type", "1"),
            ("pt_uistyle", "40"),
            ("aid", APP_ID),
            ("daid", DAID),
            ("pt_3rd_aid", THIRD_AID),
            ("has_onekey", "1"),
        ])
        .header(reqwest::header::REFERER, "https://xui.ptlogin2.qq.com/")
        .header(
            reqwest::header::COOKIE,
            format!("qrsig={}", session.qrsig),
        )
        .send()
        .await
        .context("轮询 QQ 二维码状态失败")?;
    let text = response.text().await.context("读取二维码状态失败")?;
    parse_ptui_callback(&text)
}

/// 解析 `ptuiCB('65','0','','0','二维码未失效。', '')` 这种 JS 回调。
pub fn parse_ptui_callback(text: &str) -> Result<QrOutcome> {
    let start = text.find("ptuiCB(").context("二维码状态响应无法解析")? + "ptuiCB(".len();
    let end = text[start..].find(')').context("二维码状态响应无法解析")? + start;
    let args = split_quoted(&text[start..end]);
    let code = args.first().context("二维码状态缺少状态码")?;

    // 0 成功 / 65 已过期 / 66 未扫 / 67 已扫待确认 / 68 拒绝
    match code.as_str() {
        "66" => Ok(QrOutcome::Waiting),
        "67" => Ok(QrOutcome::Scanned),
        "65" => Ok(QrOutcome::Expired),
        "68" => Ok(QrOutcome::Refused),
        "0" => {
            let jump = args.get(2).context("登录成功但缺少跳转地址")?;
            let sigx = between(jump, "ptsigx=", "&s_url").context("跳转地址里没有 ptsigx")?;
            let uin = between(jump, "uin=", "&service").context("跳转地址里没有 uin")?;
            Ok(QrOutcome::Done { uin, sigx })
        }
        // 其余未知码按"还在等"处理，不要把用户踢回重新扫码
        _ => Ok(QrOutcome::Waiting),
    }
}

/// 用 uin + ptsigx 换到 musickey。
pub async fn authorize(http: &reqwest::Client, uin: &str, sigx: &str) -> Result<Credential> {
    // check_sig 必须**不跟随重定向**：p_skey 只出现在这一跳的 Set-Cookie 里，
    // 跟到下一跳就丢了。
    let no_redirect = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("构建 QQ 登录客户端失败")?;

    let response = no_redirect
        .get("https://ssl.ptlogin2.graph.qq.com/check_sig")
        .query(&[
            ("uin", uin),
            ("pttype", "1"),
            ("service", "ptqrlogin"),
            ("nodirect", "0"),
            ("ptsigx", sigx),
            ("s_url", "https://graph.qq.com/oauth2.0/login_jump"),
            ("ptlang", "2052"),
            ("ptredirect", "100"),
            ("aid", APP_ID),
            ("daid", DAID),
            ("j_later", "0"),
            ("low_login_hour", "0"),
            ("regmaster", "0"),
            ("pt_login_type", "3"),
            ("pt_aid", "0"),
            ("pt_aaid", "16"),
            ("pt_light", "0"),
            ("pt_3rd_aid", THIRD_AID),
        ])
        .header(reqwest::header::REFERER, "https://xui.ptlogin2.qq.com/")
        .send()
        .await
        .context("check_sig 请求失败")?;

    let cookies = all_cookies(&response);
    let p_skey = cookies
        .iter()
        .find(|(name, _)| name == "p_skey")
        .map(|(_, value)| value.clone())
        .context("获取 p_skey 失败")?;
    let cookie_header = cookies
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ");

    let authorize_response = no_redirect
        .post("https://graph.qq.com/oauth2.0/authorize")
        .header(reqwest::header::COOKIE, cookie_header)
        .form(&[
            ("response_type", "code"),
            ("client_id", THIRD_AID),
            ("redirect_uri", REDIRECT_URI),
            ("scope", "get_user_info,get_app_friends"),
            ("state", "state"),
            ("switch", ""),
            ("from_ptlogin", "1"),
            ("src", "1"),
            ("update_auth", "1"),
            ("openapi", "1010_1030"),
            ("g_tk", &hash33(&p_skey, 5381).to_string()),
            ("auth_time", &(now_secs() * 1000).to_string()),
            ("ui", &format!("{:032x}", rand::random::<u128>())),
        ])
        .send()
        .await
        .context("QQ 授权请求失败")?;

    let location = authorize_response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let code = between(&location, "code=", "&").context("授权跳转里没有 code")?;

    // 最后一步走 musicu.fcg 换 musickey
    let payload = json!({
        "comm": {"ct": 19, "cv": 2201, "chid": "0", "tmeLoginType": 2},
        "req_0": {
            "module": "QQConnectLogin.LoginServer",
            "method": "QQLogin",
            "param": {"code": code}
        }
    });
    let response = http
        .post("https://u.y.qq.com/cgi-bin/musicu.fcg")
        .json(&payload)
        .send()
        .await
        .context("换取 QQ 音乐凭证失败")?;
    let value: Value = response.json().await.context("凭证响应不是合法 JSON")?;
    let item = value.get("req_0").context("凭证响应缺少 req_0")?;
    let code = item.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        bail!("QQ 音乐登录失败：code={code}");
    }
    let data = item.get("data").cloned().unwrap_or(Value::Null);
    let credential: Credential =
        serde_json::from_value(data).context("凭证字段不完整，无法解析")?;
    anyhow::ensure!(credential.is_present(), "QQ 音乐没有返回可用的 musickey");
    Ok(credential)
}

fn cookie_from(response: &reqwest::Response, name: &str) -> Option<String> {
    all_cookies(response)
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

fn all_cookies(response: &reqwest::Response) -> Vec<(String, String)> {
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

/// 抠出 `'...'` 单引号包起来的实参，支持 `\'` 转义。
fn split_quoted(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\'' {
            continue;
        }
        let mut arg = String::new();
        while let Some(ch) = chars.next() {
            match ch {
                '\\' => {
                    if let Some(escaped) = chars.next() {
                        arg.push(escaped);
                    }
                }
                '\'' => break,
                other => arg.push(other),
            }
        }
        out.push(arg);
    }
    out
}

fn between(text: &str, start: &str, end: &str) -> Option<String> {
    let from = text.find(start)? + start.len();
    let rest = &text[from..];
    let to = rest.find(end).unwrap_or(rest.len());
    let found = &rest[..to];
    if found.is_empty() {
        None
    } else {
        Some(found.to_string())
    }
}

// ---------------------------------------------------------------- QQ 音乐 App 扫码

const MUSICU: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const MQTT_HOST: &str = "mu.y.qq.com";
const MQTT_PATH: &str = "/ws/handshake";
const MQTT_KEEP_ALIVE: u16 = 45;
const MOBILE_WATCH_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// 同时创建 QQ 互联码 + QQ 音乐客户端码。
/// 两路并行；单路失败不拖垮另一路，两路都失败才返回 Err。
pub async fn create_dual_qr(http: &reqwest::Client) -> Result<DualQrSession> {
    let (qq_res, mobile_res) = tokio::join!(create_qq_qr(http), create_mobile_qr(http));
    let qq = qq_res
        .map_err(|err| tracing::warn!("QQ 互联二维码创建失败：{err:#}"))
        .ok();
    let mobile = mobile_res
        .map_err(|err| tracing::warn!("QQ 音乐客户端二维码创建失败：{err:#}"))
        .ok();
    if qq.is_none() && mobile.is_none() {
        bail!("QQ 音乐与 QQ 二维码均获取失败");
    }
    Ok(DualQrSession { qq, mobile })
}

fn abort_mobile(session: &DualQrSession) {
    if let Some(mobile) = &session.mobile {
        mobile.abort();
    }
}

/// 轮询双通道：优先 QQ 互联，其次 QQ 音乐 App。
/// 任一路成功即 Done；两边都过期/不可用才 Expired。
pub async fn poll_dual_qr(
    http: &reqwest::Client,
    session: &DualQrSession,
) -> Result<DualQrOutcome> {
    let mobile_state = session
        .mobile
        .as_ref()
        .map(poll_mobile_qr)
        .unwrap_or(DualQrOutcome::Expired);

    // App 侧已经拿到凭证 / 明确失败时，直接采纳（不阻塞在互联轮询上）。
    match &mobile_state {
        DualQrOutcome::Done(credential) => {
            return Ok(DualQrOutcome::Done(credential.clone()));
        }
        DualQrOutcome::Error(message) => return Ok(DualQrOutcome::Error(message.clone())),
        _ => {}
    }

    // 1) 优先 QQ 互联
    let mut qq_alive = false;
    if let Some(qq) = &session.qq {
        match check_qq_qr(http, qq).await {
            Ok(QrOutcome::Done { uin, sigx }) => match authorize(http, &uin, &sigx).await {
                Ok(credential) => {
                    abort_mobile(session);
                    return Ok(DualQrOutcome::Done(credential));
                }
                Err(err) => {
                    // 互联授权失败且 App 侧也帮不上 → 报错；否则继续等 App。
                    if !matches!(
                        mobile_state,
                        DualQrOutcome::Waiting | DualQrOutcome::Scanned
                    ) {
                        return Ok(DualQrOutcome::Error(truncate(
                            &format!("QQ 授权换凭证失败：{err:#}"),
                            160,
                        )));
                    }
                }
            },
            Ok(QrOutcome::Scanned) => return Ok(DualQrOutcome::Scanned),
            Ok(QrOutcome::Waiting) => qq_alive = true,
            Ok(QrOutcome::Refused) => {
                if !matches!(mobile_state, DualQrOutcome::Waiting | DualQrOutcome::Scanned) {
                    abort_mobile(session);
                    return Ok(DualQrOutcome::Refused);
                }
            }
            Ok(QrOutcome::Expired) => {}
            Err(err) => {
                if session.mobile.is_none() {
                    return Ok(DualQrOutcome::Error(truncate(
                        &format!("检查 QQ 二维码失败：{err:#}"),
                        160,
                    )));
                }
                tracing::debug!("QQ 互联轮询失败，回退 QQ 音乐 App：{err:#}");
            }
        }
    }

    // 2) 合并 QQ 音乐 App / 存活状态
    match mobile_state {
        DualQrOutcome::Scanned => Ok(DualQrOutcome::Scanned),
        DualQrOutcome::Refused if !qq_alive => Ok(DualQrOutcome::Refused),
        DualQrOutcome::Waiting | DualQrOutcome::Refused => Ok(DualQrOutcome::Waiting),
        DualQrOutcome::Expired if qq_alive => Ok(DualQrOutcome::Waiting),
        DualQrOutcome::Expired => Ok(DualQrOutcome::Expired),
        // Done / Error 已在前面 return
        DualQrOutcome::Done(credential) => Ok(DualQrOutcome::Done(credential)),
        DualQrOutcome::Error(message) => Ok(DualQrOutcome::Error(message)),
    }
}

pub async fn create_mobile_qr(http: &reqwest::Client) -> Result<MobileQrSession> {
    let (png, qrcode_id) = request_mobile_qrcode(http).await?;
    let state = Arc::new(Mutex::new(MobileWatchState::Waiting));
    let watch_slot = Arc::new(Mutex::new(None));

    let http = http.clone();
    let state_bg = Arc::clone(&state);
    let qrcode_id_bg = qrcode_id.clone();
    let handle = tokio::spawn(async move {
        match watch_mobile_qr(&http, &qrcode_id_bg, &state_bg).await {
            Ok(credential) => {
                *state_bg.lock().unwrap() = MobileWatchState::Done(credential);
            }
            Err(err) => {
                let mut guard = state_bg.lock().unwrap();
                if matches!(
                    *guard,
                    MobileWatchState::Refused
                        | MobileWatchState::Expired
                        | MobileWatchState::Done(_)
                ) {
                    return;
                }
                let message = format!("{err:#}");
                if message.contains("超时") || message.to_lowercase().contains("timeout") {
                    *guard = MobileWatchState::Expired;
                } else if message.contains("取消") {
                    *guard = MobileWatchState::Refused;
                } else {
                    *guard = MobileWatchState::Error(truncate(&message, 160));
                }
            }
        }
    });
    *watch_slot.lock().unwrap() = Some(handle);

    Ok(MobileQrSession {
        png,
        qrcode_id,
        state,
        watch: watch_slot,
    })
}

fn poll_mobile_qr(session: &MobileQrSession) -> DualQrOutcome {
    match session.state.lock().unwrap().clone() {
        MobileWatchState::Waiting => DualQrOutcome::Waiting,
        MobileWatchState::Scanned => DualQrOutcome::Scanned,
        MobileWatchState::Refused => DualQrOutcome::Refused,
        MobileWatchState::Expired => DualQrOutcome::Expired,
        MobileWatchState::Done(credential) => DualQrOutcome::Done(credential),
        MobileWatchState::Error(message) => DualQrOutcome::Error(message),
    }
}

async fn request_mobile_qrcode(http: &reqwest::Client) -> Result<(Vec<u8>, String)> {
    let payload = json!({
        "comm": {"ct": 23, "cv": 0, "chid": "0"},
        "req_0": {
            "module": "music.login.LoginServer",
            "method": "CreateQRCode",
            "param": {
                "tmeAppID": "qqmusic",
                "ct": 19,
                "cv": 2201
            }
        }
    });
    let response = http
        .post(MUSICU)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::REFERER, "https://y.qq.com/")
        .json(&payload)
        .send()
        .await
        .context("获取 QQ 音乐客户端二维码失败")?;
    anyhow::ensure!(
        response.status().is_success(),
        "获取 QQ 音乐客户端二维码失败：HTTP {}",
        response.status()
    );
    let value: Value = response.json().await.context("客户端二维码响应不是合法 JSON")?;
    let item = value.get("req_0").context("客户端二维码响应缺少 req_0")?;
    let code = item.get("code").and_then(Value::as_i64).unwrap_or(-1);
    anyhow::ensure!(code == 0, "获取 QQ 音乐客户端二维码失败：code={code}");
    let data = item.get("data").context("客户端二维码响应缺少 data")?;
    let qrcode = data
        .get("qrcode")
        .and_then(Value::as_str)
        .context("客户端二维码响应缺少 qrcode")?;
    let qrcode_id = data
        .get("qrcodeID")
        .and_then(Value::as_str)
        .context("客户端二维码响应缺少 qrcodeID")?
        .to_string();
    anyhow::ensure!(!qrcode_id.is_empty(), "客户端二维码 qrcodeID 为空");

    let b64 = qrcode.split(',').next_back().unwrap_or(qrcode);
    let png = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .context("客户端二维码 PNG base64 解码失败")?;
    anyhow::ensure!(!png.is_empty(), "QQ 音乐客户端二维码为空");
    Ok((png, qrcode_id))
}

async fn watch_mobile_qr(
    http: &reqwest::Client,
    qrcode_id: &str,
    state: &Mutex<MobileWatchState>,
) -> Result<Credential> {
    let started = Instant::now();
    let client_id = format!(
        "{}{}",
        now_secs() * 1000 + i64::from(rand::thread_rng().gen_range(0..1000)),
        rand::thread_rng().gen_range(1000..10000)
    );

    let mut mqtt = MqttWsClient::connect(
        MQTT_HOST,
        MQTT_PATH,
        &client_id,
        MQTT_KEEP_ALIVE,
        "pass",
        &[
            ("tmeAppID", "qqmusic"),
            ("business", "management"),
            ("hashTag", qrcode_id),
            ("clientTag", "management.user"),
            ("userID", qrcode_id),
        ],
        3,
    )
    .await?;

    let topic = format!("management.qrcode_login/{qrcode_id}");
    mqtt.subscribe(
        &topic,
        &[("authorization", "tmelogin"), ("pubsub", "unicast")],
    )
    .await?;

    loop {
        let remaining = MOBILE_WATCH_TIMEOUT.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            *state.lock().unwrap() = MobileWatchState::Expired;
            bail!("二维码登录超时");
        }
        let publish = tokio::time::timeout(remaining, mqtt.next_publish())
            .await
            .context("二维码登录超时")?
            .context("MQTT 连接已关闭")?
            .context("MQTT 连接已关闭")?;

        let event_type = publish
            .user_properties
            .iter()
            .find(|(key, _)| key == "type")
            .map(|(_, value)| value.as_str())
            .unwrap_or("");

        match event_type {
            "scanned" => {
                let mut guard = state.lock().unwrap();
                if matches!(*guard, MobileWatchState::Waiting) {
                    *guard = MobileWatchState::Scanned;
                }
            }
            "canceled" => {
                *state.lock().unwrap() = MobileWatchState::Refused;
                bail!("用户取消登录");
            }
            "timeout" => {
                *state.lock().unwrap() = MobileWatchState::Expired;
                bail!("二维码登录超时");
            }
            "loginFailed" => bail!("QQ 音乐扫码登录失败"),
            "cookies" => {
                let payload: Value = serde_json::from_slice(&publish.payload)
                    .context("cookies 事件不是合法 JSON")?;
                return authorize_mobile_cookies(http, qrcode_id, &payload).await;
            }
            _ => {}
        }
    }
}

async fn authorize_mobile_cookies(
    http: &reqwest::Client,
    qrcode_id: &str,
    payload: &Value,
) -> Result<Credential> {
    let cookies = payload
        .get("cookies")
        .and_then(Value::as_object)
        .context("cookies 事件缺少 cookies 字段")?;
    let uin = cookie_map_value(cookies, "qqmusic_uin").context("cookies 里没有 qqmusic_uin")?;
    let key = cookie_map_value(cookies, "qqmusic_key").context("cookies 里没有 qqmusic_key")?;
    let musicid: i64 = uin.parse().context("qqmusic_uin 不是数字")?;

    let request_payload = json!({
        "comm": {
            "ct": 19,
            "cv": 2201,
            "chid": "0",
            "tmeLoginType": 6
        },
        "req_0": {
            "module": "music.login.LoginServer",
            "method": "Login",
            "param": {
                "musicid": musicid,
                "qrCodeID": qrcode_id,
                "token": key
            }
        }
    });
    let response = http
        .post(MUSICU)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::REFERER, "https://y.qq.com/")
        .json(&request_payload)
        .send()
        .await
        .context("换取 QQ 音乐客户端凭证失败")?;
    let value: Value = response.json().await.context("客户端凭证响应不是合法 JSON")?;
    let item = value.get("req_0").context("客户端凭证响应缺少 req_0")?;
    let code = item.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        bail!("QQ 音乐客户端登录失败：code={code}");
    }
    let data = item.get("data").cloned().unwrap_or(Value::Null);
    let mut credential: Credential =
        serde_json::from_value(data).context("客户端凭证字段不完整")?;
    if credential.login_type == 0 {
        credential.login_type = 6;
    }
    anyhow::ensure!(credential.is_present(), "QQ 音乐客户端没有返回可用的 musickey");
    Ok(credential)
}

fn cookie_map_value(
    cookies: &serde_json::Map<String, Value>,
    name: &str,
) -> Option<String> {
    cookies
        .get(name)
        .and_then(|entry| entry.get("value").or(Some(entry)))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let clipped: String = text.chars().take(max_chars).collect();
        format!("{clipped}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waiting_states_are_recognized() {
        assert_eq!(
            parse_ptui_callback("ptuiCB('66','0','','0','二维码未失效。', '')").unwrap(),
            QrOutcome::Waiting
        );
        assert_eq!(
            parse_ptui_callback("ptuiCB('67','0','','0','二维码认证中。', '')").unwrap(),
            QrOutcome::Scanned
        );
        assert_eq!(
            parse_ptui_callback("ptuiCB('65','0','','0','二维码已失效。', '')").unwrap(),
            QrOutcome::Expired
        );
        assert_eq!(
            parse_ptui_callback("ptuiCB('68','0','','0','本次登录已被拒绝。', '')").unwrap(),
            QrOutcome::Refused
        );
    }

    #[test]
    fn success_yields_uin_and_sigx_from_the_jump_url() {
        let body = "ptuiCB('0','0','https://ptlogin2.graph.qq.com/check_sig?\
                    pttype=1&uin=123456789&service=ptqrlogin&nodirect=0&ptsigx=ABCDEF0123&s_url=\
                    https%3A%2F%2Fgraph.qq.com','0','登录成功！', '昵称')";
        assert_eq!(
            parse_ptui_callback(body).unwrap(),
            QrOutcome::Done {
                uin: "123456789".into(),
                sigx: "ABCDEF0123".into()
            }
        );
    }

    #[test]
    fn unknown_codes_keep_waiting_instead_of_kicking_the_user_out() {
        assert_eq!(
            parse_ptui_callback("ptuiCB('99','0','','0','未知', '')").unwrap(),
            QrOutcome::Waiting
        );
    }

    #[test]
    fn quoted_args_survive_escaped_quotes() {
        let args = split_quoted(r#"'a','b\'c','d'"#);
        assert_eq!(args, vec!["a", "b'c", "d"]);
    }

    #[test]
    fn between_returns_none_when_the_marker_is_missing() {
        assert_eq!(between("a=1&b=2", "b=", "&"), Some("2".into()));
        assert_eq!(between("a=1", "zzz=", "&"), None);
        assert_eq!(between("code=&x", "code=", "&"), None);
    }

    #[test]
    fn cookie_map_value_reads_nested_and_plain_entries() {
        let cookies = json!({
            "qqmusic_uin": {"value": "12345"},
            "qqmusic_key": "plain-token"
        })
        .as_object()
        .cloned()
        .unwrap();
        assert_eq!(cookie_map_value(&cookies, "qqmusic_uin").as_deref(), Some("12345"));
        assert_eq!(cookie_map_value(&cookies, "qqmusic_key").as_deref(), Some("plain-token"));
    }
}
