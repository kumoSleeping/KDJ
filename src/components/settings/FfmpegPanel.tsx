import { useEffect, useState } from "react";
import { Copy, Download, ExternalLink, FolderOpen, RefreshCw, FileArchive } from "lucide-react";
import { mediaToolsInstalling, useFfmpegStore } from "../../stores/ffmpegStore";
import { getBridge } from "../../lib/bridge";
import { copyText } from "../../lib/copyText";
import type { FfmpegToolStatus } from "../../types";
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
  const { status, progress, checking, choosing, error, refresh, install, setError } = useFfmpegStore();
  const [copied, setCopied] = useState(false);
  const [distro, setDistro] = useState("debian");
  const installing = mediaToolsInstalling(progress);
  const busy = checking || choosing || installing;
  useEffect(() => { void refresh(); }, [refresh]);

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
          <RefreshCw size={12} aria-hidden="true" />{checking ? "检测中…" : "重新检测"}
        </Button>
      </div>
      {status && <>
        <ToolRow name="FFmpeg" tool={status.ffmpeg} />
        <ToolRow name="ffprobe" tool={status.ffprobe} />
      </>}
      {["windows", "macos"].includes(platform ?? "") && getBridge().installMediaTools && <div className="kd-ffmpeg-guide">
        <div className="kd-ffmpeg-actions">
          {(status?.arch === "x86_64" || (platform === "macos" && status?.arch === "aarch64")) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void install("download")}>
            <Download size={12} aria-hidden="true" />{needsInstall ? "一键安装" : "重新安装"}
          </Button>}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void install("zip")}>
            <FileArchive size={12} aria-hidden="true" />导入 ZIP
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void install("folder")}>
            <FolderOpen size={12} aria-hidden="true" />选择文件夹
          </Button>
          <Button variant="ghost" size="sm" onClick={() => open(platform === "macos" ? "https://ffmpeg.martin-riedl.de/" : "https://www.gyan.dev/ffmpeg/builds/")}>
            <ExternalLink size={12} aria-hidden="true" />下载来源与许可
          </Button>
        </div>
        {needsInstall && <p className="kd-ai-prompt-copy">KDJ 会保存并启用媒体工具，无需移动文件或修改系统设置。已下载的 ZIP 可直接导入，已解压的文件夹也可直接选择。</p>}
        {platform === "windows" && status?.arch !== "x86_64" && <p className="kd-ai-prompt-copy">当前设备：{status?.arch}。请选择兼容此设备的 Windows 工具包。</p>}
        {platform === "macos" && needsInstall && <p className="kd-ai-prompt-copy">{status?.arch === "aarch64" ? "Apple Silicon" : "Intel"} · 自动选择对应版本。FFmpeg 与 ffprobe 分开的 ZIP 可同时选择导入。</p>}
        {installing && <div className="kd-ffmpeg-actions" role="status" aria-live="polite">
          <span className="kd-ai-prompt-copy">{progress?.phase === "preparing" ? "准备安装…"
            : progress?.phase === "extracting" ? "正在导入媒体工具…"
            : progress?.phase === "validating" ? "正在验证媒体工具…"
            : `正在下载 ${progress?.component ?? ""} · ${((progress?.downloaded ?? 0) / 1048576).toFixed(1)} MB${progress?.total ? ` / ${(progress.total / 1048576).toFixed(1)} MB` : ""}`}</span>
          <progress aria-label="媒体工具安装进度" max={progress?.total || undefined}
            value={progress?.phase === "downloading" && progress.total ? progress.downloaded : undefined} />
        </div>}
        {progress?.phase === "done" && !needsInstall && <p className="kd-ai-prompt-copy" role="status">媒体工具已就绪</p>}
      </div>}
      {needsInstall && <div className="kd-ffmpeg-guide">
        <p className="kd-ai-prompt-copy">混音编辑器的媒体读取、变速和导出需要 FFmpeg 与 ffprobe。</p>
        {platform === "windows" ? <>
          {!getBridge().installMediaTools && <p className="kd-ai-prompt-copy">请在 Windows 版 KDJ 的媒体工具中安装或导入 FFmpeg。</p>}
        </> : platform === "macos" && !getBridge().installMediaTools ? <>
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
        {((platform === "macos" && !getBridge().installMediaTools) || platform === "linux") && command && <div className="kd-ffmpeg-command">
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
