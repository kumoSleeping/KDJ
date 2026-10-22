import { create } from "zustand";
import { useAppStore } from "../stores/appStore";
import { captureDiagnostic } from "./diagnostics";
import { useSettingsFocus, useSettingsPage } from "./settingsPages";

/**
 * Whether this window has the report to the developer to land on. The main window says so while
 * it is up; a side window (the mixing editor, the crash page) has no settings drawer, and its
 * notices offer no way there.
 */
export const useReportEntry = create<{ ready: boolean; setReady(ready: boolean): void }>(set => ({
  ready: false,
  setReady: ready => set({ ready }),
}));

/** What the notice said that the report was last asked for from: the report fills it in as the problem. */
export const useReportProblem = create<{ text: string; set(text: string): void }>(set => ({
  text: "",
  set: text => set({ text }),
}));

/**
 * From the notice of an error to the report (设置 → 系统 → 日志): what the notice said joins the
 * recent errors the report carries, and the settings open with the report unfolded. Nothing is
 * sent here: sending is the report's own key.
 */
export function reportError(message: string): void {
  captureDiagnostic("ui", "notice", message);
  useReportProblem.getState().set(message);
  useSettingsPage.getState().setPage("system");
  useSettingsFocus.getState().focus("report");
  useAppStore.getState().openSettingsPanel();
}
