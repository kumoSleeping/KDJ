import { Fragment, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Check, Copy, Play } from "lucide-react";
import { DASH, formatDuration, thumbUrl } from "../../lib/format";
import { api } from "../../lib/api";
import { requestSongPreview } from "../../lib/songPreview";
import { clearTextSelection, hasTextSelectionWithin } from "../../lib/textSelection";
import type { MergedGroup, Platform, SongSource } from "../../types";
import { copyText } from "../../lib/copyText";
import { ContextMenu } from "../common";
import { playTrack } from "../library/TrackTable";

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
  /** 挂在某个"包"（歌单/一次搜索）底下时缩进并画导引线。 */
  indent?: boolean;
  /** 包里的最后一行，竖导引线到此为止。 */
  last?: boolean;
  onToggleSelect(): void;
  onEnterSelection(): void;
  onToggleExpand(): void;
  onPickSource(index: number): void;
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
  indent = false,
  last = false,
  onToggleSelect,
  onEnterSelection,
  onToggleExpand,
  onPickSource,
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

  /** 双击 / 右键「播放」才会顶替主播放条；单击绝不碰正在播的。 */
  const playGroup = () => {
    if (previewSource) {
      requestSongPreview({
        source: previewSource,
        title: group.title,
        artist: group.artists.join(", "),
        autoPlay: true,
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
          // 单击不装播放条、不开播——正在播的别被随手点一下顶掉。
          // 多来源组仍可展开看各平台；要听用双击或右键「播放」。
          if (multi && !expanded) onToggleExpand();
        }}
        onDoubleClick={() => {
          if (!selectionMode) playGroup();
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
          style={{ width: "1.6rem" }}
        >
          {multi && (
            <button
              type="button"
              className="kd-btn kd-btn-icon"
              data-variant="ghost"
              data-size="sm"
              aria-label={expanded ? "收起来源" : "展开来源"}
              aria-expanded={expanded}
              onClick={(event) => {
                event.stopPropagation();
                onToggleExpand();
              }}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          )}
        </td>
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          onDragEnd={selectable ? onDragEnd : undefined}
          className="kd-td-strong"
          title={group.title}
        >
          {indent ? (
            <span className="kd-tree-indent kd-truncate" data-last={last ? "true" : undefined}>
              {titleCell}
            </span>
          ) : (
            titleCell
          )}
        </td>
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          onDragEnd={selectable ? onDragEnd : undefined}
          title={group.artists.join(", ")}
        >
          {group.artists.join(", ") || DASH}
        </td>
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          onDragEnd={selectable ? onDragEnd : undefined}
          className="kd-muted"
          title={group.album}
        >
          {group.album || DASH}
        </td>
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          onDragEnd={selectable ? onDragEnd : undefined}
          className="kd-td-num"
        >
          {formatDuration(group.duration)}
        </td>
        <td draggable={selectable} onDragStart={selectable ? onDragStart : undefined}
          onDragEnd={selectable ? onDragEnd : undefined}>
          <span className="kd-source-dots" title={group.sources.map((s) => PLATFORM_LABEL[s.platform]).join(" / ")}>
            {group.sources.map((source, index) => (
              <i
                key={`${source.platform}:${source.key}`}
                className="kd-source-dot"
                data-platform={source.platform}
                data-active={index === sourceIndex ? "true" : "false"}
              />
            ))}
          </span>
        </td>
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          onDragEnd={selectable ? onDragEnd : undefined}
          className="kd-mono"
        >
          {active ? PLATFORM_LABEL[active.platform] : DASH}
        </td>
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          onDragEnd={selectable ? onDragEnd : undefined}
          className="kd-td-num kd-mono"
        >
          {active ? qualityLabel(active) : DASH}
        </td>
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          onDragEnd={selectable ? onDragEnd : undefined}
          style={{ width: "3rem" }}
        >
          {active?.vip && (
            <span className="kd-chip" data-tone="warn">
              VIP
            </span>
          )}
        </td>
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
              });
            }}
          >
            <td />
            <td />
            <td colSpan={3} className="kd-muted" style={{ paddingLeft: "1.4rem" }}>
              <span className="kd-row" style={{ gap: "0.4rem" }}>
                {index === sourceIndex ? <Check size={12} /> : <span style={{ width: 12 }} />}
                <span className="kd-truncate">{source.title}</span>
                <span className="kd-faint">·</span>
                <span className="kd-truncate kd-faint">{source.artists.join(", ") || DASH}</span>
              </span>
            </td>
            <td className="kd-td-num kd-muted">{formatDuration(source.duration)}</td>
            <td />
            <td className="kd-mono kd-muted">{PLATFORM_LABEL[source.platform]}</td>
            <td className="kd-td-num kd-mono kd-muted">{qualityLabel(source)}</td>
            <td>
              {source.vip && (
                <span className="kd-chip" data-tone="warn">
                  VIP
                </span>
              )}
            </td>
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
