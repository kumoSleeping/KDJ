import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { mediaToolsInstalling, useFfmpegStore } from "../../stores/ffmpegStore";
import { FfmpegPanel } from "../settings/FfmpegPanel";

export function WorkshopMediaTools() {
  const { status, progress, error, refresh } = useFfmpegStore();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const desktop = ["darwin", "win32", "linux"].includes(getBridge().platform);
  useEffect(() => { if (desktop) void refresh(); }, [desktop, refresh]);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  const needsTools = status && (status.ffmpeg.state !== "ready" || status.ffprobe.state !== "ready");
  const installing = mediaToolsInstalling(progress);
  if (!desktop) return null;
  return <>
    {(needsTools || installing || error) && <button type="button" onClick={() => setOpen(true)}
      title={error || "混音编辑器的媒体读取、变速和导出需要媒体工具"}>
      <Download size={15} />{installing ? "媒体工具安装中" : error ? "检查媒体工具" : "安装媒体工具"}
    </button>}
    {open && createPortal(<dialog ref={dialog} className="vj-dialog kd-media-tools-dialog"
      aria-label="媒体工具" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <header><strong>媒体工具</strong><button type="button" aria-label="关闭媒体工具" onClick={() => setOpen(false)}><X size={15} /></button></header>
      <FfmpegPanel />
    </dialog>, document.body)}
  </>;
}
