/**
 * 浏览历史：回到「上一个打开的地方」。
 *
 * 记的是工作台地点（曲库/搜索、文件夹、旁路面板、在线内容），不是播放进度。
 * 顶栏左上角的返回键在地点栈里往回走；撤销优先恢复刚关掉的旁路面板，没有可恢复的
 * 面板时退化为后退一步。
 *
 * 在线内容（搜索结果、打开的合集或歌单）归 Workspace 管：它把每一份送到屏上的列表
 * 存档，在这里只留一个编号（`search`），回去时由它按编号把列表原样放回来。
 */

import { create } from "zustand";
import { useAppStore, type ListMode } from "./appStore";
import { useLibraryStore } from "./libraryStore";
import { useCompositionStore } from "./compositionStore";

export type OverlayKind =
  | "settings"
  | "queue"
  | "composition"
  | "preview"
  | "folders"
  | "duplicates"
  | "lyrics";

/** Which of the stage's panes is the one on screen; null when both are (the local list pinned). */
export type NavPane = "local" | "search" | null;

export interface Place {
  listMode: ListMode;
  folder: string;
  folderDeep: boolean;
  selectedId: number | null;
  overlay: OverlayKind | null;
  /** The online list on screen, by the number Workspace archived it under; null when none. */
  search: number | null;
  pane: NavPane;
}

/** What the workspace adds to a place, and how it brings one back. */
export interface WorkspaceNav {
  read(): { search: number | null; pane: NavPane };
  apply(search: number | null, pane: NavPane): void;
}

const MAX = 80;

let workspaceNav: WorkspaceNav | null = null;

/** Workspace registers itself while mounted; returns the unregister. */
export function registerWorkspaceNav(nav: WorkspaceNav): () => void {
  workspaceNav = nav;
  return () => {
    if (workspaceNav === nav) workspaceNav = null;
  };
}

function overlayOf(): OverlayKind | null {
  const app = useAppStore.getState();
  if (app.showFolders) return "folders";
  if (app.showSettings) return "settings";
  if (app.showPreview) return "preview";
  if (app.showQueue) return "queue";
  if (app.showComposition) return "composition";
  if (app.showDuplicates) return "duplicates";
  if (app.showLyrics) return "lyrics";
  return null;
}

export function readPlace(): Place {
  const app = useAppStore.getState();
  const lib = useLibraryStore.getState();
  const workspace = workspaceNav?.read() ?? { search: null, pane: null };
  return {
    listMode: app.listMode,
    folder: lib.filter.folder,
    folderDeep: lib.filter.folderDeep,
    selectedId: lib.selectedId,
    overlay: overlayOf(),
    search: workspace.search,
    pane: workspace.pane,
  };
}

/**
 * The same place, whichever song is selected in it: picking songs is not going somewhere, so
 * it does not grow the history, but the place remembers the last pick (see `commit`).
 */
export function samePlace(a: Place, b: Place): boolean {
  return (
    a.listMode === b.listMode &&
    a.folder === b.folder &&
    a.folderDeep === b.folderDeep &&
    a.overlay === b.overlay &&
    a.search === b.search &&
    a.pane === b.pane
  );
}

/** 应用地点时抬起，避免自己触发的 store 变更再 push 进历史。 */
let applying = false;

export function isApplyingNav(): boolean {
  return applying;
}

function applyOverlay(overlay: OverlayKind | null): void {
  const app = useAppStore.getState();
  if (overlay === "settings") app.openSettingsPanel();
  else if (overlay === "preview") app.openPreviewPanel();
  else if (overlay === "queue") app.openQueuePanel();
  else if (overlay === "composition" && useCompositionStore.getState().tasks.length > 0) app.openCompositionPanel();
  else if (overlay === "folders") app.openFoldersPanel();
  else if (overlay === "duplicates")
    app.openDuplicatePanel(app.duplicateFolders, {
      all: app.duplicateAll,
      includeSubfolders: app.duplicateIncludeSubfolders,
    });
  else if (overlay === "lyrics") app.openLyricsPanel();
  else app.dismissOverlay();
}

export function applyPlace(place: Place): void {
  applying = true;
  try {
    const lib = useLibraryStore.getState();
    // 不走 setListMode：它会清 overlay 并打乱恢复顺序
    useAppStore.setState({
      listMode: place.listMode,
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
    });
    if (lib.filter.folder !== place.folder || lib.filter.folderDeep !== place.folderDeep) {
      lib.setFilter({ folder: place.folder, folderDeep: place.folderDeep });
    }
    if (place.selectedId !== null && lib.selectedId !== place.selectedId) {
      lib.select(place.selectedId, "replace");
    } else if (place.selectedId === null && lib.selectedId !== null) {
      lib.select(null, "replace");
    }
    workspaceNav?.apply(place.search, place.pane);
    applyOverlay(place.overlay);
  } finally {
    queueMicrotask(() => {
      applying = false;
    });
  }
}

interface NavStore {
  past: Place[];
  present: Place | null;
  future: Place[];
  /** 刚关掉的旁路面板，供「撤销」一键打开。 */
  dismissedOverlay: OverlayKind | null;
  canBack: boolean;
  canForward: boolean;
  canUndo: boolean;

  /** 当前地点有实质变化时压栈（由 Workspace 订阅触发）。 */
  commit(place?: Place): void;
  back(): void;
  forward(): void;
  /** 恢复刚关掉的面板；没有则后退一步。 */
  undo(): void;
  rememberDismiss(overlay: OverlayKind | null): void;
  /** Every archived online list the history can still return to (for Workspace to keep). */
  searchesKept(): Set<number>;
}

function flags(state: Pick<NavStore, "past" | "future" | "dismissedOverlay" | "present">) {
  return {
    canBack: state.past.length > 0,
    canForward: state.future.length > 0,
    canUndo: state.dismissedOverlay !== null || state.past.length > 0,
  };
}

export const useNavStore = create<NavStore>()((set, get) => ({
  past: [],
  present: null,
  future: [],
  dismissedOverlay: null,
  canBack: false,
  canForward: false,
  canUndo: false,

  commit(place) {
    if (applying) return;
    const next = place ?? readPlace();
    const { present, past } = get();
    if (present && samePlace(present, next)) {
      // The same place with another song picked: the place keeps the pick, the stack stays.
      if (present.selectedId !== next.selectedId) set({ present: next });
      return;
    }
    const grown = present ? [...past, present] : past;
    const trimmed = grown.length > MAX ? grown.slice(grown.length - MAX) : grown;
    set({
      past: trimmed,
      present: next,
      future: [],
      ...flags({ past: trimmed, future: [], dismissedOverlay: get().dismissedOverlay, present: next }),
    });
  },

  back() {
    const { past, present, future, dismissedOverlay } = get();
    if (past.length === 0 || !present) return;
    const prev = past[past.length - 1];
    const nextPast = past.slice(0, -1);
    const nextFuture = [present, ...future];
    set({
      past: nextPast,
      present: prev,
      future: nextFuture,
      ...flags({ past: nextPast, future: nextFuture, dismissedOverlay, present: prev }),
    });
    applyPlace(prev);
  },

  forward() {
    const { past, present, future, dismissedOverlay } = get();
    if (future.length === 0 || !present) return;
    const next = future[0];
    const nextFuture = future.slice(1);
    const nextPast = [...past, present];
    set({
      past: nextPast,
      present: next,
      future: nextFuture,
      ...flags({ past: nextPast, future: nextFuture, dismissedOverlay, present: next }),
    });
    applyPlace(next);
  },

  undo() {
    const dismissed = get().dismissedOverlay;
    if (dismissed) {
      set({
        dismissedOverlay: null,
        ...flags({ ...get(), dismissedOverlay: null }),
      });
      applyOverlay(dismissed);
      get().commit();
      return;
    }
    get().back();
  },

  rememberDismiss(overlay) {
    if (!overlay) return;
    set({
      dismissedOverlay: overlay,
      ...flags({ ...get(), dismissedOverlay: overlay }),
    });
  },

  searchesKept() {
    const { past, present, future } = get();
    const kept = new Set<number>();
    for (const place of [...past, ...(present ? [present] : []), ...future]) {
      if (place.search !== null) kept.add(place.search);
    }
    return kept;
  },
}));
