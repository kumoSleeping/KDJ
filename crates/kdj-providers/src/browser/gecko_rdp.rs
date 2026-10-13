//! Shared Firefox-family authorization. The user enables Browser Toolbox and approves its
//! connection dialog. Only loopback listeners owned by the selected installation are contacted.
//! A cancelled/denied connection is never retried, and dropping the future closes the socket.
use super::{
    Browser, LoginSite, LoginTrace, AUTH_TIMEOUT, COMMAND_TIMEOUT, RETRY_INTERVAL,
    YOUTUBE_COOKIE_NAMES, CandidateValidator, LOGIN_TIMEOUT,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{net::Ipv4Addr, process::Stdio};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::{timeout, Instant},
};

const MAX_PACKET: usize = 1024 * 1024;
const MAX_RESULT: usize = 128 * 1024;

async fn packet(stream: &mut TcpStream) -> Result<Value> {
    let mut digits = Vec::new();
    loop {
        let byte = stream
            .read_u8()
            .await
            .context("浏览器已拒绝或结束授权连接")?;
        if byte == b':' {
            break;
        }
        anyhow::ensure!(
            byte.is_ascii_digit() && digits.len() < 7,
            "浏览器授权响应格式无效"
        );
        digits.push(byte);
    }
    let length: usize = std::str::from_utf8(&digits)?
        .parse()
        .context("浏览器授权响应长度无效")?;
    anyhow::ensure!(length > 0 && length <= MAX_PACKET, "浏览器授权响应过大");
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .await
        .context("浏览器授权连接已断开")?;
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("浏览器授权响应格式无效"))
}

struct Connection {
    stream: TcpStream,
}
impl Connection {
    async fn send(&mut self, value: Value) -> Result<()> {
        let text = value.to_string();
        self.stream
            .write_all(format!("{}:{text}", text.len()).as_bytes())
            .await
            .context("浏览器授权连接已断开")
    }
    async fn call(&mut self, actor: &str, kind: &str, mut args: Value, key: &str) -> Result<Value> {
        args["to"] = actor.into();
        args["type"] = kind.into();
        timeout(COMMAND_TIMEOUT, async {
            self.send(args).await?;
            for _ in 0..256 {
                let value = packet(&mut self.stream).await?;
                if value["from"] != actor {
                    continue;
                }
                anyhow::ensure!(
                    value.get("error").is_none(),
                    "浏览器拒绝了授权请求；请确认工具箱允许访问浏览器主进程"
                );
                if value.get(key).is_some() {
                    return Ok(value);
                }
            }
            bail!("浏览器没有返回授权结果")
        })
        .await
        .context("浏览器授权响应超时")?
    }
    async fn evaluate(&mut self, actor: &str, text: String) -> Result<Value> {
        let result = timeout(COMMAND_TIMEOUT, async {
            self.send(json!({"to":actor,"type":"evaluateJSAsync","text":text}))
                .await?;
            let mut expected = None;
            let mut event: Option<Value> = None;
            for _ in 0..256 {
                let value = packet(&mut self.stream).await?;
                if value["from"] != actor {
                    continue;
                }
                anyhow::ensure!(value.get("error").is_none(), "浏览器拒绝了登录读取请求");
                if value["type"] == "evaluationResult" {
                    event = Some(value);
                } else if let Some(id) = value["resultID"].as_str() {
                    expected = Some(id.to_owned());
                }
                if let (Some(id), Some(event)) = (&expected, &event) {
                    if event["resultID"] != *id {
                        continue;
                    }
                    // Never include exception text or protocol bodies, which can contain credentials.
                    anyhow::ensure!(
                        event["hasException"] != true
                            && event.get("exception").is_none_or(Value::is_null),
                        "浏览器无法读取所选站点登录状态；请更新浏览器后重试"
                    );
                    return Ok(event["result"].clone());
                }
            }
            bail!("浏览器没有返回登录读取结果")
        })
        .await
        .context("浏览器登录读取超时")??;
        let text = if let Some(text) = result.as_str() {
            text.to_owned()
        } else if result["type"] == "longString" {
            let length = result["length"]
                .as_u64()
                .context("浏览器返回的登录状态长度无效")? as usize;
            anyhow::ensure!(length <= MAX_RESULT, "浏览器返回的登录状态过大");
            let actor = result["actor"]
                .as_str()
                .context("浏览器返回的登录状态无效")?;
            self.call(
                actor,
                "substring",
                json!({"start":0,"end":length}),
                "substring",
            )
            .await?["substring"]
                .as_str()
                .context("浏览器返回的登录状态无效")?
                .to_owned()
        } else {
            bail!("浏览器未返回有效的登录状态");
        };
        anyhow::ensure!(text.len() <= MAX_RESULT, "浏览器返回的登录状态过大");
        serde_json::from_str(&text).map_err(|_| anyhow::anyhow!("浏览器返回的登录状态格式无效"))
    }
}

fn login_script(site: LoginSite, selected: Option<u64>) -> String {
    let names = if site == LoginSite::Soundcloud {
        &["oauth_token"][..]
    } else {
        YOUTUBE_COOKIE_NAMES
    };
    include_str!("gecko_login.js")
        .replace("__BROWSER_ID__", &json!(selected).to_string())
        .replace("__SITE_ORIGIN__", &json!(site.origin()).to_string())
        .replace("__COOKIE_NAMES__", &json!(names).to_string())
}

async fn read_connected(
    connection: &mut Connection,
    browser: &Browser,
    site: LoginSite,
    trace: &LoginTrace,
    selected: &mut Option<u64>,
    opened: &mut bool,
) -> Result<(Value, Value)> {
    let descriptor = connection
        .call("root", "getProcess", json!({"id":0}), "processDescriptor")
        .await?;
    let actor = descriptor["processDescriptor"]["actor"]
        .as_str()
        .context("浏览器未提供主进程授权")?;
    let target = connection
        .call(actor, "getTarget", json!({}), "process")
        .await?;
    let console = target["process"]["consoleActor"]
        .as_str()
        .context("浏览器未提供登录读取接口")?;
    trace.step("read_cookies");
    let response = connection.evaluate(console, login_script(site, *selected)).await?;
    if response["status"] == "no_page" && !*opened {
        browser.open_url(site.origin()).await?;
        *opened = true;
    }
    match response["status"].as_str() {
        Some("ok") => {},
        Some("no_page" | "waiting") => return Ok((json!({"cookies":[]}), Value::Null)),
        Some("closed") => bail!("登录标签页已关闭"),
        Some("ambiguous") => bail!("多个浏览器容器打开了 {}；请只保留要登录账号的该站点页面后重试", site.label()),
        Some("permission_required") => bail!("请在浏览器 about:config 中将 devtools.debugger.prompt-connection 和 devtools.debugger.force-local 恢复为 true，再重新授权"),
        _ => bail!("浏览器未返回所选站点登录状态"),
    }
    *selected = Some(response["browserId"].as_u64().context("无法核实登录标签页")?);
    let metadata = if site != LoginSite::Soundcloud {
        let browser_id = response["browserId"]
            .as_u64()
            .context("无法核实登录标签页")?;
        let descriptor = connection
            .call("root", "getTab", json!({"browserId":browser_id}), "tab")
            .await?;
        let actor = descriptor["tab"]["actor"]
            .as_str()
            .context("无法连接登录标签页")?;
        let target = connection
            .call(actor, "getTarget", json!({}), "frame")
            .await?;
        let console = target["frame"]["consoleActor"]
            .as_str()
            .context("无法读取登录标签页账号")?;
        let metadata = connection.evaluate(console, format!(
            "JSON.stringify(location.origin === {} ? {{authUser: String(globalThis.ytcfg?.get?.('SESSION_INDEX') ?? ''), userAgent: navigator.userAgent}} : null)", json!(site.origin())
        )).await?;

        metadata
    } else {
        Value::Null
    };
    Ok((response, metadata))
}

// Open the installed application's own toolbox command. This does not enable preferences;
// Gecko itself refuses to open the toolbox until the user enables both debugging controls.
async fn open_toolbox(browser: &Browser, site: LoginSite) -> Result<()> {
    #[cfg(target_os = "macos")]
    let executable = {
        let output = tokio::process::Command::new("/usr/bin/plutil")
            .args(["-extract", "CFBundleExecutable", "raw", "-o", "-"])
            .arg(browser.executable.join("Contents/Info.plist"))
            .output()
            .await?;
        let name = std::str::from_utf8(&output.stdout)?.trim();
        anyhow::ensure!(
            output.status.success()
                && !name.is_empty()
                && !name.contains(['/', '\\'])
                && name != "."
                && name != "..",
            "浏览器程序路径无效"
        );
        browser.executable.join("Contents/MacOS").join(name)
    };
    #[cfg(not(target_os = "macos"))]
    let executable = browser.executable.clone();
    let mut child = tokio::process::Command::new(executable)
        // about:debugging configures remote targets, not the two Browser Toolbox permissions.
        // Open the actual login site; the settings panel supplies native shortcuts if --devtools
        // is not forwarded by this Firefox fork. Never edit the profile preferences.
        .args(["--new-tab", site.origin(), "--devtools", "--jsdebugger"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("无法打开浏览器工具箱")?;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

use super::process_ports::listeners;

async fn selected_listener(browser: &Browser) -> Result<Option<(u32, u16)>> {
    let mut ports: Vec<_> = listeners()
        .await?
        .into_iter()
        .filter(|(pid, _)| browser.owns_process(*pid))
        .collect();
    ports.sort_unstable();
    ports.dedup();
    anyhow::ensure!(
        ports.len() <= 1,
        "该浏览器有多个本地调试端口；请关闭多余工具箱或远程调试连接后重试"
    );
    Ok(ports.pop())
}

pub(super) async fn read<T, F, Fut>(
    browser: &Browser,
    site: LoginSite,
    trace: &LoginTrace,
    finish: F,
) -> Result<T>
where F: FnMut(Value, Value) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    trace.step("open_authorization");
    if selected_listener(browser).await?.is_none() {
        open_toolbox(browser, site).await?;
    }
    trace.step("wait_browser_permission");
    timeout(LOGIN_TIMEOUT, async {
        let start = Instant::now();
        let (pid, port) = loop {
            if let Some(endpoint) = selected_listener(browser).await? { break endpoint; }
            anyhow::ensure!(start.elapsed() < AUTH_TIMEOUT, "浏览器工具箱尚未就绪；请按「授权设置」开启两个调试选项并打开 Browser Toolbox，再点击登录");
            tokio::time::sleep(RETRY_INTERVAL).await;
        };
        anyhow::ensure!(browser.owns_process(pid), "浏览器进程已改变，请重新授权");
        // Exactly one connection per action; a refused permission is final.
        let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.context("无法连接浏览器工具箱，请重新授权")?;
        let mut connection = Connection { stream };
        let greeting = packet(&mut connection.stream).await?;
        anyhow::ensure!(greeting["from"] == "root" && greeting["applicationType"] == "browser", "此端口不是浏览器工具箱");
        anyhow::ensure!(selected_listener(browser).await? == Some((pid, port)), "浏览器授权端口已改变，请重试");
        let result = async {
            let mut validator = CandidateValidator::new(finish);
            let mut selected = None;
            let mut opened = false;
            loop {
                let (cookies, metadata) = read_connected(&mut connection, browser, site, trace, &mut selected, &mut opened).await?;
                if let Some(value) = validator.check(cookies, metadata, site, trace).await? { return Ok(value); }
                trace.step("wait_browser_login");
                tokio::time::sleep(RETRY_INTERVAL).await;
            }
        }.await;
        let _ = connection.stream.shutdown().await;
        trace.step("disconnect");
        result
    }).await.context("等待浏览器授权超时；请在浏览器中允许本次连接后重试")?
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn pair() -> (Connection, TcpStream) {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let (client, server) = tokio::join!(
            TcpStream::connect(listener.local_addr().unwrap()),
            listener.accept()
        );
        (
            Connection {
                stream: client.unwrap(),
            },
            server.unwrap().0,
        )
    }
    async fn reply(stream: &mut TcpStream, value: Value) {
        let text = value.to_string();
        // Fragmented frames are normal TCP behavior.
        for bytes in format!("{}:{text}", text.len()).as_bytes().chunks(5) {
            stream.write_all(bytes).await.unwrap();
        }
    }
    #[tokio::test]
    async fn evaluation_accepts_event_before_ack_and_long_strings() {
        let (mut connection, mut server) = pair().await;
        let task = tokio::spawn(async move {
            assert_eq!(
                packet(&mut server).await.unwrap()["type"],
                "evaluateJSAsync"
            );
            reply(&mut server, json!({"from":"console", "type":"evaluationResult", "resultID":"1", "result":{"type":"longString", "length":20,"actor":"long"}})).await;
            reply(&mut server, json!({"from":"console", "resultID":"1"})).await;
            assert_eq!(
                packet(&mut server).await.unwrap(),
                json!({"to":"long","type":"substring","start":0,"end":20})
            );
            reply(
                &mut server,
                json!({"from":"long","substring":"{\"authUser\":\"2\"}"}),
            )
            .await;
        });
        assert_eq!(
            connection
                .evaluate("console", "fixed-script".into())
                .await
                .unwrap()["authUser"],
            "2"
        );
        task.await.unwrap();
    }
    #[tokio::test]
    async fn rejects_oversized_frames_and_does_not_echo_exceptions() {
        let (mut connection, mut server) = pair().await;
        server.write_all(b"9999999:").await.unwrap();
        assert!(packet(&mut connection.stream).await.is_err());
        let (mut connection, mut server) = pair().await;
        let task = tokio::spawn(async move {
            packet(&mut server).await.unwrap();
            reply(&mut server, json!({"from":"console","resultID":"1"})).await;
            reply(&mut server, json!({"from":"console","type":"evaluationResult","resultID":"1","hasException":true,"exceptionMessage":"secret-cookie"})).await;
        });
        let error = connection
            .evaluate("console", "fixed-script".into())
            .await
            .unwrap_err();
        assert!(!format!("{error:#}").contains("secret-cookie"));
        task.await.unwrap();
    }
    #[tokio::test]
    async fn gecko_site_flow_preserves_account_selection_and_closes_on_drop() {
        let (mut connection, mut server) = pair().await;
        let task = tokio::spawn(async move {
            for (kind, response) in [
                (
                    "getProcess",
                    json!({"from":"root","processDescriptor":{"actor":"process"}}),
                ),
                (
                    "getTarget",
                    json!({"from":"process","process":{"consoleActor":"chromeConsole"}}),
                ),
                (
                    "evaluateJSAsync",
                    json!({"status":"ok","browserId":42,"cookies":[{"name":"SAPISID","value":"test-only","domain":".youtube.com","expires":-1}]}),
                ),
                ("getTab", json!({"from":"root","tab":{"actor":"tab"}})),
                (
                    "getTarget",
                    json!({"from":"tab","frame":{"consoleActor":"pageConsole"}}),
                ),
                (
                    "evaluateJSAsync",
                    json!({"authUser":"3","userAgent":"test"}),
                ),
            ] {
                let request = packet(&mut server).await.unwrap();
                assert_eq!(request["type"], kind);
                if kind == "getTab" {
                    assert_eq!(request["browserId"], 42);
                }
                if kind == "evaluateJSAsync" {
                    assert!(request["text"]
                        .as_str()
                        .unwrap()
                        .contains("https://www.youtube.com"));
                    reply(&mut server, json!({"from":request["to"],"resultID":"id"})).await;
                    reply(&mut server, json!({"from":request["to"],"type":"evaluationResult","resultID":"id","result":response.to_string()})).await;
                } else {
                    reply(&mut server, response).await;
                }
            }
            let mut byte = [0];
            assert_eq!(server.read(&mut byte).await.unwrap(), 0);
        });
        let trace = LoginTrace::new("youtube", "test");
        let (cookies, metadata) = read_connected(
            &mut connection,
            &super::super::tests::test_browser(std::path::PathBuf::new()),
            LoginSite::Youtube,
            &trace,
            &mut None,
            &mut false,
        )
        .await
        .unwrap();
        assert_eq!(
            super::super::youtube_session(&cookies, &metadata, "test".into(), LoginSite::Youtube)
                .unwrap()
                .x_goog_authuser,
            "3"
        );
        drop(connection);
        task.await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires user-approved browser debugging and selected-site login; never prints credentials"]
    async fn live_gecko_authorization() -> Result<()> {
        let id = std::env::var("KDJ_TEST_AUTHORIZATION_BROWSER")?;
        let browser =
            super::super::installed_browser(&id).context("Selected browser is not installed")?;
        let trace = LoginTrace::new("youtube", "authorization_test");
        let (cookies, metadata) = read(&browser, LoginSite::Youtube, &trace, |cookies, metadata| async { Ok((cookies, metadata)) }).await?;
        let session =
            super::super::youtube_session(&cookies, &metadata, "test".into(), LoginSite::Youtube)?;
        anyhow::ensure!(!session.cookie.is_empty(), "No authenticated session");
        eprintln!("Browser authorization received a YouTube session; credential values omitted");
        Ok(())
    }
}
