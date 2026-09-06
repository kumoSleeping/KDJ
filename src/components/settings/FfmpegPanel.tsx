import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Download, ExternalLink, RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import { getBridge } from "../../lib/bridge";
import { copyText } from "../../lib/copyText";
import type { FfmpegInstallationStatus, FfmpegToolStatus } from "../../types";
import { Button, InlineNotice, Panel } from "../common";

const DOWNLOAD_PAGE = "https://ffmpeg.org/download.html";

function ToolRow({ name, tool }: { name: string; tool: FfmpegToolStatus }) {
  const label = tool.state === "ready" ? "已安装" : tool.state === "missing" ? "未安装" : "无法运行";
  return <div className="kd-cli-install-row">
    <span className="kd-cli-install-copy">
      <strong>{name} · {label}{tool.version ? ` · ${tool.version}` : ""}</strong>
      {tool.path && <small title={tool.path}>{tool.path}</small>}
      {tool.error && <small title={tool.error}>{tool.error}</small>}
    </span>
  </div>;
}

export function FfmpegPanel() {
  const [status, setStatus] = useState<FfmpegInstallationStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [distro, setDistro] = useState("debian");
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setBusy(true);
    setError("");
    try {
      const next = await api.ffmpegInstallationStatus();
      if (id === requestId.current) setStatus(next);
    } catch (cause) {
      if (id === requestId.current) setError(String(cause));
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => { requestId.current++; };
  }, [refresh]);

  const open = (url: string) => {
    const openExternal = getBridge().openExternal;
    if (!openExternal) { setError("当前窗口无法打开下载链接"); return; }
    void openExternal(url).catch(cause => setError(String(cause)));
  };
  const command = status?.platform === "macos" ? "brew install ffmpeg"
    : distro === "debian" ? "sudo apt update && sudo apt install ffmpeg"
    : distro === "arch" ? "sudo pacman -S ffmpeg" : "";
  const copy = () => {
    setCopied(false);
    void copyText(command).then(() => setCopied(true)).catch(cause => setError(String(cause)));
  };
  const needsInstall = status && (status.ffmpeg.state !== "ready" || status.ffprobe.state !== "ready");
  const platform = status?.platform;
  return <Panel heading="媒体工具" dense>
    <div className="kd-ai-prompt kd-ffmpeg-settings">
      <div className="kd-ffmpeg-actions">
        <span className="kd-ai-prompt-copy">FFmpeg / ffprobe</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw size={12} aria-hidden="true" />{busy ? "检测中…" : "重新检测"}
        </Button>
      </div>
      {status && <>
        <ToolRow name="FFmpeg" tool={status.ffmpeg} />
        <ToolRow name="ffprobe" tool={status.ffprobe} />
      </>}
      {needsInstall && <div className="kd-ffmpeg-guide">
        <p className="kd-ai-prompt-copy">VJ 导出、变速和媒体信息读取需要这两个工具。</p>
        {platform === "windows" ? <>
          <div className="kd-ffmpeg-actions">
            <Button variant="ghost" size="sm" onClick={() => open(status.arch === "x86_64"
              ? "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
              : "https://github.com/BtbN/FFmpeg-Builds/releases")}>
              <Download size={12} aria-hidden="true" />{status.arch === "x86_64" ? "下载 Windows ZIP" : "Windows 下载页"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => open(DOWNLOAD_PAGE)}>
              <ExternalLink size={12} aria-hidden="true" />下载来源
            </Button>
          </div>
          <p className="kd-ai-prompt-copy">{status.arch === "x86_64" ? "Gyan Essentials · Windows x64。" : `选择适合 ${status.arch} 的构建。`}解压后，将含 ffmpeg.exe 和 ffprobe.exe 的 bin 文件夹加入用户 Path，重启 KDJ 后重新检测。</p>
        </> : platform === "macos" ? <>
          <p className="kd-ai-prompt-copy">通过 Homebrew 安装，适用于 Apple Silicon 和 Intel。在终端执行下方命令，完成后重新检测。</p>
          <div className="kd-ffmpeg-actions">
            <Button variant="ghost" size="sm" onClick={() => open("https://brew.sh/")}>
              <ExternalLink size={12} aria-hidden="true" />安装 Homebrew
            </Button>
            <Button variant="ghost" size="sm" onClick={() => open("https://formulae.brew.sh/formula/ffmpeg")}>
              <ExternalLink size={12} aria-hidden="true" />FFmpeg 安装页
            </Button>
          </div>
        </> : platform === "linux" ? <>
          <label className="kd-ffmpeg-actions"><span className="kd-ai-prompt-copy">发行版</span>
            <select className="kd-select" value={distro} onChange={event => { setDistro(event.target.value); setCopied(false); }}>
              <option value="debian">Ubuntu / Debian</option>
              <option value="arch">Arch Linux</option>
              <option value="other">其他发行版</option>
            </select>
          </label>
          <p className="kd-ai-prompt-copy">按发行版安装包含 ffmpeg 和 ffprobe 的软件包，完成后重新检测。</p>
          <Button variant="ghost" size="sm" onClick={() => open(DOWNLOAD_PAGE)}>
            <Download size={12} aria-hidden="true" />Linux 软件包与下载
          </Button>
        </> : null}
        {(platform === "macos" || platform === "linux") && command && <div className="kd-ffmpeg-command">
          <code>{command}</code>
          <Button variant="ghost" size="sm" onClick={copy}>
            <Copy size={12} aria-hidden="true" />{copied ? "已复制" : "复制命令"}
          </Button>
        </div>}
      </div>}
      <InlineNotice text={error} block onDismiss={() => setError("")} />
    </div>
  </Panel>;
}
