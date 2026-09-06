import { createStore, type StoreApi } from "zustand/vanilla";
import { api } from "../lib/api";
import { LibraryWindow } from "../lib/libraryWindow";
import { cycleTableSort } from "../lib/tableSort";
import { DEFAULT_FILTER, useLibraryStore, type LibraryStore } from "./libraryStore";

/** A list owns its query, cache and selection; file operations and clipboard stay shared. */
export type LibraryPaneStore = Pick<LibraryStore,
  | "orderedIds" | "indexById" | "summaryById" | "queryVersion" | "requestLatency"
  | "ensureRange" | "resolveSummaries" | "retryList" | "total" | "loading" | "loadingMore" | "error"
  | "filter" | "setFilter" | "cycleSort" | "selectedId" | "selectedIds" | "selectedTrack"
  | "select" | "selectAll" | "selectionMode" | "setSelectionMode" | "clipboard" | "copyToClipboard"
  | "paste" | "applyFolderOp" | "undo" | "undoLast" | "removeTracks" | "startAnalyze" | "updateTrack"
>;
export type LibraryPaneStoreApi = StoreApi<LibraryPaneStore>;

let nextId = 0;

export function createTemporaryLibrary(folder: string) {
  let store: LibraryPaneStoreApi;
  let detailSequence = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const lane = new LibraryWindow({
    index: (query, signal) => api.trackIndex(query, signal),
    summaries: (ids, query, signal) => api.trackSummaries(ids, query, signal),
    publish: (snapshot) => {
      store.setState(snapshot);
      const current = store.getState();
      if (!snapshot.loading) {
        const ids = current.selectedIds.filter((id) => snapshot.indexById.has(id));
        if (ids.length !== current.selectedIds.length) {
          store.setState({ selectedIds: ids, selectedId: ids.at(-1) ?? null, selectedTrack: null });
        }
      }
    },
  });
  const load = () => {
    const { filter } = store.getState();
    lane.changeQuery({ folder: filter.folder, folder_deep: true, q: filter.q,
      sort: filter.sort, order: filter.order, sort2: filter.sort2 ?? undefined,
      order2: filter.sort2 ? filter.order2 : undefined });
    return lane.refreshIndex();
  };
  const readDetail = async (id: number | null) => {
    const sequence = ++detailSequence;
    if (id === null) return;
    try {
      const track = await api.track(id);
      if (sequence === detailSequence && store.getState().selectedId === id) store.setState({ selectedTrack: track });
    } catch { /* List errors have their own retry control. */ }
  };
  store = createStore<LibraryPaneStore>((set, get) => ({
    orderedIds: [], indexById: new Map(), summaryById: new Map(), queryVersion: 0, requestLatency: 200,
    total: 0, loading: true, loadingMore: false, error: "",
    filter: { ...DEFAULT_FILTER, folder, sort: "custom" },
    selectedId: null, selectedIds: [], selectedTrack: null, selectionMode: false,
    clipboard: useLibraryStore.getState().clipboard, undo: useLibraryStore.getState().undo,
    ensureRange: (...args) => lane.ensureRange(...args),
    resolveSummaries: (ids) => lane.resolveIds(ids), retryList: () => lane.retry(),
    setFilter(patch) {
      set({ filter: { ...get().filter, ...patch } });
      void load();
    },
    cycleSort(column) { get().setFilter(cycleTableSort(get().filter, column, "custom", "asc")); },
    select(id, mode = "replace") {
      const current = get();
      let ids = id === null ? [] : [id];
      if (id !== null && mode === "toggle") {
        ids = current.selectedIds.includes(id) ? current.selectedIds.filter((item) => item !== id) : [...current.selectedIds, id];
      } else if (id !== null && mode === "range" && current.selectedId !== null) {
        const from = current.indexById.get(current.selectedId);
        const to = current.indexById.get(id);
        if (from !== undefined && to !== undefined) ids = current.orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1);
      }
      const selectedId = id !== null && ids.includes(id) ? id : ids.at(-1) ?? null;
      set({ selectedId, selectedIds: ids, selectedTrack: current.selectedTrack?.id === selectedId ? current.selectedTrack : null,
        ...(id === null ? { selectionMode: false } : {}) });
      void readDetail(selectedId);
    },
    selectAll() {
      const selectedId = get().selectedId ?? get().orderedIds[0] ?? null;
      set({ selectedIds: [...get().orderedIds], selectedId });
      void readDetail(selectedId);
    },
    setSelectionMode: (on) => set({ selectionMode: on }),
    copyToClipboard(op) {
      if (get().selectedIds.length) useLibraryStore.setState({ clipboard: { ids: [...get().selectedIds], op } });
    },
    async paste(dest, op) {
      const clip = useLibraryStore.getState().clipboard;
      if (!clip || !dest) return null;
      const used = op ?? clip.op;
      const result = await get().applyFolderOp(clip.ids, dest, used);
      if (used === "move") useLibraryStore.setState({ clipboard: null });
      return result;
    },
    async applyFolderOp(ids, dest, op) {
      const result = await api.applyFolderOp(ids, dest, op);
      useLibraryStore.setState({ undo: result.undo, undoError: "" });
      await Promise.all([lane.refreshChanged(ids), useLibraryStore.getState().refresh()]);
      void useLibraryStore.getState().refreshFolders();
      void useLibraryStore.getState().refreshStats();
      return result;
    },
    undoLast: () => useLibraryStore.getState().undoLast(),
    removeTracks: (ids, file) => useLibraryStore.getState().removeTracks(ids, file),
    startAnalyze: (...args) => useLibraryStore.getState().startAnalyze(...args),
    updateTrack: (id, patch) => useLibraryStore.getState().updateTrack(id, patch),
  }));
  return {
    id: ++nextId,
    store,
    /** Effect-owned so StrictMode cleanup/restart also cancels the previous request generation. */
    mount() {
      void load();
      const unsubscribe = useLibraryStore.subscribe((next, previous) => {
        store.setState({ clipboard: next.clipboard, undo: next.undo });
        if (next.orderedIds === previous.orderedIds && next.summaryById === previous.summaryById) return;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          const ids = [...store.getState().summaryById.keys()];
          lane.invalidate(ids);
          void lane.refreshChanged(ids);
        }, 150);
      });
      return () => {
        unsubscribe();
        clearTimeout(refreshTimer);
        detailSequence += 1;
        lane.dispose();
      };
    },
  };
}
export type TemporaryLibrary = ReturnType<typeof createTemporaryLibrary>;
