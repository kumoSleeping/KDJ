import { Fragment, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Disc3,
  Download,
  LoaderCircle,
  ListMusic,
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
import { ContextMenu, EmptyState } from "../common";
import { MergedGroupRow, PLATFORM_LABEL } from "./MergedGroupRow";
import { PlatformMark } from "./PlatformMark";
import { endSearchDrag, writeSearchSourcesDrag } from "../../lib/searchDrag";
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
  RESULT_LEAD_WIDTH,
  type ResultColumn,
} from "./resultColumns";
import type { LayoutMode } from "../../lib/useLayoutMode";
import { collectionToken } from "../../lib/searchCollections";
import { CoverImage } from "../common/VinylPlaceholder";
import { selectableGroups, selectionKey } from "../../lib/resultSelection";

export { selectableGroups, selectionKey } from "../../lib/resultSelection";

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

function isResolvedCollectionItem(item: IntakeItem): boolean {
  return (
    item.groups.length > 0 &&
    (item.kind === "playlist" || item.kind === "artist" || item.kind === "album")
  );
}

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
  onToggleSelect(key: string): void;
  onToggleExpand(groupId: string): void;
  onPickSource(groupId: string, index: number): void;
  onToggleItem(index: number): void;
  onToggleItemAll(index: number): void;
  onToggleAll(): void;
  onDownloadItem(index: number): void;
  /** 单曲显式下载入口（右键菜单等；序号列本身不再放下载键）。 */
  onDownloadGroup(group: MergedGroup): void;
  /** 普通单击在线曲目时选中来源并打开右侧详情。 */
  onInspectGroup(group: MergedGroup, sourceIndex: number): void;
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

function loadPrefs(): TableColumnPrefs {
  return loadTableColumnPrefs(RESULT_COLUMN_PREFS_KEY, RESULT_COLUMN_PREFS_SCHEMA);
}

export function ResultTable({
  items,
  video,
  loading,
  searched,
  layout,
  selected,
  selectionMode,
  onSelectionModeChange,
  expandedGroups,
  collapsedItems,
  sourceIndex,
  onToggleSelect,
  onToggleExpand,
  onPickSource,
  onToggleItem,
  onToggleItemAll,
  onToggleAll,
  onDownloadItem,
  onDownloadGroup,
  onInspectGroup,
  onLoadCollection,
  loadingCollections,
}: ResultTableProps) {
  const [inspectedGroup, setInspectedGroup] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const toggleSelectRef = useRef(onToggleSelect);
  toggleSelectRef.current = onToggleSelect;
  const parentPressRef = useRef<number | null>(null);
  const suppressParentClickRef = useRef<number | null>(null);
  const totalGroups = items.reduce((sum, item) => sum + item.groups.length, 0);

  const [colPrefs, setColPrefs] = useState(loadPrefs);
  const colPrefsRef = useRef(colPrefs);
  colPrefsRef.current = colPrefs;
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [colMenu, setColMenu] = useState<{ x: number; y: number } | null>(null);

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
  const visibleColumns = orderedColumns.filter((column) => !colPrefs.hidden.includes(column.key));
  const leadWidth = widthFor("lead", RESULT_LEAD_WIDTH);
  // 批选列只在 selectionMode 时占满勾选宽；平时留一点左边距，别贴死边缘。
  // 不能继续写死 2.2rem：fixed 布局下 <col> 会盖过 .kd-selection-cell { width: 0 }。
  const selectionColWidth = selectionMode ? "2.2rem" : "0.35rem";
  const totalColumns = 3 + visibleColumns.length;
  const tableMinWidthPx =
    remStringToPx(selectionColWidth) +
    remStringToPx(leadWidth) +
    visibleColumns.reduce(
      (sum, column) => sum + remStringToPx(widthFor(column.key, column.width)),
      0,
    );

  const beginColumnResize = (key: string, event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const th = event.currentTarget.parentElement;
    if (!th) return;
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
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
      event.preventDefault();
      for (const key of selectedRef.current) toggleSelectRef.current(key);
      onSelectionModeChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionMode, selected.size, onSelectionModeChange]);

  // 新一轮查询沿用相同 group_id 的概率并不为零；结果整体替换时清掉旧高亮，
  // 避免右栏仍是上一轮曲目、列表却误把新一轮同 id 行标成已选中。
  useEffect(() => setInspectedGroup(null), [items]);

  if (loading && totalGroups === 0 && !video) {
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
      <EmptyState
        icon={<SearchX size={22} />}
        title="没有结果"
        hint="换个关键词试试；如果某个平台报错，看上方的错误提示——多半是没登录或该平台限制了。"
      />
    ) : (
      <EmptyState
        icon={<Disc3 size={22} />}
        title="搜点什么"
        hint="支持关键词、分享链接、歌单链接；直接粘贴多行文本会自动按行拆开批量处理。"
      />
    );
  }

  // 单条关键词搜索就是普通列表，不套壳——套一层"包"只会平白多一行。
  const flat = items.length === 1 && items[0].kind === "search";
  // 全选只管得着可下载且尚未入库的行；歌曲与 B 站视频使用同一组选择键。
  const selectableTotal = items.reduce((sum, item) => sum + selectableGroups(item).length, 0);
  const allSelected =
    selectableTotal > 0 &&
    items.every((item, index) =>
      selectableGroups(item).every((group) => selected.has(selectionKey(index, group.group_id))),
    );

  const renderCollectionRows = (item: IntakeItem) =>
    item.collections.map((collection, collectionIndex) => {
      const token = collectionToken(collection);
      const loadingCollection = loadingCollections.has(token);
      const openCollection = () => {
        if (!loadingCollection) onLoadCollection(collection);
      };
      const collectionCell = (key: string) => {
        switch (key) {
          case "title":
            return (
              <td key={key} className="kd-td-strong" data-col="title" title={collection.title}>
                <span className="kd-result-title">
                  <span className="kd-thumb">
                    <CoverImage src={collection.cover} alt="" loading="lazy" />
                  </span>
                  <span className="kd-result-title-text">{collection.title}</span>
                </span>
              </td>
            );
          case "artist":
            return (
              <td key={key} data-col="artist" title={collection.subtitle}>
                {collection.subtitle}
              </td>
            );
          case "album":
            return (
              <td key={key} data-col="album" className="kd-muted">
                {KIND_LABEL[collection.kind]}
              </td>
            );
          case "duration":
            return (
              <td key={key} data-col="duration" className="kd-td-num kd-muted">
                {collection.count > 0 ? `${collection.count} 首` : ""}
              </td>
            );
          case "sources":
            return (
              <td key={key} data-col="sources">
                <span className="kd-row kd-muted" style={{ gap: "0.35rem" }}>
                  <PlatformMark id={collection.platform} size={12} />
                  {PLATFORM_LABEL[collection.platform]}
                </span>
              </td>
            );
          default:
            return <td key={key} data-col={key} />;
        }
      };
      return (
        <tr
          key={`collection:${token}`}
          data-collection="true"
          data-loading={loadingCollection || undefined}
          aria-busy={loadingCollection || undefined}
          aria-label={`${collection.title}，打开并载入曲目`}
          tabIndex={0}
          onClick={openCollection}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openCollection();
          }}
          title="打开并载入曲目"
        >
          <td className="kd-selection-cell" />
          <td className="kd-result-lead" data-col="index">
            {loadingCollection ? (
              <LoaderCircle className="kd-spin" size={12} aria-hidden="true" />
            ) : (
              <span className="kd-result-index">{collectionIndex + 1}</span>
            )}
          </td>
          {visibleColumns.map((column) => collectionCell(column.key))}
          <td className="kd-table-fill" aria-hidden="true" />
        </tr>
      );
    });

  const renderOpenedCollectionHead = (
    item: IntakeItem,
    index: number,
    pickableCount: number,
    collapsed: boolean,
  ) => (
    <tr
      data-collection-open="true"
      data-collapsed={collapsed || undefined}
      aria-expanded={!collapsed}
      aria-label={`${item.title || item.entry}，${collapsed ? "展开" : "收起"}曲目`}
      tabIndex={0}
      title={collapsed ? "展开曲目" : "收起曲目"}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        onToggleItem(index);
      }}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onToggleItem(index);
      }}
    >
      <td className="kd-selection-cell" />
      <td className="kd-result-lead" data-col="index">
        {collapsed ? (
          <ChevronRight size={13} aria-hidden="true" />
        ) : (
          <ChevronDown size={13} aria-hidden="true" />
        )}
      </td>
      <td colSpan={Math.max(1, visibleColumns.length + 1)}>
        <span className="kd-row" style={{ gap: "0.45rem", minWidth: 0 }}>
          {item.groups[0]?.cover ? (
            <span className="kd-thumb">
              <CoverImage src={item.groups[0].cover} alt="" loading="lazy" />
            </span>
          ) : null}
          {item.platform ? <PlatformMark id={item.platform} size={13} /> : null}
          <span className="kd-chip" data-tone="theme">
            {KIND_LABEL[item.kind]}
          </span>
          <strong className="kd-truncate" title={item.title || item.entry}>
            {item.title || item.entry}
          </strong>
          <span className="kd-faint">
            {item.groups.length} {item.platform === "bilibili" ? "个视频" : "首"}
          </span>
          {pickableCount > 0 ? (
            <button
              type="button"
              className="kd-result-download-all"
              style={{ marginLeft: "auto" }}
              onClick={(event) => {
                event.stopPropagation();
                onDownloadItem(index);
              }}
            >
              <Download size={12} />
              全部下载
            </button>
          ) : null}
        </span>
      </td>
    </tr>
  );

  const renderColumnHead = (column: ResultColumn) => {
    const colWidth = widthFor(column.key, column.width);
    return (
      <th
        key={column.key}
        data-col={column.key}
        data-column-reorder="true"
        style={{ width: colWidth }}
        className={column.align === "num" ? "kd-td-num" : undefined}
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
      </th>
    );
  };

  return (
    <>
      <table className="kd-table" data-kind="results" style={{ minWidth: tableMinWidthPx }}>
        <colgroup>
          <col style={{ width: selectionColWidth }} />
          <col style={{ width: leadWidth }} />
          {visibleColumns.map((column) => (
            <col key={column.key} style={{ width: widthFor(column.key, column.width) }} />
          ))}
          <col />
        </colgroup>
        {/* 只贴了一条 B 站链接时不摆表头：艺人/专辑/音质这些列底下一个格子都没有，
            光留一排列名反而像"结果没加载出来" */}
        {items.length > 0 && (
          <thead>
            <tr
              onContextMenu={(event) => {
                event.preventDefault();
                setColMenu({ x: event.clientX, y: event.clientY });
              }}
            >
              <th className="kd-selection-cell" data-active={selectionMode ? "true" : undefined}>
                {selectionMode && (
                  <input
                    type="checkbox"
                    checked={allSelected}
                    aria-label="全选"
                    onChange={onToggleAll}
                  />
                )}
              </th>
              <th data-col="index" style={{ width: leadWidth }} title="当前列表中的序号">
                序号
                <span
                  className="kd-col-resize"
                  data-active={resizingCol === "lead" ? "true" : undefined}
                  onPointerDown={(event) => beginColumnResize("lead", event)}
                  onClick={(event) => event.stopPropagation()}
                  aria-hidden="true"
                />
              </th>
              {visibleColumns.map(renderColumnHead)}
              <th className="kd-table-fill" aria-hidden="true" />
            </tr>
          </thead>
        )}
        <tbody>
          {/* 贴进来的那条链接置顶：它是用户刚刚亲手要的东西，不该排在搜索结果后面 */}
          {video && (
            <VideoResultRow
              key={video.bvid}
              {...videoSeedFromInfo(video)}
              info={video}
              columns={visibleColumns}
              totalColumns={totalColumns}
              layout={layout}
              rowNumber={1}
            />
          )}
          {items.map((item, index) => {
            const directCollection = isResolvedCollectionItem(item);
            const itemFlat = flat || directCollection;
            const flatRowOffset = itemFlat
              ? (video ? 1 : 0) +
                items
                  .slice(0, index)
                  .filter(isResolvedCollectionItem)
                  .reduce((sum, previous) => sum + previous.groups.length, 0)
              : 0;
            const collapsed = collapsedItems.has(index);
            const pickable = selectableGroups(item);
            const itemSelected =
              pickable.length > 0 &&
              pickable.every((group) => selected.has(selectionKey(index, group.group_id)));

            const groupRows = item.groups.map((group, position) =>
                  // 视频行横跨整张表，所以它不吃 indent/last 那套导引线——
                  // 一条挂在两倍高的块上的肘线只会显得断掉
                  isVideoGroup(group) ? (
                    <VideoResultRow
                      key={group.group_id}
                      {...videoSeedFromGroup(group)}
                      columns={visibleColumns}
                      totalColumns={totalColumns}
                      layout={layout}
                      rowNumber={flatRowOffset + position + 1}
                      selectable={!group.in_library}
                      selected={selected.has(selectionKey(index, group.group_id))}
                      selectionMode={selectionMode}
                      onToggleSelect={() => onToggleSelect(selectionKey(index, group.group_id))}
                      onEnterSelection={() => onSelectionModeChange(true)}
                    />
                  ) : (
                    <MergedGroupRow
                      key={group.group_id}
                      group={group}
                      columns={visibleColumns}
                      layout={layout}
                      indent={!itemFlat}
                      last={position === item.groups.length - 1}
                      rowNumber={flatRowOffset + position + 1}
                      inspected={inspectedGroup === selectionKey(index, group.group_id)}
                      sourceIndex={sourceIndex[group.group_id] ?? group.best_source_index}
                      selected={selected.has(selectionKey(index, group.group_id))}
                      selectable={group.sources.some((source) => source.platform !== "local")}
                      selectionMode={selectionMode}
                      expanded={expandedGroups.has(group.group_id)}
                      followingSongs={item.groups
                        .slice(position + 1)
                        .flatMap((candidate) => {
                          const next = previewItem(
                            candidate,
                            sourceIndex[candidate.group_id] ?? candidate.best_source_index,
                          );
                          return next ? [next] : [];
                        })}
                      onToggleSelect={() => onToggleSelect(selectionKey(index, group.group_id))}
                      onEnterSelection={() => onSelectionModeChange(true)}
                      onToggleExpand={() => onToggleExpand(group.group_id)}
                      onPickSource={(sourceIdx) => onPickSource(group.group_id, sourceIdx)}
                      onInspect={(sourceIdx) => {
                        setInspectedGroup(selectionKey(index, group.group_id));
                        onInspectGroup(group, sourceIdx);
                      }}
                      onDownload={() => onDownloadGroup(group)}
                      onDragStart={(event) => {
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
                        const sources = groups.flatMap((candidate) => {
                          const preferred =
                            candidate.sources[
                              sourceIndex[candidate.group_id] ?? candidate.best_source_index
                            ] ?? candidate.sources[0];
                          // 本地来源只表示“库里已有”，不能送进下载接口。正常情况下后端
                          // best_source_index 已避开它；旧缓存或手动来源索引仍可能指向 local，
                          // 拖放时必须退回该组第一条在线来源，不能生成一个空载荷。
                          const picked =
                            preferred?.platform !== "local"
                              ? preferred
                              : candidate.sources.find((source) => source.platform !== "local");
                          if (!picked) return [];
                          // 列表封面用的是合并组的 cover（可能来自另一家平台）；
                          // 入选源自己常常是空的——不盖回去，待下载行就会空着方框。
                          const cover = picked.cover?.trim() || candidate.cover?.trim() || "";
                          return cover && cover !== picked.cover
                            ? [{ ...picked, cover }]
                            : [picked];
                        });
                        writeSearchSourcesDrag(event.dataTransfer, sources);
                      }}
                      onDragEnd={() => endSearchDrag()}
                    />
                  ),
                );
            // 已经解析成真实曲目的远程集合保持普通曲目行，只在第一行上方留一条
            // 当前集合标题。它不是可折叠父包，不画树枝，也不会把歌曲再次套层级。
            const rows =
              !collapsed ? (
                <>
                  {renderCollectionRows(item)}
                  {groupRows}
                </>
              ) : null;

            if (itemFlat) {
              return (
                <Fragment key={item.entry}>
                  {directCollection
                    ? renderOpenedCollectionHead(item, index, pickable.length, collapsed)
                    : null}
                  {rows}
                </Fragment>
              );
            }

            return (
              <Fragment key={`${index}:${item.entry}`}>
                <tr
                  data-tree="parent"
                  data-selecting={selectionMode ? "true" : undefined}
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
                      // 开复选框。具体歌曲长按会打开和桌面相同的右键菜单。
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
                  <td className="kd-selection-cell" data-active={selectionMode ? "true" : undefined}>
                    {selectionMode && (
                      <input
                        type="checkbox"
                        checked={itemSelected}
                        disabled={pickable.length === 0}
                        aria-label={`选择「${item.title || item.entry}」全部曲目`}
                        onChange={() => onToggleItemAll(index)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    )}
                  </td>
                  <td className="kd-result-lead">
                    {(item.groups.length > 0 || item.collections.length > 0) && (
                      <span className="kd-result-lead-actions">
                        <span className="kd-result-lead-spacer" aria-hidden="true" />
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
                          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        </button>
                      </span>
                    )}
                  </td>
                  <td colSpan={Math.max(1, visibleColumns.length + 1)}>
                    <span className="kd-row" style={{ gap: "0.45rem", minWidth: 0 }}>
                      <span
                        className="kd-chip"
                        data-tone={item.kind === "error" ? "danger" : "theme"}
                      >
                        {KIND_LABEL[item.kind]}
                      </span>
                      {item.kind === "playlist" || item.kind === "artist" || item.kind === "album" ? (
                        <ListMusic size={13} className="kd-muted" />
                      ) : null}
                      <strong className="kd-truncate" title={item.title || item.entry}>
                        {item.title || item.entry}
                      </strong>
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
                      <span className="kd-result-package-actions" style={{ marginLeft: "auto" }}>
                        {item.collections.length > 0 ? `${item.collections.length} 个集合` : ""}
                        {item.groups.length > 0 ? `${item.collections.length > 0 ? " · " : ""}${item.groups.length} 首` : ""}
                        {(item.kind === "playlist" || item.kind === "artist" || item.kind === "album") &&
                          pickable.length > 0 && (
                            <button
                              type="button"
                              className="kd-result-download-all"
                              onClick={(event) => {
                                event.stopPropagation();
                                onDownloadItem(index);
                              }}
                            >
                              <Download size={12} />
                              全部下载
                            </button>
                          )}
                      </span>
                    </span>
                  </td>
                </tr>
                {rows}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {colMenu && (
        <ContextMenu x={colMenu.x} y={colMenu.y} onClose={() => setColMenu(null)}>
          {orderedColumns.map((column) => {
            const isHidden = colPrefs.hidden.includes(column.key);
            const locked = column.hideable === false;
            return (
              <button
                key={column.key}
                type="button"
                disabled={locked}
                title={locked ? "标题列不能藏" : undefined}
                onClick={() =>
                  saveColPrefs({
                    ...colPrefs,
                    hidden: isHidden
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
              localStorage.removeItem(RESULT_COLUMN_PREFS_KEY);
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
}
