import { useAppStore } from "../stores/appStore";
import { useSettingsPage } from "./settingsPages";

/** 设置 → AI (docs/ai-dock.md). */
export function openAiSettings(): void {
  useSettingsPage.getState().setPage("ai");
  useAppStore.getState().openSettingsPanel();
}
