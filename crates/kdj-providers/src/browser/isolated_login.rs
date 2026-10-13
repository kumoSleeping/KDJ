//! A fresh, short-lived real browser profile. Never changes or copies the user's profile.
//! Only the launched process's loopback endpoint and the selected site's cookies are used.
use super::*;
use std::process::Stdio;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
};

struct Session {
    child: Option<Child>,
    profile: Option<tempfile::TempDir>,
    #[cfg(windows)]
    job: Option<std::os::windows::io::OwnedHandle>,
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let profile = self.profile.take();
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                // This group was created for this exact child, never the user's browser group.
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            #[cfg(windows)]
            drop(self.job.take());
            let _ = child.start_kill();
            // Reap before deleting: Windows holds profile files open until process exit.
            tokio::spawn(async move {
                let _ = child.wait().await;
                if let Some(profile) = profile {
                    // Browser helpers may finish closing files just after the parent exits.
                    for _ in 0..100 {
                        match tokio::fs::remove_dir_all(profile.path()).await {
                            Ok(()) => break,
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                        }
                    }
                    drop(profile);
                }
            });
        }
    }
}

#[cfg(windows)]
fn manage_windows_process(child: &Child) -> Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::*;
    // An owned Job closes the isolated browser and its children on success, cancellation or error.
    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        anyhow::ensure!(!handle.is_null(), "无法管理浏览器登录窗口");
        let job = OwnedHandle::from_raw_handle(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        anyhow::ensure!(
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32
            ) != 0,
            "无法设置浏览器登录窗口清理"
        );
        let process = child.raw_handle().context("浏览器登录窗口已关闭")?;
        anyhow::ensure!(
            AssignProcessToJobObject(job.as_raw_handle(), process) != 0,
            "无法管理浏览器登录进程"
        );
        Ok(job)
    }
}

async fn executable(browser: &Browser) -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/usr/bin/plutil")
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
        Ok(browser.executable.join("Contents/MacOS").join(name))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(browser.executable.clone())
    }
}

fn bidi_port(line: &str) -> Option<u16> {
    line.strip_prefix("WebDriver BiDi listening on ws://127.0.0.1:")?
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|p| *p != 0)
}

async fn launch(browser: &Browser, gecko: bool, headless: bool) -> Result<(Session, Connection)> {
    let profile = tempfile::Builder::new()
        .prefix("kdj-browser-login-")
        .tempdir()?;
    let mut command = Command::new(executable(browser).await?);
    if headless {
        command.arg("--headless");
    }
    #[cfg(unix)]
    command.process_group(0);
    if gecko {
        // These affect this new profile only. Keep certificate checks and browser security defaults.
        std::fs::write(
            profile.path().join("user.js"),
            concat!(
                "user_pref(\"browser.shell.checkDefaultBrowser\", false);\n",
                "user_pref(\"browser.startup.homepage_override.mstone\", \"ignore\");\n",
                "user_pref(\"browser.aboutwelcome.enabled\", false);\n",
                "user_pref(\"zen.welcome-screen.seen\", true);\n",
            ),
        )?;
        command
            .args(["--no-remote", "--profile"])
            .arg(profile.path())
            .args(["--remote-debugging-port", "0", "about:blank"]);
    } else {
        command
            .arg(format!("--user-data-dir={}", profile.path().display()))
            .args([
                "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1",
                "--no-first-run",
                "--no-default-browser-check",
                "about:blank",
            ]);
    }
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(if gecko { Stdio::piped() } else { Stdio::null() })
        .kill_on_drop(true)
        .spawn()
        .context("无法打开浏览器登录窗口")?;
    let mut session = Session {
        child: Some(child),
        profile: Some(profile),
        #[cfg(windows)]
        job: None,
    };
    #[cfg(windows)]
    {
        session.job = Some(manage_windows_process(session.child.as_ref().unwrap())?);
    }
    let child = session.child.as_mut().unwrap();
    let endpoint = if gecko {
        let stderr = child.stderr.take().context("无法读取浏览器启动状态")?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        // Drain without logging (browser output can contain URLs). Bound each line allocation.
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut tx = Some(tx);
            let mut line = Vec::new();
            loop {
                line.clear();
                let Ok(n) = (&mut reader).take(8192).read_until(b'\n', &mut line).await else {
                    break;
                };
                if n == 0 {
                    break;
                }
                if let Some(port) = std::str::from_utf8(&line).ok().and_then(bidi_port) {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(port);
                    }
                }
            }
        });
        let port = timeout(Duration::from_secs(30), rx)
            .await
            .context("浏览器未能启动登录连接；请更新浏览器后重试")?
            .context("此浏览器未提供登录连接")?;
        format!("ws://127.0.0.1:{port}/session")
    } else {
        let path = session
            .profile
            .as_ref()
            .unwrap()
            .path()
            .join("DevToolsActivePort");
        timeout(Duration::from_secs(30), async {
            loop {
                anyhow::ensure!(child.try_wait()?.is_none(), "浏览器登录窗口已关闭");
                if let Ok(file) = tokio::fs::File::open(&path).await {
                    let mut text = String::new();
                    file.take(4097).read_to_string(&mut text).await?;
                    if let Ok(endpoint) = parse_endpoint(&text) {
                        return Ok::<_, anyhow::Error>(endpoint);
                    }
                }
                tokio::time::sleep(RETRY_INTERVAL).await;
            }
        })
        .await
        .context("浏览器未能启动登录连接；请更新浏览器后重试")??
    };
    // A fresh profile discovery file/stderr alone isn't identity proof. Check the OS owner too.
    let port = url::Url::parse(&endpoint)?
        .port()
        .context("浏览器端口无效")?;
    let pid = session
        .child
        .as_ref()
        .and_then(Child::id)
        .context("浏览器登录窗口已关闭")?;
    // The announcement can become visible before the OS listener table is updated.
    // Wait for this exact child; never weaken ownership checks to any same-brand process.
    timeout(Duration::from_secs(5), async {
        loop {
            anyhow::ensure!(session.child.as_mut().unwrap().try_wait()?.is_none(), "浏览器登录窗口已关闭");
            anyhow::ensure!(browser.owns_process(pid), "无法核实浏览器登录进程");
            if super::process_ports::listeners().await?.contains(&(pid, port)) { return Ok::<_, anyhow::Error>(()); }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }).await.context("无法核实浏览器登录端口所属进程")??;
    let config = WebSocketConfig::default()
        .max_message_size(Some(1024 * 1024))
        .max_frame_size(Some(1024 * 1024));
    let (socket, _) = timeout(
        COMMAND_TIMEOUT,
        connect_async_with_config(endpoint, Some(config), false),
    )
    .await
    .context("连接浏览器超时")?
    .context("无法连接浏览器登录窗口")?;
    Ok((session, Connection { socket, next_id: 0 }))
}

fn cookie_domains(site: LoginSite) -> &'static [&'static str] {
    match site {
        LoginSite::Soundcloud => &["soundcloud.com", ".soundcloud.com"],
        LoginSite::Youtube => &["youtube.com", ".youtube.com", "www.youtube.com"],
        LoginSite::Ytm => &["youtube.com", ".youtube.com", "music.youtube.com"],
    }
}

fn normalized_bidi_cookies(cookies: &[Value], site: LoginSite) -> Value {
    let cookies: Vec<_> = cookies.iter().filter_map(|cookie| {
        let domain = cookie["domain"].as_str()?;
        let name = cookie["name"].as_str()?;
        if !cookie_domains(site).contains(&domain) || cookie["path"] != "/"
            || !(if site == LoginSite::Soundcloud { name == "oauth_token" } else { youtube_cookie_name(name) })
            || cookie["value"]["type"] != "string" { return None; }
        Some(json!({"name":name, "domain":domain, "path":"/",
            "value":cookie["value"]["value"].as_str()?, "expires":cookie.get("expiry").cloned().unwrap_or(json!(-1))}))
    }).collect();
    json!({"cookies":cookies})
}

pub(super) async fn read<T, F, Fut>(
    browser: &Browser,
    site: LoginSite,
    gecko: bool,
    trace: &LoginTrace,
    finish: F,
) -> Result<T>
where F: FnMut(Value, Value) -> Fut, Fut: std::future::Future<Output = Result<T>> {
    trace.step("open_login_window");
    let (mut session, mut connection) = launch(browser, gecko, false).await?;
    let login_url = if site == LoginSite::Soundcloud {
        "https://soundcloud.com/signin"
    } else {
        site.origin()
    };
    let context = if gecko {
        connection
            .call("session.new", json!({"capabilities":{}}), None)
            .await?;
        let tree = connection
            .call("browsingContext.getTree", json!({"maxDepth":0}), None)
            .await?;
        let context = tree["contexts"][0]["context"]
            .as_str()
            .context("浏览器没有登录标签页")?
            .to_owned();
        connection
            .call(
                "browsingContext.navigate",
                json!({"context":context,"url":login_url,"wait":"none"}),
                None,
            )
            .await?;
        context
    } else {
        connection.verify_browser(browser).await?;
        let page = connection
            .call("Target.createTarget", json!({"url":login_url}), None)
            .await?;
        page["targetId"]
            .as_str()
            .context("无法打开登录标签页")?
            .to_owned()
    };
    trace.step("wait_browser_login");
    let mut selected = Some(context.clone());
    let mut validator = CandidateValidator::new(finish);
    let result = timeout(LOGIN_TIMEOUT, async {
        loop {
            anyhow::ensure!(session.child.as_mut().unwrap().try_wait()?.is_none(), "浏览器登录窗口已关闭");
            let (cookies, metadata) = if gecko {
                let tree = connection.call("browsingContext.getTree", json!({"maxDepth":0}), None).await?;
                let current = tree["contexts"].as_array().into_iter().flatten()
                    .find(|c| c["context"] == context).context("浏览器登录窗口已关闭")?;
                if !current["url"].as_str().is_some_and(|url| site.matches(url)) {
                    tokio::time::sleep(RETRY_INTERVAL).await;
                    continue;
                }
                let mut cookies = Vec::new();
                for domain in cookie_domains(site) {
                    let response = connection.call("storage.getCookies", json!({
                        "partition":{"type":"context","context":context},"filter":{"domain":domain,"path":"/"}
                    }), None).await?;
                    cookies.extend(response["cookies"].as_array().context("浏览器未返回登录状态")?.iter().cloned());
                }
                let metadata = if site == LoginSite::Soundcloud { Value::Null } else {
                    let response = connection.call("script.evaluate", json!({
                        "target":{"context":context},"awaitPromise":false,
                        "expression":format!("JSON.stringify(location.origin === {} ? {{authUser: String(globalThis.ytcfg?.get?.('SESSION_INDEX') ?? ''), userAgent: navigator.userAgent}} : null)", json!(site.origin()))
                    }), None).await?;
                    response.pointer("/result/value").and_then(Value::as_str)
                        .and_then(|text| serde_json::from_str(text).ok()).unwrap_or(Value::Null)
                };
                (normalized_bidi_cookies(&cookies, site), metadata)
            } else {
                let pages = connection.call("Target.getTargets", json!({}), None).await?;
                let current = pages["targetInfos"].as_array().into_iter().flatten()
                    .find(|p| p["targetId"] == context).context("浏览器登录窗口已关闭")?;
                if !current["url"].as_str().is_some_and(|url| site.matches(url)) {
                    tokio::time::sleep(RETRY_INTERVAL).await;
                    continue;
                }
                connection.site_cookies(site, trace, &mut selected).await?
            };
            if let Some(value) = validator.check(cookies, metadata, site, trace).await? { return Ok::<_, anyhow::Error>(value); }
            tokio::time::sleep(RETRY_INTERVAL).await;
        }
    }).await.context("登录超时，请重试")?;
    let _ = connection.socket.close(None).await;
    trace.step("disconnect");
    // Session guard also handles cancellation/errors: the user's ordinary browser stays open.
    drop(session);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "starts only a fresh headless profile; no user credentials"]
    async fn live_isolated_gecko_start_and_cleanup() {
        let browser = installed_browser("zen").expect("Zen installed");
        let (session, mut connection) = launch(&browser, true, true).await.unwrap();
        let path = session.profile.as_ref().unwrap().path().to_owned();
        connection
            .call("session.new", json!({"capabilities":{}}), None)
            .await
            .unwrap();
        let tree = connection
            .call("browsingContext.getTree", json!({"maxDepth":0}), None)
            .await
            .unwrap();
        assert!(tree["contexts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["url"] == "about:blank"));
        let context = tree["contexts"][0]["context"].as_str().unwrap();
        // Synthetic cookie in an empty disposable profile only: exercises the real BiDi shape.
        connection.call("storage.setCookie", json!({"partition":{"type":"context","context":context},
            "cookie":{"name":"oauth_token","value":{"type":"string","value":"kdj-test-only"},"domain":"soundcloud.com","path":"/"}
        }), None).await.unwrap();
        let response = connection
            .call(
                "storage.getCookies",
                json!({"partition":{"type":"context","context":context},
            "filter":{"domain":"soundcloud.com","path":"/"}}),
                None,
            )
            .await
            .unwrap();
        let normalized = normalized_bidi_cookies(
            response["cookies"].as_array().unwrap(),
            LoginSite::Soundcloud,
        );
        assert!(candidate_ready(&normalized, &Value::Null, LoginSite::Soundcloud));
        connection.socket.close(None).await.unwrap();
        drop(connection);
        drop(session);
        timeout(Duration::from_secs(10), async {
            while path.exists() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("temporary profile cleaned after process exit");
    }
    #[tokio::test]
    #[ignore = "starts only a fresh headless Chromium profile; no user credentials"]
    async fn live_isolated_chromium_start_and_cleanup() {
        let id = std::env::var("KDJ_TEST_ISOLATED_BROWSER").unwrap_or_else(|_| "chrome".into());
        let browser = installed_browser(&id).expect("selected Chromium browser installed");
        let (session, mut connection) = launch(&browser, false, true).await.unwrap();
        let path = session.profile.as_ref().unwrap().path().to_owned();
        connection.verify_browser(&browser).await.unwrap();
        let pages = connection
            .call("Target.getTargets", json!({}), None)
            .await
            .unwrap();
        assert!(pages["targetInfos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["url"] == "about:blank"));
        let target = pages["targetInfos"].as_array().unwrap().iter()
            .find(|page| page["url"] == "about:blank").unwrap()["targetId"].as_str().unwrap();
        let attached = connection.call("Target.attachToTarget", json!({"targetId":target,"flatten":true}), None).await.unwrap();
        let attached = attached["sessionId"].as_str().unwrap();
        // Synthetic HttpOnly credential in this empty profile; no website, account or network login.
        connection.call("Network.setCookie", json!({"name":"oauth_token","value":"kdj-fixture-only",
            "domain":".soundcloud.com","path":"/","secure":true,"httpOnly":true}), Some(attached)).await.unwrap();
        let cookies = connection.call("Network.getCookies", json!({"urls":["https://soundcloud.com/"]}), Some(attached)).await.unwrap();
        let mut validator = CandidateValidator::new(|cookies, _| async move {
            let imported = cookie_from_response(&cookies)?;
            anyhow::ensure!(imported.token == "kdj-fixture-only", "fixture cookie mismatch");
            // The owning profile must survive validation.
            Ok(())
        });
        assert!(path.exists());
        assert_eq!(validator.check(cookies, Value::Null, LoginSite::Soundcloud, &LoginTrace::new("soundcloud", "fixture")).await.unwrap(), Some(()));
        assert!(path.exists());
        connection.call("Target.detachFromTarget", json!({"sessionId":attached}), None).await.unwrap();

        connection.socket.close(None).await.unwrap();
        drop(connection);
        drop(session);
        timeout(Duration::from_secs(10), async {
            while path.exists() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("temporary profile cleaned after process exit");
    }
    #[test]
    fn endpoint_only_accepts_browser_loopback_announcement() {
        assert_eq!(
            bidi_port("WebDriver BiDi listening on ws://127.0.0.1:41235\n"),
            Some(41235)
        );
        for line in [
            "WebDriver BiDi listening on ws://evil:123",
            "WebDriver BiDi listening on ws://127.0.0.1:0",
            "WebDriver BiDi listening on ws://127.0.0.1:123/path",
        ] {
            assert_eq!(bidi_port(line), None);
        }
    }
    #[test]
    fn bidi_cookie_filter_rejects_unrelated_domains_names_and_binary_values() {
        let cookie = json!({"name":"oauth_token","domain":".soundcloud.com","path":"/","value":{"type":"string","value":"test"}});
        let mut evil = cookie.clone();
        evil["domain"] = "soundcloud.com.evil.test".into();
        let mut unrelated = cookie.clone();
        unrelated["name"] = "other".into();
        let mut binary = cookie.clone();
        binary["value"]["type"] = "base64".into();
        let result =
            normalized_bidi_cookies(&[cookie, evil, unrelated, binary], LoginSite::Soundcloud);
        assert_eq!(result["cookies"].as_array().unwrap().len(), 1);
        assert!(candidate_ready(&result, &Value::Null, LoginSite::Soundcloud));
        assert!(!candidate_ready(&result, &Value::Null, LoginSite::Youtube));
    }
}
