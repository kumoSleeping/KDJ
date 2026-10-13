import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ClipboardPaste, Globe2, KeyRound, LoaderCircle, LogIn, RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import { getBridge } from "../../lib/bridge";
import { motion } from "../../lib/motion";
import { useAppStore } from "../../stores/appStore";
import type { Account, BrowserCatalog } from "../../types";
import { Button, InlineNotice } from "../common";
import { Select } from "../common/Select";
import "./BrowserLogin.css";

type Method = "direct" | "authorize" | "headers" | "webview";
type LoginPlatform = "soundcloud" | "ytm" | "youtube";
interface WindowResult { status: "done" | "error" | "cancelled" | "browser_required"; message: string }

const METHODS = [
  { id: "authorize", label: "浏览器授权", icon: Globe2 },
  { id: "direct", label: "直接读取", icon: KeyRound },
  { id: "headers", label: "导入请求头", icon: ClipboardPaste },
  { id: "webview", label: "登录窗口", icon: LogIn },
] as const;

/**
 * All browser-account providers share the same four choices; only the selected flow mounts. The
 * flow opens in place, under the choices, in the account's own row: the selected choice is the
 * one written in full-strength text, and choosing it again puts the flow away. There is no
 * window and no mask over the settings.
 */
export function BrowserLogin({ account, sourceEnabled, onDone }: {
  account: Account; sourceEnabled: boolean; onDone(): void;
}) {
  const [method, setMethod] = useState<Method | null>("authorize");
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
          setMethod("authorize");
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
  const label = (id: Method) => METHODS.find(m => m.id === id)!.label;
  return <>
    <ul className="kd-account-login-methods" aria-label={`${account.label} 登录方式`}>
      {METHODS.map(({ id, icon: Icon }) => <li key={id}>
        <button type="button" data-active={method === id || undefined} aria-expanded={id === "webview" ? undefined : method === id}
          disabled={busy} onClick={() => {
            if (busy) return;
            setWindowNotice("");
            if (id === "webview") void openLoginWindow();
            else setMethod(current => current === id ? null : id);
          }}>
          <Icon size={14} aria-hidden="true" />
          <span>{label(id)}</span>
        </button>
      </li>)}
    </ul>
    {windowNotice && <InlineNotice text={windowNotice} className="kd-account-notice" onDismiss={() => setWindowNotice("")} />}
    {method && method !== "webview" && <LoginPanel key={method} account={account} method={method} label={label(method)}
      sourceEnabled={sourceEnabled} onBusy={setPanelBusy} onClose={() => setMethod(null)} onDone={onDone} />}
  </>;
}

function LoginPanel({ account, method, label, sourceEnabled, onBusy, onClose, onDone }: {
  account: Account; method: Exclude<Method, "webview">; label: string; sourceEnabled: boolean;
  onBusy(busy: boolean): void; onClose(): void; onDone(): void;
}) {
  const platform = account.platform as LoginPlatform;
  const setAccount = useAppStore(state => state.setAccount);
  const [catalog, setCatalog] = useState<BrowserCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusyState] = useState(false);
  const [browser, setBrowser] = useState("");
  const [profile, setProfile] = useState("");
  const [newWindow, setNewWindow] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [headers, setHeaders] = useState("");
  const [notice, setNotice] = useState("");
  const [permissionRequired, setPermissionRequired] = useState(false);
  const permissionReturn = useRef(false);
  const alive = useRef(true);
  const detection = useRef(0);
  const authorization = useRef<string | null>(null);
  const authorized = method === "authorize";
  const browserMethod = method === "direct" || authorized;
  const systemAutomation = catalog?.authorization_browsers?.find(item => item.id === browser)?.method === "system_automation";

  const authorizationOption = catalog?.authorization_browsers?.find(item => item.id === browser);
  const profileConfirmation = authorized && !newWindow && authorizationOption?.method === "profile_confirmation";
  const geckoAutomation = authorized && !newWindow && authorizationOption?.method === "gecko_rdp";
  const authorizationProfiles = authorizationOption?.profiles ?? [];
  const selectedProfile = authorizationProfiles.find(item => item.id === profile) ?? authorizationProfiles[0];

  const isolated = newWindow || catalog?.authorization_browsers?.find(item => item.id === browser)?.method === "isolated_window";

  // The parent keeps the other choices still while a login is under way.
  const setBusy = (value: boolean) => { setBusyState(value); onBusy(value); };
  const cancelAuthorization = async () => {
    const id = authorization.current;
    if (!id) return;
    await api.cancelBrowserLogin(id);
  };
  useEffect(() => {
    alive.current = true;
    const unload = () => { void cancelAuthorization().catch(() => {}); };
    window.addEventListener("pagehide", unload);
    return () => { unload(); window.removeEventListener("pagehide", unload); alive.current = false; detection.current++; onBusy(false); };
  }, []);

  const detect = async () => {
    const generation = ++detection.current;
    setLoading(true);
    setNotice("");
    try {
      const result = await (platform === "soundcloud" ? api.soundcloudBrowserCatalog()
        : platform === "ytm" ? api.ytmBrowserCatalog() : api.youtubeBrowserCatalog());
      if (!alive.current || generation !== detection.current) return;
      setCatalog(result);
      if (authorized) {
        let remembered = "";
        try { remembered = localStorage.getItem(`kdj.login.browser.${platform}`) ?? ""; } catch { /* unavailable storage */ }
        setBrowser(previous => [previous, remembered].find(id => result.authorization_browsers?.some(item => item.id === id))
          ?? result.authorization_browsers?.find(item => ["remote_debugging", "gecko_rdp"].includes(item.method ?? ""))?.id
          ?? result.authorization_browsers?.[0]?.id ?? "");
      } else {
        const choices = result.browsers.flatMap(b => b.profiles.map(p => ({ browser: b.id, profile: p.id })));
        const chosen = choices.find(item => item.browser === browser && item.profile === profile) ?? choices[0];
        setBrowser(chosen?.browser ?? "");
        setProfile(chosen?.profile ?? "");
      }
    } catch (error) {
      if (alive.current && generation === detection.current) setNotice(`检测浏览器失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (alive.current && generation === detection.current) setLoading(false);
    }
  };

  useEffect(() => { if (browserMethod) void detect(); }, []);

  const login = async (afterPermissionSettings = false) => {
    permissionReturn.current = false;
    if (!sourceEnabled) { setNotice(`请先开启 ${account.label} 下载源`); return; }
    if (profileConfirmation && !selectedProfile) {
      setNotice("请先在该浏览器的普通标签页登录，再重新检测浏览器配置");
      return;
    }
    if (geckoAutomation) setSetupOpen(true);
    setBusy(true);
    setNotice("");
    setPermissionRequired(false);
    try {
      let result: Account;
      if (method === "authorize") {
        const id = crypto.randomUUID();
        authorization.current = id;
        try {
          result = await (platform === "soundcloud" ? api.soundcloudBrowserAuthorize(browser, id, profileConfirmation ? selectedProfile?.id : undefined, profileConfirmation, newWindow)
            : platform === "ytm" ? api.ytmBrowserAuthorize(browser, id, profileConfirmation ? selectedProfile?.id : undefined, profileConfirmation, newWindow) : api.youtubeBrowserAuthorize(browser, id, profileConfirmation ? selectedProfile?.id : undefined, profileConfirmation, newWindow));
        } finally { authorization.current = null; }
      } else if (method === "direct") {
        result = await (platform === "soundcloud" ? api.soundcloudBrowserLogin(browser, profile)
          : platform === "ytm" ? api.ytmBrowserLogin(browser, profile) : api.youtubeBrowserLogin(browser, profile));
      } else {
        result = await (platform === "soundcloud" ? api.soundcloudHeadersLogin(headers)
          : platform === "ytm" ? api.ytmHeadersLogin(headers) : api.youtubeHeadersLogin(headers));
      }
      if (authorized) {
        try { localStorage.setItem(`kdj.login.browser.${platform}`, browser); } catch { /* login remains valid */ }
      }
      if (alive.current) { setHeaders(""); setBusy(false); setAccount(result); onDone(); }
    } catch (error) {
      if (alive.current) {
        const message = error instanceof Error ? error.message : String(error);
        if (method === "direct" && getBridge().platform === "darwin"
          && message.includes("macOS 拒绝访问 Safari 登录数据")) {
          setPermissionRequired(true);
          if (afterPermissionSettings) setNotice(import.meta.env.DEV
            ? "macOS 仍拒绝访问 Safari 登录数据。当前是开发版；请核对 KDJ Dev 或启动它的应用是否获准，正式版 KDJ 的权限不代表开发版已获准。"
            : "macOS 仍拒绝访问 Safari 登录数据；请核对当前 KDJ 的完全磁盘访问权限，已允许则退出并重新打开 KDJ。");
          setBusy(false);
          return;
        }
        setNotice(`登录失败：${message}`);
        setBusy(false);
      }
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

  const choices = authorized ? catalog?.authorization_browsers ?? [] : catalog?.browsers.flatMap(b => b.profiles) ?? [];
  const canLogin = !busy && !loading && (method === "headers" ? !!headers.trim()
    : !!browser && (authorized || !!profile));

  return <div className="kd-account-login-panel" role="group" aria-label={`${account.label} · ${label}`} {...motion("fade")}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose();
    }}>
    {browserMethod && <div className="kd-account-login-controls">
      {!!choices.length && (authorized ? <Select aria-label={`${account.label} 授权浏览器`} value={browser}
        disabled={busy || loading} onChange={event => { setBrowser(event.currentTarget.value); setProfile(""); setNotice(""); setSetupOpen(false); setNewWindow(false); }}>
        {catalog?.authorization_browsers?.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </Select> : <Select aria-label={`${account.label} 浏览器账号`} value={JSON.stringify([browser, profile])}
        disabled={busy || loading} onChange={event => {
          const [b, p] = JSON.parse(event.currentTarget.value) as [string, string];
          setBrowser(b); setProfile(p); setNotice("");
        }}>
        {catalog?.browsers.flatMap(b => b.profiles.map(p => <option key={JSON.stringify([b.id, p.id])}
          value={JSON.stringify([b.id, p.id])}>{b.label} · {p.label}</option>))}
      </Select>)}
      {profileConfirmation && authorizationProfiles.length > 1 && <Select aria-label={`${account.label} 浏览器配置`}
        value={selectedProfile?.id ?? ""} disabled={busy || loading}
        onChange={event => { setProfile(event.currentTarget.value); setNotice(""); }}>
        {authorizationProfiles.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </Select>}
      <Button size="sm" variant="ghost" iconOnly aria-label="重新检测浏览器" title="重新检测浏览器"
        disabled={busy || loading} onClick={() => void detect()}><RefreshCw size={14} /></Button>
    </div>}
    {authorized && authorizationOption && <div className="kd-account-login-controls">
      <label><input type="checkbox" checked={newWindow} disabled={busy || loading}
        onChange={event => { setNewWindow(event.currentTarget.checked); setSetupOpen(false); }} />在新窗口登录</label>
      {!isolated && !profileConfirmation && !systemAutomation && <Button size="sm" variant="ghost"
        onClick={() => setSetupOpen(open => !open)}>{setupOpen ? "收起设置" : "授权设置"}</Button>}
    </div>}
    {setupOpen && authorized && !isolated && <fieldset className="kd-account-browser-setup">
      <legend>浏览器授权设置</legend>
      {geckoAutomation ? <>
        <p>在浏览器按 {getBridge().platform === "darwin" ? "⌘ ⌥ I" : "Ctrl + Shift + I"}，再按 F1 打开开发者工具设置。在高级设置中开启“浏览器 chrome 和附加组件调试工具箱”与“远程调试”。</p>
        <p>然后按 {getBridge().platform === "darwin" ? "⌘ ⌥ ⇧ I" : "Ctrl + Alt + Shift + I"} 打开浏览器工具箱，并允许连接。KDJ 会自动继续。</p>
      </> : <p>在 KDJ 打开的浏览器授权页开启远程调试，并允许本次连接。若浏览器没有此选项，可选择“在新窗口登录”。</p>}
    </fieldset>}
    {method === "headers" && <textarea className="kd-textarea" rows={6} aria-label={`${account.label} 请求头`}
      autoFocus autoComplete="off" autoCorrect="off" spellCheck={false} value={headers} disabled={busy}
      onChange={event => setHeaders(event.currentTarget.value)} />}
    {notice && <InlineNotice text={notice} className="kd-account-notice" onDismiss={() => setNotice("")} />}
    <div className="kd-account-login-actions">
      <span role="status" className="kd-account-login-status">
        {loading ? "正在查找浏览器" : busy ? authorized
          ? profileConfirmation ? "正在读取并验证登录状态" : isolated ? "请在新窗口登录，完成后自动返回" : geckoAutomation ? "等待浏览器工具箱授权，完成后自动继续" : systemAutomation ? "正在读取浏览器登录" : "在授权页开启远程调试，再允许本次连接" : "正在登录" : permissionRequired ? "需要完全磁盘访问权限" : ""}
      </span>
      {busy && authorized && <Button size="sm" variant="ghost" onClick={() => {
        void cancelAuthorization().catch(error => { if (alive.current) setNotice(`取消失败：${error instanceof Error ? error.message : String(error)}`); });
      }}>取消</Button>}
      {permissionRequired && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void openPermissionSettings()}>开启权限</Button>}
      <Button size="sm" variant="ghost" disabled={!canLogin} onClick={() => void login()}>
        {busy && <LoaderCircle size={13} className="kd-spin" />}{busy ? "正在登录" : profileConfirmation ? "允许并登录" : "登录"}
      </Button>
    </div>
  </div>;
}
