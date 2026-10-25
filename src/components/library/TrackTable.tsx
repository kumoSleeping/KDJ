import { useStore } from "zustand";
import type { LibraryPaneStore, LibraryPaneStoreApi } from "../../stores/temporaryLibraryStore";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type Ref } from "react";
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
  Clapperboard,
} from "lucide-react";
import { useLaneEditor } from "../../stores/laneEditorStore";
import { libraryDemand, restoreLibraryAnchor } from "../../lib/libraryViewport";
import { listScrollsItself, rowListPadding, useRowList, useScrollMotion } from "../common/rowList";
import { scrollTopTo } from "../../lib/wheelScroll";
import { tracePlayback } from "../../lib/playbackTrace";
import { api } from "../../lib/api";
import { OverlayScrollbars } from "../common/OverlayScrollbars";
import { VinylPlaceholder } from "../common/VinylPlaceholder";
import { RowIndex, RowPick } from "../common/RowPick";
import { TableRating } from "../common/TableRating";
import { TableSortMark } from "../common/TableSortMark";
import { TrackKeyChip } from "../common/TrackKeyChip";
import { pointerDragGhost, setDragGhost, type PointerDragGhost } from "../common/dragGhost";
import "../common/DragGhost.css";
import { createListArrival, type ListArrival } from "../common/listArrival";
import "../common/RowList.css";
import { copyText } from "../../lib/copyText";
import { copyShareContent } from "../../lib/shareClipboard";
import {
  bilibiliVideoShareSearchQuery,
  formatShareListText,
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
import { pointerAccepts } from "../../lib/dragRefusal";
import { pointerTrackDropAt, type PointerTrackDrop } from "../../lib/pointerTrackDrop";
import { resolveLibraryPasteOp } from "../../lib/libraryPaste";
import { isOutsideFolder } from "../../lib/outsideFolder";
import { exportProject } from "../../lib/kdjvPlay";
import { DASH, formatBpm, formatBytes, formatDate, formatDuration, isImageTrack, isProjectTrack, isVideoTrack, thumbUrl } from "../../lib/format";
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
import type { FileDisposalMode, KeyNotation, LibraryStats, SongSource, TrackSummary } from "../../types";
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
import { canVisualizeTrack, useVisualizerPopup } from "../../lib/visualizerPopup";
import { exportVisualizerTracks, reportVisualizerExportError } from "../../lib/visualizerExportActions";
import { useTrackMetaEditor } from "../../lib/trackMetaEditor";
import { dragPreviewFromBlob, vinylDragPreview } from "../../lib/dragPreview";
import { usePlaybackPrefs } from "../../lib/playbackPrefs";
import { useSharePrefs } from "../../lib/sharePrefs";
import { requestExploreSearch } from "../../lib/vjSearch";
import { isPlatformEnabled } from "../../lib/enabledPlatforms";
import { normalizeEnabledPlatforms, normalizeSearchPlatforms } from "../../lib/searchPlatforms";
import { readLocalStorage } from "../../lib/storageWrite";
import { aiDropElementAt, fromLocalTracks } from "../../lib/aiAttachments";
import { useAiStore } from "../../stores/aiStore";

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
export type EnergyBaselines = Pick<LibraryStats, "rms_db_median" | "energy_median" | "peak_db_median">;
export function EnergyMeter({
  value,
  rmsDb = null,
  peakDb = null,
  baselines,
}: {
  value: number | null;
  rmsDb?: number | null;
  peakDb?: number | null;
  /** The library's medians (its stats); read once by the table, not by every row. */
  baselines: EnergyBaselines | null | undefined;
}) {
  const stats = baselines;
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
  { id: "rating", label: "评分", width: "4.2rem", key: "rating" },
  { id: "duration", label: "时长", width: "4rem", align: "num", key: "duration" },
  { id: null, label: "格式", width: "3.4rem", key: "format" },
  { id: null, label: "大小", width: "4.6rem", align: "num", key: "size" },
  // 日期加时间是 16 个等宽字符，约 8.5rem；再加两侧内边距。窄了它会压到下一列上。
  { id: "file_created_at", label: "文件创建", width: "10rem", key: "file_created_at" },
  { id: null, label: "采样率", width: "5.5rem", key: "samplerate" },
  { id: null, label: "声道", width: "3.4rem", key: "channels" },
  { id: null, label: "码率", width: "5.5rem", key: "bitrate" },
  { id: null, label: "流派", width: "6rem", key: "genre" },
  { id: null, label: "年份", width: "4rem", key: "year" },
  { id: null, label: "来源", width: "6rem", key: "source_platform" },
  { id: "added_at", label: "入库", width: "10rem", key: "added_at" },
  { id: null, label: "文件名", width: "14rem", key: "filename" },
  { id: null, label: "路径", width: "20rem", key: "path" },
];

/* ------------------------------------------------------------ 列的自由组合 */

/**
 * 列顺序 + 隐藏集合 + 自定义列宽，长期保存。和三栏换位、详情面板拖排同一套心智：
 * 拖一次、勾一次、拉一次，永远不用再想。存的是 id 列表而不是完整快照，
 * 理由同 PanelStack：以后加新列时旧存档不作废，新列自动排在默认位置。
 */
// 新版默认布局只应用一次；旧 key 原样保留，新 key 存在后始终以用户设置为准。
const LEGACY_COLUMN_PREFS_KEY = "kd-library-columns";
const COLUMN_PREFS_KEY = "kd-library-columns-v2";
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

function defaultColumnPrefs(): ColumnPrefs {
  return {
    order: COLUMNS.map((column) => column.key),
    hidden: [
      "file_created_at", "samplerate", "channels", "bitrate", "genre",
      "year", "source_platform", "added_at", "filename", "path",
    ],
    widths: {},
  };
}

function loadColumnPrefs(): ColumnPrefs {
  if (readLocalStorage(COLUMN_PREFS_KEY) !== null) {
    return loadTableColumnPrefs(COLUMN_PREFS_KEY, COLUMN_PREFS_SCHEMA);
  }
  const defaults = defaultColumnPrefs();
  // 升级只调整顺序和显隐，不覆盖用户拖过的列宽，也不改写旧版存档。
  defaults.widths = loadTableColumnPrefs(LEGACY_COLUMN_PREFS_KEY, COLUMN_PREFS_SCHEMA).widths;
  return saveTableColumnPrefs(COLUMN_PREFS_KEY, defaults, COLUMN_PREFS_SCHEMA);
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

/** Covers known to be missing (an audio file without a picture): the placeholder is there from the first frame. */
const coversMissing = new Set<string>();
/** Covers the browser has shown once: it has them decoded, so a row built again shows them at once. */
const coversShown = new Set<string>();
function coverSettled(key: string, shown: boolean): void {
  (shown ? coversShown : coversMissing).add(key);
}
export function coverKeyOf(track: TrackSummary): string {
  return `${track.id}:${track.modified_at}`;
}
/** A cover that has been shown or is known to be missing: nothing is left to load for it. */
export function isCoverSettled(track: TrackSummary): boolean {
  const key = coverKeyOf(track);
  return coversShown.has(key) || coversMissing.has(key);
}
/** A video's first frame is extracted on demand; a service that is restarting is asked again. */
const COVER_RETRIES = 12;
const COVER_RETRY_MS = 3000;

/**
 * 曲库表的封面格：一个普通的 <img>，由浏览器自己的图片管线请求、解码和缓存。行在视口外两三屏
 * 就挂好（rowList.ts），所以图片进入视口时已经在了，不用 lazy。浏览器显示过的封面（coversShown）
 * 重新挂载时同步解码，不闪。没有封面的音频记在 coversMissing 里，再次挂载时第一帧就是唱盘；视频
 * 首帧由后端抽取，服务短暂重启或抽帧排队时换个地址稍后再试，不能一次失败就永久空白。
 */
function TrackCoverThumb({ track }: { track: TrackSummary }) {
  const isVideo = isVideoTrack(track.format);
  const key = coverKeyOf(track);
  const [attempt, setAttempt] = useState(0);
  const [missing, setMissing] = useState(() => coversMissing.has(key));
  const retryTimer = useRef<number | null>(null);
  useEffect(() => {
    setAttempt(0);
    setMissing(coversMissing.has(key));
    return () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [key]);
  const revision = isVideo && attempt > 0 ? `${track.modified_at}-${attempt}` : track.modified_at;
  return (
    <span className="kd-thumb" draggable={false}>
      {missing && !isVideo ? (
        <VinylPlaceholder />
      ) : missing ? null : (
        <img
          src={api.coverUrl(track.id, revision, 64)}
          alt=""
          decoding={coversShown.has(key) ? "sync" : "async"}
          draggable={false}
          onLoad={() => coverSettled(key, true)}
          onError={() => {
            if (!isVideo || attempt >= COVER_RETRIES) {
              coverSettled(key, false);
              setMissing(true);
              return;
            }
            retryTimer.current = window.setTimeout(() => {
              retryTimer.current = null;
              setAttempt((value) => value + 1);
            }, COVER_RETRY_MS);
          }}
        />
      )}
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
/** 多选分享时菜单打开后最多去平台找回几首的链接；其余只用直接链接和已找回的。 */
const MENU_SHARE_LOOKUPS = 40;
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
  baselines: EnergyBaselines | null | undefined,
) {
  switch (key) {
    case "title":
      return (
        <div key={key} className="kd-list-cell kd-td-strong" role="gridcell" data-col="title" data-flex="" title={track.title || track.filename}>
          <TrackCoverThumb track={track} />
          {/* 媒介类型是这首本地文件的附属信息，排在封面后、标题前。KDJ 视频工程写一个「工程」小标签。 */}
          {isProjectTrack(track.format) ? (
            <span className="kd-video-mark kd-project-mark" title="KDJ 视频工程：由本机文件拼成，在 KDJ 里播放">工程</span>
          ) : isVideoTrack(track.format) && (
            <span className="kd-video-mark" title="视频" role="img" aria-label="视频">
              <Video size={11} aria-hidden="true" />
            </span>
          )}
          {isImageTrack(track.format) && <span className="kd-video-mark" title={track.format.toLowerCase() === "gif" ? "GIF" : "图片"} role="img" aria-label={track.format.toLowerCase() === "gif" ? "GIF" : "图片"}><ImageIcon size={11} aria-hidden="true" /></span>}
          <span className="kd-truncate">{track.title || track.filename}</span>
        </div>
      );
    case "artist":
      // data-empty 是给竖屏用的：那边没有"列"要对齐，
      // 一个孤零零的破折号只是噪声，直接不占位
      return (
        <div key={key} className="kd-list-cell" role="gridcell" data-col="artist" data-clip="" data-empty={track.artist ? undefined : "true"} title={track.artist}>
          {track.artist || DASH}
        </div>
      );
    case "album":
      return (
        <div key={key} className="kd-list-cell" role="gridcell" data-col="album" data-clip="" title={track.album}>
          {track.album || DASH}
        </div>
      );
    case "bpm":
      return (
        <div key={key} className="kd-list-cell kd-td-num" role="gridcell" data-col="bpm">
          {formatBpm(track.bpm)}
        </div>
      );
    case "camelot":
      return (
        <div key={key} className="kd-list-cell" role="gridcell" data-col="camelot" data-flex="">
          <TrackKeyChip track={track} notation={keyNotation} />
        </div>
      );
    case "energy":
      return (
        <div key={key} className="kd-list-cell" role="gridcell" data-col="energy" data-flex="">
          <EnergyMeter value={track.energy} rmsDb={track.rms_db} peakDb={track.peak_db} baselines={baselines} />
        </div>
      );
    case "duration":
      return (
        <div key={key} className="kd-list-cell kd-td-num" role="gridcell" data-col="duration">
          {formatDuration(track.duration)}
        </div>
      );
    case "format":
      return (
        <div key={key} className="kd-list-cell kd-mono kd-muted" role="gridcell" data-col="format">
          {track.format.toUpperCase() || DASH}
        </div>
      );
    case "size":
      return (
        <div key={key} className="kd-list-cell kd-td-num kd-mono kd-muted" role="gridcell" data-col="size">
          {formatBytes(track.size)}
        </div>
      );
    case "file_created_at":
    case "added_at": {
      const value = formatDate(track[key]);
      return (
        <div key={key} className="kd-list-cell kd-mono kd-muted" role="gridcell" data-col={key} data-clip="" title={value}>
          {value}
        </div>
      );
    }
    case "samplerate":
    case "channels":
    case "bitrate": {
      const value = key === "samplerate"
        ? track.samplerate ? `${track.samplerate / 1000} kHz` : DASH
        : key === "channels"
          ? track.channels ? `${track.channels}ch` : DASH
          : track.bitrate ? `${track.bitrate} kbps` : DASH;
      return <div key={key} className="kd-list-cell kd-mono kd-muted" role="gridcell" data-col={key} title={value}>{value}</div>;
    }
    case "genre":
    case "year":
    case "source_platform":
    case "filename":
    case "path": {
      const value = track[key] || (key === "source_platform" ? "local" : "");
      return <div key={key} className="kd-list-cell" role="gridcell" data-col={key} data-clip="" title={value}>{value || DASH}</div>;
    }
    case "rating":
      return (
        <div key={key} className="kd-list-cell" role="gridcell" data-col="rating" data-flex="">
          <TableRating value={track.rating} onChange={onRate} />
        </div>
      );
    default:
      return null;
  }
}

interface TrackCellsProps {
  track: TrackSummary;
  columns: readonly Column[];
  keyNotation: KeyNotation;
  baselines: EnergyBaselines | null | undefined;
  onRate(id: number, rating: number): void;
}

/**
 * 行的选中、焦点和播放标记只改行元素的属性；单元格树单独 memo 后，封面、能量条和
 * 评分控件不会跟着重复执行。
 */
const TrackCells = memo(function TrackCells({
  track,
  columns,
  keyNotation,
  baselines,
  onRate,
}: TrackCellsProps) {
  return (
    <>
      {columns.map((column) => trackCell(
        track,
        column.key,
        keyNotation,
        column.key === "rating" ? (rating) => onRate(track.id, rating) : undefined,
        baselines,
      ))}
    </>
  );
});

/** 空位只留序号（由 TrackRow 持有）；一个空格跨过数据列，不制造假的内容或控件。 */
const PlaceholderCells = memo(function PlaceholderCells({ columns }: Pick<TrackCellsProps, "columns">) {
  return <div className="kd-list-cell" aria-hidden="true" style={{ gridColumn: `span ${columns.length}` }} />;
});

/**
 * 行上的交互。对象身份在表格的整个生命周期里不变（实现每次渲染换新，见 TrackTable 里的
 * rowActions），所以窗口移动、选区变化都不会让没变的行重渲染。
 */
interface TrackRowActions {
  click(event: React.MouseEvent<HTMLDivElement>, track: TrackSummary): void;
  doubleClick(track: TrackSummary): void;
  pointerDown(event: React.PointerEvent<HTMLDivElement>, track: TrackSummary): void;
  cancelPress(): void;
  contextMenu(event: React.MouseEvent<HTMLDivElement>, track: TrackSummary): void;
  linkDragStart(event: React.DragEvent<HTMLDivElement>, track: TrackSummary): void;
  linkDragEnd(): void;
}

interface TrackRowProps extends Omit<TrackCellsProps, "track"> {
  /** The row's key in the list: the track's id. Its summary may not have arrived yet. */
  id: number;
  track: TrackSummary | undefined;
  /** 在当前顺序里的位置（从 0 起）。 */
  index: number;
  showIndex: boolean;
  /** Rows are being picked: the index gives way to the selection mark (see TrackTable's `selecting`). */
  selectionMode: boolean;
  selected: boolean;
  focused: boolean;
  playing: boolean;
  /** Windows 分享链接走 WebView2 原生 HTML5 拖放。 */
  linkDrag: boolean;
  actions: TrackRowActions;
  /** `range` picks the run from the row touched last to this one. */
  onToggle(id: number, range?: boolean): void;
  ref: Ref<HTMLDivElement>;
}

/**
 * 一行曲目：文档流里的一个 grid，不定位（定位元素是 WebKit 的一个层，两千个层让每次滚动都要
 * 遍历两千个层）。窗口挪动时留在窗口里的行 props 不变，整行跳过；真正要渲染的只有新进来的那几行。
 * 摘要到达时内容在同一个元素里换上，行不重挂。
 */
/** Dev: rows rendered since the page loaded (the scroll trace reads the difference). */
let rowRenders = 0;

const TrackRow = memo(function TrackRow({
  id,
  track,
  index,
  showIndex,
  selectionMode,
  selected,
  focused,
  playing,
  linkDrag,
  actions,
  onToggle,
  ref,
  ...cells
}: TrackRowProps) {
  if (import.meta.env.DEV) rowRenders += 1;
  const ready = track;
  return (
    <div
      ref={ref}
      className="kd-list-row"
      role="row"
      aria-rowindex={index + 1}
      data-kd-row-key={id}
      aria-selected={selected}
      aria-busy={!ready || undefined}
      data-loading-track={!ready ? "true" : undefined}
      data-kd-track-id={ready?.id}
      data-focus={focused ? "true" : undefined}
      data-playing={playing ? "true" : undefined}
      data-selecting={selectionMode ? "true" : undefined}
      // 空位没有交互；序号和行在补入内容时不替换、不移动。
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
      {showIndex ? (
        <div className="kd-list-cell" role="gridcell" data-col="index" data-flex="" data-picking={selectionMode && ready ? "true" : undefined}>
          <RowIndex number={index + 1} picking={selectionMode} pick={ready ? (
            <RowPick state={selected ? "all" : "none"} label={`选择 ${ready.title || ready.filename}`}
              onToggle={(event) => onToggle(ready.id, event.shiftKey)} />
          ) : null} />
        </div>
      ) : null}
      {ready ? <TrackCells track={ready} {...cells} /> : <PlaceholderCells columns={cells.columns} />}
    </div>
  );
});

/** 有曲目时下载态占独立序号列，和下面 1/2/3 同宽；无曲目时不单独占一列。 */
const PendingRow = memo(function PendingRow({ task, showIndex, showArtist, showFormat, onMenu, ref }: {
  task: DownloadTask;
  showIndex: boolean;
  showArtist: boolean;
  showFormat: boolean;
  onMenu(event: React.MouseEvent<HTMLDivElement>, task: DownloadTask): void;
  ref: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      className="kd-list-row"
      role="row"
      data-kd-row-key={`pending:${task.id}`}
      data-pending="true"
      data-pending-state={task.state}
      onContextMenu={(event) => onMenu(event, task)}
    >
      {showIndex ? (
        <div className="kd-list-cell kd-pending-index" role="gridcell" data-col="index" data-flex="">
          <PendingStateMark task={task} />
        </div>
      ) : null}
      <div
        className="kd-list-cell kd-td-strong kd-pending-lead"
        role="gridcell"
        data-col="title"
        data-flex=""
        style={{ gridColumn: showIndex ? "2 / -1" : "1 / -1" }}
        title={task.title || "未命名"}
      >
        <span className="kd-pending-title">
          {!showIndex ? <PendingStateMark task={task} /> : null}
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
      </div>
    </div>
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
 * 虚拟列表的兜底行高（= --kd-row-h）。真实行高以渲染出来的第一行为准
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

/**
 * 列表被呈现时，等渲染出的行对上它的位置（换查询后最多等这么久）再开始到场；滚动补入的行由
 * 到场模块按自己的时钟接上（见 common/listArrival）。
 */
interface ArrivalDue { offset: number; at: number }
const ARRIVAL_DUE_MS = 400;
/** Rows of a list that scrolls itself given their contents in one step; more than these entering at once come as their numbers. */
const FILL_ROWS = 12;
const FILL_PAUSE_MS = 16;
/** No contents are filled in this soon after rows came as numbers: the jump may still be going on. */
const FILL_AFTER_JUMP_MS = 60;
/** Rows remembered as built (they do not replay the chase); past this many the memory starts over. */
const MAX_BUILT_REMEMBERED = 50_000;

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
  /**
   * The library's medians for the loudness column, read once for every row. The stats arrive as a
   * new object with every analysed batch: the rows are given the three numbers they read, and
   * another object only when one of them has changed.
   */
  const rmsMedian = useLibraryStore((state) => state.stats?.rms_db_median);
  const energyMedian = useLibraryStore((state) => state.stats?.energy_median);
  const peakMedian = useLibraryStore((state) => state.stats?.peak_db_median);
  const hasStats = useLibraryStore((state) => state.stats !== null);
  const energyBaselines = useMemo<EnergyBaselines | null>(
    () => hasStats ? { rms_db_median: rmsMedian, energy_median: energyMedian, peak_db_median: peakMedian } : null,
    [hasStats, rmsMedian, energyMedian, peakMedian],
  );
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
  // The workspace hands over a fresh onSelect on many of its renders; the rows must not render
  // for that (two thousand rows is a third of a second), so the handler they hold is one object.
  const onSelectLatest = useRef(onSelect);
  onSelectLatest.current = onSelect;
  const toggleTrackSelection = useCallback(
    (id: number, range = false) => onSelectLatest.current(id, range ? "range" : "toggle"),
    [],
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
  /**
   * Dev: what the list did during one scroll, from its first frame until it rests, written to
   * the native log (`library-scroll`): frames and the longest gap between them, renders of the
   * table and of rows and the time they took, what triggered them, and what the list was.
   */
  const renderStartedAt = performance.now();
  const traceRef = useRef({ running: false, startedAt: 0, from: 0, frames: 0, scrolls: 0, slow: 0, gapMax: 0, lastFrame: 0, loop: 0,
    renders: 0, renderMs: 0, rowRendersAt: 0, bumps: 0, publishes: 0, downloads: 0, layoutMs: 0, styleMs: 0, layoutPreMs: 0, props: 0,
    prevSummaries: summaryById, prevDownloads: downloadTasks, prevProps: [] as unknown[] });
  // Dev: before any scroll handler runs (a capturing listener on the window runs first), was
  // layout already dirty? Then it is the frame before (its handlers, the player bar's text, a
  // sticky head) that leaves it so, not the handlers of this event.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const before = (event: Event) => {
      const box = scrollerRef.current;
      const trace = traceRef.current;
      if (!box || event.target !== box || !trace.running) return;
      const t0 = performance.now();
      void box.offsetHeight;
      trace.layoutPreMs += performance.now() - t0;
    };
    window.addEventListener("scroll", before, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", before, { capture: true });
  }, []);
  if (import.meta.env.DEV) {
    const trace = traceRef.current;
    trace.renders += 1;
    if (trace.prevSummaries !== summaryById) { trace.publishes += 1; trace.prevSummaries = summaryById; }
    if (trace.prevDownloads !== downloadTasks) { trace.downloads += 1; trace.prevDownloads = downloadTasks; }
    // Renders caused by the table's own props changing (the workspace rendering), as against its hooks.
    const props = [total, loading, layout, fitWidth, selectedId, selectedIds, shortcutActive, visible, sort, order, sort2, order2, onSelect, onSort];
    if (trace.prevProps.some((value, index) => value !== props[index])) trace.props += 1;
    trace.prevProps = props;
  }
  useLayoutEffect(() => {
    if (import.meta.env.DEV) traceRef.current.renderMs += performance.now() - renderStartedAt;
  });
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
  /** 右键落在多选里时，选中各首的分享链接（按列表顺序；找不到链接的不在里面）。 */
  const [menuShareBatch, setMenuShareBatch] = useState<{
    key: string;
    items: { track: TrackSummary; link: string }[];
    loading: boolean;
    /** 选中的歌里有没有可能分享的：没有一首有来源时不摆这一项，和单首一样。 */
    possible: boolean;
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
    },
    [],
  );

  /** 触屏长按整行后启动系统文件拖动；明显纵向移动时优先让列表滚动。 */
  const beginTrackSystemFileDrag = (
    event: React.PointerEvent<HTMLDivElement>,
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
  const beginTrackPointerDrag = (event: React.PointerEvent<HTMLDivElement>, track: TrackSummary) => {
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
    // A place of the app's own that takes the rows (the editor), told when the pointer leaves it.
    let place: PointerTrackDrop | null = null;

    try {
      sourceRow.setPointerCapture(pointerId);
    } catch {
      // WebKit 若已经开始取消该指针，window capture 监听仍可完成收尾。
    }

    const blockDragScroll = (scrollEvent: Event) => {
      if (dragging) scrollEvent.preventDefault();
    };

    const clearTargets = () => {
      document
        .querySelectorAll<HTMLElement>("[data-kd-pointer-track-over], [data-kd-pointer-ai-over]")
        .forEach((node) => {
          node.removeAttribute("data-kd-pointer-track-over");
          node.removeAttribute("data-kd-pointer-ai-over");
        });
    };
    const hitAt = (x: number, y: number) => document.elementFromPoint(x, y) as HTMLElement | null;
    const paintTarget = (x: number, y: number) => {
      clearTargets();
      const ai = aiDropElementAt(x, y);
      ghost?.hint(ai ? "交给 AI" : null);
      const under = ai ? null : pointerTrackDropAt(x, y);
      if (place !== under) place?.leave();
      place = under;
      if (ai) {
        ai.setAttribute("data-kd-pointer-ai-over", "");
        return;
      }
      if (place) {
        ghost?.hint(place.over(ids, x, y));
        return;
      }
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
      const exports = hit?.closest<HTMLElement>("[data-kd-visualizer-export-drop]");
      ghost?.hint(exports ? "导出可视化" : null);
      if (exports) return;
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
      place?.leave();
      place = null;
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
      // A place of the app that takes the drop (a key in the top bar sits in that strip) keeps it:
      // a shake there on the way in must not hand the drag to the system.
      if (outsideWindow && !pointerAccepts("track", move.clientX, move.clientY) && launchSystemExternalDrag()) return;
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
      const ai = aiDropElementAt(up.clientX, up.clientY);
      const taker = ai ? null : pointerTrackDropAt(up.clientX, up.clientY);
      cleanup();
      if (!dragging) return;
      up.preventDefault();
      if (taker) {
        finishTrackDrop();
        taker.drop(ids, up.clientX, up.clientY);
        return;
      }
      // The `/pi` field: the songs become cards that go to the AI with the request.
      if (ai) {
        finishTrackDrop();
        void libraryStore.getState().resolveSummaries(ids)
          .then(tracks => useAiStore.getState().attach(fromLocalTracks(tracks)))
          .catch(() => undefined);
        return;
      }
      if (hit?.closest("[data-kd-visualizer-export-drop]")) {
        finishTrackDrop();
        void libraryStore.getState().resolveSummaries(ids)
          .then(tracks => exportVisualizerTracks(tracks, { x: up.clientX, y: up.clientY }))
          .catch(reportVisualizerExportError);
        return;
      }

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
  // 多选时同样在菜单打开时备齐链接：直接链接立刻就有，SoundCloud / 旧 B 站视频去平台找回。
  const shareBatchKey = menuIds.length > 1 ? menuIds.join(",") : "";
  // Layout effect: the menu's first frame already knows whether there is anything to share.
  useLayoutEffect(() => {
    setMenuShareBatch(null);
    if (!shareBatchKey) return;
    let active = true;
    const ids = shareBatchKey.split(",").map(Number)
      .sort((a, b) => (indexById.get(a) ?? Infinity) - (indexById.get(b) ?? Infinity));
    const known = new Map(summaryById);
    const missing = ids.filter((id) => !known.has(id));
    const lookups: Promise<unknown>[] = [];
    const links = new Map<number, string>();
    const publish = (loading: boolean) => {
      if (!active) return;
      const items = ids.flatMap((id) => {
        const track = known.get(id);
        const link = links.get(id);
        return track && link ? [{ track, link }] : [];
      });
      setMenuShareBatch({ key: shareBatchKey, items, loading, possible: loading || items.length > 0 || lookups.length > 0 });
    };
    const collect = (tracks: readonly TrackSummary[]) => {
      for (const track of tracks) {
        known.set(track.id, track);
        const direct = trackShareLink(track);
        if (direct) {
          links.set(track.id, direct);
          continue;
        }
        if (!(soundCloudTrackId(track) || (isVideoTrack(track.format) && bilibiliVideoShareSearchQuery(track)))) continue;
        if (lookups.length >= MENU_SHARE_LOOKUPS) continue;
        lookups.push(resolveLocalTrackShareLink(track).then((link) => {
          if (link) links.set(track.id, link);
        }));
      }
    };
    collect(ids.flatMap((id) => known.get(id) ?? []));
    // 选区里还没滚到的行，曲库只载了它们的 id：取一次摘要再找链接。
    const summaries = missing.length > 0
      ? api.trackSummaries(missing).then(collect).catch(() => undefined)
      : Promise.resolve();
    publish(lookups.length > 0 || missing.length > 0);
    void summaries.then(() => Promise.all(lookups)).then(() => publish(false));
    return () => {
      active = false;
    };
    // 菜单打开那一刻的选区与摘要就是要分享的内容；之后摘要刷新不重找。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareBatchKey]);
  const shareBatch = shareBatchKey && menuShareBatch?.key === shareBatchKey ? menuShareBatch : null;
  const copyTrackShareList = async (items: readonly { track: TrackSummary; link: string }[]) => {
    setRowMenu(null);
    if (items.length === 0) return;
    await copyShareContent(
      formatShareListText(
        items.map(({ track, link }) => ({
          link,
          info: { title: track.title || track.filename, artists: track.artist, album: track.album },
        })),
        shareContentMode,
      ),
      shareContentMode,
    );
  };
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

  /* ------------------------------------------------ 滚动容器、行高、到场 */
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const initialSessionRef = useRef(persistentSession ? readWorkspaceSession().local : { scrollTop: 0, topVisibleTrackId: null, rowOffset: 0 });
  const scrollRestoreDoneRef = useRef(false);
  const anchorRef = useRef({ id: null as number | null, index: 0, offset: 0 });
  const previousQueryRef = useRef(queryVersion);
  const [headerH, setHeaderH] = useState(28);
  const headerHRef = useRef(28);
  const [rootFont, setRootFont] = useState(16);
  const [rowH, setRowH] = useState(FALLBACK_ROW_H);
  const rowHRef = useRef(FALLBACK_ROW_H);
  /** 行的到场动画（见 common/listArrival）。 */
  const arrivalRef = useRef<ListArrival | null>(null);
  /** 行渲染到位之后要开始的到场动画（见 ArrivalDue）。 */
  const arrivalDueRef = useRef<ArrivalDue | null>(null);
  const visibleRef = useRef(visible);
  const pendingCountRef = useRef(0);
  /** 已挂载的行，按行的键（曲目 id / 待下载任务）；到场动画按它找到行。 */
  const rowElementsRef = useRef(new Map<string, HTMLElement>());
  const registerRow = useCallback((el: HTMLDivElement) => {
    const key = el.dataset.kdRowKey ?? "";
    const rows = rowElementsRef.current;
    rows.set(key, el);
    return () => {
      if (rows.get(key) === el) rows.delete(key);
    };
  }, []);
  /** 滚动容器 ref：可视区域优先分析要知道"曲目表滚到哪了"。 */
  const trackScrollerRef = useCallback((el: HTMLDivElement | null) => {
    scrollerRef.current = el;
    if (persistentSession) observeTrackScroller(el);
  }, [persistentSession]);
  // centerSelected 挂在 [] 上，靠 ref 拿最新值，不为它重挂全局事件
  const selectedIdRef = useRef(selectedId);
  // 只取 id：播放进度之类的变化不该让整张表重渲染
  const playingId = useSyncExternalStore(subscribePlayingTrack, () => getPlayingTrack()?.id ?? null, () => null);
  const virtualizerRef = useRef<ReturnType<typeof useRowList>["virtualizer"] | null>(null);
  useEffect(() => {
    const scrollTrackIntoCenter = (trackId: number | null | undefined, attemptsLeft = 40) => {
      const id = trackId ?? selectedIdRef.current;
      if (id == null) return;
      const index = libraryStore.getState().indexById.get(id) ?? -1;
      const virtualizer = virtualizerRef.current;
      if (index < 0 || !virtualizer || !scrollerRef.current) {
        if (attemptsLeft > 0) requestAnimationFrame(() => scrollTrackIntoCenter(id, attemptsLeft - 1));
        return;
      }
      // The rows of the place are built before the offset is written (scrollTopTo): a jump that
      // moved first would show a frame of padding in WebKit, as a flick did.
      const target = virtualizer.getOffsetForIndex(pendingCountRef.current + index, "center");
      if (target) scrollTopTo(scrollerRef.current, target[0]);
      else virtualizer.scrollToIndex(pendingCountRef.current + index, { align: "center" });
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
  const tableMinWidthPx = useMemo(() => {
    const px = (value: string) => Number.parseFloat(value) * (value.endsWith("px") ? 1 : rootFont);
    return fitWidth ? "100%" : (showIndexCol ? px(indexWidth) : 0)
      + visibleColumns.reduce((sum, column) => sum + px(displayWidthFor(column)), 0);
  }, [fitWidth, showIndexCol, indexWidth, visibleColumns, colPrefs.widths, rootFont]);

  /* ---------------------------------------------------- 虚拟列表 */
  /**
   * 行是绝对定位的独立块（common/RowList.css），只有视口附近的行存在；滚动由 WebView 的滚动线程
   * 执行，页面在报回位置的那一帧渲染对应的行（common/rowList.ts），前后各留十几行。滚动帧里
   * 不量布局、不切祖先属性、不提交别的东西：一行便宜到亚毫秒，就不需要替身行和分帧补入。
   */
  selectedIdRef.current = selectedId;
  pendingCountRef.current = pendingDownloads.length;
  const pending = pendingDownloads.length;
  const count = pending + total;
  const getKey = useCallback(
    (index: number) => index < pending ? `pending:${pendingDownloads[index].id}` : orderedIds[index - pending] ?? `gap:${index}`,
    [pending, pendingDownloads, orderedIds],
  );
  // 先于虚拟化器听 scroll：它在同一个事件里同步渲染，渲染后的 effect 要读到这次滚动的方向。
  // 停稳：记下顶部的行（后台换索引时按它保持位置），持久会话也记下位置。
  // A list waiting to be presented at an offset asks for a render when the scroll reaches it.
  const [, bump] = useReducer((tick: number) => tick + 1, 0);
  const motion = useScrollMotion(scrollerRef, () => {
    const box = scrollerRef.current;
    if (!box) return;
    const ids = libraryStore.getState().orderedIds;
    const top = Math.max(0, box.scrollTop);
    if (import.meta.env.DEV) {
      const trace = traceRef.current;
      if (trace.running) {
        trace.running = false;
        cancelAnimationFrame(trace.loop);
        let covers = 0;
        for (const id of ids) { const track = libraryStore.getState().summaryById.get(id); if (track && isCoverSettled(track)) covers += 1; }
        tracePlayback("library-scroll", { ms: Math.round(performance.now() - trace.startedAt), px: Math.round(top - trace.from),
          scrolls: trace.scrolls, frames: trace.frames, slow: trace.slow, gapMax: Math.round(trace.gapMax),
          renders: trace.renders, renderMs: Math.round(trace.renderMs), rowRenders: rowRenders - trace.rowRendersAt,
          props: trace.props, bumps: trace.bumps, publishes: trace.publishes, downloads: trace.downloads,
          layoutMs: Math.round(trace.layoutMs), styleMs: Math.round(trace.styleMs), layoutPreMs: Math.round(trace.layoutPreMs),
          playing: getPlayingTrack() ? 1 : 0,
          rows: rowElementsRef.current.size, count: ids.length, whole: whole ? 1 : 0, built: mounted ? 1 : 0,
          covers, due: arrivalDueRef.current ? 1 : 0 });
      }
    }
    const index = Math.max(0, Math.floor(top / rowHRef.current) - pendingCountRef.current);
    const anchor = { id: ids[index] ?? null, index, offset: top % rowHRef.current };
    anchorRef.current = anchor;
    if (persistentSession) updateLocalWorkspaceSession({ scrollTop: top, topVisibleTrackId: anchor.id, rowOffset: anchor.offset });
  }, () => {
    if (arrivalDueRef.current) { bump(); traceRef.current.bumps += 1; }
    if (!import.meta.env.DEV) return;
    const trace = traceRef.current;
    trace.scrolls += 1;
    if (trace.running) return;
    Object.assign(trace, { running: true, startedAt: performance.now(), from: motion.current.offset, frames: 0, scrolls: 1, slow: 0, gapMax: 0,
      lastFrame: performance.now(), renders: 0, renderMs: 0, rowRendersAt: rowRenders, bumps: 0, publishes: 0, downloads: 0,
      layoutMs: 0, styleMs: 0, layoutPreMs: 0, props: 0 });
    const tick = (now: number) => {
      const gap = now - trace.lastFrame;
      trace.lastFrame = now;
      trace.frames += 1;
      if (gap > 50) trace.slow += 1;
      trace.gapMax = Math.max(trace.gapMax, gap);
      // Whether something left layout or style dirty this frame: a forced read is free when clean.
      const box = scrollerRef.current;
      const row = box?.querySelector<HTMLElement>(".kd-list-row");
      if (box && row) {
        const t0 = performance.now();
        void box.offsetHeight;
        const t1 = performance.now();
        void getComputedStyle(row).color;
        const t2 = performance.now();
        trace.layoutMs += t1 - t0;
        trace.styleMs += t2 - t1;
      }
      if (trace.running) trace.loop = requestAnimationFrame(tick);
    };
    trace.loop = requestAnimationFrame(tick);
  });

  // Left to the WebView, a short list is rendered whole and a long one keeps three screens beyond
  // either edge; in WebKit the list scrolls itself and keeps the rows around the viewport (rowList.ts).
  const own = useMemo(() => listScrollsItself(), []);
  const screenRef = useRef(20);
  const { virtualizer, whole, mounted } = useRowList({ scrollerRef, count, rowHeight: rowH, headHeight: headerH, getKey, screenRows: screenRef.current, resetKey: queryVersion, own });
  virtualizerRef.current = virtualizer;
  const items = virtualizer.getVirtualItems();

  /**
   * 自己滚动的列表：滚动到哪里，那里的行在同一帧里就建好，所以序号永远在。一帧里进来的行太多时
   * （拖滑块、跳转）这些行先只有序号，不占那一帧；滚动缓下来后离视口近的先填上内容，一步十几行。
   */
  const shellsRef = useRef<{ items: typeof items; ids: readonly number[]; query: number; keys: Set<number>; shells: Set<number>; jumpedAt: number }>(
    { items: [], ids: orderedIds, query: queryVersion, keys: new Set(), shells: new Set(), jumpedAt: 0 });
  if (own && shellsRef.current.items !== items) {
    const before = shellsRef.current;
    const keys = new Set<number>();
    const shells = new Set<number>();
    const entering: number[] = [];
    for (const item of items) {
      if (item.index < pending) continue;
      const id = orderedIds[item.index - pending];
      keys.add(id);
      if (before.shells.has(id)) shells.add(id);
      else if (!before.keys.has(id)) entering.push(id);
    }
    // Another list, the same one in another order, and a list being presented come whole.
    const jumped = before.query === queryVersion && before.ids === orderedIds && !arrivalDueRef.current
      && motion.current.moving && entering.length > FILL_ROWS;
    if (jumped) for (const id of entering) shells.add(id);
    shellsRef.current = { items, ids: orderedIds, query: queryVersion, keys, shells, jumpedAt: jumped ? performance.now() : before.jumpedAt };
  }
  const shells = shellsRef.current.shells;
  const [, stepFill] = useReducer((step: number) => step + 1, 0);
  const hasShells = shells.size > 0;
  useEffect(() => {
    if (!hasShells) return;
    let timer = 0;
    const fill = () => {
      const state = shellsRef.current;
      if (state.shells.size === 0) return;
      // The jump is still going on: its rows would be gone before they were read.
      if (performance.now() - state.jumpedAt >= FILL_AFTER_JUMP_MS) {
        const height = Math.max(rowHRef.current, (virtualizerRef.current?.scrollRect?.height ?? 720) - headerHRef.current);
        const centre = (motion.current.offset + height / 2) / rowHRef.current - pendingCountRef.current;
        const positions = libraryStore.getState().indexById;
        const nearest = [...state.shells].sort((a, b) => Math.abs((positions.get(a) ?? 0) - centre) - Math.abs((positions.get(b) ?? 0) - centre));
        shellsRef.current = { ...state, shells: new Set(nearest.slice(FILL_ROWS)) };
        stepFill();
      }
      if (shellsRef.current.shells.size > 0) timer = window.setTimeout(fill, FILL_PAUSE_MS);
    };
    timer = window.setTimeout(fill, FILL_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [hasShells]);
  const range = virtualizer.range;
  const screen = Math.max(1, Math.ceil(Math.max(rowH, (virtualizer.scrollRect?.height ?? 720) - headerH) / rowH));
  screenRef.current = screen;
  // 数据在渲染前一屏开始请求；其余由数据层在后台补齐。
  const demand = libraryDemand({
    total, pending, screen,
    start: items[0]?.index ?? 0, end: items.length ? items[items.length - 1].index + 1 : 0,
    visibleStart: range?.startIndex ?? 0, visibleEnd: range ? range.endIndex + 1 : 0,
  });
  useEffect(() => {
    if (total > 0) void ensureRange(demand.fetchStart, demand.fetchEnd, demand.visibleTrackStart, demand.visibleTrackEnd);
  }, [ensureRange, total, orderedIds, queryVersion, demand.fetchStart, demand.fetchEnd, demand.visibleTrackStart, demand.visibleTrackEnd]);

  useLayoutEffect(() => {
    const box = scrollerRef.current;
    if (!box) return;
    const measure = () => {
      setRootFont(Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
      const row = box.querySelector<HTMLElement>(".kd-list-row");
      const height = row?.getBoundingClientRect().height ?? FALLBACK_ROW_H;
      if (height > 0 && Math.abs(height - rowHRef.current) > 0.5) {
        rowHRef.current = height;
        setRowH(height);
      }
      const header = box.querySelector(".kd-list-head")?.getBoundingClientRect().height ?? 28;
      headerHRef.current = header;
      setHeaderH((old) => Math.abs(old - header) > 0.5 ? header : old);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    const row = box.querySelector(".kd-list-row");
    if (row) observer.observe(row);
    const theme = new MutationObserver(measure);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "class"] });
    return () => { observer.disconnect(); theme.disconnect(); };
  }, [total > 0, layout, colPrefs.hidden, colPrefs.order, pendingDownloads.length > 0]);
  // 行高变了（字号、主题）：每一行的位置都按新的行高算。
  useLayoutEffect(() => { virtualizer.measure(); }, [rowH, virtualizer]);

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

  useLayoutEffect(() => {
    const box = scrollerRef.current;
    if (!box) return;
    let desired = box.scrollTop;
    let presented = false;
    if (previousQueryRef.current !== queryVersion) {
      if (previousQueryRef.current > 0) scrollRestoreDoneRef.current = true;
      previousQueryRef.current = queryVersion;
      // The initial index starts a query too; persisted position applies once on startup.
      // Another list from here on: it starts at its top, and it arrives.
      if (scrollRestoreDoneRef.current) { desired = 0; presented = true; }
      anchorRef.current = { id: null, index: 0, offset: 0 };
    }
    if (!scrollRestoreDoneRef.current && total > 0) {
      const saved = initialSessionRef.current;
      desired = saved.topVisibleTrackId !== null
        ? restoreLibraryAnchor(orderedIds, saved.topVisibleTrackId, Math.floor(saved.scrollTop / rowH), saved.rowOffset, rowH, pending)
        : saved.scrollTop;
      scrollRestoreDoneRef.current = true;
      // The list is on screen for the first time, wherever it was left: that is an arrival too.
      presented = true;
    } else if (total > 0 && anchorRef.current.id !== null) {
      const anchor = anchorRef.current;
      desired = restoreLibraryAnchor(orderedIds, anchor.id, anchor.index, anchor.offset, rowH, pending);
    }
    const maxTop = Math.max(0, count * rowH + headerHRef.current - box.clientHeight);
    desired = Math.min(maxTop, Math.max(0, desired));
    if (Math.abs(box.scrollTop - desired) > 0.5) box.scrollTop = desired;
    if (presented) arrivalDueRef.current = { offset: desired, at: performance.now() };
    const index = Math.max(0, Math.floor(desired / rowH) - pending);
    anchorRef.current = { id: orderedIds[index] ?? null, index, offset: desired % rowH };
  }, [orderedIds, queryVersion, total, count, rowH, pending]);

  // 板块重新显示：列表再到场一次，在它原来的位置。隐藏（display: none）期间容器没有尺寸，
  // 位置可能被清成了 0：按停稳时记下的行放回去。
  useLayoutEffect(() => {
    if (visibleRef.current === visible) return;
    visibleRef.current = visible;
    const box = scrollerRef.current;
    if (!visible || !box) {
      arrivalDueRef.current = null;
      arrivalRef.current?.stop();
      return;
    }
    const anchor = anchorRef.current;
    if (box.scrollTop === 0 && anchor.id !== null && total > 0) {
      const wanted = restoreLibraryAnchor(orderedIds, anchor.id, anchor.index, anchor.offset, rowHRef.current, pendingCountRef.current);
      if (wanted > 0) box.scrollTop = wanted;
    }
    arrivalDueRef.current = { offset: box.scrollTop, at: performance.now() };
  }, [visible, total, orderedIds]);

  /**
   * The rows under the viewport, [first, last): from the one at the head's lower edge (the row
   * the session remembers) to the one at the bottom. The virtualizer's own range also counts a
   * row that lies wholly under the head.
   */
  const viewBounds = useCallback(() => {
    const offset = Math.max(0, motion.current.offset);
    const height = Math.max(rowH, (virtualizer.scrollRect?.height ?? 0) - headerH);
    const first = Math.min(count, Math.floor(offset / rowH));
    const last = Math.min(count, Math.max(first, Math.ceil((offset + height) / rowH)));
    return { first, last };
  }, [virtualizer, motion, rowH, headerH, count]);
  /** The rows in view, in the order they arrive from the top; one not mounted is a gap. */
  const rowsInView = useCallback(() => {
    const rows: (HTMLElement | null)[] = [];
    const { first, last } = viewBounds();
    for (let index = first; index < last; index += 1) {
      rows.push(rowElementsRef.current.get(String(getKey(index))) ?? null);
    }
    return rows;
  }, [viewBounds, getKey]);

  // 列表被呈现：渲染出的行对上了它的位置，视口里的行到场。
  useLayoutEffect(() => {
    const due = arrivalDueRef.current;
    const arrival = arrivalRef.current;
    const box = scrollerRef.current;
    if (!due || !arrival || !box || !visibleRef.current) return;
    // The rows at the list's place are rendered once the scroll it was put at has reached the
    // page and the rows under the viewport exist.
    if (Math.abs(motion.current.offset - due.offset) > 1) {
      if (performance.now() - due.at > ARRIVAL_DUE_MS) arrivalDueRef.current = null;
      return;
    }
    const rows = rowsInView();
    if (rows.length === 0 || !rows.every(Boolean)) {
      // The rows there are not built yet; a presentation that waits too long is given up.
      if (performance.now() - due.at > ARRIVAL_DUE_MS) arrivalDueRef.current = null;
      return;
    }
    arrivalDueRef.current = null;
    arrival.present(rows);
  });

  // 行追上滚动：一次甩动跑在了造行的帧前面，视口里的位置先露了出来、行后到。这样的行按它离
  // 来向那一边的距离接上同一个时钟，一行接一行到场；阅读速度的滚动在视口外就把行备好，不会到这里。
  // 建过一次的行（everBuilt）再回来时直接就位，不重播。
  const seenKeysRef = useRef(new Set<string>());
  const everBuiltRef = useRef(new Set<string>());
  useLayoutEffect(() => {
    const seen = seenKeysRef.current;
    const built = everBuiltRef.current;
    const next = new Set<string>();
    for (const item of items) next.add(String(item.key));
    seenKeysRef.current = next;
    const arrival = arrivalRef.current;
    const { moving, direction } = motion.current;
    const settle = () => {
      if (built.size > MAX_BUILT_REMEMBERED) built.clear();
      for (const key of next) built.add(key);
    };
    // A list that scrolls itself builds its rows in the frame that shows them: none is late.
    if (own || !arrival || !moving || arrival.gesture() === "list" || arrivalDueRef.current) { settle(); return; }
    const { first, last } = viewBounds();
    for (const item of items) {
      const key = String(item.key);
      if (seen.has(key) || built.has(key) || item.index < first || item.index >= last) continue;
      const row = rowElementsRef.current.get(String(item.key));
      if (!row) continue;
      const step = direction < 0 ? last - 1 - item.index : item.index - first;
      arrival.chase(row, step, direction < 0 ? "above" : "below");
    }
    settle();
  });

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
      // A project double-clicked plays and opens in the editor beside the list, whichever click plays.
      if (!selecting && isProjectTrack(track.format)) void useLaneEditor.getState().openTrack(track);
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

  const moveColumn = (from: string, to: string) => {
    if (from === to) return;
    // 以当前看到的顺序为基准重排，理由同 PanelStack.commit。
    saveColPrefs({ ...colPrefs, order: moveColumnOrder(colPrefs.order, colIds, from, to) });
  };

  const listStyle = {
    "--kd-list-cols": [showIndexCol ? indexWidth : null, ...visibleColumns.map(displayWidthFor), "minmax(0, 1fr)"].filter(Boolean).join(" "),
    "--kd-list-min-width": typeof tableMinWidthPx === "number" ? `${tableMinWidthPx}px` : tableMinWidthPx,
  } as CSSProperties;
  const showArtist = visibleColumns.some((column) => column.key === "artist");
  const showFormat = visibleColumns.some((column) => column.key === "format");
  const onPendingMenu = useCallback((event: React.MouseEvent<HTMLDivElement>, task: DownloadTask) => {
    event.preventDefault();
    setRowMenu(null);
    setPendingMenu({ x: event.clientX, y: event.clientY, task });
  }, []);

  return (
    <div className="kd-overlay-scroll-host">
    <div
      className="kd-scroll"
      style={{ height: "100%", overflowAnchor: "none" }}
      aria-busy={loading || loadingMore}
      // 这一个容器同时横滚和竖滚。滚轮、触控板、触摸由 WebView 的滚动线程执行，拖滑块、键盘、
      // 定位由页面执行；都从容器的 scroll 事件进来，虚拟化在那一帧渲染对应的行。
      ref={trackScrollerRef}
    >
      {/* data-kind 区分曲库表和搜索结果表（两者共用行列表的样式）。 */}
      <div
        className="kd-list"
        role="grid"
        aria-rowcount={count}
        data-kind="library"
        data-layout={layout}
        data-fit-width={fitWidth || undefined}
        style={listStyle}
      >
        {/* 右键任意列头 = 选列菜单；拖列头 = 换列序；列头右缘把手 = 调列宽。
            指针移动超过阈值才算拖动，并拦掉松手后的排序 click。 */}
        <div
          className="kd-list-head"
          role="row"
          onContextMenu={(event) => {
            event.preventDefault();
            setColMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          {showIndexCol ? (
            <div
              className="kd-list-hcell"
              role="columnheader"
              data-col="index"
              data-picking={selecting ? "true" : undefined}
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
            </div>
          ) : null}
          {visibleColumns.map((column) => (
            <div
              key={column.key}
              className={column.align === "num" ? "kd-list-hcell kd-td-num" : "kd-list-hcell"}
              role="columnheader"
              data-col={column.key}
              data-column-reorder="true"
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
              <span className="kd-hcell-text">
                {column.label}
                {/* 主、副排序仍由 store 中的 sort / sort2 区分；表头只显示方向，
                    避免带圈数字与列名字号不协调。层级说明保留在表头 title 中。 */}
                {column.id !== null && column.id === sort && (
                  <TableSortMark order={order} />
                )}
                {column.id !== null && column.id !== sort && column.id === sort2 && (
                  <TableSortMark order={order2} secondary />
                )}
              </span>
              <span
                className="kd-col-resize"
                data-active={resizingCol === column.key ? "true" : undefined}
                onPointerDown={(event) => beginColumnResize(column.key, event)}
                onClick={(event) => event.stopPropagation()}
                aria-hidden="true"
              />
            </div>
          ))}
        </div>
        <div className="kd-list-body" role="rowgroup" style={rowListPadding(items, virtualizer.getTotalSize(), headerH)}>
          {items.map((item) => {
            if (item.index < pending) {
              const task = pendingDownloads[item.index];
              return (
                <PendingRow
                  key={item.key}
                  ref={registerRow}
                  task={task}
                  showIndex={showIndexCol}
                  showArtist={showArtist}
                  showFormat={showFormat}
                  onMenu={onPendingMenu}
                />
              );
            }
            const id = orderedIds[item.index - pending];
            return (
              <TrackRow
                key={item.key}
                ref={registerRow}
                id={id}
                track={shells.has(id) ? undefined : summaryById.get(id)}
                index={item.index - pending}
                selected={selected.has(id)}
                focused={id === selectedId}
                playing={id === playingId}
                selectionMode={selecting}
                linkDrag={htmlExternalLinkDrag}
                actions={rowActions}
                showIndex={showIndexCol}
                columns={visibleColumns}
                keyNotation={keyNotation}
                baselines={energyBaselines}
                onToggle={toggleTrackSelection}
                onRate={rateTrack}
              />
            );
          })}
        </div>
      </div>
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
              saveColPrefs(defaultColumnPrefs());
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
          {shareBatchKey ? shareBatch?.possible !== false && (
            <button
              type="button"
              disabled={!shareBatch || shareBatch.loading || shareBatch.items.length === 0}
              onClick={() => {
                if (shareBatch) void copyTrackShareList(shareBatch.items);
              }}
            >
              <Link2 size={12} />
              {!shareBatch || shareBatch.loading
                ? "查找分享链接…"
                : shareBatch.items.length > 0
                  ? `复制分享内容（${shareBatch.items.length} 首）`
                  : "没有找到分享链接"}
            </button>
          ) : (rowShareLink || lookedUpShare) && (
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
          {isProjectTrack(rowMenu.track.format) && (
            <button type="button" disabled={menuIds.length !== 1} onClick={() => {
              const track = rowMenu.track;
              setRowMenu(null);
              exportProject(track);
            }}><Download size={12} />导出 MP4</button>
          )}
          {menuIds.length === 1 && !isImageTrack(rowMenu.track.format) && (
            <button type="button" onClick={() => {
              const track = rowMenu.track;
              setRowMenu(null);
              // A project opens in the editor; a video is cut; a song is the base of a VJ.
              if (isProjectTrack(track.format)) { void useLaneEditor.getState().openTrack(track); return; }
              void api.track(track.id).then(full => isVideoTrack(full.format)
                ? useLaneEditor.getState().startVideo(full)
                : useLaneEditor.getState().startVj(full)).catch(() => undefined);
            }}><Clapperboard size={12} />
              {isProjectTrack(rowMenu.track.format) ? "编辑工程" : isVideoTrack(rowMenu.track.format) ? "剪辑这个视频" : "用这首歌做 VJ"}
            </button>
          )}
          <button type="button" disabled={menuIds.length !== 1 || !canVisualizeTrack(rowMenu.track)} onClick={event => {
            const track = rowMenu.track;
            const from = event.currentTarget.getBoundingClientRect();
            setRowMenu(null);
            void exportVisualizerTracks([track], from).catch(reportVisualizerExportError);
          }}><Download size={12} />导出可视化</button>
          <button type="button" disabled={menuIds.length !== 1 || isImageTrack(rowMenu.track.format)} onClick={() => {
            const track = rowMenu.track;
            setRowMenu(null);
            if (isVideoTrack(track.format)) { useVisualizerStudioStore.getState().open(track); return; }
            useVisualizerPopup.getState().openTrack(track);
            useVisualizerStudioStore.getState().openInlineSettings(track, { editorIfNoWindow: true });
          }}><BarChart3 size={12} />展开可视化</button>
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
