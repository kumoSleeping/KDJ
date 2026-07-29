/**
 * 软件更新：启动 + 定时静默检查；手动检查才报错。
 * 发现新版本后顶栏出现「待下载」，点进设置里的更新区。
 */

import { create } from "zustand";
import { api } from "../lib/api";
import { getBridge } from "../lib/bridge";
import type { UpdateInfo, UpdateProgress } from "../types";
import { useAppStore } from "./appStore";

const AUTO_KEY = "kd-auto-update-check";
const INTERVAL_MS = 5 * 60 * 1000;

function readAutoCheck(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_KEY);
    if (raw === null) return true;
    return raw !== "0" && raw !== "false";
  } catch {
    return true;
  }
}

function writeAutoCheck(value: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchUpdateInfo(): Promise<UpdateInfo> {
  const bridge = getBridge();
  return bridge.checkUpdate ? bridge.checkUpdate() : api.checkUpdate();
}

interface UpdateStore {
  info: UpdateInfo | null;
  /** 自动检测，默认开。 */
  autoCheck: boolean;
  checking: boolean;
  applying: boolean;
  /** 仅手动检查失败时写。 */
  manualError: string;
  progress: UpdateProgress | null;
  /** 递增后设置页滚到更新区。 */
  focusEpoch: number;

  setAutoCheck(on: boolean): void;
  /** silent：失败/无更新都不打扰；手动才写 manualError。 */
  check(opts?: { silent?: boolean }): Promise<UpdateInfo | null>;
  apply(onProgress?: (p: UpdateProgress) => void): Promise<void>;
  clearManualError(): void;
  /** 打开设置并滚到软件更新。 */
  openUpdateSection(): void;
  /** 启动静默检查 + 5 分钟轮询（受 autoCheck 控制）。 */
  startBackgroundChecks(): () => void;
}

let checkSeq = 0;

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  info: null,
  autoCheck: readAutoCheck(),
  checking: false,
  applying: false,
  manualError: "",
  progress: null,
  focusEpoch: 0,

  setAutoCheck(on) {
    writeAutoCheck(on);
    set({ autoCheck: on });
  },

  async check(opts) {
    const silent = opts?.silent ?? false;
    const seq = ++checkSeq;
    set({ checking: true, ...(silent ? {} : { manualError: "" }) });
    try {
      const info = await fetchUpdateInfo();
      if (seq !== checkSeq) return info;
      set({ info, checking: false });
      return info;
    } catch (error) {
      if (seq !== checkSeq) return null;
      if (silent) {
        set({ checking: false });
      } else {
        set({ checking: false, manualError: `检查更新失败：${errorText(error)}` });
      }
      return null;
    }
  },

  async apply(onProgress) {
    const info = get().info;
    if (!info?.newer) return;
    const bridge = getBridge();
    const canSelfUpdate = typeof bridge.applyUpdate === "function";
    set({ applying: true, manualError: "", progress: null });
    try {
      if (!canSelfUpdate) {
        await bridge.openExternal?.(info.url);
        set({ applying: false });
        return;
      }
      set({
        progress: {
          stage: "checking",
          downloaded: 0,
          total: null,
          message: "正在确认更新包",
        },
      });
      await bridge.applyUpdate?.((p) => {
        set({ progress: p });
        onProgress?.(p);
      });
    } catch (error) {
      set({
        applying: false,
        progress: null,
        manualError: `更新失败：${errorText(error)}`,
      });
    }
  },

  clearManualError() {
    set({ manualError: "" });
  },

  openUpdateSection() {
    useAppStore.getState().openSettingsPanel();
    set({ focusEpoch: get().focusEpoch + 1 });
  },

  startBackgroundChecks() {
    let timer: number | null = null;

    const clear = () => {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const arm = () => {
      clear();
      if (!get().autoCheck) return;
      void get().check({ silent: true });
      timer = window.setInterval(() => {
        if (get().autoCheck) void get().check({ silent: true });
      }, INTERVAL_MS);
    };

    arm();
    const unsub = useUpdateStore.subscribe((state, prev) => {
      if (state.autoCheck !== prev.autoCheck) arm();
    });

    return () => {
      clear();
      unsub();
    };
  },
}));
