//! B 站扫码登录（web 端 passport 接口）。
//!
//! 比 QQ 那条链路简单得多：生成二维码拿 `qrcode_key`，轮询同一个 key，
//! 成功时 cookie 在响应头的 Set-Cookie 里，刷新令牌在响应体的 refresh_token。

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use serde_json::Value;

use super::client::collect_response_cookies;

#[derive(Debug, Clone)]
pub struct BiliQrSession {
    pub url: String,
    pub qrcode_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QrPoll {
    Waiting,
    Scanned,
    Expired,
    Done(BTreeMap<String, String>),
}

pub async fn create_qr(http: &reqwest::Client) -> Result<BiliQrSession> {
    let body: Value = http
        .get("https://passport.bilibili.com/x/passport-login/web/qrcode/generate")
        .query(&[("source", "main-fe-header")])
        .send()
        .await
        .context("获取 B 站二维码失败")?
        .json()
        .await
        .context("B 站二维码响应不是合法 JSON")?;
    let data = body.get("data").context("二维码响应缺少 data")?;
    let url = data
        .get("url")
        .and_then(Value::as_str)
        .context("二维码响应缺少 url")?
        .to_string();
    let qrcode_key = data
        .get("qrcode_key")
        .and_then(Value::as_str)
        .context("二维码响应缺少 qrcode_key")?
        .to_string();
    Ok(BiliQrSession { url, qrcode_key })
}

pub async fn poll_qr(http: &reqwest::Client, qrcode_key: &str) -> Result<QrPoll> {
    let response = http
        .get("https://passport.bilibili.com/x/passport-login/web/qrcode/poll")
        .query(&[("qrcode_key", qrcode_key)])
        .send()
        .await
        .context("轮询 B 站二维码失败")?;

    // cookie 要在读 body 之前拿，body 一读 response 就被消费了
    let cookies = collect_response_cookies(&response);
    let body: Value = response
        .json()
        .await
        .context("B 站二维码状态不是合法 JSON")?;
    Ok(classify_poll(&body, cookies))
}

fn classify_poll(body: &Value, mut cookies: BTreeMap<String, String>) -> QrPoll {
    let code = body
        .pointer("/data/code")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    match code {
        0 => {
            if let Some(refresh_token) = body
                .pointer("/data/refresh_token")
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
            {
                cookies.insert("ac_time_value".into(), refresh_token.into());
            }
            QrPoll::Done(cookies)
        }
        86090 => QrPoll::Scanned,
        86038 => QrPoll::Expired,
        _ => QrPoll::Waiting,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 状态码映射写错会让用户卡在"等待扫码"上，所以单独钉住。
    #[test]
    fn poll_codes_map_to_the_right_states() {
        let cases = [(0i64, true), (86090, false), (86038, false), (86101, false)];
        for (code, is_done) in cases {
            let mapped = classify_poll(
                &serde_json::json!({"data": {"code": code}}),
                BTreeMap::new(),
            );
            assert_eq!(matches!(mapped, QrPoll::Done(_)), is_done, "code={code}");
        }
    }

    #[test]
    fn successful_poll_persists_the_refresh_token() {
        let result = classify_poll(
            &serde_json::json!({
                "data": {"code": 0, "refresh_token": "refresh-me"}
            }),
            BTreeMap::from([("SESSDATA".into(), "session".into())]),
        );
        let QrPoll::Done(cookies) = result else {
            panic!("扫码成功应返回登录态");
        };
        assert_eq!(
            cookies.get("ac_time_value").map(String::as_str),
            Some("refresh-me")
        );
        assert_eq!(cookies.get("SESSDATA").map(String::as_str), Some("session"));
    }
}
