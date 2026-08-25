//! 驻留进程上的 HTTP 客户端。错误体沿用 `{"detail":"..."}`。

use anyhow::{bail, Context, Result};
use reqwest::blocking::{Client, Response};
use reqwest::header::CONTENT_TYPE;
use serde::Serialize;

pub struct HttpClient {
    base: String,
    inner: Client,
}

impl HttpClient {
    pub fn new(base_url: &str) -> Self {
        HttpClient {
            base: base_url.trim_end_matches('/').to_string(),
            inner: Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .expect("构建 HTTP 客户端"),
        }
    }

    pub fn get_value(&self, path: &str) -> Result<serde_json::Value> {
        self.read(self.inner.get(self.url(path)).send())
    }

    pub fn get_query<T: Serialize + ?Sized>(
        &self,
        path: &str,
        query: &T,
    ) -> Result<serde_json::Value> {
        self.read(self.inner.get(self.url(path)).query(query).send())
    }

    pub fn send_json<T: Serialize>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: &T,
    ) -> Result<serde_json::Value> {
        self.read(self.inner.request(method, self.url(path)).json(body).send())
    }

    pub fn post_json<T: Serialize>(&self, path: &str, body: &T) -> Result<serde_json::Value> {
        self.send_json(reqwest::Method::POST, path, body)
    }

    pub fn patch_json<T: Serialize>(&self, path: &str, body: &T) -> Result<serde_json::Value> {
        self.send_json(reqwest::Method::PATCH, path, body)
    }

    pub fn delete_query<T: Serialize + ?Sized>(
        &self,
        path: &str,
        query: &T,
    ) -> Result<serde_json::Value> {
        self.read(self.inner.delete(self.url(path)).query(query).send())
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
