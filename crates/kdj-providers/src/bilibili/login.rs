//! B 站扫码登录（web 端 passport 接口）。
//!
//! 比 QQ 那条链路简单得多：生成二维码拿 `qrcode_key`，轮询同一个 key，
//! 成功时 cookie 直接在响应头的 Set-Cookie 里。

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use serde_json::Value;

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
    let cookies = collect_cookies(&response);
    let body: Value = response
        .json()
        .await
        .context("B 站二维码状态不是合法 JSON")?;
    let code = body
        .pointer("/data/code")
        .and_then(Value::as_i64)
        .unwrap_or(-1);

    // 0 成功 / 86038 已失效 / 86090 已扫待确认 / 86101 未扫
    Ok(match code {
        0 => QrPoll::Done(cookies),
        86090 => QrPoll::Scanned,
        86038 => QrPoll::Expired,
        _ => QrPoll::Waiting,
    })
}

fn collect_cookies(response: &reqwest::Response) -> BTreeMap<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 状态码映射写错会让用户卡在"等待扫码"上，所以单独钉住。
    #[test]
    fn poll_codes_map_to_the_right_states() {
        let cases = [(0i64, true), (86090, false), (86038, false), (86101, false)];
        for (code, is_done) in cases {
            let mapped = match code {
                0 => QrPoll::Done(BTreeMap::new()),
                86090 => QrPoll::Scanned,
                86038 => QrPoll::Expired,
                _ => QrPoll::Waiting,
            };
            assert_eq!(matches!(mapped, QrPoll::Done(_)), is_done, "code={code}");
        }
    }
}
