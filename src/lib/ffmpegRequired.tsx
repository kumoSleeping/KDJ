import { useAppStore } from "../stores/appStore";
import { useSettingsFocus, useSettingsPage } from "./settingsPages";

/** 设置 → FFmpeg，媒体工具的安装处。 */
export function openMediaToolsSettings(): void {
  useSettingsPage.getState().setPage("ffmpeg");
  useSettingsFocus.getState().focus("ffmpeg");
  useAppStore.getState().openSettingsPanel();
}
