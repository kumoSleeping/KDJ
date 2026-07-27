//! provider 共用的网络与安全工具。
//!
//! 这里的三件事都是**修过的真实漏洞**，不是理论上的加固，改之前先读注释：
//! 1. [`host_is`]：判断"是不是本平台链接"必须比对 host，不能用子串。
//! 2. [`resolves_to_public_ip`] + [`expand_short_link`]：短链逐跳展开，
//!    每一跳都独立校验域名和目标 IP。
//! 3. [`AtomicDownload`]：先写 `.partial` 再原子改名。

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use url::Url;

/// 四家 provider 共用的 HTTP client 超时配置。
///
/// **不能用 `ClientBuilder::timeout`**：那是"从发请求到响应体读完"的全程上限，
/// 而元数据 API 和音频/视频下载共用同一个 client——下载一首 41 MB 的 FLAC
/// 在 200 KB/s 的 CDN 上要三分多钟，30 秒的全程上限会让它必定死在半路
/// （症状：`error decoding response body: operation timed out`，
/// 且失败字节数恰好 ≈ 速率 × 上限秒数）。
///
/// 正确语义拆成两段：
/// - `connect_timeout`：建连要快，服务器不通就赶紧报错；
/// - `read_timeout`：**相邻两次读之间**的间隔上限，流一直在动就永不触发，
///   真停住了（CDN 僵死、网断）也能在 30 秒内断开，不会无限挂着。
/// 总时长不设上限——下载多久是文件大小和网速的事，不该由超时来裁。
pub fn http_timeouts(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
}

/// 判断 URL 的 host 是否就是 domain（或其子域）。
///
/// 子串判断（`"163cn.tv" in text`）会把 path/query 里的同名片段也算命中，
/// 任意 URL 只要带上 `?ref=163cn.tv` 就能骗我们去请求它——那是修过的盲 SSRF，
/// 所有"是不是本平台链接"的判断都必须走这里。
pub fn host_is(url: &str, domain: &str) -> bool {
    let Ok(parsed) = Url::parse(url.trim()) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    let host = host.trim_end_matches('.');
    let target = domain.to_ascii_lowercase();
    host == target || host.ends_with(&format!(".{target}"))
}

/// 拒绝解析到私网/回环/链路本地地址的主机。
///
/// 白名单域名理论上不会解析到内网，但 DNS 可被投毒、跳转可被开放重定向指向内网，
/// 所以每一跳都要独立确认目标 IP 是公网地址。
pub async fn resolves_to_public_ip(host: &str) -> bool {
    let host = host.trim();
    if host.is_empty() {
        return false;
    }
    // 字面量 IP 不用过 DNS
    if let Ok(addr) = host.parse::<IpAddr>() {
        return is_public(&addr);
    }
    let lookup = format!("{host}:80");
    let Ok(addrs) = tokio::net::lookup_host(lookup).await else {
        return false;
    };
    let mut any = false;
    for addr in addrs {
        any = true;
        if !is_public(&addr.ip()) {
            return false;
        }
    }
    any
}

fn is_public(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.octets()[0] == 0
                // 100.64.0.0/10 CGNAT
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
                // 169.254/16 已被 is_link_local 覆盖；192.0.0.0/24 IETF 保留
                || (v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 0)
                // 198.18.0.0/15 benchmark
                || (v4.octets()[0] == 198 && (18..20).contains(&v4.octets()[1]))
                || v4.is_multicast()
                // 240.0.0.0/4 保留
                || v4.octets()[0] >= 240)
        }
        IpAddr::V6(v6) => {
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // fc00::/7 unique local
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // fe80::/10 link local
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // ::ffff:0:0/96 IPv4 映射地址要按 IPv4 规则再判一次
                || v6.to_ipv4_mapped().is_some_and(|v4| !is_public(&IpAddr::V4(v4))))
        }
    }
}

/// 短链逐跳展开。每一跳都用 `allow_host` 重新校验域名，并确认目标 IP 是公网。
///
/// **不能**图省事用 `follow_redirects(true)` 一次性跟到底再校验最终 URL——
/// 中间跳转可以是任意内网地址，而那些请求是真的会发出去的（盲 SSRF）。
pub async fn expand_short_link(
    client: &reqwest::Client,
    url: &str,
    max_hops: usize,
    allow_host: &(dyn Fn(&str) -> bool + Sync),
) -> Result<String> {
    let mut current = Url::parse(url.trim()).context("分享链接不是合法 URL")?;
    for _ in 0..max_hops {
        ensure_hop_allowed(&current, allow_host).await?;
        let response = client
            .get(current.clone())
            .send()
            .await
            .context("展开短链失败")?;
        let status = response.status();
        if !status.is_redirection() {
            if !status.is_success() {
                bail!("展开短链失败：HTTP {status}");
            }
            return Ok(response.url().to_string());
        }
        let Some(location) = response.headers().get(reqwest::header::LOCATION) else {
            return Ok(response.url().to_string());
        };
        let location = location.to_str().context("Location 头不是合法文本")?;
        current = current.join(location).context("Location 不是合法 URL")?;
    }
    bail!("分享短链跳转次数过多")
}

async fn ensure_hop_allowed(
    url: &Url,
    allow_host: &(dyn Fn(&str) -> bool + Sync),
) -> Result<()> {
    if !matches!(url.scheme(), "http" | "https") {
        bail!("分享链接跳转到了不允许的协议");
    }
    let host = url.host_str().unwrap_or_default();
    if !allow_host(host) {
        bail!("分享链接跳转到了不允许的地址");
    }
    if !resolves_to_public_ip(host).await {
        bail!("分享链接解析到了非公网地址");
    }
    Ok(())
}

/// 媒体直链的校验。
///
/// 直链来自登录态 API 的响应（不是用户输入），CDN 域名也不固定，
/// 所以这里不做域名白名单，只挡掉 `file://` 之类的协议和指向内网的主机。
pub async fn ensure_media_url(url: &str) -> Result<()> {
    let parsed = Url::parse(url).context("媒体直链不是合法 URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("媒体直链协议不受支持");
    }
    let host = parsed.host_str().unwrap_or_default();
    if !resolves_to_public_ip(host).await {
        bail!("媒体直链解析到了非公网地址");
    }
    Ok(())
}

/// 落盘守卫：先写 `<name>.partial`，校验通过才 rename 到最终路径。
///
/// 直接写目标文件的话，下载/转码中途失败会把上一次的成品截断成坏文件，
/// 而且半成品会被曲库扫描当成正常曲目收进去。
pub struct AtomicDownload {
    final_path: PathBuf,
    partial_path: PathBuf,
    committed: bool,
}

impl AtomicDownload {
    pub fn new(final_path: impl Into<PathBuf>) -> Self {
        let final_path = final_path.into();
        let partial_path = with_partial_suffix(&final_path);
        AtomicDownload {
            final_path,
            partial_path,
            committed: false,
        }
    }

    /// 正在写的临时路径。
    pub fn partial(&self) -> &Path {
        &self.partial_path
    }

    pub fn final_path(&self) -> &Path {
        &self.final_path
    }

    /// 校验通过后原子替换。
    pub fn commit(mut self) -> Result<PathBuf> {
        let size = std::fs::metadata(&self.partial_path)
            .with_context(|| format!("临时文件不存在：{}", self.partial_path.display()))?
            .len();
        if size == 0 {
            bail!("下载得到的是空文件");
        }
        std::fs::rename(&self.partial_path, &self.final_path)
            .with_context(|| format!("重命名到 {} 失败", self.final_path.display()))?;
        self.committed = true;
        Ok(self.final_path.clone())
    }
}

impl Drop for AtomicDownload {
    fn drop(&mut self) {
        if !self.committed {
            // 失败/取消路径上一定要清掉半成品，否则会被曲库扫描收走
            let _ = std::fs::remove_file(&self.partial_path);
        }
    }
}

fn with_partial_suffix(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    name.push_str(".partial");
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_is_matches_exact_host_and_subdomains() {
        assert!(host_is("https://163cn.tv/abc", "163cn.tv"));
        assert!(host_is("https://music.163.com/song?id=1", "music.163.com"));
        assert!(host_is("https://on.soundcloud.com/x", "soundcloud.com"));
    }

    #[test]
    fn host_is_rejects_the_blind_ssrf_shape() {
        // 这条就是修过的洞：子串判断会把它当成网易云链接去请求
        assert!(!host_is("https://evil.example/?ref=163cn.tv", "163cn.tv"));
        assert!(!host_is("https://163cn.tv.evil.example/x", "163cn.tv"));
        assert!(!host_is("https://notmusic.163.com.evil/x", "music.163.com"));
    }

    #[test]
    fn host_is_rejects_garbage_and_non_http_schemes() {
        assert!(!host_is("", "163cn.tv"));
        assert!(!host_is("not a url", "163cn.tv"));
        assert!(!host_is("file:///etc/passwd", "163cn.tv"));
    }

    #[tokio::test]
    async fn private_and_loopback_addresses_are_rejected() {
        for host in [
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "172.16.0.1",
            "169.254.169.254", // 云元数据服务，SSRF 的经典目标
            "0.0.0.0",
            "100.64.0.1",
            "::1",
            "fd00::1",
        ] {
            assert!(!resolves_to_public_ip(host).await, "{host} 不该被放行");
        }
    }

    #[tokio::test]
    async fn public_literals_pass() {
        assert!(resolves_to_public_ip("1.1.1.1").await);
        assert!(resolves_to_public_ip("2606:4700:4700::1111").await);
    }

    #[test]
    fn partial_file_is_cleaned_up_when_not_committed() {
        let dir = std::env::temp_dir().join("kumodeck-atomic-test");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("song.mp3");
        {
            let guard = AtomicDownload::new(&target);
            std::fs::write(guard.partial(), b"half").unwrap();
            assert!(guard.partial().exists());
            // guard 在这里被 drop：模拟下载失败
        }
        assert!(!target.exists(), "失败时不该留下成品");
        assert!(!dir.join("song.mp3.partial").exists(), "半成品必须被清掉");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_renames_atomically_and_rejects_empty_output() {
        let dir = std::env::temp_dir().join("kumodeck-atomic-commit");
        std::fs::create_dir_all(&dir).unwrap();

        let guard = AtomicDownload::new(dir.join("ok.mp3"));
        std::fs::write(guard.partial(), b"data").unwrap();
        let path = guard.commit().unwrap();
        assert!(path.exists());
        assert!(!dir.join("ok.mp3.partial").exists());

        let empty = AtomicDownload::new(dir.join("empty.mp3"));
        std::fs::write(empty.partial(), b"").unwrap();
        assert!(empty.commit().is_err(), "空文件必须当作失败");
        assert!(!dir.join("empty.mp3").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
