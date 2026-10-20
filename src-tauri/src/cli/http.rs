//! 驻留进程上的 HTTP 客户端。错误体沿用 `{"detail":"..."}`。

use anyhow::{Context, Result};
use reqwest::blocking::{Client, Response};
use reqwest::header::CONTENT_TYPE;
use serde::Serialize;

pub struct HttpClient {
    base: String,
    auth_token: String,
    inner: Client,
}

impl HttpClient {
    pub fn new(base_url: &str, auth_token: &str) -> Result<Self> {
        let builder = client_builder(base_url)?.timeout(std::time::Duration::from_secs(120));
        Ok(HttpClient {
            base: base_url.trim_end_matches('/').to_string(),
            auth_token: auth_token.to_string(),
            inner: builder.build().context("构建 HTTP 客户端失败")?,
        })
    }

    /// 截图、对齐这类可能跑几分钟的请求：不设总超时，中断命令即断开连接、KDJ 停止计算。
    pub fn post_json_long<T: Serialize>(&self, path: &str, body: &T) -> Result<serde_json::Value> {
        let client = client_builder(&self.base)?
            .timeout(None::<std::time::Duration>)
            .build()
            .context("构建 HTTP 客户端失败")?;
        self.read(
            client
                .post(self.url(path))
                .bearer_auth(&self.auth_token)
                .json(body)
                .send(),
        )
    }

    /// 长任务接口逐行回 NDJSON，最后一行是结果。不设总超时：命令被中断时进程退出、
    /// 连接随之断开，KDJ 那边据此取消任务。
    pub fn post_ndjson<T: Serialize>(&self, path: &str, body: &T) -> Result<serde_json::Value> {
        use std::io::BufRead as _;
        let client = client_builder(&self.base)?
            // 阻塞客户端默认 30 秒总超时，会切断长下载。
            .timeout(None::<std::time::Duration>)
            .build()
            .context("构建 HTTP 客户端失败")?;
        let response = client
            .post(self.url(path))
            .bearer_auth(&self.auth_token)
            .json(body)
            .send()
            .context("请求 KDJ 失败")?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().unwrap_or_default();
            return Err(status_error(status, &text));
        }
        let mut last = serde_json::Value::Null;
        let mut shown = serde_json::Value::Null;
        for line in std::io::BufReader::new(response).lines() {
            let line = line.context("读取 KDJ 进度失败")?;
            if line.trim().is_empty() {
                continue;
            }
            last = serde_json::from_str(&line).context("解析 JSON 失败")?;
            // 进度行进 stderr，stdout 只留最终结果；每秒的心跳只在数字变了时才打。
            if last["event"] == "progress" && last != shown {
                eprintln!("{last}");
                shown = last.clone();
            }
        }
        Ok(last)
    }

    pub fn get_value(&self, path: &str) -> Result<serde_json::Value> {
        self.read(
            self.inner
                .get(self.url(path))
                .bearer_auth(&self.auth_token)
                .send(),
        )
    }

    pub fn get_query<T: Serialize + ?Sized>(
        &self,
        path: &str,
        query: &T,
    ) -> Result<serde_json::Value> {
        self.read(
            self.inner
                .get(self.url(path))
                .bearer_auth(&self.auth_token)
                .query(query)
                .send(),
        )
    }

    pub fn send_json<T: Serialize>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: &T,
    ) -> Result<serde_json::Value> {
        self.read(
            self.inner
                .request(method, self.url(path))
                .bearer_auth(&self.auth_token)
                .json(body)
                .send(),
        )
    }

    pub fn post_json<T: Serialize>(&self, path: &str, body: &T) -> Result<serde_json::Value> {
        self.send_json(reqwest::Method::POST, path, body)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn read(&self, result: reqwest::Result<Response>) -> Result<serde_json::Value> {
        let response = result.context("请求 KDJ 失败")?;
        let status = response.status();
        let header = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = response.text().context("读取响应失败")?;
        if !status.is_success() {
            return Err(status_error(status, &text));
        }
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Null);
        }
        if header.contains("json")
            || text.trim_start().starts_with('{')
            || text.trim_start().starts_with('[')
        {
            serde_json::from_str(&text).context("解析 JSON 失败")
        } else {
            Ok(serde_json::Value::String(text))
        }
    }
}

fn client_builder(base_url: &str) -> Result<reqwest::blocking::ClientBuilder> {
    kdj_core::ensure_rustls_ring();
    let url = reqwest::Url::parse(base_url).context("KDJ 服务地址无效")?;
    // The control API never redirects. Do not follow a stale/misconfigured endpoint
    // into a different path or service with the session credential.
    let mut builder = Client::builder().redirect(reqwest::redirect::Policy::none());
    if url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    }) {
        // A system HTTP proxy must never receive a loopback control bearer token.
        builder = builder.no_proxy();
    }
    Ok(builder)
}

/// 错误体沿用 `{"detail":"..."}`；404 单独归成 not_found，AI 才能据此分支。
fn status_error(status: reqwest::StatusCode, text: &str) -> anyhow::Error {
    let detail = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| value.get("detail").and_then(|v| v.as_str()).map(str::to_string))
        .unwrap_or_else(|| format!("HTTP {}：{text}", status.as_u16()));
    let code = if status == reqwest::StatusCode::NOT_FOUND {
        "not_found"
    } else {
        "failed"
    };
    super::CliError::new(code, detail).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn invalid_service_url_returns_an_error() {
        assert!(HttpClient::new("not a URL", "test-token").is_err());
    }

    #[test]
    fn loopback_control_api_does_not_follow_redirects() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let client = HttpClient::new(&format!("http://{address}"), "test-token").unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 8192);
            }
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            String::from_utf8(request).unwrap()
        });
        let error = client.get_value("/api/health").unwrap_err();
        assert!(error.to_string().contains("HTTP 302"), "{error:#}");
        assert!(server
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization: bearer test-token"));
    }
}
