import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ListMusic,
  LoaderCircle,
  RotateCcw,
  SearchX,
} from "lucide-react";
import type {
  CollectionResult,
  IntakeItem,
  IntakeKind,
  MergedGroup,
  VideoInfo,
} from "../../types";
import type { SongPreviewItem } from "../../lib/songPreview";
import { thumbUrl } from "../../lib/format";
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
import { ContextMenu, EmptyState, InlineNotice } from "../common";
import { MergedGroupRow, PLATFORM_LABEL } from "./MergedGroupRow";
import { PlatformMark } from "./PlatformMark";
import {
  beginAudioPointerDrag,
  endSearchDrag,
  writeSearchSourcesDrag,
} from "../../lib/searchDrag";
import {
  isVideoGroup,
  VideoResultRow,
  videoSeedFromGroup,
  videoSeedFromInfo,
} from "./VideoResultRow";
import {
  RESULT_COLUMN_MIN_WIDTH,
  RESULT_COLUMN_PREFS_KEY,
  RESULT_COLUMNS,
  RESULT_GUTTER_WIDTH,
  RESULT_LEAD_WIDTH,
  resultColumnKeysWithData,
  type ResultColumn,
} from "./resultColumns";
import type { LayoutMode } from "../../lib/useLayoutMode";
import {
  collectionReveal,
  collectionToken,
} from "../../lib/searchCollections";
import { CoverImage } from "../common/VinylPlaceholder";
import { RowPick } from "../common/RowPick";
import {
  pickStateOf,
  resultRowActionUsesSelection,
  selectableGroups,
  selectionKey,
  selectionRun,
} from "../../lib/resultSelection";
import { tossItemKey } from "../../lib/downloadToss";
import { removeLocalStorage } from "../../lib/storageWrite";
import { isEditable } from "../../lib/useLibraryClipboard";
import {
  FOLD_MAX_ROWS,
  foldingRowProps,
  foldOrder,
  publishSearchOutcome,
  searchOutcomeOf,
  useFold,
} from "./searchMotion";
import {
  arrivalAfter,
  nearListEnd,
  NOTHING_PRESENTED,
  settleRowGestures,
  type ResultDelivery,
} from "./resultArrival";
import { resultBlocks, resultListIsFlat, resultPickKeys, resultRowCount, type ResultBlock } from "./resultBlocks";
import { useRowList, useScrollMotion } from "../common/rowList";
import { createListArrival, type ListArrival } from "../common/listArrival";
import "../common/RowList.css";
import "./ResultTable.css";

export {
  resultRowActionUsesSelection,
  selectableGroups,
  selectionKey,
} from "../../lib/resultSelection";

const KIND_LABEL: Record<IntakeKind, string> = {
  search: "搜索",
  song: "单曲",
  playlist: "歌单",
  artist: "艺术家",
  album: "专辑",
  radio: "播客",
  unknown: "链接",
  error: "失败",
};

/** The bounds of a row height before the first row is measured (= --kd-row-h). */
const FALLBACK_ROW_H = 36;
/** A presented list waits this long for the rows at its place to be rendered before giving up. */
const ARRIVAL_DUE_MS = 400;

function previewItem(group: MergedGroup, preferredIndex: number): SongPreviewItem | null {
  if (isVideoGroup(group)) return null;
  const preferred = group.sources[preferredIndex] ?? group.sources[0];
  const source =
    preferred && preferred.platform !== "bilibili" && preferred.platform !== "local"
      ? preferred
      : group.sources.find(
          (candidate) => candidate.platform !== "bilibili" && candidate.platform !== "local",
        );
  if (!source) return null;
  return {
    source,
    title: group.title || source.title,
    artist: group.artists.join(", ") || source.artists.join(", "),
  };
}

export interface ResultTableProps {
  items: IntakeItem[];
  /** 贴 B 站链接解析出来的那一个视频，置顶在结果最前面。 */
  video: VideoInfo | null;
  loading: boolean;
  /** 已处理过一次（用来区分"还没搜"和"搜了没结果"）。 */
  searched: boolean;
  /**
   * Which list this is and where it starts. A new id is a list the user has not seen: its rows
   * arrive in a cascade. Rows added to or taken from the list keep the id.
   */
  delivery: ResultDelivery;
  /** The pane holding the table is on screen; coming back on screen presents the list again. */
  paneShown: boolean;
  /** 当前布局档位，决定搜索结果行的单击/双击播放行为。 */
  layout: LayoutMode;
  selected: Set<string>;
  selectionMode: boolean;
  onSelectionModeChange(value: boolean): void;
  /** 展开了跨平台来源明细的组。 */
  expandedGroups: Set<string>;
  /** 折叠起来的"包"下标。 */
  collapsedItems: Set<number>;
  sourceIndex: Record<string, number>;
  /** 最后由用户点开的在线曲目；由工作台持久化以便重启恢复。 */
  inspectedGroup: string | null;
  /** How many rows of the opened collection(s) are shown so far; the list grows in batches. */
  collectionShown: number;
  /** There are rows beyond the shown ones, in hand or still at the provider. */
  hasMoreRows: boolean;
  /** The next batch is being fetched: a ring turns at the foot of the list. */
  loadingMoreRows: boolean;
  /** The end of what is shown came into reach. */
  onShowMoreRows(): void;
  onToggleSelect(key: string): void;
  onToggleExpand(groupId: string): void;
  onPickSource(groupId: string, index: number): void;
  onToggleItem(index: number): void;
  onToggleItemAll(index: number): void;
  onToggleAll(): void;
  /** 单曲显式下载入口（首个数据列右端的下载键、右键菜单）。 */
  onDownloadGroup(group: MergedGroup): void;
  /** 右键落在现有选区内时，把整组选中结果加入队列。 */
  onDownloadSelected(): void;
  /** 普通单击在线曲目时选中来源并打开右侧详情。 */
  onInspectGroup(group: MergedGroup, sourceIndex: number, groupKey: string): void;
  /** 当前列表来自可编辑的平台歌单时，右键菜单显示真实远端移除操作。 */
  onRemoveStreamGroup?(group: MergedGroup, sourceIndex: number): void;
  removeStreamGroupLabel?: string;
  removingStreamGroupIds?: ReadonlySet<string>;
  /** 双击后仍在解析或装载中的来源，用于把加载反馈钉在原行。 */
  previewPendingSourceKey?: string;
  previewPendingLabel?: string;
  /** 作者/专辑集合必须先展开为歌曲，不能直接入队。 */
  onLoadCollection(collection: CollectionResult): void;
  loadingCollections: Set<string>;
}

const RESULT_COLUMN_MAX_WIDTH = "80rem";
const RESULT_COLUMN_PREFS_SCHEMA: TableColumnPrefsSchema = {
  columnKeys: RESULT_COLUMNS.map((column) => column.key),
  // lead 是固定在左侧的序号列：只保存宽度，不参与数据列换序和显隐。
  widthKeys: ["lead", ...RESULT_COLUMNS.map((column) => column.key)],
  lockedVisible: ["title"],
  minWidths: RESULT_COLUMN_MIN_WIDTH,
  maxWidth: RESULT_COLUMN_MAX_WIDTH,
};

const NO_ITEMS: IntakeItem[] = [];

type ResultTableHandlers = Required<Pick<
  ResultTableProps,
  | "onSelectionModeChange"
  | "onToggleSelect"
  | "onToggleExpand"
  | "onPickSource"
  | "onToggleItem"
  | "onToggleItemAll"
  | "onToggleAll"
  | "onDownloadGroup"
  | "onDownloadSelected"
  | "onInspectGroup"
  | "onRemoveStreamGroup"
  | "onLoadCollection"
  | "onShowMoreRows"
>>;

/**
 * The rows of one package (a playlist, an album, one entry of a batch). Collapsing the package
 * folds them away instead of dropping them: they fade as pictures of themselves, then one empty
 * row stands in for them and closes the room they held (ResultTable.css, "Folding back").
 */
function PackageRows({
  open,
  count,
  children,
}: {
  open: boolean;
  /** Rows the package shows when open; the fold is told how many of them take part. */
  count: number;
  /** The package's rows; `leaving` asks for the pictures that fade out. */
  children(leaving: boolean): ReactNode;
}) {
  const phase = useFold(open, Math.min(count, FOLD_MAX_ROWS));
  const endRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(0);
  // Measured once, when the rows start to leave and before anything has moved: the room they hold.
  useLayoutEffect(() => {
    if (phase !== "out") return;
    let height = 0;
    let row = endRef.current?.previousElementSibling;
    while (row instanceof HTMLElement && row.dataset.fold) {
      height += row.offsetHeight;
      row = row.previousElementSibling;
    }
    heightRef.current = height;
  }, [phase]);

  if (phase === "closed") return null;
  if (phase === "shut") {
    return (
      <div className="kd-list-row" role="row" data-fold="shut" aria-hidden="true"
        style={{ "--kd-fold-h": `${heightRef.current}px` } as CSSProperties} />
    );
  }
  return (
    <>
      <Fragment key="rows">{children(phase === "out")}</Fragment>
      {phase === "out" ? <div key="end" ref={endRef} hidden /> : null}
    </>
  );
}

/**
 * The table re-renders for what it shows, not for its owner. The workspace renders on every
 * keystroke in the search field and hands over fresh handlers each time; they are read at the
 * moment of the call instead, so typing over a long list of results does not render its rows.
 */
export function ResultTable(props: ResultTableProps) {
  const latest = useRef(props);
  latest.current = props;
  const handlers = useMemo<ResultTableHandlers>(
    () => ({
      onSelectionModeChange: (value) => latest.current.onSelectionModeChange(value),
      onToggleSelect: (key) => latest.current.onToggleSelect(key),
      onToggleExpand: (groupId) => latest.current.onToggleExpand(groupId),
      onPickSource: (groupId, index) => latest.current.onPickSource(groupId, index),
      onToggleItem: (index) => latest.current.onToggleItem(index),
      onToggleItemAll: (index) => latest.current.onToggleItemAll(index),
      onToggleAll: () => latest.current.onToggleAll(),
      onDownloadGroup: (group) => latest.current.onDownloadGroup(group),
      onDownloadSelected: () => latest.current.onDownloadSelected(),
      onInspectGroup: (group, sourceIndex, groupKey) =>
        latest.current.onInspectGroup(group, sourceIndex, groupKey),
      onRemoveStreamGroup: (group, sourceIndex) =>
        latest.current.onRemoveStreamGroup?.(group, sourceIndex),
      onLoadCollection: (collection) => latest.current.onLoadCollection(collection),
      onShowMoreRows: () => latest.current.onShowMoreRows(),
    }),
    [],
  );
  return (
    <ResultTableView
      {...props}
      {...handlers}
      items={props.items.length ? props.items : NO_ITEMS}
      // Whether the list can be edited remotely is data; the handler behind it is read late.
      onRemoveStreamGroup={props.onRemoveStreamGroup ? handlers.onRemoveStreamGroup : undefined}
    />
  );
}

function loadPrefs(): TableColumnPrefs {
  return loadTableColumnPrefs(RESULT_COLUMN_PREFS_KEY, RESULT_COLUMN_PREFS_SCHEMA);
}

/** A mounted row of a block and where it lies in the list, in pixels from the first row. */
interface PlacedRow { row: HTMLElement; block: string; top: number }

const ResultTableView = memo(function ResultTableView({
  items,
  video,
  loading,
  searched,
  delivery,
  paneShown,
  layout,
  selected,
  selectionMode,
  onSelectionModeChange,
  expandedGroups,
  collapsedItems,
  sourceIndex,
  inspectedGroup,
  collectionShown,
  hasMoreRows,
  loadingMoreRows,
  onShowMoreRows,
  onToggleSelect,
  onToggleExpand,
  onPickSource,
  onToggleItem,
  onToggleItemAll,
  onToggleAll,
  onDownloadGroup,
  onDownloadSelected,
  onInspectGroup,
  onRemoveStreamGroup,
  removeStreamGroupLabel,
  removingStreamGroupIds,
  previewPendingSourceKey,
  previewPendingLabel,
  onLoadCollection,
  loadingCollections,
}: ResultTableProps) {
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const toggleSelectRef = useRef(onToggleSelect);
  toggleSelectRef.current = onToggleSelect;
  /**
   * Rows are being picked: the mode was asked for (a row menu's 选择, the head's mark, select
   * all), or something is already picked (⌘/Ctrl-click, Shift-click). The work rail reads the
   * same condition. While it holds, every row that can be downloaded shows the selection mark
   * in place of its number, and a plain click on it picks or drops it instead of opening it.
   */
  const selecting = selectionMode || selected.size > 0;
  const parentPressRef = useRef<number | null>(null);
  const suppressParentClickRef = useRef<number | null>(null);
  const totalGroups = items.reduce((sum, item) => sum + item.groups.length, 0);
  /** Nothing to show yet: the spinner stands in for the list. */
  const waiting = loading && totalGroups === 0 && !video;

  /** There are rows on screen (or would be, were the pane shown). */
  const listed = !waiting && (items.length > 0 || Boolean(video));

  // Opened collections grow in batches: the list shows a prefix of the rows, so a batch only
  // ever adds blocks at the end.
  const reveal = useMemo(() => collectionReveal(items, collectionShown), [items, collectionShown]);
  /** The list as the virtualizer places it: one block per song, collection or package (resultBlocks.ts). */
  const blocks = useMemo(
    () => resultBlocks({ items, video, shownRows: reveal.rows, collapsedItems, expandedGroups }),
    [items, video, reveal, collapsedItems, expandedGroups],
  );
  const flat = resultListIsFlat(items);
  /** The row touched last — picked, dropped or opened: where a Shift-click's run starts. */
  const anchorRef = useRef<string | null>(null);
  const pickRow = (key: string, range: boolean) => {
    // The run follows the rows as they are shown, whatever page or package they belong to.
    const shown = range ? resultPickKeys(blocks) : [];
    const run = range ? selectionRun(shown, anchorRef.current, key) : null;
    anchorRef.current = key;
    if (!run) {
      onToggleSelect(key);
      return;
    }
    // A run only adds: what was picked before it stays picked.
    for (const item of run) if (!selected.has(item)) onToggleSelect(item);
  };

  // A list is presented when it is one the user has not just been looking at: another delivery,
  // rows where the spinner was, or the pane back on screen (resultArrival.ts). Each presentation
  // is one cascade from the first row in view; a re-render or a change of the rows is none.
  const [arrival, setArrival] = useState(() =>
    arrivalAfter(NOTHING_PRESENTED, { delivery: delivery.id, shown: paneShown, listed }, loading),
  );
  const arrivalNow = arrivalAfter(arrival, { delivery: delivery.id, shown: paneShown, listed }, loading);
  if (arrivalNow !== arrival) setArrival(arrivalNow);

  /* ---------------------------------------------------- the row list */
  // The list lives in the pane's scroller (the workspace renders it there); the virtualizer and
  // the scroll listener follow that element, found when the list mounts.
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const scrollerRef = useMemo(() => ({ current: scroller }), [scroller]);
  const listRef = useCallback((element: HTMLDivElement | null) => {
    setScroller(element?.closest<HTMLElement>(".kd-scroll") ?? element?.parentElement ?? null);
  }, []);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [rowH, setRowH] = useState(FALLBACK_ROW_H);
  const rowHRef = useRef(FALLBACK_ROW_H);
  const [headH, setHeadH] = useState(28);
  const headShown = items.length > 0;
  const headPx = headShown ? headH : 0;
  const estimateSize = useCallback((index: number) => (blocks[index]?.rows ?? 1) * rowH, [blocks, rowH]);
  // A delivered list is a new list: every block of it is new, whatever the last list held.
  const getKey = useCallback((index: number) => `${delivery.id}:${blocks[index]?.key ?? index}`, [blocks, delivery.id]);
  // The scroll listener hears a scroll before the virtualizer renders for it: the effects of
  // that render read the scroll's direction.
  // A list waiting to be presented at an offset asks for a render when the scroll reaches it.
  const [, bump] = useReducer((tick: number) => tick + 1, 0);
  const arrivalDueRef = useRef<{ offset: number; at: number } | null>(null);
  const motion = useScrollMotion(scrollerRef, () => {}, () => { if (arrivalDueRef.current) bump(); });
  const screenRef = useRef(20);
  const { virtualizer } = useRowList({ scrollerRef, count: blocks.length, rowHeight: rowH, estimateSize, headHeight: headPx, getKey, measured: true,
    screenRows: screenRef.current, resetKey: delivery.id });
  screenRef.current = Math.max(1, Math.ceil(Math.max(rowH, (virtualizer.scrollRect?.height ?? 720) - headPx) / rowH));
  const virtualItems = virtualizer.getVirtualItems();
  /** The mounted blocks by their key; the arrival finds its rows through them. */
  const blockElementsRef = useRef(new Map<string, HTMLElement>());
  const registerBlock = useCallback((element: HTMLDivElement) => {
    virtualizer.measureElement(element);
    const key = element.dataset.kdBlockKey ?? "";
    const elements = blockElementsRef.current;
    elements.set(key, element);
    return () => {
      if (elements.get(key) === element) elements.delete(key);
    };
  }, [virtualizer]);

  useLayoutEffect(() => {
    if (!scroller) return;
    const measure = () => {
      const row = scroller.querySelector<HTMLElement>(".kd-list-row:not([data-fold])");
      const height = row?.getBoundingClientRect().height ?? FALLBACK_ROW_H;
      if (height > 0 && Math.abs(height - rowHRef.current) > 0.5) {
        rowHRef.current = height;
        setRowH(height);
      }
      const head = scroller.querySelector(".kd-list-head")?.getBoundingClientRect().height ?? 28;
      setHeadH((old) => Math.abs(old - head) > 0.5 ? head : old);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    const row = scroller.querySelector(".kd-list-row:not([data-fold])");
    if (row) observer.observe(row);
    return () => observer.disconnect();
  }, [scroller, listed]);
  useLayoutEffect(() => { virtualizer.measure(); }, [rowH, virtualizer]);

  /* ---------------------------------------------------- arriving */
  const arrivalRef = useRef<ListArrival | null>(null);
  useLayoutEffect(() => {
    if (!scroller) return;
    const created = createListArrival(scroller);
    arrivalRef.current = created;
    return () => {
      created.stop();
      if (arrivalRef.current === created) arrivalRef.current = null;
    };
  }, [scroller]);
  /** The presentation that starts once the rows at its place are rendered (declared with the scroll listener). */
  /** The delivery whose starting position has been taken; the pane coming back keeps its place. */
  const placedRef = useRef<number | null>(null);
  const deliveryRef = useRef(delivery);
  deliveryRef.current = delivery;
  useLayoutEffect(() => {
    if (!arrivalNow.run || !scroller) return;
    const delivered = deliveryRef.current;
    if (placedRef.current !== delivered.id) {
      placedRef.current = delivered.id;
      scroller.scrollTop = delivered.top;
      scroller.scrollLeft = delivered.left;
    }
    arrivalDueRef.current = { offset: scroller.scrollTop, at: performance.now() };
  }, [arrivalNow.run, scroller]);
  useLayoutEffect(() => {
    // display:none cancels CSS animations. Remove their marks too, so reopening retained
    // results during a search cannot restart a half-finished cascade in the browser.
    if (!paneShown) {
      arrivalDueRef.current = null;
      arrivalRef.current?.stop();
    }
  }, [paneShown]);
  // Marks the rows put on themselves (slotting in, unfolding) come off when their gesture ends.
  useEffect(() => {
    const body = bodyRef.current;
    return body ? settleRowGestures(body) : undefined;
  }, [listed, scroller]);

  /**
   * The rows of the mounted blocks that lie under the viewport (below the head's lower edge,
   * above the bottom), top to bottom, by the list's own geometry: a block's offset and the rows'
   * height. Nothing is measured.
   */
  const rowsInView = useCallback((): PlacedRow[] => {
    const offset = Math.max(0, motion.current.offset);
    const height = virtualizer.scrollRect?.height ?? 0;
    const viewTop = offset + headPx;
    const viewBottom = offset + Math.max(height, headPx + rowH);
    const rows: PlacedRow[] = [];
    for (const item of virtualItems) {
      const block = blockElementsRef.current.get(String(item.key));
      if (!block) continue;
      let at = 0;
      for (const row of block.querySelectorAll<HTMLElement>(":scope > .kd-list-row")) {
        if (row.hidden) continue;
        const top = item.start + at * rowH;
        at += 1;
        if (top + rowH > viewTop && top < viewBottom) rows.push({ row, block: String(item.key), top: top - headPx });
      }
    }
    return rows;
  }, [virtualizer, virtualItems, motion, headPx, rowH]);

  const seenBlocksRef = useRef(new Set<string>());
  /** Blocks built once in this delivery: their rows do not replay the chase when they come back. */
  const everBuiltRef = useRef({ delivery: Number.NaN, keys: new Set<string>() });
  const grownRef = useRef({ delivery: Number.NaN, shown: 0 });
  useLayoutEffect(() => {
    const seen = seenBlocksRef.current;
    const next = new Set<string>();
    for (const item of virtualItems) next.add(String(item.key));
    seenBlocksRef.current = next;
    if (everBuiltRef.current.delivery !== delivery.id) everBuiltRef.current = { delivery: delivery.id, keys: new Set() };
    const built = everBuiltRef.current.keys;
    const builtNow = new Set<string>();
    for (const key of next) if (!built.has(key)) { built.add(key); builtNow.add(key); }
    const wasBuilt = (key: string) => !builtNow.has(key);
    const before = grownRef.current;
    grownRef.current = { delivery: delivery.id, shown: reveal.shown };
    const grown = before.delivery === delivery.id && reveal.shown > before.shown;
    const arrivalNow = arrivalRef.current;
    if (!arrivalNow || !scroller || !paneShown) return;
    const due = arrivalDueRef.current;
    if (due) {
      // The list is presented: once the rows at its place are rendered, the ones in view arrive.
      if (Math.abs(motion.current.offset - due.offset) > 1) {
        if (performance.now() - due.at > ARRIVAL_DUE_MS) arrivalDueRef.current = null;
        return;
      }
      const rows = rowsInView();
      if (rows.length === 0) return;
      arrivalDueRef.current = null;
      arrivalNow.present(rows.map((placed) => placed.row));
      return;
    }
    const fresh = rowsInView().filter((placed) => !seen.has(placed.block));
    if (fresh.length === 0) return;
    if (grown) {
      // The batch that was just added arrives; the rows that were there do not move.
      arrivalNow.present(fresh.map((placed) => placed.row));
      return;
    }
    // Rows that a scroll outran catch up with it, from the side it came from; rows built once
    // before are simply there again.
    const { moving, direction } = motion.current;
    if (!moving || arrivalNow.gesture() === "list") return;
    const offset = Math.max(0, motion.current.offset);
    const viewTop = offset;
    const viewBottom = offset + Math.max(virtualizer.scrollRect?.height ?? 0, headPx + rowH) - headPx;
    for (const placed of fresh) {
      if (wasBuilt(placed.block)) continue;
      const step = direction < 0
        ? Math.max(0, Math.round((viewBottom - placed.top - rowH) / rowH))
        : Math.max(0, Math.round((placed.top - viewTop) / rowH));
      arrivalNow.chase(placed.row, step, direction < 0 ? "above" : "below");
    }
  });

  // The next batch is due when the end of what is shown comes into reach: on a scroll, on a
  // pane that grew, and right after a batch that did not fill the pane. A batch that failed
  // (the fetch ended and nothing was added) is asked for again by the user's next scroll or
  // turn of the wheel, never by itself.
  const moreRef = useRef({ loading: loadingMoreRows, ask: onShowMoreRows, failed: false });
  moreRef.current.loading = loadingMoreRows;
  moreRef.current.ask = onShowMoreRows;
  const fetchFromRef = useRef<number | null>(null);
  useEffect(() => {
    if (loadingMoreRows) {
      fetchFromRef.current = reveal.shown;
    } else if (fetchFromRef.current !== null) {
      moreRef.current.failed = fetchFromRef.current === reveal.shown;
      fetchFromRef.current = null;
    }
  }, [loadingMoreRows, reveal.shown]);
  useEffect(() => {
    moreRef.current.failed = false;
  }, [delivery.id]);
  useEffect(() => {
    if (!scroller || !hasMoreRows || !paneShown) return;
    const check = (byUser: boolean) => {
      const more = moreRef.current;
      if (more.loading || (more.failed && !byUser)) return;
      if (!nearListEnd(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight)) return;
      more.failed = false;
      more.ask();
    };
    const onScroll = () => check(true);
    // At the very end a turn of the wheel scrolls nothing, so it is heard on its own.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY > 0) check(true);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => check(false));
    resize?.observe(scroller);
    check(false);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      resize?.disconnect();
    };
  }, [scroller, hasMoreRows, paneShown, listed, delivery.id, reveal.shown]);

  // Rows of a package that mount after their list was delivered (the package was opened again)
  // slot in on their own. A batch added to a flat list is not late: it arrives as a batch.
  const settledRef = useRef<number | null>(null);
  const lateRows = settledRef.current === delivery.id;
  useLayoutEffect(() => {
    if (listed) settledRef.current = delivery.id;
  }, [delivery.id, listed]);

  // The search bar's source marks settle on what this list came back with.
  useLayoutEffect(() => {
    if (!loading) publishSearchOutcome(searchOutcomeOf(items, video));
  }, [loading, items, video]);

  const [colPrefs, setColPrefs] = useState(loadPrefs);
  const colPrefsRef = useRef(colPrefs);
  colPrefsRef.current = colPrefs;
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [colMenu, setColMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragError, setDragError] = useState("");

  const saveColPrefs = (next: TableColumnPrefs) => {
    const normalized = saveTableColumnPrefs(
      RESULT_COLUMN_PREFS_KEY,
      next,
      RESULT_COLUMN_PREFS_SCHEMA,
    );
    colPrefsRef.current = normalized;
    setColPrefs(normalized);
  };

  // 在线结果可能因收起面板或 Vite HMR 直接卸载；卸载 / pagehide 时兜底保存
  // 当前 ref，确保最后一次拖动不会只停留在组件 state 中。
  useEffect(() => {
    const persist = () => {
      saveTableColumnPrefs(
        RESULT_COLUMN_PREFS_KEY,
        colPrefsRef.current,
        RESULT_COLUMN_PREFS_SCHEMA,
      );
    };
    window.addEventListener("pagehide", persist);
    return () => {
      window.removeEventListener("pagehide", persist);
      persist();
    };
  }, []);

  const widthFor = (key: string, fallback: string) => colPrefs.widths[key] ?? fallback;
  const orderedColumns = orderByPrefs(RESULT_COLUMNS, colPrefs.order);
  const colIds = orderedColumns.map((column) => column.key);
  const columnsWithData = resultColumnKeysWithData(items, video);
  const visibleColumns = orderedColumns.filter(
    (column) =>
      !colPrefs.hidden.includes(column.key) && columnsWithData.has(column.key),
  );
  const leadWidth = widthFor("lead", RESULT_LEAD_WIDTH);
  const tableMinWidthPx =
    remStringToPx(RESULT_GUTTER_WIDTH) +
    remStringToPx(leadWidth) +
    visibleColumns.reduce(
      (sum, column) => sum + remStringToPx(widthFor(column.key, column.width)),
      0,
    );

  // What plays on after a row is the rest of the whole item, shown or not. Worked out once per
  // item: a collection that has grown long renders many rows, and renders them on every scroll.
  const followingByItem = useMemo(() => {
    const map = new Map<IntakeItem, { songs: SongPreviewItem[]; after: number[] }>();
    for (const item of items) {
      const following = { songs: [] as SongPreviewItem[], after: [] as number[] };
      for (const candidate of item.groups) {
        const song = previewItem(candidate, sourceIndex[candidate.group_id] ?? candidate.best_source_index);
        if (song) following.songs.push(song);
        following.after.push(following.songs.length);
      }
      map.set(item, following);
    }
    return map;
  }, [items, sourceIndex]);

  const beginColumnResize = (key: string, event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const cell = event.currentTarget.parentElement;
    if (!cell) return;
    const startX = event.clientX;
    const startWidth = cell.getBoundingClientRect().width;
    const minPx = remStringToPx(RESULT_COLUMN_MIN_WIDTH[key] ?? "2.8rem");
    const maxPx = remStringToPx(RESULT_COLUMN_MAX_WIDTH);
    setResizingCol(key);
    document.body.dataset.kdColResizing = "true";

    const onMove = (moveEvent: PointerEvent) => {
      const next = pxToRemString(
        Math.min(maxPx, Math.max(minPx, startWidth + (moveEvent.clientX - startX))),
      );
      setColPrefs((current) => {
        const updated = {
          ...current,
          widths: { ...current.widths, [key]: next },
        };
        colPrefsRef.current = updated;
        return updated;
      });
    };
    let finished = false;
    const onEnd = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      document.body.removeAttribute("data-kd-col-resizing");
      setResizingCol(null);
      saveTableColumnPrefs(
        RESULT_COLUMN_PREFS_KEY,
        colPrefsRef.current,
        RESULT_COLUMN_PREFS_SCHEMA,
      );
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const moveColumn = (from: string, to: string) => {
    saveColPrefs({
      ...colPrefs,
      order: moveColumnOrder(colPrefs.order, colIds, from, to),
    });
  };

  useEffect(() => {
    if (!selectionMode && selected.size === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Esc already consumed by a menu/search field, or cancelling IME input, keeps the picks.
      if (event.defaultPrevented || event.isComposing || isEditable(event.target)) return;
      event.preventDefault();
      for (const key of selectedRef.current) toggleSelectRef.current(key);
      onSelectionModeChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionMode, selected.size, onSelectionModeChange]);

  if (waiting) {
    return (
      <div
        className="kd-empty kd-search-loading"
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="正在处理"
      >
        <LoaderCircle className="kd-spin" size={22} aria-hidden="true" />
      </div>
    );
  }

  if (items.length === 0 && !video) {
    return searched ? (
      <EmptyState icon={<SearchX size={22} />} title="没有结果" />
    ) : (
      <div className="kd-empty" />
    );
  }

  // 全选只管得着可下载且尚未入库的行；歌曲与 B 站视频使用同一组选择键。
  const selectableTotal = items.reduce((sum, item) => sum + selectableGroups(item).length, 0);
  const allSelected =
    selectableTotal > 0 &&
    items.every((item, index) =>
      selectableGroups(item).every((group) => selected.has(selectionKey(index, group.group_id))),
    );

  // `leave` is the row's step in its package fading out (PackageRows).
  const renderCollectionRow = (collection: CollectionResult, collectionIndex: number, indent: boolean, leave?: number) => {
    const token = collectionToken(collection);
    const loadingCollection = loadingCollections.has(token);
    const collectionLabel = KIND_LABEL[collection.kind];
    const openCollection = () => {
      if (!loadingCollection) onLoadCollection(collection);
    };
    const collectionCell = (key: string) => {
      switch (key) {
        case "title":
          return (
            <div key={key} role="gridcell" className="kd-list-cell kd-td-strong" data-col="title" data-flex="" title={collection.title}>
              <span className={`kd-result-title${indent ? " kd-tree-indent" : ""}`}>
                <span className="kd-thumb kd-result-collection-cover">
                  <CoverImage
                    src={thumbUrl(collection.cover)}
                    alt=""
                    loading="lazy"
                    fallback={(
                      <span className="kd-result-collection-cover-fallback" aria-hidden="true">
                        <ListMusic size={17} strokeWidth={2.15} />
                      </span>
                    )}
                  />
                </span>
                <span className="kd-result-title-text">{collection.title}</span>
              </span>
            </div>
          );
        case "artist":
          return (
            <div key={key} role="gridcell" className="kd-list-cell" data-col="artist" title={collection.subtitle}>
              {collection.subtitle}
            </div>
          );
        case "album":
          return (
            <div key={key} role="gridcell" className="kd-list-cell kd-muted" data-col="album">
              {KIND_LABEL[collection.kind]}
            </div>
          );
        case "duration":
          return (
            <div key={key} role="gridcell" className="kd-list-cell kd-td-num kd-muted" data-col="duration">
              {collection.count > 0 ? `${collection.count} 首` : ""}
            </div>
          );
        case "sources":
          return (
            <div key={key} role="gridcell" className="kd-list-cell" data-col="sources" data-flex="">
              <span
                className="kd-row kd-muted kd-result-collection-source"
                data-platform={collection.platform}
                style={{ gap: "0.35rem" }}
              >
                <PlatformMark id={collection.platform} size={12} />
                {PLATFORM_LABEL[collection.platform]}
              </span>
            </div>
          );
        default:
          return <div key={key} role="gridcell" className="kd-list-cell" data-col={key} />;
      }
    };
    return (
      <div
        key={`collection:${token}`}
        className="kd-list-row"
        role="row"
        data-collection="true"
        data-collection-kind={collection.kind}
        data-loading={loadingCollection || undefined}
        aria-busy={loadingCollection || undefined}
        aria-label={`${collection.title}，进入${collectionLabel}`}
        tabIndex={0}
        onClick={openCollection}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          openCollection();
        }}
        title={`进入${collectionLabel}`}
        {...foldingRowProps(leave)}
      >
        <div role="gridcell" className="kd-list-cell kd-result-gutter" />
        <div role="gridcell" className="kd-list-cell kd-result-lead" data-col="index" data-flex="">
          {loadingCollection ? (
            <LoaderCircle className="kd-spin" size={12} aria-hidden="true" />
          ) : (
            <span className="kd-result-index">{collectionIndex + 1}</span>
          )}
        </div>
        {visibleColumns.map((column) => collectionCell(column.key))}
      </div>
    );
  };

  const renderGroupRow = (item: IntakeItem, index: number, group: MergedGroup, position: number, rowNumber: number, indent: boolean, leave?: number) => {
    const following = followingByItem.get(item) ?? { songs: [], after: [] };
    // The source a download of this group takes (the workspace picks the same one).
    const pickedSource = (candidate: MergedGroup) =>
      candidate.sources[sourceIndex[candidate.group_id] ?? candidate.best_source_index]
        ?? candidate.sources[0];
    const dragSources = () => {
      const currentKey = selectionKey(index, group.group_id);
      const draggingSelection = selected.has(currentKey);
      const groups = draggingSelection
        ? items.flatMap((entry, itemIndex) =>
            entry.groups.flatMap((candidate) =>
              selected.has(selectionKey(itemIndex, candidate.group_id))
                ? [candidate]
                : [],
            ),
          )
        : [group];
      return groups.flatMap((candidate) => {
        const preferred =
          candidate.sources[
            sourceIndex[candidate.group_id] ?? candidate.best_source_index
          ] ?? candidate.sources[0];
        // 本地来源只是“库里已有”；DJ/下载都必须选该组真实在线来源。
        const picked = preferred?.platform !== "local"
          ? preferred
          : candidate.sources.find((source) => source.platform !== "local");
        if (!picked) return [];
        const cover = picked.cover?.trim() || candidate.cover?.trim() || "";
        return [{
          ...picked,
          title: candidate.title || picked.title,
          artists: candidate.artists.length > 0
            ? candidate.artists
            : picked.artists,
          album: candidate.album || picked.album,
          duration: candidate.duration ?? picked.duration,
          cover,
        }];
      });
    };
    // 视频与歌曲共用父包层级；分 P 若展开，会在视频自身的层级上再退一层。
    return isVideoGroup(group) ? (
      <VideoResultRow
        key={group.group_id}
        {...videoSeedFromGroup(group)}
        columns={visibleColumns}
        layout={layout}
        rowNumber={rowNumber}
        late={lateRows && indent}
        leave={leave}
        indent={indent}
        selectable={group.sources.some((source) => source.platform !== "local")}
        selected={selected.has(selectionKey(index, group.group_id))}
        selectionMode={selecting}
        pickKey={selectionKey(index, group.group_id)}
        tossItem={pickedSource(group) ? tossItemKey(pickedSource(group)!) : undefined}
        expanded={expandedGroups.has(group.group_id)}
        onToggleExpand={() => onToggleExpand(group.group_id)}
        onToggleSelect={(range) => pickRow(selectionKey(index, group.group_id), range === true)}
        onEnterSelection={() => onSelectionModeChange(true)}
        onDownloadSelected={
          resultRowActionUsesSelection(
            selected,
            selectionKey(index, group.group_id),
          )
            ? onDownloadSelected
            : undefined
        }
        onRemoveFromStreamPlaylist={
          onRemoveStreamGroup
            ? () => onRemoveStreamGroup(group, 0)
            : undefined
        }
        removeFromStreamPlaylistLabel={removeStreamGroupLabel}
        removingFromStreamPlaylist={removingStreamGroupIds?.has(group.group_id)}
      />
    ) : (
      <MergedGroupRow
        key={group.group_id}
        group={group}
        columns={visibleColumns}
        layout={layout}
        indent={indent}
        rowNumber={rowNumber}
        late={lateRows && indent}
        leave={leave}
        inspected={inspectedGroup === selectionKey(index, group.group_id)}
        sourceIndex={sourceIndex[group.group_id] ?? group.best_source_index}
        selected={selected.has(selectionKey(index, group.group_id))}
        selectable={group.sources.some((source) => source.platform !== "local")}
        selectionMode={selecting}
        pickKey={selectionKey(index, group.group_id)}
        expanded={expandedGroups.has(group.group_id)}
        followingSongs={following.songs.slice(following.after[position])}
        onToggleSelect={(range) => pickRow(selectionKey(index, group.group_id), range === true)}
        onEnterSelection={() => onSelectionModeChange(true)}
        onToggleExpand={() => onToggleExpand(group.group_id)}
        onPickSource={(sourceIdx) => onPickSource(group.group_id, sourceIdx)}
        onInspect={(sourceIdx) => {
          const groupKey = selectionKey(index, group.group_id);
          anchorRef.current = groupKey;
          onInspectGroup(group, sourceIdx, groupKey);
        }}
        onDownload={() => {
          const groupKey = selectionKey(index, group.group_id);
          if (resultRowActionUsesSelection(selected, groupKey)) onDownloadSelected();
          else onDownloadGroup(group);
        }}
        onDownloadSingle={() => onDownloadGroup(group)}
        onRemoveFromStreamPlaylist={
          onRemoveStreamGroup
            ? () => onRemoveStreamGroup(
                group,
                sourceIndex[group.group_id] ?? group.best_source_index,
              )
            : undefined
        }
        removeFromStreamPlaylistLabel={removeStreamGroupLabel}
        removingFromStreamPlaylist={removingStreamGroupIds?.has(group.group_id)}
        previewPendingSourceKey={previewPendingSourceKey}
        previewPendingLabel={previewPendingLabel}
        onDragStart={(event) => {
          writeSearchSourcesDrag(
            event.dataTransfer,
            dragSources(),
            event.currentTarget,
          );
        }}
        onDragEnd={() => endSearchDrag()}
        onPointerDragStart={(event, onActivated) =>
          beginAudioPointerDrag(
            event.nativeEvent,
            dragSources(),
            group.title,
            (error) => setDragError(error instanceof Error ? error.message : String(error)),
            onActivated,
          )}
      />
    );
  };

  /** A package: its head row and, under it, its collections and the groups reached so far. */
  const renderPackage = (block: Extract<ResultBlock, { kind: "package" }>) => {
    const { item, itemIndex: index, shownGroups, collapsed } = block;
    const collectionKind =
      item.kind === "playlist" || item.kind === "artist" || item.kind === "album"
        ? item.kind
        : null;
    const visibleGroups = item.groups.slice(0, shownGroups);
    const pickable = selectableGroups(item);
    const itemPick = pickStateOf(
      pickable.map((group) => selectionKey(index, group.group_id)),
      selected,
    );
    const packageRowCount = item.collections.length + visibleGroups.length;
    // A package that folds away shows pictures of the rows that can be on screen.
    const renderRows = (leaving?: number) => (
      <>
        {item.collections.slice(0, leaving ?? item.collections.length).map((collection, collectionIndex) =>
          renderCollectionRow(collection, collectionIndex, true, leaving === undefined ? undefined : foldOrder(collectionIndex, leaving)))}
        {(leaving === undefined ? visibleGroups : visibleGroups.slice(0, Math.max(0, leaving - item.collections.length)))
          .map((group, position) => renderGroupRow(item, index, group, position, position + 1, true,
            leaving === undefined ? undefined : foldOrder(item.collections.length + position, leaving)))}
      </>
    );
    return (
      <>
        <div
          className="kd-list-row"
          role="row"
          data-tree="parent"
          data-collection-kind={collectionKind ?? undefined}
          onClick={() => {
            if (suppressParentClickRef.current === index) {
              suppressParentClickRef.current = null;
              return;
            }
            onToggleItem(index);
          }}
          onPointerDown={(event) => {
            if (event.pointerType === "mouse") return;
            if (parentPressRef.current !== null) window.clearTimeout(parentPressRef.current);
            parentPressRef.current = window.setTimeout(() => {
              // 包行自身没有独立操作；长按只抑制随后那次误点击，不得直接
              // 进入批选。具体歌曲长按会打开和桌面相同的右键菜单。
              suppressParentClickRef.current = index;
              parentPressRef.current = null;
            }, 480);
          }}
          onPointerUp={() => {
            if (parentPressRef.current !== null) window.clearTimeout(parentPressRef.current);
            parentPressRef.current = null;
          }}
          onPointerCancel={() => {
            if (parentPressRef.current !== null) window.clearTimeout(parentPressRef.current);
            parentPressRef.current = null;
          }}
          onContextMenu={(event) => {
            event.preventDefault();
          }}
        >
          <div role="gridcell" className="kd-list-cell kd-result-gutter" />
          <div role="gridcell" className="kd-list-cell kd-result-lead" data-flex="">
            {(item.groups.length > 0 || item.collections.length > 0) && (
              <span className="kd-result-lead-actions">
                {/* The package's own mark takes the empty slot before its chevron. */}
                {selecting && pickable.length > 0 ? (
                  <span className="kd-result-lead-spacer">
                    <RowPick
                      state={itemPick}
                      label={`选择「${item.title || item.entry}」全部曲目`}
                      onToggle={() => onToggleItemAll(index)}
                    />
                  </span>
                ) : (
                  <span className="kd-result-lead-spacer" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className="kd-result-lead-btn"
                  aria-label={collapsed ? `展开「${item.title || item.entry}」` : `收起「${item.title || item.entry}」`}
                  aria-expanded={!collapsed}
                  title={collapsed ? "展开" : "收起"}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleItem(index);
                  }}
                >
                  {/* One chevron: the stylesheet turns it while the package is open. */}
                  <ChevronRight size={13} />
                </button>
              </span>
            )}
          </div>
          <div role="gridcell" className="kd-list-cell kd-result-package-cell" data-flex="" style={{ gridColumn: "3 / -1" }}>
            <span className="kd-result-package-head">
              {collectionKind && item.groups[0]?.cover ? (
                <span className="kd-thumb kd-result-collection-cover">
                  <CoverImage src={thumbUrl(item.groups[0].cover)} alt="" loading="lazy" />
                </span>
              ) : null}
              {!collectionKind ? (
                <span
                  className="kd-chip"
                  data-tone={item.kind === "error" ? "danger" : undefined}
                >
                  {KIND_LABEL[item.kind]}
                </span>
              ) : null}
              <strong className="kd-truncate" title={item.title || item.entry}>
                {item.title || item.entry}
              </strong>
              {collectionKind && item.platform ? (
                <span
                  className="kd-result-collection-platform"
                  data-platform={item.platform}
                  title={`来源：${PLATFORM_LABEL[item.platform] ?? item.platform}`}
                  aria-label={`来源：${PLATFORM_LABEL[item.platform] ?? item.platform}`}
                >
                  <PlatformMark id={item.platform} size={12} />
                </span>
              ) : null}
              {item.error && (
                <span
                  className="kd-row kd-truncate"
                  style={{ color: "var(--kd-danger)", gap: "0.25rem" }}
                  title={item.error}
                >
                  <AlertTriangle size={12} />
                  {item.error}
                </span>
              )}
              {Object.entries(item.errors).map(([platform, message]) => (
                <span
                  key={platform}
                  className="kd-chip"
                  data-tone="warn"
                  title={`${platform}：${message}`}
                >
                  {PLATFORM_LABEL[platform as keyof typeof PLATFORM_LABEL] ?? platform}{" "}
                  失败
                </span>
              ))}
              <span className="kd-result-package-actions">
                {(item.collections.length > 0 || item.groups.length > 0) && (
                  <span className="kd-result-collection-count">
                    {item.collections.length > 0 ? `${item.collections.length} 个集合` : ""}
                    {item.groups.length > 0 ? `${item.collections.length > 0 ? " · " : ""}${item.groups.length} 首` : ""}
                  </span>
                )}
              </span>
            </span>
          </div>
        </div>
        <PackageRows open={!collapsed} count={packageRowCount}>
          {(leaving) =>
            renderRows(leaving ? Math.min(packageRowCount, FOLD_MAX_ROWS) : undefined)
          }
        </PackageRows>
      </>
    );
  };

  const renderBlock = (block: ResultBlock) => {
    switch (block.kind) {
      case "video":
        // 贴进来的那条链接置顶：它是用户刚刚亲手要的东西，不该排在搜索结果后面
        return (
          <VideoResultRow
            {...videoSeedFromInfo(block.video)}
            info={block.video}
            columns={visibleColumns}
            layout={layout}
            rowNumber={1}
            late={lateRows}
          />
        );
      case "collection":
        return renderCollectionRow(block.collection, block.collectionIndex, block.indent);
      case "group":
        return renderGroupRow(block.item, block.itemIndex, block.group, block.position, block.rowNumber, block.indent);
      case "package":
        return renderPackage(block);
    }
  };

  const renderColumnHead = (column: ResultColumn) => (
    <div
      key={column.key}
      role="columnheader"
      className={column.align === "num" ? "kd-list-hcell kd-td-num" : "kd-list-hcell"}
      data-col={column.key}
      data-column-reorder="true"
      onPointerDown={(event) => {
        if (resizingCol) return;
        beginColumnPointerReorder(event, column.key, visibleColumns.map((item) => item.key), {
          onStart: setDragCol,
          onOver: setOverCol,
          onMove: moveColumn,
          onEnd: () => {
            setDragCol(null);
            setOverCol(null);
          },
        });
      }}
      data-dragging={dragCol === column.key ? "true" : undefined}
      data-col-drop={
        dragCol && dragCol !== column.key && overCol === column.key
          ? colIds.indexOf(dragCol) < colIds.indexOf(column.key)
            ? "after"
            : "before"
          : undefined
      }
      title="拖动列头换列序；右缘拖动调列宽；右键选择显示哪些列"
    >
      {column.label}
      <span
        className="kd-col-resize"
        data-active={resizingCol === column.key ? "true" : undefined}
        onPointerDown={(event) => beginColumnResize(column.key, event)}
        onClick={(event) => event.stopPropagation()}
        aria-hidden="true"
      />
    </div>
  );

  // 左边距 + 序号 + 数据列 + 弹性空白列。批选不占列：选择标记落在序号格里。
  const listStyle = {
    "--kd-list-cols": [RESULT_GUTTER_WIDTH, leadWidth, ...visibleColumns.map((column) => widthFor(column.key, column.width)), "minmax(0, 1fr)"].join(" "),
    "--kd-list-min-width": `${tableMinWidthPx}px`,
  } as CSSProperties;

  return (
    <>
      <InlineNotice text={dragError} onDismiss={() => setDragError("")} block />
      <div
        ref={listRef}
        className="kd-list"
        role="grid"
        data-kind="results"
        data-flat={flat || undefined}
        aria-rowcount={resultRowCount(blocks)}
        style={listStyle}
      >
        {/* 只贴了一条 B 站链接时不摆表头：艺人/专辑/音质这些列底下一个格子都没有，
            光留一排列名反而像"结果没加载出来" */}
        {headShown && (
          <div
            className="kd-list-head"
            role="row"
            onContextMenu={(event) => {
              event.preventDefault();
              setColMenu({ x: event.clientX, y: event.clientY });
            }}
          >
            <div className="kd-list-hcell kd-result-gutter" aria-hidden="true" />
            <div
              role="columnheader"
              className="kd-list-hcell"
              data-col="index"
              data-picking={selecting ? "true" : undefined}
              title={selecting ? undefined : "当前列表中的序号"}
            >
              <span className="kd-th-label">序号</span>
              {/* Above the rows' marks, in their place: all of the list, a part of it, none. */}
              {selecting ? (
                <RowPick
                  className="kd-pick-head"
                  state={allSelected ? "all" : selected.size > 0 ? "some" : "none"}
                  label="全选"
                  disabled={selectableTotal === 0}
                  onToggle={() => {
                    onToggleAll();
                    // Dropping every row through the head's mark stays in the mode.
                    onSelectionModeChange(true);
                  }}
                />
              ) : null}
              <span
                className="kd-col-resize"
                data-active={resizingCol === "lead" ? "true" : undefined}
                onPointerDown={(event) => beginColumnResize("lead", event)}
                onClick={(event) => event.stopPropagation()}
                aria-hidden="true"
              />
            </div>
            {visibleColumns.map(renderColumnHead)}
          </div>
        )}
        <div ref={bodyRef} className="kd-list-body" role="rowgroup" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((item) => (
            <div
              key={item.key}
              ref={registerBlock}
              className="kd-list-block"
              data-index={item.index}
              data-kd-block-key={String(item.key)}
              style={{ top: item.start - headPx }}
            >
              {renderBlock(blocks[item.index])}
            </div>
          ))}
        </div>
        {/* The room at the foot is held while the list can still grow, so the ring that turns
            there during a fetch moves nothing. */}
        {hasMoreRows ? (
          <div
            className="kd-result-more"
            role={loadingMoreRows ? "status" : undefined}
            aria-label={loadingMoreRows ? "正在载入更多" : undefined}
            aria-hidden={loadingMoreRows ? undefined : true}
          >
            {loadingMoreRows ? <LoaderCircle className="kd-spin" size={16} aria-hidden="true" /> : null}
          </div>
        ) : null}
      </div>
      {colMenu && (
        <ContextMenu x={colMenu.x} y={colMenu.y} onClose={() => setColMenu(null)}>
          {orderedColumns.map((column) => {
            const hasData = columnsWithData.has(column.key);
            const isHidden = colPrefs.hidden.includes(column.key) || !hasData;
            const locked = column.hideable === false;
            return (
              <button
                key={column.key}
                type="button"
                disabled={locked || !hasData}
                title={
                  locked
                    ? "标题列不能藏"
                    : !hasData
                      ? `当前结果没有${column.label}信息`
                      : undefined
                }
                onClick={() =>
                  saveColPrefs({
                    ...colPrefs,
                    hidden: colPrefs.hidden.includes(column.key)
                      ? colPrefs.hidden.filter((key) => key !== column.key)
                      : [...colPrefs.hidden, column.key],
                  })
                }
              >
                <Check size={12} style={{ opacity: isHidden ? 0 : 1 }} />
                {column.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              removeLocalStorage(RESULT_COLUMN_PREFS_KEY);
              const defaults = loadPrefs();
              colPrefsRef.current = defaults;
              setColPrefs(defaults);
              setColMenu(null);
            }}
          >
            <RotateCcw size={12} />
            恢复默认列
          </button>
        </ContextMenu>
      )}
    </>
  );
});
