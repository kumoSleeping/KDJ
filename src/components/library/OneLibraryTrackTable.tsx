import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  FolderOpen,
  LoaderCircle,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { api } from "../../lib/api";
import { formatBpm, formatDuration } from "../../lib/format";
import { trackKeyMatches, trackKeySortValue } from "../../lib/keyDisplay";
import { cycleTableSort, tableSortTitle, type TableSortOrder } from "../../lib/tableSort";
import {
  PLAYLIST_DROP_DEVICE_ATTR,
  PLAYLIST_DROP_ID_ATTR,
  playlistDropElementAt,
  searchDropElementAt,
  searchDropPathAt,
} from "../../lib/folderDrop";
import {
  ONE_LIBRARY_FILTER_TOGGLE_EVENT,
  oneLibraryPlayableTrack,
  reorderOneLibraryContentIds,
} from "../../lib/oneLibraryTrack";
import { playTrack } from "../../lib/playTrack";
import {
  resolveSearchDestDir,
} from "../../lib/searchDrag";
import { clearTextSelection, hasTextSelectionWithin } from "../../lib/textSelection";
import {
  suppressCoverClickAfterTrackDrop,
} from "../../lib/trackDrag";
import {
  playClickForLayout,
  useTrackClickPrefs,
} from "../../lib/trackClickPrefs";
import type { LayoutMode } from "../../lib/useLayoutMode";
import { shouldHandleWorkspaceDelete } from "../../lib/workspacePanes";
import { isEditable } from "../../lib/useLibraryClipboard";
import { usePlaylistStore, type OneLibrarySelectMode } from "../../stores/playlistStore";
import { useAppStore } from "../../stores/appStore";
import type { OneLibraryTrack } from "../../types";
import { ContextMenu, InlineNotice } from "../common";
import { CoverImage } from "../common/VinylPlaceholder";
import { TableRating } from "../common/TableRating";
import { TableSortMark } from "../common/TableSortMark";
import { TrackKeyChip } from "../common/TrackKeyChip";
import {
  beginColumnPointerReorder,
  loadTableColumnPrefs,
  moveColumnOrder,
  orderByPrefs,
  pxToRemString,
  remStringToPx,
  saveTableColumnPrefs,
  type TableColumnPrefs,
  type TableColumnPrefsSchema,
} from "../../lib/tableColumnPrefs";
import {
  dispatchOneLibraryCoverDrop,
  ONE_LIBRARY_COVER_CONTENT_ATTR,
  ONE_LIBRARY_COVER_DEVICE_ATTR,
  ONE_LIBRARY_COVER_TARGET_ATTR,
} from "../../lib/oneLibraryCoverDrag";

type OneLibrarySort = "custom" | "title" | "artist" | "album" | "bpm" | "key" | "rating" | "duration";
interface OneLibraryViewState {
  title: string;
  artist: string;
  album: string;
  bpmMin: number | null;
  bpmMax: number | null;
  key: string;
  ratingMin: number | null;
  sort: OneLibrarySort;
  order: TableSortOrder;
  sort2: OneLibrarySort | null;
  order2: TableSortOrder;
}

const DEFAULT_VIEW: OneLibraryViewState = {
  title: "",
  artist: "",
  album: "",
  bpmMin: null,
  bpmMax: null,
  key: "",
  ratingMin: null,
  sort: "custom",
  order: "asc",
  sort2: null,
  order2: "asc",
};
const ONE_LIBRARY_VIEWS_KEY = "kd-onelibrary-views-v1";
const ONE_LIBRARY_COLUMNS_KEY = "kd-onelibrary-columns-v1";
const INDEX_KEY = "index";
const COLUMNS = [
  { key: "title", label: "标题", width: "14rem", min: "4rem" },
  { key: "artist", label: "艺人", width: "6.5rem", min: "3rem" },
  { key: "album", label: "专辑", width: "5.75rem", min: "3rem" },
  { key: "bpm", label: "BPM", width: "4.2rem", min: "2.8rem" },
  { key: "key", label: "KEY", width: "4rem", min: "2.8rem" },
  { key: "duration", label: "时长", width: "4rem", min: "2.8rem" },
  { key: "rating", label: "评分", width: "4.2rem", min: "3rem" },
] as const;
const COLUMN_KEYS = COLUMNS.map((column) => column.key);
const COLUMN_MIN = Object.fromEntries(COLUMNS.map((column) => [column.key, column.min]));
const COLUMN_SCHEMA: TableColumnPrefsSchema = {
  columnKeys: COLUMN_KEYS,
  widthKeys: [INDEX_KEY, ...COLUMN_KEYS],
  lockedVisible: ["title"],
  minWidths: { [INDEX_KEY]: "1.4rem", ...COLUMN_MIN },
  maxWidth: "80rem",
};

function playlistViewKey(devicePath: string, playlistId: number): string {
  return `${devicePath}\u0000${playlistId}`;
}

function readStoredView(key: string): OneLibraryViewState {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(ONE_LIBRARY_VIEWS_KEY) ?? "{}");
    const value = all && typeof all === "object" ? (all as Record<string, unknown>)[key] : null;
    if (value && typeof value === "object") {
      const raw = value as Partial<Record<keyof OneLibraryViewState, unknown>>;
      const numberOrNull = (candidate: unknown) =>
        typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
      const sorts: OneLibrarySort[] = ["custom", "title", "artist", "album", "bpm", "key", "rating", "duration"];
      const sort = sorts.includes(raw.sort as OneLibrarySort) ? raw.sort as OneLibrarySort : "custom";
      const sort2 = sorts.includes(raw.sort2 as OneLibrarySort) && raw.sort2 !== "custom"
        ? raw.sort2 as OneLibrarySort
        : null;
      return {
        title: typeof raw.title === "string" ? raw.title : "",
        artist: typeof raw.artist === "string" ? raw.artist : "",
        album: typeof raw.album === "string" ? raw.album : "",
        bpmMin: numberOrNull(raw.bpmMin),
        bpmMax: numberOrNull(raw.bpmMax),
        key: typeof raw.key === "string" ? raw.key : "",
        ratingMin: numberOrNull(raw.ratingMin),
        sort,
        order: raw.order === "desc" ? "desc" : "asc",
        sort2: sort === "custom" || sort2 === sort ? null : sort2,
        order2: raw.order2 === "desc" ? "desc" : "asc",
      };
    }
  } catch {
    // 损坏存档只影响这一张表的视图。
  }
  return { ...DEFAULT_VIEW };
}

function writeStoredView(key: string, value: OneLibraryViewState): void {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ONE_LIBRARY_VIEWS_KEY) ?? "{}");
    const all = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    localStorage.setItem(ONE_LIBRARY_VIEWS_KEY, JSON.stringify({ ...all, [key]: value }));
  } catch {
    // localStorage 不可用时本次会话仍由 React state 保留。
  }
}

function compareNullable(left: string | number | null, right: string | number | null): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""), "zh-CN", { numeric: true });
}

function clickMode(event: React.MouseEvent): OneLibrarySelectMode {
  if (event.shiftKey) return "range";
  if (event.metaKey || event.ctrlKey) return "toggle";
  return "replace";
}

export function OneLibraryTrackTable({
  layout,
  onInspect,
  shortcutActive,
}: {
  layout: LayoutMode;
  onInspect?(track: OneLibraryTrack, clickCount: number): void;
  /** 分屏中只有当前点亮板块可以消费全局删除快捷键。 */
  shortcutActive: boolean;
}) {
  const target = usePlaylistStore((state) => state.selectedTarget);
  const tracks = usePlaylistStore((state) => state.selectedTracks);
  const selectedIds = usePlaylistStore((state) => state.selectedContentIds);
  const focusedId = usePlaylistStore((state) => state.focusedContentId);
  const selectionMode = usePlaylistStore((state) => state.selectionMode);
  const loading = usePlaylistStore((state) => state.tracksLoading);
  const keyNotation = useAppStore((state) => state.settings?.key_notation ?? "camelot");
  const error = usePlaylistStore((state) => state.deviceError);
  const devices = usePlaylistStore((state) => state.devices);
  const selectTrack = usePlaylistStore((state) => state.selectTrack);
  const selectAllTracks = usePlaylistStore((state) => state.selectAllTracks);
  const setVisibleContentIds = usePlaylistStore((state) => state.setVisibleContentIds);
  const setSelectionMode = usePlaylistStore((state) => state.setSelectionMode);
  const reorder = usePlaylistStore((state) => state.reorderTracks);
  const rateTrack = usePlaylistStore((state) => state.rateTrack);
  const copyTracks = usePlaylistStore((state) => state.copyTracks);
  const importTracksToFolder = usePlaylistStore((state) => state.importTracksToFolder);
  const remove = usePlaylistStore((state) => state.removeTracks);
  const clearError = usePlaylistStore((state) => state.clearError);
  const widePlay = useTrackClickPrefs((state) => state.widePlay);
  const narrowPlay = useTrackClickPrefs((state) => state.narrowPlay);
  const playClick = playClickForLayout({ widePlay, narrowPlay }, layout);
  const [menu, setMenu] = useState<{ track: OneLibraryTrack; x: number; y: number } | null>(null);
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number } | null>(null);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef<number | null>(null);
  const viewKey = target ? playlistViewKey(target.device_path, target.playlist_id) : "";
  const [view, setView] = useState<OneLibraryViewState>(() => readStoredView(viewKey));
  const [columnPrefs, setColumnPrefs] = useState<TableColumnPrefs>(() =>
    loadTableColumnPrefs(ONE_LIBRARY_COLUMNS_KEY, COLUMN_SCHEMA),
  );
  const columnPrefsRef = useRef(columnPrefs);
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const [coverVersions, setCoverVersions] = useState<Record<number, string>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const suppressSortRef = useRef(false);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const writable = Boolean(
    target && !devices.find((device) => device.path === target.device_path)?.read_only,
  );
  const canReorder = writable && view.sort === "custom";

  useEffect(() => {
    setView(readStoredView(viewKey));
    setFiltersOpen(false);
  }, [viewKey]);

  useEffect(() => {
    const toggle = () => setFiltersOpen((open) => !open);
    window.addEventListener(ONE_LIBRARY_FILTER_TOGGLE_EVENT, toggle);
    return () => window.removeEventListener(ONE_LIBRARY_FILTER_TOGGLE_EVENT, toggle);
  }, []);

  useEffect(() => {
    const onCover = (event: Event) => {
      const detail = (event as CustomEvent<{ devicePath?: string; contentId?: number; version?: string }>).detail;
      if (detail?.devicePath !== target?.device_path || !Number.isFinite(detail.contentId)) return;
      setCoverVersions((current) => ({
        ...current,
        [detail.contentId as number]: detail.version || String(Date.now()),
      }));
    };
    window.addEventListener("kd:onelibrary-cover-updated", onCover);
    return () => window.removeEventListener("kd:onelibrary-cover-updated", onCover);
  }, [target?.device_path]);

  useEffect(() => {
    columnPrefsRef.current = columnPrefs;
  }, [columnPrefs]);

  useEffect(() => {
    const persist = () =>
      saveTableColumnPrefs(ONE_LIBRARY_COLUMNS_KEY, columnPrefsRef.current, COLUMN_SCHEMA);
    window.addEventListener("pagehide", persist);
    return () => {
      window.removeEventListener("pagehide", persist);
      persist();
    };
  }, []);

  const updateView = (patch: Partial<OneLibraryViewState>) => {
    setView((current) => {
      const next = { ...current, ...patch };
      if (viewKey) writeStoredView(viewKey, next);
      return next;
    });
  };

  const visibleTracks = useMemo(() => {
    const textMatch = (value: string, query: string) =>
      !query.trim() || value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const filtered = tracks.filter((track) =>
      textMatch(track.title || track.filename, view.title)
      && textMatch(track.artist, view.artist)
      && textMatch(track.album, view.album)
      && (view.bpmMin === null || (track.bpm !== null && track.bpm >= view.bpmMin))
      && (view.bpmMax === null || (track.bpm !== null && track.bpm <= view.bpmMax))
      && trackKeyMatches(track, view.key)
      && (view.ratingMin === null || track.rating >= view.ratingMin),
    );
    if (view.sort === "custom") return filtered;
    const value = (track: OneLibraryTrack, sort: OneLibrarySort): string | number | null => {
      switch (sort) {
        case "title": return track.title || track.filename;
        case "artist": return track.artist;
        case "album": return track.album;
        case "bpm": return track.bpm;
        case "key": return trackKeySortValue(track);
        case "rating": return track.rating;
        case "duration": return track.duration;
        default: return track.sequence;
      }
    };
    return [...filtered].sort((left, right) => {
      const primary = compareNullable(value(left, view.sort), value(right, view.sort));
      const primaryResult = view.order === "asc" ? primary : -primary;
      if (primaryResult) return primaryResult;
      if (view.sort2) {
        const secondary = compareNullable(value(left, view.sort2), value(right, view.sort2));
        const secondaryResult = view.order2 === "asc" ? secondary : -secondary;
        if (secondaryResult) return secondaryResult;
      }
      return left.sequence - right.sequence;
    });
  }, [tracks, view]);

  useEffect(() => {
    setVisibleContentIds(visibleTracks.map((track) => track.content_id));
  }, [setVisibleContentIds, visibleTracks]);

  useEffect(
    () => () => setVisibleContentIds(null),
    [setVisibleContentIds, viewKey],
  );

  const orderedColumns = orderByPrefs(COLUMNS, columnPrefs.order);
  const visibleColumns = orderedColumns.filter((column) => !columnPrefs.hidden.includes(column.key));
  const visibleColumnKeys: string[] = visibleColumns.map((column) => column.key);
  const tableMinWidth =
    remStringToPx(columnPrefs.widths[INDEX_KEY] ?? "1.75rem")
    + visibleColumns.reduce(
      (sum, column) => sum + remStringToPx(columnPrefs.widths[column.key] ?? column.width),
      0,
    );
  const saveColumnPrefs = (next: TableColumnPrefs) => {
    const normalized = saveTableColumnPrefs(ONE_LIBRARY_COLUMNS_KEY, next, COLUMN_SCHEMA);
    columnPrefsRef.current = normalized;
    setColumnPrefs(normalized);
  };
  const suppressNextSort = () => {
    suppressSortRef.current = true;
    window.setTimeout(() => { suppressSortRef.current = false; }, 0);
  };
  const beginColumnResize = (key: string, event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const header = event.currentTarget.parentElement;
    if (!header) return;
    const startX = event.clientX;
    const startWidth = header.getBoundingClientRect().width;
    const minPx = remStringToPx(COLUMN_MIN[key] ?? "2.8rem");
    const maxPx = remStringToPx("40rem");
    setResizingColumn(key);
    document.body.dataset.kdColResizing = "true";
    const onMove = (move: PointerEvent) => {
      const width = pxToRemString(Math.min(maxPx, Math.max(minPx, startWidth + move.clientX - startX)));
      setColumnPrefs((current) => {
        const next = { ...current, widths: { ...current.widths, [key]: width } };
        columnPrefsRef.current = next;
        return next;
      });
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      document.body.removeAttribute("data-kd-col-resizing");
      setResizingColumn(null);
      suppressNextSort();
      saveTableColumnPrefs(ONE_LIBRARY_COLUMNS_KEY, columnPrefsRef.current, COLUMN_SCHEMA);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const sortBy = (key: string) => {
    if (suppressSortRef.current) {
      suppressSortRef.current = false;
      return;
    }
    const sort = key as OneLibrarySort;
    updateView(cycleTableSort(view, sort, "custom", "asc"));
  };
  const hasViewFilter = Boolean(
    view.title.trim()
    || view.artist.trim()
    || view.album.trim()
    || view.bpmMin !== null
    || view.bpmMax !== null
    || view.key.trim()
    || view.ratingMin !== null,
  );

  useEffect(
    () => () => {
      pointerCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    const available = new Set(tracks.map((track) => track.content_id));
    if (selectedIds.some((id) => !available.has(id))) {
      usePlaylistStore.setState({
        selectedContentIds: selectedIds.filter((id) => available.has(id)),
        focusedContentId: focusedId !== null && available.has(focusedId) ? focusedId : null,
      });
    }
  }, [focusedId, selectedIds, tracks]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      if (event.key === "Escape") {
        if (selectedIds.length === 0) return;
        event.preventDefault();
        selectTrack(null);
        return;
      }
      if (!writable || !shouldHandleWorkspaceDelete(
        shortcutActive,
        "onelibrary",
        event.key,
        event.metaKey || event.ctrlKey,
      )) return;
      if (selectedIds.length === 0) return;
      event.preventDefault();
      void remove(selectedIds).catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [remove, selectTrack, selectedIds, shortcutActive, writable]);

  if (!target) return null;

  const play = (track: OneLibraryTrack) => playTrack(oneLibraryPlayableTrack(track, target));
  const menuIds = menu
    ? selected.has(menu.track.content_id)
      ? selectedIds
      : [menu.track.content_id]
    : [];

  const beginPointerDrag = (
    event: React.PointerEvent<HTMLTableRowElement>,
    track: OneLibraryTrack,
  ) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, input, select, textarea, a, label")) return;
    pointerCleanupRef.current?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const ids = selected.has(track.content_id) ? [...selectedIds] : [track.content_id];
    let dragging = false;
    let ghost: HTMLDivElement | null = null;

    const hitAt = (x: number, y: number) => document.elementFromPoint(x, y) as HTMLElement | null;
    const clearTargets = () => {
      document
        .querySelectorAll<HTMLElement>("[data-kd-pointer-track-over]")
        .forEach((element) => element.removeAttribute("data-kd-pointer-track-over"));
      document
        .querySelectorAll<HTMLElement>("[data-kd-pointer-search-over]")
        .forEach((element) => element.removeAttribute("data-kd-pointer-search-over"));
    };
    const paintTarget = (x: number, y: number) => {
      clearTargets();
      const hit = hitAt(x, y);
      const cover = hit?.closest<HTMLElement>(`[${ONE_LIBRARY_COVER_TARGET_ATTR}]`);
      if (cover) {
        cover.setAttribute("data-kd-pointer-track-over", "cover");
        return;
      }
      const row = canReorder
        ? hit?.closest<HTMLElement>("tr[data-kd-onelibrary-content-id]")
        : null;
      if (row) {
        const rect = row.getBoundingClientRect();
        row.setAttribute(
          "data-kd-pointer-track-over",
          y < rect.top + rect.height / 2 ? "before" : "after",
        );
        return;
      }
      const playlist = playlistDropElementAt(x, y);
      if (playlist) {
        playlist.setAttribute("data-kd-pointer-track-over", "playlist");
        return;
      }
      searchDropElementAt(x, y)?.setAttribute("data-kd-pointer-search-over", "folder");
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      clearTargets();
      ghost?.remove();
      ghost = null;
      delete document.body.dataset.kdTrackPointerDragging;
      delete document.body.dataset.kdTrackPointerSource;
      pointerCleanupRef.current = null;
    };
    const activate = (x: number, y: number) => {
      dragging = true;
      clearTextSelection();
      suppressClickRef.current = track.content_id;
      if (!selected.has(track.content_id)) selectTrack(track.content_id, "replace");
      document.body.dataset.kdTrackPointerDragging = "true";
      document.body.dataset.kdTrackPointerSource = "onelibrary";
      ghost = document.createElement("div");
      ghost.className = "kd-track-pointer-ghost";
      ghost.textContent = ids.length > 1 ? `拖动 ${ids.length} 首曲目` : track.title || track.filename;
      document.body.appendChild(ghost);
      ghost.style.transform = `translate3d(${x + 12}px, ${y + 12}px, 0)`;
      paintTarget(x, y);
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const distance = Math.hypot(move.clientX - startX, move.clientY - startY);
      if (!dragging && distance < 5) return;
      move.preventDefault();
      if (!dragging) activate(move.clientX, move.clientY);
      ghost?.style.setProperty("transform", `translate3d(${move.clientX + 12}px, ${move.clientY + 12}px, 0)`);
      paintTarget(move.clientX, move.clientY);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      const hit = hitAt(up.clientX, up.clientY);
      const cover = hit?.closest<HTMLElement>(`[${ONE_LIBRARY_COVER_TARGET_ATTR}]`);
      const row = canReorder
        ? hit?.closest<HTMLElement>("tr[data-kd-onelibrary-content-id]")
        : null;
      const edge = row?.getAttribute("data-kd-pointer-track-over");
      const playlist = row ? null : playlistDropElementAt(up.clientX, up.clientY);
      const localDest = row || playlist ? "" : searchDropPathAt(up.clientX, up.clientY);
      const coverContentId = cover ? Number(cover.getAttribute(ONE_LIBRARY_COVER_CONTENT_ATTR)) : NaN;
      const coverDevice = cover?.getAttribute(ONE_LIBRARY_COVER_DEVICE_ATTR)?.trim() ?? "";
      cleanup();
      if (!dragging) return;
      up.preventDefault();
      if (cover && coverDevice && Number.isFinite(coverContentId)) {
        suppressCoverClickAfterTrackDrop();
        dispatchOneLibraryCoverDrop({
          source: { kind: "onelibrary", devicePath: target.device_path, ids },
          targetDevicePath: coverDevice,
          targetContentId: coverContentId,
        });
        return;
      }
      if (row && (edge === "before" || edge === "after")) {
        const targetId = Number(row.dataset.kdOnelibraryContentId);
        if (Number.isFinite(targetId) && !ids.includes(targetId)) {
          const order = reorderOneLibraryContentIds(
            tracks.map((item) => item.content_id),
            ids,
            targetId,
            edge === "before",
          );
          void reorder(order).catch(() => undefined);
        }
        return;
      }
      if (playlist) {
        const targetId = Number(playlist.getAttribute(PLAYLIST_DROP_ID_ATTR));
        const devicePath = playlist.getAttribute(PLAYLIST_DROP_DEVICE_ATTR)?.trim() ?? "";
        if (devicePath && Number.isFinite(targetId)) {
          void copyTracks(target, devicePath, targetId, ids).catch(() => undefined);
        }
        return;
      }
      if (localDest) {
        try {
          void importTracksToFolder(target, ids, resolveSearchDestDir(localDest)).catch(() => undefined);
        } catch {
          // resolveSearchDestDir 的消息由 store 的目标选择和本地栏状态呈现。
        }
      }
    };
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId !== pointerId) return;
      cleanup();
    };

    pointerCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
  };

  return (
    <div className="kd-col kd-onelibrary-track-view">
      <InlineNotice text={error} onDismiss={clearError} block />
      {(filtersOpen || hasViewFilter) ? (
      <div className="kd-library-filterbar kd-onelibrary-filterbar">
        <span className="kd-library-filter-label">筛选</span>
        <input
          className="kd-input"
          aria-label="按标题筛选 OneLibrary"
          placeholder="标题"
          value={view.title}
          onChange={(event) => updateView({ title: event.target.value })}
        />
        <input
          className="kd-input"
          aria-label="按艺人筛选 OneLibrary"
          placeholder="艺人"
          value={view.artist}
          onChange={(event) => updateView({ artist: event.target.value })}
        />
        <input
          className="kd-input"
          aria-label="按专辑筛选 OneLibrary"
          placeholder="专辑"
          value={view.album}
          onChange={(event) => updateView({ album: event.target.value })}
        />
        <input
          className="kd-input kd-input-number"
          type="number"
          aria-label="最低 BPM"
          placeholder="BPM ≥"
          value={view.bpmMin ?? ""}
          onChange={(event) => updateView({ bpmMin: event.target.value ? Number(event.target.value) : null })}
        />
        <input
          className="kd-input kd-input-number"
          type="number"
          aria-label="最高 BPM"
          placeholder="BPM ≤"
          value={view.bpmMax ?? ""}
          onChange={(event) => updateView({ bpmMax: event.target.value ? Number(event.target.value) : null })}
        />
        <input
          className="kd-input kd-input-short"
          aria-label="按 KEY 筛选 OneLibrary"
          placeholder="KEY"
          value={view.key}
          onChange={(event) => updateView({ key: event.target.value })}
        />
        <select
          className="kd-filter-control kd-onelibrary-rating-filter"
          aria-label="最低评分"
          value={view.ratingMin ?? ""}
          onChange={(event) => updateView({ ratingMin: event.target.value ? Number(event.target.value) : null })}
        >
          <option value="">评分</option>
          {[1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{rating} 星以上</option>)}
        </select>
        <button
          type="button"
          className="kd-filter-reset"
          disabled={!hasViewFilter}
          onClick={() => {
            updateView({
              title: "",
              artist: "",
              album: "",
              bpmMin: null,
              bpmMax: null,
              key: "",
              ratingMin: null,
            });
            setFiltersOpen(false);
          }}
          title="清除 OneLibrary 筛选"
        >
          <RotateCcw size={12} />
          重置
        </button>
      </div>
      ) : null}
      {loading ? (
        <div className="kd-onelibrary-track-loading">
          <LoaderCircle className="kd-spin" size={18} />
        </div>
      ) : (
        <div className="kd-scroll kd-grow">
          <table
            className="kd-table kd-onelibrary-track-table"
            data-kind="onelibrary"
            data-layout={layout}
            style={{ minWidth: tableMinWidth }}
            tabIndex={-1}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "a") {
                event.preventDefault();
                event.stopPropagation();
                selectAllTracks();
              }
            }}
            onPointerDownCapture={(event) => event.currentTarget.focus({ preventScroll: true })}
          >
            <colgroup>
              <col style={{ width: columnPrefs.widths[INDEX_KEY] ?? "1.75rem" }} />
              {visibleColumns.map((column) => (
                <col key={column.key} style={{ width: columnPrefs.widths[column.key] ?? column.width }} />
              ))}
              <col />
            </colgroup>
            <thead>
              <tr>
                <th
                  data-col="index"
                  data-sortable="true"
                  title="恢复播放列表原始顺序"
                  onClick={() => updateView({ sort: "custom", order: "asc", sort2: null, order2: "asc" })}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setColumnMenu({ x: event.clientX, y: event.clientY });
                  }}
                >
                  序号
                  {view.sort === "custom" ? <TableSortMark order="asc" /> : null}
                  <span
                    className="kd-col-resize"
                    role="separator"
                    aria-label="调整序号列宽"
                    onPointerDown={(event) => beginColumnResize(INDEX_KEY, event)}
                  />
                </th>
                {visibleColumns.map((column) => (
                  <th
                    key={column.key}
                    data-col={column.key}
                    data-sortable="true"
                    data-column-reorder="true"
                    data-dragging={dragColumn === column.key ? "true" : undefined}
                    data-col-drop={
                      dragColumn && dragColumn !== column.key && overColumn === column.key
                        ? visibleColumnKeys.indexOf(dragColumn) < visibleColumnKeys.indexOf(column.key)
                          ? "after"
                          : "before"
                        : undefined
                    }
                    title={tableSortTitle(view, column.key)}
                    onClick={() => sortBy(column.key)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setColumnMenu({ x: event.clientX, y: event.clientY });
                    }}
                    onPointerDown={(event) => {
                      if (resizingColumn) return;
                      beginColumnPointerReorder(event, column.key, visibleColumnKeys, {
                        onStart: setDragColumn,
                        onOver: setOverColumn,
                        onDragged: suppressNextSort,
                        onMove: (from, to) => saveColumnPrefs({
                          ...columnPrefsRef.current,
                          order: moveColumnOrder(
                            columnPrefsRef.current.order,
                            visibleColumnKeys,
                            from,
                            to,
                          ),
                        }),
                        onEnd: () => { setDragColumn(null); setOverColumn(null); },
                      });
                    }}
                  >
                    {column.label}
                    {view.sort === column.key ? <TableSortMark order={view.order} /> : null}
                    {view.sort !== column.key && view.sort2 === column.key
                      ? <TableSortMark order={view.order2} secondary />
                      : null}
                    <span
                      className="kd-col-resize"
                      role="separator"
                      aria-label={`调整${column.label}列宽`}
                      onPointerDown={(event) => beginColumnResize(column.key, event)}
                    />
                  </th>
                ))}
                <th className="kd-table-fill" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {visibleTracks.map((track, index) => (
                <tr
                  key={track.content_id}
                  aria-selected={selected.has(track.content_id)}
                  data-focus={focusedId === track.content_id ? "true" : undefined}
                  data-selecting={selectionMode ? "true" : undefined}
                  data-kd-onelibrary-content-id={track.content_id}
                  draggable={false}
                  onClick={(event) => {
                    if (hasTextSelectionWithin(event.currentTarget)) return;
                    if (suppressClickRef.current === track.content_id) {
                      suppressClickRef.current = null;
                      return;
                    }
                    if (playClick === "single" && event.detail > 1) return;
                    const mode = selectionMode ? "toggle" : clickMode(event);
                    if (mode === "range" && focusedId !== null) {
                      const anchor = visibleTracks.findIndex((item) => item.content_id === focusedId);
                      const cursor = visibleTracks.findIndex((item) => item.content_id === track.content_id);
                      if (anchor >= 0 && cursor >= 0) {
                        const [start, end] = anchor < cursor ? [anchor, cursor] : [cursor, anchor];
                        usePlaylistStore.setState({
                          selectedContentIds: visibleTracks
                            .slice(start, end + 1)
                            .map((item) => item.content_id),
                          focusedContentId: track.content_id,
                          selectionMode: true,
                        });
                      } else {
                        selectTrack(track.content_id, mode);
                      }
                    } else {
                      selectTrack(track.content_id, mode);
                    }
                    if (mode !== "replace") return;
                    onInspect?.(track, event.detail);
                    if (playClick === "single") play(track);
                  }}
                  onDoubleClick={() => {
                    if (!selectionMode && playClick === "double") play(track);
                  }}
                  onPointerDown={(event) => beginPointerDrag(event, track)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ track, x: event.clientX, y: event.clientY });
                  }}
                >
                  <td data-col="index">{index + 1}</td>
                  {visibleColumns.map((column) => {
                    switch (column.key) {
                      case "title": return (
                        <td key={column.key} data-col="title" className="kd-td-strong" title={track.path}>
                          {selectionMode ? (
                            <button
                              type="button"
                              className="kd-row-select"
                              aria-label={selected.has(track.content_id) ? "取消选择" : "选择曲目"}
                              aria-pressed={selected.has(track.content_id)}
                              onClick={(event) => {
                                event.stopPropagation();
                                selectTrack(track.content_id, "toggle");
                              }}
                            >
                              <Check size={9} />
                            </button>
                          ) : null}
                          <span className="kd-thumb">
                            <CoverImage
                              src={api.oneLibraryCoverUrl(
                                target.device_path,
                                track.content_id,
                                `${track.cover_version}-${coverVersions[track.content_id] ?? ""}`,
                              )}
                              key={`${track.cover_version}-${coverVersions[track.content_id] ?? ""}`}
                              loading="lazy"
                            />
                          </span>
                          {track.title || track.filename}
                        </td>
                      );
                      case "artist": return <td key={column.key} data-col="artist">{track.artist || "—"}</td>;
                      case "album": return <td key={column.key} data-col="album">{track.album || "—"}</td>;
                      case "bpm": return <td key={column.key} data-col="bpm" className="kd-td-num">{formatBpm(track.bpm)}</td>;
                      case "key": return (
                        <td key={column.key} data-col="key">
                          <TrackKeyChip track={track} notation={keyNotation} />
                        </td>
                      );
                      case "rating": return (
                        <td key={column.key} data-col="rating">
                          <TableRating
                            value={track.rating}
                            onChange={writable
                              ? (rating) => { void rateTrack(track.content_id, rating).catch(() => undefined); }
                              : undefined}
                          />
                        </td>
                      );
                      case "duration": return <td key={column.key} data-col="duration" className="kd-td-num">{formatDuration(track.duration)}</td>;
                    }
                  })}
                  <td className="kd-table-fill" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {columnMenu && (
        <ContextMenu x={columnMenu.x} y={columnMenu.y} onClose={() => setColumnMenu(null)}>
          {orderedColumns.map((column) => {
            const hidden = columnPrefs.hidden.includes(column.key);
            const locked = column.key === "title";
            return (
              <button
                key={column.key}
                type="button"
                disabled={locked}
                onClick={() => saveColumnPrefs({
                  ...columnPrefs,
                  hidden: hidden
                    ? columnPrefs.hidden.filter((key) => key !== column.key)
                    : [...columnPrefs.hidden, column.key],
                })}
              >
                <Check size={12} style={{ opacity: hidden ? 0 : 1 }} />
                {column.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem(ONE_LIBRARY_COLUMNS_KEY);
              const defaults = loadTableColumnPrefs(ONE_LIBRARY_COLUMNS_KEY, COLUMN_SCHEMA);
              columnPrefsRef.current = defaults;
              setColumnPrefs(defaults);
              setColumnMenu(null);
            }}
          >
            <RotateCcw size={12} /> 恢复默认列
          </button>
        </ContextMenu>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button type="button" onClick={() => { play(menu.track); setMenu(null); }}>
            <Play size={12} /> 播放
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectionMode(true);
              if (!selected.has(menu.track.content_id)) selectTrack(menu.track.content_id, "toggle");
              setMenu(null);
            }}
          >
            <Check size={12} /> 选择
          </button>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(menu.track.title || menu.track.filename);
              setMenu(null);
            }}
          >
            <Copy size={12} /> 复制标题
          </button>
          <button
            type="button"
            onClick={() => {
              void window.kdj.revealPath(menu.track.path);
              setMenu(null);
            }}
          >
            <FolderOpen size={12} /> 在文件夹中显示
          </button>
          {writable ? (
            <button
              type="button"
              data-danger="true"
              onClick={() => {
                setMenu(null);
                void remove(menuIds).catch(() => undefined);
              }}
            >
              <Trash2 size={12} /> 从列表移除{menuIds.length > 1 ? `（${menuIds.length} 首）` : ""}
            </button>
          ) : null}
        </ContextMenu>
      )}
    </div>
  );
}
