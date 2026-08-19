import { Fragment, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Check, Copy, Download, Play } from "lucide-react";
import { DASH, formatDuration, thumbUrl } from "../../lib/format";
import { api } from "../../lib/api";
import { requestSongPreview, type SongPreviewItem } from "../../lib/songPreview";
import { clearTextSelection, hasTextSelectionWithin } from "../../lib/textSelection";
import type { LayoutMode } from "../../lib/useLayoutMode";
import type { MergedGroup, Platform, SongSource } from "../../types";
import { copyText } from "../../lib/copyText";
import { ContextMenu } from "../common";
import { CoverImage } from "../common/VinylPlaceholder";
import { playTrack } from "../library/TrackTable";
import { PlatformMark } from "./PlatformMark";

/** 平台在表格里的短标签。混合搜索一行可能同时挂三个来源，全名太挤。 */
export const PLATFORM_LABEL: Record<Platform, string> = {
  wyy: "网易云",
  qqm: "QQ",
  soundcloud: "SC",
  ytm: "YTM",
  bilibili: "B站",
  local: "本地",
};

/** @deprecated 请从 `lib/searchDrag` 引用；保留 re-export 以免旧 import 断掉。 */
export { SEARCH_DOWNLOAD_DND_TYPE } from "../../lib/searchDrag";

export interface MergedGroupRowProps {
  group: MergedGroup;
  /** 当前选中的来源下标（用户可在展开后改）。 */
  sourceIndex: number;
  selected: boolean;
  /** 纯本地结果只用于提示“已经有了”，不能送进在线下载队列。 */
  selectable: boolean;
  selectionMode: boolean;
  expanded: boolean;
  /** 可见数据列（顺序已按用户偏好排好；不含勾选/动作列）。 */
  columns: ReadonlyArray<{ key: string; align?: "num" }>;
  /** 当前集合（或普通结果列表）中的可见序号。 */
  rowNumber: number;
  /** 竖屏列表固定单击播放；横屏仍保留单击查看详情。 */
  layout: LayoutMode;
  /** 普通单击选中并展示在线详情；与批量下载勾选状态相互独立。 */
  inspected: boolean;
  /** 挂在某个"包"（歌单/一次搜索）底下时缩进并画导引线。 */
  indent?: boolean;
  /** 包里的最后一行，竖导引线到此为止。 */
  last?: boolean;
  onToggleSelect(): void;
  onEnterSelection(): void;
  onToggleExpand(): void;
  onPickSource(index: number): void;
  onInspect(index: number): void;
  /** 把当前选中来源直接丢进下载队列，省掉先勾选再找顶栏。 */
  onDownload(): void;
  /** 当前搜索结果里排在本行之后的可播放歌曲。 */
  followingSongs?: SongPreviewItem[];
  onDragStart?(event: React.DragEvent<HTMLElement>): void;
  onDragEnd?(): void;
}

function qualityLabel(source: SongSource): string {
  if (!source.max_quality) return DASH;
  return source.max_quality === "flac" ? "FLAC" : `${source.max_quality}K`;
}

export function MergedGroupRow({
  group,
  sourceIndex,
  selected,
  selectable,
  selectionMode,
  expanded,
  columns,
  rowNumber,
  layout,
  inspected,
  indent = false,
  last = false,
  onToggleSelect,
  onEnterSelection,
  onToggleExpand,
  onPickSource,
  onInspect,
  onDownload,
  followingSongs = [],
  onDragStart,
  onDragEnd,
}: MergedGroupRowProps) {
  const active = group.sources[sourceIndex] ?? group.sources[0];
  const multi = group.sources.length > 1;
  const pressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number } | null>(null);

  /**
   * 试听放哪个来源：优先当前选中的；选中的是 B 站就退而求其次找一家音乐
   * 平台（B 站条目是视频，试听走视频预览那条路）。一家都没有就不给按钮。
   */
  const previewSource =
    active && active.platform !== "bilibili" && active.platform !== "local"
      ? active
      : (group.sources.find(
          (source) => source.platform !== "bilibili" && source.platform !== "local",
        ) ?? null);
  const toggleSelection = () => {
    onToggleSelect();
  };

  /** 把当前组/来源送进主播放条试听。双击或设置成单击时触发。 */
  const playGroup = () => {
    if (previewSource) {
      requestSongPreview({
        source: previewSource,
        title: group.title,
        artist: group.artists.join(", "),
        autoPlay: true,
        queue: followingSongs,
      });
      // 移动端轻点是直接播放，不能又自动展开一大串来源把用户刚看的列表挤走。
      if (layout !== "narrow" && multi && !expanded) onToggleExpand();
      return;
    }
    const local = group.sources.find((source) => source.platform === "local");
    const trackId = Number(local?.payload?.track_id);
    if (Number.isFinite(trackId) && trackId > 0) void api.track(trackId).then(playTrack);
  };

  /** 展开的某个来源直接播放；移动端不能先用详情抽屉来确认来源。 */
  const playSource = (source: SongSource) => {
    if (source.platform === "local") {
      const trackId = Number(source.payload?.track_id);
      if (Number.isFinite(trackId) && trackId > 0) void api.track(trackId).then(playTrack);
      return;
    }
    if (source.platform === "bilibili") return;
    requestSongPreview({
      source,
      title: source.title || group.title,
      artist: source.artists.join(", ") || group.artists.join(", "),
      autoPlay: true,
      queue: followingSongs,
    });
  };

  const titleCell = (
    <>
      {multi && (
        <button
          type="button"
          className="kd-result-source-toggle"
          aria-label={expanded ? "收起来源" : "展开来源"}
          aria-expanded={expanded}
          title={expanded ? "收起来源" : "展开来源"}
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpand();
          }}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      )}
      {/* 封面只负责识别歌曲，不再叠播放三角；横屏双击、竖屏单击试听。 */}
      <span
        className="kd-thumb"
        draggable={selectable}
        title={selectable ? "拖到下载队列，或拖进左侧文件夹直接入队" : undefined}
        onDragStart={(event) => {
          event.stopPropagation();
          clearTextSelection();
          onDragStart?.(event);
        }}
        onDragEnd={() => onDragEnd?.()}
      >
        <CoverImage
          src={group.cover ? thumbUrl(group.cover) : ""}
          loading="lazy"
          draggable={false}
          referrerPolicy="no-referrer"
        />
      </span>
      <span className="kd-result-title-text">{group.title}</span>
      {group.in_library && (
        <span className="kd-chip" data-tone="ok" style={{ marginLeft: "0.4rem" }}>
          已入库
        </span>
      )}
    </>
  );

  // 同一平台可能挂多条候选源；图标列只按平台去重，当前选中那条所属平台高亮。
  const platformMarks: Array<{ platform: Platform; active: boolean }> = [];
  for (const [index, source] of group.sources.entries()) {
    const existing = platformMarks.find((mark) => mark.platform === source.platform);
    if (existing) {
      if (index === sourceIndex) existing.active = true;
      continue;
    }
    platformMarks.push({ platform: source.platform, active: index === sourceIndex });
  }

  const cellDrag = selectable
    ? {
        draggable: true as const,
        onDragStart,
        onDragEnd,
      }
    : { draggable: false as const };

  const dataCell = (key: string) => {
    switch (key) {
      case "title":
        return (
          <td key={key} className="kd-td-strong" data-col="title" title={group.title} {...cellDrag}>
            <span
              className={`kd-result-title${indent ? " kd-tree-indent" : ""}`}
              data-last={indent && last ? "true" : undefined}
            >
              {titleCell}
            </span>
          </td>
        );
      case "artist":
        return (
          <td key={key} data-col="artist" title={group.artists.join(", ")} {...cellDrag}>
            {group.artists.join(", ") || DASH}
          </td>
        );
      case "album":
        return (
          <td key={key} data-col="album" title={group.album} {...cellDrag}>
            {group.album || DASH}
          </td>
        );
      case "duration":
        return (
          <td key={key} className="kd-td-num" data-col="duration" {...cellDrag}>
            {formatDuration(group.duration)}
          </td>
        );
      case "sources":
        return (
          <td key={key} data-col="sources" {...cellDrag}>
            <span
              className="kd-source-dots"
              title={platformMarks.map((mark) => PLATFORM_LABEL[mark.platform]).join(" / ")}
            >
              {platformMarks.map((mark) => (
                <span
                  key={mark.platform}
                  className="kd-source-dot"
                  data-platform={mark.platform}
                  data-active={mark.active ? "true" : "false"}
                >
                  <PlatformMark id={mark.platform} size={12} />
                </span>
              ))}
            </span>
          </td>
        );
      case "from":
        return (
          <td key={key} className="kd-mono" data-col="from" {...cellDrag}>
            {active ? PLATFORM_LABEL[active.platform] : DASH}
          </td>
        );
      case "quality":
        return (
          <td key={key} className="kd-td-num kd-mono" data-col="quality" {...cellDrag}>
            {active ? qualityLabel(active) : DASH}
          </td>
        );
      case "vip":
        return (
          <td key={key} data-col="vip" style={{ width: "3rem" }} {...cellDrag}>
            {active?.vip && (
              <span className="kd-chip" data-tone="warn">
                VIP
              </span>
            )}
          </td>
        );
      default:
        return <td key={key} {...cellDrag} />;
    }
  };

  const sourceDataCell = (key: string, source: SongSource, index: number) => {
    switch (key) {
      case "title":
        return (
          <td key={key} colSpan={1} className="kd-muted" style={{ paddingLeft: "1.4rem" }}>
            <span className="kd-row" style={{ gap: "0.4rem" }}>
              {index === sourceIndex ? <Check size={12} /> : <span style={{ width: 12 }} />}
              <span className="kd-truncate">{source.title}</span>
              <span className="kd-faint">·</span>
              <span className="kd-truncate kd-faint">{source.artists.join(", ") || DASH}</span>
            </span>
          </td>
        );
      case "artist":
      case "album":
      case "sources":
        return <td key={key} />;
      case "duration":
        return (
          <td key={key} className="kd-td-num kd-muted">
            {formatDuration(source.duration)}
          </td>
        );
      case "from":
        return (
          <td key={key} className="kd-mono kd-muted">
            {PLATFORM_LABEL[source.platform]}
          </td>
        );
      case "quality":
        return (
          <td key={key} className="kd-td-num kd-mono kd-muted">
            {qualityLabel(source)}
          </td>
        );
      case "vip":
        return (
          <td key={key}>
            {source.vip && (
              <span className="kd-chip" data-tone="warn">
                VIP
              </span>
            )}
          </td>
        );
      default:
        return <td key={key} />;
    }
  };

  return (
    <Fragment>
      <tr
        aria-selected={selected || inspected}
        aria-label={
          layout === "narrow"
            ? `${group.title}，单击播放`
            : `${group.title}，单击查看详情，双击播放`
        }
        data-selecting={selectionMode ? "true" : undefined}
        // table-row 在 macOS WKWebView 里不是可靠的原生拖动源；选中后由每个 td 起拖。
        draggable={false}
        onClick={(event) => {
          if (hasTextSelectionWithin(event.currentTarget)) return;
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          // 控件自己消费点击（展开、勾选），和视频行同一条 closest 规则
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          // touch 双点会发两次 click；竖屏首下已经直接播放，第二下不能再重启。
          if (layout === "narrow" && event.detail > 1) return;
          if (selectable && (selectionMode || event.metaKey || event.ctrlKey)) {
            toggleSelection();
            return;
          }
          if (selectionMode) return;
          // 移动端详情抽屉会盖住整个列表，轻点歌曲必须直接起播；详情只由
          // 底部“正在播放”唱盘显式打开。横屏继续保留查看/播放两级手势。
          if (layout === "narrow") playGroup();
          else onInspect(sourceIndex);
        }}
        onDoubleClick={() => {
          if (!selectionMode && layout !== "narrow") playGroup();
        }}
        tabIndex={0}
        onKeyDown={(event) => {
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (layout === "narrow" && !selectionMode) {
            playGroup();
            return;
          }
          if ((event.metaKey || event.ctrlKey) && !selectionMode) {
            playGroup();
            return;
          }
          if (!selectionMode) onInspect(sourceIndex);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setRowMenu({ x: event.clientX, y: event.clientY });
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse") return;
          const x = event.clientX;
          const y = event.clientY;
          pressTimerRef.current = window.setTimeout(() => {
            setRowMenu({ x, y });
            suppressClickRef.current = true;
            pressTimerRef.current = null;
          }, 480);
        }}
        onPointerUp={() => {
          if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
          pressTimerRef.current = null;
        }}
        onPointerCancel={() => {
          if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
          pressTimerRef.current = null;
        }}
      >
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          onDragEnd={selectable ? onDragEnd : undefined}
          className="kd-selection-cell"
          data-active={selectionMode ? "true" : undefined}
        >
          {selectionMode && selectable && (
            <input
              type="checkbox"
              checked={selected}
              aria-label={`选择 ${group.title}`}
              onChange={toggleSelection}
              onClick={(event) => event.stopPropagation()}
            />
          )}
        </td>
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          onDragEnd={selectable ? onDragEnd : undefined}
          className="kd-result-lead"
          data-col="index"
        >
          <span className="kd-result-index">{rowNumber}</span>
        </td>
        {columns.map((column) => dataCell(column.key))}
        <td className="kd-table-fill" aria-hidden="true" />
      </tr>

      {expanded &&
        group.sources.map((source, index) => (
          <tr
            key={`${source.platform}:${source.key}`}
            aria-label={
              layout === "narrow"
                ? `${source.title || group.title}，单击播放此来源`
                : `${source.title || group.title}，单击查看此来源详情，双击播放`
            }
            data-local={source.platform === "local" ? "true" : undefined}
            onClick={(event) => {
              if (layout === "narrow" && event.detail > 1) return;
              if (source.platform === "local") {
                if (layout === "narrow") playSource(source);
                return;
              }
              // 移动端选源后立刻播放，不能用全屏详情抽屉拦住结果列表。
              onPickSource(index);
              if (layout === "narrow") playSource(source);
              else onInspect(index);
            }}
            onDoubleClick={() => {
              if (layout === "narrow") return;
              if (source.platform === "local") return;
              onPickSource(index);
              playSource(source);
            }}
            // 宽屏本地来源仍只是“已在库中”的提示，保持原来的不可聚焦；竖屏把它
            // 变成可直接播放的行，才需要纳入键盘 Tab 顺序。
            tabIndex={source.platform === "local" && layout !== "narrow" ? undefined : 0}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (source.platform === "local") {
                if (layout === "narrow") playSource(source);
                return;
              }
              onPickSource(index);
              if (layout === "narrow" || event.metaKey || event.ctrlKey) {
                playSource(source);
                return;
              }
              onInspect(index);
            }}
          >
            <td />
            <td />
            {columns.map((column) => sourceDataCell(column.key, source, index))}
            <td className="kd-table-fill" aria-hidden="true" />
          </tr>
        ))}
      {rowMenu && (
        <ContextMenu x={rowMenu.x} y={rowMenu.y} onClose={() => setRowMenu(null)}>
          <button
            type="button"
            onClick={() => {
              setRowMenu(null);
              playGroup();
            }}
          >
            <Play size={12} />
            播放
          </button>
          <button
            type="button"
            onClick={() => {
              void copyText(group.title);
              setRowMenu(null);
            }}
          >
            <Copy size={12} />
            复制标题
          </button>
          {selectable && (
            <button
              type="button"
              onClick={() => {
                onDownload();
                setRowMenu(null);
              }}
            >
              <Download size={12} />
              加入下载队列
            </button>
          )}
          {selectable && (
            <button
              type="button"
              onClick={() => {
                onEnterSelection();
                if (!selected) onToggleSelect();
                setRowMenu(null);
              }}
            >
              <Check size={12} />
              选择
            </button>
          )}
        </ContextMenu>
      )}
    </Fragment>
  );
}
