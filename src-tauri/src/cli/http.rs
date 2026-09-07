//! 驻留进程上的 HTTP 客户端。错误体沿用 `{"detail":"..."}`。

use anyhow::{bail, Context, Result};
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
        kdj_core::ensure_rustls_ring();
        let url = reqwest::Url::parse(base_url).context("KDJ 服务地址无效")?;
        let mut builder = Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            // The control API never redirects. Do not follow a stale/misconfigured endpoint
            // into a different path or service with the session credential.
            .redirect(reqwest::redirect::Policy::none());
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
        Ok(HttpClient {
            base: base_url.trim_end_matches('/').to_string(),
            auth_token: auth_token.to_string(),
            inner: builder.build().context("构建 HTTP 客户端失败")?,
        })
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

    pub fn delete_query<T: Serialize + ?Sized>(
        &self,
        path: &str,
        query: &T,
    ) -> Result<serde_json::Value> {
        self.read(
            self.inner
                .delete(self.url(path))
                .bearer_auth(&self.auth_token)
                .query(query)
                .send(),
        )
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
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(detail) = value.get("detail").and_then(|v| v.as_str()) {
                    bail!("{detail}");
                }
            }
            bail!("HTTP {}：{text}", status.as_u16());
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
