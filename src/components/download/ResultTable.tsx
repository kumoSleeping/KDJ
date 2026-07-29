import { Fragment, useEffect, useRef } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Disc3,
  Download,
  LoaderCircle,
  ListMusic,
  SearchX,
} from "lucide-react";
import type { IntakeItem, IntakeKind, MergedGroup, VideoInfo } from "../../types";
import { EmptyState } from "../common";
import { MergedGroupRow, PLATFORM_LABEL } from "./MergedGroupRow";
import { endSearchDrag, writeSearchSourcesDrag } from "../../lib/searchDrag";
import {
  isVideoGroup,
  VideoResultRow,
  videoSeedFromGroup,
  videoSeedFromInfo,
} from "./VideoResultRow";

const KIND_LABEL: Record<IntakeKind, string> = {
  search: "搜索",
  song: "单曲",
  playlist: "歌单",
  album: "专辑",
  unknown: "链接",
  error: "失败",
};

/** 选中键：group_id 在不同 item 之间可能重复（同一首歌被两条关键词搜到）。 */
export function selectionKey(itemIndex: number, groupId: string): string {
  return `${itemIndex}:${groupId}`;
}

/**
 * 能进"勾选 → 批量入队"那条路的组。
 *
 * 视频行被排除在外：画质 / 只要音轨 / 分 P 是逐条选的，批量入队那条接口
 * （`/download` 收的是 `SongSource`）带不上这些参数。两条路并存的话，
 * 用户在行里调完画质再去按底下那颗「加入队列」，调的东西会被无声丢掉。
 * 所以视频行没有勾选框，只有它自己那颗「下载」。
 */
export function selectableGroups(item: IntakeItem): MergedGroup[] {
  return item.groups.filter(
    (group) =>
      !isVideoGroup(group) && group.sources.some((source) => source.platform !== "local"),
  );
}

export interface ResultTableProps {
  items: IntakeItem[];
  /** 贴 B 站链接解析出来的那一个视频，置顶在结果最前面。 */
  video: VideoInfo | null;
  loading: boolean;
  /** 已处理过一次（用来区分"还没搜"和"搜了没结果"）。 */
  searched: boolean;
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
  /** 单首直接入队（行首下载键）。 */
  onDownloadGroup(group: MergedGroup): void;
}

/** 表头列（首列的全选框由组件自己渲染，所以不在这里）。
 * 标题 / 艺人 / 专辑宽度对齐曲库 TrackTable：标题固定 14rem，不参与压缩。 */
const HEAD_COLUMNS: ReadonlyArray<{
  label: string;
  width?: string;
  num?: boolean;
  col?: string;
}> = [
  { label: "", width: "3.4rem" },
  { label: "标题", width: "14rem", col: "title" },
  { label: "艺人", width: "6.5rem", col: "artist" },
  { label: "专辑", width: "5.75rem", col: "album" },
  { label: "时长", width: "4.5rem", num: true },
  { label: "来源", width: "4.5rem" },
  { label: "下载自", width: "4.5rem" },
  { label: "音质", width: "4rem", num: true },
  { label: "", width: "3rem" },
];

/** 视频行横跨整张表：首列的勾选框 + 上面这些列。 */
const TOTAL_COLUMNS = HEAD_COLUMNS.length + 1;

export function ResultTable({
  items,
  video,
  loading,
  searched,
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
}: ResultTableProps) {
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const toggleSelectRef = useRef(onToggleSelect);
  toggleSelectRef.current = onToggleSelect;
  const parentPressRef = useRef<number | null>(null);
  const suppressParentClickRef = useRef<number | null>(null);
  const totalGroups = items.reduce((sum, item) => sum + item.groups.length, 0);

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

  if (loading && totalGroups === 0 && !video) {
    return (
      <EmptyState
        icon={<LoaderCircle className="kd-spin" size={22} />}
        title="正在处理"
        hint="并发打各个平台；批量时每条独立跑，先出结果的先显示。"
      />
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
  // 全选只管得着有勾选框的那些行，视频行不算在内，否则搜出来一屏视频时
  // 表头那个框会永远勾不满
  const selectableTotal = items.reduce((sum, item) => sum + selectableGroups(item).length, 0);
  const allSelected =
    selectableTotal > 0 &&
    items.every((item, index) =>
      selectableGroups(item).every((group) => selected.has(selectionKey(index, group.group_id))),
    );

  return (
    <table className="kd-table">
      {/* 只贴了一条 B 站链接时不摆表头：艺人/专辑/音质这些列底下一个格子都没有，
          光留一排列名反而像"结果没加载出来" */}
      {items.length > 0 && (
        <thead>
          <tr>
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
            {HEAD_COLUMNS.map((column, index) => (
              <th
                key={column.label || `spacer-${index}`}
                data-col={column.col}
                style={column.width ? { width: column.width } : undefined}
                className={column.num ? "kd-td-num" : undefined}
              >
                {column.label}
              </th>
            ))}
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
            colSpan={TOTAL_COLUMNS}
          />
        )}
        {items.map((item, index) => {
          const collapsed = collapsedItems.has(index);
          const pickable = selectableGroups(item);
          const itemSelected =
            pickable.length > 0 &&
            pickable.every((group) => selected.has(selectionKey(index, group.group_id)));

          const rows = collapsed
            ? null
            : item.groups.map((group, position) =>
                // 视频行横跨整张表，所以它不吃 indent/last 那套导引线——
                // 一条挂在两倍高的块上的肘线只会显得断掉
                isVideoGroup(group) ? (
                  <VideoResultRow
                    key={group.group_id}
                    {...videoSeedFromGroup(group)}
                    colSpan={TOTAL_COLUMNS}
                  />
                ) : (
                  <MergedGroupRow
                    key={group.group_id}
                    group={group}
                    indent={!flat}
                    last={position === item.groups.length - 1}
                    sourceIndex={sourceIndex[group.group_id] ?? group.best_source_index}
                    selected={selected.has(selectionKey(index, group.group_id))}
                    selectable={group.sources.some((source) => source.platform !== "local")}
                    selectionMode={selectionMode}
                    expanded={expandedGroups.has(group.group_id)}
                    onToggleSelect={() => onToggleSelect(selectionKey(index, group.group_id))}
                    onEnterSelection={() => onSelectionModeChange(true)}
                    onToggleExpand={() => onToggleExpand(group.group_id)}
                    onPickSource={(sourceIdx) => onPickSource(group.group_id, sourceIdx)}
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

          if (flat) return <Fragment key={item.entry}>{rows}</Fragment>;

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
                  {item.groups.length > 0 && (
                    <span className="kd-result-lead-actions">
                      <span className="kd-result-lead-spacer" aria-hidden="true" />
                      <span className="kd-result-lead-btn" aria-hidden="true">
                        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      </span>
                    </span>
                  )}
                </td>
                <td colSpan={4}>
                  <span className="kd-row" style={{ gap: "0.45rem", minWidth: 0 }}>
                    <span className="kd-chip" data-tone={item.kind === "error" ? "danger" : "theme"}>
                      {KIND_LABEL[item.kind]}
                    </span>
                    {item.kind === "playlist" || item.kind === "album" ? (
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
                        {PLATFORM_LABEL[platform as keyof typeof PLATFORM_LABEL] ?? platform} 失败
                      </span>
                    ))}
                  </span>
                </td>
                <td colSpan={4} className="kd-td-num kd-muted">
                  <span className="kd-result-package-actions">
                    {item.groups.length > 0 ? `${item.groups.length} 首` : ""}
                    {(item.kind === "playlist" || item.kind === "album") && pickable.length > 0 && (
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
                </td>
              </tr>
              {rows}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
