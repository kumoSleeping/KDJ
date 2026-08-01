import { Fragment, useRef, useState } from "react";
import { BookPlus, ChevronDown, ChevronRight, Check, Copy, Download, Play } from "lucide-react";
import { DASH, formatDuration, thumbUrl } from "../../lib/format";
import { api } from "../../lib/api";
import { requestSongPreview, type SongPreviewItem } from "../../lib/songPreview";
import { clearTextSelection, hasTextSelectionWithin } from "../../lib/textSelection";
import {
  playClickForLayout,
  useTrackClickPrefs,
} from "../../lib/trackClickPrefs";
import type { LayoutMode } from "../../lib/useLayoutMode";
import type { MergedGroup, Platform, SongSource } from "../../types";
import { copyText } from "../../lib/copyText";
import { ContextMenu } from "../common";
import { playTrack } from "../library/TrackTable";
import { PlatformMark } from "./PlatformMark";

/** 平台在表格里的短标签。混合搜索一行可能同时挂三个来源，全名太挤。 */
export const PLATFORM_LABEL: Record<Platform, string> = {
  wyy: "网易云",
  qqm: "QQ",
  soundcloud: "SC",
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
  /** 当前布局档位，决定单击/双击播放行为。 */
  layout: LayoutMode;
  /** 挂在某个"包"（歌单/一次搜索）底下时缩进并画导引线。 */
  indent?: boolean;
  /** 包里的最后一行，竖导引线到此为止。 */
  last?: boolean;
  onToggleSelect(): void;
  onEnterSelection(): void;
  onToggleExpand(): void;
  onPickSource(index: number): void;
  /** 把当前选中来源直接丢进下载队列，省掉先勾选再找顶栏。 */
  onDownload(): void;
  /** 持久化在线来源；它和下载是两个明确动作。 */
  onAddToLibrary(): void;
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
  layout,
  indent = false,
  last = false,
  onToggleSelect,
  onEnterSelection,
  onToggleExpand,
  onPickSource,
  onDownload,
  onAddToLibrary,
  followingSongs = [],
  onDragStart,
  onDragEnd,
}: MergedGroupRowProps) {
  const active = group.sources[sourceIndex] ?? group.sources[0];
  const multi = group.sources.length > 1;
  const pressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number } | null>(null);
  const { widePlay, narrowPlay } = useTrackClickPrefs();
  const playClick = playClickForLayout({ widePlay, narrowPlay }, layout);

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
  const streamable = Boolean(previewSource);
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
      if (multi && !expanded) onToggleExpand();
      return;
    }
    const local = group.sources.find((source) => source.platform === "local");
    const trackId = Number(local?.payload?.track_id);
    if (Number.isFinite(trackId) && trackId > 0) void api.track(trackId).then(playTrack);
  };

  const thumbImg = group.cover && (
    <img
      src={thumbUrl(group.cover)}
      alt=""
      loading="lazy"
      draggable={false}
      referrerPolicy="no-referrer"
      onError={(event) => {
        event.currentTarget.style.display = "none";
      }}
    />
  );

  const titleCell = (
    <>
      {/* 封面只负责识别歌曲，不再叠播放三角。试听统一走整行双击。 */}
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
        {thumbImg}
      </span>
      {group.title}
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
            {indent ? (
              <span className="kd-tree-indent kd-truncate" data-last={last ? "true" : undefined}>
                {titleCell}
              </span>
            ) : (
              titleCell
            )}
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
        aria-selected={selected}
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
          if (selectable && (selectionMode || event.metaKey || event.ctrlKey)) {
            toggleSelection();
            return;
          }
          // 与曲库表一致：设置成单击播放时直接进播放条；双击播放时单击不顶掉正在播。
          if (playClick === "single") {
            playGroup();
          }
        }}
        onDoubleClick={() => {
          if (!selectionMode && playClick === "double") playGroup();
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
        >
          {/* 下载在前、展开在后：窄屏上这两颗键常被表头 1.6rem + 左右 padding 裁掉，
              单独给一列够宽的动作格，别再吃通用 td 的 0.6rem 内边距。 */}
          <span className="kd-result-lead-actions">
            {streamable ? (
              <button
                type="button"
                className="kd-result-lead-btn"
                aria-label={`添加 ${group.title} 到曲库`}
                title="添加到流媒体曲库（不下载）"
                onClick={(event) => {
                  event.stopPropagation();
                  onAddToLibrary();
                }}
              >
                <BookPlus size={13} />
              </button>
            ) : (
              <span className="kd-result-lead-spacer" aria-hidden="true" />
            )}
            {selectable ? (
              <button
                type="button"
                className="kd-result-lead-btn"
                aria-label={`下载 ${group.title}`}
                title="加入下载队列"
                onClick={(event) => {
                  event.stopPropagation();
                  onDownload();
                }}
              >
                <Download size={13} />
              </button>
            ) : (
              <span className="kd-result-lead-spacer" aria-hidden="true" />
            )}
            {multi ? (
              <button
                type="button"
                className="kd-result-lead-btn"
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
            ) : (
              <span className="kd-result-lead-spacer" aria-hidden="true" />
            )}
          </span>
        </td>
        {columns.map((column) => dataCell(column.key))}
        <td className="kd-table-fill" aria-hidden="true" />
      </tr>

      {expanded &&
        group.sources.map((source, index) => (
          <tr
            key={`${source.platform}:${source.key}`}
            data-local={source.platform === "local" ? "true" : undefined}
            onClick={() => {
              if (source.platform === "local") return;
              // 单击只选定下载来源，不顶替正在播的
              onPickSource(index);
            }}
            onDoubleClick={() => {
              if (source.platform === "local" || source.platform === "bilibili") return;
              onPickSource(index);
              requestSongPreview({
                source,
                title: source.title || group.title,
                artist: source.artists.join(", ") || group.artists.join(", "),
                autoPlay: true,
                queue: followingSongs,
              });
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
          {streamable && (
            <button
              type="button"
              onClick={() => {
                onAddToLibrary();
                setRowMenu(null);
              }}
            >
              <BookPlus size={12} />
              添加到曲库（不下载）
            </button>
          )}
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
