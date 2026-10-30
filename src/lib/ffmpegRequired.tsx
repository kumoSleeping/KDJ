import { Download } from "lucide-react";
import { showTask } from "../components/tasks/taskBubbleStore";
import { useAppStore } from "../stores/appStore";
import { mediaToolsInstalling, useFfmpegStore } from "../stores/ffmpegStore";
import { getBridge } from "./bridge";
import { useSettingsFocus, useSettingsPage } from "./settingsPages";

/** 设置 → FFmpeg，媒体工具的安装处。 */
export function openMediaToolsSettings(): void {
  useSettingsPage.getState().setPage("ffmpeg");
  useSettingsFocus.getState().focus("ffmpeg");
  useAppStore.getState().openSettingsPanel();
}

/**
 * 可视化导出缺系统编码器时要用 FFmpeg。没有就地说一声（任务气泡），同时打开设置并翻到安装处，返回 false。
 * macOS 和 Windows 上画面由 WebView 的 WebCodecs 硬件编码、音轨由系统 AAC 编码器编码，不需要 FFmpeg；
 * 没有 WebCodecs（macOS 10.15）或没有系统 AAC 编码器（Linux）时才要。
 * 查不到状态时不拦：真正缺失时后端的导出任务自己会失败。
 */
export async function ensureFfmpegForExport(): Promise<boolean> {
  const platform = getBridge().platform;
  if (!["darwin", "win32", "linux"].includes(platform)) return true;
  if (platform !== "linux" && typeof VideoEncoder !== "undefined") return true;
  await useFfmpegStore.getState().refresh();
  const { status, progress } = useFfmpegStore.getState();
  if (!status || status.ffmpeg.state === "ready") return true;
  showTask({
    id: "ffmpeg-required", kind: "export", tone: "error", size: "small",
    title: mediaToolsInstalling(progress) ? "FFmpeg 安装中" : status.ffmpeg.state === "missing" ? "FFmpeg 未安装" : "FFmpeg 无法运行",
    icon: <Download size={16} />,
    onOpen: openMediaToolsSettings,
  });
  openMediaToolsSettings();
  return false;
}
