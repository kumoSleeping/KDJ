import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ClipboardPaste, Cookie, Globe2, LoaderCircle, QrCode, RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import { getBridge } from "../../lib/bridge";
import { exportedLoginHeaders, LOGIN_SITES } from "../../lib/cookieEditorImport";
import { motion } from "../../lib/motion";
import { useAppStore } from "../../stores/appStore";
import type { Account, BrowserCatalog, Platform, QrStateValue, QrVariant } from "../../types";
import { Button, InlineNotice } from "../common";
import { PointerDemo } from "../common/PointerDemo";
import { Select } from "../common/Select";
import { SlidePages } from "../drawer/SlidePages";
import "./AccountLogin.css";

type Method = "qr" | "cookies" | "browser" | "headers";

const METHODS: Record<Method, { label: string; icon: typeof Globe2 }> = {
  qr: { label: "扫码", icon: QrCode },
  cookies: { label: "从 Cookie-Editor 导入", icon: Cookie },
  browser: { label: "从浏览器导入", icon: Globe2 },
  headers: { label: "请求头", icon: ClipboardPaste },
};

/**
 * Each account's way that stays signed in longest is 推荐: the code to scan, which KDJ renews itself,
 * or for the sites without one the browser's own login, which KDJ reads again when its copy ends.
 * A copy handed over by hand (Cookie-Editor, request headers) ends soon on QQ (no key to renew it)
 * and YouTube (the browser keeps replacing the session); the way says so.
 */
const RECOMMENDED: Partial<Record<Platform, Method>> = {
  wyy: "qr", qqm: "qr", bilibili: "qr", ytm: "browser", youtube: "browser", soundcloud: "browser",
};
const DROPS_SOON = new Set<Platform>(["qqm", "ytm", "youtube"]);

function methodLabel(method: Method, platform: Platform): string {
  const notes: string[] = [];
  if (RECOMMENDED[platform] === method) notes.push("推荐");
  if (method === "browser") notes.push("部分支持");
  if ((method === "cookies" || method === "headers") && DROPS_SOON.has(platform)) notes.push("容易掉线");
  const label = method === "browser" ? "从浏览器导入" : METHODS[method].label;
  return notes.length ? `${label}（${notes.join("，")}）` : label;
}

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
const WAYS = "ways";

/** The ways one account can be logged in on a desktop, in the order they are offered. */
export function loginMethods(account: Account): Method[] {
  const mobile = ["android", "ios"].includes(window.kdj?.platform ?? "");
  if (mobile) return account.login_method === "qr" ? ["qr", "headers"] : ["headers"];
  return account.login_method === "qr" ? ["qr", "cookies", "browser", "headers"] : ["cookies", "browser", "headers"];
}

/**
 * Logging in to one account, in place under its row. The block shows one thing at a time: the ways
 * the account has, or the page of the way that was chosen, which takes the whole block; its head is
 * the way's name and the key back to the ways. The two change places sideways (SlidePages). Nothing
 * is open, fetched or looked for until a way is chosen. There is no window and no mask over the
 * settings; a code to scan comes up here as well.
 */
export function AccountLogin({ account, sourceEnabled, onDone }: {
  account: Account; sourceEnabled: boolean; onDone(): void;
}) {
  const methods = loginMethods(account);
  const [method, setMethod] = useState<Method | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const busy = panelBusy;
  const panel = { account, sourceEnabled, onBusy: setPanelBusy, onDone };
  return <SlidePages className="kd-account-login" page={method ?? WAYS} order={[WAYS, ...methods]}>
    {!method ? <ul className="kd-account-login-methods" aria-label={`${account.label} 登录方式`}>
      {methods.map(id => {
        const Icon = METHODS[id].icon;
        return <li key={id}>
          <button type="button" onClick={() => setMethod(id)}>
            <Icon size={14} aria-hidden="true" />
            <span>{methodLabel(id, account.platform)}</span>
          </button>
        </li>;
      })}
    </ul> : <div className="kd-account-login-way" role="group" aria-label={`${account.label} · ${methodLabel(method, account.platform)}`}
      onKeyDown={event => event.stopPropagation()}>
      <button type="button" className="kd-account-login-back" disabled={busy} title="返回登录方式"
        onClick={() => setMethod(null)}>
        <ChevronLeft size={14} aria-hidden="true" />
        <span>{methodLabel(method, account.platform)}</span>
      </button>
      {method === "qr" && <QrPanel account={account} onDone={onDone} />}
      {method === "cookies" && <CookieEditorPanel {...panel} />}
      {method === "browser" && <BrowserPanel {...panel} />}
      {method === "headers" && <HeadersPanel {...panel} />}
    </div>}
  </SlidePages>;
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
  return <div className="kd-account-login-panel">
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

/** The browsers of this computer for one platform, and the one that is chosen: the one used last here, else the one used most recently. */
function useBrowsers(platform: Platform, onError: (message: string) => void) {
  const [catalog, setCatalog] = useState<BrowserCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [browser, setBrowser] = useState("");
  const alive = useRef(true);
  const detection = useRef(0);
  const detect = async () => {
    const generation = ++detection.current;
    setLoading(true);
    onError("");
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
      if (alive.current && generation === detection.current) onError(`检测浏览器失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (alive.current && generation === detection.current) setLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void detect();
    return () => { alive.current = false; detection.current++; };
  }, []);
  const remember = () => {
    try { localStorage.setItem(`kdj.login.browser.${platform}`, browser); } catch { /* login remains valid */ }
  };
  return { catalog, loading, browser, setBrowser, selected: catalog?.browsers.find(item => item.id === browser), detect, remember };
}

/** 从浏览器导入: the login the chosen browser already has is read from it. Not every browser can be read. */
function BrowserPanel({ account, sourceEnabled, onBusy, onDone }: {
  account: Account; sourceEnabled: boolean; onBusy(busy: boolean): void; onDone(): void;
}) {
  const platform = account.platform;
  const setAccount = useAppStore(state => state.setAccount);
  const [busy, setBusyState] = useState(false);
  const [profile, setProfile] = useState("");
  const [notice, setNotice] = useState("");
  const [permissionRequired, setPermissionRequired] = useState(false);
  const { catalog, loading, browser, setBrowser, selected, detect, remember } = useBrowsers(platform, setNotice);
  const permissionReturn = useRef(false);
  const alive = useRef(true);
  const attempt = useRef<string | null>(null);
  const cancelled = useRef(false);
  const profiles = selected?.reuse ? selected.profiles : [];

  // The parent keeps the way back still while a login is under way.
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
    return () => { unload(); window.removeEventListener("pagehide", unload); alive.current = false; onBusy(false); };
  }, []);

  const login = async (afterPermissionSettings = false) => {
    permissionReturn.current = false;
    if (!selected) return;
    // SoundCloud and YouTube refuse a login while their source is switched off.
    if (account.login_method !== "qr" && !sourceEnabled) { setNotice(`请先开启 ${account.label} 下载源`); return; }
    // What cannot be read is not asked for: the other way is named instead.
    if (!selected.reuse) { setNotice(`${selected.label} 的登录在这台电脑上读不了，请改用「${METHODS.cookies.label}」`); return; }
    cancelled.current = false;
    setBusy(true);
    setNotice("");
    setPermissionRequired(false);
    const id = crypto.randomUUID();
    attempt.current = id;
    try {
      const result = await api.browserLogin(platform, {
        browser, request_id: id, profile: profiles.find(item => item.id === profile)?.id ?? profiles[0]?.id,
      });
      if (alive.current) { remember(); setBusy(false); setAccount(result); onDone(); }
    } catch (error) {
      if (!alive.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setBusy(false);
      // A login the user stopped is not a failure to report.
      if (cancelled.current) return;
      if (getBridge().platform === "darwin" && message.includes("macOS 拒绝访问 Safari 登录数据")) {
        setPermissionRequired(true);
        if (afterPermissionSettings) setNotice(import.meta.env.DEV
          ? "macOS 仍拒绝访问 Safari 登录数据。当前是开发版；请核对 KDJ Dev 或启动它的应用是否获准，正式版 KDJ 的权限不代表开发版已获准。"
          : "macOS 仍拒绝访问 Safari 登录数据；请核对当前 KDJ 的完全磁盘访问权限，已允许则退出并重新打开 KDJ。");
        return;
      }
      setNotice(`登录失败：${message}`);
    } finally {
      if (attempt.current === id) attempt.current = null;
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

  return <div className="kd-account-login-panel">
    <div className="kd-account-login-controls">
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
    </div>
    {notice && <InlineNotice text={notice} className="kd-account-notice" onDismiss={() => setNotice("")} />}
    <div className="kd-account-login-actions">
      <span role="status" className="kd-account-login-status">
        {loading ? "正在查找浏览器" : busy ? "正在读取" : permissionRequired ? "需要完全磁盘访问权限" : ""}
      </span>
      {busy && <Button size="sm" variant="ghost" onClick={() => {
        void cancel().catch(error => { if (alive.current) setNotice(`取消失败：${error instanceof Error ? error.message : String(error)}`); });
      }}>取消</Button>}
      {permissionRequired && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void openPermissionSettings()}>开启权限</Button>}
      <Button size="sm" variant="ghost" disabled={busy || loading || !selected} onClick={() => void login()}>
        {busy && <LoaderCircle size={13} className="kd-spin" />}登录
      </Button>
    </div>
  </div>;
}

/**
 * 从 Cookie-Editor 导入: the login stays in the browser the user chose and is handed over by the
 * Cookie-Editor extension. Four steps, one thing each, with the key that does it: KDJ opens the
 * extension's install page and then the platform's site in that browser (never in whichever is the
 * default), the user exports there (the little picture shows where: the cookie on the toolbar,
 * Export, JSON), and KDJ takes the export from the clipboard when its window is returned to.
 */
function CookieEditorPanel({ account, sourceEnabled, onBusy, onDone }: {
  account: Account; sourceEnabled: boolean; onBusy(busy: boolean): void; onDone(): void;
}) {
  const platform = account.platform;
  const setAccount = useAppStore(state => state.setAccount);
  const [busy, setBusyState] = useState(false);
  const [notice, setNotice] = useState("");
  const [pasteBox, setPasteBox] = useState(false);
  const { catalog, loading, browser, setBrowser, selected, detect, remember } = useBrowsers(platform, setNotice);
  const alive = useRef(true);
  // The user has gone to the browser from here: on their return the clipboard is looked at.
  const awaited = useRef(false);
  const taking = useRef(false);
  const setBusy = (value: boolean) => { setBusyState(value); onBusy(value); };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; onBusy(false); };
  }, []);

  /** The site, or the extension's page, in the chosen browser. Without one KDJ can start, the system's own. */
  const openInBrowser = async (page: "site" | "extension") => {
    setNotice("");
    try {
      if (selected?.open) await api.browserOpen(platform, selected.id, page);
      else {
        const openExternal = getBridge().openExternal;
        if (!openExternal) throw new Error("当前环境无法打开浏览器");
        await openExternal(page === "site" ? `https://${LOGIN_SITES[platform]}/` : "https://cookie-editor.com/#download");
      }
      awaited.current = true;
    } catch (error) {
      if (alive.current) setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  /** Logs in with an export. What is not one is said only when the user handed it over (`asked`). */
  const takeExport = async (text: string, asked: boolean) => {
    let headers: string;
    try { headers = exportedLoginHeaders(text, platform); }
    catch (error) {
      if (asked) setNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    // SoundCloud and YouTube refuse a login while their source is switched off.
    if (account.login_method !== "qr" && !sourceEnabled) { setNotice(`请先开启 ${account.label} 下载源`); return; }
    awaited.current = false;
    setBusy(true);
    setNotice("");
    try {
      const result = await api.exportedLogin(platform, headers);
      if (alive.current) { remember(); setBusy(false); setAccount(result); onDone(); }
    } catch (error) {
      if (!alive.current) return;
      setBusy(false);
      setNotice(`登录失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const takeClipboard = async (asked: boolean) => {
    if (taking.current) return;
    taking.current = true;
    try {
      let text: string;
      try {
        const read = getBridge().readClipboardText;
        if (!read) throw new Error("no clipboard");
        text = await read();
      } catch {
        // The clipboard cannot be read here: the user pastes into a field instead.
        if (asked && alive.current) setPasteBox(true);
        return;
      }
      if (alive.current) await takeExport(text, asked);
    } finally { taking.current = false; }
  };

  // Coming back to the window goes on with what the user started from here, and only that.
  useEffect(() => {
    const resume = () => {
      if (!alive.current || busy || !awaited.current || document.visibilityState === "hidden") return;
      void takeClipboard(false);
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  });

  const where = selected?.label ?? "浏览器";
  return <div className="kd-account-login-panel">
    <div className="kd-account-login-controls">
      {!!catalog?.browsers.length && <Select aria-label={`${account.label} 浏览器`} value={browser}
        disabled={busy || loading} onChange={event => { setBrowser(event.currentTarget.value); setNotice(""); }}>
        {catalog.browsers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </Select>}
      <Button size="sm" variant="ghost" iconOnly aria-label="重新检测浏览器" title="重新检测浏览器"
        disabled={busy || loading} onClick={() => void detect()}><RefreshCw size={14} /></Button>
    </div>
    <ol className="kd-account-login-steps">
      {/* The browser is named once, in the choice above: a key is one word, and the line is the step's. */}
      <li>
        <span className="kd-truncate">安装 Cookie-Editor 扩展</span>
        <Button size="sm" variant="ghost" disabled={busy} title={`在 ${where} 打开安装页`}
          onClick={() => void openInBrowser("extension")}>安装</Button>
      </li>
      <li>
        <span className="kd-truncate" title={`登录 ${account.label}`}>登录 {account.label}</span>
        <Button size="sm" variant="ghost" disabled={busy} title={`在 ${where} 打开 ${account.label}`}
          onClick={() => void openInBrowser("site")}>打开</Button>
      </li>
      <li>
        <span className="kd-truncate">点小饼干 → Export → JSON</span>
        <PointerDemo scene="cookie-export" label="在浏览器的工具栏上点 Cookie-Editor 的小饼干，点 Export，再选 JSON，登录就复制好了" />
      </li>
      <li>
        <span className="kd-truncate">回到 KDJ，自动登录</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void takeClipboard(true)}>粘贴</Button>
      </li>
    </ol>
    {/* What is pasted is taken, never shown: it is a login. */}
    {pasteBox && <textarea className="kd-textarea" rows={2} aria-label={`${account.label} 导出的登录`}
      placeholder="在这里粘贴" autoFocus autoComplete="off" autoCorrect="off" spellCheck={false} value="" disabled={busy}
      onChange={() => {}} onPaste={event => {
        event.preventDefault();
        void takeExport(event.clipboardData.getData("text"), true);
      }} />}
    {notice && <InlineNotice text={notice} className="kd-account-notice" onDismiss={() => setNotice("")} />}
    {(busy || loading) && <div className="kd-account-login-actions">
      <span role="status" className="kd-account-login-status">{loading ? "正在查找浏览器" : "正在登录"}</span>
    </div>}
  </div>;
}

/** 请求头: the request headers copied out of a browser's developer tools, for when nothing else works. */
function HeadersPanel({ account, sourceEnabled, onBusy, onDone }: {
  account: Account; sourceEnabled: boolean; onBusy(busy: boolean): void; onDone(): void;
}) {
  const platform = account.platform;
  const setAccount = useAppStore(state => state.setAccount);
  const [headers, setHeaders] = useState("");
  const [busy, setBusyState] = useState(false);
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const setBusy = (value: boolean) => { setBusyState(value); onBusy(value); };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; onBusy(false); };
  }, []);

  const login = async () => {
    // SoundCloud and YouTube refuse a login while their source is switched off.
    if (account.login_method !== "qr" && !sourceEnabled) { setNotice(`请先开启 ${account.label} 下载源`); return; }
    setBusy(true);
    setNotice("");
    try {
      const result = await api.headersLogin(platform, headers);
      if (alive.current) { setHeaders(""); setBusy(false); setAccount(result); onDone(); }
    } catch (error) {
      if (!alive.current) return;
      setBusy(false);
      setNotice(`登录失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return <div className="kd-account-login-panel">
    <textarea className="kd-textarea" rows={6} aria-label={`${account.label} 请求头`}
      autoFocus autoComplete="off" autoCorrect="off" spellCheck={false} value={headers} disabled={busy}
      onChange={event => setHeaders(event.currentTarget.value)} />
    {notice && <InlineNotice text={notice} className="kd-account-notice" onDismiss={() => setNotice("")} />}
    <div className="kd-account-login-actions">
      <span role="status" className="kd-account-login-status">{busy ? "正在登录" : ""}</span>
      <Button size="sm" variant="ghost" disabled={busy || !headers.trim()} onClick={() => void login()}>
        {busy && <LoaderCircle size={13} className="kd-spin" />}登录
      </Button>
    </div>
  </div>;
}
