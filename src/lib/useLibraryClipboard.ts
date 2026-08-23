import { useEffect, useRef } from "react";
import type { SongSource } from "../types";
import { copyText } from "./copyText";
import { resolveLibraryPasteOp } from "./libraryPaste";
import { isOutsideFolder } from "./outsideFolder";
import { useAppStore } from "../stores/appStore";
import { useDownloadStore } from "../stores/downloadStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaylistStore } from "../stores/playlistStore";

/**
 * 曲目表 / 搜索结果表的复制 · 剪切 · 粘贴 · 全选快捷键。
 *
 * Mac 用 Cmd、其它平台用 Ctrl，两个都认（`metaKey || ctrlKey`）。
 * Cmd+V：复制一份独立的本地文件；Cmd+Option+V / Ctrl+Alt+V：移动；Cmd/Ctrl+Z 撤回最近的复制、移动或删除批次。
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
  /** 多板块同时可见且键盘焦点不在表内时，当前是否以在线结果为主板块。 */
  preferred?: () => boolean;
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
      const isZ = isModKey(event, "z");
      if (!isA && !isC && !isX && !isV && !isZ) return;

      const withAlt = event.altKey;
      // Option/Alt 只给 V 用（强制移动）；其它键带 Option 不接管。
      if (withAlt && !isV) return;

      if (isZ) {
        // Shift+Cmd/Ctrl+Z 是重做，当前只实现单向撤回，不拦截系统快捷键。
        if (event.shiftKey) return;
        const store = useLibraryStore.getState();
        if (!store.undo.available) return;
        event.preventDefault();
        void store.undoLast().catch(() => undefined);
        return;
      }

      const search = searchRef.current;
      const target = event.target as HTMLElement | null;
      const inResults = Boolean(target?.closest?.('[data-kind="results"]'));
      const inLibrary = Boolean(target?.closest?.('[data-kind="library"]'));
      const inOneLibrary = Boolean(target?.closest?.('[data-kind="onelibrary"]'));
      const oneLibraryTarget = usePlaylistStore.getState().selectedTarget;
      const searchActive = search?.active() ?? false;
      const searchPreferred = searchActive && (search?.preferred?.() ?? false);
      const chosen = searchActive ? search!.chosenSources() : [];
      const librarySelected = useLibraryStore.getState().selectedIds.length > 0;
      // 点在哪张表就听哪张；否则有勾选的那边优先；都没有时搜索开着归搜索。
      const preferSearch = inResults
        ? searchActive
        : inLibrary
          ? false
          : searchPreferred
            ? true
          : chosen.length > 0
            ? true
            : librarySelected
              ? false
              : searchActive;

      if (inOneLibrary && oneLibraryTarget) {
        const playlist = usePlaylistStore.getState();
        if (isA) {
          event.preventDefault();
          playlist.selectAllTracks();
          return;
        }
        if (isC) {
          const chosenIds = new Set(playlist.selectedContentIds);
          const labels = playlist.selectedTracks
            .filter((track) => chosenIds.has(track.content_id))
            .map((track) => {
              const title = track.title || track.filename;
              return track.artist ? `${title} — ${track.artist}` : title;
            });
          if (labels.length > 0) {
            event.preventDefault();
            void copyText(labels.join("\n"));
          }
          return;
        }
        // OneLibrary 的 X 不删除外置文件，也不伪装成本地剪贴板；移除列表关联
        // 走 Delete/Backspace 或明确菜单。
        if (isX) return;
      }

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
        store.copyToClipboard(isX ? "move" : "copy");
        return;
      }

      // isV
      if (oneLibraryTarget && (inOneLibrary || (!inLibrary && !inResults))) {
        const store = useLibraryStore.getState();
        if (store.clipboard?.ids.length) {
          event.preventDefault();
          void usePlaylistStore
            .getState()
            .addTracks(
              oneLibraryTarget.device_path,
              oneLibraryTarget.playlist_id,
              store.clipboard.ids,
            )
            .catch(() => undefined);
          return;
        }
        if (searchClip?.length) {
          event.preventDefault();
          const quality = useAppStore.getState().settings?.default_quality ?? null;
          void useDownloadStore
            .getState()
            .enqueue(searchClip, { quality, one_library_target: oneLibraryTarget })
            .then(() => useAppStore.getState().openQueuePanel())
            .catch(() => undefined);
          return;
        }
      }

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
        if (!dest || isOutsideFolder(dest)) return;
        event.preventDefault();
        const quality = useAppStore.getState().settings?.default_quality ?? null;
        void useDownloadStore
          .getState()
          .enqueue(searchClip, { quality, dest_dir: dest })
          .then(() => useAppStore.getState().openQueuePanel())
          .catch(() => undefined);
        return;
      }

      const dest = store.filter.folder;
      if (!store.clipboard || !dest || isOutsideFolder(dest)) return;
      event.preventDefault();
      const op = resolveLibraryPasteOp({
        forceMove: withAlt,
        clipboardOp: store.clipboard.op,
      });
      void store.paste(dest, op);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
