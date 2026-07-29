/**
 * 浏览历史：回到「上一个打开的地方」。
 *
 * 记的是工作台地点（曲库/搜索、文件夹、旁路面板、选中曲），
 * 不是播放进度。← → 在地点栈里走；撤销优先恢复刚关掉的旁路面板，
 * 没有可恢复的面板时退化为后退一步。
 */

import { create } from "zustand";
import { useAppStore, type ListMode } from "./appStore";
import { useLibraryStore } from "./libraryStore";

export type OverlayKind = "settings" | "queue" | "preview" | "folders" | "vjExport";

export interface Place {
  listMode: ListMode;
  folder: string;
  folderDeep: boolean;
  queueView: boolean;
  selectedId: number | null;
  overlay: OverlayKind | null;
}

const MAX = 80;

function overlayOf(): OverlayKind | null {
  const app = useAppStore.getState();
  if (app.showFolders) return "folders";
  if (app.showSettings) return "settings";
  if (app.showPreview) return "preview";
  if (app.showQueue) return "queue";
  if (app.showVjExport) return "vjExport";
  return null;
}

export function readPlace(): Place {
  const app = useAppStore.getState();
  const lib = useLibraryStore.getState();
  return {
    listMode: app.listMode,
    folder: lib.filter.folder,
    folderDeep: lib.filter.folderDeep,
    queueView: lib.queueView,
    selectedId: lib.selectedId,
    overlay: overlayOf(),
  };
}

function samePlace(a: Place, b: Place): boolean {
  return (
    a.listMode === b.listMode &&
    a.folder === b.folder &&
    a.folderDeep === b.folderDeep &&
    a.queueView === b.queueView &&
    a.selectedId === b.selectedId &&
    a.overlay === b.overlay
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
  else if (overlay === "folders") app.openFoldersPanel();
  else if (overlay === "vjExport") app.openVjExportPanel();
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
      showQueue: false,
      showPreview: false,
      showFolders: false,
      showVjExport: false,
    });
    if (lib.queueView !== place.queueView) lib.setQueueView(place.queueView);
    if (lib.filter.folder !== place.folder || lib.filter.folderDeep !== place.folderDeep) {
      lib.setFilter({ folder: place.folder, folderDeep: place.folderDeep });
    }
    if (place.selectedId !== null && lib.selectedId !== place.selectedId) {
      lib.select(place.selectedId, "replace");
    } else if (place.selectedId === null && lib.selectedId !== null) {
      lib.select(null, "replace");
    }
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
    if (present && samePlace(present, next)) return;
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
}));
