/**
 * 应用级状态：当前板块、health、设置、账号。
 * WS 事件也在这里统一分发给三个 store（见 connectEvents），
 * 组件不要自己 events.subscribe——那样每个组件都会各自处理一遍同一条事件。
 */

import { create } from "zustand";
import { api, events } from "../lib/api";
import { enqueueSettingsWrite } from "../lib/settingsWriteBarrier";
import { isPlatformEnabled, normalizeEnabledPlatforms } from "../lib/enabledPlatforms";
import { readWorkspaceSession } from "../lib/workspaceSession";
import type { Account, Health, SearchCapabilities, Settings, WsEvent } from "../types";
import { useDownloadStore } from "./downloadStore";
import { useWorkshopStore } from "./workshopStore";
import { useCompositionStore } from "./compositionStore";
import { useLibraryStore } from "./libraryStore";
import { useStreamBrowseStore } from "./streamBrowseStore";
import { useSidebarVisibilityStore } from "./sidebarVisibilityStore";

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

function mergeAccount(accounts: Account[], account: Account): Account[] {
  const index = accounts.findIndex((item) => item.platform === account.platform);
  return index >= 0
    ? accounts.map((item, itemIndex) => (itemIndex === index ? account : item))
    : [...accounts, account];
}

/**
 * 联网核验失败只说明“现在问不到平台”，不说明本地凭证或账号身份消失了。
 * provider 会把失败原因放进 detail；这里保留离线快照里的身份字段，避免一次网络
 * 抖动同时抹掉昵称、头像和在线目录的账号绑定。
 */
function mergeVerifiedAccounts(cached: Account[], verified: Account[]): Account[] {
  const cachedByPlatform = new Map(cached.map((account) => [account.platform, account]));
  return verified.map((account) => {
    if (account.state !== "unknown") return account;
    const previous = cachedByPlatform.get(account.platform);
    if (!previous) return account;
    return {
      ...account,
      account_key: account.account_key || previous.account_key,
      nickname: account.nickname || previous.nickname,
      avatar: account.avatar || previous.avatar,
      credential_kind: account.credential_kind || previous.credential_kind,
    };
  });
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
  /** 手动固定后，被动选歌或切换中间列表不能顶掉设置面板。 */
  settingsPinned: boolean;
  /** 强制把右栏/抽屉切到下载队列（曲库页也能看队列，不必先搜一次）。 */
  showQueue: boolean;
  queuePanelEpoch: number;
  /** 手动固定后，被动选歌/切换中间列表不能顶掉下载队列。 */
  queuePinned: boolean;
  showComposition: boolean;
  compositionPanelEpoch: number;
  compositionPinned: boolean;
  /** 右栏/抽屉显示搜索结果预览（音频试听或视频预览），与下载队列互斥。 */
  showPreview: boolean;
  previewPanelEpoch: number;
  /** 单栏布局下用抽屉装文件夹树（宽屏左栏常驻，不必走这条）。 */
  showFolders: boolean;
  foldersPanelEpoch: number;
  /** 右栏显示所选本地文件夹的重复曲目分析结果。 */
  showDuplicates: boolean;
  duplicateFolders: string[];
  duplicateAll: boolean;
  duplicateIncludeSubfolders: boolean;
  duplicatesPanelEpoch: number;
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
  /** 设置页正在向各平台核验账号；离线快照仍留在界面上。 */
  accountsRefreshing: boolean;
  booting: boolean;
  /** health 拉不通时的原因；空串 = sidecar 正常。 */
  bootError: string;
  savingSettings: boolean;
  /** 最近一次设置落盘失败；成功提交后清空。 */
  settingsError: string;

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
  setSettingsPinned(value: boolean): void;
  toggleQueuePanel(): void;
  openQueuePanel(): void;
  setQueuePinned(value: boolean): void;
  toggleCompositionPanel(): void;
  openCompositionPanel(): void;
  setCompositionPinned(value: boolean): void;
  /** 打开预览旁路（点搜索结果音频/视频时走这条，不跟下载队列挤一栏）。 */
  openPreviewPanel(): void;
  toggleFoldersPanel(): void;
  openFoldersPanel(): void;
  openDuplicatePanel(
    folders: string[],
    options?: { all?: boolean; includeSubfolders?: boolean },
  ): void;
  /** 打开右栏歌词面板。 */
  openLyricsPanel(): void;
  toggleLyricsPanel(): void;
  /** 只收起旁路面板，不改 listMode（窄屏抽屉点关闭 / 下拖时用）。 */
  dismissOverlay(): void;
  /** 当前打开的旁路面板种类；没有则 null。供浏览历史 / 撤销使用。 */
  currentOverlay():
    | "settings"
    | "queue"
    | "composition"
    | "preview"
    | "folders"
    | "duplicates"
    | "lyrics"
    | null;
  bootstrap(): Promise<void>;
  /** 账号面板使用：仅在后台核验结果过旧时检查，不向用户暴露刷新操作。 */
  verifyAccountsIfStale(): Promise<void>;
  refreshAccounts(): Promise<void>;
  setAccount(account: Account): void;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  handleEvent(event: WsEvent): void;
}

/** 打开某一块旁路面板时，把其余旁路关掉——互斥，避免关 A 露出 B。 */
function clearOverlays() {
  return {
    showSettings: false,
    settingsPinned: false,
    showQueue: false,
    showComposition: false,
    compositionPinned: false,
    showPreview: false,
    showFolders: false,
    showDuplicates: false,
    showLyrics: false,
    queuePinned: false,
  } as const;
}

/** 被动导航尊重手动固定的下载栏；显式打开其它旁路仍走 clearOverlays。 */
function clearPassiveOverlays(
  state: Pick<AppStore, "showSettings" | "settingsPinned" | "showQueue" | "queuePinned" | "showComposition" | "compositionPinned">,
) {
  if (state.showSettings && state.settingsPinned) {
    return { ...clearOverlays(), showSettings: true, settingsPinned: true } as const;
  }
  if (state.showQueue && state.queuePinned) {
    return { ...clearOverlays(), showQueue: true, queuePinned: true } as const;
  }
  if (state.showComposition && state.compositionPinned) {
    return { ...clearOverlays(), showComposition: true, compositionPinned: true } as const;
  }
  return clearOverlays();
}

/** StrictMode 下 effect 会跑两次，用同一个 promise 挡掉重复的启动请求。 */
let bootInFlight: Promise<void> | null = null;
/** 工作台启动闸门也要单飞；否则 StrictMode 会重复恢复缓存与目录快照。 */
let bootAllInFlight: Promise<void> | null = null;
/** 快照启动只在首个工作台画面之后校验一次磁盘；StrictMode 不能重复枚举。 */
let folderLiveRefreshScheduled = false;
/** 设置重复挂载与登录回调可能撞在一起；全平台账号核验只保留一趟。 */
let accountsRefreshInFlight: Promise<void> | null = null;
/** 自动核验失败也进入冷却，避免用户反复开关设置时持续请求第三方平台。 */
let accountsLastVerificationAttemptAt: number | null = null;
const ACCOUNT_VERIFICATION_COOLDOWN_MS = 30 * 60 * 1000;
/** 设置写入只有一条顺序通道；响应只允许兑现到发起它时的 intent。 */
let settingsIntent = 0;
let settingsPending = 0;
let persistedSettings: Settings | null = null;

export const useAppStore = create<AppStore>()((set, get) => ({
  listMode: "library",
  hasResults: false,
  showSettings: false,
  settingsPanelEpoch: 0,
  settingsPinned: false,
  showQueue: false,
  queuePanelEpoch: 0,
  queuePinned: false,
  showComposition: false,
  compositionPanelEpoch: 0,
  compositionPinned: false,
  showPreview: false,
  previewPanelEpoch: 0,
  showFolders: false,
  foldersPanelEpoch: 0,
  showDuplicates: false,
  duplicateFolders: [],
  duplicateAll: false,
  duplicateIncludeSubfolders: true,
  duplicatesPanelEpoch: 0,
  showLyrics: false,
  lyricsPanelEpoch: 0,
  health: null,
  settings: null,
  accounts: [],
  searchCapabilities: {},
  accountsError: "",
  accountsRefreshing: false,
  booting: true,
  bootError: "",
  savingSettings: false,
  settingsError: "",

  setListMode(mode) {
    // 用户点了曲库/搜索/文件夹，就是在切换当前关注的内容；旁路面板
    // 应该自动让位，不能逼用户先找到右上角的关闭按钮。
    set((state) => ({ listMode: mode, ...clearPassiveOverlays(state) }));
  },

  setHasResults(value) {
    // 只撑开中间搜索半栏；不改 listMode、不清旁路——右栏继续留着曲目详情，
    // 等真有下载任务再 openQueuePanel。
    set({ hasResults: value });
  },

  showTrackDetail() {
    set((state) => ({ listMode: "library", ...clearPassiveOverlays(state) }));
  },

  focusLibrary() {
    set((state) => (
      (state.showSettings && state.settingsPinned) || (state.showQueue && state.queuePinned) || (state.showComposition && state.compositionPinned)
    ) ? {
      listMode: "library",
      ...clearPassiveOverlays(state),
    } : {
      listMode: "library",
      showSettings: false,
      settingsPinned: false,
      showQueue: false,
      showComposition: false,
      compositionPinned: false,
      showPreview: false,
      showFolders: false,
      showDuplicates: false,
      queuePinned: false,
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

  setSettingsPinned(value) {
    set({ settingsPinned: get().showSettings ? value : false });
  },

  toggleQueuePanel() {
    const open = !get().showQueue;
    set({
      ...clearOverlays(),
      showQueue: open,
      // 顶栏下载按钮是明确的手动打开动作，打开后默认固定。
      queuePinned: open,
      queuePanelEpoch: open ? get().queuePanelEpoch + 1 : get().queuePanelEpoch,
    });
  },

  openQueuePanel() {
    const pinned = get().showQueue && get().queuePinned;
    set({
      ...clearOverlays(),
      showQueue: true,
      // 入队自动弹出不强制固定；已经由用户固定的则保持。
      queuePinned: pinned,
      queuePanelEpoch: get().queuePanelEpoch + 1,
    });
  },

  setQueuePinned(value) {
    set({ queuePinned: get().showQueue ? value : false });
  },

  toggleCompositionPanel() {
    const open = !get().showComposition;
    set({ ...clearOverlays(), showComposition: open, compositionPinned: open,
      compositionPanelEpoch: get().compositionPanelEpoch + (open ? 1 : 0) });
  },
  openCompositionPanel() {
    set({ ...clearOverlays(), showComposition: true, compositionPinned: true,
      compositionPanelEpoch: get().compositionPanelEpoch + 1 });
  },
  setCompositionPinned(value) { set({ compositionPinned: get().showComposition ? value : false }); },

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

  openDuplicatePanel(folders, options) {
    const unique = [...new Set(folders.map((folder) => folder.trim()).filter(Boolean))];
    const all = options?.all === true;
    if (!all && unique.length === 0) return;
    set({
      ...clearOverlays(),
      showDuplicates: true,
      duplicateFolders: unique,
      duplicateAll: all,
      duplicateIncludeSubfolders: options?.includeSubfolders ?? true,
      duplicatesPanelEpoch: get().duplicatesPanelEpoch + 1,
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
    if (state.showComposition) return "composition";
    if (state.showDuplicates) return "duplicates";
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
    const run = (async () => {
      const [health, settings, accounts, searchCapabilities] = await Promise.allSettled([
        api.health(),
        api.getSettings(),
        api.cachedAccounts(),
        api.searchCapabilities(),
      ]);
      if (health.status === "fulfilled") {
        set({ health: health.value, bootError: "" });
      } else {
        set({ health: null, bootError: errorText(health.reason) });
      }
      if (settings.status === "fulfilled") {
        persistedSettings = settings.value;
        set({ settings: settings.value, settingsError: "" });
        applyTheme(settings.value.theme);
      }
      // 账号拉不到不挡启动，但要把原因留下：登录面板不然只会一直写着"稍等一下"
      if (accounts.status === "fulfilled") {
        const startupForeground = useStreamBrowseStore
          .getState()
          .hydrateForStartup(accounts.value, readWorkspaceSession());
        set({
          accounts: accounts.value,
          accountsError: "",
          // 在线前台的目标、侧栏高亮与工作区可见性必须在第一次挂载前一起就绪。
          ...(startupForeground ? { listMode: "search" as const, hasResults: true } : {}),
        });
      } else {
        // 读取失败时不调用 hydrateForStartup：不能把“接口暂时失败”误判成全部登出，
        // 从而删掉仍可信的账号绑定缓存。
        set({ accountsError: `账号状态拉取失败：${errorText(accounts.reason)}` });
      }
      if (searchCapabilities.status === "fulfilled") {
        set({ searchCapabilities: searchCapabilities.value });
      } else {
        // 能力接口失败不影响单曲搜索；UI 会退回“单曲”且不冒充支持集合。
        set({ searchCapabilities: {} });
      }
    })().finally(() => {
      bootInFlight = null;
    });
    bootInFlight = run;
    return run;
  },

  verifyAccountsIfStale() {
    if (accountsRefreshInFlight) return accountsRefreshInFlight;
    const now = Date.now();
    if (
      accountsLastVerificationAttemptAt !== null
      && now - accountsLastVerificationAttemptAt >= 0
      && now - accountsLastVerificationAttemptAt < ACCOUNT_VERIFICATION_COOLDOWN_MS
    ) {
      return Promise.resolve();
    }
    return get().refreshAccounts();
  },

  refreshAccounts() {
    if (accountsRefreshInFlight) return accountsRefreshInFlight;
    accountsLastVerificationAttemptAt = Date.now();
    set({ accountsRefreshing: true, accountsError: "" });
    const run = (async () => {
      try {
        const verified = await api.accounts();
        set((state) => ({
          accounts: mergeVerifiedAccounts(state.accounts, verified),
          accountsError: "",
        }));
      } catch (error) {
        // 保留已经显示的离线快照；请求本身失败不等于六个平台全掉线。
        set({ accountsError: `账号状态刷新失败：${errorText(error)}` });
      } finally {
        set({ accountsRefreshing: false });
      }
    })().finally(() => {
      accountsRefreshInFlight = null;
    });
    accountsRefreshInFlight = run;
    return run;
  },

  setAccount(account) {
    set({ accounts: mergeAccount(get().accounts, account) });
  },

  saveSettings(patch) {
    const current = get().settings;
    if (!current) return Promise.resolve();
    persistedSettings ??= current;
    const next: Settings = { ...current, ...patch };
    const accountContextChanged =
      Object.prototype.hasOwnProperty.call(patch, "enabled_platforms") ||
      Object.prototype.hasOwnProperty.call(patch, "soundcloud_enabled");
    const intent = ++settingsIntent;
    settingsPending += 1;
    // 先本地生效（主题切换要立刻看到），失败再回滚
    set({ settings: next, savingSettings: true, settingsError: "" });
    applyTheme(next.theme);

    const commit = async () => {
      try {
        const saved = await api.putSettings(next);
        persistedSettings = saved;
        // 重新启用下载源时恢复被右键收起的侧栏入口；保存失败则保留隐藏偏好。
        useSidebarVisibilityStore.getState().restorePlatforms(
          normalizeEnabledPlatforms(saved.enabled_platforms).filter(
            (platform) => !isPlatformEnabled(current, platform),
          ),
        );
        // 后面还有用户操作时，这个旧响应只更新“已落盘基线”，不能盖掉新意图。
        if (intent === settingsIntent) {
          set({ settings: saved, settingsError: "" });
          applyTheme(saved.theme);
          if (saved.auto_start_downloads && !current.auto_start_downloads) {
            void import("../lib/mediaActions").then(({ resumePendingDownloadPreparations }) =>
              resumePendingDownloadPreparations(),
            );
          }
          // provider 的“已启用/未启用”说明来自后端 live context。下载源开关保存后
          // 立即重读本地快照，避免开关已经显示“开”，账号行还残留“未启用”。
          if (accountContextChanged) {
            try {
              const accounts = await api.cachedAccounts();
              if (intent === settingsIntent) {
                set({ accounts, accountsError: "" });
              }
            } catch (error) {
              if (intent === settingsIntent) {
                set({ accountsError: `账号状态刷新失败：${errorText(error)}` });
              }
            }
          }
        }
      } catch (error) {
        if (intent === settingsIntent && persistedSettings) {
          set({
            settings: persistedSettings,
            settingsError: `设置没有保存：${errorText(error)}`,
          });
          applyTheme(persistedSettings.theme);
        }
        throw error;
      } finally {
        settingsPending = Math.max(0, settingsPending - 1);
        set({ savingSettings: settingsPending > 0 });
      }
    };
    return enqueueSettingsWrite(commit);
  },

  handleEvent(event) {
    if (event.type === "account.changed") {
      set({ accounts: mergeAccount(get().accounts, event.payload) });
    }
  },
}));

/** sidecar 是否可用：health 拿到过且没有连接错误。 */
export function selectConnected(state: AppStore): boolean {
  return state.health !== null && state.bootError === "";
}

/**
 * 启动 / 重试统一闸门：health、设置、账号目录缓存、曲库目录快照、下载与统计一起恢复。
 * 工作台只在这批完成后挂载；有目录快照时，真实磁盘校验延到首帧之后。
 */
export async function bootAll(): Promise<void> {
  if (bootAllInFlight) return bootAllInFlight;
  useAppStore.setState({ booting: true });
  const run = (async () => {
    await Promise.allSettled([
      useAppStore.getState().bootstrap(),
      useDownloadStore.getState().refresh(),
      useCompositionStore.getState().refresh(),
      useLibraryStore.getState().restoreFoldersForStartup(),
      useLibraryStore.getState().refreshStats(),
      useLibraryStore.getState().refreshUndo(),
    ]);
    useAppStore.setState({ booting: false });
    const library = useLibraryStore.getState();
    if (library.folderStartupSource === "snapshot" && !folderLiveRefreshScheduled) {
      folderLiveRefreshScheduled = true;
      const refresh = () => {
        void useLibraryStore.getState().refreshFolders();
      };
      // 两个 animation frame 把实时磁盘枚举明确放到工作台首帧之后；刷新期间 Store
      // 继续持有快照，完整结果回来才一次替换。
      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => window.requestAnimationFrame(refresh));
      } else {
        setTimeout(refresh, 0);
      }
    }
  })().finally(() => {
    bootAllInFlight = null;
  });
  bootAllInFlight = run;
  return run;
}

/** 全局唯一的 WS 订阅点：一条事件按 type 分发给各 store 自己的 handleEvent。 */
export function connectEvents(): () => void {
  return events.subscribe((event) => {
    useAppStore.getState().handleEvent(event);
    useDownloadStore.getState().handleEvent(event);
    useCompositionStore.getState().handleEvent(event);
    useWorkshopStore.getState().handleEvent(event);
    useLibraryStore.getState().handleEvent(event);
  });
}
