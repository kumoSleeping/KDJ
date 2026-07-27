import { cloneElement, useEffect, useRef, useState } from "react";
import {
  Check,
  BarChart3,
  Copy,
  FolderOpen,
  FolderSearch,
  Link2,
  ListMusic,
  ListStart,
  ListX,
  LoaderCircle,
  Play,
  RotateCcw,
  Star,
  Trash2,
} from "lucide-react";
import { api } from "../../lib/api";
import { hasTextSelectionWithin } from "../../lib/textSelection";
import { observeTrackScroller } from "../../lib/autoAnalyze";
import { getBridge } from "../../lib/bridge";
import { isEditable } from "../../lib/useLibraryClipboard";
import { camelotColor } from "../../lib/camelot";
import {
  announceTrackDrag,
  endTrackDrag,
  TRACK_TRASH_DROP_EVENT,
  type TrackDragDetail,
} from "../../lib/trackDrag";
import { DASH, formatBpm, formatDuration, isVideoTrack } from "../../lib/format";
import type { LayoutMode } from "../../lib/useLayoutMode";
import { useAppStore } from "../../stores/appStore";
import {
  useLibraryStore,
  type SelectMode,
  type SortOrder,
  type TrackSort,
} from "../../stores/libraryStore";
import { useQueueStore } from "../../stores/queueStore";
import type { FileDisposalMode, Track } from "../../types";
import { Button, EmptyState, InlineNotice, SelectionBar } from "../common";
import { pickAndScanFolders, TRACK_DND_TYPE } from "./FolderTree";

/** 双击曲目 = 播放。PlayerBar 监听同名事件，两边不用互相持有引用。 */
export const PLAY_EVENT = "kd:play";

export function playTrack(track: Track): void {
  window.dispatchEvent(new CustomEvent<Track>(PLAY_EVENT, { detail: track }));
}

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
 * 列顺序 + 隐藏集合，长期保存。和三栏换位、详情面板拖排同一套心智：
 * 拖一次、勾一次，永远不用再想。存的是 id 列表而不是完整快照，
 * 理由同 PanelStack：以后加新列时旧存档不作废，新列自动排在默认位置。
 */
const COLUMN_PREFS_KEY = "kd-library-columns";

interface ColumnPrefs {
  order: string[];
  hidden: string[];
}

function loadColumnPrefs(): ColumnPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLUMN_PREFS_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const { order, hidden } = raw as Record<string, unknown>;
      const strings = (value: unknown) =>
        Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
      // 标题列永远不准藏：它是唯一说明「这行是哪首歌」的列，藏掉整张表就没有主语了。
      // 在读档这一层拦，而不是只在菜单里禁用——存档被手改坏也不会出现无标题的表
      return { order: strings(order), hidden: strings(hidden).filter((key) => key !== "title") };
    }
  } catch {
    // 存档坏了就用默认，不值得为它报错
  }
  return { order: [], hidden: [] };
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
  onSelect(id: number, mode: SelectMode): void;
  onSort(sort: TrackSort): void;
  onScrollEnd(): void;
  /** 在单个文件夹视图里才能行内拖动换位（顺序写进该文件夹的清单）。 */
  reorderable?: boolean;
  onReorder?(ids: number[], targetId: number, before: boolean): void;
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
          {/* 内嵌封面缩略图。没图时 onError 藏掉 img，底下的灰格子当占位，
              行高不会跳。lazy：一页 200 行，只拉滚到眼前的。
              版本号挂 modified_at：换封面会更新它，列表里的小图才能跟着换——
              封面响应带 max-age=3600，不带版本号要干等缓存过期。 */}
          <span
            className="kd-thumb"
            draggable={Boolean(onTrackDragStart)}
            onDragStart={onTrackDragStart}
            title={onTrackDragStart ? "拖动封面移动所选曲目" : undefined}
          >
            <img
              src={api.coverUrl(track.id, track.modified_at)}
              alt=""
              loading="lazy"
              draggable={false}
              onError={(event) => {
                event.currentTarget.style.visibility = "hidden";
              }}
            />
          </span>
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
          {/* 视频角标：曲库里混着 VJ 素材和 MV，不标一下和音频完全分不出来。
              紧贴标题文字放，读起来是「[封面] 视频 标题」。
              中性色不用红色——这是状态不是动作。 */}
          {isVideoTrack(track.format) && <span className="kd-badge-video">视频</span>}
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
        <td key={key} data-col="album" className="kd-muted" title={track.album}>
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
  const removeTracks = useLibraryStore((state) => state.removeTracks);
  const startAnalyze = useLibraryStore((state) => state.startAnalyze);
  const addToQueue = useQueueStore((state) => state.add);
  const removeFromQueue = useQueueStore((state) => state.remove);
  const copyToClipboard = useLibraryStore((state) => state.copyToClipboard);
  const updateTrack = useLibraryStore((state) => state.updateTrack);
  const selected = new Set(selectedIds);
  /** 桌面右键 / 触屏长按后才显示行内小复选框；Cmd/Ctrl 多选不需要它。 */
  const [selectionMode, setSelectionMode] = useState(false);
  const pressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef<number | null>(null);
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
  /** 永久删除的二次确认：第一次点只是上膛，菜单一关就退膛。 */
  const [armed, setArmed] = useState(false);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  /** 删除失败的原因。表格没有别的报错位置，就近显示在滚动区顶部。 */
  const [notice, setNotice] = useState("");

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

  // 点别处 / Esc 关掉行菜单（和列菜单同一套；两个菜单不会同时开）
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
  useEffect(() => {
    const centerSelected = () =>
      scrollerRef.current
        ?.querySelector('tr[data-focus="true"]')
        ?.scrollIntoView({ block: "center" });
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

  /* ---------------------------------------------------- 列拖排 / 显隐 */
  const [colPrefs, setColPrefs] = useState(loadColumnPrefs);
  /** 正在拖的列头 id / 悬停到哪个列头上（画落点竖线用）。 */
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  /** 右键列头弹出的「选列」菜单的位置。null = 没开。 */
  const [colMenu, setColMenu] = useState<{ x: number; y: number } | null>(null);
  const colMenuRef = useRef<HTMLDivElement | null>(null);

  // 点别处 / 按 Esc 关掉选列菜单（同 FolderTree 的右键菜单）
  useEffect(() => {
    if (!colMenu) return;
    const close = (event: MouseEvent) => {
      if (!colMenuRef.current?.contains(event.target as Node)) setColMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setColMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [colMenu]);

  const saveColPrefs = (next: ColumnPrefs) => {
    localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify(next));
    setColPrefs(next);
  };

  // 没记录过的列排 MAX：stable sort 让它们之间保持 COLUMNS 里的默认相对顺序
  const colRank = (key: string) => {
    const index = colPrefs.order.indexOf(key);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const orderedColumns = [...COLUMNS].sort((a, b) => colRank(a.key) - colRank(b.key));
  const colIds = orderedColumns.map((column) => column.key);
  const visibleColumns = orderedColumns.filter((column) => !colPrefs.hidden.includes(column.key));

  const moveColumn = (from: string, to: string) => {
    if (from === to) return;
    // 以当前看到的顺序为基准重排，理由同 PanelStack.commit。
    // 插入点用未过滤的 indexOf：从左边拖来落在目标右侧、从右边拖来落在左侧，
    // 这样拖到最右也够得着（落点竖线跟着画在对应的一侧，见 data-col-drop）
    const next = colIds.filter((id) => id !== from);
    next.splice(colIds.indexOf(to), 0, from);
    saveColPrefs({ ...colPrefs, order: next });
  };

  if (loading && tracks.length === 0) {
    return <EmptyState icon={<LoaderCircle className="kd-spin" size={22} />} title="正在读取曲库" />;
  }

  if (tracks.length === 0) {
    if (queueView) {
      return (
        <EmptyState
          icon={<ListMusic size={22} />}
          title="临时列表是空的"
          hint="回到全部曲目后右键加入；也可以复制曲目，再在这里按 Cmd/Ctrl+V。"
        />
      );
    }
    return (
      <EmptyState
        icon={<FolderSearch size={22} />}
        title="把本地音乐带进 KDJ"
        hint="选择音乐文件夹后，曲目会自动导入并在后台分析 BPM、调号和能量；也可以直接用顶部搜索下载歌曲。"
        action={
          <Button variant="primary" onClick={() => void pickAndScanFolders()}>
            添加音乐文件夹
          </Button>
        }
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
      // scrollerRef 蹭同一个 ref：滚回选中行（见上面 DETAIL_EVENT）也要这个容器
      ref={(el) => {
        scrollerRef.current = el;
        observeTrackScroller(el);
      }}
      onScroll={(event) => {
        const el = event.currentTarget;
        // 距底 200px 就预取下一页，滚到底再等请求会有明显空白
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) onScrollEnd();
      }}
    >
      {(selectionMode || selectedIds.length > 1) && (
        <SelectionBar
          count={selectedIds.length}
          onSelectAll={() => useLibraryStore.getState().selectAll()}
          onClear={() => useLibraryStore.getState().select(null)}
          onDone={() => {
            setSelectionMode(false);
            useLibraryStore.getState().select(null);
          }}
        >
          <Button variant="ghost" size="sm" disabled={selectedIds.length === 0} onClick={() => copyToClipboard("link")}>
            <Copy size={12} /> 复制
          </Button>
          <Button variant="ghost" size="sm" disabled={selectedIds.length === 0} onClick={() => copyToClipboard("move")}>
            剪切
          </Button>
        </SelectionBar>
      )}
      {/* data-kind 区分曲库表和搜索结果表（两者共用 .kd-table，但结果表里有
          视频大行那套自排版，套不得两行式）；data-layout 是两行式的开关，
          见 TrackTableProps.layout 里为什么不能交给容器宽度判。 */}
      <table className="kd-table" data-kind="library" data-layout={layout}>
        <thead>
          {/* 右键任意列头 = 选列菜单；拖列头 = 换列序。
              拖和点不冲突：一旦触发 dragstart，浏览器就不再发那次 click */}
          <tr
            onContextMenu={(event) => {
              event.preventDefault();
              setColMenu({ x: event.clientX, y: event.clientY });
            }}
          >
            {visibleColumns.map((column) => (
              <th
                key={column.key}
                data-col={column.key}
                style={column.width ? { width: column.width } : undefined}
                className={column.align === "num" ? "kd-td-num" : undefined}
                data-sortable={column.id ? "true" : undefined}
                onClick={column.id ? () => onSort(column.id as TrackSort) : undefined}
                data-sort={
                  column.id !== null
                    ? column.id === sort
                      ? "1"
                      : column.id === sort2
                        ? "2"
                        : undefined
                    : undefined
                }
                draggable
                onDragStart={(event) => {
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
                  if (!dragCol || dragCol === column.key) return;
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
                    : "拖动列头换列序；右键选择显示哪些列"
                }
              >
                {column.label}
                {/* ①②：哪个是主、哪个是副，光靠箭头分不出来。
                    数字标出层级，箭头标出方向，两件事各归各的符号。 */}
                {column.id !== null && column.id === sort && (
                  <span className="kd-sort-mark">①{order === "asc" ? "↑" : "↓"}</span>
                )}
                {column.id !== null && column.id !== sort && column.id === sort2 && (
                  <span className="kd-sort-mark" data-second="true">
                    ②{order2 === "asc" ? "↑" : "↓"}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tracks.map((track) => (
            <tr
              key={track.id}
              aria-selected={selected.has(track.id)}
              data-focus={track.id === selectedId ? "true" : undefined}
              data-drop={drop?.id === track.id ? (drop.before ? "before" : "after") : undefined}
              data-selecting={selectionMode ? "true" : undefined}
              // 普通单选行保留文字框选；Cmd/Ctrl 形成真正的多选后，整行都可拖。
              // 单条仍可直接拖封面，不需要先进入多选。
              // WebKit 对 table-row 的原生 draggable 支持不稳定，真正的拖动源放到每个 td；
              // 事件冒泡到这里统一决定“单条还是整个选区”。
              draggable={false}
              onDragStart={(event) => {
                const ids = selected.has(track.id) ? selectedIds : [track.id];
                if (!selected.has(track.id)) onSelect(track.id, "replace");
                event.dataTransfer.setData(TRACK_DND_TYPE, JSON.stringify(ids));
                event.dataTransfer.effectAllowed = "copyMove";
                announceTrackDrag(ids);
              }}
              onDragEnd={() => {
                setDrop(null);
                endTrackDrag();
              }}
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
                onSelect(track.id, mode);
                // 竖屏点一下 = 播放：触屏上没有"双击"这个自然动作，而点一首歌
                // 九成的意图就是放它。带修饰键的多选点击不算——那是在攒选区。
                // 详情入口挪去了播放条的「正在播」块（见 PlayerBar.DETAIL_EVENT）
                if (layout === "narrow" && mode === "replace") playFromTable(track);
              }}
              onPointerDown={(event) => {
                if (event.pointerType !== "mouse") {
                  beginLongPress(track, event.clientX, event.clientY);
                }
              }}
              onPointerUp={cancelPress}
              onPointerCancel={cancelPress}
              onPointerLeave={cancelPress}
              onDoubleClick={() => {
                if (!selectionMode) playFromTable(track);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                cancelPress();
                // 右键只开菜单；用户明确点菜单里的「选择」后才显示复选框。
                setRowMenu({ x: event.clientX, y: event.clientY, track });
              }}
              // 同一份拖拽载荷两种落点：拖到左边文件夹树=移动文件，
              // 落在列表行上=换顺序（只在单文件夹视图开）。
              onDragOver={
                reorderable
                  ? (event) => {
                      if (!event.dataTransfer.types.includes(TRACK_DND_TYPE)) return;
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
                      const raw = event.dataTransfer.getData(TRACK_DND_TYPE);
                      const target = drop;
                      setDrop(null);
                      if (!raw || !target || target.id !== track.id) return;
                      event.preventDefault();
                      try {
                        const ids = JSON.parse(raw) as number[];
                        if (!ids.includes(track.id)) onReorder?.(ids, track.id, target.before);
                      } catch {
                        // 载荷不是我们的格式（比如从别处拖进来的文件），忽略
                      }
                    }
                  : undefined
              }
            >
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
                  column.key === "title"
                    ? (event) => {
                        event.stopPropagation();
                        // 整行不再 draggable：否则 Chromium 把框选文字解释为拖歌曲。
                        // 封面是明确且稳定的拖拽把手。
                        const ids = selected.has(track.id) ? selectedIds : [track.id];
                        if (!selected.has(track.id)) onSelect(track.id, "replace");
                        event.dataTransfer.setData(TRACK_DND_TYPE, JSON.stringify(ids));
                        event.dataTransfer.effectAllowed = "copyMove";
                        event.dataTransfer.setDragImage(event.currentTarget, 8, 8);
                        setDrop(null);
                        announceTrackDrag(ids);
                      }
                    : undefined,
                  column.key === "rating"
                    ? (rating) => {
                        void updateTrack(track.id, { rating });
                      }
                    : undefined,
                ) as React.ReactElement<React.TdHTMLAttributes<HTMLTableCellElement>>;
                return cloneElement(cell, {
                  // <tr draggable> 在 macOS WKWebView 中不会可靠触发 dragstart。
                  // 每个格子都是真实拖动源：未选行拖单条，选中行拖整个选区。
                  draggable: true,
                });
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {/* 选列菜单。开着的时候点勾选不关闭——一次通常要调好几列，
          调一列关一次等于逼用户右键三回。点别处 / Esc / 恢复默认才关。 */}
      {colMenu && (
        <div
          ref={colMenuRef}
          className="kd-context-menu"
          style={{ left: colMenu.x, top: colMenu.y }}
          role="menu"
        >
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
              setColPrefs({ order: [], hidden: [] });
              setColMenu(null);
            }}
          >
            <RotateCcw size={12} />
            恢复默认列
          </button>
        </div>
      )}
      {/* 行右键菜单：多选操作的家。删除的三种去向都在这儿——
          回收站（能反悔）、永久删除（安卓等没有回收站的平台，点两次确认）、
          只移出曲库（文件不动）。条目带数量，删的是几首一目了然。 */}
      {rowMenu && (
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
              copyToClipboard("link");
              setRowMenu(null);
            }}
          >
            <Copy size={12} />
            复制{menuIds.length > 1 ? `（${menuIds.length} 首）` : ""}
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
            下一首播放（插队）{menuTracks.length > 1 ? `（${menuTracks.length} 首）` : ""}
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
            移出曲库{menuIds.length > 1 ? `（${menuIds.length} 首）` : ""}（保留文件）
          </button>
        </div>
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
