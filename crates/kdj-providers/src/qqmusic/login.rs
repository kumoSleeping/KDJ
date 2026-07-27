//! QQ 扫码登录。
//!
//! 这条链路比其他平台都长，五步缺一不可：
//! 1. `ptqrshow` 拿二维码 PNG + `qrsig` cookie；
//! 2. `ptqrlogin` 轮询，参数里的 `ptqrtoken = hash33(qrsig)`；
//! 3. 成功时从返回的 JS 回调里抠出 `uin` 和 `ptsigx`；
//! 4. `check_sig` 换 `p_skey`（**必须不跟随重定向**，p_skey 只在这一跳的 Set-Cookie 里）；
//! 5. `graph.qq.com/oauth2.0/authorize` 拿 code → `QQConnectLogin.LoginServer` 换 musickey。

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::client::{hash33, now_secs, Credential};

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
}
