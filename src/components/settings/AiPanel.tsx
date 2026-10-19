import { useEffect, useState } from "react";
import { Copy, Download, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { aiApi } from "../../lib/api";
import { getBridge } from "../../lib/bridge";
import { copyText } from "../../lib/copyText";
import { useAiStore } from "../../stores/aiStore";
import type { AiGlobalLogin, AiModel, AiStatus, AiWebMode } from "../../types/ai";
import { Button, InlineNotice, Panel } from "../common";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import "./AiPanel.css";

/** pi's npm package; its installers and `pi update` keep the same one. */
const INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent";
const UPDATE_COMMAND = "pi update";
const HOME_PAGE = "https://pi.dev";
const ACCESS_PAGE = "https://pi.dev/packages/pi-web-access";

const WEB_MODES: readonly { value: AiWebMode; label: string }[] = [
  { value: "access", label: "pi-web-access" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "deepseek-jina", label: "DeepSeek + Jina" },
  { value: "jina", label: "Jina" },
];

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function open(url: string, fail: (text: string) => void) {
  const openExternal = getBridge().openExternal;
  if (!openExternal) { fail("当前窗口无法打开链接"); return; }
  void openExternal(url).catch(cause => fail(message(cause)));
}

/** pi itself: found or not, its version, and the one command to install or update it. */
function PiRow({ status, onError }: { status: AiStatus | null; onError(text: string): void }) {
  const refresh = useAiStore(state => state.refresh);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const pi = status?.pi;
  const command = pi?.state === "missing" ? INSTALL_COMMAND : pi?.latest ? UPDATE_COMMAND : "";
  const state = !pi ? "" : pi.state === "ready" ? `pi ${pi.version ?? ""}`.trim() : pi.state === "missing" ? "未安装 pi" : "pi 无法运行";
  return <div className="kd-djp-group">
    <span className="kd-djp-label">pi</span>
    <div className="kd-ai-row">
      <span className="kd-ai-row-copy">
        <strong>{state}</strong>
        {pi?.latest && <small>{pi.latest} 可更新</small>}
        {pi?.error && <small title={pi.error}>{pi.error}</small>}
      </span>
      <span className="kd-ai-row-keys">
        <Button variant="ghost" size="sm" onClick={() => open(HOME_PAGE, onError)}><ExternalLink size={12} aria-hidden="true" />pi.dev</Button>
        <Button variant="ghost" size="sm" disabled={checking} onClick={() => {
          setChecking(true);
          void refresh(true).finally(() => setChecking(false));
        }}><RefreshCw size={12} aria-hidden="true" />{checking ? "检测中…" : "重新检测"}</Button>
      </span>
    </div>
    {command && <div className="kd-ai-command">
      <code>{command}</code>
      <Button variant="ghost" size="sm" onClick={() => {
        setCopied(false);
        void copyText(command).then(() => setCopied(true)).catch(cause => onError(message(cause)));
      }}><Copy size={12} aria-hidden="true" />{copied ? "已复制" : "复制"}</Button>
    </div>}
  </div>;
}

/** The logins KDJ's pi has, the one in use in full ink with its model, and the ways to add one. */
function LoginsGroup({ status, onError }: { status: AiStatus; onError(text: string): void }) {
  const setStatus = useAiStore(state => state.setStatus);
  const [busy, setBusy] = useState("");
  const [models, setModels] = useState<AiModel[]>([]);
  const [adding, setAdding] = useState("");
  const [key, setKey] = useState("");
  const [global, setGlobal] = useState<AiGlobalLogin[]>([]);
  const logins = status.providers.filter(provider => provider.configured);
  const unset = status.providers.filter(provider => !provider.configured);
  const current = status.provider && logins.some(login => login.id === status.provider) ? status.provider : null;
  const ready = status.pi.state === "ready";

  useEffect(() => {
    let live = true;
    aiApi.globalLogins().then(result => { if (live) setGlobal(result.logins); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  useEffect(() => {
    setModels([]);
    if (!ready || !current) return;
    let live = true;
    aiApi.models(current).then(result => { if (live) setModels(result.models); }).catch(() => undefined);
    return () => { live = false; };
  }, [ready, current]);
  useEffect(() => { if (!adding && unset[0]) setAdding(unset[0].id); }, [adding, unset]);

  const run = async (id: string, work: () => Promise<AiStatus>) => {
    setBusy(id);
    try {
      setStatus(await work());
    } catch (cause) {
      onError(message(cause));
    } finally {
      setBusy("");
    }
  };
  const importable = global.filter(login => login.importable && !logins.some(item => item.id === login.id) && login.id !== "jina");

  return <div className="kd-djp-group">
    <span className="kd-djp-label">模型</span>
    {logins.length > 0 && <div className="kd-ai-logins" role="radiogroup" aria-label="使用的服务商">
      {logins.map(login => {
        const on = login.id === current;
        return <div key={login.id} className="kd-ai-row kd-ai-login" data-on={on || undefined}>
          <button type="button" className="kd-ai-login-name" role="radio" aria-checked={on} disabled={!!busy}
            onClick={() => { if (!on) void run(login.id, () => aiApi.saveProvider({ provider: login.id })); }}>
            {login.label}
          </button>
          {busy === login.id && <LoaderCircle size={12} className="kd-spin" aria-hidden="true" />}
          {on && <Select className="kd-select kd-ai-model" value={status.model ?? ""} disabled={!!busy} aria-label={`${login.label} 的模型`}
            onChange={event => void run(login.id, () => aiApi.saveProvider({ provider: login.id, model: event.target.value || null }))}>
            <option value="">默认</option>
            {models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
          </Select>}
        </div>;
      })}
    </div>}
    {unset.length > 0 && <form className="kd-ai-row kd-ai-add" onSubmit={event => {
      event.preventDefault();
      const value = key.trim();
      if (!value || !adding) return;
      void run(adding, () => aiApi.saveProvider({ provider: adding, key: value })).then(() => { setKey(""); setAdding(""); });
    }}>
      <Select className="kd-select" value={adding} aria-label="服务商" onChange={event => setAdding(event.target.value)}>
        {unset.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
      </Select>
      <input className="kd-input" type="password" autoComplete="off" spellCheck={false} value={key} aria-label="API Key"
        onChange={event => setKey(event.target.value)} />
      <Button variant="ghost" size="sm" type="submit" disabled={!!busy || !key.trim()}>添加</Button>
    </form>}
    {importable.length > 0 && <div className="kd-ai-row kd-ai-import">
      <span className="kd-ai-row-hint">从 pi 导入</span>
      {importable.map(login => <Button key={login.id} variant="ghost" size="sm" disabled={!!busy}
        onClick={() => void run(login.id, () => aiApi.importLogin(login.id))}>
        {busy === login.id ? <LoaderCircle size={12} className="kd-spin" aria-hidden="true" /> : null}{login.label}
      </Button>)}
    </div>}
  </div>;
}

/** How the AI searches the web, and what that way still needs. */
function WebGroup({ status, onError }: { status: AiStatus; onError(text: string): void }) {
  const setStatus = useAiStore(state => state.setStatus);
  const [jinaKey, setJinaKey] = useState("");
  const [saving, setSaving] = useState(false);
  const { web } = status;
  const deepseek = status.providers.some(provider => provider.id === "deepseek" && provider.configured);
  const save = async (body: Parameters<typeof aiApi.setWeb>[0]) => {
    setSaving(true);
    try {
      setStatus(await aiApi.setWeb(body));
    } catch (cause) {
      onError(message(cause));
    } finally {
      setSaving(false);
    }
  };
  const install = async () => {
    try {
      setStatus(await aiApi.installAccess());
    } catch (cause) {
      onError(message(cause));
    }
  };
  const needsDeepseek = (web.mode === "deepseek" || web.mode === "deepseek-jina") && !deepseek;
  return <div className="kd-djp-group">
    <span className="kd-djp-label">网页搜索</span>
    <Segmented label="网页搜索方式" options={WEB_MODES} value={web.mode} disabled={saving}
      onChange={mode => void save({ mode })} />
    {web.mode === "access" && <div className="kd-ai-row">
      <span className="kd-ai-row-copy">
        <strong>{web.access ? "pi-web-access 已安装" : web.installing ? "正在安装 pi-web-access…" : "未安装 pi-web-access"}</strong>
        {web.error && <small title={web.error}>{web.error}</small>}
      </span>
      <span className="kd-ai-row-keys">
        <Button variant="ghost" size="sm" onClick={() => open(ACCESS_PAGE, onError)}><ExternalLink size={12} aria-hidden="true" />介绍</Button>
        {!web.access && <Button variant="ghost" size="sm" disabled={web.installing || status.pi.state !== "ready"} onClick={() => void install()}>
          {web.installing ? <LoaderCircle size={12} className="kd-spin" aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}安装
        </Button>}
      </span>
    </div>}
    {needsDeepseek && <div className="kd-ai-row"><span className="kd-ai-row-copy"><strong>需要先登录 DeepSeek</strong></span></div>}
    {web.mode === "jina" && <form className="kd-ai-row kd-ai-add" onSubmit={event => {
      event.preventDefault();
      if (jinaKey.trim()) void save({ jina_key: jinaKey.trim() }).then(() => setJinaKey(""));
    }}>
      <span className="kd-ai-row-hint">{web.jina ? "Jina Key 已保存" : "Jina Key"}</span>
      <input className="kd-input" type="password" autoComplete="off" spellCheck={false} value={jinaKey} aria-label="Jina API Key"
        onChange={event => setJinaKey(event.target.value)} />
      <Button variant="ghost" size="sm" type="submit" disabled={saving || !jinaKey.trim()}>{web.jina ? "替换" : "保存"}</Button>
    </form>}
  </div>;
}

/**
 * 设置 → AI (docs/ai-dock.md): pi, the logins of KDJ's own pi directory (never the global
 * ~/.pi; a key it already has can be brought over), and how the AI searches the web.
 */
export function AiPanel() {
  const status = useAiStore(state => state.status);
  const statusError = useAiStore(state => state.statusError);
  const refresh = useAiStore(state => state.refresh);
  const [error, setError] = useState("");
  useEffect(() => { void refresh(); }, [refresh]);
  return <Panel heading="AI" dense>
    <div className="kd-djp-groups kd-ai-panel" data-drawer-pending={!status && !statusError ? "" : undefined}>
      <PiRow status={status} onError={setError} />
      {status && <LoginsGroup status={status} onError={setError} />}
      {status && <WebGroup status={status} onError={setError} />}
      <InlineNotice text={error || statusError} block onDismiss={error ? () => setError("") : undefined} />
    </div>
  </Panel>;
}
