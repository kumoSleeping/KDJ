//! B 站分享文案 → (BV 号, 分 P 下标)。
//!
//! 短链展开是这里最敏感的部分：`b23.tv` 必须**逐跳**校验域名白名单 + 目标 IP 是公网。
//! 一次性 follow 到底再校验最终 URL 是不够的——中间跳转可以是任意内网地址，
//! 而那些请求是真的会发出去的（盲 SSRF）。

use anyhow::{bail, Context, Result};

/// 允许出现在分享链接里的域名。
const ALLOWED_HOSTS: [&str; 4] = [
    "b23.tv",
    "bilibili.com",
    "www.bilibili.com",
    "m.bilibili.com",
];

/// 请求 UA。
///
/// **版本号必须是完整的四段**（`131.0.0.0`）。
///
/// Python 版的 `USER_AGENT` 常量写的是 `Chrome/131.0`——一个不存在的 Chrome 版本号——
/// 但那个常量只用于下载和短链展开，搜索走的是 bilibili_api 自带的 UA，所以没暴露。
/// 移植时我把它当成"全局 UA"复用到了搜索上，于是搜索接口的风控把请求判成机器人：
/// 返回 `code=0` + `data: {v_voucher}`，一条结果都没有却**不报错**。
///
/// 实测二分过：cookie（buvid3/buvid4/空 SESSDATA）、query 参数顺序、
/// Referer 结尾的斜杠都不影响结果，**只有 UA 会**。
/// playurl / view 不受这条风控管，所以只有搜索是瞎的，很难从现象反推原因。
pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                              (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

pub fn host_allowed(host: &str) -> bool {
    let normalized = host.to_ascii_lowercase();
    let normalized = normalized.trim_end_matches('.');
    ALLOWED_HOSTS.contains(&normalized) || normalized.ends_with(".bilibili.com")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoTarget {
    pub bvid: String,
    pub page_index: usize,
    pub resolved_url: String,
}

/// 规范化 BV 号。
///
/// 后 10 位是**大小写敏感**的 base58，只能把 `BV` 前缀统一成大写，其余原样保留。
pub fn normalize_bvid(text: &str) -> String {
    let bytes: Vec<char> = text.chars().collect();
    for start in 0..bytes.len().saturating_sub(11) {
        let head: String = bytes[start..start + 2].iter().collect();
        if !head.eq_ignore_ascii_case("BV") {
            continue;
        }
        let tail: String = bytes[start + 2..start + 12].iter().collect();
        if tail.len() == 10 && tail.chars().all(|c| c.is_ascii_alphanumeric()) {
            return format!("BV{tail}");
        }
    }
    String::new()
}

/// 从文本里挑出第一个通过白名单的 B 站链接。
///
/// 要遍历所有 URL 而不是只看第一个，否则
/// 「转自 t.cn/xxx 原视频 bilibili.com/xxx」整条会被拒。
pub fn pick_bilibili_url(text: &str) -> String {
    for candidate in extract_urls(text) {
        let cleaned =
            candidate.trim_end_matches(|c: char| "。，、；：！？,.!?;:)]}>'\"".contains(c));
        if let Ok(parsed) = url::Url::parse(cleaned) {
            if host_allowed(parsed.host_str().unwrap_or_default()) {
                return cleaned.to_string();
            }
        }
    }
    String::new()
}

/// 收藏夹链接里的 fid。认两种写法：
/// - `space.bilibili.com/{mid}/favlist?fid={fid}`（www 前缀也行）
/// - 纯数字 fid（用户从收藏夹页地址栏手抠出来的那串）
///
/// 注意 fid 不是 mid：同一用户的多个收藏夹各有各的 fid。
pub fn pick_favlist_id(text: &str) -> Option<String> {
    let text = text.trim();
    if let Some(position) = text.find("favlist") {
        let query = &text[position..];
        if let Some(fid_start) = query.find("fid=") {
            let rest = &query[fid_start + 4..];
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if !digits.is_empty() {
                return Some(digits);
            }
        }
        return None;
    }
    // 没有 favlist 字样时，接受纯数字输入当 fid。
    let trimmed = text.trim();
    if !trimmed.is_empty() && trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return Some(trimmed.to_string());
    }
    None
}

fn extract_urls(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let rest = &text[index..];
        let Some(offset) = rest.find("http") else {
            break;
        };
        let start = index + offset;
        if !text[start..].starts_with("http://") && !text[start..].starts_with("https://") {
            index = start + 4;
            continue;
        }
        let end = text[start..]
            .find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"' || c == '\'')
            .map(|offset| start + offset)
            .unwrap_or(text.len());
        out.push(&text[start..end]);
        index = end.max(start + 4);
    }
    out
}

pub fn page_index_from_url(value: &str) -> usize {
    let Ok(parsed) = url::Url::parse(value) else {
        return 0;
    };
    parsed
        .query_pairs()
        .find(|(key, _)| key == "p")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .map(|page| page.saturating_sub(1))
        .unwrap_or(0)
}

/// 反转义分享文案里常见的 HTML 实体和 `\/`。
pub fn normalize_shared_text(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("\\/", "/")
}

/// 把「分享文案 / 链接 / 裸 BV 号」解析成目标。
///
/// 需要发网络请求（展开 b23.tv）时才用到 `http`。
pub async fn resolve_video_target(http: &reqwest::Client, source: &str) -> Result<VideoTarget> {
    let text = normalize_shared_text(source.trim());
    let shared_url = pick_bilibili_url(&text);
    let direct_bvid = normalize_bvid(&text);
    let page_index = if shared_url.is_empty() {
        0
    } else {
        page_index_from_url(&shared_url)
    };

    if !shared_url.is_empty() {
        let host = url::Url::parse(&shared_url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_ascii_lowercase))
            .unwrap_or_default();
        // 普通站内链接里已经带 BV 号，没必要再发一次请求；b23.tv 短链才需要展开
        if !direct_bvid.is_empty() && host != "b23.tv" {
            return Ok(VideoTarget {
                bvid: direct_bvid,
                page_index,
                resolved_url: shared_url,
            });
        }
        let resolved =
            crate::net::expand_short_link(http, &shared_url, 3, &|host| host_allowed(host))
                .await
                .context("展开哔哩哔哩短链失败")?;
        let resolved_host = url::Url::parse(&resolved)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_string))
            .unwrap_or_default();
        if !host_allowed(&resolved_host) {
            bail!("分享短链跳转到了非哔哩哔哩域名");
        }
        let resolved_bvid = normalize_bvid(&resolved);
        if !resolved_bvid.is_empty() {
            return Ok(VideoTarget {
                page_index: page_index_from_url(&resolved),
                bvid: resolved_bvid,
                resolved_url: resolved,
            });
        }
    }

    if !direct_bvid.is_empty() {
        return Ok(VideoTarget {
            bvid: direct_bvid,
            page_index,
            resolved_url: String::new(),
        });
    }
    bail!("没有找到有效的哔哩哔哩 BV 号或分享链接")
}

/// 搜索接口的标题带 `<em class="keyword">` 高亮标签，展示前要剥掉再反转义。
pub fn strip_search_markup(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut rest = title;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        match rest[start..].find('>') {
            Some(end) => rest = &rest[start + end + 1..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    normalize_shared_text(&out).trim().to_string()
}

/// 搜索接口的时长是 `"12:34"` / `"1:02:03"` 这种钟面格式。
pub fn parse_clock(value: &str) -> Option<f64> {
    let parts: Vec<&str> = value.trim().split(':').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    let mut seconds = 0.0f64;
    for part in parts {
        seconds = seconds * 60.0 + part.parse::<f64>().ok()?;
    }
    (seconds > 0.0).then_some(seconds)
}

/// 封面地址归一成 https 绝对链接。
///
/// B 站接口回的是协议相对（`//i2.hdslb.com/...`）或纯 http，
/// 而渲染端 CSP 的 img-src 只放行 https 外链——不归一图就是白格子。
pub fn normalize_pic(url: &str) -> String {
    let url = url.trim();
    if let Some(rest) = url.strip_prefix("//") {
        return format!("https://{rest}");
    }
    if let Some(rest) = url.strip_prefix("http://") {
        return format!("https://{rest}");
    }
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bvid_case_is_preserved_except_the_prefix() {
        // 后 10 位是大小写敏感的 base58，改了就是另一个视频
        assert_eq!(normalize_bvid("bv1L94y1H7CV"), "BV1L94y1H7CV");
        assert_eq!(
            normalize_bvid("看这个 https://www.bilibili.com/video/BV1L94y1H7CV?p=2"),
            "BV1L94y1H7CV"
        );
        assert_eq!(normalize_bvid("没有号"), "");
        assert_eq!(normalize_bvid("BV123"), "", "位数不够不能算");
    }

    #[test]
    fn picks_the_bilibili_url_even_when_it_is_not_first() {
        let text = "转自 https://t.cn/AbCdEf 原视频 https://www.bilibili.com/video/BV1L94y1H7CV";
        assert_eq!(
            pick_bilibili_url(text),
            "https://www.bilibili.com/video/BV1L94y1H7CV"
        );
    }

    #[test]
    fn trailing_punctuation_is_trimmed_from_shared_urls() {
        let text = "看这个 https://b23.tv/abcdefg。";
        assert_eq!(pick_bilibili_url(text), "https://b23.tv/abcdefg");
    }

    #[test]
    fn foreign_hosts_are_never_picked() {
        assert_eq!(pick_bilibili_url("https://evil.example/bilibili.com"), "");
        assert_eq!(
            pick_bilibili_url("https://bilibili.com.evil.example/x"),
            "",
            "后缀伪装不能通过"
        );
    }

    #[test]
    fn host_allowlist_covers_subdomains_only() {
        assert!(host_allowed("www.bilibili.com"));
        assert!(host_allowed("api.bilibili.com"));
        assert!(host_allowed("b23.tv"));
        assert!(!host_allowed("bilibili.com.evil.example"));
        assert!(!host_allowed("notbilibili.com"));
    }

    #[test]
    fn page_index_is_zero_based() {
        assert_eq!(
            page_index_from_url("https://www.bilibili.com/video/BV1?p=3"),
            2
        );
        assert_eq!(page_index_from_url("https://www.bilibili.com/video/BV1"), 0);
        assert_eq!(
            page_index_from_url("https://www.bilibili.com/video/BV1?p=0"),
            0,
            "p=0 不能变成 usize 下溢"
        );
    }

    #[test]
    fn search_markup_is_stripped_and_unescaped() {
        assert_eq!(
            strip_search_markup("<em class=\"keyword\">Never</em> Gonna &amp; Give"),
            "Never Gonna & Give"
        );
        assert_eq!(strip_search_markup("普通标题"), "普通标题");
    }

    #[test]
    fn clock_durations_parse_at_both_lengths() {
        assert_eq!(parse_clock("12:34"), Some(754.0));
        assert_eq!(parse_clock("1:02:03"), Some(3723.0));
        assert_eq!(parse_clock(""), None);
        assert_eq!(parse_clock("abc"), None);
    }

    #[test]
    fn covers_are_normalized_to_https() {
        assert_eq!(
            normalize_pic("//i2.hdslb.com/bfs/archive/x.jpg"),
            "https://i2.hdslb.com/bfs/archive/x.jpg"
        );
        assert_eq!(
            normalize_pic("http://i2.hdslb.com/x.jpg"),
            "https://i2.hdslb.com/x.jpg"
        );
        assert_eq!(
            normalize_pic("https://i2.hdslb.com/x.jpg"),
            "https://i2.hdslb.com/x.jpg"
        );
    }

    #[test]
    fn favlist_ids_are_picked_from_links_or_bare_numbers() {
        assert_eq!(
            pick_favlist_id("https://space.bilibili.com/12345/favlist?fid=987654"),
            Some("987654".into())
        );
        assert_eq!(
            pick_favlist_id("https://space.bilibili.com/12345/upload/video"),
            None,
            "没有 favlist 字样且不是纯数字的不认"
        );
        assert_eq!(pick_favlist_id("987654"), Some("987654".into()));
        assert_eq!(pick_favlist_id("BV1L94y1H7CV"), None);
    }

    #[tokio::test]
    async fn plain_links_with_a_bvid_do_not_hit_the_network() {
        // 没有网络也必须能解析：直链里已经有 BV 号，不该去展开
        let http = reqwest::Client::new();
        let target = resolve_video_target(&http, "https://www.bilibili.com/video/BV1L94y1H7CV?p=2")
            .await
            .unwrap();
        assert_eq!(target.bvid, "BV1L94y1H7CV");
        assert_eq!(target.page_index, 1);
    }

    #[tokio::test]
    async fn bare_bvid_is_accepted() {
        let http = reqwest::Client::new();
        let target = resolve_video_target(&http, "BV1L94y1H7CV").await.unwrap();
        assert_eq!(target.bvid, "BV1L94y1H7CV");
        assert_eq!(target.page_index, 0);
    }

    #[tokio::test]
    async fn garbage_input_is_rejected_without_a_request() {
        let http = reqwest::Client::new();
        assert!(resolve_video_target(&http, "随便一句话").await.is_err());
    }
}
