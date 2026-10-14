//! 平台响应里的 Set-Cookie → 对已保存登录的增删。
//!
//! 网站会在普通请求的响应里换掉登录 Cookie 的值（YouTube 的 SIDCC、B 站刷新后的整套登录）。
//! 浏览器照单全收；KDJ 不收的话，网站一作废旧值，导入或复用来的登录就掉了。这里只做浏览器
//! 本来就做的事：收下这个站点自己发来的 Cookie，过期的删掉。值不进日志。

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Change {
    Set(String, String),
    Remove(String),
}

/// `site` 是这份登录所属的注册域（`youtube.com`、`bilibili.com`）。带 Domain 的只认这个域和它的
/// 子域；不带的是发这条响应的主机自己的，调用方只拿这个站点的响应来问。
pub(crate) fn changes(headers: &http::HeaderMap, site: &str) -> Vec<Change> {
    headers
        .get_all(http::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|text| cookie::Cookie::parse(text.to_owned()).ok())
        .filter(|cookie| cookie.domain().is_none_or(|domain| within(domain, site)))
        .filter(|cookie| !cookie.name().is_empty() && valid_value(cookie.value()))
        .map(|cookie| {
            if removes(&cookie) {
                Change::Remove(cookie.name().to_owned())
            } else {
                Change::Set(cookie.name().to_owned(), cookie.value().to_owned())
            }
        })
        .collect()
}

/// 合进 name → value 表；`keep` 为 false 的名字不收。返回表是否真的变了。
pub(crate) fn apply(
    cookies: &mut BTreeMap<String, String>,
    changes: &[Change],
    keep: impl Fn(&str) -> bool,
) -> bool {
    let mut changed = false;
    for change in changes {
        match change {
            Change::Set(name, value) if keep(name) => {
                if cookies.get(name) != Some(value) {
                    cookies.insert(name.clone(), value.clone());
                    changed = true;
                }
            }
            Change::Remove(name) if keep(name) => changed |= cookies.remove(name).is_some(),
            _ => {}
        }
    }
    changed
}

/// 这条 Set-Cookie 是在删 Cookie：值为空、Max-Age 不为正、Expires 已过。
fn removes(cookie: &cookie::Cookie) -> bool {
    cookie.value().is_empty()
        || cookie.max_age().is_some_and(|age| age.is_zero() || age.is_negative())
        || cookie
            .expires_datetime()
            .is_some_and(|at| at <= cookie::time::OffsetDateTime::now_utc())
}

/// 一行 Set-Cookie 是不是在删 Cookie（给自己解析名值的调用方用）。
pub(crate) fn removes_set_cookie(text: &str) -> bool {
    cookie::Cookie::parse(text).is_ok_and(|cookie| removes(&cookie))
}

fn within(domain: &str, site: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    domain == site || domain.ends_with(&format!(".{site}"))
}

/// 要原样拼回 Cookie 头里：不能带分号、空白或控制字符。
fn valid_value(value: &str) -> bool {
    !value
        .chars()
        .any(|c| c == ';' || c.is_control() || c.is_whitespace())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(lines: &[&str]) -> http::HeaderMap {
        let mut map = http::HeaderMap::new();
        for line in lines {
            map.append(http::header::SET_COOKIE, line.parse().unwrap());
        }
        map
    }

    #[test]
    fn takes_this_site_and_drops_others() {
        let found = changes(
            &headers(&[
                "SIDCC=new; Domain=.youtube.com; Path=/; Expires=Fri, 01 Jan 2100 00:00:00 GMT",
                "YSC=host; Path=/; HttpOnly",
                "NID=other; Domain=.google.com; Path=/",
                "SIDCC=x; Domain=notyoutube.com",
            ]),
            "youtube.com",
        );
        assert_eq!(
            found,
            vec![
                Change::Set("SIDCC".into(), "new".into()),
                Change::Set("YSC".into(), "host".into()),
            ]
        );
    }

    #[test]
    fn expired_and_empty_entries_remove() {
        let found = changes(
            &headers(&[
                "A=gone; Max-Age=0; Domain=.bilibili.com",
                "B=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
                "C=; Path=/",
                "D=kept; Max-Age=3600",
            ]),
            "bilibili.com",
        );
        assert_eq!(
            found,
            vec![
                Change::Remove("A".into()),
                Change::Remove("B".into()),
                Change::Remove("C".into()),
                Change::Set("D".into(), "kept".into()),
            ]
        );
    }

    #[test]
    fn apply_reports_only_real_changes_and_honours_the_filter() {
        let mut jar = BTreeMap::from([
            ("SID".to_string(), "s".to_string()),
            ("SIDCC".to_string(), "old".to_string()),
        ]);
        let all = |_: &str| true;
        assert!(!apply(&mut jar, &[Change::Set("SID".into(), "s".into())], all));
        assert!(apply(&mut jar, &[Change::Set("SIDCC".into(), "new".into())], all));
        assert!(!apply(&mut jar, &[Change::Remove("missing".into())], all));
        assert!(!apply(&mut jar, &[Change::Remove("SID".into())], |name| name != "SID"));
        assert_eq!(jar["SID"], "s");
        assert_eq!(jar["SIDCC"], "new");
    }
}
