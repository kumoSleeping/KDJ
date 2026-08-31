import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const STORAGE_KEY = "kd-arrow-key-control-v1";

export type HorizontalArrowKeyMode = "seek" | "track";
export type VerticalArrowKeyMode = "list" | "volume";

export interface ArrowKeyControlPrefs {
  enabled: boolean;
  horizontalMode: HorizontalArrowKeyMode;
  verticalMode: VerticalArrowKeyMode;
}

export const DEFAULT_ARROW_KEY_CONTROL: Readonly<ArrowKeyControlPrefs> = {
  enabled: true,
  horizontalMode: "seek",
  verticalMode: "list",
};

export type ArrowKeyAction =
  | "seek-backward"
  | "seek-forward"
  | "previous-track"
  | "next-track"
  | "list-up"
  | "list-down"
  | "volume-up"
  | "volume-down";

export const ARROW_KEY_LIST_STEP_EVENT = "kd:arrow-key-list-step";

export interface ArrowKeyListStepDetail {
  delta: -1 | 1;
}

export function resolveArrowKeyAction(
  key: string,
  prefs: ArrowKeyControlPrefs,
): ArrowKeyAction | null {
  if (!prefs.enabled) return null;
  if (key === "ArrowLeft") {
    return prefs.horizontalMode === "seek" ? "seek-backward" : "previous-track";
  }
  if (key === "ArrowRight") {
    return prefs.horizontalMode === "seek" ? "seek-forward" : "next-track";
  }
  if (key === "ArrowUp") {
    return prefs.verticalMode === "list" ? "list-up" : "volume-up";
  }
  if (key === "ArrowDown") {
    return prefs.verticalMode === "list" ? "list-down" : "volume-down";
  }
  return null;
}

function normalizeHorizontalMode(value: unknown): HorizontalArrowKeyMode {
  return value === "track" ? "track" : "seek";
}

function normalizeVerticalMode(value: unknown): VerticalArrowKeyMode {
  return value === "volume" ? "volume" : "list";
}

function load(): ArrowKeyControlPrefs {
  if (typeof window === "undefined") return { ...DEFAULT_ARROW_KEY_CONTROL };
  try {
    const raw: unknown = JSON.parse(readLocalStorage(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULT_ARROW_KEY_CONTROL };
    const data = raw as Partial<ArrowKeyControlPrefs>;
    return {
      enabled:
        typeof data.enabled === "boolean" ? data.enabled : DEFAULT_ARROW_KEY_CONTROL.enabled,
      horizontalMode: normalizeHorizontalMode(data.horizontalMode),
      verticalMode: normalizeVerticalMode(data.verticalMode),
    };
  } catch {
    return { ...DEFAULT_ARROW_KEY_CONTROL };
  }
}

function save(prefs: ArrowKeyControlPrefs): void {
  if (typeof window === "undefined") return;
  try {
    writeLocalStorageNow(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 快捷键仍按当前会话生效；存储不可用只影响下次启动恢复。
  }
}

interface ArrowKeyControlState extends ArrowKeyControlPrefs {
  setEnabled(value: boolean): void;
  setHorizontalMode(value: HorizontalArrowKeyMode): void;
  setVerticalMode(value: VerticalArrowKeyMode): void;
}

function currentPrefs(state: ArrowKeyControlState): ArrowKeyControlPrefs {
  return {
    enabled: state.enabled,
    horizontalMode: state.horizontalMode,
    verticalMode: state.verticalMode,
  };
}

export const useArrowKeyControl = create<ArrowKeyControlState>((set, get) => ({
  ...load(),
  setEnabled(enabled) {
    const next = { ...currentPrefs(get()), enabled };
    set({ enabled });
    save(next);
  },
  setHorizontalMode(horizontalMode) {
    const next = {
      ...currentPrefs(get()),
      horizontalMode: normalizeHorizontalMode(horizontalMode),
    };
    set({ horizontalMode: next.horizontalMode });
    save(next);
  },
  setVerticalMode(verticalMode) {
    const next = {
      ...currentPrefs(get()),
      verticalMode: normalizeVerticalMode(verticalMode),
    };
    set({ verticalMode: next.verticalMode });
    save(next);
  },
}));
