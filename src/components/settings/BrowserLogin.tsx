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
interface WindowResult { status: "done" | "error" | "cancelled"; message: string }

const METHODS = [
  { id: "direct", label: "直接读取", icon: KeyRound },
  { id: "authorize", label: "浏览器授权", icon: Globe2 },
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
  const [method, setMethod] = useState<Method | null>(null);
  // A login that is under way is not walked away from by choosing another way.
  const [busy, setBusy] = useState(false);
  const mac = getBridge().platform === "darwin";
  const label = (id: Method) => id === "direct" && mac ? "钥匙串读取" : METHODS.find(m => m.id === id)!.label;
  return <>
    <ul className="kd-account-login-methods" aria-label={`${account.label} 登录方式`}>
      {METHODS.map(({ id, icon: Icon }) => <li key={id}>
        <button type="button" data-active={method === id || undefined} aria-expanded={method === id}
          disabled={busy && method !== id} onClick={() => { if (!busy) setMethod(current => current === id ? null : id); }}>
          <Icon size={14} aria-hidden="true" />
          <span>{label(id)}</span>
        </button>
      </li>)}
    </ul>
    {method && <LoginPanel key={method} account={account} method={method} label={label(method)}
      sourceEnabled={sourceEnabled} onBusy={setBusy} onClose={() => setMethod(null)} onDone={onDone} />}
  </>;
}

function LoginPanel({ account, method, label, sourceEnabled, onBusy, onClose, onDone }: {
  account: Account; method: Method; label: string; sourceEnabled: boolean;
  onBusy(busy: boolean): void; onClose(): void; onDone(): void;
}) {
  const platform = account.platform as LoginPlatform;
  const setAccount = useAppStore(state => state.setAccount);
  const refreshAccounts = useAppStore(state => state.refreshAccounts);
  const [catalog, setCatalog] = useState<BrowserCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusyState] = useState(false);
  const [browser, setBrowser] = useState("");
  const [profile, setProfile] = useState("");
  const [headers, setHeaders] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const detection = useRef(0);
  const listener = useRef<UnlistenFn | null>(null);
  const bridge = getBridge();
  const openWindow = platform === "soundcloud" ? bridge.openSoundcloudWebLogin
    : platform === "ytm" ? bridge.openYtmWebLogin : bridge.openYoutubeWebLogin;
  const authorized = method === "authorize";
  const browserMethod = method === "direct" || authorized;
  const systemAutomation = catalog?.authorization_browsers?.find(item => item.id === browser)?.method === "system_automation";

  // The parent keeps the other choices still while a login is under way.
  const setBusy = (value: boolean) => { setBusyState(value); onBusy(value); };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; detection.current++; listener.current?.(); listener.current = null; onBusy(false); };
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
        setBrowser(previous => result.authorization_browsers?.some(item => item.id === previous)
          ? previous : result.authorization_browsers?.[0]?.id ?? "");
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

  const login = async () => {
    if (!sourceEnabled) { setNotice(`请先开启 ${account.label} 下载源`); return; }
    setBusy(true);
    setNotice("");
    try {
      if (method === "webview") {
        if (!openWindow) throw new Error("当前系统没有可用的登录窗口");
        listener.current = await listen<WindowResult>(`${platform === "soundcloud" ? "soundcloud" : platform}-web-login://result`, event => {
          if (!alive.current) return;
          listener.current?.(); listener.current = null;
          setBusy(false);
          if (event.payload.status === "done") { void refreshAccounts(); onDone(); }
          else if (event.payload.status !== "cancelled") setNotice(event.payload.message || "登录未完成");
        });
        if (!alive.current) { listener.current?.(); listener.current = null; return; }
        await openWindow();
        return;
      }
      let result: Account;
      if (method === "authorize") {
        result = await (platform === "soundcloud" ? api.soundcloudBrowserAuthorize(browser)
          : platform === "ytm" ? api.ytmBrowserAuthorize(browser) : api.youtubeBrowserAuthorize(browser));
      } else if (method === "direct") {
        result = await (platform === "soundcloud" ? api.soundcloudBrowserLogin(browser, profile)
          : platform === "ytm" ? api.ytmBrowserLogin(browser, profile) : api.youtubeBrowserLogin(browser, profile));
      } else {
        result = await (platform === "soundcloud" ? api.soundcloudHeadersLogin(headers)
          : platform === "ytm" ? api.ytmHeadersLogin(headers) : api.youtubeHeadersLogin(headers));
      }
      if (alive.current) { setHeaders(""); setBusy(false); setAccount(result); onDone(); }
    } catch (error) {
      if (alive.current) {
        listener.current?.(); listener.current = null;
        setNotice(`登录失败：${error instanceof Error ? error.message : String(error)}`);
        setBusy(false);
      }
    }
  };

  const choices = authorized ? catalog?.authorization_browsers ?? [] : catalog?.browsers.flatMap(b => b.profiles) ?? [];
  const canLogin = !busy && !loading && (method === "headers" ? !!headers.trim()
    : method === "webview" ? !!openWindow : !!browser && (authorized || !!profile));

  return <div className="kd-account-login-panel" role="group" aria-label={`${account.label} · ${label}`} {...motion("fade")}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose();
    }}>
    {browserMethod && <div className="kd-account-login-controls">
      {!!choices.length && (authorized ? <Select aria-label={`${account.label} 授权浏览器`} value={browser}
        disabled={busy || loading} onChange={event => { setBrowser(event.currentTarget.value); setNotice(""); }}>
        {catalog?.authorization_browsers?.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </Select> : <Select aria-label={`${account.label} 浏览器账号`} value={JSON.stringify([browser, profile])}
        disabled={busy || loading} onChange={event => {
          const [b, p] = JSON.parse(event.currentTarget.value) as [string, string];
          setBrowser(b); setProfile(p); setNotice("");
        }}>
        {catalog?.browsers.flatMap(b => b.profiles.map(p => <option key={JSON.stringify([b.id, p.id])}
          value={JSON.stringify([b.id, p.id])}>{b.label} · {p.label}</option>))}
      </Select>)}
      <Button size="sm" variant="ghost" iconOnly aria-label="重新检测浏览器" title="重新检测浏览器"
        disabled={busy || loading} onClick={() => void detect()}><RefreshCw size={14} /></Button>
    </div>}
    {method === "headers" && <textarea className="kd-textarea" rows={6} aria-label={`${account.label} 请求头`}
      autoFocus autoComplete="off" autoCorrect="off" spellCheck={false} value={headers} disabled={busy}
      onChange={event => setHeaders(event.currentTarget.value)} />}
    {notice && <InlineNotice text={notice} className="kd-account-notice" onDismiss={() => setNotice("")} />}
    <div className="kd-account-login-actions">
      <span role="status" className="kd-account-login-status">
        {loading ? "正在查找浏览器" : busy ? authorized
          ? systemAutomation ? "正在读取浏览器登录" : "请在浏览器中允许本次授权" : "正在登录" : ""}
      </span>
      <Button size="sm" variant="ghost" disabled={!canLogin} onClick={() => void login()}>
        {busy && <LoaderCircle size={13} className="kd-spin" />}{busy ? "正在登录" : "登录"}
      </Button>
    </div>
  </div>;
}
