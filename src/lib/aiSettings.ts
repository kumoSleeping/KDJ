import { useAppStore } from "../stores/appStore";
import { useSettingsFocus, useSettingsPage } from "./settingsPages";

/** 设置 → 系统, at the AI section (docs/ai-dock.md). */
export function openAiSettings(): void {
  useSettingsPage.getState().setPage("system");
  useSettingsFocus.getState().focus("ai");
  useAppStore.getState().openSettingsPanel();
}
