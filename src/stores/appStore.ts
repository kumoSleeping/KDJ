/**
 * 应用级状态：当前板块、health、设置、账号。
 * WS 事件也在这里统一分发给三个 store（见 connectEvents），
 * 组件不要自己 events.subscribe——那样每个组件都会各自处理一遍同一条事件。
 */

import { create } from "zustand";
import { api, events } from "../lib/api";
import type { Account, Health, SearchCapabilities, Settings, WsEvent } from "../types";
import { useDownloadStore } from "./downloadStore";
import { useLibraryStore } from "./libraryStore";

/**
 * hasResults 只管中间搜索半栏是否展开；右栏下载队列只看 showQueue。
 * 搜完（含 Explore 代搜）不再自动把右栏切成队列——真有任务入队时再 openQueuePanel。
 *
 * 视频曾经是并列的第三个标签，现在并回了搜索半栏：贴 B 站链接和搜关键词都是
 * "去网上找东西下"。视频和歌的差别只体现在结果行的长相上（见 VideoResultRow）。
 */
export type ListMode = "library" | "search";

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
  // macOS 快速拖窗时会直接合成原生窗口底层；它也要和页面同色，
  // 否则浅色主题的窗口右缘会短暂露出配置中的深色背景。
  window.kdj?.setWindowBackground(resolved);
  // 存的是算好的 dark/light 而不是 system：读它的是 public/theme-init.js，
  // 跑在首帧前，越简单越好，不该在那边再算一遍系统偏好
  try {
    localStorage.setItem("kd-theme", resolved);
  } catch {
    /* localStorage 不可用只影响下次启动的首帧，不影响本次 */
  }
}

export interface AppStore {
  listMode: ListMode;
  /** 有没有搜过（哪怕结果为空）。决定要不要显示切换开关。 */
  hasResults: boolean;
  /** 右侧详情栏是否正显示「设置」面板（顶栏小齿轮呼出；接播 + 账号合在一起）。 */
  showSettings: boolean;
  /** 每次显式打开设置面板都递增；即使面板已是打开态，也能重新拉开窄屏抽屉。 */
  settingsPanelEpoch: number;
  /** 强制把右栏/抽屉切到下载队列（曲库页也能看队列，不必先搜一次）。 */
  showQueue: boolean;
  queuePanelEpoch: number;
  /** 右栏/抽屉显示搜索结果预览（音频试听或视频预览），与下载队列互斥。 */
  showPreview: boolean;
  previewPanelEpoch: number;
  /** 单栏布局下用抽屉装文件夹树（宽屏左栏常驻，不必走这条）。 */
  showFolders: boolean;
  foldersPanelEpoch: number;
  /** 右栏显示「按顺序导出 VJ」设置面板。 */
  showVjExport: boolean;
  vjExportPanelEpoch: number;
  /** 右栏显示 KDJ 虚拟磁盘的正式创建与挂载管理面板。 */
  showVirtualDisk: boolean;
  virtualDiskPanelEpoch: number;
  /** 右栏显示歌词（播放时后台搜到的 LRC）。 */
  showLyrics: boolean;
  lyricsPanelEpoch: number;
  health: Health | null;
  settings: Settings | null;
  accounts: Account[];
  /** provider 声明的搜索维度；失败时空对象只保留单曲搜索。 */
  searchCapabilities: SearchCapabilities;
  /** 账号状态刷新失败的原因；空串 = 正常。登录面板自己显示这一行。 */
  accountsError: string;
  booting: boolean;
  /** health 拉不通时的原因；空串 = sidecar 正常。 */
  bootError: string;
  savingSettings: boolean;

  setListMode(mode: ListMode): void;
  setHasResults(value: boolean): void;
  /** 让右栏回到曲目详情；任何显式选歌/换歌入口都走它。 */
  showTrackDetail(): void;
  /**
   * 回到曲库主面并清掉设置/队列等旁路，但**保留歌词内容面**。
   * 起播、接歌、上一首走这条——别用 showTrackDetail，否则会把刚钉住的歌词栏拆掉。
   */
  focusLibrary(): void;
  toggleSettingsPanel(): void;
  openSettingsPanel(): void;
  toggleQueuePanel(): void;
  openQueuePanel(): void;
  /** 打开预览旁路（点搜索结果音频/视频时走这条，不跟下载队列挤一栏）。 */
  openPreviewPanel(): void;
  toggleFoldersPanel(): void;
  openFoldersPanel(): void;
  /** 打开「按顺序导出 VJ」旁路（由文件夹右键触发）。 */
  openVjExportPanel(): void;
  openVirtualDiskPanel(): void;
  /** 打开右栏歌词面板。 */
  openLyricsPanel(): void;
  toggleLyricsPanel(): void;
  /** 只收起旁路面板，不改 listMode（窄屏抽屉点关闭 / 下拖时用）。 */
  dismissOverlay(): void;
  /** 当前打开的旁路面板种类；没有则 null。供浏览历史 / 撤销使用。 */
  currentOverlay():
    | "settings"
    | "queue"
    | "preview"
    | "folders"
    | "vjExport"
    | "virtualDisk"
    | "lyrics"
    | null;
  bootstrap(): Promise<void>;
  refreshAccounts(): Promise<void>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  handleEvent(event: WsEvent): void;
}

/** 打开某一块旁路面板时，把其余旁路关掉——互斥，避免关 A 露出 B。 */
function clearOverlays() {
  return {
    showSettings: false,
    showQueue: false,
    showPreview: false,
    showFolders: false,
    showVjExport: false,
    showVirtualDisk: false,
    showLyrics: false,
  } as const;
}

/** StrictMode 下 effect 会跑两次，用同一个 promise 挡掉重复的启动请求。 */
let bootInFlight: Promise<void> | null = null;

export const useAppStore = create<AppStore>()((set, get) => ({
  listMode: "library",
  hasResults: false,
  showSettings: false,
  settingsPanelEpoch: 0,
  showQueue: false,
  queuePanelEpoch: 0,
  showPreview: false,
  previewPanelEpoch: 0,
  showFolders: false,
  foldersPanelEpoch: 0,
  showVjExport: false,
  vjExportPanelEpoch: 0,
  showVirtualDisk: false,
  virtualDiskPanelEpoch: 0,
  showLyrics: false,
  lyricsPanelEpoch: 0,
  health: null,
  settings: null,
  accounts: [],
  searchCapabilities: {},
  accountsError: "",
  booting: true,
  bootError: "",
  savingSettings: false,

  setListMode(mode) {
    // 用户点了曲库/搜索/文件夹，就是在切换当前关注的内容；旁路面板
    // 应该自动让位，不能逼用户先找到右上角的关闭按钮。
    set({ listMode: mode, ...clearOverlays() });
  },

  setHasResults(value) {
    // 只撑开中间搜索半栏；不改 listMode、不清旁路——右栏继续留着曲目详情，
    // 等真有下载任务再 openQueuePanel。
    set({ hasResults: value });
  },

  showTrackDetail() {
    set({ listMode: "library", ...clearOverlays() });
  },

  focusLibrary() {
    set({
      listMode: "library",
      showSettings: false,
      showQueue: false,
      showPreview: false,
      showFolders: false,
      showVjExport: false,
      showVirtualDisk: false,
    });
  },

  // 旁路面板共用右栏/抽屉那一个位置，互斥：开一个就把另一个顶掉，
  // 不然"关掉 A 露出的是 B"会让人以为关错了东西
  toggleSettingsPanel() {
    const open = !get().showSettings;
    set({
      ...clearOverlays(),
      showSettings: open,
      settingsPanelEpoch: open ? get().settingsPanelEpoch + 1 : get().settingsPanelEpoch,
    });
  },

  openSettingsPanel() {
    set({
      ...clearOverlays(),
      showSettings: true,
      settingsPanelEpoch: get().settingsPanelEpoch + 1,
    });
  },

  toggleQueuePanel() {
    const open = !get().showQueue;
    set({
      ...clearOverlays(),
      showQueue: open,
      queuePanelEpoch: open ? get().queuePanelEpoch + 1 : get().queuePanelEpoch,
    });
  },

  openQueuePanel() {
    set({
      ...clearOverlays(),
      showQueue: true,
      queuePanelEpoch: get().queuePanelEpoch + 1,
    });
  },

  openPreviewPanel() {
    set({
      ...clearOverlays(),
      showPreview: true,
      previewPanelEpoch: get().previewPanelEpoch + 1,
    });
  },

  toggleFoldersPanel() {
    const open = !get().showFolders;
    set({
      ...clearOverlays(),
      showFolders: open,
      foldersPanelEpoch: open ? get().foldersPanelEpoch + 1 : get().foldersPanelEpoch,
    });
  },

  openFoldersPanel() {
    set({
      ...clearOverlays(),
      showFolders: true,
      foldersPanelEpoch: get().foldersPanelEpoch + 1,
    });
  },

  openVjExportPanel() {
    set({
      ...clearOverlays(),
      showVjExport: true,
      vjExportPanelEpoch: get().vjExportPanelEpoch + 1,
    });
  },

  openVirtualDiskPanel() {
    set({
      ...clearOverlays(),
      showVirtualDisk: true,
      virtualDiskPanelEpoch: get().virtualDiskPanelEpoch + 1,
    });
  },

  openLyricsPanel() {
    set({
      ...clearOverlays(),
      showLyrics: true,
      lyricsPanelEpoch: get().lyricsPanelEpoch + 1,
    });
  },

  toggleLyricsPanel() {
    const open = !get().showLyrics;
    set({
      ...clearOverlays(),
      showLyrics: open,
      lyricsPanelEpoch: open ? get().lyricsPanelEpoch + 1 : get().lyricsPanelEpoch,
    });
  },

  currentOverlay() {
    const state = get();
    if (state.showFolders) return "folders";
    if (state.showSettings) return "settings";
    if (state.showPreview) return "preview";
    if (state.showQueue) return "queue";
    if (state.showVjExport) return "vjExport";
    if (state.showVirtualDisk) return "virtualDisk";
    if (state.showLyrics) return "lyrics";
    return null;
  },

  dismissOverlay() {
    const overlay = get().currentOverlay();
    set({ ...clearOverlays() });
    if (overlay) {
      void import("./navStore").then(({ useNavStore }) => {
        useNavStore.getState().rememberDismiss(overlay);
      });
    }
  },

  bootstrap() {
    if (bootInFlight) return bootInFlight;
    set({ booting: true });
    const run = (async () => {
      const [health, settings, accounts, searchCapabilities] = await Promise.allSettled([
        api.health(),
        api.getSettings(),
        api.accounts(),
        api.searchCapabilities(),
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
      if (searchCapabilities.status === "fulfilled") {
        set({ searchCapabilities: searchCapabilities.value });
      } else {
        // 能力接口失败不影响单曲搜索；UI 会退回“单曲”且不冒充支持集合。
        set({ searchCapabilities: {} });
      }
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
      // 保存失败时先回滚；主题会当场恢复，其他设置也会回到原值。
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
    useLibraryStore.getState().refreshUndo(),
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
