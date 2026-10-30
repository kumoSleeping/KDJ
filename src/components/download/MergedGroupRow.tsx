import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ChevronRight,
  Check,
  Copy,
  Disc3,
  Download,
  Link2,
  ListMinus,
  ListPlus,
  LoaderCircle,
  Play,
} from "lucide-react";
import { DASH, formatDuration, thumbUrl } from "../../lib/format";
import { api } from "../../lib/api";
import {
  requestSongPreview,
  sourceKey,
  type SongPreviewItem,
} from "../../lib/songPreview";
import { clearTextSelection, hasTextSelectionWithin } from "../../lib/textSelection";
import type { CollectionResult, MergedGroup, Platform, SongSource } from "../../types";
import { albumOfSource } from "../../lib/searchCollections";
import { copyText } from "../../lib/copyText";
import { copyShareContent, songSourcesArtwork } from "../../lib/shareClipboard";
import { firstSourceShareLink, formatShareText } from "../../lib/shareLink";
import { useSharePrefs } from "../../lib/sharePrefs";
import type { ShareSelection } from "../../lib/resultSelection";
import { ContextMenu } from "../common";
import { CoverImage } from "../common/VinylPlaceholder";
import { playTrack } from "../library/TrackTable";
import { RowIndex, RowPick } from "../common/RowPick";
import { TOSS_ITEM_ATTR, tossItemKey } from "../../lib/downloadToss";
import { PlatformMark } from "./PlatformMark";
import { resultDownloadKeyColumn } from "./resultColumns";
import { ResultDownloadKey, withDownloadKey } from "./ResultDownloadKey";
import { foldingRowProps, foldOrder, useFold } from "./searchMotion";

/** 平台在表格里的短标签。混合搜索一行可能同时挂三个来源，全名太挤。 */
export const PLATFORM_LABEL: Record<Platform, string> = {
  wyy: "网易云",
  qqm: "QQ",
  soundcloud: "SC",
  ytm: "YTM",
  youtube: "YT",
  bilibili: "B站",
  local: "本地",
};

/** @deprecated 请从 `lib/searchDrag` 引用；保留 re-export 以免旧 import 断掉。 */
export { SEARCH_DOWNLOAD_DND_TYPE } from "../../lib/searchDrag";

export interface MergedGroupRowProps {
  group: MergedGroup;
  /** The row is in a selection of several: its menu shares all of it. */
  shareSelection?: ShareSelection;
  /** 当前选中的来源下标（用户可在展开后改）。 */
  sourceIndex: number;
  selected: boolean;
  /** 纯本地结果只用于提示“已经有了”，不能送进在线下载队列。 */
  selectable: boolean;
  /** Rows are being picked: the number gives way to the selection mark and a plain click picks. */
  selectionMode: boolean;
  /** The row's key in the selection, written on the row so a Shift-click can follow the rows as shown. */
  pickKey?: string;
  expanded: boolean;
  /** 可见数据列（顺序已按用户偏好排好；不含左边距/序号列）。 */
  columns: ReadonlyArray<{ key: string; align?: "num" }>;
  /** 当前集合（或普通结果列表）中的可见序号。 */
  rowNumber: number;
  /** 普通单击选中并展示在线详情；与批量下载勾选状态相互独立。 */
  inspected: boolean;
  /** 挂在某个"包"（歌单/一次搜索）底下时缩进一档。 */
  indent?: boolean;
  /** Mounted into a list that had already settled: the row slots in on its own. Read once, at mount. */
  late?: boolean;
  /** The row's package is folding away: the row is a picture that fades out, this many steps in. */
  leave?: number;
  /** `range`: pick the run from the row touched last to this one (Shift-click). */
  onToggleSelect(range?: boolean): void;
  onEnterSelection(): void;
  onToggleExpand(): void;
  onPickSource(index: number): void;
  onInspect(index: number): void;
  /** 把当前选中来源直接丢进下载队列，省掉先勾选再找顶栏。 */
  onDownload(): void;
  onDownloadSingle(): void;
  /** 仅远端账号收藏/本人歌单提供；调用后由上层等待平台服务器确认。 */
  onRemoveFromStreamPlaylist?(): void;
  removeFromStreamPlaylistLabel?: string;
  removingFromStreamPlaylist?: boolean;
  /** The album of the shown source (NetEase, QQ Music), opened as a list or downloaded whole. */
  onOpenAlbum?(album: CollectionResult): void;
  onDownloadAlbum?(album: CollectionResult): void;
  /** 正在解析或装载的在线来源；用于在用户双击的位置给出即时反馈。 */
  previewPendingSourceKey?: string;
  previewPendingLabel?: string;
  /** 当前搜索结果里排在本行之后的可播放歌曲。 */
  followingSongs?: SongPreviewItem[];
  onDragStart?(event: React.DragEvent<HTMLElement>): void;
  onDragEnd?(): void;
  /** WKWebView pointer 主链路；返回清理函数供换页/卸载时释放全局监听。 */
  onPointerDragStart?(
    event: React.PointerEvent<HTMLElement>,
    onActivated: () => void,
  ): (() => void) | void;
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
  pickKey,
  expanded,
  columns,
  rowNumber,
  inspected,
  indent = false,
  late = false,
  leave,
  onToggleSelect,
  onEnterSelection,
  onToggleExpand,
  onPickSource,
  onInspect,
  onDownload,
  onDownloadSingle,
  shareSelection,
  onRemoveFromStreamPlaylist,
  removeFromStreamPlaylistLabel,
  removingFromStreamPlaylist = false,
  onOpenAlbum,
  onDownloadAlbum,
  previewPendingSourceKey = "",
  previewPendingLabel = "解析中",
  followingSongs = [],
  onDragStart,
  onDragEnd,
  onPointerDragStart,
}: MergedGroupRowProps) {
  const active = group.sources[sourceIndex] ?? group.sources[0];
  const album = active ? albumOfSource(active) : null;
  const shareLink =firstSourceShareLink(group.sources, sourceIndex);
  const shareContentMode = useSharePrefs((state) => state.contentMode);
  const multi = group.sources.length > 1;
  const pressTimerRef = useRef<number | null>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number } | null>(null);
  // How the row entered is decided when it mounts and never changes, so a re-render cannot replay it.
  const [bornLate] = useState(late);
  // Sources opened by the user unfold; ones already open when the row mounted are simply there.
  const [unfold, setUnfold] = useState(!expanded);
  if (!expanded && !unfold) setUnfold(true);
  // Closed sources fold back: they fade as pictures, then one empty row closes the room they held.
  const sourcesFold = useFold(expanded, group.sources.length);

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
  const previewPending = Boolean(
    previewSource && previewPendingSourceKey === sourceKey(previewSource),
  );
  useEffect(() => () => pointerDragCleanupRef.current?.(), []);

  const toggleSelection = (range = false) => {
    onToggleSelect(range);
  };
  // The download key is offered in the first data column, and not while rows are being picked.
  const keyColumn = resultDownloadKeyColumn(columns);
  const downloadKey = selectable && !selectionMode
    ? <ResultDownloadKey title={group.title} onDownload={onDownloadSingle} />
    : null;
  const keyed = (key: string, content: React.ReactNode) =>
    key === keyColumn ? withDownloadKey(content, downloadKey) : content;

  /** 把当前组/来源送进主播放条试听。双击或设置成单击时触发。 */
  const playGroup = () => {
    if (previewSource) {
      if (previewPending) return;
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

  /** 展开的某个来源直接播放；移动端不能先用详情抽屉来确认来源。 */
  const playSource = (source: SongSource) => {
    if (source.platform === "local") {
      const trackId = Number(source.payload?.track_id);
      if (Number.isFinite(trackId) && trackId > 0) void api.track(trackId).then(playTrack);
      return;
    }
    if (source.platform === "bilibili") return;
    if (previewPendingSourceKey === sourceKey(source)) return;
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
      {/* 封面只负责识别歌曲，不再叠播放三角；双击试听。 */}
      <span
        className="kd-thumb"
        draggable={selectable}
        title={selectable ? "拖到 DJ Deck 直接装盘，或拖到下载队列/文件夹" : undefined}
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
      {withDownloadKey(group.title, keyColumn === "title" ? downloadKey : null, "kd-result-title-text")}
      {/* The sources toggle trails the title, so every cover starts on the same column. */}
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
          {/* One chevron: the stylesheet turns it when the sources are open. */}
          <ChevronRight size={13} />
        </button>
      )}
      {previewPending && (
        <span className="kd-result-resolving" role="status">
          <LoaderCircle className="kd-spin" size={11} aria-hidden="true" />
          {previewPendingLabel}
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
          <div role="gridcell" key={key} className="kd-list-cell kd-td-strong" data-col="title" title={group.title} {...cellDrag} data-flex="">
            <span className={`kd-result-title${indent ? " kd-tree-indent" : ""}`}>
              {titleCell}
            </span>
          </div>
        );
      case "artist":
        return (
          <div role="gridcell" className="kd-list-cell" key={key} data-col="artist" data-clip="" title={group.artists.join(", ")} {...cellDrag}>
            {keyed(key, group.artists.join(", ") || DASH)}
          </div>
        );
      case "album":
        return (
          <div role="gridcell" className="kd-list-cell" key={key} data-col="album" data-clip="" title={group.album} {...cellDrag}>
            {keyed(key, group.album || DASH)}
          </div>
        );
      case "duration":
        return (
          <div role="gridcell" key={key} className="kd-list-cell kd-td-num" data-col="duration" {...cellDrag}>
            {keyed(key, formatDuration(group.duration))}
          </div>
        );
      case "sources":
        return (
          <div role="gridcell" className="kd-list-cell" key={key} data-col="sources" {...cellDrag} data-flex="">
            {keyed(key, (
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
            ))}
          </div>
        );
      case "from":
        return (
          <div role="gridcell" key={key} className="kd-list-cell kd-mono" data-col="from" {...cellDrag}>
            {keyed(key, active ? PLATFORM_LABEL[active.platform] : DASH)}
          </div>
        );
      case "quality":
        return (
          <div role="gridcell" key={key} className="kd-list-cell kd-td-num kd-mono" data-col="quality" {...cellDrag}>
            {keyed(key, active ? qualityLabel(active) : DASH)}
          </div>
        );
      case "vip":
        return (
          <div role="gridcell" className="kd-list-cell" key={key} data-col="vip" style={{ width: "3rem" }} {...cellDrag} data-flex="">
            {keyed(key, active?.vip ? (
              <span className="kd-chip" data-tone="warn">
                VIP
              </span>
            ) : null)}
          </div>
        );
      default:
        return <div role="gridcell" className="kd-list-cell" key={key} {...cellDrag} />;
    }
  };

  const sourceDataCell = (key: string, source: SongSource, index: number) => {
    switch (key) {
      case "title":
        return (
          <div role="gridcell"
            key={key}
            className="kd-list-cell kd-muted kd-result-source-child"
            data-parent-indented={indent ? "true" : undefined}
            data-picked={index === sourceIndex ? "true" : undefined}
           data-flex="">
            <span className="kd-result-source-line">
              {/* The pick mark sits in the cover's slot, so the source's title starts under the song's. */}
              <span className="kd-result-source-pick">
                {index === sourceIndex ? <Check size={13} /> : null}
              </span>
              <span className="kd-truncate">{source.title}</span>
              <span className="kd-faint">·</span>
              <span className="kd-truncate kd-faint">{source.artists.join(", ") || DASH}</span>
              {previewPendingSourceKey === sourceKey(source) && (
                <span className="kd-result-resolving" role="status">
                  <LoaderCircle className="kd-spin" size={11} aria-hidden="true" />
                  {previewPendingLabel}
                </span>
              )}
            </span>
          </div>
        );
      case "artist":
      case "album":
      case "sources":
        return <div role="gridcell" className="kd-list-cell" key={key} />;
      case "duration":
        return (
          <div role="gridcell" key={key} className="kd-list-cell kd-td-num kd-muted">
            {formatDuration(source.duration)}
          </div>
        );
      case "from":
        return (
          <div role="gridcell" key={key} className="kd-list-cell kd-mono kd-muted">
            {PLATFORM_LABEL[source.platform]}
          </div>
        );
      case "quality":
        return (
          <div role="gridcell" key={key} className="kd-list-cell kd-td-num kd-mono kd-muted">
            {qualityLabel(source)}
          </div>
        );
      case "vip":
        return (
          <div role="gridcell" className="kd-list-cell" key={key}>
            {source.vip && (
              <span className="kd-chip" data-tone="warn">
                VIP
              </span>
            )}
          </div>
        );
      default:
        return <div role="gridcell" className="kd-list-cell" key={key} />;
    }
  };

  return (
    <Fragment>
      <div className="kd-list-row" role="row"
        // While rows are being picked "selected" means picked; the row whose details are open
        // is told apart by data-inspected.
        aria-selected={selectionMode ? selected : selected || inspected}
        data-kd-search-result=""
        data-pick-key={selectable ? pickKey : undefined}
        data-downloadable={selectable ? "true" : undefined}
        {...{ [TOSS_ITEM_ATTR]: selectable && active ? tossItemKey(active) : undefined }}
        data-inspected={inspected ? "true" : undefined}
        data-resolving={previewPending ? "true" : undefined}
        data-enter={bornLate && leave === undefined ? "late" : undefined}
        aria-busy={previewPending ? "true" : undefined}
        aria-label={`${group.title}，单击查看详情，双击播放`}
        data-selecting={selectionMode ? "true" : undefined}
        // table-row 在 macOS WKWebView 里不是可靠的原生拖动源；选中后由每个 td 起拖。
        draggable={false}
        onClick={(event) => {
          const picking = selectionMode || event.metaKey || event.ctrlKey || event.shiftKey;
          if (!picking && hasTextSelectionWithin(event.currentTarget)) return;
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          // 控件自己消费点击（展开、选择标记），和视频行同一条 closest 规则
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          // Picking: a plain click anywhere on the row picks or drops it (⌘/Ctrl-click starts
          // the picking, Shift-click takes the run from the row touched last). Nothing opens or plays.
          if (selectable && picking) {
            toggleSelection(event.shiftKey);
            return;
          }
          if (selectionMode) return;
          onInspect(sourceIndex);
        }}
        onDoubleClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          if (!selectionMode) playGroup();
        }}
        tabIndex={0}
        onKeyDown={(event) => {
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (selectionMode) {
            if (selectable) toggleSelection(event.shiftKey);
            return;
          }
          if (event.metaKey || event.ctrlKey) {
            playGroup();
            return;
          }
          onInspect(sourceIndex);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setRowMenu({ x: event.clientX, y: event.clientY });
        }}
        onMouseDown={(event) => {
          // A click that picks must not select text on its way (Shift would stretch a selection).
          if (
            selectable
            && (selectionMode || event.metaKey || event.ctrlKey || event.shiftKey)
            && !(event.target as HTMLElement).closest("button, select, label, input, a")
          ) {
            event.preventDefault();
            clearTextSelection();
          }
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse") {
            if (!selectable || selectionMode || event.metaKey || event.ctrlKey || event.shiftKey) return;
            pointerDragCleanupRef.current?.();
            pointerDragCleanupRef.current = onPointerDragStart?.(event, () => {
              suppressClickRef.current = true;
            }) ?? null;
            return;
          }
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
        {...foldingRowProps(leave)}
      >
        <div role="gridcell"
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          onDragEnd={selectable ? onDragEnd : undefined}
          className="kd-list-cell kd-result-gutter"
        />
        <div role="gridcell"
          draggable={selectable}
          onDragStart={selectable ? onDragStart : undefined}
          onDragEnd={selectable ? onDragEnd : undefined}
          className="kd-list-cell kd-result-lead"
          data-col="index"
         data-flex="">
          <RowIndex
            number={rowNumber}
            picking={selectionMode}
            pick={selectable ? (
              // The row itself takes the keyboard (Enter / Space pick it), so its mark is not a tab stop.
              <RowPick
                state={selected ? "all" : "none"}
                label={`选择 ${group.title}`}
                tabbable={false}
                onToggle={(event) => toggleSelection(event.shiftKey)}
              />
            ) : null}
          />
        </div>
        {columns.map((column) => dataCell(column.key))}
      </div>

      {(sourcesFold === "open" || sourcesFold === "out") &&
        group.sources.map((source, index) => {
          // Leaving with the package, or folding back under this row: the last source goes first.
          const sourceLeave =
            leave ?? (sourcesFold === "out" ? foldOrder(index, group.sources.length) : undefined);
          return (
          <div className="kd-list-row" role="row"
            key={`${source.platform}:${source.key}`}
            data-resolving={previewPendingSourceKey === sourceKey(source) ? "true" : undefined}
            aria-busy={previewPendingSourceKey === sourceKey(source) ? "true" : undefined}
            aria-label={`${source.title || group.title}，单击查看此来源详情，双击播放`}
            data-local={source.platform === "local" ? "true" : undefined}
            data-source-child="true"
            data-unfold={unfold && sourceLeave === undefined ? "true" : undefined}
            style={unfold ? ({ "--kd-unfold-i": Math.min(index, 8) } as CSSProperties) : undefined}
            onClick={() => {
              if (source.platform === "local") return;
              onPickSource(index);
              // While rows are being picked a source is only chosen: nothing opens or plays.
              if (selectionMode) return;
              onInspect(index);
            }}
            onDoubleClick={() => {
              if (selectionMode) return;
              if (source.platform === "local") return;
              onPickSource(index);
              playSource(source);
            }}
            // 本地来源只是“已在库中”的提示，不可聚焦。
            tabIndex={source.platform === "local" ? undefined : 0}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (source.platform === "local") return;
              onPickSource(index);
              if (selectionMode) return;
              if (event.metaKey || event.ctrlKey) {
                playSource(source);
                return;
              }
              onInspect(index);
            }}
            {...foldingRowProps(sourceLeave)}
          >
            <div role="gridcell" className="kd-list-cell" />
            <div role="gridcell" className="kd-list-cell" />
            {columns.map((column) => sourceDataCell(column.key, source, index))}
              </div>
          );
        })}
      {sourcesFold === "shut" && (
        <div className="kd-list-row" role="row" data-fold="shut" aria-hidden="true"
          style={{ "--kd-fold-h": `calc(var(--kd-row-h) * ${group.sources.length})` } as CSSProperties} />
      )}
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
          {album && onOpenAlbum && (
            <button
              type="button"
              onClick={() => {
                setRowMenu(null);
                onOpenAlbum(album);
              }}
            >
              <Disc3 size={12} />
              打开此专辑
            </button>
          )}
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
          {shareSelection ? shareSelection.count > 0 && (
            <button
              type="button"
              onClick={() => {
                shareSelection.copy();
                setRowMenu(null);
              }}
            >
              <Link2 size={12} />
              复制分享内容（{shareSelection.count} 首）
            </button>
          ) : shareLink && (
            <button
              type="button"
              onClick={() => {
                void copyShareContent(
                  formatShareText(
                    shareLink,
                    { title: group.title, artists: group.artists, album: group.album },
                    shareContentMode,
                  ),
                  shareContentMode,
                  songSourcesArtwork(group.sources, sourceIndex),
                );
                setRowMenu(null);
              }}
            >
              <Link2 size={12} />
              复制分享内容
            </button>
          )}
          {onRemoveFromStreamPlaylist && removeFromStreamPlaylistLabel && (
            <button
              type="button"
              disabled={removingFromStreamPlaylist}
              onClick={() => {
                if (removingFromStreamPlaylist) return;
                setRowMenu(null);
                onRemoveFromStreamPlaylist();
              }}
            >
              <ListMinus size={12} />
              {removingFromStreamPlaylist ? "正在移除…" : removeFromStreamPlaylistLabel}
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
          {album && onDownloadAlbum && (
            <button
              type="button"
              onClick={() => {
                setRowMenu(null);
                onDownloadAlbum(album);
              }}
            >
              <ListPlus size={12} />
              将此专辑添加到下载
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
