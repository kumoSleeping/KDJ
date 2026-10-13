import { Download } from "lucide-react";
import { showTask } from "../components/tasks/taskBubbleStore";
import { useAppStore } from "../stores/appStore";
import { mediaToolsInstalling, useFfmpegStore } from "../stores/ffmpegStore";
import { getBridge } from "./bridge";
import { useSettingsFocus, useSettingsPage } from "./settingsPages";

/** 设置 → 系统，翻到媒体工具（FFmpeg）的安装处。 */
export function openMediaToolsSettings(): void {
  useSettingsPage.getState().setPage("system");
  useSettingsFocus.getState().focus("ffmpeg");
  useAppStore.getState().openSettingsPanel();
}

/**
 * 导出要用 FFmpeg。没有就地说一声（任务气泡），同时打开设置并翻到安装处，返回 false。
 * 查不到状态时不拦：真正缺失时后端的导出任务自己会失败。
 */
export async function ensureFfmpegForExport(): Promise<boolean> {
  if (!["darwin", "win32", "linux"].includes(getBridge().platform)) return true;
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
