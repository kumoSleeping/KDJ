import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import type { CliInstallStatus } from "../../types";
import { Button, InlineNotice, Panel } from "../common";

/** What the `kdj` command on the PATH is, and the key that installs or updates it. */
function describe(status: CliInstallStatus): { label: string; action: string } {
  const version = status.installedVersion ?? status.currentVersion;
  switch (status.state) {
    case "current": return { label: `kdj · 已安装 · v${version}`, action: "" };
    case "outdated": return { label: `kdj · 已安装 · v${status.installedVersion ?? "?"}，当前 v${status.currentVersion}`, action: "更新" };
    case "broken": return { label: "kdj · 入口失效", action: "重新安装" };
    case "conflict": return { label: "kdj · 安装位置已被其他命令占用", action: "" };
    case "missing": return { label: "kdj · 未安装", action: "安装" };
    default: return { label: "", action: "" };
  }
}

/**
 * 设置 → 系统 → 命令行: puts `kdj` on the PATH (docs/ai-cli.md) — a link to this app on macOS
 * and Linux, a `kdj.cmd` launcher on Windows (src-tauri/src/cli/install.rs).
 */
export function CliPanel() {
  const bridge = getBridge();
  const [status, setStatus] = useState<CliInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void bridge.cliInstallStatus?.()
      .then(next => { if (alive) setStatus(next); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; };
  }, [bridge]);
  if (!bridge.cliInstallStatus || status?.state === "unsupported") return null;
  const install = () => {
    if (!bridge.installCli || busy) return;
    setBusy(true);
    setError("");
    void bridge.installCli()
      .then(setStatus)
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  const shown = status ? describe(status) : null;
  return <Panel heading="命令行" dense>
    <div className="kd-ai-prompt" data-drawer-pending={!status && !error ? "" : undefined}>
      {shown && <div className="kd-cli-install-row" title={status?.installPath}>
        <span className="kd-cli-install-copy">
          <strong>{shown.label}</strong>
          {status?.installPath ? <small>{status.installPath}</small> : null}
        </span>
        {shown.action && bridge.installCli ? <Button variant="ghost" size="sm" disabled={busy} onClick={install}>
          {status?.state === "missing" ? <Download size={12} aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
          {busy ? "处理中…" : shown.action}
        </Button> : null}
      </div>}
    </div>
    <InlineNotice text={error} onDismiss={() => setError("")} />
  </Panel>;
}
