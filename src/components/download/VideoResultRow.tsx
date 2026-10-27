import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  Link2,
  ListMinus,
} from "lucide-react";
import { mediaProductionAvailable } from "../../lib/platformFeatures";
import { api, ApiError } from "../../lib/api";
import { copyText } from "../../lib/copyText";
import { copyShareContent, remoteArtwork } from "../../lib/shareClipboard";
import { formatShareText, platformShareLink } from "../../lib/shareLink";
import { useSharePrefs } from "../../lib/sharePrefs";
import type { ShareSelection } from "../../lib/resultSelection";
import { DASH, formatDuration, thumbUrl } from "../../lib/format";
import { rememberVideoEnqueue } from "../../lib/queueTaskDraft";
import { beginVideoPointerDrag } from "../../lib/searchDrag";
import { TOSS_ITEM_ATTR, tossToDownloads } from "../../lib/downloadToss";
import { clearTextSelection } from "../../lib/textSelection";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import type { MergedGroup, VideoDownloadRequest, VideoInfo, VideoPage } from "../../types";
import { ContextMenu, InlineNotice } from "../common";
import { RowIndex, RowPick } from "../common/RowPick";
import { PlatformMark } from "./PlatformMark";
import { resultDownloadKeyColumn } from "./resultColumns";
import { ResultDownloadKey, withDownloadKey } from "./ResultDownloadKey";
import { foldingRowProps, foldOrder, useFold } from "./searchMotion";
import { requestVideoPreview } from "./VideoPreview";
import { useTrackClickPrefs, playClickForLayout } from "../../lib/trackClickPrefs";
import type { LayoutMode } from "../../lib/useLayoutMode";
import { CoverImage } from "../common/VinylPlaceholder";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @deprecated 请从 `lib/searchDrag` 引用；保留 re-export 以免旧 import 断掉。 */
export { VIDEO_DOWNLOAD_DND_TYPE } from "../../lib/searchDrag";

/**
 * 画出一行视频要的最少信息。
 *
 * 关键词搜出来的 B 站条目只有这些（`SongSource` 那条路不带分 P 和可用画质），
 * 贴链接解析出来的 `VideoInfo` 是它的超集，所以两条路共用同一个种子结构。
 */
export interface VideoSeed {
  platform: "bilibili" | "youtube";
  bvid: string;
  /** 已知的分 P 数；后端无法确定时保持 null，不能据此虚构展开入口。 */
  pageCount: number | null;
  title: string;
  author: string;
  cover: string;
  duration: number | null;
}

/**
 * 整组来源都是同一种视频平台才按视频行展示。
 *
 * 混进了音乐平台的那种本质上是一首歌，视频只是它可选的下载来源之一；
 * 按视频铺开反而会把"同一首歌有几家可选、默认走哪家"这件事藏起来。
 */
export function isVideoGroup(group: MergedGroup): boolean {
  const platform = group.sources[0]?.platform;
  return (
    (platform === "bilibili" || platform === "youtube") &&
    group.sources.every((source) => source.platform === platform)
  );
}

export function videoSeedFromGroup(group: MergedGroup): VideoSeed {
  const source = group.sources[0];
  const rawPageCount = source?.payload?.page_count;
  const parsedPageCount =
    typeof rawPageCount === "number" ? rawPageCount : Number(rawPageCount);
  return {
    platform: source?.platform === "youtube" ? "youtube" : "bilibili",
    bvid: String(source?.payload?.bvid ?? source?.payload?.video_id ?? source?.key ?? ""),
    pageCount:
      Number.isInteger(parsedPageCount) && parsedPageCount > 0 ? parsedPageCount : null,
    title: group.title,
    author: group.artists.join(", "),
    cover: group.cover,
    duration: group.duration,
  };
}

export function videoSeedFromInfo(info: VideoInfo): VideoSeed {
  return {
    platform: info.platform,
    bvid: info.bvid,
    pageCount: info.platform === "bilibili" ? info.pages.length : null,
    title: info.title,
    author: info.author,
    cover: info.cover,
    duration: info.duration,
  };
}

/** 解析结果按平台 + 视频 ID 缓存。 */
const resolvedCache = new Map<string, VideoInfo>();
/** 同一个视频即使在多个结果组出现，也只允许有一条正在进行的解析请求。 */
const resolvedRequests = new Map<string, Promise<VideoInfo>>();
/** 已知失效稿件和短时平台错误也要记住，不能因为行重新挂载就再次请求。 */
const resolvedFailures = new Map<string, { message: string; expiresAt: number }>();

function resolveFailureTtl(error: unknown): number {
  const message = errorText(error);
  if (/62002|稿件不可见|已失效视频/i.test(message)) return 6 * 60 * 60 * 1_000;
  if (/风控|HTTP 429|code=-?(?:352|412|509)/i.test(message)) return 30 * 1_000;
  if (error instanceof ApiError && error.status === 400) return 30 * 60 * 1_000;
  return 30 * 1_000;
}

function rememberResolveFailure(cacheKey: string, error: unknown): void {
  const now = Date.now();
  for (const [key, failure] of resolvedFailures) {
    if (failure.expiresAt <= now) resolvedFailures.delete(key);
  }
  while (resolvedFailures.size >= 256) {
    const oldest = resolvedFailures.keys().next().value;
    if (!oldest) break;
    resolvedFailures.delete(oldest);
  }
  resolvedFailures.set(cacheKey, {
    message: errorText(error),
    expiresAt: now + resolveFailureTtl(error),
  });
}

function resolveVideoOnce(cacheKey: string, bvid: string, platform: VideoSeed["platform"]): Promise<VideoInfo> {
  const cached = resolvedCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);
  const failed = resolvedFailures.get(cacheKey);
  if (failed && failed.expiresAt > Date.now()) return Promise.reject(new Error(failed.message));
  if (failed) resolvedFailures.delete(cacheKey);
  const pending = resolvedRequests.get(cacheKey);
  if (pending) return pending;

  const request = api
    .videoResolve(bvid, platform)
    .then((result) => {
      // 结果页可能长时间开着，给缓存一个明确上限，避免搜索越多占用越多内存。
      if (resolvedCache.size >= 256) {
        const oldest = resolvedCache.keys().next().value;
        if (oldest) resolvedCache.delete(oldest);
      }
      resolvedCache.set(cacheKey, result);
      resolvedFailures.delete(cacheKey);
      return result;
    })
    .catch((error) => {
      rememberResolveFailure(cacheKey, error);
      throw error;
    })
    .finally(() => resolvedRequests.delete(cacheKey));
  resolvedRequests.set(cacheKey, request);
  return request;
}

export interface VideoResultRowProps extends VideoSeed {
  /** 已解析的完整信息；不给时，仅对元数据已确认的多 P 在用户展开后补查。 */
  info?: VideoInfo | null;
  /** 可见数据列（与 ResultTable / MergedGroupRow 同一套偏好）。 */
  columns: ReadonlyArray<{ key: string; align?: "num" }>;
  /** 当前布局档位，决定单击/双击预览行为。 */
  layout: LayoutMode;
  /** 当前结果列表中的序号。 */
  rowNumber: number;
  /** 挂在批量结果父包下时，视频行也必须占用一层树形缩进。 */
  indent?: boolean;
  /** Mounted into a list that had already settled: the row slots in on its own. Read once, at mount. */
  late?: boolean;
  /** The row's package is folding away: the row is a picture that fades out, this many steps in. */
  leave?: number;
  /** 收藏夹/搜索返回的视频可进入与歌曲相同的全选和批量下载流程。 */
  selectable?: boolean;
  selected?: boolean;
  /** Rows are being picked: the number gives way to the selection mark and a plain click picks. */
  selectionMode?: boolean;
  /** The row's key in the selection, written on the row so a Shift-click can follow the rows as shown. */
  pickKey?: string;
  /** What a batch download knows this row by (downloadToss.ts): its cover joins the gathering. */
  tossItem?: string;
  /** 搜索结果里的分 P 与歌曲多来源共用同一套展开状态。 */
  expanded?: boolean;
  onToggleExpand?(): void;
  /** `range`: pick the run from the row touched last to this one (Shift-click). */
  onToggleSelect?(range?: boolean): void;
  onEnterSelection?(): void;
  /** 当前行位于现有选区内时，右键下载应交给整组选区入口。 */
  onDownloadSelected?(): void;
  /** The row is in a selection of several: its menu shares all of it. */
  shareSelection?: ShareSelection;
  onRemoveFromStreamPlaylist?(): void;
  removeFromStreamPlaylistLabel?: string;
  removingFromStreamPlaylist?: boolean;
}

/**
 * 搜索结果里的一条视频——外观对齐音频的 MergedGroupRow：
 * 封面 + 标题 / 艺人 / 时长 / 来源图标 / 下载自 / 音质，行首显示序号。
 * B 站多 P 在总视频下展开；画质、Offset 等细项仍在「下载队列」里逐条配置。
 */
export function VideoResultRow({
  platform,
  bvid,
  pageCount,
  title,
  author,
  cover,
  duration,
  info: given,
  columns,
  layout,
  rowNumber,
  indent = false,
  late = false,
  leave,
  selectable = false,
  selected = false,
  selectionMode = false,
  pickKey,
  tossItem,
  expanded,
  onToggleExpand,
  onToggleSelect,
  onEnterSelection,
  onDownloadSelected,
  shareSelection,
  onRemoveFromStreamPlaylist,
  removeFromStreamPlaylistLabel,
  removingFromStreamPlaylist = false,
}: VideoResultRowProps) {
  const settings = useAppStore((state) => state.settings);
  const openQueuePanel = useAppStore((state) => state.openQueuePanel);
  const mergeTasks = useDownloadStore((state) => state.mergeTasks);
  const { widePlay, narrowPlay } = useTrackClickPrefs();
  const shareContentMode = useSharePrefs((state) => state.contentMode);
  const playClick = playClickForLayout({ widePlay, narrowPlay }, layout);

  const cacheKey = `${platform}:${bvid}`;
  const [info, setInfo] = useState<VideoInfo | null>(given ?? resolvedCache.get(cacheKey) ?? null);
  const displayCover = cover.trim() || info?.cover?.trim() || "";
  const [localPartsExpanded, setLocalPartsExpanded] = useState(false);
  const partsExpanded = expanded ?? localPartsExpanded;
  // How the row entered is decided when it mounts and never changes, so a re-render cannot replay it.
  const [bornLate] = useState(late);
  // Parts opened by the user unfold; ones already open when the row mounted are simply there.
  const [unfold, setUnfold] = useState(!partsExpanded);
  if (!partsExpanded && !unfold) setUnfold(true);
  const [resolvingParts, setResolvingParts] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    pageIndex: number;
    part: boolean;
  } | null>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => () => pointerDragCleanupRef.current?.(), []);

  const effectiveHeight = settings?.video_max_height ?? 1080;
  const qualityLabel = `${effectiveHeight}P`;
  // VideoInfo.pages 对 B 站表示真正可独立下载的分 P。YouTube 当前返回的单元素
  // pages 只是统一视频协议的占位，播放列表另走 collection，不能混成这里的分 P。
  const pages = platform === "bilibili" ? (info?.pages ?? []) : [];
  const knownPageCount =
    platform === "bilibili" ? (info ? pages.length : (pageCount ?? 0)) : 0;
  const hasMultiplePages = knownPageCount > 1;
  const canExpandParts = platform === "bilibili" && hasMultiplePages;
  // Closed parts fold back: they fade as pictures, then one empty row closes the room they held.
  const partsFold = useFold(hasMultiplePages && partsExpanded, pages.length);

  const toggleParts = useCallback(() => {
    if (resolvingParts) return;
    if (info) {
      if (!hasMultiplePages) return;
      if (onToggleExpand) onToggleExpand();
      else setLocalPartsExpanded((value) => !value);
      return;
    }
    if (platform !== "bilibili" || !bvid) return;
    setResolvingParts(true);
    setSendError("");
    void resolveVideoOnce(cacheKey, bvid, platform)
      .then((result) => {
        setInfo(result);
        if (result.pages.length <= 1) return;
        if (onToggleExpand) onToggleExpand();
        else setLocalPartsExpanded(true);
      })
      .catch((error) => setSendError(`分 P 解析失败：${errorText(error)}`))
      .finally(() => setResolvingParts(false));
  }, [bvid, cacheKey, hasMultiplePages, info, onToggleExpand, platform, resolvingParts]);

  const buildRequest = useCallback((pageIndex = 0): VideoDownloadRequest => {
    const page = pages[pageIndex];
    return {
      platform,
      bvid,
      page_index: pageIndex,
      page_count: knownPageCount,
      page_title: page?.title?.trim() || undefined,
      max_height: effectiveHeight,
      audio_only: false,
      video_only: false,
      // YouTube has one fixed, decode-free H.264/AAC → MP4 path. The global compatibility
      // re-encode setting remains available to Bilibili downloads only.
      transcode: mediaProductionAvailable() && platform !== "youtube" && (settings?.video_transcode ?? false),
      title: title.trim() || undefined,
      artist: author.trim() || undefined,
      cover: displayCover || undefined,
    };
  }, [
    platform,
    bvid,
    pages,
    knownPageCount,
    effectiveHeight,
    settings?.video_transcode,
    title,
    author,
    displayCover,
  ]);

  const download = useCallback(async (pageIndex = 0) => {
    setSending(true);
    setSendError("");
    // The parcel leaves from the row or menu item that was clicked; the request goes out when it
    // has nearly landed.
    const toss = tossToDownloads({ title: title.trim() });
    try {
      const request = buildRequest(pageIndex);
      await toss.ready;
      const task = await api.videoDownload(request);
      rememberVideoEnqueue(task.id, request);
      mergeTasks([
        {
          ...task,
          title: title.trim() || task.title,
          artist: author.trim() || task.artist,
          cover: displayCover || task.cover || undefined,
        },
      ]);
      openQueuePanel();
    } catch (error) {
      toss.fail();
      setSendError(`下载失败：${errorText(error)}`);
    } finally {
      setSending(false);
    }
  }, [buildRequest, title, author, displayCover, mergeTasks, openQueuePanel]);

  const bindPointerDrag = (event: React.PointerEvent, pageIndex = 0) => {
    if (!bvid) return;
    pointerDragCleanupRef.current?.();
    const request = buildRequest(pageIndex);
    const page = pages[pageIndex];
    const displayTitle =
      pages.length > 1
        ? `P${pageIndex + 1} · ${page?.title?.trim() || title}`
        : title;
    pointerDragCleanupRef.current = beginVideoPointerDrag(
      event.nativeEvent,
      request,
      { title: displayTitle, artist: author, cover: displayCover },
      (error) => setSendError(`拖入失败：${errorText(error)}`),
      () => {
        suppressClickRef.current = true;
      },
    );
  };

  const previewPage = (pageIndex: number) => {
    const page = pages[pageIndex];
    requestVideoPreview({
      platform,
      bvid,
      title: page && pages.length > 1 ? `${title} · P${pageIndex + 1} · ${page.title}` : title,
      author,
      page: pageIndex,
      cover: displayCover,
    });
  };

  const cellDrag = {
    draggable: true as const,
    onDragStart: (event: React.DragEvent) => {
      // HTML5 drag 留给外层；WKWebView 里真正靠 pointer drag。
      event.preventDefault();
    },
  };
  // The download key is offered in the first data column, and not while rows are being picked.
  const keyColumn = resultDownloadKeyColumn(columns);
  const downloadKey = bvid && !selectionMode
    ? <ResultDownloadKey title={title} onDownload={() => { void download(0); }} disabled={sending} />
    : null;
  const keyed = (key: string, content: React.ReactNode) =>
    key === keyColumn ? withDownloadKey(content, downloadKey) : content;

  const partCell = (columnKey: string, page: VideoPage, pageIndex: number) => {
    switch (columnKey) {
      case "title":
        return (
          <div role="gridcell"
            key={columnKey}
            className="kd-list-cell kd-muted"
            data-col="title"
            title={`P${pageIndex + 1} · ${page.title}`}
            {...cellDrag}
           data-flex="">
            <span className="kd-result-title kd-video-part-title">
              <span className="kd-thumb" aria-hidden="true">
                <CoverImage
                  src={displayCover ? thumbUrl(displayCover) : ""}
                  loading="lazy"
                  draggable={false}
                  referrerPolicy="no-referrer"
                />
              </span>
              <span className="kd-video-part-index kd-mono">P{pageIndex + 1}</span>
              <span className="kd-result-title-text">{page.title || `P${pageIndex + 1}`}</span>
            </span>
          </div>
        );
      case "artist":
      case "album":
      case "sources":
        return <div role="gridcell" className="kd-list-cell" key={columnKey} {...cellDrag} />;
      case "duration":
        return (
          <div role="gridcell" key={columnKey} className="kd-list-cell kd-td-num kd-muted" data-col="duration" {...cellDrag}>
            {formatDuration(page.duration)}
          </div>
        );
      case "from":
        return (
          <div role="gridcell" key={columnKey} className="kd-list-cell kd-mono kd-muted" data-col="from" {...cellDrag}>
            B站
          </div>
        );
      case "quality":
        return (
          <div role="gridcell" key={columnKey} className="kd-list-cell kd-td-num kd-mono kd-muted" data-col="quality" {...cellDrag}>
            {qualityLabel}
          </div>
        );
      case "vip":
        return <div role="gridcell" className="kd-list-cell" key={columnKey} {...cellDrag} />;
      default:
        return <div role="gridcell" className="kd-list-cell" key={columnKey} {...cellDrag} />;
    }
  };

  return (
    <Fragment>
      <div className="kd-list-row" role="row"
        data-video="true"
        data-enter={bornLate && leave === undefined ? "late" : undefined}
        data-selecting={selectionMode ? "true" : undefined}
        data-pick-key={selectable ? pickKey : undefined}
        data-downloadable={bvid ? "true" : undefined}
        {...{ [TOSS_ITEM_ATTR]: selectable ? tossItem : undefined }}
        aria-selected={selected}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          event.preventDefault();
          setRowMenu({ x: event.clientX, y: event.clientY, pageIndex: 0, part: false });
        }}
        onDoubleClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          if (!bvid) return;
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          if (selectionMode) return;
          if (playClick === "double") {
            previewPage(0);
          }
        }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          if (selectionMode || event.metaKey || event.ctrlKey || event.shiftKey) return;
          bindPointerDrag(event);
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
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          if (!bvid) return;
          if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
          // Picking: a plain click anywhere on the row picks or drops it (⌘/Ctrl-click starts
          // the picking, Shift-click takes the run from the row touched last). Nothing is previewed.
          if (selectable && (selectionMode || event.metaKey || event.ctrlKey || event.shiftKey)) {
            onToggleSelect?.(event.shiftKey);
            return;
          }
          if (selectionMode) return;
          // 窄屏单击即播，双点的第二个 click 必须吞掉，避免视频重新装载两次。
          if (playClick === "single" && event.detail > 1) return;
          if (playClick === "single") {
            previewPage(0);
          }
        }}
        title={
          playClick === "single"
            ? "单击预览视频；下载细项可在队列里调整"
            : "双击预览视频；下载细项可在队列里调整"
        }
        {...foldingRowProps(leave)}
      >
        <div role="gridcell" className="kd-list-cell kd-result-gutter" {...cellDrag} />
        <div role="gridcell" className="kd-list-cell kd-result-lead" data-col="index" {...cellDrag} data-flex="">
          <RowIndex
            number={rowNumber}
            picking={selectionMode}
            pick={selectable ? (
              <RowPick
                state={selected ? "all" : "none"}
                label={`选择 ${title}`}
                onToggle={(event) => onToggleSelect?.(event.shiftKey)}
              />
            ) : null}
          />
        </div>
        {columns.map((column) => {
          switch (column.key) {
            case "title":
              return (
                <div role="gridcell" key={column.key} className="kd-list-cell kd-td-strong" data-col="title" title={title} {...cellDrag} data-flex="">
                  <span className={`kd-result-title${indent ? " kd-tree-indent" : ""}`}>
                    <span
                      className="kd-thumb"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        clearTextSelection();
                        bindPointerDrag(event, 0);
                      }}
                    >
                      <CoverImage
                        src={displayCover ? thumbUrl(displayCover) : ""}
                        loading="lazy"
                        draggable={false}
                        referrerPolicy="no-referrer"
                      />
                    </span>
                    {withDownloadKey(title, keyColumn === "title" ? downloadKey : null, "kd-result-title-text")}
                    {hasMultiplePages ? (
                      <span className="kd-video-page-count kd-mono">{knownPageCount}P</span>
                    ) : null}
                    {/* The parts toggle trails the title and its count, so every cover starts on the same column. */}
                    {canExpandParts ? (
                      <button
                        type="button"
                        className="kd-result-source-toggle"
                        disabled={resolvingParts}
                        aria-label={
                          resolvingParts
                            ? "正在读取分 P"
                            : partsExpanded
                              ? "收起分 P"
                              : `展开 ${knownPageCount} 个分 P`
                        }
                        aria-expanded={partsExpanded}
                        title={
                          resolvingParts
                            ? "正在读取分 P"
                            : partsExpanded
                              ? "收起分 P"
                              : `展开 ${knownPageCount} 个分 P`
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleParts();
                        }}
                      >
                        {/* One chevron: the stylesheet turns it when the parts are open. */}
                        <ChevronRight size={13} />
                      </button>
                    ) : null}
                  </span>
                </div>
              );
            case "artist":
              return (
                <div role="gridcell" className="kd-list-cell" key={column.key} data-col="artist" data-clip="" title={author || undefined} {...cellDrag}>
                  {keyed(column.key, author || DASH)}
                </div>
              );
            case "album":
              return (
                <div role="gridcell" className="kd-list-cell" key={column.key} data-col="album" {...cellDrag}>
                  {keyed(column.key, DASH)}
                </div>
              );
            case "duration":
              return (
                <div role="gridcell" key={column.key} className="kd-list-cell kd-td-num" data-col="duration" {...cellDrag}>
                  {keyed(column.key, formatDuration(duration ?? info?.duration ?? null))}
                </div>
              );
            case "sources":
              return (
                <div role="gridcell" className="kd-list-cell" key={column.key} data-col="sources" {...cellDrag} data-flex="">
                  {keyed(column.key, (
                    <span className="kd-source-dots" title={platform === "youtube" ? "YouTube" : "B站"}>
                      <span className="kd-source-dot" data-platform={platform} data-active="true">
                        <PlatformMark id={platform} size={12} />
                      </span>
                    </span>
                  ))}
                </div>
              );
            case "from":
              return (
                <div role="gridcell" key={column.key} className="kd-list-cell kd-mono" data-col="from" {...cellDrag}>
                  {keyed(column.key, platform === "youtube" ? "YouTube" : "B站")}
                </div>
              );
            case "quality":
              return (
                <div role="gridcell" key={column.key} className="kd-list-cell kd-td-num kd-mono" data-col="quality" {...cellDrag}>
                  {keyed(column.key, qualityLabel)}
                </div>
              );
            case "vip":
              return (
                <div role="gridcell" className="kd-list-cell" key={column.key} data-col="vip" style={{ width: "3rem" }} {...cellDrag} data-flex="">
                  {keyed(column.key, null)}
                </div>
              );
            default:
              return <div role="gridcell" className="kd-list-cell" key={column.key} {...cellDrag} />;
          }
        })}
      </div>
      {partsFold === "open" || partsFold === "out"
        ? pages.map((page, pageIndex) => {
            // Leaving with the package, or folding back under this row: the last part goes first.
            const partLeave =
              leave ?? (partsFold === "out" ? foldOrder(pageIndex, pages.length) : undefined);
            return (
            <div className="kd-list-row" role="row"
              key={`${bvid}:p${pageIndex + 1}`}
              data-video="true"
              data-video-part="true"
              data-parent-indented={indent ? "true" : undefined}
              data-unfold={unfold && partLeave === undefined ? "true" : undefined}
              style={unfold ? ({ "--kd-unfold-i": Math.min(pageIndex, 8) } as CSSProperties) : undefined}
              aria-label={`P${pageIndex + 1}，${page.title}，${playClick === "single" ? "单击" : "双击"}预览`}
              tabIndex={0}
              onContextMenu={(event) => {
                event.preventDefault();
                setRowMenu({
                  x: event.clientX,
                  y: event.clientY,
                  pageIndex,
                  part: true,
                });
              }}
              onPointerDown={(event) => {
                if ((event.target as HTMLElement).closest("button, select, label, input, a")) return;
                if (selectionMode || event.metaKey || event.ctrlKey) return;
                bindPointerDrag(event, pageIndex);
              }}
              onClick={(event) => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                if (selectionMode) return;
                if (playClick === "single" && event.detail > 1) return;
                if (playClick === "single") previewPage(pageIndex);
              }}
              onDoubleClick={() => {
                if (!selectionMode && playClick === "double") previewPage(pageIndex);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                if (!selectionMode) previewPage(pageIndex);
              }}
              {...foldingRowProps(partLeave)}
            >
              <div role="gridcell" className="kd-list-cell kd-result-gutter" {...cellDrag} />
              <div role="gridcell" className="kd-list-cell kd-result-lead" data-col="index" {...cellDrag}  data-flex=""/>
              {columns.map((column) => partCell(column.key, page, pageIndex))}
                  </div>
            );
          })
        : null}
      {partsFold === "shut" ? (
        <div className="kd-list-row" role="row" data-fold="shut" aria-hidden="true"
          style={{ "--kd-fold-h": `calc(var(--kd-row-h) * ${pages.length})` } as CSSProperties} />
      ) : null}
      {sendError ? (
        <div className="kd-list-row" role="row" data-video="true">
          <div role="gridcell" className="kd-list-cell" data-flex="" style={{ gridColumn: "1 / -1" }}>
            <InlineNotice text={sendError} onDismiss={() => setSendError("")} />
          </div>
        </div>
      ) : null}
      {rowMenu && (
        <ContextMenu x={rowMenu.x} y={rowMenu.y} onClose={() => setRowMenu(null)}>
          <button
            type="button"
            disabled={sending || !bvid}
            onClick={() => {
              if (!rowMenu.part && onDownloadSelected) onDownloadSelected();
              else void download(rowMenu.pageIndex);
              setRowMenu(null);
            }}
          >
            <Download size={12} />
            {rowMenu.part ? `下载 P${rowMenu.pageIndex + 1}` : "加入下载队列"}
          </button>
          <button
            type="button"
            onClick={() => {
              const page = pages[rowMenu.pageIndex];
              void copyText(
                rowMenu.part && page
                  ? `${title} · P${rowMenu.pageIndex + 1} · ${page.title}`
                  : title,
              );
              setRowMenu(null);
            }}
          >
            <Copy size={12} />
            复制标题
          </button>
          {!rowMenu.part && shareSelection ? shareSelection.count > 0 ? (
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
          ) : null : platformShareLink(
            platform,
            bvid,
            rowMenu.part || hasMultiplePages
              ? { page_index: rowMenu.pageIndex, page_count: knownPageCount }
              : undefined,
          ) ? (
            <button
              type="button"
              onClick={() => {
                const page = pages[rowMenu.pageIndex];
                const shareLink = platformShareLink(
                  platform,
                  bvid,
                  rowMenu.part || hasMultiplePages
                    ? { page_index: rowMenu.pageIndex, page_count: knownPageCount }
                    : undefined,
                );
                if (!shareLink) return;
                void copyShareContent(
                  formatShareText(
                    shareLink,
                    {
                      title:
                        rowMenu.part && page
                          ? `${title} · P${rowMenu.pageIndex + 1} · ${page.title}`
                          : title,
                      artists: author,
                    },
                    shareContentMode,
                  ),
                  shareContentMode,
                  remoteArtwork(displayCover),
                );
                setRowMenu(null);
              }}
            >
              <Link2 size={12} />
              复制分享内容
            </button>
          ) : null}
          {!rowMenu.part && onRemoveFromStreamPlaylist && removeFromStreamPlaylistLabel ? (
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
          ) : null}
          {!rowMenu.part && selectable ? (
            <button
              type="button"
              onClick={() => {
                onEnterSelection?.();
                if (!selected) onToggleSelect?.();
                setRowMenu(null);
              }}
            >
              <Check size={12} />
              选择
            </button>
          ) : null}
          {author ? (
            <button
              type="button"
              onClick={() => {
                void copyText(author);
                setRowMenu(null);
              }}
            >
              <Copy size={12} />
              复制 UP 主
            </button>
          ) : null}
          {bvid ? (
            <button
              type="button"
              onClick={() => {
                void copyText(bvid);
                setRowMenu(null);
              }}
            >
              <Copy size={12} />
              {platform === "youtube" ? "复制视频 ID" : "复制 BV 号"}
            </button>
          ) : null}
        </ContextMenu>
      )}
    </Fragment>
  );
}
