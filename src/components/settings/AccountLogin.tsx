import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ClipboardPaste, Globe2, LoaderCircle, LogIn, QrCode, RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import { getBridge } from "../../lib/bridge";
import { cookieEditorHeaders, MAX_COOKIE_IMPORT_BYTES } from "../../lib/cookieEditorImport";
import { motion } from "../../lib/motion";
import { useAppStore } from "../../stores/appStore";
import type { Account, BrowserCatalog, Platform, QrStateValue, QrVariant } from "../../types";
import { Button, InlineNotice } from "../common";
import { Select } from "../common/Select";
import "./AccountLogin.css";

type Method = "qr" | "cookies" | "browser" | "webview" | "headers";
interface WindowResult { status: "done" | "error" | "cancelled" | "browser_required"; message: string }

const METHODS: Record<Method, { label: string; icon: typeof Globe2 }> = {
  qr: { label: "扫码", icon: QrCode },
  cookies: { label: "从 Cookie-Editor 导入", icon: ClipboardPaste },
  browser: { label: "从浏览器导入（部分支持）", icon: Globe2 },
  webview: { label: "登录窗口", icon: LogIn },
  headers: { label: "请求头", icon: ClipboardPaste },
};

export const SCAN_WITH: Partial<Record<Platform, string>> = {
  wyy: "用网易云音乐 App 扫码",
  qqm: "用对应 App 扫码",
  bilibili: "用哔哩哔哩 App 扫码",
};
export const QR_STATE_TEXT: Partial<Record<QrStateValue, string>> = {
  waiting: "等待扫码",
  scanned: "已扫码，请在手机上确认",
  done: "登录成功",
  expired: "二维码已过期",
  refused: "已在手机上取消",
  error: "登录状态异常",
};
export const QR_FINAL_STATES = new Set<QrStateValue>(["done", "expired", "refused", "error"]);
const QR_POLL_MS = 1500;

/** The ways one account can be logged in on a desktop, in the order they are offered. */
export function loginMethods(account: Account): Method[] {
  return account.login_method === "qr" ? ["qr", "cookies", "browser"] : ["cookies", "browser", "webview", "headers"];
}

/**
 * Logging in to one account, in place under its row: the ways it has, and under them the one the
 * user chose. Nothing is open, fetched or looked for until a way is chosen; the chosen way is the
 * one written in full-strength text, and choosing it again puts it away. There is no window and no
 * mask over the settings; a code to scan comes up here as well.
 */
export function AccountLogin({ account, sourceEnabled, onDone }: {
  account: Account; sourceEnabled: boolean; onDone(): void;
}) {
  const methods = loginMethods(account);
  const [method, setMethod] = useState<Method | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const [windowBusy, setWindowBusy] = useState(false);
  const [windowNotice, setWindowNotice] = useState("");
  const windowListener = useRef<UnlistenFn | null>(null);
  const alive = useRef(true);
  const refreshAccounts = useAppStore(state => state.refreshAccounts);
  const busy = panelBusy || windowBusy;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; windowListener.current?.(); windowListener.current = null; };
  }, []);
  const openLoginWindow = async () => {
    if (!sourceEnabled) { setWindowNotice(`请先开启 ${account.label} 下载源`); return; }
    const bridge = getBridge();
    const openWindow = account.platform === "soundcloud" ? bridge.openSoundcloudWebLogin
      : account.platform === "ytm" ? bridge.openYtmWebLogin : bridge.openYoutubeWebLogin;
    setMethod("webview");
    setWindowNotice("");
    setWindowBusy(true);
    try {
      if (!openWindow) throw new Error("当前系统没有可用的登录窗口");
      windowListener.current = await listen<WindowResult>(`${account.platform}-web-login://result`, event => {
        if (!alive.current) return;
        windowListener.current?.(); windowListener.current = null;
        setWindowBusy(false);
        if (event.payload.status === "browser_required") {
          setMethod("browser");
          setWindowNotice(event.payload.message);
        } else if (event.payload.status === "done") { void refreshAccounts(); onDone(); }
        else if (event.payload.status !== "cancelled") setWindowNotice(event.payload.message || "登录未完成");
      });
      if (!alive.current) { windowListener.current?.(); windowListener.current = null; return; }
      await openWindow();
    } catch (error) {
      windowListener.current?.(); windowListener.current = null;
      if (alive.current) {
        setWindowBusy(false);
        setWindowNotice(`登录失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  return <>
    <ul className="kd-account-login-methods" aria-label={`${account.label} 登录方式`}>
      {methods.map(id => {
        const Icon = METHODS[id].icon;
        return <li key={id}>
          <button type="button" data-active={method === id || undefined} disabled={busy} onClick={() => {
            if (busy) return;
            setWindowNotice("");
            if (id === "webview") void openLoginWindow();
            else setMethod(current => current === id ? null : id);
          }}>
            <Icon size={14} aria-hidden="true" />
            <span>{METHODS[id].label}</span>
          </button>
        </li>;
      })}
    </ul>
    {windowNotice && <InlineNotice text={windowNotice} className="kd-account-notice" onDismiss={() => setWindowNotice("")} />}
    {method === "qr" && <QrPanel account={account} onDone={onDone} />}
    {method === "cookies" && <CookieEditorPanel account={account} sourceEnabled={sourceEnabled} onBusy={setPanelBusy} onDone={onDone} />}
    {(method === "browser" || method === "headers") && <LoginPanel key={method} account={account} method={method}
      sourceEnabled={sourceEnabled} onBusy={setPanelBusy} onDone={onDone} />}
  </>;
}

/** The code to scan, fetched when this way is opened and watched until the phone answers. */
function QrPanel({ account, onDone }: { account: Account; onDone(): void }) {
  const setAccount = useAppStore(state => state.setAccount);
  const [variants, setVariants] = useState<QrVariant[]>([]);
  const [state, setState] = useState<QrStateValue | null>(null);
  const [notice, setNotice] = useState("");
  const [round, setRound] = useState(0);
  useEffect(() => {
    let current = true;
    let timer = 0;
    setVariants([]);
    setState(null);
    setNotice("");
    void (async () => {
      try {
        const session = await api.loginQr(account.platform);
        if (!current) return;
        // QQ 音乐会一次返回「QQ 音乐 App」+「QQ」两张码；其它平台只有主图。
        setVariants(session.variants?.length ? session.variants
          : [{ id: "default", label: account.label, image: session.image }]);
        setState("waiting");
        const poll = async () => {
          try {
            const next = await api.loginQrState(account.platform, session.session_id);
            if (!current) return;
            setState(next.state);
            if (next.state === "done") { if (next.account) setAccount(next.account); onDone(); return; }
            if (!QR_FINAL_STATES.has(next.state)) timer = window.setTimeout(() => void poll(), QR_POLL_MS);
          } catch (error) {
            if (!current) return;
            setState("error");
            setNotice(`登录状态检查失败：${error instanceof Error ? error.message : String(error)}`);
          }
        };
        timer = window.setTimeout(() => void poll(), QR_POLL_MS);
      } catch (error) {
        if (current) setNotice(`获取登录二维码失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => { current = false; window.clearTimeout(timer); };
  }, [account.platform, round]);

  const ended = !!state && QR_FINAL_STATES.has(state) && state !== "done";
  return <div className="kd-account-login-panel" role="group" aria-label={`${account.label} · 扫码`}>
    {variants.length > 0 && <div className="kd-account-login-qr" {...motion("pop")}>
      {variants.map(variant => <figure key={variant.id}>
        <img src={variant.image} alt={`${variant.label}登录二维码`} />
        {variants.length > 1 && <figcaption>{variant.label}</figcaption>}
      </figure>)}
    </div>}
    {notice && <InlineNotice text={notice} className="kd-account-notice" onDismiss={() => setNotice("")} />}
    <div className="kd-account-login-actions">
      <span role="status" className="kd-account-login-status">
        {!state ? notice ? "" : "正在获取二维码"
          : state === "waiting" ? SCAN_WITH[account.platform] ?? "等待扫码" : QR_STATE_TEXT[state] ?? ""}
      </span>
      {(ended || (!state && !!notice)) && <Button size="sm" variant="ghost" onClick={() => setRound(value => value + 1)}>重新获取</Button>}
    </div>
  </div>;
}

function LoginPanel({ account, method, sourceEnabled, onBusy, onDone }: {
  account: Account; method: "browser" | "headers"; sourceEnabled: boolean;
  onBusy(busy: boolean): void; onDone(): void;
}) {
  const platform = account.platform;
  const setAccount = useAppStore(state => state.setAccount);
  const [catalog, setCatalog] = useState<BrowserCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusyState] = useState(false);
  const [inWindow, setInWindow] = useState(false);
  const [browser, setBrowser] = useState("");
  const [profile, setProfile] = useState("");
  const [headers, setHeaders] = useState("");
  const [notice, setNotice] = useState("");
  const [permissionRequired, setPermissionRequired] = useState(false);
  const permissionReturn = useRef(false);
  const alive = useRef(true);
  const detection = useRef(0);
  const attempt = useRef<string | null>(null);
  const cancelled = useRef(false);
  const reuse = method === "browser";
  const selected = catalog?.browsers.find(item => item.id === browser);
  const profiles = selected?.profiles ?? [];
  // Only SoundCloud goes on in a window of the chosen browser when its login cannot be read:
  // Google refuses to sign in to a browser started that way, and the others have a code to scan.
  const windowFallback = platform === "soundcloud";

  // The parent keeps the other choices still while a login is under way.
  const setBusy = (value: boolean) => { setBusyState(value); onBusy(value); };
  const cancel = async () => {
    const id = attempt.current;
    if (!id) return;
    cancelled.current = true;
    await api.cancelBrowserLogin(id);
  };
  useEffect(() => {
    alive.current = true;
    const unload = () => { void cancel().catch(() => {}); };
    window.addEventListener("pagehide", unload);
    return () => { unload(); window.removeEventListener("pagehide", unload); alive.current = false; detection.current++; onBusy(false); };
  }, []);

  const detect = async () => {
    const generation = ++detection.current;
    setLoading(true);
    setNotice("");
    try {
      const result = await api.browserCatalog(platform);
      if (!alive.current || generation !== detection.current) return;
      setCatalog(result);
      let remembered = "";
      try { remembered = localStorage.getItem(`kdj.login.browser.${platform}`) ?? ""; } catch { /* unavailable storage */ }
      // The catalog lists the browser used most recently first.
      setBrowser(previous => [previous, remembered].find(id => result.browsers.some(item => item.id === id))
        ?? result.browsers[0]?.id ?? "");
    } catch (error) {
      if (alive.current && generation === detection.current) setNotice(`检测浏览器失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (alive.current && generation === detection.current) setLoading(false);
    }
  };

  useEffect(() => { if (reuse) void detect(); }, []);

  /** One request the 取消 key can stop. */
  const request = async (fresh: boolean) => {
    const id = crypto.randomUUID();
    attempt.current = id;
    try {
      return await api.browserLogin(platform, {
        browser, request_id: id, window: fresh,
        profile: fresh ? undefined : profiles.find(item => item.id === profile)?.id ?? profiles[0]?.id,
      });
    } finally { attempt.current = null; }
  };

  const fromBrowser = async (): Promise<Account> => {
    if (!selected) throw new Error("请选择浏览器");
    const canOpenWindow = windowFallback && selected.window;
    if (!selected.reuse && !canOpenWindow) throw new Error(`${selected.label} 里没有可读取的登录`);
    if (selected.reuse) {
      try { return await request(false); }
      catch (error) {
        // What could not be read is not reported while the same browser can still log in afresh.
        if (!canOpenWindow || cancelled.current || !alive.current) throw error;
      }
    }
    setInWindow(true);
    return await request(true);
  };

  const login = async (afterPermissionSettings = false) => {
    permissionReturn.current = false;
    // SoundCloud and YouTube refuse a login while their source is switched off.
    if (account.login_method !== "qr" && !sourceEnabled) { setNotice(`请先开启 ${account.label} 下载源`); return; }
    cancelled.current = false;
    setBusy(true);
    setInWindow(false);
    setNotice("");
    setPermissionRequired(false);
    try {
      const result = reuse ? await fromBrowser()
        : await (platform === "soundcloud" ? api.soundcloudHeadersLogin(headers)
          : platform === "ytm" ? api.ytmHeadersLogin(headers) : api.youtubeHeadersLogin(headers));
      if (reuse) {
        try { localStorage.setItem(`kdj.login.browser.${platform}`, browser); } catch { /* login remains valid */ }
      }
      if (alive.current) { setHeaders(""); setBusy(false); setAccount(result); onDone(); }
    } catch (error) {
      if (!alive.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setBusy(false);
      // A login the user stopped is not a failure to report.
      if (cancelled.current) return;
      if (reuse && getBridge().platform === "darwin" && message.includes("macOS 拒绝访问 Safari 登录数据")) {
        setPermissionRequired(true);
        if (afterPermissionSettings) setNotice(import.meta.env.DEV
          ? "macOS 仍拒绝访问 Safari 登录数据。当前是开发版；请核对 KDJ Dev 或启动它的应用是否获准，正式版 KDJ 的权限不代表开发版已获准。"
          : "macOS 仍拒绝访问 Safari 登录数据；请核对当前 KDJ 的完全磁盘访问权限，已允许则退出并重新打开 KDJ。");
        return;
      }
      setNotice(`登录失败：${message}`);
    }
  };

  const openPermissionSettings = async () => {
    permissionReturn.current = false;
    setBusy(true);
    setNotice("");
    try {
      const openExternal = getBridge().openExternal;
      if (!openExternal) throw new Error("当前环境不支持打开系统设置");
      await openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
      if (alive.current) permissionReturn.current = true;
    } catch (error) {
      if (alive.current) setNotice(`无法打开权限设置：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  useEffect(() => {
    setPermissionRequired(false);
    permissionReturn.current = false;
  }, [browser, profile]);

  // Returning from Settings resumes only the login the user explicitly started.
  // Consume the intent before requesting so focus + visibility events cannot duplicate it.
  useEffect(() => {
    const resume = () => {
      if (!alive.current || busy || !permissionReturn.current || document.visibilityState === "hidden") return;
      permissionReturn.current = false;
      void login(true);
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  });

  const canLogin = !busy && !loading && (reuse ? !!selected : !!headers.trim());

  return <div className="kd-account-login-panel" role="group" aria-label={`${account.label} · ${METHODS[method].label}`} {...motion("fade")}
    onKeyDown={event => event.stopPropagation()}>
    {reuse && <div className="kd-account-login-controls">
      {!!catalog?.browsers.length && <Select aria-label={`${account.label} 浏览器`} value={browser}
        disabled={busy || loading} onChange={event => { setBrowser(event.currentTarget.value); setProfile(""); setNotice(""); }}>
        {catalog.browsers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </Select>}
      {profiles.length > 1 && <Select aria-label={`${account.label} 浏览器配置`}
        value={profiles.find(item => item.id === profile)?.id ?? profiles[0].id} disabled={busy || loading}
        onChange={event => { setProfile(event.currentTarget.value); setNotice(""); }}>
        {profiles.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </Select>}
      <Button size="sm" variant="ghost" iconOnly aria-label="重新检测浏览器" title="重新检测浏览器"
        disabled={busy || loading} onClick={() => void detect()}><RefreshCw size={14} /></Button>
    </div>}
    {!reuse && <textarea className="kd-textarea" rows={6} aria-label={`${account.label} 请求头`}
      autoFocus autoComplete="off" autoCorrect="off" spellCheck={false} value={headers} disabled={busy}
      onChange={event => setHeaders(event.currentTarget.value)} />}
    {notice && <InlineNotice text={notice} className="kd-account-notice" onDismiss={() => setNotice("")} />}
    <div className="kd-account-login-actions">
      <span role="status" className="kd-account-login-status">
        {loading ? "正在查找浏览器" : busy ? inWindow ? "请在打开的浏览器窗口登录" : reuse ? "正在读取浏览器登录" : "正在登录"
          : permissionRequired ? "需要完全磁盘访问权限" : ""}
      </span>
      {busy && reuse && <Button size="sm" variant="ghost" onClick={() => {
        void cancel().catch(error => { if (alive.current) setNotice(`取消失败：${error instanceof Error ? error.message : String(error)}`); });
      }}>取消</Button>}
      {permissionRequired && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void openPermissionSettings()}>开启权限</Button>}
      <Button size="sm" variant="ghost" disabled={!canLogin} onClick={() => void login()}>
        {busy && <LoaderCircle size={13} className="kd-spin" />}{busy ? "正在登录" : "登录"}
      </Button>
    </div>
  </div>;
}

function CookieEditorPanel({ account, sourceEnabled, onBusy, onDone }: {
  account: Account; sourceEnabled: boolean; onBusy(value: boolean): void; onDone(): void;
}) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const working = useRef(false);
  const setAccount = useAppStore(state => state.setAccount);
  const locked = busy || reading;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; onBusy(false); };
  }, []);

  const install = async () => {
    setNotice("");
    try {
      const open = getBridge().openExternal;
      if (!open) throw new Error("当前环境无法打开浏览器");
      await open("https://cookie-editor.com/#download");
    } catch { if (alive.current) setNotice("无法打开安装页面"); }
  };

  const importCookies = async (clipboard = false) => {
    if (working.current) return;
    if (account.login_method !== "qr" && !sourceEnabled) {
      setNotice(`请先开启 ${account.label} 下载源`); return;
    }
    working.current = true;
    setBusy(true); onBusy(true); setNotice("");
    try {
      let raw = content;
      if (clipboard) {
        try { raw = await navigator.clipboard.readText(); }
        catch { throw new Error("无法读取剪贴板，请直接粘贴到输入框后导入"); }
      }
      if (!alive.current) return;
      const headers = cookieEditorHeaders(raw, account.platform);
      const result = await api.cookieEditorLogin(account.platform, headers);
      if (alive.current) { setContent(""); setAccount(result); onDone(); }
    } catch (error) {
      if (alive.current) setNotice(error instanceof Error ? error.message : "导入失败");
    } finally {
      working.current = false;
      if (alive.current) { setBusy(false); onBusy(false); }
    }
  };

  const readFile = async (file: File) => {
    if (working.current) return;
    setNotice(""); setContent("");
    if (file.size > MAX_COOKIE_IMPORT_BYTES) { setNotice("Cookie 文件过大，请只导出当前站点"); return; }
    working.current = true; setReading(true); onBusy(true);
    try { const text = await file.text(); if (alive.current) setContent(text); }
    catch { if (alive.current) setNotice("无法读取 Cookie 文件"); }
    finally {
      working.current = false;
      if (alive.current) { setReading(false); onBusy(false); }
    }
  };

  return <div className="kd-account-login-panel" role="group" aria-label={`${account.label} · Cookie-Editor`}
    {...motion("fade")} onKeyDown={event => event.stopPropagation()}>
    <div className="kd-account-login-controls">
      <Button size="sm" variant="ghost" disabled={locked} onClick={() => void install()}>安装 Cookie-Editor</Button>
      <input ref={fileInput} type="file" accept=".json,.txt,application/json,text/plain" hidden disabled={locked}
        onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
          if (file) void readFile(file);
        }} />
      <Button size="sm" variant="ghost" disabled={locked} onClick={() => fileInput.current?.click()}>选择文件</Button>
    </div>
    <p className="kd-account-cookie-guide">
      在已登录的{account.label}站点打开 Cookie-Editor，选择导出 → JSON，回到这里粘贴并导入。Cookie 等同登录凭证，请勿分享。
    </p>
    <textarea className="kd-textarea" rows={6} aria-label={`${account.label} Cookie-Editor 导出内容`}
      autoFocus autoComplete="off" autoCorrect="off" spellCheck={false} value={content} disabled={locked}
      onChange={event => setContent(event.currentTarget.value)} />
    {notice && <InlineNotice text={notice} className="kd-account-notice" onDismiss={() => setNotice("")} />}
    <div className="kd-account-login-actions">
      <span role="status" className="kd-account-login-status">{reading ? "正在读取文件" : busy ? "正在验证登录" : ""}</span>
      <Button size="sm" variant="ghost" disabled={locked} onClick={() => void importCookies(true)}>粘贴并导入</Button>
      <Button size="sm" variant="ghost" disabled={locked || !content.trim()} onClick={() => void importCookies()}>
        {busy && <LoaderCircle size={13} className="kd-spin" />}导入
      </Button>
    </div>
  </div>;
}
