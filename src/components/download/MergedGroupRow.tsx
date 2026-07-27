import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Check, Play } from "lucide-react";
import { DASH, formatDuration, thumbUrl } from "../../lib/format";
import { api } from "../../lib/api";
import { requestSongPreview } from "../../lib/songPreview";
import { hasTextSelectionWithin } from "../../lib/textSelection";
import type { MergedGroup, Platform, SongSource } from "../../types";
import { playTrack } from "../library/TrackTable";

/** 平台在表格里的短标签。混合搜索一行可能同时挂三个来源，全名太挤。 */
export const PLATFORM_LABEL: Record<Platform, string> = {
  wyy: "网易云",
  qqm: "QQ",
  soundcloud: "SC",
  bilibili: "B站",
  local: "本地",
};

/** 搜索结果 → 右侧下载队列的原生拖拽载荷。 */
export const SEARCH_DOWNLOAD_DND_TYPE = "application/x-kdj-download-sources";

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
}: MergedGroupRowProps) {
  const active = group.sources[sourceIndex] ?? group.sources[0];
  const multi = group.sources.length > 1;
  const pressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number } | null>(null);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);

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
  const revealPreview = () => {
    if (previewSource) requestSongPreview({ source: previewSource, title: group.title, artist: group.artists.join(", ") });
    if (multi && !expanded) onToggleExpand();
  };

  const toggleSelection = () => {
    onToggleSelect();
  };

  const playGroup = () => {
    if (previewSource) {
      revealPreview();
      return;
    }
    const local = group.sources.find((source) => source.platform === "local");
    const trackId = Number(local?.payload?.track_id);
    if (Number.isFinite(trackId) && trackId > 0) void api.track(trackId).then(playTrack);
  };

  useEffect(() => {
    if (!rowMenu) return;
    const close = (event: MouseEvent) => {
      if (!rowMenuRef.current?.contains(event.target as Node)) setRowMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRowMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [rowMenu]);

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
        title={selectable ? "拖动封面把所选歌曲加入下载队列" : undefined}
        onDragStart={(event) => {
          event.stopPropagation();
          onDragStart?.(event);
        }}
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
          if (selectable && (selectionMode || event.metaKey || event.ctrlKey)) toggleSelection();
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
          title={group.artists.join(", ")}
        >
          {group.artists.join(", ") || DASH}
        </td>
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          className="kd-muted"
          title={group.album}
        >
          {group.album || DASH}
        </td>
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          className="kd-td-num"
        >
          {formatDuration(group.duration)}
        </td>
        <td draggable={selectable} onDragStart={selectable ? onDragStart : undefined}>
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
          className="kd-mono"
        >
          {active ? PLATFORM_LABEL[active.platform] : DASH}
        </td>
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          className="kd-td-num kd-mono"
        >
          {active ? qualityLabel(active) : DASH}
        </td>
        <td
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
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
              if (source.platform !== "local") onPickSource(index);
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
      {rowMenu &&
        createPortal(
          <div
            ref={rowMenuRef}
            className="kd-context-menu"
            style={{ left: rowMenu.x, top: rowMenu.y }}
            role="menu"
          >
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
          </div>,
          document.body,
        )}
    </Fragment>
  );
}
