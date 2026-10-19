import { useEffect, useState } from "react";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { aiApi } from "../../lib/api";
import { getBridge } from "../../lib/bridge";
import { copyText } from "../../lib/copyText";
import { useAiStore } from "../../stores/aiStore";
import type { AiGlobalLogin, AiModel } from "../../types/ai";
import { Button, InlineNotice, Panel } from "../common";
import { Select } from "../common/Select";

/** pi's npm package; its installers and `pi update` keep the same one. */
const INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent";
const UPDATE_COMMAND = "pi update";
const HOME_PAGE = "https://pi.dev";

/**
 * 设置 → 系统 → AI (docs/ai-dock.md): the pi KDJ runs, the provider, its key and the model. The key
 * is written to KDJ's own pi directory (data/ai/pi-agent/auth.json), never to the global ~/.pi; a
 * key the global pi already has can be brought over from there.
 */
export function AiPanel() {
  const status = useAiStore(state => state.status);
  const statusError = useAiStore(state => state.statusError);
  const refresh = useAiStore(state => state.refresh);
  const setStatus = useAiStore(state => state.setStatus);
  const [checking, setChecking] = useState(false);
  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  const [models, setModels] = useState<AiModel[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [global, setGlobal] = useState<AiGlobalLogin[]>([]);
  const [importing, setImporting] = useState("");
  useEffect(() => {
    let live = true;
    aiApi.globalLogins().then(result => { if (live) setGlobal(result.logins); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const bring = async (login: AiGlobalLogin) => {
    setImporting(login.id);
    setError("");
    try {
      setStatus(await aiApi.importLogin(login.id));
      setProvider(login.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting("");
    }
  };

  useEffect(() => {
    setChecking(true);
    void refresh().finally(() => setChecking(false));
  }, [refresh]);
  useEffect(() => {
    if (!provider && status) setProvider(status.provider ?? status.providers[0]?.id ?? "");
  }, [status, provider]);

  const chosen = status?.providers.find(item => item.id === provider);
  const ready = status?.pi.state === "ready";
  useEffect(() => {
    setModels([]);
    if (!ready || !chosen?.configured) return;
    let live = true;
    aiApi.models(provider)
      .then(result => { if (live) setModels(result.models); })
      .catch(cause => { if (live) setError(String(cause instanceof Error ? cause.message : cause)); });
    return () => { live = false; };
  }, [ready, provider, chosen?.configured]);

  const save = async (body: { key?: string; model?: string | null }) => {
    if (!provider || saving) return;
    setSaving(true);
    setError("");
    try {
      setStatus(await aiApi.saveProvider({ provider, ...body }));
      if (body.key) setKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const copy = (text: string) => {
    setCopied("");
    void copyText(text).then(() => setCopied(text)).catch(cause => setError(String(cause)));
  };
  const open = (url: string) => {
    const openExternal = getBridge().openExternal;
    if (!openExternal) { setError("当前窗口无法打开链接"); return; }
    void openExternal(url).catch(cause => setError(String(cause)));
  };

  const pi = status?.pi;
  const piLabel = !pi ? "" : pi.state === "ready" ? "已安装" : pi.state === "missing" ? "未安装" : "无法运行";
  const model = status?.provider === provider ? status.model : null;
  return <Panel heading="AI" dense>
    <div className="kd-ai-prompt kd-ffmpeg-settings" data-drawer-pending={!status && !statusError ? "" : undefined}>
      <div className="kd-ffmpeg-actions">
        <span className="kd-ai-prompt-copy">pi</span>
        <Button variant="ghost" size="sm" onClick={() => open(HOME_PAGE)}>
          <ExternalLink size={12} aria-hidden="true" />pi.dev
        </Button>
        <Button variant="ghost" size="sm" disabled={checking} onClick={() => {
          setChecking(true);
          void refresh(true).finally(() => setChecking(false));
        }}>
          <RefreshCw size={12} aria-hidden="true" />{checking ? "检测中…" : "重新检测"}
        </Button>
      </div>
      {pi && <div className="kd-cli-install-row">
        <span className="kd-cli-install-copy">
          <strong>pi · {piLabel}{pi.version ? ` · ${pi.version}` : ""}{pi.latest ? ` · ${pi.latest} 可更新` : ""}</strong>
          {pi.path && <small title={pi.path}>{pi.path}</small>}
          {pi.error && <small title={pi.error}>{pi.error}</small>}
        </span>
      </div>}
      {pi && (pi.state === "missing" || pi.latest) && <div className="kd-ffmpeg-command">
        <code>{pi.state === "missing" ? INSTALL_COMMAND : UPDATE_COMMAND}</code>
        <Button variant="ghost" size="sm" onClick={() => copy(pi.state === "missing" ? INSTALL_COMMAND : UPDATE_COMMAND)}>
          <Copy size={12} aria-hidden="true" />{copied === (pi.state === "missing" ? INSTALL_COMMAND : UPDATE_COMMAND) ? "已复制" : "复制命令"}
        </Button>
      </div>}
      {status && status.providers.length > 0 && <>
        <label className="kd-ffmpeg-actions"><span className="kd-ai-prompt-copy">服务商</span>
          <Select className="kd-select" value={provider} onChange={event => { setProvider(event.target.value); setKey(""); }}>
            {status.providers.map(item => <option key={item.id} value={item.id}>{item.label}{item.configured ? " · 已设置" : ""}</option>)}
          </Select>
        </label>
        <form className="kd-ffmpeg-actions" onSubmit={event => { event.preventDefault(); if (key.trim()) void save({ key: key.trim() }); }}>
          <span className="kd-ai-prompt-copy">API Key</span>
          <input className="kd-input" type="password" autoComplete="off" spellCheck={false} value={key}
            aria-label={`${chosen?.label ?? provider} API Key`} onChange={event => setKey(event.target.value)} />
          <Button variant="ghost" size="sm" type="submit" disabled={saving || !key.trim()}>保存</Button>
        </form>
        {global.length > 0 && <div className="kd-ffmpeg-actions kd-ai-global">
          <span className="kd-ai-prompt-copy">从 pi 导入</span>
          {global.map(login => login.importable
            ? <Button key={login.id} variant="ghost" size="sm" disabled={!!importing} onClick={() => void bring(login)}>
              {importing === login.id ? "导入中…" : login.label}
            </Button>
            : <span key={login.id} className="kd-ai-prompt-copy" title="订阅登录不能共用：两边会互相顶掉登录">{login.label} · 订阅登录</span>)}
        </div>}
        {models.length > 0 && <label className="kd-ffmpeg-actions"><span className="kd-ai-prompt-copy">模型</span>
          <Select className="kd-select" value={model ?? ""} disabled={saving}
            onChange={event => void save({ model: event.target.value || null })}>
            {!model && <option value="" />}
            {models.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
          </Select>
        </label>}
      </>}
      <InlineNotice text={error || statusError} block className="kd-ffmpeg-error" onDismiss={error ? () => setError("") : undefined} />
    </div>
  </Panel>;
}
