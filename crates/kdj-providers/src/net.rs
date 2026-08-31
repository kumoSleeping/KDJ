//! provider 共用的网络与安全工具。
//!
//! 这里的三件事都是**修过的真实漏洞**，不是理论上的加固，改之前先读注释：
//! 1. [`host_is`]：判断"是不是本平台链接"必须比对 host，不能用子串。
//! 2. [`resolves_to_public_ip`] + [`expand_short_link`]：短链逐跳展开，
//!    每一跳都独立校验域名和目标 IP。
//! 3. [`AtomicDownload`]：先写 `.partial` 再原子改名。

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::header::{
    HeaderMap, AUTHORIZATION, COOKIE, HOST, ORIGIN, PROXY_AUTHORIZATION, REFERER, WWW_AUTHENTICATE,
};
use url::Url;

/// 网络响应常以几 KiB 的小 chunk 到达。直接逐块写文件会在低性能 Windows 和 U 盘上
/// 产生大量小写调用；512 KiB 用户态缓冲把它们合并成顺序写，同时只占固定内存。
const DOWNLOAD_WRITE_BUFFER_BYTES: usize = 512 * 1024;

pub async fn create_download_writer(
    path: &Path,
) -> std::io::Result<tokio::io::BufWriter<tokio::fs::File>> {
    let file = tokio::fs::File::create(path).await?;
    Ok(tokio::io::BufWriter::with_capacity(
        DOWNLOAD_WRITE_BUFFER_BYTES,
        file,
    ))
}

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
    kdj_core::ensure_rustls_ring();
    builder
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
}

/// 远程媒体 GET 的统一安全策略。
///
/// 每一跳都会重新解析公网地址并把结果固定到该次请求；因此这里不能复用 provider
/// 的普通 API client。普通 client 会自动重定向、使用系统代理并再次解析 DNS，恰好
/// 绕过媒体 URL 在请求前做的安全检查。
#[derive(Debug, Clone, Copy)]
pub struct GuardedMediaPolicy {
    pub max_redirects: usize,
    pub connect_timeout: Duration,
    pub read_timeout: Duration,
}

impl Default for GuardedMediaPolicy {
    fn default() -> Self {
        Self {
            max_redirects: 5,
            connect_timeout: Duration::from_secs(15),
            read_timeout: Duration::from_secs(30),
        }
    }
}

/// 只做与 DNS 无关的媒体 URL 校验。真正请求前仍必须走 [`guarded_media_get`]，
/// 不能把这个函数单独当成 SSRF 防线。
pub fn parse_guarded_media_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw.trim()).context("媒体地址不是合法 URL")?;
    if url.scheme() != "https" {
        bail!("远程媒体地址必须使用 HTTPS");
    }
    if url.host_str().is_none() {
        bail!("远程媒体地址缺少主机名");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("远程媒体地址不能携带用户信息");
    }
    if url.fragment().is_some() {
        bail!("远程媒体地址不能携带 fragment");
    }
    Ok(url)
}

fn guarded_redirect_url(current: &Url, location: &str) -> Result<Url> {
    let next = current
        .join(location)
        .context("媒体重定向 Location 不是合法 URL")?;
    parse_guarded_media_url(next.as_str())
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn strip_cross_origin_headers(headers: &mut HeaderMap) {
    for name in [
        AUTHORIZATION,
        COOKIE,
        PROXY_AUTHORIZATION,
        WWW_AUTHENTICATE,
        REFERER,
        ORIGIN,
        HOST,
    ] {
        headers.remove(name);
    }
}

/// HTTPS 媒体 GET：禁用系统代理、自动重定向和自动 Referer，每跳校验全部 DNS
/// 结果并通过 `resolve_to_addrs` 固定，再手动处理下一跳。
pub async fn guarded_media_get(
    url: &str,
    headers: &HeaderMap,
    policy: GuardedMediaPolicy,
) -> Result<reqwest::Response> {
    guarded_media_get_with_host(url, headers, policy, &|_| true).await
}

/// 与 [`guarded_media_get`] 相同，并允许调用方额外限定每一跳的 URL/host。
pub async fn guarded_media_get_with_host(
    url: &str,
    headers: &HeaderMap,
    policy: GuardedMediaPolicy,
    allow_url: &(dyn Fn(&Url) -> bool + Sync),
) -> Result<reqwest::Response> {
    kdj_core::ensure_rustls_ring();
    let mut current = parse_guarded_media_url(url)?;
    let mut request_headers = headers.clone();

    for hop in 0..=policy.max_redirects {
        if !allow_url(&current) {
            bail!("远程媒体地址不属于允许的来源");
        }
        let host = current.host_str().context("远程媒体地址缺少主机名")?;
        let addrs = pinned_public_addrs(&current)
            .await
            .context("远程媒体地址解析到了非公网地址")?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .referer(false)
            .https_only(true)
            // 系统代理会绕过 `resolve_to_addrs` 并让代理替我们访问私网目标。
            .no_proxy()
            .connect_timeout(policy.connect_timeout)
            .read_timeout(policy.read_timeout)
            .resolve_to_addrs(host, &addrs)
            .build()
            .context("构建受控媒体客户端失败")?;
        let response = client
            .get(current.clone())
            .headers(request_headers.clone())
            .send()
            .await
            .context("受控媒体请求失败")?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        if hop == policy.max_redirects {
            bail!("远程媒体重定向次数过多");
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .context("远程媒体重定向缺少 Location")?
            .to_str()
            .context("远程媒体重定向 Location 不是合法文本")?;
        let next = guarded_redirect_url(&current, location)?;
        if !same_origin(&current, &next) {
            strip_cross_origin_headers(&mut request_headers);
        }
        current = next;
    }
    unreachable!("有限重定向循环一定会返回")
}

fn extend_limited(buffer: &mut Vec<u8>, chunk: &[u8], max_bytes: usize) -> Result<()> {
    if buffer.len().saturating_add(chunk.len()) > max_bytes {
        bail!("远程响应超过允许大小");
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

/// 有上限地读取小型媒体辅助响应（授权 JSON、封面等）。上限按解压后的实际字节计，
/// 不能只信 Content-Length。
pub async fn response_bytes_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        bail!("远程响应超过允许大小");
    }
    let capacity = response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or_default()
        .min(max_bytes);
    let mut data = Vec::with_capacity(capacity);
    while let Some(chunk) = response.chunk().await.context("读取远程响应失败")? {
        extend_limited(&mut data, &chunk, max_bytes)?;
    }
    Ok(data)
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
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
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
    resolve_public_host(host, 80).await.is_ok()
}

/// 解析 URL 的全部目标地址，并拒绝任意非公网结果。调用方必须把返回地址固定到
/// 随后的 HTTP client，避免“检查时一次 DNS、请求时另一次 DNS”的 rebinding 窗口。
pub async fn pinned_public_addrs(url: &Url) -> Result<Vec<SocketAddr>> {
    let host = url.host_str().context("URL 缺少主机名")?;
    let port = url.port_or_known_default().context("URL 缺少端口")?;
    resolve_public_host(host, port).await
}

async fn resolve_public_host(host: &str, port: u16) -> Result<Vec<SocketAddr>> {
    let host = host.trim();
    if host.is_empty() {
        bail!("目标缺少主机名");
    }
    if let Ok(addr) = host.parse::<IpAddr>() {
        if !is_public(&addr) {
            bail!("目标解析到了非公网地址");
        }
        return Ok(vec![SocketAddr::new(addr, port)]);
    }
    let mut addrs = tokio::net::lookup_host((host, port))
        .await
        .context("无法解析目标主机")?
        .collect::<Vec<_>>();
    addrs.sort_unstable();
    addrs.dedup();
    if addrs.is_empty() || addrs.iter().any(|addr| !is_public(&addr.ip())) {
        bail!("目标解析到了非公网地址");
    }
    Ok(addrs)
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
    _client: &reqwest::Client,
    url: &str,
    max_hops: usize,
    allow_host: &(dyn Fn(&str) -> bool + Sync),
) -> Result<String> {
    kdj_core::ensure_rustls_ring();
    let mut current = Url::parse(url.trim()).context("分享链接不是合法 URL")?;
    for _ in 0..max_hops {
        let addrs = ensure_hop_allowed(&current, allow_host).await?;
        let host = current.host_str().context("分享链接缺少主机名")?;
        // reqwest 的默认 client 会自动跟随重定向，逐跳校验就会失效。每一跳都使用
        // 禁止重定向且固定 DNS 结果的 client，下一跳只在校验后才会发出。
        let client = http_timeouts(
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("KDJ link resolver")
                .resolve_to_addrs(host, &addrs),
        )
        .build()
        .context("构建短链解析客户端失败")?;
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
) -> Result<Vec<SocketAddr>> {
    if url.scheme() != "https" {
        bail!("分享链接必须使用 HTTPS");
    }
    let host = url.host_str().unwrap_or_default();
    if !allow_host(host) {
        bail!("分享链接跳转到了不允许的地址");
    }
    pinned_public_addrs(url)
        .await
        .context("分享链接解析到了非公网地址")
}

/// 媒体直链的校验。远程音视频携带账号相关签名参数，禁止明文 HTTP，避免内容和
/// 临时凭证在链路上被读取或篡改。
///
/// 直链来自登录态 API 的响应（不是用户输入），CDN 域名也不固定，
/// 所以这里不做域名白名单，只挡掉 `file://` 之类的协议和指向内网的主机。
pub async fn ensure_media_url(url: &str) -> Result<()> {
    let parsed = parse_guarded_media_url(url)?;
    pinned_public_addrs(&parsed)
        .await
        .context("媒体直链解析到了非公网地址")?;
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
        assert!(!host_is("ftp://music.163.com/song", "music.163.com"));
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

    #[tokio::test]
    async fn remote_media_requires_https() {
        assert!(ensure_media_url("http://1.1.1.1/song.mp3").await.is_err());
        assert!(ensure_media_url("https://1.1.1.1/song.mp3").await.is_ok());
    }

    #[test]
    fn guarded_media_rejects_credentials_fragments_and_http_downgrades() {
        assert!(parse_guarded_media_url("https://user@example.com/song.mp3").is_err());
        assert!(parse_guarded_media_url("https://example.com/song.mp3#secret").is_err());
        let current = Url::parse("https://1.1.1.1/song.mp3?signature=secret").unwrap();
        assert!(guarded_redirect_url(&current, "http://1.1.1.1/next").is_err());
    }

    #[test]
    fn cross_origin_redirect_does_not_inherit_capability_query_or_credentials() {
        let current = Url::parse("https://media.example/song.mp3?signature=secret").unwrap();
        let next = guarded_redirect_url(&current, "https://cdn.example/final.mp3").unwrap();
        assert_eq!(next.as_str(), "https://cdn.example/final.mp3");

        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, "Bearer secret".parse().unwrap());
        headers.insert(COOKIE, "session=secret".parse().unwrap());
        headers.insert(REFERER, current.as_str().parse().unwrap());
        strip_cross_origin_headers(&mut headers);
        assert!(!headers.contains_key(AUTHORIZATION));
        assert!(!headers.contains_key(COOKIE));
        assert!(!headers.contains_key(REFERER));
    }

    #[tokio::test]
    async fn guarded_media_rejects_private_initial_and_redirect_targets() {
        let headers = HeaderMap::new();
        assert!(guarded_media_get(
            "https://127.0.0.1/song.mp3",
            &headers,
            GuardedMediaPolicy::default(),
        )
        .await
        .is_err());

        let current = Url::parse("https://1.1.1.1/song.mp3").unwrap();
        let next =
            guarded_redirect_url(&current, "https://169.254.169.254/latest/meta-data").unwrap();
        assert!(pinned_public_addrs(&next).await.is_err());
    }

    #[test]
    fn limited_response_buffer_rejects_the_oversized_chunk() {
        let mut data = vec![0_u8; 8];
        assert!(extend_limited(&mut data, &[1, 2], 10).is_ok());
        assert!(extend_limited(&mut data, &[3], 10).is_err());
        assert_eq!(data.len(), 10, "超限 chunk 不得部分写入");
    }

    #[test]
    fn partial_file_is_cleaned_up_when_not_committed() {
        let dir = std::env::temp_dir().join("kdj-atomic-test");
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
        let dir = std::env::temp_dir().join("kdj-atomic-commit");
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
