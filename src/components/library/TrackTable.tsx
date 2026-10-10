import { dropWorkshopTracks, paintWorkshopDrop } from "../../lib/workshopDrop";
import { useStore } from "zustand";
import type { LibraryPaneStore, LibraryPaneStoreApi } from "../../stores/temporaryLibraryStore";
import { cloneElement, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import {
  Check,
  BarChart3,
  CircleAlert,
  Copy,
  Download,
  FolderOpen,
  Link2,
  ListX,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Search,
  Undo2,
  Trash2,
  Video,
  Image as ImageIcon,
} from "lucide-react";
import { LIBRARY_REST_PACE, libraryScrollPace, libraryViewport, libraryWindowTop, restoreLibraryAnchor } from "../../lib/libraryViewport";
import { createLibraryStandIns, standInGap, type LibraryStandIns } from "../../lib/libraryStandIns";
import { createLibraryRowRecovery, type LibraryRowRecovery } from "../../lib/libraryRowRecovery";
import { tracePlayback } from "../../lib/playbackTrace";
import { api } from "../../lib/api";
import { WorkshopAddMenu } from "../composition/WorkshopAddMenu";
import { acquireCoverThumbnail, peekCoverThumbnail, type CoverThumbnailLease } from "../../lib/coverThumbnailQueue";
import { OverlayScrollbars } from "../common/OverlayScrollbars";
import { CoverImage, VinylPlaceholder } from "../common/VinylPlaceholder";
import { RowIndex, RowPick } from "../common/RowPick";
import { TableRating } from "../common/TableRating";
import { TableSortMark } from "../common/TableSortMark";
import { TrackKeyChip } from "../common/TrackKeyChip";
import { pointerDragGhost, setDragGhost, type PointerDragGhost } from "../common/dragGhost";
import "../common/DragGhost.css";
import { createListArrival, type ListArrival } from "./listArrival";
import { copyText } from "../../lib/copyText";
import { copyShareContent } from "../../lib/shareClipboard";
import {
  bilibiliVideoShareSearchQuery,
  formatShareText,
  matchedBilibiliVideoShareLink,
  matchedTrackShareLink,
  soundCloudPlayerShareLink,
  soundCloudStoredShareLink,
  soundCloudTrackApiUrl,
  soundCloudTrackId,
  trackShareLink,
  trackShareSearchQuery,
  writeShareLinkDrag,
} from "../../lib/shareLink";
import { clearTextSelection, hasTextSelectionWithin } from "../../lib/textSelection";
import { observeTrackScroller } from "../../lib/autoAnalyze";
import { getBridge } from "../../lib/bridge";
import { isEditable } from "../../lib/useLibraryClipboard";
import { tableSortTitle } from "../../lib/tableSort";
import { DJ_TRACK_TABLE_COLUMN_WIDTHS, fitDjTrackColumns } from "../../lib/djTableLayout";
import {
  announceTrackDrag,
  claimActiveTrackDragIds,
  dispatchTrackCoverDrop,
  dispatchTrackDeckDrop,
  dispatchTrackSamplerDrop,
  endTrackDrag,
  finishTrackDrop,
  lockTrackPointerDragScroll,
  suppressCoverClickAfterTrackDrop,
  systemFileDragPayload,
  trackDeckDropSideAt,
  TRACK_COVER_DROP_TARGET_ATTR,
  TRACK_DECK_DROP_TARGET_ATTR,
  TRACK_DECK_SPLIT_DROP_TARGET,
  TRACK_SAMPLER_DROP_TARGET_ATTR,
  TRACK_TRASH_DROP_EVENT,
  writeTrackDragData,
  type TrackDragDetail,
} from "../../lib/trackDrag";
import {
  folderDropElementAt,
  FOLDER_DROP_PATH_ATTR,
} from "../../lib/folderDrop";
import { resolveLibraryPasteOp } from "../../lib/libraryPaste";
import { isOutsideFolder } from "../../lib/outsideFolder";
import { DASH, formatBpm, formatBytes, formatDate, formatDuration, isImageTrack, isVideoTrack, thumbUrl } from "../../lib/format";
import { playClickForLayout, useTrackClickPrefs } from "../../lib/trackClickPrefs";
import type { LayoutMode } from "../../lib/useLayoutMode";
import { shouldHandleWorkspaceDelete } from "../../lib/workspacePanes";
import {
  readWorkspaceSession,
  updateLocalWorkspaceSession,
} from "../../lib/workspaceSession";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import {
  useLibraryStore,
  type SelectMode,
  type SortOrder,
  type TrackSort,
} from "../../stores/libraryStore";
import type { DownloadTask } from "../../types";
import type { FileDisposalMode, KeyNotation, SongSource, TrackSummary } from "../../types";
import { playTrack } from "../../lib/playTrack";
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
import { ContextMenu, InlineNotice } from "../common";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import { useTrackMetaEditor } from "../../lib/trackMetaEditor";
import { dragPreviewFromBlob, vinylDragPreview } from "../../lib/dragPreview";
import { usePlaybackPrefs } from "../../lib/playbackPrefs";
import { useSharePrefs } from "../../lib/sharePrefs";
import { requestExploreSearch } from "../../lib/vjSearch";
import { isPlatformEnabled } from "../../lib/enabledPlatforms";
import { normalizeEnabledPlatforms, normalizeSearchPlatforms } from "../../lib/searchPlatforms";
import { removeLocalStorage } from "../../lib/storageWrite";

/** @deprecated 请从 `lib/playTrack` 引用；保留 re-export 以免旧 import 断掉。 */
export { PLAY_EVENT, playTrack, parsePlayRequest, type PlayRequest } from "../../lib/playTrack";

/**
 * 点播放条的「正在播」块时由 PlayerBar 广播：回到曲库页、看这首歌。
 * Workspace 接住它切页/拉抽屉，本表接住它把选中行滚回视野中央。
 * 定义放这儿而不是 PlayerBar：PlayerBar 已经 import 本文件（PLAY_EVENT），
 * 反向再 import 一个常量就成环了。
 */
export const DETAIL_EVENT = "kd:show-detail";

export interface DetailEventDetail {
  source?: string;
  /** 定位正在播等场景：显式指定要滚进视野的曲目 id。 */
  trackId?: number;
}

/** 1..10 的能量条。未分析时全灰。 */
export function EnergyMeter({
  value,
  rmsDb = null,
  peakDb = null,
}: {
  value: number | null;
  rmsDb?: number | null;
  peakDb?: number | null;
}) {
  const stats = useLibraryStore((state) => state.stats);
  const rmsBaseline = stats?.rms_db_median;
  const energyBaseline = stats?.energy_median;
  const peakBaseline = stats?.peak_db_median;
  const ratio =
    rmsDb !== null && rmsBaseline !== null && rmsBaseline !== undefined
      ? Math.pow(10, (rmsDb - rmsBaseline) / 20) * 100
      : value !== null && energyBaseline
        ? (value / energyBaseline) * 100
        : null;
  const peakDelta = peakDb !== null && peakBaseline != null ? peakDb - peakBaseline : 0;
  const tone =
    ratio === null
      ? "empty"
      : ratio > 135 || peakDelta > 1.5
        ? "danger"
        : ratio > 118 || peakDelta > 0.8
          ? "hot"
          : ratio > 105
            ? "warm"
            : "ok";
  const details = [
    ratio !== null ? `相对曲库基准 ${Math.round(ratio)}%` : "曲库基准尚未建立",
    value !== null ? `能量 ${value}/10` : "",
    rmsDb !== null ? `RMS ${rmsDb.toFixed(1)} dB` : "",
    peakDb !== null ? `Peak ${peakDb.toFixed(1)} dB` : "",
  ].filter(Boolean);
  return (
    <span className="kd-loudness-number" data-tone={tone} title={details.join(" · ")}>
      {ratio !== null ? `${Math.round(ratio)}%` : DASH}
    </span>
  );
}

interface Column {
  id: TrackSort | null;
  label: string;
  width?: string;
  align?: "num";
  /** 给 CSS / 测试用来定位这一列。 */
  key: string;
}

/**
 * 列宽策略：**标题永远不参与压缩，其余列按优先级让位——但都不消失**。
 *
 * 标题是唯一无法从别处推断的信息（BPM/KEY/时长都是数字，看一眼就知道），
 * 标题直接拿固定的高优先宽度；依赖“吃剩余”会在以后新增列时又悄悄缩回去。
 *
 * 艺人和专辑用 `clamp(下限, 理想值, 上限)`：面板一窄就先缩到下限，
 * 把省出来的宽度让给标题。下限故意留得能看见几个字 + 省略号——
 * **让位不等于消失**，一列全空白和一列没有是两回事。
 * 专辑的下限比艺人更小，所以挤压时它先让。
 */
const COLUMNS: Column[] = [
  { id: "title", label: "标题", width: "14rem", key: "title" },
  // 标题单元格里还装着封面缩略图 + 「视频」角标（约 70px），它们都算在标题头上，
  // 所以其余列的预留只能更抠：艺人/专辑的理想占比与上限都压小
  //（曲库里一大片视频行这两列本来就全是"—"），数字列给到刚好放下内容为止。
  { id: "artist", label: "艺人", width: "6.5rem", key: "artist" },
  { id: "album", label: "专辑", width: "5.75rem", key: "album" },
  { id: "bpm", label: "BPM", width: "4.2rem", align: "num", key: "bpm" },
  // 单元格两侧各有 0.6rem 内边距，色块本身最小 2.6rem；3.4rem 会让
  // 色块超出内容区，td 的 text-overflow: ellipsis 就会在它后面补出一个点。
  { id: "camelot", label: "KEY", width: "4rem", key: "camelot" },
  // 现在只显示彩色百分比，不再为已经删除的响度轨道预留宽度。
  { id: "energy", label: "响度", width: "3.8rem", key: "energy" },
  { id: "duration", label: "时长", width: "4rem", align: "num", key: "duration" },
  { id: null, label: "格式", width: "3.4rem", key: "format" },
  { id: null, label: "大小", width: "4.6rem", align: "num", key: "size" },
  { id: "file_created_at", label: "文件创建", width: "8.5rem", key: "file_created_at" },
  { id: "rating", label: "评分", width: "4.2rem", key: "rating" },
  { id: null, label: "采样率", width: "5.5rem", key: "samplerate" },
  { id: null, label: "声道", width: "3.4rem", key: "channels" },
  { id: null, label: "码率", width: "5.5rem", key: "bitrate" },
  { id: null, label: "流派", width: "6rem", key: "genre" },
  { id: null, label: "年份", width: "4rem", key: "year" },
  { id: null, label: "来源", width: "6rem", key: "source_platform" },
  { id: "added_at", label: "入库", width: "8.5rem", key: "added_at" },
  { id: null, label: "文件名", width: "14rem", key: "filename" },
  { id: null, label: "路径", width: "20rem", key: "path" },
];

/* ------------------------------------------------------------ 列的自由组合 */

/**
 * 列顺序 + 隐藏集合 + 自定义列宽，长期保存。和三栏换位、详情面板拖排同一套心智：
 * 拖一次、勾一次、拉一次，永远不用再想。存的是 id 列表而不是完整快照，
 * 理由同 PanelStack：以后加新列时旧存档不作废，新列自动排在默认位置。
 */
const COLUMN_PREFS_KEY = "kd-library-columns";
const INDEX_COL_KEY = "index";
const INDEX_DEFAULT_WIDTH = "1.75rem";

type ColumnPrefs = TableColumnPrefs;

const COLUMN_MIN_WIDTH: Record<string, string> = {
  index: "1.4rem",
  title: "4rem",
  artist: "3rem",
  album: "3rem",
  bpm: "2.8rem",
  camelot: "2.8rem",
  energy: "2.8rem",
  duration: "2.8rem",
  format: "2.6rem",
  size: "3.4rem",
  file_created_at: "6.5rem",
  rating: "3rem",
  samplerate: "4.5rem",
  channels: "3rem",
  bitrate: "4.5rem",
  genre: "3rem",
  year: "3rem",
  source_platform: "4rem",
  added_at: "6.5rem",
  filename: "4rem",
  path: "5rem",
};

const COLUMN_MAX_WIDTH = "80rem";
const COLUMN_PREFS_SCHEMA: TableColumnPrefsSchema = {
  columnKeys: COLUMNS.map((column) => column.key),
  // 序号固定在最左侧，不参与换序 / 显隐，但它自己的拖拽宽度也要恢复。
  widthKeys: [INDEX_COL_KEY, ...COLUMNS.map((column) => column.key)],
  lockedVisible: ["title"],
  minWidths: COLUMN_MIN_WIDTH,
  maxWidth: COLUMN_MAX_WIDTH,
};

function loadColumnPrefs(): ColumnPrefs {
  // 标题列永远不准藏：它是唯一说明「这行是哪首歌」的列。
  return loadTableColumnPrefs(COLUMN_PREFS_KEY, COLUMN_PREFS_SCHEMA);
}

export interface TrackTableProps {
  libraryStore?: LibraryPaneStoreApi;
  persistentSession?: boolean;
  total: number;
  loading: boolean;
  /**
   * 当前布局档位，原样落到 `<table data-layout>` 上给 CSS 当判据。
   *
   * 换行式（标题一行、元信息一行）**只有 narrow（只剩曲目表这一栏）才准用**。
   * 之前是 `@container (max-width: 700px)` 判的，判据错在：那量的是曲目表这一栏
   * 有多宽，于是"窗口 1400、把详情栏拖到 600"也会触发——屏幕明明还摆得下两栏，
   * 却退化成手机排版。摆不摆得下长条要看还剩几栏，不看这一栏被挤成多窄。
   */
  layout: LayoutMode;
  /** 可选紧凑适配；DJ 模式当前保留完整配置列并由外层横向滚动。 */
  fitWidth?: boolean;
  selectedId: number | null;
  selectedIds: number[];
  /** 分屏中只有当前点亮板块可以消费全局删除快捷键。 */
  shortcutActive: boolean;
  /**
   * 这张表所在的板块此刻是否显示（板块切走时只是 display: none，表格不卸载）。每次重新显示，
   * 列表都重新"到场"一次（见 listArrival）。不传按一直显示算。
   */
  visible?: boolean;
  sort: TrackSort;
  order: SortOrder;
  /** 副排序键：主键相同的那一撮再按它排。null = 只按主键。 */
  sort2: TrackSort | null;
  order2: SortOrder;
  /**
   * clickCount 透传 MouseEvent.detail：双击播放会先送来一下 detail=1 的单击，
   * 再补一下 detail=2。选中始终只改变列表；周围面板跟随正在播放的曲目。
   */
  onSelect(id: number, mode: SelectMode, clickCount?: number): void;
  onSort(sort: TrackSort): void;
}

/**
 * 封面请求的先后由可视范围决定。行不为此重渲染：等待中的请求登记在这里，表格在窗口
 * 移动后统一改它们的优先级（见 TrackTable 里的 coverLane）。
 */
interface WaitingCover { index: number; lease: CoverThumbnailLease }
interface CoverLane { start: number; end: number; fast: boolean; recovering: boolean; waiting: Set<WaitingCover> }
function coverLanePriority(lane: CoverLane, index: number): number {
  if (lane.fast) return Infinity;
  if (index >= lane.start && index < lane.end) return 0;
  return lane.recovering ? Infinity : 1;
}

/**
 * 曲库表的封面格。
 *
 * 后端重启、首次视频抽帧排队时会短暂断开/超时；旧版一收到一次 img error 就直接
 * 写 `visibility: hidden`，服务恢复后浏览器也不会再请求，于是抽帧早就成功了列表
 * 仍永远空白。视频封面用 fetch 先确认 HTTP 成功、转成 Blob URL 后才交给 img；
 * 这样 WKWebView 不会把开发时后端重启造成的图片加载失败永久黏在原节点上。普通
 * 音频没有内嵌图很常见，仍直接退回灰色占位，避免为每一首无图文件轮询。
 */
function TrackCoverThumb({ track, index, lane }: { track: TrackSummary; index: number; lane: CoverLane }) {
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<number | null>(null);
  const waitingRef = useRef<WaitingCover | null>(null);
  const isVideo = isVideoTrack(track.format);
  const revision = isVideo ? `${track.modified_at}-${attempt}` : track.modified_at;
  const key = `${track.id}:${revision}:64`;
  // 首帧直接用已有结论：缓存里的封面、或已知没有封面。结论未知时格子保持空白，
  // 不先画唱盘再换成封面；同一行换修订时，旧图留到新图到达。
  const [shown, setShown] = useState(() => peekCoverThumbnail(key));

  useEffect(() => {
    setAttempt(0);
  }, [track.id, track.modified_at]);

  useEffect(() => {
    let alive = true;
    const lease = acquireCoverThumbnail(key, api.coverUrl(track.id, revision, 64), coverLanePriority(lane, index));
    const waiting: WaitingCover = { index, lease };
    waitingRef.current = waiting;
    lane.waiting.add(waiting);
    void lease.promise
      .then((objectUrl) => {
        lane.waiting.delete(waiting);
        if (alive && objectUrl) setShown((current) => current.src === objectUrl ? current : { src: objectUrl, missing: false });
      })
      .catch(() => {
        lane.waiting.delete(waiting);
        if (!alive) return;
        if (!isVideo || attempt >= 12) {
          setShown(current => current.missing && !current.src ? current : { src: "", missing: true });
          return;
        }
        // 后端热重启 / 首次抽帧排队时稍候再试。每次换 URL，失败缓存不会卡住重试。
        retryTimer.current = window.setTimeout(() => {
          retryTimer.current = null;
          setAttempt((value) => value + 1);
        }, 3000);
      });

    return () => {
      alive = false;
      lease.release();
      lane.waiting.delete(waiting);
      if (waitingRef.current === waiting) waitingRef.current = null;
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    };
  }, [key, lane]);
  // 排序变化会让同一行换位置；等待中的请求跟着换优先级。
  useEffect(() => {
    const waiting = waitingRef.current;
    if (!waiting || waiting.index === index) return;
    waiting.index = index;
    waiting.lease.setPriority(coverLanePriority(lane, index));
  }, [index, lane]);

  return (
    <span className="kd-thumb" draggable={false}>
      {shown.src ? (
        isVideo ? <img key={shown.src} src={shown.src} alt="" draggable={false} /> : <CoverImage src={shown.src} />
      ) : shown.missing && !isVideo ? (
        <VinylPlaceholder />
      ) : null}
    </span>
  );
}

const systemDragPreviewCache = new Map<string, Promise<string>>();

/**
 * 系统拖拽的图片必须在离开 WebView 前准备好。指针按下时就从本地封面路由预取，
 * 并裁成固定方形，避免高分辨率封面在 Finder / Explorer 下变成巨大的拖拽浮图。
 */
function systemDragPreview(track: TrackSummary): Promise<string> {
  const cacheKey = `${track.id}:${track.modified_at}`;
  const cached = systemDragPreviewCache.get(cacheKey);
  if (cached) return cached;
  // 走后端缩略图磁盘缓存，不在每次按下时抽取、传输、解码整张原图。缩略图按长边 256 缩放，
  // 2:1 以内的封面裁成方形后短边仍不小于 128，不会被放大。
  const pending = fetch(api.coverUrl(track.id, track.modified_at, 256))
    .then((response) => response.ok ? response.blob() : Promise.reject(new Error(`HTTP ${response.status}`)))
    .then(dragPreviewFromBlob)
    .catch(() => vinylDragPreview());
  systemDragPreviewCache.set(cacheKey, pending);
  if (systemDragPreviewCache.size > 96) {
    const oldest = systemDragPreviewCache.keys().next().value;
    if (oldest) systemDragPreviewCache.delete(oldest);
  }
  return pending;
}

const localTrackShareLinkCache = new Map<string, Promise<string | null>>();
const resolvedLocalTrackShareLinks = new Map<string, string | null>();

function localTrackShareCacheKey(track: TrackSummary): string {
  const query = isVideoTrack(track.format)
    ? bilibiliVideoShareSearchQuery(track)
    : trackShareSearchQuery(track);
  return `${track.id}:${track.modified_at}:${track.source_key}:${query}`;
}

/**
 * The page of a SoundCloud download. The record keeps the track's id, not its address, so the
 * platform is asked for the address of that id: first its resolver, then a search for the title
 * in which only the source with the same id counts. When SoundCloud cannot be asked at all, its
 * player addressed by the id is shared instead. A title match is never used: the id is known.
 */
function resolveSoundCloudShareLink(track: TrackSummary, id: string): Promise<string | null> {
  const stored = (sources: readonly SongSource[]) => soundCloudStoredShareLink(track, sources);
  const query = trackShareSearchQuery(track);
  return api.resolve(soundCloudTrackApiUrl(id), 1)
    .then((response) => stored(response.sources))
    .catch(() => null)
    .then((link) => link ?? (query
      ? api.search({ query, platforms: ["soundcloud"], limit: 12, merge: false, kind: "song" })
        .then((response) => stored([
          ...(response.per_platform.soundcloud ?? []),
          ...response.groups.flatMap((group) => group.sources),
        ]))
        .catch(() => null)
      : null))
    .then((link) => link ?? soundCloudPlayerShareLink(track));
}

/**
 * 没有直接链接的本地曲目：SoundCloud 下载按曲目 id 向平台取回页面地址；B 站多 P 视频按
 * KDJ 固定文件名还原父标题；其余旧曲目走严格同名匹配。
 */
function resolveLocalTrackShareLink(track: TrackSummary): Promise<string | null> {
  const direct = trackShareLink(track);
  if (direct) return Promise.resolve(direct);
  const soundCloudId = soundCloudTrackId(track);
  const video = isVideoTrack(track.format);
  const query = video
    ? bilibiliVideoShareSearchQuery(track)
    : trackShareSearchQuery(track);
  if (!soundCloudId && !query) return Promise.resolve(null);
  const cacheKey = localTrackShareCacheKey(track);
  if (resolvedLocalTrackShareLinks.has(cacheKey)) {
    return Promise.resolve(resolvedLocalTrackShareLinks.get(cacheKey) ?? null);
  }
  const cached = localTrackShareLinkCache.get(cacheKey);
  if (cached) return cached;
  const pending = (soundCloudId
    ? resolveSoundCloudShareLink(track, soundCloudId)
    : api.search({
      query,
      platforms: video ? ["bilibili"] : ["wyy", "qqm"],
      limit: 8,
      merge: false,
      kind: "song",
    }).then((response) => video
      ? matchedBilibiliVideoShareLink(track, response.per_platform.bilibili ?? [])
      : matchedTrackShareLink(
        track,
        response.groups.flatMap((group) => group.sources),
      )).catch(() => null)
  ).then((link) => {
    resolvedLocalTrackShareLinks.set(cacheKey, link);
    return link;
  });
  localTrackShareLinkCache.set(cacheKey, pending);
  if (localTrackShareLinkCache.size > 96) {
    const oldest = localTrackShareLinkCache.keys().next().value;
    if (oldest) localTrackShareLinkCache.delete(oldest);
  }
  return pending;
}

/** 每列的单元格。列可以被拖排 / 隐藏（见 COLUMN_PREFS_KEY），所以按 key 取，不写死顺序。 */
function trackCell(
  track: TrackSummary,
  key: string,
  keyNotation: KeyNotation,
  onRate: ((rating: number) => void) | undefined,
  index: number,
  coverLane: CoverLane,
) {
  switch (key) {
    case "title":
      return (
        <td key={key} data-col="title" className="kd-td-strong" title={track.title || track.filename}>
          {/* lazy：一页 200 行，只在滚到眼前时请求。视频首帧由 TrackCoverThumb
              在服务短暂重启或抽帧排队时重试，不能一次失败就永久变成灰格。 */}
          <TrackCoverThumb track={track} index={index} lane={coverLane} />
          {/* 媒介类型是这首本地文件的附属信息，排在封面后、标题前。 */}
          {isVideoTrack(track.format) && (
            <span className="kd-video-mark" title="视频" role="img" aria-label="视频">
              <Video size={11} aria-hidden="true" />
            </span>
          )}
          {isImageTrack(track.format) && <span className="kd-video-mark" title={track.format.toLowerCase() === "gif" ? "GIF" : "图片"} role="img" aria-label={track.format.toLowerCase() === "gif" ? "GIF" : "图片"}><ImageIcon size={11} aria-hidden="true" /></span>}
          {track.title || track.filename}
        </td>
      );
    case "artist":
      // data-empty 是给竖屏用的：那边没有"列"要对齐，
      // 一个孤零零的破折号只是噪声，直接不占位
      return (
        <td key={key} data-col="artist" data-empty={track.artist ? undefined : "true"} title={track.artist}>
          {track.artist || DASH}
        </td>
      );
    case "album":
      return (
        <td key={key} data-col="album" title={track.album}>
          {track.album || DASH}
        </td>
      );
    case "bpm":
      return (
        <td key={key} data-col="bpm" className="kd-td-num">
          {formatBpm(track.bpm)}
        </td>
      );
    case "camelot":
      return (
        <td key={key} data-col="camelot">
          <TrackKeyChip track={track} notation={keyNotation} />
        </td>
      );
    case "energy":
      return (
        <td key={key} data-col="energy">
          <EnergyMeter value={track.energy} rmsDb={track.rms_db} peakDb={track.peak_db} />
        </td>
      );
    case "duration":
      return (
        <td key={key} data-col="duration" className="kd-td-num">
          {formatDuration(track.duration)}
        </td>
      );
    case "format":
      return (
        <td key={key} data-col="format" className="kd-mono kd-muted">
          {track.format.toUpperCase() || DASH}
        </td>
      );
    case "size":
      return (
        <td key={key} data-col="size" className="kd-td-num kd-mono kd-muted">
          {formatBytes(track.size)}
        </td>
      );
    case "file_created_at":
      return (
        <td key={key} data-col="file_created_at" className="kd-mono kd-muted">
          {formatDate(track.file_created_at)}
        </td>
      );
    case "samplerate":
    case "channels":
    case "bitrate": {
      const value = key === "samplerate"
        ? track.samplerate ? `${track.samplerate / 1000} kHz` : DASH
        : key === "channels"
          ? track.channels ? `${track.channels}ch` : DASH
          : track.bitrate ? `${track.bitrate} kbps` : DASH;
      return <td key={key} data-col={key} className="kd-mono kd-muted" title={value}>{value}</td>;
    }
    case "genre":
    case "year":
    case "source_platform":
    case "filename":
    case "path": {
      const value = track[key] || (key === "source_platform" ? "local" : "");
      return <td key={key} data-col={key} title={value}>{value || DASH}</td>;
    }
    case "added_at":
      return <td key={key} data-col={key} className="kd-mono kd-muted">{formatDate(track.added_at)}</td>;
    case "rating":
      return (
        <td key={key} data-col="rating">
          <TableRating value={track.rating} onChange={onRate} />
        </td>
      );
    default:
      return null;
  }
}

interface TrackCellsProps {
  track: TrackSummary;
  /** 在当前顺序里的位置（从 0 起）。 */
  index: number;
  coverLane: CoverLane;
  showIndex: boolean;
  columns: readonly Column[];
  keyNotation: KeyNotation;
  /** Rows are being picked: the index gives way to the selection mark (see TrackTable's `selecting`). */
  selectionMode: boolean;
  selected: boolean;
  /** `range` picks the run from the row touched last to this one. */
  onToggle(id: number, range?: boolean): void;
  onRate(id: number, rating: number): void;
}

/**
 * 行的选中、焦点和播放标记只改 <tr> 的属性；单元格树单独 memo 后，封面、能量条和
 * 评分控件不会跟着重复执行。
 */
const TrackCells = memo(function TrackCells({
  track,
  index,
  coverLane,
  columns,
  keyNotation,
  onRate,
}: TrackCellsProps) {
  return (
    <>
      {columns.map((column) => {
        const cell = trackCell(
          track,
          column.key,
          keyNotation,
          column.key === "rating" ? (rating) => onRate(track.id, rating) : undefined,
          index,
          coverLane,
        ) as React.ReactElement<React.TdHTMLAttributes<HTMLTableCellElement>>;
        return cloneElement(
          cell,
          { draggable: false },
          <span className="kd-track-drag-surface" draggable={false}>
            {cell.props.children}
          </span>,
        );
      })}
      <td className="kd-table-fill" aria-hidden="true" />
    </>
  );
});

/** 空位只留序号（由 TrackRow 持有）；一个空格跨过数据列，不制造假的内容或控件。 */
const PlaceholderCells = memo(function PlaceholderCells({ columns }: Pick<TrackCellsProps, "columns">) {
  return <td colSpan={columns.length + 1} aria-hidden="true" />;
});

/**
 * 行上的交互。对象身份在表格的整个生命周期里不变（实现每次渲染换新，见 TrackTable 里的
 * rowActions），所以窗口移动、选区变化都不会让没变的行重渲染。
 */
interface TrackRowActions {
  click(event: React.MouseEvent<HTMLTableRowElement>, track: TrackSummary): void;
  doubleClick(track: TrackSummary): void;
  pointerDown(event: React.PointerEvent<HTMLTableRowElement>, track: TrackSummary): void;
  cancelPress(): void;
  contextMenu(event: React.MouseEvent<HTMLTableRowElement>, track: TrackSummary): void;
  linkDragStart(event: React.DragEvent<HTMLTableRowElement>, track: TrackSummary): void;
  linkDragEnd(): void;
}

interface TrackRowProps extends Omit<TrackCellsProps, "track"> {
  track: TrackSummary | undefined;
  recovery: LibraryRowRecovery;
  focused: boolean;
  playing: boolean;
  /** Windows 分享链接走 WebView2 原生 HTML5 拖放。 */
  linkDrag: boolean;
  actions: TrackRowActions;
}

/**
 * 一行曲目。滚动只是把窗口挪几行：留在窗口里的行 props 不变，整行跳过；真正要渲染的
 * 只有新进来的那几行。
 */
const TrackRow = memo(function TrackRow({
  track,
  recovery,
  focused,
  playing,
  linkDrag,
  actions,
  ...cells
}: TrackRowProps) {
  const rowRef = useRef<HTMLTableRowElement | null>(null);
  const [admitted, setAdmitted] = useState(() => Boolean(track) && !recovery.deferred());
  const ready = admitted || !recovery.deferred() ? track : undefined;
  const id = track?.id;
  const index = cells.index;
  const readable = Boolean(ready);
  useLayoutEffect(() => {
    if (readable && id !== undefined) {
      if (!admitted) setAdmitted(true);
      recovery.remember(id);
      return;
    }
    // Register even when the summary is missing. A response arriving after a fling must still
    // pass through the commit budget, rather than materializing every cold row together.
    return recovery.enqueue({ index, available: id !== undefined, fresh: id !== undefined && !recovery.seen(id),
      admit: () => setAdmitted(true), element: () => rowRef.current });
  }, [recovery, index, admitted, id, readable]);
  return (
    <tr
      ref={rowRef}
      aria-selected={cells.selected}
      aria-busy={!ready || undefined}
      data-loading-track={!ready ? "true" : undefined}
      data-kd-track-id={ready?.id}
      data-focus={focused ? "true" : undefined}
      data-playing={playing ? "true" : undefined}
      data-selecting={cells.selectionMode ? "true" : undefined}
      // 空位没有交互；序号和 tr 在补入内容时不替换、不移动。
      draggable={Boolean(ready && linkDrag)}
      onDragStart={ready && linkDrag ? (event) => actions.linkDragStart(event, ready) : undefined}
      onDragEnd={ready && linkDrag ? actions.linkDragEnd : undefined}
      onClick={ready ? (event) => actions.click(event, ready) : undefined}
      onPointerDown={ready ? (event) => actions.pointerDown(event, ready) : undefined}
      onPointerUp={actions.cancelPress}
      onPointerCancel={actions.cancelPress}
      onPointerLeave={actions.cancelPress}
      onDoubleClick={ready ? () => actions.doubleClick(ready) : undefined}
      onContextMenu={ready ? (event) => actions.contextMenu(event, ready) : undefined}
    >
      {cells.showIndex ? (
        <td data-col="index" data-picking={cells.selectionMode && ready ? "true" : undefined}>
          <RowIndex number={index + 1} picking={cells.selectionMode} pick={ready ? (
            <RowPick state={cells.selected ? "all" : "none"} label={`选择 ${ready.title || ready.filename}`}
              onToggle={(event) => cells.onToggle(ready.id, event.shiftKey)} />
          ) : null} />
        </td>
      ) : null}
      {ready ? <TrackCells track={ready} {...cells} /> : <PlaceholderCells columns={cells.columns} />}
    </tr>
  );
});

/** 鼠标事件 → 多选语义。Mac 用 Cmd，其它平台用 Ctrl，两个都认。 */
function selectMode(event: React.MouseEvent): SelectMode {
  if (event.shiftKey) return "range";
  if (event.metaKey || event.ctrlKey) return "toggle";
  return "replace";
}

function sameFolderPath(a: string, b: string): boolean {
  const norm = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");
  return Boolean(a) && norm(a) === norm(b);
}

const PENDING_STATES = new Set(["queued", "running", "processing", "paused", "failed"]);

/**
 * 虚拟滚动的兜底行高（= --kd-row-h）。真实行高以渲染出来的第一行为准
 * （见 TrackTable 里的量测 effect），这里只是首帧还没量到时的占位。
 */
const FALLBACK_ROW_H = 36;
/** 原生拖放结束回调早于 WebView 清掉边缘自动滚动，留一小段静默期吞掉尾帧。 */
const EXTERNAL_DRAG_SCROLL_SETTLE_MS = 240;

function pendingLabel(task: DownloadTask): string {
  if (task.state === "running") {
    const pct = Math.round(Math.max(0, Math.min(1, task.progress)) * 100);
    const action = "下载中";
    return pct > 0 ? `${action} ${pct}%` : action;
  }
  if (task.state === "processing") {
    return "正在生成文件";
  }
  if (task.state === "paused") return "已暂停";
  if (task.state === "failed") return task.error ? `失败：${task.error}` : "下载失败";
  if (task.state === "done") return "入库中";
  return "待下载";
}

function PendingStateMark({ task }: { task: DownloadTask }) {
  const label = pendingLabel(task);
  const icon =
    task.state === "running" || task.state === "processing" ? (
      <LoaderCircle size={12} className="kd-spin" />
    ) : task.state === "paused" ? (
      <Pause size={12} />
    ) : task.state === "failed" ? (
      <CircleAlert size={12} />
    ) : task.state === "done" ? (
      <Check size={12} />
    ) : (
      <Download size={12} />
    );

  return (
    <span className="kd-pending-mark" data-state={task.state} title={label} role="img" aria-label={label}>
      {icon}
    </span>
  );
}

/** 当前文件夹下载任务的即时反馈；文件实际入库后由正式曲目行替代。 */
function isPendingForFolder(task: DownloadTask, filterFolder: string, indexById: ReadonlyMap<number, number>): boolean {
  const dest = task.dest_dir?.trim() || "";
  if (!dest) return false;
  const folder = filterFolder.trim();
  // 全部曲目：任意落进曲库文件夹的下载都应顶上可见（子文件夹也属于全库）。
  if (!folder) {
    if (isOutsideFolder(dest)) return false;
  } else if (!sameFolderPath(dest, folder)) {
    return false;
  }
  if (PENDING_STATES.has(task.state)) return true;
  if (task.state !== "done") return false;
  if (task.track_id == null) return true;
  return !indexById.has(task.track_id);
}

/** 渲染窗口的基准位置（按步长取整，见 libraryWindowTop）和视口高度。 */
interface LibraryView { top: number; height: number }
const REST_VIEW: LibraryView = { top: 0, height: 0 };
function sameLibraryView(a: LibraryView, b: LibraryView): boolean {
  return a.top === b.top && a.height === b.height;
}
/** 这么久没有新的滚动帧就算停稳。 */
const SCROLL_REST_MS = 140;
/** 一次滚动走过这么多屏才写一条跟踪日志（开发版）。 */
const TRACED_SCROLL_SCREENS = 3;
/** 快滚途中每走过这么多行，把摘要的加载重心挪到眼前一次。 */
const FLIGHT_DEMAND_ROWS = 300;
/** 列表被呈现时等渲染窗口对齐；滚动补入由每批真实内容自己开始动画。 */
type ArrivalDue = { view: LibraryView; at: number };
/** 换查询后等窗口对上最多这么久。 */
const ARRIVAL_DUE_MS = 400;

export const TrackTable = memo(function TrackTable({
  libraryStore = useLibraryStore,
  persistentSession = true,
  total,
  loading,
  layout,
  fitWidth = false,
  selectedId,
  selectedIds,
  sort,
  order,
  sort2,
  order2,
  onSelect,
  onSort,
  shortcutActive,
  visible = true,
}: TrackTableProps) {
  const useTableStore = <T,>(selector: (state: LibraryPaneStore) => T) => useStore(libraryStore, selector);
  const shortcutActiveRef = useRef(shortcutActive);
  shortcutActiveRef.current = shortcutActive;
  const orderedIds = useTableStore((state) => state.orderedIds);
  const indexById = useTableStore((state) => state.indexById);
  const summaryById = useTableStore((state) => state.summaryById);
  const queryVersion = useTableStore((state) => state.queryVersion);
  const ensureRange = useTableStore((state) => state.ensureRange);
  const loadingMore = useTableStore((state) => state.loadingMore);
  const settings = useAppStore((state) => state.settings);
  const keyNotation = settings?.key_notation ?? "camelot";
  const filterFolder = useTableStore((state) => state.filter.folder);
  const removeTracks = useTableStore((state) => state.removeTracks);
  const widePlay = useTrackClickPrefs((state) => state.widePlay);
  const narrowPlay = useTrackClickPrefs((state) => state.narrowPlay);
  const localExternalDragMode = usePlaybackPrefs((state) => state.localExternalDragMode);
  const shareContentMode = useSharePrefs((state) => state.contentMode);
  const sameNameSearchPlatforms = useMemo(() => {
    const selectedPlatforms = normalizeSearchPlatforms(settings?.search_platforms)
      .filter((platform) => isPlatformEnabled(settings, platform));
    return selectedPlatforms.length > 0
      ? selectedPlatforms
      : normalizeEnabledPlatforms(settings?.enabled_platforms);
  }, [settings]);
  const formatTrackShareText = useCallback(
    (track: TrackSummary, link: string) => formatShareText(
      link,
      { title: track.title || track.filename, artists: track.artist, album: track.album },
      shareContentMode,
    ),
    [shareContentMode],
  );
  const htmlExternalLinkDrag =
    localExternalDragMode === "share_link"
    && !window.kdj?.startLinkDrag
    && window.kdj?.platform === "win32";
  const playClick = playClickForLayout({ widePlay, narrowPlay }, layout);
  const copyToClipboard = useTableStore((state) => state.copyToClipboard);
  const undo = useTableStore((state) => state.undo);
  const undoLast = useTableStore((state) => state.undoLast);
  const undoName = undo.op === "copy" ? "复制" : undo.op === "delete" ? "删除" : "移动";
  const updateTrack = useTableStore((state) => state.updateTrack);
  const toggleTrackSelection = useCallback(
    (id: number, range = false) => onSelect(id, range ? "range" : "toggle"),
    [onSelect],
  );
  const rateTrack = useCallback(
    (id: number, rating: number) => { void updateTrack(id, { rating }); },
    [updateTrack],
  );
  const selectionMode = useTableStore((state) => state.selectionMode);
  const setSelectionMode = useTableStore((state) => state.setSelectionMode);
  /**
   * Rows are being picked: the mode was asked for (the row menu's 选择, the head's mark), or a
   * batch already exists (⌘/Ctrl-click, Shift-click, select all). The work rail reads the same
   * condition, so the list and its rail are in the mode together. While it holds, every row
   * shows the selection mark in place of its number and a plain click picks or drops the row.
   */
  const selecting = selectionMode || selectedIds.length > 1;
  const downloadTasks = useDownloadStore((state) => state.list);
  const pendingDownloads = useMemo(
    () => downloadTasks.filter((task) => isPendingForFolder(task, filterFolder, indexById)),
    [downloadTasks, filterFolder, indexById],
  );
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const pressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef<number | null>(null);
  /**
   * The second click is the earliest reliable double-click edge. Submit playback there, before
   * selection opens/re-renders the detail pane; the following `dblclick` remains a fallback for
   * synthetic/accessibility dispatches that did not emit the preceding click pair.
   */
  const doubleClickPlaybackRef = useRef<{ trackId: number; at: number } | null>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  const htmlExternalDragScrollUnlockRef = useRef<((settleMs?: number) => void) | null>(null);
  const suppressContextMenuUntilRef = useRef(0);

  // Esc 的语义是取消这一轮批选：菜单、选择标记和选区一起收掉。
  // 全选走 useLibraryClipboard（Cmd/Ctrl+A），不挂在「仅多选时」——
  // 只选了一首时也要能全选。
  useEffect(() => {
    if (!shortcutActive || !selecting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 搜索框用 Esc 清空关键词、输入法用 Esc 取消候选：都不该连带清掉批选。
      if (event.defaultPrevented || event.isComposing || isEditable(event.target)) return;
      event.preventDefault();
      setSelectionMode(false);
      libraryStore.getState().select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutActive, selecting, libraryStore, setSelectionMode]);

  /* ------------------------------------------------ 行右键菜单（多选操作） */
  /**
   * 能不能走系统回收站看**后端**跑在什么系统上——文件在它那台机器上。
   * 安卓/iOS 没有回收站，删除文件改成「点两次确认」的永久删除。
   * 拿不到 platform（Python sidecar 的 health 没这个键）按支持算：开发环境全是桌面。
   */
  const backendPlatform = useAppStore((state) => state.health?.platform ?? "");
  const trashSupported = backendPlatform !== "android" && backendPlatform !== "ios";
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; track: TrackSummary } | null>(null);
  const [menuShareResolution, setMenuShareResolution] = useState<{
    cacheKey: string;
    link: string | null;
    loading: boolean;
  } | null>(null);
  const [pendingMenu, setPendingMenu] = useState<{
    x: number;
    y: number;
    task: DownloadTask;
  } | null>(null);
  /** 永久删除的二次确认：第一次点只是上膛，菜单一关就退膛。 */
  const [armed, setArmed] = useState(false);
  /** 删除失败的原因。表格没有别的报错位置，就近显示在滚动区顶部。 */
  const [notice, setNotice] = useState("");

  useEffect(
    () => () => {
      pointerDragCleanupRef.current?.();
      htmlExternalDragScrollUnlockRef.current?.();
      resizeObserverRef.current?.disconnect();
      // 两个 ref 都要归零：留着已取消的帧号，onScroll 会一直以为还有一帧在排队。
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = 0;
      if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = null;
    },
    [],
  );

  /** 触屏长按整行后启动系统文件拖动；明显纵向移动时优先让列表滚动。 */
  const beginTrackSystemFileDrag = (
    event: React.PointerEvent<HTMLTableRowElement>,
    track: TrackSummary,
  ): boolean => {
    const startFileDrag = window.kdj?.startFileDrag;
    const startLinkDrag = window.kdj?.startLinkDrag;
    const canStart = localExternalDragMode === "share_link" ? startLinkDrag : startFileDrag;
    if (!canStart || event.button !== 0 || event.pointerType === "mouse") return false;
    if ((event.target as HTMLElement).closest("button, input, select, textarea, a, label")) return false;

    pointerDragCleanupRef.current?.();
    const sourceRow = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const sourceScroller = sourceRow.closest<HTMLElement>(".kd-scroll");
    const sourceScrollTop = sourceScroller?.scrollTop ?? 0;
    const sourceScrollLeft = sourceScroller?.scrollLeft ?? 0;
    const dragImage = systemDragPreview(track);
    const shareLink = localExternalDragMode === "share_link"
      ? resolveLocalTrackShareLink(track)
      : Promise.resolve<string | null>(null);
    let timer: number | null = null;
    let launched = false;

    try {
      sourceRow.setPointerCapture(pointerId);
    } catch {
      // WebView 已取消指针时，window 监听仍会完成清理。
    }

    const cleanup = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onEnd, true);
      window.removeEventListener("pointercancel", onEnd, true);
      try {
        if (sourceRow.hasPointerCapture(pointerId)) sourceRow.releasePointerCapture(pointerId);
      } catch {
        // 原生拖动接管触摸序列后 capture 会自动释放。
      }
      if (pointerDragCleanupRef.current === cleanup) pointerDragCleanupRef.current = null;
    };
    const launch = () => {
      if (launched) return;
      launched = true;
      const dragIds = selected.has(track.id) ? [...selectedIds] : [track.id];
      cleanup();
      clearTextSelection();
      cancelPress();
      suppressClickRef.current = track.id;
      suppressContextMenuUntilRef.current = Date.now() + 1_000;
      if (!selected.has(track.id)) onSelect(track.id, "replace");
      const releaseScroll = lockTrackPointerDragScroll(
        sourceScroller,
        sourceScrollTop,
        sourceScrollLeft,
      );
      if (localExternalDragMode === "share_link") setNotice("正在查找分享链接…");
      const files = localExternalDragMode === "file"
        ? libraryStore.getState().resolveSummaries(dragIds)
        : Promise.resolve([] as TrackSummary[]);
      void Promise.all([dragImage, shareLink, files])
        .then(async ([preview, link, rows]) => {
          if (localExternalDragMode === "share_link") {
            if (!link || !startLinkDrag) {
              setNotice("没有找到可确认的歌曲分享链接");
              return;
            }
            await startLinkDrag({
              url: link,
              label: track.title || track.filename,
              text: formatTrackShareText(track, link),
              dragImage: preview || undefined,
              includeArtwork: shareContentMode === "more_info",
            });
            setNotice("");
            return;
          }
          if (!startFileDrag) return;
          if (rows.length !== dragIds.length) throw new Error("部分曲目信息无法读取，请重试");
          const payload = systemFileDragPayload(rows, dragIds, track);
          if (!payload.paths.length) throw new Error("这个曲目没有可拖出的本地文件");
          await startFileDrag({ ...payload, dragImage: preview || undefined });
        })
        .catch((error: unknown) => {
          setNotice(`无法拖出${localExternalDragMode === "share_link" ? "分享链接" : "文件"}：${(error as Error).message}`);
        })
        .finally(() => releaseScroll(EXTERNAL_DRAG_SCROLL_SETTLE_MS));
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const distance = Math.hypot(move.clientX - startX, move.clientY - startY);
      if (distance > 10) {
        // 手指明显移动就是滚列表，不抢成系统拖动。
        cleanup();
      }
    };
    const onEnd = (end: PointerEvent) => {
      if (end.pointerId === pointerId) cleanup();
    };

    pointerDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onEnd, true);
    window.addEventListener("pointercancel", onEnd, true);
    timer = window.setTimeout(launch, 420);
    return true;
  };

  /**
   * 本地曲目不用 WebKit 的原生 draggable：它经常把按住移动解释成框选/多选，
   * 或只发 dragstart 不发 drop。这里直接跟踪指针，松手时按坐标命中文件夹。
   */
  const beginTrackPointerDrag = (event: React.PointerEvent<HTMLTableRowElement>, track: TrackSummary) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, input, select, textarea, a, label")) return;
    // Windows 的 URL 数据拖放交给 WebView2 原生 HTML5 链路；文件与 macOS 链接仍用
    // pointer 状态机，保证应用内的文件夹 / Deck / 封面落点不受影响。
    if (
      localExternalDragMode === "share_link"
      && !window.kdj?.startLinkDrag
      && window.kdj?.platform === "win32"
    ) return;

    pointerDragCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const ids = selected.has(track.id) ? [...selectedIds] : [track.id];
    const startFileDrag = window.kdj?.startFileDrag;
    const startLinkDrag = window.kdj?.startLinkDrag;
    const dragImage = systemDragPreview(track);
    const shareLink = localExternalDragMode === "share_link"
      ? resolveLocalTrackShareLink(track)
      : Promise.resolve<string | null>(null);
    const sourceRow = event.currentTarget;
    const sourceScroller = sourceRow.closest<HTMLElement>(".kd-scroll");
    const sourceScrollTop = sourceScroller?.scrollTop ?? 0;
    const sourceScrollLeft = sourceScroller?.scrollLeft ?? 0;
    const previousUserSelect = sourceRow.style.userSelect;
    sourceRow.style.userSelect = "none";
    let dragging = false;
    let ghost: PointerDragGhost | null = null;
    let unlockScroll: (settleMs?: number) => void = () => undefined;

    try {
      sourceRow.setPointerCapture(pointerId);
    } catch {
      // WebKit 若已经开始取消该指针，window capture 监听仍可完成收尾。
    }

    const blockDragScroll = (scrollEvent: Event) => {
      if (dragging) scrollEvent.preventDefault();
    };

    const clearTargets = () => {
      paintWorkshopDrop();
      document
        .querySelectorAll<HTMLElement>("[data-kd-pointer-track-over]")
        .forEach((node) => node.removeAttribute("data-kd-pointer-track-over"));
    };
    const hitAt = (x: number, y: number) => document.elementFromPoint(x, y) as HTMLElement | null;
    const paintTarget = (x: number, y: number) => {
      clearTargets();
      if (paintWorkshopDrop(x, y)) return;
      const folder = folderDropElementAt(x, y);
      if (folder) {
        folder.setAttribute("data-kd-pointer-track-over", "folder");
        return;
      }
      const splitDeck = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[${TRACK_DECK_DROP_TARGET_ATTR}="${TRACK_DECK_SPLIT_DROP_TARGET}"]`,
        ),
      ).find((target) => {
        const rect = target.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      });
      if (splitDeck) {
        const rect = splitDeck.getBoundingClientRect();
        splitDeck.setAttribute(
          "data-kd-pointer-track-over",
          x < rect.left + rect.width / 2 ? "deck-left" : "deck-right",
        );
        return;
      }
      const side = trackDeckDropSideAt(x, y);
      if (side !== null) {
        document
          .querySelectorAll<HTMLElement>(
            "[" + TRACK_DECK_DROP_TARGET_ATTR + "]",
          )
          .forEach((target) => {
            if (target.getAttribute(TRACK_DECK_DROP_TARGET_ATTR) === String(side)) {
              target.setAttribute("data-kd-pointer-track-over", "deck");
            }
          });
        return;
      }
      const hit = hitAt(x, y);
      const sampler = hit?.closest<HTMLElement>(`[${TRACK_SAMPLER_DROP_TARGET_ATTR}]`);
      if (sampler) {
        sampler.setAttribute("data-kd-pointer-track-over", "sampler");
        return;
      }
      const trash = hit?.closest<HTMLElement>("[data-kd-track-trash-target]");
      if (trash) {
        trash.setAttribute("data-kd-pointer-track-over", "trash");
        return;
      }
      const cover = hit?.closest<HTMLElement>(`[${TRACK_COVER_DROP_TARGET_ATTR}]`);
      if (cover) {
        cover.setAttribute("data-kd-pointer-track-over", "cover");
      }
    };
    const cleanup = (preserveScrollLock = false) => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("wheel", blockDragScroll, true);
      clearTargets();
      if (!preserveScrollLock) {
        unlockScroll();
        unlockScroll = () => undefined;
      }
      ghost?.remove();
      ghost = null;
      sourceRow.style.userSelect = previousUserSelect;
      try {
        if (sourceRow.hasPointerCapture(pointerId)) sourceRow.releasePointerCapture(pointerId);
      } catch {
        // 指针取消或虚拟行卸载后 capture 可能已由 WebKit 自动释放。
      }
      delete document.body.dataset.kdTrackPointerDragging;
      delete document.body.dataset.kdTrackPointerSource;
      pointerDragCleanupRef.current = null;
    };
    const activate = (x: number, y: number) => {
      dragging = true;
      clearTextSelection();
      cancelPress();
      suppressClickRef.current = track.id;
      if (!selected.has(track.id)) onSelect(track.id, "replace");
      announceTrackDrag(ids);
      document.body.dataset.kdTrackPointerDragging = "true";
      document.body.dataset.kdTrackPointerSource = "local";
      unlockScroll = lockTrackPointerDragScroll(
        sourceScroller,
        sourceScrollTop,
        sourceScrollLeft,
      );
      window.addEventListener("wheel", blockDragScroll, { capture: true, passive: false });
      ghost = pointerDragGhost({
        title: track.title || track.filename,
        count: ids.length,
        coverFrom: sourceRow,
        glyph: isVideoTrack(track.format) ? "video" : "song",
      }, x, y);
      paintTarget(x, y);
    };
    const launchSystemExternalDrag = () => {
      if (localExternalDragMode === "share_link" ? !startLinkDrag : !startFileDrag) return false;
      const dragIds = selected.has(track.id) ? [...selectedIds] : [track.id];
      const releaseScroll = unlockScroll;
      unlockScroll = () => undefined;
      cleanup(true);
      if (dragging) finishTrackDrop();
      suppressClickRef.current = track.id;
      suppressContextMenuUntilRef.current = Date.now() + 1_000;
      if (localExternalDragMode === "share_link") setNotice("正在查找分享链接…");
      const files = localExternalDragMode === "file"
        ? libraryStore.getState().resolveSummaries(dragIds)
        : Promise.resolve([] as TrackSummary[]);
      void Promise.all([dragImage, shareLink, files])
        .then(async ([preview, link, rows]) => {
          if (localExternalDragMode === "share_link") {
            if (!link || !startLinkDrag) {
              setNotice("没有找到可确认的歌曲分享链接");
              return;
            }
            await startLinkDrag({
              url: link,
              label: track.title || track.filename,
              text: formatTrackShareText(track, link),
              dragImage: preview || undefined,
              includeArtwork: shareContentMode === "more_info",
            });
            setNotice("");
            return;
          }
          if (!startFileDrag) return;
          if (rows.length !== dragIds.length) throw new Error("部分曲目信息无法读取，请重试");
          const payload = systemFileDragPayload(rows, dragIds, track);
          if (!payload.paths.length) throw new Error("这个曲目没有可拖出的本地文件");
          await startFileDrag({ ...payload, dragImage: preview || undefined });
        })
        .catch((error: unknown) => {
          setNotice(`无法拖出${localExternalDragMode === "share_link" ? "分享链接" : "文件"}：${(error as Error).message}`);
        })
        .finally(() => releaseScroll(EXTERNAL_DRAG_SCROLL_SETTLE_MS));
      return true;
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const distance = Math.hypot(move.clientX - startX, move.clientY - startY);
      if (!dragging && distance < 5) return;
      move.preventDefault();
      if (!dragging) activate(move.clientX, move.clientY);
      // 窗口内继续沿用 KDJ 的 Deck / 文件夹 / 废纸篓等落点；指针越过应用边缘时，
      // 无缝把同一批真实文件交给 Finder / Explorer。这样整行都是拖动源，也不牺牲内部拖放。
      // 在真正离开 WebView 前几像素就接管；部分系统离窗后不会再派发 pointermove。
      const edgeThreshold = 6;
      const outsideWindow =
        move.clientX <= edgeThreshold
        || move.clientY <= edgeThreshold
        || move.clientX >= window.innerWidth - edgeThreshold
        || move.clientY >= window.innerHeight - edgeThreshold;
      if (outsideWindow && launchSystemExternalDrag()) return;
      ghost?.move(move.clientX, move.clientY);
      paintTarget(move.clientX, move.clientY);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      const folder = folderDropElementAt(up.clientX, up.clientY);
      const hit = hitAt(up.clientX, up.clientY);
      const deckSide = trackDeckDropSideAt(up.clientX, up.clientY);
      const sampler = hit?.closest<HTMLElement>(`[${TRACK_SAMPLER_DROP_TARGET_ATTR}]`);
      const samplerSlot = sampler ? Number(sampler.getAttribute(TRACK_SAMPLER_DROP_TARGET_ATTR)) : NaN;
      const trash = hit?.closest<HTMLElement>("[data-kd-track-trash-target]");
      const cover = hit?.closest<HTMLElement>(`[${TRACK_COVER_DROP_TARGET_ATTR}]`);
      const coverTrackId = cover ? Number(cover.dataset.kdTrackId) : NaN;
      cleanup();
      if (!dragging) return;
      up.preventDefault();
      if (dropWorkshopTracks(up.clientX, up.clientY)) return;

      if (deckSide !== null) {
        dispatchTrackDeckDrop(ids, deckSide);
        finishTrackDrop();
        return;
      }

      if (Number.isInteger(samplerSlot) && samplerSlot >= 0 && samplerSlot < 8) {
        dispatchTrackSamplerDrop(ids, samplerSlot);
        finishTrackDrop();
        return;
      }

      if (folder) {
        const dest = folder.getAttribute(FOLDER_DROP_PATH_ATTR)?.trim() ?? "";
        const claimed = claimActiveTrackDragIds();
        if (!dest || claimed.length === 0) return;
        const op = resolveLibraryPasteOp({ forceMove: up.altKey });
        void libraryStore
          .getState()
          .applyFolderOp(claimed, dest, op)
          .then((result) => {
            const failed = Object.keys(result.errors).length;
            if (failed > 0) {
              const verb = op === "move" ? "移动" : "复制";
              setNotice(`已${verb} ${result.track_ids.length} 首，${failed} 首失败`);
            }
          })
          .catch((error: unknown) => setNotice(`操作失败：${(error as Error).message}`));
        return;
      }
      if (trash) {
        window.dispatchEvent(
          new CustomEvent<TrackDragDetail>(TRACK_TRASH_DROP_EVENT, { detail: { ids } }),
        );
        finishTrackDrop();
        return;
      }
      if (cover && Number.isFinite(coverTrackId)) {
        // 封面框本身可点击选图；先挡掉拖拽结束后的合成 click，避免误弹文件选择器。
        suppressCoverClickAfterTrackDrop();
        dispatchTrackCoverDrop(ids, coverTrackId);
        finishTrackDrop();
        return;
      }
      finishTrackDrop();
    };
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId !== pointerId) return;
      cleanup();
      if (dragging) finishTrackDrop();
    };

    pointerDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
  };

  const cancelPress = () => {
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
    pressTimerRef.current = null;
  };
  const beginLongPress = (track: TrackSummary, x: number, y: number) => {
    cancelPress();
    pressTimerRef.current = window.setTimeout(() => {
      setRowMenu({ x, y, track });
      suppressClickRef.current = track.id;
      pressTimerRef.current = null;
    }, 480);
  };

  // 菜单开合都退膛：残留的"已确认"状态比误删只差一次点击
  useEffect(() => setArmed(false), [rowMenu]);

  // 老版本入库的 B 站视频没有 BV 号，SoundCloud 下载只存了曲目 id、没有页面地址。菜单打开时
  // 先找回，用户真正点击复制时链接已经就绪，仍处在一次明确的复制手势里。
  useEffect(() => {
    setMenuShareResolution(null);
    if (
      !rowMenu
      || trackShareLink(rowMenu.track)
      || !(soundCloudTrackId(rowMenu.track)
        || (isVideoTrack(rowMenu.track.format) && bilibiliVideoShareSearchQuery(rowMenu.track)))
    ) {
      return;
    }
    let active = true;
    const cacheKey = localTrackShareCacheKey(rowMenu.track);
    setMenuShareResolution({ cacheKey, link: null, loading: true });
    void resolveLocalTrackShareLink(rowMenu.track).then((link) => {
      if (active) setMenuShareResolution({ cacheKey, link, loading: false });
    });
    return () => {
      active = false;
    };
  }, [rowMenu]);

  /** 菜单操作作用的曲目：右键落在选区里 = 整批，落在选区外的行 = 只有它。 */
  const menuIds = rowMenu
    ? selected.has(rowMenu.track.id)
      ? selectedIds
      : [rowMenu.track.id]
    : [];
  const rowShareCacheKey = rowMenu ? localTrackShareCacheKey(rowMenu.track) : "";
  const directRowShareLink = rowMenu ? trackShareLink(rowMenu.track) : null;
  const lookedUpShare =
    rowMenu && menuShareResolution?.cacheKey === rowShareCacheKey
      ? menuShareResolution
      : null;
  const rowShareLink = directRowShareLink ?? lookedUpShare?.link ?? null;
  const rowSameNameQuery = rowMenu && !isVideoTrack(rowMenu.track.format)
    ? trackShareSearchQuery(rowMenu.track)
    : "";
  const copyTrackShareLink = async (track: TrackSummary, link: string | null) => {
    setRowMenu(null);
    if (!link) return;
    await copyShareContent(
      formatTrackShareText(track, link),
      shareContentMode,
      () => api.coverBlob(track.id),
    );
  };
  const playFromTable = (track: TrackSummary) => {
    if (isImageTrack(track.format)) return;
    // 摘要已经包含换源所需的全部标量。播放意图必须在当前点击栈同步发出；
    // 详情、拍点数组、标签和备注由选中态异步补齐，不能挡在音频前面。
    playTrack(track);
  };

  const deleteWithNotice = (ids: number[], file: FileDisposalMode) => {
    void removeTracks(ids, file)
      .then((errors) => {
        const reasons = Object.values(errors);
        if (reasons.length > 0) {
          setNotice(`${reasons.length} 首没删成：${reasons[0]}`);
        }
      })
      .catch((error: unknown) => setNotice((error as Error).message));
  };

  const runDelete = (file: FileDisposalMode) => {
    const ids = menuIds;
    setRowMenu(null);
    deleteWithNotice(ids, file);
  };

  // Del / ⌘⌫（Windows 上 Ctrl⌫）= 把选中的曲目移到回收站。
  // 能反悔的操作才配快捷键——没有回收站的平台（安卓）不给：
  // 永久删除必须经过右键菜单里"点两次"的确认，一颗按键太容易误触。
  // 裸 Backspace 故意不接：它离拼写修正太近了。
  useEffect(() => {
    if (!trashSupported) return;
    const onKey = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      if (!shouldHandleWorkspaceDelete(
        shortcutActive,
        "local",
        event.key,
        event.metaKey || event.ctrlKey,
      )) return;
      const ids = libraryStore.getState().selectedIds;
      if (ids.length === 0) return;
      event.preventDefault();
      deleteWithNotice(ids, "trash");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // deleteWithNotice 闭包里只有稳定的 store action 和 setNotice，不用进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortcutActive, trashSupported]);

  useEffect(() => {
    if (!shortcutActive) return;
    const onTrashDrop = (event: Event) => {
      const ids = (event as CustomEvent<TrackDragDetail>).detail?.ids ?? [];
      if (ids.length === 0) return;
      if (!trashSupported) {
        setNotice("这个系统没有可恢复的废纸篓，不能通过拖放删除文件");
        return;
      }
      deleteWithNotice(ids, "trash");
    };
    window.addEventListener(TRACK_TRASH_DROP_EVENT, onTrashDrop);
    return () => window.removeEventListener(TRACK_TRASH_DROP_EVENT, onTrashDrop);
    // deleteWithNotice 只封装稳定的 store action；不让每次渲染重挂全局事件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trashSupported, shortcutActive]);

  /* ------------------------------------------------ 回到正在播的那首 */
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const initialSessionRef = useRef(persistentSession ? readWorkspaceSession().local : { scrollTop: 0, topVisibleTrackId: null, rowOffset: 0 });
  const scrollRestoreDoneRef = useRef(false);
  const anchorRef = useRef({ id: null as number | null, index: 0, offset: 0 });
  const previousQueryRef = useRef(queryVersion);
  const [headerH, setHeaderH] = useState(28);
  const headerHRef = useRef(28);
  const [rootFont, setRootFont] = useState(16);
  const [view, setView] = useState<LibraryView>(REST_VIEW);
  const viewRef = useRef(view);
  viewRef.current = view;
  const paceRef = useRef(LIBRARY_REST_PACE);
  /** 上一次滚动采样的时刻；0 表示停着。 */
  const scrollSampleAtRef = useRef(0);
  /** 替身行：快滚时代替真实的行（见 libraryStandIns）。 */
  const standInLayerRef = useRef<HTMLDivElement | null>(null);
  const standInsRef = useRef<LibraryStandIns | null>(null);
  /** 表格自己渲染出来的行范围，以及替身行上一帧盖住的范围。 */
  const renderedRowsRef = useRef({ start: 0, end: 0 });
  const coveredRowsRef = useRef<(readonly [number, number])[]>([]);
  /** 行的到场动画（见 listArrival）。 */
  const arrivalRef = useRef<ListArrival | null>(null);
  /**
   * 行提交之后要开始的到场动画（见 ArrivalDue）。
   */
  const arrivalDueRef = useRef<ArrivalDue | null>(null);
  /** 正在进行的到场动画涉及的行号，按出场先后；期间新挂载的行（摘要刚到）按原位加入。 */
  const arrivalRowsRef = useRef<number[]>([]);
  const visibleRef = useRef(visible);
  /** 快滚途中上一次把加载重心挪到的行。 */
  const flightDemandRowRef = useRef(-1);
  /** 这一次滚动的统计，停稳时写进原生日志。 */
  const scrollTraceRef = useRef({ startedAt: 0, from: 0, frames: 0, slow: 0, gapMax: 0, travelMax: 0, speedMax: 0, bare: 0, bareMax: 0, held: 0 });
  const [rowH, setRowH] = useState(FALLBACK_ROW_H);
  const rowHRef = useRef(FALLBACK_ROW_H);
  /** 横向滚动不能进入虚拟列表更新链；否则拖底部横滚条时每帧重渲染整张可视表。 */
  const scrollTopRef = useRef(0);
  const scrollRafRef = useRef(0);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const coverLane = useRef<CoverLane>({ start: 0, end: 0, fast: false, recovering: false, waiting: new Set() }).current;
  const rowRecovery = useMemo(() => createLibraryRowRecovery(() => {
    const box = scrollerRef.current;
    const top = Math.max(0, box?.scrollTop ?? 0);
    return {
      first: Math.floor(top / rowHRef.current) - pendingCountRef.current,
      end: Math.ceil((top + Math.max(rowHRef.current, (box?.clientHeight ?? 0) - headerHRef.current)) / rowHRef.current) - pendingCountRef.current,
      moving: scrollSampleAtRef.current !== 0,
      visible: visibleRef.current && Boolean(box?.clientHeight),
    };
  }, (rows, direction) => arrivalRef.current?.reveal(rows, direction < 0 ? "above" : "below"), () => {
    coverLane.recovering = false;
    for (const waiting of coverLane.waiting) waiting.lease.setPriority(coverLanePriority(coverLane, waiting.index));
  }), [coverLane]);
  useLayoutEffect(() => () => rowRecovery.destroy(), [rowRecovery]);
  const refreshCoverLane = useCallback(() => {
    const box = scrollerRef.current;
    const top = Math.max(0, box?.scrollTop ?? 0);
    const start = Math.floor(top / rowHRef.current) - pendingCountRef.current;
    const end = Math.ceil((top + Math.max(rowHRef.current, (box?.clientHeight ?? 0) - headerHRef.current)) / rowHRef.current) - pendingCountRef.current;
    const fast = paceRef.current.fast || !visibleRef.current;
    const recovering = rowRecovery.deferred();
    if (start === coverLane.start && end === coverLane.end && fast === coverLane.fast && recovering === coverLane.recovering) return;
    Object.assign(coverLane, { start, end, fast, recovering });
    for (const waiting of coverLane.waiting) waiting.lease.setPriority(coverLanePriority(coverLane, waiting.index));
  }, [coverLane, rowRecovery]);
  /** 滚动容器 ref：身份必须稳定（见 JSX 处的注释）。值没变就不 setState，
      否则 ResizeObserver 的初次回调会和自己触发的重渲染互相喂食。 */
  const trackScrollerRef = useCallback((el: HTMLDivElement | null) => {
    scrollerRef.current = el;
    scrollTopRef.current = el?.scrollTop ?? 0;
    if (persistentSession) observeTrackScroller(el);
    // 视口高度决定渲染窗口：面板拖宽拖窄、窗口缩放都要重算。
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (el) {
      const updateView = () =>
        setView((current) => {
          const top = libraryWindowTop(el.scrollTop, rowHRef.current);
          const height = el.clientHeight;
          return current.top === top && current.height === height ? current : { top, height };
        });
      updateView();
      // 容器变宽变窄会改列宽：替身行要重新量一遍真实的行。
      const observer = new ResizeObserver(() => { standInsRef.current?.invalidate(); updateView(); });
      observer.observe(el);
      resizeObserverRef.current = observer;
    }
  }, []);
  // centerSelected 挂在 [] 上，靠 ref 拿最新值，不为它重挂全局事件
  const selectedIdRef = useRef(selectedId);
  // 只取 id：播放进度之类的变化不该让整张表重渲染
  const playingId = useSyncExternalStore(subscribePlayingTrack, () => getPlayingTrack()?.id ?? null, () => null);
  const pendingCountRef = useRef(0);
  useEffect(() => {
    const scrollTrackIntoCenter = (trackId: number | null | undefined, attemptsLeft = 40) => {
      const id = trackId ?? selectedIdRef.current;
      if (id == null) return;

      const box = scrollerRef.current;
      if (!box) {
        if (attemptsLeft > 0) {
          requestAnimationFrame(() => scrollTrackIntoCenter(id, attemptsLeft - 1));
        }
        return;
      }

      const index = libraryStore.getState().indexById.get(id) ?? -1;
      if (index < 0) {
        if (attemptsLeft > 0) {
          requestAnimationFrame(() => scrollTrackIntoCenter(id, attemptsLeft - 1));
        }
        return;
      }

      const row = box.querySelector(`tr[data-kd-track-id="${id}"]`);
      if (row) {
        row.scrollIntoView({ block: "center" });
        return;
      }

      const height = rowHRef.current;
      if (height <= 0) {
        if (attemptsLeft > 0) {
          requestAnimationFrame(() => scrollTrackIntoCenter(id, attemptsLeft - 1));
        }
        return;
      }

      // 虚拟滚动：先把滚动条推到目标附近，等下一帧行挂进 DOM 再精确居中。
      const pending = pendingCountRef.current;
      box.scrollTop = Math.max(
        0,
        pending * height + index * height - (box.clientHeight - height) / 2,
      );
      if (attemptsLeft > 0) {
        requestAnimationFrame(() => scrollTrackIntoCenter(id, attemptsLeft - 1));
      }
    };

    // 有精确的关闭前滚动位置时优先恢复它；没有存档才按选中行居中。

    const onDetail = (event: Event) => {
      const detail = (event as CustomEvent<DetailEventDetail>).detail;
      const explicitLocate = detail?.source === "locate-playing" || detail?.source === "player-deck";
      if (explicitLocate ? !persistentSession : !shortcutActiveRef.current) return;
      requestAnimationFrame(() => {
        scrollTrackIntoCenter(detail?.trackId ?? selectedIdRef.current);
      });
    };
    window.addEventListener(DETAIL_EVENT, onDetail);
    return () => window.removeEventListener(DETAIL_EVENT, onDetail);
  }, []);

  /* ---------------------------------------------------- 列拖排 / 显隐 / 列宽 */
  const [colPrefs, setColPrefs] = useState(loadColumnPrefs);
  /** 正在拖的列头 id / 悬停到哪个列头上（画落点竖线用）。 */
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  /** 右键列头弹出的「选列」菜单的位置。null = 没开。 */
  const [colMenu, setColMenu] = useState<{ x: number; y: number } | null>(null);
  /** 正在拖列宽的列 key；拖的时候禁掉列头换序，松手后压掉那一次排序 click。 */
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const suppressSortClickRef = useRef(false);
  const suppressNextSortClick = () => {
    suppressSortClickRef.current = true;
    // pointerup 之后浏览器会同步补发 click；下一轮任务仍没消费就自动解锁，
    // 避免拖到另一列时 click 没落在源表头，导致下次正常点排序被吞掉。
    window.setTimeout(() => {
      suppressSortClickRef.current = false;
    }, 0);
  };
  const colPrefsRef = useRef(colPrefs);
  colPrefsRef.current = colPrefs;

  const saveColPrefs = (next: ColumnPrefs) => {
    const normalized = saveTableColumnPrefs(COLUMN_PREFS_KEY, next, COLUMN_PREFS_SCHEMA);
    colPrefsRef.current = normalized;
    setColPrefs(normalized);
  };

  // 普通 pointerup 会即时落盘；pagehide / HMR 卸载再兜底一次，避免开发刷新或
  // 指针被 WebView 取消时只留下 React state、下次挂载却读到旧宽度。
  useEffect(() => {
    const persist = () => {
      saveTableColumnPrefs(COLUMN_PREFS_KEY, colPrefsRef.current, COLUMN_PREFS_SCHEMA);
    };
    window.addEventListener("pagehide", persist);
    return () => {
      window.removeEventListener("pagehide", persist);
      persist();
    };
  }, []);

  const widthFor = (key: string, fallback: string) => colPrefs.widths[key] ?? fallback;

  const beginColumnResize = (key: string, event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const th = event.currentTarget.parentElement;
    if (!th) return;
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    const minPx = remStringToPx(COLUMN_MIN_WIDTH[key] ?? "2.8rem");
    const maxPx = remStringToPx(COLUMN_MAX_WIDTH);
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
        // 同步写 ref：松手落盘时不能等下一次渲染才拿到最新宽度。
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
      suppressNextSortClick();
      // 松手时把最新宽度落盘；拖动过程只 setState，避免每个像素写 localStorage
      saveTableColumnPrefs(COLUMN_PREFS_KEY, colPrefsRef.current, COLUMN_PREFS_SCHEMA);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const orderedColumns = useMemo(
    () => orderByPrefs(COLUMNS, colPrefs.order),
    [colPrefs.order],
  );
  const colIds = useMemo(() => orderedColumns.map((column) => column.key), [orderedColumns]);
  const configuredVisibleColumns = useMemo(
    () => orderedColumns.filter((column) => !colPrefs.hidden.includes(column.key)),
    [colPrefs.hidden, orderedColumns],
  );
  const visibleColumns = useMemo(
    () => fitWidth ? fitDjTrackColumns(configuredVisibleColumns) : configuredVisibleColumns,
    [configuredVisibleColumns, fitWidth],
  );
  /** 只有曲库行需要序号列；纯待下载占位时不占左侧空白。 */
  const showIndexCol = total > 0;
  const configuredIndexWidth = widthFor(INDEX_COL_KEY, INDEX_DEFAULT_WIDTH);
  // Four/five-digit row numbers must stay legible, including while they are the only content.
  const indexWidth = fitWidth ? "10%" : `${Math.max(
    Number.parseFloat(configuredIndexWidth) * (configuredIndexWidth.endsWith("px") ? 1 : rootFont),
    (Math.max(1.75, String(total).length * 0.55 + 0.7)) * rootFont,
  )}px`;
  const displayWidthFor = (column: Column) => fitWidth
    ? DJ_TRACK_TABLE_COLUMN_WIDTHS[column.key as keyof typeof DJ_TRACK_TABLE_COLUMN_WIDTHS]
    : widthFor(column.key, column.width ?? "4rem");
  const tableColSpan = visibleColumns.length + (showIndexCol ? 1 : 0) + 1;
  const tableMinWidthPx = useMemo(() => {
    const px = (value: string) => Number.parseFloat(value) * (value.endsWith("px") ? 1 : rootFont);
    return fitWidth ? "100%" : (showIndexCol ? px(indexWidth) : 0)
      + visibleColumns.reduce((sum, column) => sum + px(displayWidthFor(column)), 0);
  }, [fitWidth, showIndexCol, indexWidth, visibleColumns, colPrefs.widths, rootFont]);

  /* ---------------------------------------------------- 虚拟滚动 */
  /**
   * 曲库上千首时把每一行都挂进 DOM 是滚动卡顿和空白的根源：
   * 每次滚动都要重排上千个带封面的格子，懒加载的图片追不上滚动就留出白块。
   * 行高恒定（td 全是 nowrap + 固定 --kd-row-h，内容撑不高），
   * 所以只渲染视口附近的一小段，上下各垫一根占位行把总高度撑住——
   * 滚动条位置、行序号、拖放落点都和全量渲染时一致。
   */
  selectedIdRef.current = selectedId;
  pendingCountRef.current = pendingDownloads.length;

  /**
   * 给滚动容器此刻的位置画上编号空行（见 libraryStandIns），并记下它们和真实
   * 的行一起盖住了哪些行。`direction` 是快滚的去向，替身行的余量大部分放在前方；0 表示表格自己
   * 在造行，这时只补视口里缺的行（平时没有），不占画布。
   */
  const paintStandIns = useCallback((direction: -1 | 0 | 1) => {
    const standIns = standInsRef.current;
    if (!standIns) return;
    const pending = pendingCountRef.current;
    const pace = paceRef.current;
    coveredRowsRef.current = standIns.update({
      rowHeight: rowHRef.current, count: libraryStore.getState().orderedIds.length + pending, first: pending, direction,
      // 甩动在平滑后的速度跟上之前就已经是全速了：两者取大。
      speed: Math.max(Math.abs(pace.speed), Math.abs(pace.instant)),
      windowStart: renderedRowsRef.current.start, windowEnd: renderedRowsRef.current.end,
    });
  }, [libraryStore]);

  /** 行号（待下载行在前，曲目在后）对应的、表格此刻渲染出来的行；不在渲染窗口里的是空位。 */
  const mountedRows = useCallback((rows: readonly number[]) => {
    const body = scrollerRef.current?.querySelector<HTMLElement>("table.kd-table > tbody");
    if (!body) return [];
    const { start, end } = renderedRowsRef.current;
    // tbody 的子元素依次是：上占位行（有的话）、渲染窗口里的每一行、下占位行。
    const offset = body.firstElementChild?.hasAttribute("data-spacer") ? 1 : 0;
    return rows.map((row) => {
      const element = row >= start && row < end ? body.children[offset + row - start] as HTMLElement | undefined : undefined;
      return element?.hasAttribute("data-loading-track") ? undefined : element;
    });
  }, []);

  /** 列表被呈现：只让已经有真实内容的可视行到场，空位等内容就绪后再浮现。 */
  const startArrival = useCallback(() => {
    const box = scrollerRef.current;
    const arrival = arrivalRef.current;
    if (!box || !arrival) return false;
    const rowHeight = rowHRef.current;
    const top = Math.max(0, box.scrollTop);
    const first = Math.floor(top / rowHeight);
    const last = Math.ceil((top + Math.max(rowHeight, box.clientHeight - headerHRef.current)) / rowHeight);
    const { start, end } = renderedRowsRef.current;
    const from = Math.max(start, first);
    const to = Math.min(end, last);
    const rows: number[] = [];
    for (let row = from; row < to; row += 1) rows.push(row);
    arrivalRowsRef.current = rows;
    arrival.start("list", "below", mountedRows(rows));
    return arrival.gesture() !== null;
  }, [mountedRows]);

  /**
   * 把表格对齐到滚动容器此刻的位置。滚动由 WebView 的滚动线程执行，页面拿到位置时它已经在
   * 屏幕上了，所以：
   * - 阅读速度的滚动：在这一帧内提交对应的行（flushSync），每晚一帧露出的就是空白；
   * - 快滚：冻结窗口，只预绘制清晰编号。减速时同步换入廉价行壳，再由 rowRecovery 每帧
   *   补入少量真实内容；动画跟随实际提交，而不是一次造好后仅延迟显示。
   * 只在 React 之外（动画帧）调用；`now` 是这一帧的时间戳。
   */
  const syncWindow = useCallback((now: number) => {
    const node = scrollerRef.current;
    if (!node) return;
    const rowHeight = rowHRef.current;
    const pending = pendingCountRef.current;
    const ids = libraryStore.getState().orderedIds;
    const height = node.clientHeight;
    const listEnd = Math.max(0, (ids.length + pending) * rowHeight + headerHRef.current - height);
    const reach = Math.max(0, node.scrollHeight - height);
    // 列表变短而 DOM 还没跟上时，容器能滚到列表之外：拉回来。只在 DOM 确实更长时才写——到边后的
    // 回弹同样会报出范围之外的位置，那是 WebView 自己的动画，写回去就是和它打架。
    if (node.scrollTop > listEnd && reach > listEnd + 1) node.scrollTop = listEnd;
    // 回弹不算滚动：位置按可滚范围取，到边之后不再变化，表格和替身行都不动。
    const top = Math.min(Math.min(listEnd, reach), Math.max(0, node.scrollTop));
    if (top !== scrollTopRef.current) {
      const travel = top - scrollTopRef.current;
      // 停着之后的第一帧没有上一个时刻可比，按一帧算。
      const elapsed = scrollSampleAtRef.current ? now - scrollSampleAtRef.current : 16;
      paceRef.current = libraryScrollPace(paceRef.current, travel, elapsed, height);
      const trace = scrollTraceRef.current;
      if (!scrollSampleAtRef.current) Object.assign(trace, { startedAt: now, from: scrollTopRef.current, frames: 0, slow: 0, gapMax: 0, travelMax: 0, speedMax: 0, bare: 0, bareMax: 0, held: 0 });
      // 这一帧开始时，新视口里有多少行既没有真实的行也没有替身行：滚动线程已经把它们露出来了。
      const first = Math.floor(top / rowHeight);
      const bare = standInGap(coveredRowsRef.current, Math.max(pending, first),
        Math.min(ids.length + pending, Math.ceil((top + height - headerHRef.current) / rowHeight)));
      trace.frames += 1;
      if (elapsed > 50) trace.slow += 1;
      trace.gapMax = Math.max(trace.gapMax, elapsed);
      trace.travelMax = Math.max(trace.travelMax, Math.abs(travel));
      trace.speedMax = Math.max(trace.speedMax, Math.abs(paceRef.current.speed));
      if (bare) { trace.bare += 1; trace.bareMax = Math.max(trace.bareMax, bare); }
      scrollSampleAtRef.current = now;
      scrollTopRef.current = top;
      const index = Math.max(0, first - pending);
      anchorRef.current = { id: ids[index] ?? null, index, offset: top % rowHeight };
      if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = window.setTimeout(() => {
        scrollIdleTimerRef.current = null;
        // 停稳：造出这里的行。
        paceRef.current = LIBRARY_REST_PACE;
        scrollSampleAtRef.current = 0;
        const box = scrollerRef.current;
        if (box) {
          const rest: LibraryView = { top: libraryWindowTop(box.scrollTop, rowHRef.current), height: box.clientHeight };
          if (sameLibraryView(viewRef.current, rest)) paintStandIns(0);
          else {
            // 此处只同步空行壳；真实内容由 rowRecovery 分帧补入。
            flushSync(() => setView(rest));
          }
          rowRecovery.resume();
          refreshCoverLane();
          const done = scrollTraceRef.current;
          const painting = standInsRef.current?.takeStats();
          if (import.meta.env.DEV && Math.abs(box.scrollTop - done.from) >= TRACED_SCROLL_SCREENS * box.clientHeight) {
            tracePlayback("library-scroll", { ms: Math.round(performance.now() - done.startedAt), px: Math.round(box.scrollTop - done.from),
              frames: done.frames, slow: done.slow, gapMax: Math.round(done.gapMax), travelMax: Math.round(done.travelMax),
              speedMax: Math.round(done.speedMax * 1000), held: done.held, bare: done.bare, bareMax: done.bareMax,
              standIns: standInsRef.current?.ready() ? 1 : 0, tiles: painting?.tiles ?? 0,
              paintMs: Math.round(painting?.ms ?? 0), paintMax: Math.round(painting?.worst ?? 0) });
          }
        }
        if (!persistentSession) return;
        const anchor = anchorRef.current;
        updateLocalWorkspaceSession({ scrollTop: scrollTopRef.current, topVisibleTrackId: anchor.id, rowOffset: anchor.offset });
      }, SCROLL_REST_MS);
    }
    const pace = paceRef.current;
    refreshCoverLane();
    // 快滚且替身行可用：表格的行原地不动，不进 React。
    if (pace.fast && standInsRef.current?.ready()) {
      scrollTraceRef.current.held += 1;
      const direction = (pace.instant || pace.speed) < 0 ? -1 : 1;
      rowRecovery.hold(direction);
      // 到场动画还没做完就又甩了出去：行就地站好，不带着动画被滚走。
      arrivalDueRef.current = null;
      if (arrivalRef.current?.gesture()) arrivalRef.current.stop();
      // 表格不动，就没有人告诉数据层眼前是哪里：后台补齐还在围着起飞的位置转，眼前只有
      // 编号。隔一段路挪一次加载重心。
      const row = Math.max(0, Math.floor(top / rowHeight) - pending);
      if (Math.abs(row - flightDemandRowRef.current) >= FLIGHT_DEMAND_ROWS) {
        flightDemandRowRef.current = row;
        const screen = Math.ceil(height / rowHeight);
        const ahead = direction < 0 ? [6, 1] : [1, 6];
        void libraryStore.getState().ensureRange(Math.max(0, row - ahead[0] * screen), Math.min(ids.length, row + (1 + ahead[1]) * screen),
          row, Math.min(ids.length, row + screen));
      }
      paintStandIns(direction);
      return;
    }
    flightDemandRowRef.current = -1;
    const next: LibraryView = { top: libraryWindowTop(top, rowHeight), height };
    if (!sameLibraryView(viewRef.current, next)) {
      // 快滚慢下来只创建编号行壳，不在惯性尾段一次建好五屏真实内容。
      viewRef.current = next;
      flushSync(() => setView(next));
    }
    rowRecovery.resume(pace.instant ? (pace.instant < 0 ? -1 : 1) : undefined);
    // 一步之内的滚动帧窗口不变，不进 React。
    paintStandIns(0);
  }, [libraryStore, persistentSession, paintStandIns, rowRecovery, refreshCoverLane]);

  useLayoutEffect(() => {
    const box = scrollerRef.current;
    if (!box) return;
    const measure = () => {
      setRootFont(Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
      const row = box.querySelector<HTMLTableRowElement>("tbody tr:not([data-spacer])");
      const height = row?.getBoundingClientRect().height ?? FALLBACK_ROW_H;
      if (height > 0 && Math.abs(height - rowHRef.current) > 0.5) {
        rowHRef.current = height;
        setRowH(height);
      }
      const header = box.querySelector("thead")?.getBoundingClientRect().height ?? 28;
      // 行高、列或主题变了：替身行按新的样子重新量。
      standInsRef.current?.invalidate();
      headerHRef.current = header;
      setHeaderH((old) => Math.abs(old - header) > 0.5 ? header : old);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    const row = box.querySelector("tbody tr:not([data-spacer])");
    if (row) observer.observe(row);
    const theme = new MutationObserver(measure);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "class"] });
    return () => { observer.disconnect(); theme.disconnect(); };
  }, [total > 0, layout, colPrefs, pendingDownloads.length > 0]);

  const viewport = libraryViewport({ total, pending: pendingDownloads.length, top: view.top,
    height: view.height || 720, rowHeight: rowH, headerHeight: headerH });
  const { start: winStart, end: winEnd } = viewport;
  const windowedTracks = orderedIds.slice(viewport.trackStart, viewport.trackEnd)
    .map((id, offset) => ({ id, track: summaryById.get(id), index: viewport.trackStart + offset }));
  renderedRowsRef.current = { start: winStart, end: winEnd };

  useLayoutEffect(() => {
    const box = scrollerRef.current;
    const layer = standInLayerRef.current;
    if (!box || !layer) return;
    const standIns = createLibraryStandIns(box, layer);
    standInsRef.current = standIns;
    return () => {
      standIns.destroy();
      if (standInsRef.current === standIns) standInsRef.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const box = scrollerRef.current;
    if (!box) return;
    const arrival = createListArrival(box);
    arrivalRef.current = arrival;
    return () => {
      arrival.stop();
      if (arrivalRef.current === arrival) arrivalRef.current = null;
    };
  }, []);
  // 编号画布与 DOM 编号在同一帧交接；数据内容的动画不触碰序号。
  useLayoutEffect(() => {
    const pace = paceRef.current;
    paintStandIns(!pace.fast ? 0 : (pace.instant || pace.speed) < 0 ? -1 : 1);
  }, [paintStandIns, winStart, winEnd, orderedIds, pendingDownloads.length]);

  useLayoutEffect(() => {
    const box = scrollerRef.current;
    if (!box) return;
    let desired = box.scrollTop;
    let presented = false;
    if (previousQueryRef.current !== queryVersion) {
      if (previousQueryRef.current > 0) scrollRestoreDoneRef.current = true;
      previousQueryRef.current = queryVersion;
      paceRef.current = LIBRARY_REST_PACE;
      scrollSampleAtRef.current = 0;
      rowRecovery.resume();
      // The initial index starts a query too; persisted position applies once on startup.
      // Another list from here on: it starts at its top, and it arrives.
      if (scrollRestoreDoneRef.current) { desired = 0; presented = true; }
      anchorRef.current = { id: null, index: 0, offset: 0 };
    }
    if (!scrollRestoreDoneRef.current && total > 0) {
      const saved = initialSessionRef.current;
      desired = saved.topVisibleTrackId !== null
        ? restoreLibraryAnchor(orderedIds, saved.topVisibleTrackId, Math.floor(saved.scrollTop / rowH), saved.rowOffset, rowH, pendingDownloads.length)
        : saved.scrollTop;
      scrollRestoreDoneRef.current = true;
      // The list is on screen for the first time, wherever it was left: that is an arrival too.
      presented = true;
    } else if (total > 0 && anchorRef.current.id !== null) {
      const anchor = anchorRef.current;
      desired = restoreLibraryAnchor(orderedIds, anchor.id, anchor.index, anchor.offset, rowH, pendingDownloads.length);
    }
    desired = Math.min(viewport.maxTop, Math.max(0, desired));
    if (Math.abs(box.scrollTop - desired) > 0.5) box.scrollTop = desired;
    scrollTopRef.current = box.scrollTop;
    const windowTop = libraryWindowTop(desired, rowH);
    setView((old) => old.top === windowTop && old.height === box.clientHeight ? old : { top: windowTop, height: box.clientHeight });
    if (presented) arrivalDueRef.current = { view: { top: windowTop, height: box.clientHeight }, at: performance.now() };
    const index = Math.max(0, Math.floor(desired / rowH) - pendingDownloads.length);
    anchorRef.current = { id: orderedIds[index] ?? null, index, offset: desired % rowH };
  }, [orderedIds, queryVersion, total, rowH, pendingDownloads.length, viewport.maxTop, rowRecovery]);

  // 板块重新显示：列表再到场一次。隐藏期间容器没有尺寸，渲染窗口退回了列表开头；先按容器恢复的
  // 位置把窗口摆对，行提交后再开始。
  useLayoutEffect(() => {
    if (visibleRef.current === visible) return;
    visibleRef.current = visible;
    const box = scrollerRef.current;
    if (!visible || !box) {
      rowRecovery.hold();
      arrivalDueRef.current = null;
      arrivalRef.current?.stop();
      return;
    }
    const top = libraryWindowTop(box.scrollTop, rowHRef.current);
    const height = box.clientHeight;
    // 恢复位置不是一次滚动。
    scrollTopRef.current = box.scrollTop;
    setView((current) => current.top === top && current.height === height ? current : { top, height });
    arrivalDueRef.current = { view: { top, height }, at: performance.now() };
    paceRef.current = LIBRARY_REST_PACE;
    rowRecovery.resume();
  }, [visible, rowRecovery]);

  // 列表呈现的动画仍由窗口交接；滚动补建的动画由 rowRecovery 在小批提交后接入。
  useLayoutEffect(() => {
    const due = arrivalDueRef.current;
    if (!due) {
      if (arrivalRef.current?.gesture() === "list") arrivalRef.current.join(mountedRows(arrivalRowsRef.current));
      return;
    }
    const matched = sameLibraryView(view, due.view);
    if (!matched && performance.now() - due.at <= ARRIVAL_DUE_MS) return;
    arrivalDueRef.current = null;
    if (matched && visibleRef.current && !paceRef.current.fast) {
      if (!startArrival() && windowedTracks.some(row => !row.track)) arrivalDueRef.current = due;
    }
  });

  useEffect(() => {
    if (total > 0) void ensureRange(viewport.fetchStart, viewport.fetchEnd, viewport.visibleTrackStart, viewport.visibleTrackEnd);
  }, [ensureRange, total, orderedIds, queryVersion, viewport.fetchStart, viewport.fetchEnd, viewport.visibleTrackStart, viewport.visibleTrackEnd]);

  // 行交互的实现每次渲染都换成最新的闭包；交给行的 rowActions 身份不变，行不会因此重渲染。
  const rowActionsLatest = useRef<TrackRowActions>(null as unknown as TrackRowActions);
  rowActionsLatest.current = {
    linkDragStart(event, track) {
      const sourceScroller = event.currentTarget.closest<HTMLElement>(".kd-scroll");
      htmlExternalDragScrollUnlockRef.current?.();
      htmlExternalDragScrollUnlockRef.current = lockTrackPointerDragScroll(
        sourceScroller,
        sourceScroller?.scrollTop ?? 0,
        sourceScroller?.scrollLeft ?? 0,
      );
      const link = trackShareLink(track)
        ?? resolvedLocalTrackShareLinks.get(localTrackShareCacheKey(track))
        ?? null;
      if (!link) {
        event.preventDefault();
        htmlExternalDragScrollUnlockRef.current?.();
        htmlExternalDragScrollUnlockRef.current = null;
        setNotice("正在查找分享链接，找到后请再拖一次");
        void resolveLocalTrackShareLink(track).then((resolved) => {
          setNotice(resolved ? "分享链接已找到，可以再次拖出" : "没有找到可确认的歌曲分享链接");
        });
        return;
      }
      const ids = selected.has(track.id) ? [...selectedIds] : [track.id];
      writeTrackDragData(event.dataTransfer, ids);
      writeShareLinkDrag(event.dataTransfer, link, event.currentTarget, {
        plainText: formatTrackShareText(track, link),
      });
      setDragGhost(event.dataTransfer, {
        title: track.title || track.filename,
        count: ids.length,
        coverFrom: event.currentTarget,
      });
    },
    linkDragEnd() {
      endTrackDrag();
      htmlExternalDragScrollUnlockRef.current?.(EXTERNAL_DRAG_SCROLL_SETTLE_MS);
      htmlExternalDragScrollUnlockRef.current = null;
    },
    click(event, track) {
      if (hasTextSelectionWithin(event.currentTarget)) return;
      if (suppressClickRef.current === track.id) {
        suppressClickRef.current = null;
        return;
      }
      if (selecting) {
        // 双点会依次送 detail=1 / 2 两次 click。竖屏的单击就是播放，
        // 第二下既不该重复起播，也不该把选择状态又翻回去。
        if (playClick === "single" && event.detail > 1) return;
        // A plain click picks or drops the row; Shift picks the run up to it. Nothing plays.
        onSelect(track.id, event.shiftKey ? "range" : "toggle");
        return;
      }
      // 同上：先让第一下立即播放，第二下只被吞掉；不要等双击超时，
      // 否则移动端会感觉点歌迟钝。键盘触发的 detail=0 不受影响。
      if (playClick === "single" && event.detail > 1) return;
      const mode = selectMode(event);
      if (playClick === "double" && event.detail === 2 && mode === "replace") {
        // `click(detail=2)` precedes `dblclick`. Send the audio intent first so opening
        // TrackDetail cannot occupy the main thread before the native Load is queued.
        doubleClickPlaybackRef.current = { trackId: track.id, at: performance.now() };
        playFromTable(track);
      }
      onSelect(track.id, mode, event.detail);
      // 带修饰键的多选不算——那是在攒选区。
      if (mode !== "replace") return;
      // 单击播放按设置走；双击模式下单击只负责选择。
      // 详情入口仍留给播放条唱盘（见 PlayerBar.DETAIL_EVENT）。
      if (playClick === "single") {
        playFromTable(track);
      }
    },
    pointerDown(event, track) {
      if (htmlExternalLinkDrag) {
        void resolveLocalTrackShareLink(track);
        return;
      }
      if (beginTrackSystemFileDrag(event, track)) return;
      if (event.pointerType === "mouse") {
        beginTrackPointerDrag(event, track);
      } else {
        beginLongPress(track, event.clientX, event.clientY);
      }
    },
    cancelPress,
    doubleClick(track) {
      if (selecting || playClick !== "double") return;
      const submitted = doubleClickPlaybackRef.current;
      doubleClickPlaybackRef.current = null;
      if (
        submitted?.trackId === track.id &&
        performance.now() - submitted.at < 1_000
      ) {
        return;
      }
      playFromTable(track);
    },
    contextMenu(event, track) {
      event.preventDefault();
      if (Date.now() < suppressContextMenuUntilRef.current) return;
      cancelPress();
      setPendingMenu(null);
      // 右键只开菜单；用户明确点菜单里的「选择」后才进入批选（序号换成选择标记）。
      setRowMenu({ x: event.clientX, y: event.clientY, track });
    },
  };
  const rowActions = useMemo<TrackRowActions>(() => ({
    click: (event, track) => rowActionsLatest.current.click(event, track),
    doubleClick: (track) => rowActionsLatest.current.doubleClick(track),
    pointerDown: (event, track) => rowActionsLatest.current.pointerDown(event, track),
    cancelPress: () => rowActionsLatest.current.cancelPress(),
    contextMenu: (event, track) => rowActionsLatest.current.contextMenu(event, track),
    linkDragStart: (event, track) => rowActionsLatest.current.linkDragStart(event, track),
    linkDragEnd: () => rowActionsLatest.current.linkDragEnd(),
  }), []);

  // 等待中的封面请求按可视范围排先后。范围在渲染时写入，行挂载时的 effect 读到的就是它；
  // 窗口移动后在这里给还在等的请求换优先级。
  useLayoutEffect(() => {
    refreshCoverLane();
  }, [refreshCoverLane, visible, viewport.visibleTrackStart, viewport.visibleTrackEnd]);

  const moveColumn = (from: string, to: string) => {
    if (from === to) return;
    // 以当前看到的顺序为基准重排，理由同 PanelStack.commit。
    saveColPrefs({ ...colPrefs, order: moveColumnOrder(colPrefs.order, colIds, from, to) });
  };

  return (
    <div className="kd-overlay-scroll-host">
    <div
      className="kd-scroll"
      style={{ height: "100%", overflowAnchor: "none" }}
      aria-busy={loading || loadingMore}
      // 可视区域优先分析要知道"曲目表滚到哪了"。不挂这个 ref 它也能靠
      // DOM 自己找到表（认 td[data-col="title"]），但那条路在列结构变动时
      // 会静默失效——显式挂上就不再依赖任何选择器。
      // scrollerRef 蹭同一个 ref：滚回选中行（见上面 DETAIL_EVENT）也要这个容器。
      // ref 必须是稳定函数（useCallback）：内联箭头每次渲染都是新身份，React 会
      // 反复 detach/attach，attach 里的 setView 又触发渲染——死循环就是这么来的。
      // setView 走相等守卫：值没变就返回旧对象， ResizeObserver 的初次回调
      // 和滚动重算都不会再空转渲染。
      ref={trackScrollerRef}
      onScroll={() => {
        // 这一个容器同时横滚和竖滚；横滚不影响虚拟窗口，syncWindow 里窗口没变就不进 React，
        // 编号画布随容器横向移动，不为它重绘。
        // 滚轮、触控板、触摸由 WebView 的滚动线程执行，拖滑块、键盘、定位由页面执行；
        // 都从这里进来，一帧合并一次，并在这一帧内提交对应的行。
        if (!scrollRafRef.current) {
          scrollRafRef.current = requestAnimationFrame((now) => {
            scrollRafRef.current = 0;
            syncWindow(now);
          });
        }
      }}
    >
      {/* 批选动作在曲库半栏 LibraryWorkRail，这里不再单独占一条。 */}
      {/* data-kind 区分曲库表和搜索结果表（两者共用 .kd-table，但结果表里有
          视频大行那套自排版，套不得两行式）；data-layout 是两行式的开关，
          见 TrackTableProps.layout 里为什么不能交给容器宽度判。 */}
      <table
        className="kd-table"
        data-kind="library"
        data-layout={layout}
        data-fit-width={fitWidth || undefined}
        style={{ minWidth: tableMinWidthPx }}
      >
        {/* 每个真实列由 col 锁住自己的宽度，最后一列只吃剩余空白。
            这样拖标题不会再按比例挤动艺人/BPM；总宽超过视口时由外层横向滚动。 */}
        <colgroup>
          {showIndexCol ? <col data-col="index" style={{ width: indexWidth }} /> : null}
          {visibleColumns.map((column) => (
            <col
              key={column.key}
              data-col={column.key}
              style={{ width: displayWidthFor(column) }}
            />
          ))}
          <col />
        </colgroup>
        <thead>
          {/* 右键任意列头 = 选列菜单；拖列头 = 换列序；列头右缘把手 = 调列宽。
              指针移动超过阈值才算拖动，并拦掉松手后的排序 click。 */}
          <tr
            onContextMenu={(event) => {
              event.preventDefault();
              setColMenu({ x: event.clientX, y: event.clientY });
            }}
          >
            {showIndexCol ? (
              <th
                data-col="index"
                data-picking={selecting ? "true" : undefined}
                style={{ width: indexWidth }}
                title={selecting ? undefined : "当前列表中的序号"}
              >
                <span className="kd-th-label">序号</span>
                {/* Above the rows' marks, in their place: all of the list, a part of it, none. */}
                {selecting ? (
                  <RowPick
                    className="kd-pick-head"
                    state={selectedIds.length === 0 ? "none" : selectedIds.length >= orderedIds.length ? "all" : "some"}
                    label="全选"
                    onToggle={() => {
                      const store = libraryStore.getState();
                      if (selectedIds.length >= orderedIds.length) store.select(null);
                      else store.selectAll();
                      // Clearing through the store leaves the mode; the head's mark stays in it.
                      store.setSelectionMode(true);
                    }}
                  />
                ) : null}
                <span
                  className="kd-col-resize"
                  data-active={resizingCol === INDEX_COL_KEY ? "true" : undefined}
                  onPointerDown={(event) => beginColumnResize(INDEX_COL_KEY, event)}
                  onClick={(event) => event.stopPropagation()}
                  aria-hidden="true"
                />
              </th>
            ) : null}
            {visibleColumns.map((column) => {
              const colWidth = displayWidthFor(column);
              return (
              <th
                key={column.key}
                data-col={column.key}
                data-column-reorder="true"
                style={{ width: colWidth }}
                className={column.align === "num" ? "kd-td-num" : undefined}
                data-sortable={column.id ? "true" : undefined}
                onClick={
                  column.id
                    ? () => {
                        if (suppressSortClickRef.current) {
                          suppressSortClickRef.current = false;
                          return;
                        }
                        onSort(column.id as TrackSort);
                      }
                    : undefined
                }
                data-sort={
                  column.id !== null
                    ? column.id === sort
                      ? "1"
                      : column.id === sort2
                        ? "2"
                        : undefined
                    : undefined
                }
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
                    onDragged: suppressNextSortClick,
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
                title={
                  column.id
                    ? tableSortTitle({ sort, order, sort2, order2 }, column.id)
                    : "拖动列头换列序；右缘拖动调列宽；右键选择显示哪些列"
                }
              >
                {column.label}
                {/* 主、副排序仍由 store 中的 sort / sort2 区分；表头只显示方向，
                    避免带圈数字与列名字号不协调。层级说明保留在表头 title 中。 */}
                {column.id !== null && column.id === sort && (
                  <TableSortMark order={order} />
                )}
                {column.id !== null && column.id !== sort && column.id === sort2 && (
                  <TableSortMark order={order2} secondary />
                )}
                <span
                  className="kd-col-resize"
                  data-active={resizingCol === column.key ? "true" : undefined}
                  onPointerDown={(event) => beginColumnResize(column.key, event)}
                  onClick={(event) => event.stopPropagation()}
                  aria-hidden="true"
                />
              </th>
              );
            })}
            <th className="kd-table-fill" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {winStart > 0 && <tr data-spacer="top" aria-hidden="true"><td colSpan={tableColSpan} style={{ height: winStart * rowH }} /></tr>}
          {pendingDownloads.slice(winStart, Math.min(winEnd, pendingDownloads.length)).map((task) => {
            /** 有曲目时下载态占独立序号列，和下面 1/2/3 同宽；无曲目时不单独占一列。 */
            const showArtist = visibleColumns.some((column) => column.key === "artist");
            const showFormat = visibleColumns.some((column) => column.key === "format");
            return (
            <tr
              key={`pending:${task.id}`}
              data-pending="true"
              data-pending-state={task.state}
              onContextMenu={(event) => {
                event.preventDefault();
                setRowMenu(null);
                setPendingMenu({ x: event.clientX, y: event.clientY, task });
              }}
            >
              {showIndexCol ? (
                <td data-col="index" className="kd-pending-index">
                  <PendingStateMark task={task} />
                </td>
              ) : null}
              <td
                colSpan={Math.max(1, visibleColumns.length)}
                data-col="title"
                className="kd-td-strong kd-pending-lead"
                title={task.title || "未命名"}
              >
                <span className="kd-pending-title">
                  {!showIndexCol ? <PendingStateMark task={task} /> : null}
                  <span className="kd-thumb" aria-hidden="true">
                    {task.cover ? (
                      <img
                        src={thumbUrl(task.cover)}
                        alt=""
                        loading="lazy"
                        draggable={false}
                        referrerPolicy="no-referrer"
                        onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                      />
                    ) : null}
                  </span>
                  {task.kind === "video" && (
                    <span className="kd-video-mark" title="视频" role="img" aria-label="视频">
                      <Video size={11} aria-hidden="true" />
                    </span>
                  )}
                  <span className="kd-truncate">{task.title || "未命名"}</span>
                  {showArtist && task.artist ? (
                    <span className="kd-pending-side kd-muted kd-truncate" title={task.artist}>
                      {task.artist}
                    </span>
                  ) : null}
                  {showFormat ? (
                    <span className="kd-pending-side kd-mono kd-muted">
                      {task.kind === "video" ? "视频" : task.quality || DASH}
                    </span>
                  ) : null}
                </span>
              </td>
              <td className="kd-table-fill" aria-hidden="true" />
            </tr>
            );
          })}
          {windowedTracks.map(({ id, track, index }) => (
            <TrackRow
              key={id}
              track={track}
              recovery={rowRecovery}
              index={index}
              selected={selected.has(id)}
              focused={id === selectedId}
              playing={id === playingId}
              selectionMode={selecting}
              linkDrag={htmlExternalLinkDrag}
              actions={rowActions}
              coverLane={coverLane}
              showIndex={showIndexCol}
              columns={visibleColumns}
              keyNotation={keyNotation}
              onToggle={toggleTrackSelection}
              onRate={rateTrack}
            />
          ))}
          {winEnd < viewport.count && (
            <tr data-spacer="bottom" aria-hidden="true">
              <td
                colSpan={tableColSpan}
                style={{ height: (viewport.count - winEnd) * rowH }}
              />
            </tr>
          )}
        </tbody>
      </table>
      {/* 替身行的画布（见 libraryStandIns）。放在表格之后：OverlayScrollbars 观察的是容器的第一个子元素。 */}
      <div className="kd-table-standins" aria-hidden="true" ref={standInLayerRef} />
      {/* 选列菜单。开着的时候点勾选不关闭——一次通常要调好几列，
          调一列关一次等于逼用户右键三回。点别处 / Esc / 恢复默认才关。 */}
      {colMenu && (
        <ContextMenu x={colMenu.x} y={colMenu.y} onClose={() => setColMenu(null)}>
          {orderedColumns.map((column) => {
            const isHidden = colPrefs.hidden.includes(column.key);
            const isTitle = column.key === "title";
            return (
              <button
                key={column.key}
                type="button"
                disabled={isTitle}
                title={isTitle ? "标题列不能藏：它是唯一说明「这行是哪首歌」的列" : undefined}
                onClick={() =>
                  saveColPrefs({
                    ...colPrefs,
                    hidden: isHidden
                      ? colPrefs.hidden.filter((k) => k !== column.key)
                      : [...colPrefs.hidden, column.key],
                  })
                }
              >
                {/* 勾用 opacity 藏而不是不渲染：文字要对齐，勾的位置不能塌 */}
                <Check size={12} style={{ opacity: isHidden ? 0 : 1 }} />
                {column.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              removeLocalStorage(COLUMN_PREFS_KEY);
              const defaults = loadColumnPrefs();
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
      {/* 行右键菜单：多选操作的家。删除的三种去向都在这儿——
          回收站（能反悔）、永久删除（安卓等没有回收站的平台，点两次确认）、
          只移出曲库（文件不动）。条目带数量，删的是几首一目了然。 */}
      {pendingMenu && (
        <ContextMenu x={pendingMenu.x} y={pendingMenu.y} onClose={() => setPendingMenu(null)}>
          <button type="button" onClick={() => { void copyText(pendingMenu.task.title || ""); setPendingMenu(null); }}>
            <Copy size={12} />
            复制标题
          </button>
          {pendingMenu.task.artist ? (
            <button type="button" onClick={() => { void copyText(pendingMenu.task.artist); setPendingMenu(null); }}>
              <Copy size={12} />
              复制艺人
            </button>
          ) : null}
        </ContextMenu>
      )}
      {rowMenu && (
        <ContextMenu x={rowMenu.x} y={rowMenu.y} onClose={() => setRowMenu(null)}>
          <button
            type="button"
            disabled={!undo.available}
            title={
              undo.available
                ? `撤回上次${undoName} ${undo.count} 首`
                : "没有可撤回的曲库操作"
            }
            onClick={() => {
              setRowMenu(null);
              void undoLast().catch(() => undefined);
            }}
          >
            <Undo2 size={12} />
            撤回{undo.available ? `上次${undoName}` : ""}
          </button>
          <button
            type="button"
            disabled={isImageTrack(rowMenu.track.format)}
            onClick={() => {
              setRowMenu(null);
              playFromTable(rowMenu.track);
            }}
          >
            <Play size={12} />
            播放
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectionMode(true);
              // The batch starts with this row; a row that is merely the current one is not part of it.
              if (!selected.has(rowMenu.track.id)) onSelect(rowMenu.track.id, selecting ? "toggle" : "replace");
              setRowMenu(null);
            }}
          >
            <Check size={12} />
            选择
          </button>
          <button
            type="button"
            onClick={() => {
              void copyText(rowMenu.track.title || rowMenu.track.filename || "");
              setRowMenu(null);
            }}
          >
            <Copy size={12} />
            复制标题
          </button>
          {(rowShareLink || lookedUpShare) && (
            <button
              type="button"
              disabled={!rowShareLink}
              onClick={() => {
                void copyTrackShareLink(rowMenu.track, rowShareLink);
              }}
            >
              <Link2 size={12} />
              {lookedUpShare?.loading
                ? "查找分享链接…"
                : rowShareLink
                  ? "复制分享内容"
                  : "没有找到分享链接"}
            </button>
          )}
          {rowSameNameQuery && (
            <button
              type="button"
              onClick={() => {
                requestExploreSearch(rowSameNameQuery, sameNameSearchPlatforms);
                setRowMenu(null);
              }}
            >
              <Search size={12} />
              同名搜索
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              // 右键不改选区；落在选区外的行只复制它自己。
              copyToClipboard("copy", menuIds);
              setRowMenu(null);
            }}
          >
            <Copy size={12} />
            复制曲目{menuIds.length > 1 ? `（${menuIds.length} 首）` : ""}
          </button>
          {menuIds.length === 1 && (
            <button
              type="button"
              onClick={() => {
                // 编辑器开在右键的位置旁边，不占用列表和侧栏。
                useTrackMetaEditor.getState().open(rowMenu.track.id, { x: rowMenu.x, y: rowMenu.y });
                setRowMenu(null);
              }}
            >
              <Pencil size={12} />
              编辑 Meta
            </button>
          )}
          <button type="button" disabled={menuIds.length !== 1 || isImageTrack(rowMenu.track.format)} onClick={() => {
            useVisualizerStudioStore.getState().open(rowMenu.track);
            setRowMenu(null);
          }}><BarChart3 size={12} />新建可视化</button>
          <WorkshopAddMenu ids={() => {
            const chosen = new Set(menuIds);
            return orderedIds.filter(id => chosen.has(id));
          }} close={() => setRowMenu(null)} />
          {menuIds.length === 1 && (
            <button
              type="button"
              onClick={() => {
                setRowMenu(null);
                getBridge()
                  .revealPath(rowMenu.track.path)
                  .catch((error: unknown) => setNotice((error as Error).message));
              }}
            >
              <FolderOpen size={12} />
              在文件夹中显示
            </button>
          )}
          {trashSupported ? (
            <button type="button" data-danger="true" onClick={() => runDelete("trash")}>
              <Trash2 size={12} />
              移到回收站{menuIds.length > 1 ? `（${menuIds.length} 首）` : ""}
            </button>
          ) : (
            /* 没有回收站的平台：删了就真没了，所以第一次点只是上膛，
               字面直接换成后果本身，第二次点才执行 */
            <button
              type="button"
              data-danger="true"
              onClick={() => {
                if (armed) runDelete("remove");
                else setArmed(true);
              }}
            >
              <Trash2 size={12} />
              {armed
                ? `确认删除${menuIds.length > 1 ? ` ${menuIds.length} 首` : ""}？文件无法恢复`
                : `删除文件${menuIds.length > 1 ? `（${menuIds.length} 首）` : ""}…`}
            </button>
          )}
          {(
            <button type="button" onClick={() => runDelete("keep")}>
              <ListX size={12} />
              移出曲库{menuIds.length > 1 ? `（${menuIds.length} 首）` : ""}
            </button>
          )}
        </ContextMenu>
      )}
      {/* 删除失败的原因就近浮在滚动区里：表格没有自己的状态栏 */}
      {notice && (
        <div className="kd-table-notice">
          <InlineNotice text={notice} onDismiss={() => setNotice("")} />
        </div>
      )}

    </div>
    <OverlayScrollbars scroller={scrollerRef} />
    </div>
  );
});
