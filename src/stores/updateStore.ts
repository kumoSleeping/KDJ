/**
 * 软件更新：启动 + 定时静默检查；手动检查才报错。
 * 发现新版本后顶栏出现更新键，点进设置里的更新区。自动下载开着时（默认开），
 * 桌面在后台下好、下次启动时装上，也可以在设置里立即重启更新；安卓在 Wi‑Fi 下
 * 只把 APK 下好，安装页要等用户在设置里点「安装」才打开，从不自己弹出来。
 */

import { create } from "zustand";
import { api } from "../lib/api";
import { finishApiActivity } from "../lib/activityLog";
import { getBridge } from "../lib/bridge";
import { readLocalStorage, writeLocalStorageNow } from "../lib/storageWrite";
import type { UpdateInfo, UpdateProgress } from "../types";
import { useAppStore } from "./appStore";

const AUTO_KEY = "kd-auto-update-check";
const AUTO_DOWNLOAD_KEY = "kd-auto-update-download";
const INTERVAL_MS = 5 * 60 * 1000;

/** 不按流量计费的网络（Wi‑Fi / 有线）。WebView 说不清时按计费算，不自动下载。 */
function unmeteredNetwork(): boolean {
  const connection = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  return !!connection && !connection.saveData && (connection.type === "wifi" || connection.type === "ethernet");
}

/** 开关默认开：没写过就是开。 */
function readSwitch(key: string): boolean {
  const raw = readLocalStorage(key);
  if (raw === null) return true;
  return raw !== "0" && raw !== "false";
}

function writeSwitch(key: string, value: boolean): void {
  writeLocalStorageNow(key, value ? "1" : "0");
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
  /** 发现新版本后自动下载，默认开。 */
  autoDownload: boolean;
  /** 桌面：已在后台下好、等下次启动安装的版本；没有是空串。 */
  staged: string;
  /** 桌面：后台正在下载。 */
  downloading: boolean;
  checking: boolean;
  applying: boolean;
  /** 仅手动检查失败时写。 */
  manualError: string;
  progress: UpdateProgress | null;
  /** 递增后设置页滚到更新区。 */
  focusEpoch: number;

  setAutoCheck(on: boolean): void;
  setAutoDownload(on: boolean): void;
  /** 自动下载开着、发现了新版本时的下一步：桌面后台下好暂存；安卓只在后台检查时下。 */
  downloadInBackground(info: UpdateInfo, silent: boolean): void;
  /** silent：失败/无更新都不打扰；手动才写 manualError。 */
  check(opts?: { silent?: boolean }): Promise<UpdateInfo | null>;
  /** 用户点了更新键：下载（已下好就跳过）并安装；安卓打开系统安装页。 */
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
  autoCheck: readSwitch(AUTO_KEY),
  autoDownload: readSwitch(AUTO_DOWNLOAD_KEY),
  staged: "",
  downloading: false,
  checking: false,
  applying: false,
  manualError: "",
  progress: null,
  focusEpoch: 0,

  setAutoCheck(on) {
    writeSwitch(AUTO_KEY, on);
    set({ autoCheck: on });
  },

  setAutoDownload(on) {
    writeSwitch(AUTO_DOWNLOAD_KEY, on);
    set({ autoDownload: on });
    const info = get().info;
    if (on && info) get().downloadInBackground(info, true);
  },

  downloadInBackground(info, silent) {
    const state = get();
    if (!info.newer || !state.autoDownload) return;
    const download = getBridge().downloadUpdate;
    if (!download) {
      if (silent) offerAndroidUpdate(info);
      return;
    }
    if (state.downloading || state.applying || state.staged === info.latest) return;
    set({ downloading: true });
    // 静默：失败了下次检查再下；手动「立即重启更新」也会自己下。
    download().then(
      (version) => set({ staged: version, downloading: false }),
      () => set({ downloading: false }),
    );
  },

  async check(opts) {
    const silent = opts?.silent ?? false;
    const seq = ++checkSeq;
    set({ checking: true, ...(silent ? {} : { manualError: "" }) });
    try {
      const info = await fetchUpdateInfo();
      if (seq !== checkSeq) return info;
      set({ info, checking: false });
      get().downloadInBackground(info, silent);
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
    const updateStarted = performance.now();
    set({ applying: true, manualError: "", progress: null });
    // 安卓：Release 里有签名 APK 时在应用里下载（后台已下好就直接用），下完打开系统安装页。
    if (bridge.installAndroidUpdate && info.url.endsWith(".apk")) {
      try {
        set({ progress: { stage: "downloading", downloaded: 0, total: null, message: "" } });
        const result = await bridge.installAndroidUpdate({
          url: info.url,
          version: info.latest,
          askPermission: true,
          onProgress: (p) => {
            set({ progress: p });
            onProgress?.(p);
          },
        });
        set({
          applying: false,
          progress: null,
          staged: info.latest,
          manualError: result === "permission" ? "请在系统设置里允许 KDJ 安装应用，回来后再点一次" : "",
        });
      } catch (error) {
        set({ applying: false, progress: null, manualError: `更新失败：${errorText(error)}` });
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

/**
 * 安卓：自动下载开着时，后台检查在 Wi‑Fi 下发现新版本，只把 APK 下好（install: false），
 * 不打开安装页、不打开授权页、失败不报。装不装由用户在设置里点「安装」决定。
 */
export function offerAndroidUpdate(info: UpdateInfo): void {
  const store = useUpdateStore.getState();
  const install = getBridge().installAndroidUpdate;
  if (!info.newer || !store.autoDownload || !install || !info.url.endsWith(".apk") || store.applying
    || store.downloading || store.staged === info.latest || !unmeteredNetwork()) return;
  useUpdateStore.setState({ downloading: true });
  install({ url: info.url, version: info.latest, askPermission: false, install: false }).then(
    () => useUpdateStore.setState({ staged: info.latest, downloading: false }),
    () => useUpdateStore.setState({ downloading: false }),
  );
}
