/**
 * 应用级状态：当前板块、health、设置、账号。
 * WS 事件也在这里统一分发给三个 store（见 connectEvents），
 * 组件不要自己 events.subscribe——那样每个组件都会各自处理一遍同一条事件。
 */

import { create } from "zustand";
import { api, events } from "../lib/api";
import type { Account, Health, Settings, WsEvent } from "../types";
import { useDownloadStore } from "./downloadStore";
import { useLibraryStore } from "./libraryStore";

/**
 * 中间列表 + 右侧面板是**成对**切换的，三个标签常驻在列表面板顶边：
 *   library = 曲目表 + 曲目详情（本地）
 *   search  = 搜索结果 + 下载队列（在线）
 *   video   = 视频解析 + 下载队列（B 站）
 * 页面本身不换，只换这一对。搜索时自动切到 search、贴 B 站链接自动切到 video、
 * 点文件夹自动切回 library；随时可以手动点标签切——切走不丢内容。
 */
export type ListMode = "library" | "search" | "video";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把主题写到 <html data-theme>，design.css 只认这个属性。
 * system 时读一次 prefers-color-scheme；系统切换的监听在 main.tsx（那里才有生命周期）。
 */
export function applyTheme(theme: Settings["theme"]): void {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  if (document.documentElement.dataset.theme !== resolved) {
    document.documentElement.dataset.theme = resolved;
  }
}

export interface AppStore {
  listMode: ListMode;
  /** 有没有搜过（哪怕结果为空）。决定要不要显示切换开关。 */
  hasResults: boolean;
  /** 右侧详情栏是否正显示「平台登录」面板（左下角齿轮呼出）。 */
  showAccounts: boolean;
  health: Health | null;
  settings: Settings | null;
  accounts: Account[];
  /** 账号状态刷新失败的原因；空串 = 正常。登录面板自己显示这一行。 */
  accountsError: string;
  booting: boolean;
  /** health 拉不通时的原因；空串 = sidecar 正常。 */
  bootError: string;
  savingSettings: boolean;

  setListMode(mode: ListMode): void;
  setHasResults(value: boolean): void;
  toggleAccounts(): void;
  bootstrap(): Promise<void>;
  refreshAccounts(): Promise<void>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  handleEvent(event: WsEvent): void;
}

/** StrictMode 下 effect 会跑两次，用同一个 promise 挡掉重复的启动请求。 */
let bootInFlight: Promise<void> | null = null;

export const useAppStore = create<AppStore>()((set, get) => ({
  listMode: "library",
  hasResults: false,
  showAccounts: false,
  health: null,
  settings: null,
  accounts: [],
  accountsError: "",
  booting: true,
  bootError: "",
  savingSettings: false,

  setListMode(mode) {
    set({ listMode: mode });
  },

  setHasResults(value) {
    set({ hasResults: value, listMode: value ? "search" : "library" });
  },

  toggleAccounts() {
    set({ showAccounts: !get().showAccounts });
  },

  bootstrap() {
    if (bootInFlight) return bootInFlight;
    set({ booting: true });
    const run = (async () => {
      const [health, settings, accounts] = await Promise.allSettled([
        api.health(),
        api.getSettings(),
        api.accounts(),
      ]);
      if (health.status === "fulfilled") {
        set({ health: health.value, bootError: "" });
      } else {
        set({ health: null, bootError: errorText(health.reason) });
      }
      if (settings.status === "fulfilled") {
        set({ settings: settings.value });
        applyTheme(settings.value.theme);
      }
      // 账号拉不到不挡启动，但要把原因留下：登录面板不然只会一直写着"稍等一下"
      if (accounts.status === "fulfilled") set({ accounts: accounts.value, accountsError: "" });
      else set({ accountsError: `账号状态拉取失败：${errorText(accounts.reason)}` });
      set({ booting: false });
    })().finally(() => {
      bootInFlight = null;
    });
    bootInFlight = run;
    return run;
  },

  async refreshAccounts() {
    try {
      set({ accounts: await api.accounts(), accountsError: "" });
    } catch (error) {
      set({ accountsError: `账号状态刷新失败：${errorText(error)}` });
    }
  },

  async saveSettings(patch) {
    const current = get().settings;
    if (!current) return;
    const next: Settings = { ...current, ...patch };
    // 先本地生效（主题切换要立刻看到），失败再回滚
    set({ settings: next, savingSettings: true });
    applyTheme(next.theme);
    try {
      const saved = await api.putSettings(next);
      set({ settings: saved, savingSettings: false });
      applyTheme(saved.theme);
    } catch (error) {
      set({ settings: current, savingSettings: false });
      applyTheme(current.theme);
      // 设置的入口散在各处（主题在标题栏、目录在队列、画质在视频面板），
      // 没有一个统一的地方摆错误行；回滚本身已经是可见反馈——
      // 拨过去的开关会自己弹回来。详情只留给控制台。
      console.error(`设置保存失败：${errorText(error)}`);
    }
  },

  handleEvent(event) {
    if (event.type === "account.changed") {
      const account = event.payload;
      const accounts = get().accounts;
      const index = accounts.findIndex((item) => item.platform === account.platform);
      set({
        accounts:
          index >= 0
            ? accounts.map((item, i) => (i === index ? account : item))
            : [...accounts, account],
      });
    }
  },
}));

/** sidecar 是否可用：health 拿到过且没有连接错误。 */
export function selectConnected(state: AppStore): boolean {
  return state.health !== null && state.bootError === "";
}

/**
 * 启动 / 重试：health + settings + accounts + downloads + 曲库统计 一起打。
 * 统计是标题栏的曲库数量要用的，所以也放进首屏。
 */
export async function bootAll(): Promise<void> {
  await Promise.allSettled([
    useAppStore.getState().bootstrap(),
    useDownloadStore.getState().refresh(),
    useLibraryStore.getState().refreshStats(),
  ]);
}

/** 全局唯一的 WS 订阅点：一条事件按 type 分发给各 store 自己的 handleEvent。 */
export function connectEvents(): () => void {
  return events.subscribe((event) => {
    useAppStore.getState().handleEvent(event);
    useDownloadStore.getState().handleEvent(event);
    useLibraryStore.getState().handleEvent(event);
  });
}
