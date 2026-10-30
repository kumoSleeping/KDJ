/**
 * 软件更新：启动 + 定时静默检查；手动检查才报错。
 * 发现新版本后顶栏出现「待下载」，点进设置里的更新区。
 */

import { create } from "zustand";
import { api } from "../lib/api";
import { finishApiActivity } from "../lib/activityLog";
import { getBridge } from "../lib/bridge";
import { readLocalStorage, writeLocalStorageNow } from "../lib/storageWrite";
import type { UpdateInfo, UpdateProgress } from "../types";
import { useAppStore } from "./appStore";

const AUTO_KEY = "kd-auto-update-check";
const INTERVAL_MS = 5 * 60 * 1000;
/** 安卓自动弹过安装页的版本：每个版本只自动弹一次，之后由顶栏和设置里的键来装。 */
const ANDROID_OFFERED_KEY = "kd-android-update-offered";

/** 不按流量计费的网络（Wi‑Fi / 有线）。WebView 说不清时按计费算，不自动下载。 */
function unmeteredNetwork(): boolean {
  const connection = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  return !!connection && !connection.saveData && (connection.type === "wifi" || connection.type === "ethernet");
}

function readAutoCheck(): boolean {
  const raw = readLocalStorage(AUTO_KEY);
  if (raw === null) return true;
  return raw !== "0" && raw !== "false";
}

function writeAutoCheck(value: boolean): void {
  writeLocalStorageNow(AUTO_KEY, value ? "1" : "0");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchUpdateInfo(): Promise<UpdateInfo> {
  const bridge = getBridge();
  if (!bridge.checkUpdate) return api.checkUpdate();
  const started = performance.now();
  try {
    const info = await bridge.checkUpdate();
    // Tauri 开发包不能自更新，也不会访问 GitHub；不要把本地的开发态短路
    // 伪装成一条网络请求。正式安装包仍完整记录检查结果。
    if (!import.meta.env.DEV) {
      finishApiActivity(
        { category: "network", action: "更新检查 API", target: "GitHub · github.com" },
        { status: 200, durationMs: performance.now() - started, ok: true },
      );
    }
    return info;
  } catch (error) {
    if (!import.meta.env.DEV) {
      finishApiActivity(
        { category: "network", action: "更新检查 API", target: "GitHub · github.com" },
        {
          status: 0,
          durationMs: performance.now() - started,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    throw error;
  }
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
  /** auto：安卓后台检查发现新版本后自己下载、弹安装页；不打开授权页，失败不报。 */
  apply(onProgress?: (p: UpdateProgress) => void, opts?: { auto?: boolean }): Promise<void>;
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
      if (silent) offerAndroidUpdate(info);
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

  async apply(onProgress, opts) {
    const info = get().info;
    if (!info?.newer) return;
    const bridge = getBridge();
    const canSelfUpdate = typeof bridge.applyUpdate === "function";
    const updateStarted = performance.now();
    const auto = opts?.auto ?? false;
    set({ applying: true, manualError: "", progress: null });
    // 安卓：Release 里有签名 APK 时在应用里下载，下完打开系统安装页。
    if (bridge.installAndroidUpdate && info.url.endsWith(".apk")) {
      try {
        set({ progress: { stage: "downloading", downloaded: 0, total: null, message: "" } });
        const result = await bridge.installAndroidUpdate({
          url: info.url,
          version: info.latest,
          askPermission: !auto,
          onProgress: (p) => {
            set({ progress: p });
            onProgress?.(p);
          },
        });
        if (auto) writeLocalStorageNow(ANDROID_OFFERED_KEY, info.latest);
        set({
          applying: false,
          progress: null,
          manualError: result === "permission" && !auto ? "请在系统设置里允许 KDJ 安装应用，回来后再点一次" : "",
        });
      } catch (error) {
        set({ applying: false, progress: null, manualError: auto ? "" : `更新失败：${errorText(error)}` });
      }
      return;
    }
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
      if (canSelfUpdate) {
        finishApiActivity(
          { category: "network", action: "软件更新下载", target: "GitHub · github.com" },
          {
            status: 0,
            durationMs: performance.now() - updateStarted,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
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

/** 安卓：后台检查在 Wi‑Fi 下发现新版本，自己下好并弹出系统安装页，每个版本一次。 */
export function offerAndroidUpdate(info: UpdateInfo): void {
  const store = useUpdateStore.getState();
  if (!info.newer || !getBridge().installAndroidUpdate || store.applying || !unmeteredNetwork()
    || readLocalStorage(ANDROID_OFFERED_KEY) === info.latest) return;
  void store.apply(undefined, { auto: true });
}
