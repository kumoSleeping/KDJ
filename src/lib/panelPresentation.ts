import { create } from "zustand";
import { useToastStore } from "../stores/toastStore";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

export type PanelForm = "slim" | "strip" | "landscape" | "portrait";
export type PanelFormChoice = "auto" | PanelForm;
export const PANEL_FORM_LABELS: Record<PanelFormChoice, string> = {
  auto: "自动", slim: "窄横条", strip: "横条", landscape: "16:9", portrait: "竖向",
};

/** Supported shapes, independent of source loading, playback and dock ownership. */
export type PanelFormLocation = "top" | "right";
export const PANEL_PRESENTATIONS: Record<string, { forms: readonly PanelForm[]; aspectRatio?: number }> = {
  visualizer: { forms: ["landscape"], aspectRatio: 16 / 9 },
  control: { forms: ["slim", "landscape", "portrait"] },
  waveform: { forms: ["slim", "strip", "landscape"] },
  search: { forms: ["strip"] },
  lyrics: { forms: ["slim", "strip", "landscape", "portrait"] },
};
export function panelForms(id: string, side: PanelFormLocation): readonly PanelForm[] {
  return side === "top" ? PANEL_PRESENTATIONS[id]?.forms ?? [] : [];
}
const KEY = "kd-panel-presentations-v1";
function load(): { choices: Record<string, unknown>; readOnlyReason: string | null } {
  try {
    const value = JSON.parse(readLocalStorage(KEY) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return { choices: value, readOnlyReason: null };
  } catch { /* An unreadable document must not be replaced by an empty one. */ }
  return { choices: {}, readOnlyReason: `布局偏好 ${KEY} 无法无损读取，已保留原数据并禁止覆盖。` };
}
export function panelFormChoice(id: string, dockId: string, choices: Record<string, unknown>, side: PanelFormLocation = "top"): PanelFormChoice {
  const value = choices[`${dockId}@${side}`] ?? choices[dockId];
  return panelForms(id, side).includes(value as PanelForm) ? value as PanelForm : "auto";
}
export const usePanelPresentation = create<{
  choices: Record<string, unknown>;
  readOnlyReason: string | null;
  setChoice(id: string, dockId: string, choice: PanelFormChoice, side: PanelFormLocation, width?: number): void;
  searchSpan: boolean;
  setSearchSpan(value: boolean): void;
}>(set => ({
  ...load(),
  searchSpan: readLocalStorage("kd-search-span-sidebar") === "true",
  setSearchSpan(value) {
    writeLocalStorageNow("kd-search-span-sidebar", String(value));
    set({ searchSpan: value });
  },
  setChoice(id, dockId, choice, side, width) {
    if (choice !== "auto" && !panelForms(id, side).includes(choice)) return;
    set(state => {
      if (state.readOnlyReason) { useToastStore.getState().show(state.readOnlyReason); return state; }
      const choices = { ...state.choices, [`${dockId}@${side}`]: choice };
      if (width !== undefined && Number.isFinite(width)) choices[`${dockId}@${side}:width`] = Math.max(160, width);
      writeLocalStorageNow(KEY, JSON.stringify(choices));
      return { choices };
    });
  },
}));
