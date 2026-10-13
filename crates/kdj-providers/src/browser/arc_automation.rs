//! Arc's own macOS automation API. No debug port, profile copying, or keychain access.
//! Fixed script supplied over stdin; credentials stay in bounded, private process pipes.
use super::{
    apply_youtube_metadata, AuthorizedSession, BrowserSession, LoginSite, LoginTrace,
    YOUTUBE_COOKIE_NAMES,
};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const COOKIE_SCRIPT: &str = include_str!("arc_soundcloud.js");
const SCRIPT: &str = include_str!("arc_soundcloud.applescript");
const OUTPUT_LIMIT: u64 = 256 * 1024;

fn apple_string(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\r', "\\r")
            .replace('\n', "\\n")
    )
}

fn script_for(executable: &Path, allow_open: bool, site: LoginSite) -> Result<String> {
    let path = executable.to_str().context("Arc 安装路径无效")?;
    // Neither script nor application path comes from the request; discovery checked Arc's bundle ID.
    let javascript = if site == LoginSite::Soundcloud {
        COOKIE_SCRIPT.to_owned()
    } else {
        include_str!("arc_youtube.js")
            .replace("__SITE_ORIGIN__", &serde_json::to_string(site.origin())?)
            .replace(
                "__COOKIE_NAMES__",
                &serde_json::to_string(YOUTUBE_COOKIE_NAMES)?,
            )
    };
    Ok(SCRIPT
        .replace("__ARC_APP__", &apple_string(path))
        .replace("__ALLOW_OPEN__", if allow_open { "true" } else { "false" })
        .replace("__SITE_ORIGIN__", &apple_string(site.origin()))
        .replace(
            "__SITE_URL__",
            &apple_string(&format!("{}/", site.origin())),
        )
        .replace("__COOKIE_SCRIPT__", &apple_string(&javascript)))
}

#[derive(Deserialize)]
struct Reply {
    status: String,
    token: Option<String>,
    cookie: Option<String>,
    metadata: Option<serde_json::Value>,
    stage: Option<String>,
    code: Option<i32>,
}

fn decode_reply(data: &[u8]) -> Result<Reply> {
    // Arc may JSON-encode a JavaScript string a second time in its Apple Events response.
    let decoded: Result<Reply, serde_json::Error> =
        serde_json::from_slice::<serde_json::Value>(data).and_then(|value| match value {
            serde_json::Value::String(inner) => serde_json::from_str(&inner),
            value => serde_json::from_value(value),
        });
    decoded.map_err(|_| {
        let kind = match std::str::from_utf8(data).map(str::trim) {
            Ok("") => "empty",
            Ok("missing value") => "missing_value",
            Ok("undefined") => "undefined",
            Ok("null") => "null",
            _ => "invalid_json",
        };
        tracing::warn!(
            kind,
            bytes = data.len(),
            "Arc automation returned no login result"
        );
        anyhow::anyhow!("Arc 未返回有效的登录结果")
    })
}

fn session_from_reply(reply: Reply) -> Result<AuthorizedSession> {
    match reply.status.as_str() {
        "ok" => {
            let token = reply
                .token
                .filter(|token| {
                    !token.is_empty()
                        && token.len() <= 4096
                        && !token
                            .chars()
                            .any(|ch| ch.is_whitespace() || ch.is_control())
                })
                .context("Arc 返回的 SoundCloud 登录状态无效")?;
            Ok(AuthorizedSession {
                token,
                expires_at: 0,
                imported_from: "Arc · 浏览器授权".into(),
            })
        }
        "not_running" | "no_window" => bail!("请先打开已登录 SoundCloud 的 Arc 窗口，再点击连接"),
        "not_logged_in" => {
            bail!("当前 Arc 空间尚未登录 SoundCloud；请打开已登录的 SoundCloud 页面后重试")
        }
        "wrong_site" => bail!("Arc 页面已离开 SoundCloud；请返回 SoundCloud 后重试"),
        "ambiguous" => bail!("当前页面存在多个 SoundCloud 登录状态；请在 Arc 重新登录后再连接"),
        "loading" => bail!("SoundCloud 页面仍在加载；加载完成后可重新连接"),
        "permission_denied" => return Err(script_error(b"-1743")),
        "javascript_disabled" => return Err(script_error(b"JavaScript")),
        "script_error" => {
            let stage = match reply.stage.as_deref() {
                Some("connect") => "connect",
                Some("window") => "window",
                Some("create_tab") => "create_tab",
                Some("loading") => "loading",
                Some("execute") => "execute",
                Some("active_tab") => "active_tab",
                Some("tab_url") => "tab_url",
                Some("check_url") => "check_url",
                _ => "unknown",
            };
            tracing::warn!(stage, code = reply.code, "Arc automation failed");
            bail!("Arc 自动化连接失败；请打开 SoundCloud 页面并确认已允许自动化后重试");
        }
        _ => bail!("Arc 未完成本次登录读取"),
    }
}

fn script_error(stderr: &[u8]) -> anyhow::Error {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    // Never forward AppleScript output: browser/page error messages can contain private data.
    let message = if text.contains("-1743") || text.contains("not authorized") {
        "macOS 未允许 KDJ 控制 Arc；请在系统设置的「隐私与安全性 → 自动化」中允许后重试"
    } else if text.contains("javascript") || text.contains("java script") {
        "请在 Arc 菜单「开发者（Developer）」中开启「Allow JavaScript from Apple Events」，然后重新连接"
    } else if text.contains("-1712") {
        "等待 Arc 授权超时；请完成系统确认后重新连接"
    } else {
        "Arc 自动化连接失败；请打开 SoundCloud 页面并确认已允许自动化后重试"
    };
    anyhow::anyhow!(message)
}

pub(super) async fn read_soundcloud(
    executable: &Path,
    trace: &LoginTrace,
) -> Result<AuthorizedSession> {
    session_from_reply(read_reply(executable, LoginSite::Soundcloud, trace).await?)
}

pub(super) async fn read_youtube(
    executable: &Path,
    site: LoginSite,
    trace: &LoginTrace,
) -> Result<BrowserSession> {
    let reply = read_reply(executable, site, trace).await.map_err(|error| {
        anyhow::anyhow!("{}", error.to_string().replace("SoundCloud", site.label()))
    })?;
    if reply.status != "ok" {
        let error = session_from_reply(reply)
            .err()
            .unwrap_or_else(|| anyhow::anyhow!("Arc 未返回登录状态"));
        bail!("{}", error.to_string().replace("SoundCloud", site.label()));
    }
    let cookie = reply.cookie.context("Arc 未返回 YouTube 登录状态")?;
    anyhow::ensure!(
        cookie.len() <= 128 * 1024 && !cookie.contains(['\r', '\n']),
        "Arc 返回的 YouTube 登录状态无效"
    );
    let mut session = BrowserSession::from_cookie_header(&cookie, "Arc · 浏览器授权")?;
    apply_youtube_metadata(&mut session, &reply.metadata.unwrap_or_default());
    Ok(session)
}

async fn read_reply(executable: &Path, site: LoginSite, trace: &LoginTrace) -> Result<Reply> {
    trace.step("arc_automation");
    // One click spans multiple short Apple Events. Opening a tab and reading it
    // in the same long-running script can stall Arc's new-tab JavaScript bridge.
    tokio::time::timeout(Duration::from_secs(25), async {
        let mut allow_open = true;
        let mut opened = false;
        loop {
            let script = script_for(executable, allow_open, site)?;
            let reply = run_script(&script).await?;
            if reply.status == "opened" {
                trace.step("wait_page_ready");
            }
            allow_open = false;
            opened |= reply.status == "opened";
            // Arc may keep reporting the previous active tab while the new tab
            // is being attached. The page script still checks the exact origin
            // before accessing any cookie; never create another tab on retry.
            if matches!(reply.status.as_str(), "opened" | "loading")
                || (opened && reply.status == "wrong_site")
            {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            trace.detail(
                "arc_result",
                match reply.status.as_str() {
                    "ok" => "read",
                    "permission_denied" => "permission_denied",
                    "javascript_disabled" => "javascript_disabled",
                    "not_logged_in" => "no_session",
                    "ambiguous" => "ambiguous",
                    _ => "unavailable",
                },
            );
            return Ok(reply);
        }
    })
    .await
    .context("Arc 页面未及时响应，已停止等待；请在 SoundCloud 页面加载完成后重试")?
}

async fn run_script(script: &str) -> Result<Reply> {
    let mut child = tokio::process::Command::new("/usr/bin/osascript")
        .args(["-l", "AppleScript", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("无法启动 Arc 系统自动化连接")?;
    let mut stdin = child.stdin.take().context("无法连接 Arc 自动化输入")?;
    let mut stdout = child.stdout.take().unwrap().take(OUTPUT_LIMIT + 1);
    let mut stderr = child.stderr.take().unwrap().take(OUTPUT_LIMIT + 1);
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(12), async {
        stdin.write_all(script.as_bytes()).await?;
        drop(stdin);
        let (_, _, status) = tokio::try_join!(
            stdout.read_to_end(&mut output),
            stderr.read_to_end(&mut errors),
            child.wait()
        )?;
        Ok::<_, std::io::Error>(status)
    })
    .await
    .context("等待 Arc 授权超时；请完成系统确认后重新连接")?
    .context("Arc 自动化连接已中断")?;
    anyhow::ensure!(
        output.len() <= OUTPUT_LIMIT as usize && errors.len() <= OUTPUT_LIMIT as usize,
        "Arc 自动化响应过长，已停止连接"
    );
    if !result.success() {
        return Err(script_error(&errors));
    }
    decode_reply(&output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(data: &[u8]) -> Result<AuthorizedSession> {
        session_from_reply(decode_reply(data)?)
    }

    #[test]
    fn reply_must_be_successful_bounded_and_without_header_controls() {
        assert_eq!(
            session(br#"{"status":"ok","token":"test-only"}"#)
                .unwrap()
                .token,
            "test-only"
        );
        let wrapped =
            serde_json::to_vec(r#"{"status":"ok","token":"javascript-test-only"}"#).unwrap();
        assert_eq!(session(&wrapped).unwrap().token, "javascript-test-only");
        for body in [
            r#"{"status":"not_logged_in","token":"test-only"}"#,
            r#"{"status":"ok","token":"bad\r\nvalue"}"#,
            r#"{"status":"ok","token":""}"#,
            "not json",
        ] {
            assert!(session(body.as_bytes()).is_err());
        }
        let body = serde_json::json!({"status":"ok", "token":"x".repeat(4097)});
        assert!(session(body.to_string().as_bytes()).is_err());
        let loading = serde_json::to_vec(r#"{"status":"loading"}"#).unwrap();
        assert_eq!(decode_reply(&loading).unwrap().status, "loading");
    }

    #[test]
    fn script_inputs_are_literals_and_errors_do_not_echo_private_output() {
        assert_eq!(apple_string("a\"\\\nb"), "\"a\\\"\\\\\\nb\"");
        let script = script_for(
            Path::new("/Applications/Arc.app"),
            true,
            LoginSite::Soundcloud,
        )
        .unwrap();
        assert!(
            !script.contains("__ARC_APP__")
                && !script.contains("__COOKIE_SCRIPT__")
                && !script.contains("__ALLOW_OPEN__")
        );
        assert!(script.contains("tell application \"/Applications/Arc.app\""));
        for text in [
            "private-value: not authorized (-1743)",
            "private-value: JavaScript disabled",
            "private-value (-1712)",
            "private-value",
        ] {
            assert!(!script_error(text.as_bytes())
                .to_string()
                .contains("private-value"));
        }
    }
}
