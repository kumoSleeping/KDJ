import { useEffect, useRef } from "react";
import type { SongSource } from "../types";
import { api } from "./api";
import { copyText } from "./copyText";
import { resolveLibraryPasteOp } from "./libraryPaste";
import { isOutsideFolder } from "./outsideFolder";
import { useAppStore } from "../stores/appStore";
import { useDownloadStore } from "../stores/downloadStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useQueueStore } from "../stores/queueStore";

/**
 * 曲目表 / 搜索结果表的复制 · 剪切 · 粘贴 · 全选快捷键。
 *
 * Mac 用 Cmd、其它平台用 Ctrl，两个都认（`metaKey || ctrlKey`）。
 * Cmd+V：按设置「链接」或「复制文件」；Cmd+Option+V / Ctrl+Alt+V：移动。
 * 剪切（X）后再 V 也是移动。
 *
 * 正在输入时一律不接管：搜索框里按 Cmd+C 要复制的是选中文字。
 *
 * macOS 上 Option+V 会把 `event.key` 变成 √，必须用 `event.code === "KeyV"`。
 */

export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** 搜索半栏快捷键：由 Workspace 注入当前勾选与入队动作。 */
export type SearchListClipboard = {
  /** 中间栏正显示搜索结果。 */
  active: () => boolean;
  selectAll: () => void;
  chosenSources: () => SongSource[];
  /** 把当前勾选加入下载队列（不立刻开下，等「开始下载」）。 */
  enqueueChosen: () => void | Promise<void>;
};

/** 搜索结果 Cmd+C 暂存，可在曲库文件夹里 Cmd+V 下到当前夹。 */
let searchClip: SongSource[] | null = null;

function isModKey(event: KeyboardEvent, letter: string): boolean {
  return event.code === `Key${letter.toUpperCase()}` || event.key.toLowerCase() === letter;
}

export function useLibraryClipboard(search?: SearchListClipboard): void {
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (isEditable(event.target)) return;

      const isA = isModKey(event, "a");
      const isC = isModKey(event, "c");
      const isX = isModKey(event, "x");
      const isV = isModKey(event, "v");
      if (!isA && !isC && !isX && !isV) return;

      const withAlt = event.altKey;
      // Option/Alt 只给 V 用（强制移动）；其它键带 Option 不接管。
      if (withAlt && !isV) return;

      const search = searchRef.current;
      const target = event.target as HTMLElement | null;
      const inResults = Boolean(target?.closest?.('[data-kind="results"]'));
      const inLibrary = Boolean(target?.closest?.('[data-kind="library"]'));
      const searchActive = search?.active() ?? false;
      const chosen = searchActive ? search!.chosenSources() : [];
      const librarySelected = useLibraryStore.getState().selectedIds.length > 0;
      // 点在哪张表就听哪张；否则有勾选的那边优先；都没有时搜索开着归搜索。
      const preferSearch = inResults
        ? searchActive
        : inLibrary
          ? false
          : chosen.length > 0
            ? true
            : librarySelected
              ? false
              : searchActive;

      if (isA) {
        event.preventDefault();
        if (preferSearch) {
          search!.selectAll();
          return;
        }
        useLibraryStore.getState().selectAll();
        return;
      }

      if (isC || isX) {
        // 页面文字选区优先于曲目/搜索剪贴板。
        const textSelection = window.getSelection();
        if (textSelection && !textSelection.isCollapsed && textSelection.toString()) return;

        if (preferSearch) {
          if (chosen.length === 0) return;
          event.preventDefault();
          searchClip = [...chosen];
          const labels = chosen.map((source) => {
            const artist = source.artists.filter(Boolean).join(", ");
            return artist ? `${source.title} — ${artist}` : source.title || source.key;
          });
          void copyText(labels.join("\n"));
          return;
        }

        const store = useLibraryStore.getState();
        if (store.selectedIds.length === 0) return;
        event.preventDefault();
        store.copyToClipboard(isX ? "move" : "link");
        return;
      }

      // isV
      if (preferSearch) {
        // 搜索里粘贴 = 把勾选（或刚复制的源）加入下载列表。
        const sources = chosen.length > 0 ? chosen : searchClip;
        if (!sources || sources.length === 0) return;
        event.preventDefault();
        if (chosen.length > 0) {
          void search!.enqueueChosen();
        } else {
          const quality = useAppStore.getState().settings?.default_quality ?? null;
          void useDownloadStore
            .getState()
            .enqueue(sources, { quality })
            .then(() => useAppStore.getState().openQueuePanel())
            .catch(() => undefined);
        }
        return;
      }

      const store = useLibraryStore.getState();

      // 曲库剪贴板优先；没有的话，搜索复制过来的源可以 V 进当前文件夹下载。
      if (!store.clipboard && searchClip && searchClip.length > 0) {
        const dest = store.filter.folder;
        if (!dest || isOutsideFolder(dest) || store.queueView) return;
        event.preventDefault();
        const quality = useAppStore.getState().settings?.default_quality ?? null;
        void useDownloadStore
          .getState()
          .enqueue(searchClip, { quality, dest_dir: dest })
          .then(() => useAppStore.getState().openQueuePanel())
          .catch(() => undefined);
        return;
      }

      if (store.queueView && store.clipboard && !withAlt) {
        event.preventDefault();
        const ids = store.clipboard.ids;
        void Promise.allSettled(ids.map((id) => api.track(id))).then((results) => {
          const tracks = results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          );
          if (tracks.length > 0) useQueueStore.getState().add(tracks);
        });
        return;
      }

      const dest = store.filter.folder;
      if (!store.clipboard || !dest || isOutsideFolder(dest)) return;
      event.preventDefault();
      const op = resolveLibraryPasteOp({
        settings: useAppStore.getState().settings,
        forceMove: withAlt,
        clipboardOp: store.clipboard.op,
      });
      void store.paste(dest, op);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
