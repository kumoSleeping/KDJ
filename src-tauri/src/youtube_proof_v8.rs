//! Non-macOS YouTube WebPO / player runner (Linux + Windows).
//!
//! **Design choice (option A + thin player isolate):**
//! - Mint: link `rustypipe-botguard` as a library. It embeds Deno/V8 + a JSDOM-style
//!   realm and solves BotGuard via Create/GenerateIT (same BgUtils lineage as the
//!   macOS WKWebView worker). Keeps BotGuard out of the main Tauri renderer (SEC-005).
//! - Player `s`/`n`/config: bare `deno_core` JsRuntime with a tiny URL polyfill and
//!   DOM stubs so the existing `__KDJ_YOUTUBE_NATIVE_PO__` IIFE can run `.player()`
//!   without WKWebView. BotGuard mint in that bundle is never called on this path.
//!
//! `deno_core::JsRuntime` is `!Send`, so both runtimes live on a dedicated
//! current-thread worker. The Tauri state only holds an `mpsc` sender.

use std::hash::{Hash, Hasher};
use std::sync::OnceLock;
use std::time::Duration;

use deno_core::{JsRuntime, RuntimeOptions};
use rustypipe_botguard::Botguard;
use tokio::sync::{mpsc, oneshot};

use crate::youtube_proof::{
    valid_binding, valid_bundle, valid_googlevideo_url, valid_n_value, valid_player_url,
    valid_proof_token, valid_user_agent, MAX_PLAYER_SCRIPT_BYTES, PROOF_TIMEOUT,
    PROOF_USER_AGENT,
};

const URL_POLYFILL: &str = r#"
(function () {
  if (typeof globalThis.URL === "function" && typeof globalThis.URLSearchParams === "function") {
    return;
  }
  class URLSearchParams {
    constructor(init) {
      this._map = new Map();
      if (typeof init === "string") {
        const s = init.startsWith("?") ? init.slice(1) : init;
        for (const part of s.split("&")) {
          if (!part) continue;
          const i = part.indexOf("=");
          const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, " "));
          const v = decodeURIComponent((i < 0 ? "" : part.slice(i + 1)).replace(/\+/g, " "));
          this._map.set(k, v);
        }
      }
    }
    get(k) { return this._map.has(k) ? this._map.get(k) : null; }
    set(k, v) { this._map.set(String(k), String(v)); }
    toString() {
      const out = [];
      for (const [k, v] of this._map) {
        out.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
      }
      return out.join("&");
    }
  }
  class URL {
    constructor(input, base) {
      let href = String(input);
      if (base && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
        const baseUrl = new URL(String(base));
        if (href.startsWith("/")) {
          href = baseUrl.protocol + "//" + baseUrl.hostname + href;
        } else {
          const dir = baseUrl.pathname.replace(/\/[^/]*$/, "/");
          href = baseUrl.protocol + "//" + baseUrl.hostname + dir + href;
        }
      }
      const m = href.match(/^(https?):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i);
      if (!m) throw new TypeError("Invalid URL");
      this.protocol = m[1].toLowerCase() + ":";
      this.hostname = m[2].split(":")[0].toLowerCase();
      this.pathname = m[3] || "/";
      this.search = m[4] || "";
      this.hash = m[5] || "";
      this.searchParams = new URLSearchParams(this.search);
      this.username = "";
      this.password = "";
      this.port = "";
    }
    get href() {
      const q = this.searchParams.toString();
      return this.protocol + "//" + this.hostname + this.pathname
        + (q ? "?" + q : "") + this.hash;
    }
    toString() { return this.href; }
  }
  globalThis.URL = URL;
  globalThis.URLSearchParams = URLSearchParams;
})();
"#;

const DOM_STUBS: &str = r#"
(function () {
  const expectedDocumentUrl = "https://www.youtube.com/robots.txt";
  const expectedPolicy = "default-src 'none'; "
    + "script-src 'unsafe-eval' https://www.google.com; "
    + "connect-src https://www.youtube.com https://jnn-pa.googleapis.com; "
    + "img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; "
    + "object-src 'none'; frame-src 'none'; worker-src 'none'; "
    + "base-uri 'none'; form-action 'none'";
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.location = { href: expectedDocumentUrl };
  const cspMeta = { content: expectedPolicy };
  globalThis.document = {
    querySelector(sel) {
      return sel === 'meta[data-kdj-youtube-proof-csp="1"]' ? cspMeta : null;
    },
    createElement() {
      return {
        httpEquiv: "",
        content: "",
        dataset: {},
        referrerPolicy: "",
        src: "",
        onload: null,
        onerror: null,
        remove() {},
      };
    },
    head: { prepend() {}, append() {} },
    body: { replaceChildren() {} },
    title: "",
  };
})();
"#;

enum ProofCommand {
    Mint {
        binding: String,
        force_fresh: bool,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Player {
        bundle: String,
        player_url: String,
        javascript: String,
        operation: String,
        value: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
}

/// Send-safe handle to the dedicated Deno/V8 worker thread.
pub struct V8ProofState {
    tx: mpsc::Sender<ProofCommand>,
}

impl Default for V8ProofState {
    fn default() -> Self {
        Self {
            tx: proof_worker_sender(),
        }
    }
}

fn proof_worker_sender() -> mpsc::Sender<ProofCommand> {
    static TX: OnceLock<mpsc::Sender<ProofCommand>> = OnceLock::new();
    TX.get_or_init(spawn_proof_worker).clone()
}

fn spawn_proof_worker() -> mpsc::Sender<ProofCommand> {
    let (tx, rx) = mpsc::channel::<ProofCommand>(4);
    std::thread::Builder::new()
        .name("kdj-youtube-proof-v8".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("youtube proof v8 runtime");
            let local = tokio::task::LocalSet::new();
            local.block_on(&runtime, worker_loop(rx));
        })
        .expect("spawn youtube proof v8 worker");
    tx
}

async fn worker_loop(mut rx: mpsc::Receiver<ProofCommand>) {
    let mut botguard: Option<Botguard> = None;
    let mut player: Option<PlayerIsolate> = None;
    while let Some(cmd) = rx.recv().await {
        match cmd {
            ProofCommand::Mint {
                binding,
                force_fresh,
                reply,
            } => {
                let result = mint_on_worker(&mut botguard, &binding, force_fresh).await;
                if result.is_err() {
                    botguard = None;
                }
                let _ = reply.send(result);
            }
            ProofCommand::Player {
                bundle,
                player_url,
                javascript,
                operation,
                value,
                reply,
            } => {
                let result = player_on_worker(
                    &mut player,
                    &bundle,
                    &player_url,
                    &javascript,
                    &operation,
                    &value,
                )
                .await;
                if result.is_err() {
                    player = None;
                }
                let _ = reply.send(result);
            }
        }
    }
}

struct PlayerIsolate {
    runtime: JsRuntime,
    bundle_hash: u64,
}

fn bundle_hash(bundle: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bundle.hash(&mut hasher);
    hasher.finish()
}

fn map_bg_error(error: rustypipe_botguard::Error) -> String {
    format!("YouTube proof V8 运行失败：{error}")
}

async fn mint_on_worker(
    botguard: &mut Option<Botguard>,
    binding: &str,
    force_fresh: bool,
) -> Result<String, String> {
    if force_fresh {
        *botguard = None;
    }
    if botguard.is_none() {
        let bg = Botguard::builder()
            .user_agent(PROOF_USER_AGENT)
            .init()
            .await
            .map_err(map_bg_error)?;
        *botguard = Some(bg);
    }
    let bg = botguard
        .as_mut()
        .ok_or_else(|| "YouTube proof V8 运行器未初始化".to_string())?;
    let token = tokio::time::timeout(PROOF_TIMEOUT, bg.mint_token(binding))
        .await
        .map_err(|_| "YouTube proof 原生运算超时".to_string())?
        .map_err(map_bg_error)?;
    if !valid_proof_token(&token) {
        return Err("YouTube proof 没有返回合法 GVS token".into());
    }
    Ok(token)
}

fn ensure_player<'a>(
    player: &'a mut Option<PlayerIsolate>,
    bundle: &str,
) -> Result<&'a mut JsRuntime, String> {
    let hash = bundle_hash(bundle);
    let needs_new = player
        .as_ref()
        .is_none_or(|isolate| isolate.bundle_hash != hash);
    if needs_new {
        *player = None;
        let mut runtime = JsRuntime::new(RuntimeOptions::default());
        runtime
            .execute_script("kdj_url_polyfill.js", URL_POLYFILL)
            .map_err(|error| format!("YouTube player V8 URL 初始化失败：{error}"))?;
        runtime
            .execute_script("kdj_dom_stubs.js", DOM_STUBS)
            .map_err(|error| format!("YouTube player V8 DOM 隔离桩失败：{error}"))?;
        let owned = bundle.to_owned();
        runtime
            .execute_script(
                "kdj_youtube_native_po.js",
                deno_core::FastString::from(owned),
            )
            .map_err(|error| format!("YouTube player V8 本地代码加载失败：{error}"))?;
        let installed = runtime
            .execute_script(
                "kdj_check_po.js",
                "typeof globalThis.__KDJ_YOUTUBE_NATIVE_PO__?.player === 'function'",
            )
            .map_err(|error| format!("YouTube player V8 接口检查失败：{error}"))?;
        {
            let scope = &mut runtime.handle_scope();
            let local = deno_core::v8::Local::new(scope, installed);
            if !local.is_true() {
                return Err("YouTube player V8 未暴露 player 接口".into());
            }
        }
        *player = Some(PlayerIsolate {
            runtime,
            bundle_hash: hash,
        });
    }
    Ok(&mut player
        .as_mut()
        .ok_or_else(|| "YouTube player V8 运行器未初始化".to_string())?
        .runtime)
}

async fn player_on_worker(
    player: &mut Option<PlayerIsolate>,
    bundle: &str,
    player_url: &str,
    javascript: &str,
    operation: &str,
    value: &str,
) -> Result<String, String> {
    let runtime = ensure_player(player, bundle)?;
    let player_url_json = serde_json::to_string(player_url)
        .map_err(|_| "YouTube player 地址序列化失败".to_string())?;
    let player_javascript_json = serde_json::to_string(javascript)
        .map_err(|_| "YouTube player 脚本序列化失败".to_string())?;
    let operation_json = serde_json::to_string(operation)
        .map_err(|_| "YouTube player 操作序列化失败".to_string())?;
    let input_json =
        serde_json::to_string(value).map_err(|_| "YouTube player 输入序列化失败".to_string())?;
    let source = format!(
        r#"(async () => {{
  const value = await globalThis.__KDJ_YOUTUBE_NATIVE_PO__.player(
    {operation_json}, {player_url_json}, {player_javascript_json}, {input_json}
  );
  return JSON.stringify({{ value: String(value) }});
}})()"#
    );
    let promise = runtime
        .execute_script(
            "kdj_youtube_player.js",
            deno_core::FastString::from(source),
        )
        .map_err(|error| format!("YouTube player 原生运算失败：{error}"))?;
    let resolve = runtime.resolve(promise);
    let resolved = tokio::time::timeout(
        PROOF_TIMEOUT,
        runtime.with_event_loop_promise(resolve, Default::default()),
    )
    .await
    .map_err(|_| "YouTube player 原生运算超时".to_string())?
    .map_err(|error| format!("YouTube player 原生运算失败：{error}"))?;

    let raw = {
        let scope = &mut runtime.handle_scope();
        let local = deno_core::v8::Local::new(scope, resolved);
        local.to_rust_string_lossy(scope)
    };
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "YouTube player 原生响应无效".to_string())?;
    let output = parsed
        .get("value")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "YouTube player 没有返回结果".to_string())?;

    match operation {
        "config"
            if output
                .parse::<u64>()
                .is_ok_and(|n| (10_000..=100_000).contains(&n)) =>
        {
            Ok(output)
        }
        "transform_n" if valid_n_value(&output) => Ok(output),
        "decipher" if valid_googlevideo_url(&output) => Ok(output),
        _ => Err("YouTube player 返回结果无效".into()),
    }
}

async fn call_worker(
    state: &V8ProofState,
    cmd_with_reply: impl FnOnce(oneshot::Sender<Result<String, String>>) -> ProofCommand,
) -> Result<String, String> {
    let (reply_tx, reply_rx) = oneshot::channel();
    state
        .tx
        .send(cmd_with_reply(reply_tx))
        .await
        .map_err(|_| "YouTube proof V8 工作线程已停止".to_string())?;
    tokio::time::timeout(PROOF_TIMEOUT + Duration::from_secs(5), reply_rx)
        .await
        .map_err(|_| "YouTube proof V8 工作线程超时".to_string())?
        .map_err(|_| "YouTube proof V8 工作线程状态丢失".to_string())?
}

pub async fn mint_gvs_po_token(
    state: &V8ProofState,
    bundle: String,
    binding: String,
    force_fresh: bool,
    user_agent: String,
) -> Result<String, String> {
    if !valid_bundle(&bundle) {
        return Err("YouTube proof 本地代码无效".into());
    }
    if !valid_binding(&binding) {
        return Err("YouTube GVS 绑定值无效".into());
    }
    if !valid_user_agent(&user_agent) {
        return Err("YouTube proof 浏览器标识不匹配".into());
    }
    let _ = bundle; // API parity with macOS; mint uses rustypipe's own BotGuard bundle.
    call_worker(state, |reply| ProofCommand::Mint {
        binding,
        force_fresh,
        reply,
    })
    .await
}

pub async fn run_player(
    state: &V8ProofState,
    bundle: String,
    player_url: String,
    javascript: String,
    operation: String,
    value: String,
) -> Result<String, String> {
    if !valid_bundle(&bundle) {
        return Err("YouTube player 本地代码无效".into());
    }
    if !valid_player_url(&player_url)
        || javascript.is_empty()
        || javascript.len() > MAX_PLAYER_SCRIPT_BYTES
        || javascript.contains('\0')
    {
        return Err("YouTube player 脚本无效".into());
    }
    match operation.as_str() {
        "config" if value.is_empty() => {}
        "transform_n" if valid_n_value(&value) => {}
        "decipher"
            if !value.is_empty() && value.len() <= 16 * 1024 && !value.contains(['\r', '\n']) => {}
        _ => return Err("YouTube player 操作无效".into()),
    }
    call_worker(state, |reply| ProofCommand::Player {
        bundle,
        player_url,
        javascript,
        operation,
        value,
        reply,
    })
    .await
}


#[cfg(test)]
mod live_tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "live YouTube BotGuard; run with --ignored"]
    async fn mints_live_po_token_against_youtube() {
        let state = V8ProofState::default();
        let bundle = "/* __KDJ_YOUTUBE_NATIVE_PO__ */";
        let token = mint_gvs_po_token(
            &state,
            bundle.into(),
            "dQw4w9WgXcQ".into(),
            true,
            PROOF_USER_AGENT.into(),
        )
        .await
        .expect("live mint");
        assert!(valid_proof_token(&token), "token={token}");
        eprintln!("live mint ok len={}", token.len());
    }
}

#[cfg(test)]
mod player_tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn runs_player_config_in_isolate() {
        let state = V8ProofState::default();
        let bundle = r#"(function(){
  Object.defineProperty(globalThis, "__KDJ_YOUTUBE_NATIVE_PO__", {
    value: Object.freeze({
      mint: async () => { throw new Error("mint unused"); },
      player: async (operation) => {
        if (operation === "config") return "20500";
        throw new Error("unexpected " + operation);
      }
    }),
    configurable: false, enumerable: false, writable: false
  });
})();"#;
        let value = run_player(
            &state,
            bundle.into(),
            "https://www.youtube.com/s/player/abc/player_ias.vflset/en_US/base.js".into(),
            "/* player script placeholder */".into(),
            "config".into(),
            "".into(),
        )
        .await
        .expect("player config");
        assert_eq!(value, "20500");
    }
}
