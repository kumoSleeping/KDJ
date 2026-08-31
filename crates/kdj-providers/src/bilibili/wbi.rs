//! B 站 WBI 签名。
//!
//! 流程：`/x/web-interface/nav` 回 `wbi_img.img_url` / `sub_url`，
//! 各取文件名（去掉路径和扩展名）拼成 64 字符，按 [`OE`] 这张固定置换表重排，
//! 取前 32 字符得到 mixin key；再把参数按 key 排序 urlencode，
//! 和 mixin key 拼起来取 MD5 得到 `w_rid`。
//!
//! 这张表和"排序后 urlencode"的细节都是服务端逐字节校验的，改一个数就全盘失效。

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use md5::{Digest, Md5};
use serde_json::Value;

/// 64 项置换表。抄自 B 站前端，顺序不能动。
const OE: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/// mixin key 缓存时长。B 站每天换一次 key，1 小时足够安全又不用频繁打 nav。
const MIXIN_TTL: Duration = Duration::from_secs(3600);

/// 从 img_url / sub_url 推出 mixin key。
pub fn derive_mixin_key(img_url: &str, sub_url: &str) -> String {
    let raw: Vec<char> = format!("{}{}", filename_stem(img_url), filename_stem(sub_url))
        .chars()
        .collect();
    OE.iter()
        .filter_map(|index| raw.get(*index))
        .take(32)
        .collect()
}

/// `https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png` → 那串十六进制
fn filename_stem(url: &str) -> String {
    url.rsplit('/')
        .next()
        .unwrap_or("")
        .split('.')
        .next()
        .unwrap_or("")
        .to_string()
}

/// 给一组参数签名，返回可以直接拼到 URL 后面的 query string。
///
/// `wts` 由调用方传（测试要可复现），生产代码传当前秒级时间戳。
pub fn sign_params(params: &[(&str, String)], mixin_key: &str, wts: i64) -> String {
    // BTreeMap 天然按 key 排序，正好是签名要求的顺序
    let mut sorted: BTreeMap<String, String> = params
        .iter()
        .filter(|(key, _)| *key != "w_rid" && *key != "wts")
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect();
    sorted.insert("wts".into(), wts.to_string());
    let query = sorted
        .iter()
        .map(|(key, value)| format!("{}={}", urlencode(key), urlencode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let w_rid = hex::encode(Md5::digest(format!("{query}{mixin_key}").as_bytes()));
    format!("{query}&w_rid={w_rid}")
}

/// Python `urllib.parse.urlencode` 用的是 `quote_plus`：空格变 `+`，
/// 只有 `A-Za-z0-9_.-~` 不转义。和 Rust 常见的 percent-encoding 默认集合不一样，
/// 差一个字符签名就对不上。
fn urlencode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// mixin key 的缓存壳。
#[derive(Default)]
pub struct WbiKeyCache {
    inner: Mutex<Option<(String, Instant)>>,
    // 多个请求同时发现 key 过期时，只允许一个请求去刷新 nav。否则一次搜索或
    // 收藏夹展开就可能并发打出多条完全相同的 nav 请求。
    refresh: tokio::sync::Mutex<()>,
}

impl WbiKeyCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get<F, Fut>(&self, fetch_nav: F) -> Result<String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Value>>,
    {
        if let Some(key) = self.cached() {
            return Ok(key);
        }

        let _refresh = self.refresh.lock().await;
        // 等锁期间另一个请求可能已经刷新完，必须再检查一次。
        if let Some(key) = self.cached() {
            return Ok(key);
        }

        // nav 必须由 BiliClient 发出，才能和其它 B 站 API 共用同一把节流锁与
        // 风控熔断器；WbiKeyCache 只负责 single-flight 和缓存。
        let body = fetch_nav().await.context("获取 B 站 WBI key 失败")?;
        let wbi = body
            .pointer("/wbi_img")
            .context("B 站 nav 响应里没有 wbi_img")?;
        let img = wbi
            .get("img_url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let sub = wbi
            .get("sub_url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let key = derive_mixin_key(img, sub);
        anyhow::ensure!(key.len() == 32, "推导出来的 mixin key 长度不对：{key}");
        *self.inner.lock().unwrap() = Some((key.clone(), Instant::now()));
        Ok(key)
    }

    fn cached(&self) -> Option<String> {
        self.inner
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(_, at)| at.elapsed() < MIXIN_TTL)
            .map(|(key, _)| key.clone())
    }

    /// nav 里也带着登录态信息，顺手判断有没有登录。
    pub fn invalidate(&self) {
        *self.inner.lock().unwrap() = None;
    }
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 对拍值来自 bilibili_api.utils.network 的 OE / _enc_wbi
    const IMG: &str = "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png";
    const SUB: &str = "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png";

    #[test]
    fn mixin_key_matches_the_python_implementation() {
        assert_eq!(
            derive_mixin_key(IMG, SUB),
            "ea1db124af3c7062474693fa704f4ff8"
        );
    }

    #[test]
    fn mixin_key_is_always_32_chars() {
        let key = derive_mixin_key(IMG, SUB);
        assert_eq!(key.len(), 32);
    }

    #[test]
    fn w_rid_matches_the_python_implementation() {
        let mixin = derive_mixin_key(IMG, SUB);
        let signed = sign_params(
            &[
                ("bvid", "BV1L94y1H7CV".into()),
                ("cid", "1274546578".into()),
                ("qn", "80".into()),
                ("fnval", "4048".into()),
                ("otype", "json".into()),
                ("platform", "pc".into()),
                ("web_location", "1550101".into()),
            ],
            &mixin,
            1_700_000_000,
        );
        assert_eq!(
            signed,
            "bvid=BV1L94y1H7CV&cid=1274546578&fnval=4048&otype=json&platform=pc&qn=80\
             &web_location=1550101&wts=1700000000&w_rid=2b8cacca61a566517f1449e738d7de1a"
        );
    }

    #[test]
    fn params_are_sorted_regardless_of_input_order() {
        let mixin = derive_mixin_key(IMG, SUB);
        let a = sign_params(&[("b", "2".into()), ("a", "1".into())], &mixin, 1);
        let b = sign_params(&[("a", "1".into()), ("b", "2".into())], &mixin, 1);
        assert_eq!(a, b, "签名必须和参数书写顺序无关");
    }

    #[test]
    fn endpoint_context_must_be_supplied_by_the_caller() {
        let mixin = derive_mixin_key(IMG, SUB);
        let generic = sign_params(&[("keyword", "test".into())], &mixin, 1);
        assert!(!generic.contains("web_location="));

        let explicit = sign_params(
            &[
                ("keyword", "test".into()),
                ("web_location", "1315873".into()),
            ],
            &mixin,
            1,
        );
        assert!(explicit.contains("web_location=1315873"));
    }

    #[test]
    fn a_stale_w_rid_is_dropped_before_resigning() {
        let mixin = derive_mixin_key(IMG, SUB);
        let with_stale = sign_params(
            &[("bvid", "BV1".into()), ("w_rid", "deadbeef".into())],
            &mixin,
            1,
        );
        let clean = sign_params(&[("bvid", "BV1".into())], &mixin, 1);
        assert_eq!(with_stale, clean, "重试时旧的 w_rid 必须先去掉");
    }

    #[test]
    fn urlencode_uses_quote_plus_semantics() {
        // Python 的 urlencode 把空格编成 +，波浪号不转义
        assert_eq!(urlencode("a b"), "a+b");
        assert_eq!(urlencode("a~b.c-d_e"), "a~b.c-d_e");
        assert_eq!(urlencode("中"), "%E4%B8%AD");
        assert_eq!(urlencode("a/b"), "a%2Fb");
    }

    #[tokio::test]
    async fn concurrent_cache_misses_share_one_nav_fetch() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let cache = Arc::new(WbiKeyCache::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let first_cache = cache.clone();
        let first_calls = calls.clone();
        let second_cache = cache.clone();
        let second_calls = calls.clone();
        let (first, second) = tokio::join!(
            first_cache.get(|| async move {
                first_calls.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                Ok(serde_json::json!({
                    "wbi_img": { "img_url": IMG, "sub_url": SUB }
                }))
            }),
            second_cache.get(|| async move {
                second_calls.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                Ok(serde_json::json!({
                    "wbi_img": { "img_url": IMG, "sub_url": SUB }
                }))
            })
        );
        assert_eq!(first.unwrap(), second.unwrap());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
