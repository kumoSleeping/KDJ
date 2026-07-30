import { cloneElement, useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  BarChart3,
  CircleAlert,
  Copy,
  Download,
  FolderOpen,
  Link2,
  ListMusic,
  ListStart,
  ListX,
  LoaderCircle,
  Play,
  RotateCcw,
  Star,
  Trash2,
  Video,
} from "lucide-react";
import { api } from "../../lib/api";
import { CoverImage } from "../common/VinylPlaceholder";
import { copyText } from "../../lib/copyText";
import { clearTextSelection, hasTextSelectionWithin } from "../../lib/textSelection";
import { observeTrackScroller } from "../../lib/autoAnalyze";
import { getBridge } from "../../lib/bridge";
import { isEditable } from "../../lib/useLibraryClipboard";
import { camelotColor } from "../../lib/camelot";
import {
  announceTrackDrag,
  claimActiveTrackDragIds,
  finishTrackDrop,
  isTrackDrag,
  readTrackDragIds,
  TRACK_TRASH_DROP_EVENT,
  type TrackDragDetail,
} from "../../lib/trackDrag";
import { folderDropElementAt, FOLDER_DROP_PATH_ATTR } from "../../lib/folderDrop";
import { DASH, formatBpm, formatDuration, isVideoTrack, thumbUrl } from "../../lib/format";
import {
  clickAddsNext,
  playClickForLayout,
  useTrackClickPrefs,
} from "../../lib/trackClickPrefs";
import type { LayoutMode } from "../../lib/useLayoutMode";
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import {
  useLibraryStore,
  type SelectMode,
  type SortOrder,
  type TrackSort,
} from "../../stores/libraryStore";
import type { DownloadTask } from "../../types";
import { useQueueStore } from "../../stores/queueStore";
import type { FileDisposalMode, Track } from "../../types";
import { playTrack } from "../../lib/playTrack";
import { ContextMenu, EmptyState, InlineNotice } from "../common";

/** @deprecated 请从 `lib/playTrack` 引用；保留 re-export 以免旧 import 断掉。 */
export { PLAY_EVENT, playTrack, parsePlayRequest, type PlayRequest } from "../../lib/playTrack";

/**
 * 点播放条的「正在播」块时由 PlayerBar 广播：回到曲库页、看这首歌。
 * Workspace 接住它切页/拉抽屉，本表接住它把选中行滚回视野中央。
 * 定义放这儿而不是 PlayerBar：PlayerBar 已经 import 本文件（PLAY_EVENT），
 * 反向再 import 一个常量就成环了。
 */
export const DETAIL_EVENT = "kd:show-detail";

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

/** Camelot 色块。空值给虚线占位，保持列宽稳定。 */
export function CamelotChip({ code }: { code: string }) {
  if (!code) {
    return (
      <span className="kd-camelot" data-empty="true">
        {DASH}
      </span>
    );
  }
  return (
    <span
      className="kd-camelot"
      // 原色只负责提供色相；深浅主题各自决定填充、边框和文字亮度。
      style={{ "--kd-key-color": camelotColor(code) } as React.CSSProperties}
    >
      {code}
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
  { id: "rating", label: "评分", width: "4.2rem", key: "rating" },
];

/* ------------------------------------------------------------ 列的自由组合 */

/**
 * 列顺序 + 隐藏集合 + 自定义列宽，长期保存。和三栏换位、详情面板拖排同一套心智：
 * 拖一次、勾一次、拉一次，永远不用再想。存的是 id 列表而不是完整快照，
 * 理由同 PanelStack：以后加新列时旧存档不作废，新列自动排在默认位置。
 */
const COLUMN_PREFS_KEY = "kd-library-columns";
const INDEX_COL_KEY = "index";
const INDEX_DEFAULT_WIDTH = "3.2rem";

interface ColumnPrefs {
  order: string[];
  hidden: string[];
  /** 用户拖过的列宽（rem 字符串）。没出现的键走 COLUMNS / 序号默认值。 */
  widths: Record<string, string>;
}

const COLUMN_MIN_WIDTH: Record<string, string> = {
  index: "2.4rem",
  title: "8rem",
  artist: "3rem",
  album: "3rem",
  bpm: "2.8rem",
  camelot: "2.8rem",
  energy: "2.8rem",
  duration: "2.8rem",
  format: "2.6rem",
  rating: "3rem",
};

function rootFontPx(): number {
  if (typeof document === "undefined") return 16;
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

function remStringToPx(value: string): number {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return value.trim().endsWith("px") ? n : n * rootFontPx();
}

function pxToRemString(px: number): string {
  return `${Math.round((px / rootFontPx()) * 100) / 100}rem`;
}

function loadColumnPrefs(): ColumnPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLUMN_PREFS_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const { order, hidden, widths } = raw as Record<string, unknown>;
      const strings = (value: unknown) =>
        Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
      const widthMap: Record<string, string> = {};
      if (widths && typeof widths === "object") {
        for (const [key, value] of Object.entries(widths as Record<string, unknown>)) {
          if (typeof value === "string" && remStringToPx(value) > 0) widthMap[key] = value;
        }
      }
      // 标题列永远不准藏：它是唯一说明「这行是哪首歌」的列，藏掉整张表就没有主语了。
      // 在读档这一层拦，而不是只在菜单里禁用——存档被手改坏也不会出现无标题的表
      return {
        order: strings(order),
        hidden: strings(hidden).filter((key) => key !== "title"),
        widths: widthMap,
      };
    }
  } catch {
    // 存档坏了就用默认，不值得为它报错
  }
  return { order: [], hidden: [], widths: {} };
}

export interface TrackTableProps {
  tracks: Track[];
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
  selectedId: number | null;
  selectedIds: number[];
  sort: TrackSort;
  order: SortOrder;
  /** 副排序键：主键相同的那一撮再按它排。null = 只按主键。 */
  sort2: TrackSort | null;
  order2: SortOrder;
  /**
   * clickCount 透传 MouseEvent.detail：双击播放会先送来一下 detail=1 的单击，
   * 再补一下 detail=2。Workspace 靠它区分「单击=查看详情」和「双击=播放」——
   * 后者不该把详情面板弹出来挤压列表。
   */
  onSelect(id: number, mode: SelectMode, clickCount?: number): void;
  onSort(sort: TrackSort): void;
  onScrollEnd(): void;
  /** 在单个文件夹视图里才能行内拖动换位（顺序写进该文件夹的清单）。 */
  reorderable?: boolean;
  onReorder?(ids: number[], targetId: number, before: boolean): void;
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
function TrackCoverThumb({
  track,
  onTrackDragStart,
}: {
  track: Track;
  onTrackDragStart?: (event: React.DragEvent<HTMLSpanElement>) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [videoCover, setVideoCover] = useState("");
  const retryTimer = useRef<number | null>(null);
  const isVideo = isVideoTrack(track.format);

  useEffect(() => {
    setAttempt(0);
  }, [track.id, track.modified_at]);

  useEffect(() => {
    if (!isVideo) return;
    const controller = new AbortController();
    let alive = true;
    let objectUrl = "";
    setVideoCover("");

    void fetch(api.coverUrl(track.id, `${track.modified_at}-${attempt}`), {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((response) => {
        if (!response.ok) throw new Error(`封面 HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (alive) setVideoCover(objectUrl);
      })
      .catch(() => {
        if (!alive || controller.signal.aborted || attempt >= 12) return;
        // 后端热重启 / 首次抽帧排队时稍候再试。每次换 URL，失败缓存不会卡住重试。
        retryTimer.current = window.setTimeout(() => {
          retryTimer.current = null;
          setAttempt((value) => value + 1);
        }, 3000);
      });

    return () => {
      alive = false;
      controller.abort();
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attempt, isVideo, track.id, track.modified_at]);

  return (
    <span
      className="kd-thumb"
      draggable={Boolean(onTrackDragStart)}
      onDragStart={onTrackDragStart}
      title={onTrackDragStart ? "拖动封面移动所选曲目" : undefined}
    >
      {isVideo ? (
        videoCover ? <img key={videoCover} src={videoCover} alt="" draggable={false} /> : null
      ) : (
        <CoverImage src={api.coverUrl(track.id, track.modified_at)} loading="lazy" />
      )}
    </span>
  );
}

/** 每列的单元格。列可以被拖排 / 隐藏（见 COLUMN_PREFS_KEY），所以按 key 取，不写死顺序。 */
function trackCell(
  track: Track,
  key: string,
  selectionControl?: React.ReactNode,
  onTrackDragStart?: (event: React.DragEvent<HTMLSpanElement>) => void,
  onRate?: (rating: number) => void,
) {
  switch (key) {
    case "title":
      return (
        <td key={key} data-col="title" className="kd-td-strong" title={track.title || track.filename}>
          {selectionControl}
          {/* lazy：一页 200 行，只在滚到眼前时请求。视频首帧由 TrackCoverThumb
              在服务短暂重启或抽帧排队时重试，不能一次失败就永久变成灰格。 */}
          <TrackCoverThumb track={track} onTrackDragStart={onTrackDragStart} />
          {/* 同一首歌在两个文件夹里各出现一次时，这个标记回答"为什么"：
              不是占了两份空间，是同一份数据的两个名字。 */}
          {track.link && (
            <span
              className="kd-link-mark"
              title={track.link === "symlink" ? "符号链接" : "硬链接：和别处共用同一份文件"}
            >
              <Link2 size={11} />
            </span>
          )}
          {/* 媒介类型和链接状态都是这首文件的附属信息：排在封面后、标题前，
              有多个时并列显示，完整含义由悬停提示说明。 */}
          {isVideoTrack(track.format) && (
            <span className="kd-video-mark" title="视频" role="img" aria-label="视频">
              <Video size={11} aria-hidden="true" />
            </span>
          )}
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
          <CamelotChip code={track.camelot} />
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
    case "rating":
      return (
        <td key={key} data-col="rating">
          <span className="kd-table-rating" role="group" aria-label={`当前评分 ${track.rating || 0} 星`}>
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                draggable={false}
                aria-label={`${value} 星`}
                title={`${value} 星${track.rating === value ? "；再次点击清除评分" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRate?.(track.rating === value ? 0 : value);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <Star size={11} fill={value <= track.rating ? "currentColor" : "none"} />
              </button>
            ))}
          </span>
        </td>
      );
    default:
      return null;
  }
}

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

const PENDING_STATES = new Set(["queued", "running", "processing", "failed"]);

/**
 * 虚拟滚动的兜底行高（= --kd-row-h）。真实行高以渲染出来的第一行为准
 * （见 TrackTable 里的量测 effect），这里只是首帧还没量到时的占位。
 */
const FALLBACK_ROW_H = 36;

function pendingLabel(task: DownloadTask): string {
  if (task.state === "running") {
    const pct = Math.round(Math.max(0, Math.min(1, task.progress)) * 100);
    const action = task.kind === "vj_export" ? "导出中" : "下载中";
    return pct > 0 ? `${action} ${pct}%` : action;
  }
  if (task.state === "processing") {
    return task.kind === "vj_export" ? "正在生成 VJ" : "正在生成文件";
  }
  if (task.state === "failed") return task.error ? `失败：${task.error}` : "下载失败";
  if (task.state === "done") return "入库中";
  return "待下载";
}

function PendingStateMark({ task }: { task: DownloadTask }) {
  const label = pendingLabel(task);
  const icon =
    task.state === "running" || task.state === "processing" ? (
      <LoaderCircle size={12} className="kd-spin" />
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
function isPendingForFolder(task: DownloadTask, filterFolder: string, tracks: Track[]): boolean {
  if (!task.dest_dir || !sameFolderPath(task.dest_dir, filterFolder)) return false;
  if (PENDING_STATES.has(task.state)) return true;
  if (task.state !== "done") return false;
  if (task.track_id == null) return true;
  return !tracks.some((track) => track.id === task.track_id);
}

export function TrackTable({
  tracks,
  loading,
  layout,
  selectedId,
  selectedIds,
  sort,
  order,
  sort2,
  order2,
  onSelect,
  onSort,
  onScrollEnd,
  reorderable = false,
  onReorder,
}: TrackTableProps) {
  const loadingMore = useLibraryStore((state) => state.loadingMore);
  const queueView = useLibraryStore((state) => state.queueView);
  const filterFolder = useLibraryStore((state) => state.filter.folder);
  const filterQuery = useLibraryStore((state) => state.filter.q);
  const removeTracks = useLibraryStore((state) => state.removeTracks);
  const startAnalyze = useLibraryStore((state) => state.startAnalyze);
  const addToQueue = useQueueStore((state) => state.add);
  const removeFromQueue = useQueueStore((state) => state.remove);
  const widePlay = useTrackClickPrefs((state) => state.widePlay);
  const narrowPlay = useTrackClickPrefs((state) => state.narrowPlay);
  const clickAddNext = useTrackClickPrefs((state) => state.clickAddNext);
  const playClick = playClickForLayout({ widePlay, narrowPlay }, layout);
  const singleAddsNext = clickAddsNext({ widePlay, narrowPlay, clickAddNext }, layout);
  const copyToClipboard = useLibraryStore((state) => state.copyToClipboard);
  const updateTrack = useLibraryStore((state) => state.updateTrack);
  const selectionMode = useLibraryStore((state) => state.selectionMode);
  const setSelectionMode = useLibraryStore((state) => state.setSelectionMode);
  const downloadTasks = useDownloadStore((state) => state.list);
  const pendingDownloads = queueView
    ? []
    : downloadTasks.filter((task) => isPendingForFolder(task, filterFolder, tracks));
  const selected = new Set(selectedIds);
  const pressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef<number | null>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  /** 行内拖动的插入位置指示：悬停行上半 = 插到它前面。 */
  const [drop, setDrop] = useState<{ id: number; before: boolean } | null>(null);

  // Esc 的语义是取消这一轮显式批选：菜单、复选框和选区一起收掉。
  useEffect(() => {
    if (!selectionMode && selectedIds.length <= 1) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && !isEditable(event.target)) {
        event.preventDefault();
        useLibraryStore.getState().selectAll();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSelectionMode(false);
      useLibraryStore.getState().select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionMode, selectedIds.length]);

  /* ------------------------------------------------ 行右键菜单（多选操作） */
  /**
   * 能不能走系统回收站看**后端**跑在什么系统上——文件在它那台机器上。
   * 安卓/iOS 没有回收站，删除文件改成「点两次确认」的永久删除。
   * 拿不到 platform（Python sidecar 的 health 没这个键）按支持算：开发环境全是桌面。
   */
  const backendPlatform = useAppStore((state) => state.health?.platform ?? "");
  const trashSupported = backendPlatform !== "android" && backendPlatform !== "ios";
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; track: Track } | null>(null);
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
      resizeObserverRef.current?.disconnect();
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    },
    [],
  );

  /**
   * 本地曲目不用 WebKit 的原生 draggable：它经常把按住移动解释成框选/多选，
   * 或只发 dragstart 不发 drop。这里直接跟踪指针，松手时按坐标命中文件夹。
   */
  const beginTrackPointerDrag = (event: React.PointerEvent<HTMLTableRowElement>, track: Track) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, input, select, textarea, a, label")) return;

    pointerDragCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const ids = selected.has(track.id) ? [...selectedIds] : [track.id];
    let dragging = false;
    let ghost: HTMLDivElement | null = null;

    const clearTargets = () => {
      document
        .querySelectorAll<HTMLElement>("[data-kd-pointer-track-over]")
        .forEach((node) => node.removeAttribute("data-kd-pointer-track-over"));
    };
    const hitAt = (x: number, y: number) => document.elementFromPoint(x, y) as HTMLElement | null;
    const paintTarget = (x: number, y: number) => {
      clearTargets();
      const folder = folderDropElementAt(x, y);
      if (folder) {
        folder.setAttribute("data-kd-pointer-track-over", "folder");
        return;
      }
      const hit = hitAt(x, y);
      const trash = hit?.closest<HTMLElement>("[data-kd-track-trash-target]");
      if (trash) {
        trash.setAttribute("data-kd-pointer-track-over", "trash");
        return;
      }
      if (!reorderable) return;
      const row = hit?.closest<HTMLElement>("tr[data-kd-track-id]");
      if (!row) return;
      const rect = row.getBoundingClientRect();
      row.setAttribute("data-kd-pointer-track-over", y < rect.top + rect.height / 2 ? "before" : "after");
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      clearTargets();
      ghost?.remove();
      ghost = null;
      delete document.body.dataset.kdTrackPointerDragging;
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
      ghost = document.createElement("div");
      ghost.className = "kd-track-pointer-ghost";
      ghost.textContent = ids.length > 1 ? `移动 ${ids.length} 首曲目` : (track.title || track.filename);
      document.body.appendChild(ghost);
      ghost.style.transform = `translate3d(${x + 12}px, ${y + 12}px, 0)`;
      paintTarget(x, y);
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const distance = Math.hypot(move.clientX - startX, move.clientY - startY);
      if (!dragging && distance < 5) return;
      move.preventDefault();
      if (!dragging) activate(move.clientX, move.clientY);
      ghost?.style.setProperty("transform", `translate3d(${move.clientX + 12}px, ${move.clientY + 12}px, 0)`);
      paintTarget(move.clientX, move.clientY);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      const folder = folderDropElementAt(up.clientX, up.clientY);
      const hit = hitAt(up.clientX, up.clientY);
      const trash = hit?.closest<HTMLElement>("[data-kd-track-trash-target]");
      const row = reorderable ? hit?.closest<HTMLElement>("tr[data-kd-track-id]") : null;
      const rowEdge = row?.getAttribute("data-kd-pointer-track-over");
      cleanup();
      if (!dragging) return;
      up.preventDefault();

      if (folder) {
        const dest = folder.getAttribute(FOLDER_DROP_PATH_ATTR)?.trim() ?? "";
        const claimed = claimActiveTrackDragIds();
        if (!dest || claimed.length === 0) return;
        const op = up.altKey ? "move" : "link";
        void useLibraryStore
          .getState()
          .applyFolderOp(claimed, dest, op)
          .then((result) => {
            const failed = Object.keys(result.errors).length;
            if (failed > 0) setNotice(`已${op === "link" ? "链接" : "移动"} ${result.track_ids.length} 首，${failed} 首失败`);
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
      if (row && (rowEdge === "before" || rowEdge === "after")) {
        const targetId = Number(row.dataset.kdTrackId);
        finishTrackDrop();
        if (Number.isFinite(targetId) && !ids.includes(targetId)) {
          onReorder?.(ids, targetId, rowEdge === "before");
        }
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
  const beginLongPress = (track: Track, x: number, y: number) => {
    cancelPress();
    pressTimerRef.current = window.setTimeout(() => {
      setRowMenu({ x, y, track });
      suppressClickRef.current = track.id;
      pressTimerRef.current = null;
    }, 480);
  };

  // 菜单开合都退膛：残留的"已确认"状态比误删只差一次点击
  useEffect(() => setArmed(false), [rowMenu]);

  /** 菜单操作作用的曲目：右键落在选区里 = 整批，落在选区外的行 = 只有它。 */
  const menuIds = rowMenu
    ? selected.has(rowMenu.track.id)
      ? selectedIds
      : [rowMenu.track.id]
    : [];
  const menuTracks = rowMenu
    ? menuIds.flatMap((id) => {
        const track = tracks.find((item) => item.id === id);
        return track ? [track] : [];
      })
    : [];

  const playFromTable = (track: Track) => {
    // 临时列表是待播清单，直接点播也算消费；否则 A/B 队列里手动播 A，
    // 自动续播会先播 B，再把仍留在队列里的 A 播第二遍。
    if (queueView) removeFromQueue([track.id]);
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
      const wanted =
        event.key === "Delete" || (event.key === "Backspace" && (event.metaKey || event.ctrlKey));
      if (!wanted) return;
      const ids = useLibraryStore.getState().selectedIds;
      if (ids.length === 0) return;
      event.preventDefault();
      deleteWithNotice(ids, "trash");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // deleteWithNotice 闭包里只有稳定的 store action 和 setNotice，不用进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trashSupported]);

  useEffect(() => {
    const onTrashDrop = (event: Event) => {
      const ids = (event as CustomEvent<TrackDragDetail>).detail?.ids ?? [];
      if (ids.length === 0) return;
      if (queueView) {
        removeFromQueue(ids);
        return;
      }
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
  }, [queueView, trashSupported, removeFromQueue]);

  /* ------------------------------------------------ 回到正在播的那首 */
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** 虚拟滚动需要的滚动位置/视口高度；一帧最多重算一次（见 onScroll）。 */
  const [view, setView] = useState({ top: 0, height: 0 });
  const [rowH, setRowH] = useState(FALLBACK_ROW_H);
  const rowHRef = useRef(FALLBACK_ROW_H);
  const scrollRafRef = useRef(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  /** 滚动容器 ref：身份必须稳定（见 JSX 处的注释）。值没变就不 setState，
      否则 ResizeObserver 的初次回调会和自己触发的重渲染互相喂食。 */
  const trackScrollerRef = useCallback((el: HTMLDivElement | null) => {
    scrollerRef.current = el;
    observeTrackScroller(el);
    // 视口高度决定渲染窗口：面板拖宽拖窄、窗口缩放都要重算。
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (el) {
      const updateView = () =>
        setView((current) => {
          const top = el.scrollTop;
          const height = el.clientHeight;
          return current.top === top && current.height === height ? current : { top, height };
        });
      updateView();
      const observer = new ResizeObserver(updateView);
      observer.observe(el);
      resizeObserverRef.current = observer;
    }
  }, []);
  // centerSelected 挂在 [] 上，靠 ref 拿最新值，不为它重挂全局事件
  const tracksRef = useRef(tracks);
  const selectedIdRef = useRef(selectedId);
  const pendingCountRef = useRef(0);
  useEffect(() => {
    const centerSelected = () => {
      const box = scrollerRef.current;
      if (!box) return;
      const row = box.querySelector('tr[data-focus="true"]');
      if (row) {
        row.scrollIntoView({ block: "center" });
        return;
      }
      // 虚拟滚动下选中行多半没渲染，scrollIntoView 找不到它：
      // 按它在列表里的序号直接算滚动位置（行高恒定，见下方虚拟滚动注释）。
      const index = tracksRef.current.findIndex((track) => track.id === selectedIdRef.current);
      if (index < 0) return;
      const height = rowHRef.current;
      box.scrollTop =
        pendingCountRef.current * height + index * height - (box.clientHeight - height) / 2;
    };
    // 挂载时先滚一次：从搜索页点「正在播」跳回曲库时，这张表是重新挂的，
    // 滚动位置本来就丢了——与其停在列表顶端，不如直接停在要看的那首上。
    // 选中行不在已加载的分页里就什么都不做（1400 首只挂了前几页是常态）。
    centerSelected();
    // 本来就停在曲库页时点「正在播」不会重挂表，靠事件补同一件事。
    // 等两帧：事件比"选中态渲染进 DOM"先到，立刻滚会找不到 data-focus 行
    const onDetail = () => {
      requestAnimationFrame(() => requestAnimationFrame(centerSelected));
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
  const colPrefsRef = useRef(colPrefs);
  colPrefsRef.current = colPrefs;

  const saveColPrefs = (next: ColumnPrefs) => {
    localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify(next));
    setColPrefs(next);
  };

  const widthFor = (key: string, fallback: string) => colPrefs.widths[key] ?? fallback;

  const beginColumnResize = (key: string, event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const th = event.currentTarget.parentElement;
    if (!th) return;
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    const minPx = remStringToPx(COLUMN_MIN_WIDTH[key] ?? "2.8rem");
    setResizingCol(key);
    document.body.dataset.kdColResizing = "true";

    const onMove = (moveEvent: PointerEvent) => {
      const next = pxToRemString(Math.max(minPx, startWidth + (moveEvent.clientX - startX)));
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
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.removeAttribute("data-kd-col-resizing");
      setResizingCol(null);
      suppressSortClickRef.current = true;
      // 松手时把最新宽度落盘；拖动过程只 setState，避免每个像素写 localStorage
      localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify(colPrefsRef.current));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // 没记忆过的列排 MAX：stable sort 让它们之间保持 COLUMNS 里的默认相对顺序
  const colRank = (key: string) => {
    const index = colPrefs.order.indexOf(key);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const orderedColumns = [...COLUMNS].sort((a, b) => colRank(a.key) - colRank(b.key));
  const colIds = orderedColumns.map((column) => column.key);
  const visibleColumns = orderedColumns.filter((column) => !colPrefs.hidden.includes(column.key));
  const indexWidth = widthFor(INDEX_COL_KEY, INDEX_DEFAULT_WIDTH);
  const tableMinWidthPx =
    remStringToPx(indexWidth) +
    visibleColumns.reduce(
      (sum, column) => sum + remStringToPx(widthFor(column.key, column.width ?? "4rem")),
      0,
    );

  /* ---------------------------------------------------- 虚拟滚动 */
  /**
   * 曲库上千首时把每一行都挂进 DOM 是滚动卡顿和空白的根源：
   * 每次滚动都要重排上千个带封面的格子，懒加载的图片追不上滚动就留出白块。
   * 行高恒定（td 全是 nowrap + 固定 --kd-row-h，内容撑不高），
   * 所以只渲染视口附近的一小段，上下各垫一根占位行把总高度撑住——
   * 滚动条位置、行序号、拖放落点都和全量渲染时一致。
   */
  tracksRef.current = tracks;
  selectedIdRef.current = selectedId;
  pendingCountRef.current = pendingDownloads.length;
  // 行高以真实渲染出来的第一行为准（字号/主题变了它才变），不靠猜。
  useEffect(() => {
    const row = scrollerRef.current?.querySelector<HTMLTableRowElement>("tr[data-kd-track-id]");
    const height = row?.getBoundingClientRect().height ?? 0;
    if (height > 0 && Math.abs(height - rowHRef.current) > 0.5) {
      rowHRef.current = height;
      setRowH(height);
    }
  });
  // 占位行上方还有若干「待下载」行，算窗口时先把它们的高度扣掉。
  const pendingH = pendingDownloads.length * rowH;
  // 上下各多渲染约一屏：快速滚动时新行已经在 DOM 里，不会闪空白。
  const overscan = Math.max(10, Math.ceil(view.height / rowH));
  const winStart =
    view.height > 0 ? Math.max(0, Math.floor((view.top - pendingH) / rowH) - overscan) : 0;
  const winEnd =
    view.height > 0
      ? Math.min(tracks.length, Math.ceil((view.top + view.height - pendingH) / rowH) + overscan)
      : // 首帧还没量到视口：先渲染一小段，ref 回调量到高度后立刻换成真实窗口。
        // 不能一次全渲染——1400 行一次性进 DOM 正是要避开的那个卡顿。
        Math.min(tracks.length, 60);
  const windowedTracks = tracks.slice(winStart, winEnd);

  const moveColumn = (from: string, to: string) => {
    if (from === to) return;
    // 以当前看到的顺序为基准重排，理由同 PanelStack.commit。
    // 插入点用未过滤的 indexOf：从左边拖来落在目标右侧、从右边拖来落在左侧，
    // 这样拖到最右也够得着（落点竖线跟着画在对应的一侧，见 data-col-drop）
    const next = colIds.filter((id) => id !== from);
    next.splice(colIds.indexOf(to), 0, from);
    saveColPrefs({ ...colPrefs, order: next });
  };

  if (loading && tracks.length === 0 && pendingDownloads.length === 0) {
    return <EmptyState icon={<LoaderCircle className="kd-spin" size={22} />} title="正在读取曲库" />;
  }

  if (tracks.length === 0 && pendingDownloads.length === 0) {
    if (queueView) {
      return (
        <EmptyState
          icon={<ListMusic size={22} />}
          title="临时列表是空的"
          hint="回到全部曲目后右键加入；也可以复制曲目，再在这里按 Cmd/Ctrl+V。"
        />
      );
    }
    const query = filterQuery.trim();
    return (
      <EmptyState
        icon={<FolderOpen size={22} />}
        title={query ? "没有匹配的曲目" : filterFolder ? "这个文件夹是空的" : "还没有曲目"}
        hint={query ? "换个曲目名称试试" : "把音频或视频拖进来"}
      />
    );
  }

  return (
    <div
      className="kd-scroll"
      style={{ height: "100%" }}
      // 可视区域优先分析要知道"曲目表滚到哪了"。不挂这个 ref 它也能靠
      // DOM 自己找到表（认 td[data-col="title"]），但那条路在列结构变动时
      // 会静默失效——显式挂上就不再依赖任何选择器。
      // scrollerRef 蹭同一个 ref：滚回选中行（见上面 DETAIL_EVENT）也要这个容器。
      // ref 必须是稳定函数（useCallback）：内联箭头每次渲染都是新身份，React 会
      // 反复 detach/attach，attach 里的 setView 又触发渲染——死循环就是这么来的。
      // setView 走相等守卫：值没变就返回旧对象， ResizeObserver 的初次回调
      // 和滚动重算都不会再空转渲染。
      ref={trackScrollerRef}
      onScroll={(event) => {
        const el = event.currentTarget;
        // 距底 200px 就预取下一页，滚到底再等请求会有明显空白
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) onScrollEnd();
        // 滚动事件比帧率高得多，每个事件都 setState 重渲染就是卡顿本身；
        // 压到一帧一次，滚动和重绘对齐。
        if (scrollRafRef.current) return;
        scrollRafRef.current = requestAnimationFrame(() => {
          scrollRafRef.current = 0;
          const node = scrollerRef.current;
          if (node) setView({ top: node.scrollTop, height: node.clientHeight });
        });
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
        style={{ minWidth: tableMinWidthPx }}
      >
        <thead>
          {/* 右键任意列头 = 选列菜单；拖列头 = 换列序；列头右缘把手 = 调列宽。
              拖和点不冲突：一旦触发 dragstart，浏览器就不再发那次 click */}
          <tr
            onContextMenu={(event) => {
              event.preventDefault();
              setColMenu({ x: event.clientX, y: event.clientY });
            }}
          >
            <th data-col="index" style={{ width: indexWidth }} title="当前列表中的序号">
              序号
              <span
                className="kd-col-resize"
                data-active={resizingCol === INDEX_COL_KEY ? "true" : undefined}
                onPointerDown={(event) => beginColumnResize(INDEX_COL_KEY, event)}
                onClick={(event) => event.stopPropagation()}
                aria-hidden="true"
              />
            </th>
            {visibleColumns.map((column) => {
              const colWidth = widthFor(column.key, column.width ?? "4rem");
              return (
              <th
                key={column.key}
                data-col={column.key}
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
                draggable={!resizingCol}
                onDragStart={(event) => {
                  if (resizingCol) {
                    event.preventDefault();
                    return;
                  }
                  setDragCol(column.key);
                  event.dataTransfer.effectAllowed = "move";
                  // Firefox 不设 data 就不触发 drag 事件
                  event.dataTransfer.setData("text/plain", column.key);
                }}
                onDragEnd={() => {
                  setDragCol(null);
                  setOverCol(null);
                }}
                onDragOver={(event) => {
                  // 只认自家的列拖拽：行拖拽和外来文件都不该在列头上放行
                  if (!dragCol || dragCol === column.key || resizingCol) return;
                  event.preventDefault();
                  setOverCol(column.key);
                }}
                onDragLeave={() =>
                  setOverCol((current) => (current === column.key ? null : current))
                }
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragCol) moveColumn(dragCol, column.key);
                  setDragCol(null);
                  setOverCol(null);
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
                    ? column.id === sort
                      ? "再点一下换方向；方向转回来那一下取消这一列的排序"
                      : column.id === sort2
                        ? "副排序键。再点一下把它升为主排序（原主排序降为副）"
                        : "点一下按它排。已经有主排序时，这一下加的是副排序"
                    : "拖动列头换列序；右缘拖动调列宽；右键选择显示哪些列"
                }
              >
                {column.label}
                {/* 主、副排序仍由 store 中的 sort / sort2 区分；表头只显示方向，
                    避免带圈数字与列名字号不协调。层级说明保留在表头 title 中。 */}
                {column.id !== null && column.id === sort && (
                  <span className="kd-sort-mark" aria-label="主排序">
                    {order === "asc" ? "↑" : "↓"}
                  </span>
                )}
                {column.id !== null && column.id !== sort && column.id === sort2 && (
                  <span className="kd-sort-mark" aria-label="副排序">
                    {order2 === "asc" ? "↑" : "↓"}
                  </span>
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
          </tr>
        </thead>
        <tbody>
          {pendingDownloads.map((task) => (
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
              <td data-col="index" aria-label="待下载曲目">…</td>
              {visibleColumns.map((column) => {
                if (column.key === "title") {
                  return (
                    <td key={column.key} data-col="title" className="kd-td-strong" title={task.title || "未命名"}>
                      <span className="kd-pending-title">
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
                        {(task.kind === "video" || task.kind === "vj_export") && (
                          <span className="kd-video-mark" title="视频" role="img" aria-label="视频">
                            <Video size={11} aria-hidden="true" />
                          </span>
                        )}
                        <PendingStateMark task={task} />
                        <span className="kd-truncate">{task.title || "未命名"}</span>
                      </span>
                    </td>
                  );
                }
                if (column.key === "artist") {
                  return <td key={column.key} data-col="artist" title={task.artist || undefined}><span className="kd-truncate">{task.artist || DASH}</span></td>;
                }
                if (column.key === "format") {
                  return <td key={column.key} data-col="format">{task.kind === "video" || task.kind === "vj_export" ? "视频" : task.quality || DASH}</td>;
                }
                return <td key={column.key} data-col={column.key} />;
              })}
            </tr>
          ))}
          {/* 虚拟滚动：只渲染视口附近的行，上方的高度由这根占位行撑住。
              行序号、拖放、选中都按 tracks 里的真实下标走，不被窗口影响。 */}
          {winStart > 0 && (
            <tr data-spacer="top" aria-hidden="true">
              <td colSpan={visibleColumns.length + 1} style={{ height: winStart * rowH }} />
            </tr>
          )}
          {windowedTracks.map((track, index) => (
            <tr
              key={track.id}
              aria-selected={selected.has(track.id)}
              data-kd-track-id={track.id}
              data-focus={track.id === selectedId ? "true" : undefined}
              data-drop={drop?.id === track.id ? (drop.before ? "before" : "after") : undefined}
              data-selecting={selectionMode ? "true" : undefined}
              // 曲目移动走 pointer 状态机，不再把“框选文字还是原生拖动”交给 WKWebView 猜。
              draggable={false}
              onClick={(event) => {
                if (hasTextSelectionWithin(event.currentTarget)) return;
                if (suppressClickRef.current === track.id) {
                  suppressClickRef.current = null;
                  return;
                }
                if (selectionMode) {
                  onSelect(track.id, "toggle");
                  return;
                }
                const mode = selectMode(event);
                onSelect(track.id, mode, event.detail);
                // 带修饰键的多选不算——那是在攒选区。
                if (mode !== "replace") return;
                // 单击播放 / 单击加入下一首（仅播放手势为双击时）按设置走。
                // 详情入口仍留给播放条唱盘（见 PlayerBar.DETAIL_EVENT）。
                if (playClick === "single") {
                  playFromTable(track);
                } else if (singleAddsNext) {
                  addToQueue([track], true);
                }
              }}
              onPointerDown={(event) => {
                if (event.pointerType === "mouse") {
                  beginTrackPointerDrag(event, track);
                } else {
                  beginLongPress(track, event.clientX, event.clientY);
                }
              }}
              onPointerUp={cancelPress}
              onPointerCancel={cancelPress}
              onPointerLeave={cancelPress}
              onDoubleClick={() => {
                if (!selectionMode && playClick === "double") playFromTable(track);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                cancelPress();
                setPendingMenu(null);
                // 右键只开菜单；用户明确点菜单里的「选择」后才显示复选框。
                setRowMenu({ x: event.clientX, y: event.clientY, track });
              }}
              // 同一份拖拽载荷两种落点：拖到左边文件夹树=移动文件，
              // 落在列表行上=换顺序（只在单文件夹视图开）。
              onDragOver={
                reorderable
                  ? (event) => {
                      if (!isTrackDrag(event)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      const rect = event.currentTarget.getBoundingClientRect();
                      const before = event.clientY < rect.top + rect.height / 2;
                      setDrop((current) =>
                        current?.id === track.id && current.before === before
                          ? current
                          : { id: track.id, before },
                      );
                    }
                  : undefined
              }
              onDragLeave={
                reorderable
                  ? () => setDrop((current) => (current?.id === track.id ? null : current))
                  : undefined
              }
              onDrop={
                reorderable
                  ? (event) => {
                      const target = drop;
                      setDrop(null);
                      if (!target || target.id !== track.id) return;
                      const ids = readTrackDragIds(event.dataTransfer);
                      finishTrackDrop();
                      if (ids.length === 0) return;
                      event.preventDefault();
                      if (!ids.includes(track.id)) onReorder?.(ids, track.id, target.before);
                    }
                  : undefined
              }
            >
              <td data-col="index">{winStart + index + 1}</td>
              {visibleColumns.map((column) => {
                const cell = trackCell(
                  track,
                  column.key,
                  column.key === "title" && selectionMode ? (
                    <button
                      type="button"
                      className="kd-row-select"
                      aria-label={selected.has(track.id) ? "取消选择" : "选择曲目"}
                      aria-pressed={selected.has(track.id)}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(track.id, "toggle");
                      }}
                    >
                      <Check size={9} />
                    </button>
                  ) : undefined,
                  undefined,
                  column.key === "rating"
                    ? (rating) => {
                        void updateTrack(track.id, { rating });
                      }
                    : undefined,
                ) as React.ReactElement<React.TdHTMLAttributes<HTMLTableCellElement>>;
                // 普通 span 是 WebKit 最稳定的拖动源。让它铺满格子，避免只有封面
                // 那十几个像素能拖；td + tr 则作为旧版 WebKit 的冗余兜底。
                const dragSurface = (
                  <span className="kd-track-drag-surface" draggable={false}>
                    {cell.props.children}
                  </span>
                );
                return cloneElement(cell, {
                  draggable: false,
                }, dragSurface);
              })}
            </tr>
          ))}
          {winEnd < tracks.length && (
            <tr data-spacer="bottom" aria-hidden="true">
              <td
                colSpan={visibleColumns.length + 1}
                style={{ height: (tracks.length - winEnd) * rowH }}
              />
            </tr>
          )}
        </tbody>
      </table>
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
              localStorage.removeItem(COLUMN_PREFS_KEY);
              setColPrefs({ order: [], hidden: [], widths: {} });
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
              if (!selected.has(rowMenu.track.id)) onSelect(rowMenu.track.id, "toggle");
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
          <button
            type="button"
            onClick={() => {
              copyToClipboard("link");
              setRowMenu(null);
            }}
          >
            <Copy size={12} />
            复制曲目{menuIds.length > 1 ? `（${menuIds.length} 首）` : ""}
          </button>
          <button type="button" onClick={() => { setRowMenu(null); void startAnalyze(menuIds, true); }}>
            <BarChart3 size={12} />
            重新分析{menuIds.length > 1 ? `（${menuIds.length} 首）` : ""}
          </button>
          <button
            type="button"
            onClick={() => {
              setRowMenu(null);
              addToQueue(menuTracks);
            }}
          >
            <ListMusic size={12} />
            加入临时列表{menuTracks.length > 1 ? `（${menuTracks.length} 首）` : ""}
          </button>
          <button
            type="button"
            onClick={() => {
              setRowMenu(null);
              addToQueue(menuTracks, true);
            }}
          >
            <ListStart size={12} />
            下一首播放{menuTracks.length > 1 ? `（${menuTracks.length} 首）` : ""}
          </button>
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
          <button type="button" onClick={() => runDelete("keep")}>
            <ListX size={12} />
            移出曲库{menuIds.length > 1 ? `（${menuIds.length} 首）` : ""}
          </button>
        </ContextMenu>
      )}
      {/* 删除失败的原因就近浮在滚动区里：表格没有自己的状态栏 */}
      {notice && (
        <div className="kd-table-notice">
          <InlineNotice text={notice} onDismiss={() => setNotice("")} />
        </div>
      )}
      {loadingMore && (
        <div className="kd-row kd-muted" style={{ justifyContent: "center", padding: "0.6rem" }}>
          <LoaderCircle className="kd-spin" size={13} /> 加载更多
        </div>
      )}
    </div>
  );
}
