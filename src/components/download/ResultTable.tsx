import { Fragment } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Disc3,
  LoaderCircle,
  ListMusic,
  SearchX,
} from "lucide-react";
import type { IntakeItem, IntakeKind } from "../../types";
import { EmptyState } from "../common";
import { MergedGroupRow, PLATFORM_LABEL } from "./MergedGroupRow";

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

export interface ResultTableProps {
  items: IntakeItem[];
  loading: boolean;
  /** 已处理过一次（用来区分"还没搜"和"搜了没结果"）。 */
  searched: boolean;
  selected: Set<string>;
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
}

/** 表头列（首列的全选框由组件自己渲染，所以不在这里）。 */
const HEAD_COLUMNS: ReadonlyArray<{ label: string; width?: string; num?: boolean }> = [
  { label: "", width: "1.6rem" },
  { label: "标题" },
  { label: "艺人", width: "18%" },
  { label: "专辑", width: "16%" },
  { label: "时长", width: "4.5rem", num: true },
  { label: "来源", width: "3.5rem" },
  { label: "下载自", width: "4.5rem" },
  { label: "音质", width: "4rem", num: true },
  { label: "", width: "3rem" },
];

export function ResultTable({
  items,
  loading,
  searched,
  selected,
  expandedGroups,
  collapsedItems,
  sourceIndex,
  onToggleSelect,
  onToggleExpand,
  onPickSource,
  onToggleItem,
  onToggleItemAll,
  onToggleAll,
}: ResultTableProps) {
  const totalGroups = items.reduce((sum, item) => sum + item.groups.length, 0);

  if (loading && totalGroups === 0) {
    return (
      <EmptyState
        icon={<LoaderCircle className="kd-spin" size={22} />}
        title="正在处理"
        hint="并发打各个平台；批量时每条独立跑，先出结果的先显示。"
      />
    );
  }

  if (items.length === 0) {
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
  const allSelected =
    totalGroups > 0 &&
    items.every((item, index) =>
      item.groups.every((group) => selected.has(selectionKey(index, group.group_id))),
    );

  return (
    <table className="kd-table">
      <thead>
        <tr>
          <th style={{ width: "2rem" }}>
            <input type="checkbox" checked={allSelected} aria-label="全选" onChange={onToggleAll} />
          </th>
          {HEAD_COLUMNS.map((column, index) => (
            <th
              key={column.label || `spacer-${index}`}
              style={column.width ? { width: column.width } : undefined}
              className={column.num ? "kd-td-num" : undefined}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => {
          const collapsed = collapsedItems.has(index);
          const itemSelected =
            item.groups.length > 0 &&
            item.groups.every((group) => selected.has(selectionKey(index, group.group_id)));

          const rows = collapsed
            ? null
            : item.groups.map((group, position) => (
                <MergedGroupRow
                  key={group.group_id}
                  group={group}
                  indent={!flat}
                  last={position === item.groups.length - 1}
                  sourceIndex={sourceIndex[group.group_id] ?? group.best_source_index}
                  selected={selected.has(selectionKey(index, group.group_id))}
                  expanded={expandedGroups.has(group.group_id)}
                  onToggleSelect={() => onToggleSelect(selectionKey(index, group.group_id))}
                  onToggleExpand={() => onToggleExpand(group.group_id)}
                  onPickSource={(sourceIdx) => onPickSource(group.group_id, sourceIdx)}
                />
              ));

          if (flat) return <Fragment key={item.entry}>{rows}</Fragment>;

          return (
            <Fragment key={`${index}:${item.entry}`}>
              <tr data-tree="parent" onClick={() => onToggleItem(index)}>
                <td>
                  <input
                    type="checkbox"
                    checked={itemSelected}
                    disabled={item.groups.length === 0}
                    aria-label={`选择「${item.title || item.entry}」全部曲目`}
                    onChange={() => onToggleItemAll(index)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </td>
                <td>
                  {item.groups.length > 0 &&
                    (collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />)}
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
                  {item.groups.length > 0 ? `${item.groups.length} 首` : ""}
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
