import { useState } from "react";
import { FolderSearch, Link2, LoaderCircle } from "lucide-react";
import { api } from "../../lib/api";
import { observeTrackScroller } from "../../lib/autoAnalyze";
import { camelotColor } from "../../lib/camelot";
import { DASH, formatBpm, formatDuration, isVideoTrack } from "../../lib/format";
import type { LayoutMode } from "../../lib/useLayoutMode";
import {
  useLibraryStore,
  type SelectMode,
  type SortOrder,
  type TrackSort,
} from "../../stores/libraryStore";
import type { Track } from "../../types";
import { EmptyState } from "../common";
import { TRACK_DND_TYPE } from "./FolderTree";

/** 双击曲目 = 播放。PlayerBar 监听同名事件，两边不用互相持有引用。 */
export const PLAY_EVENT = "kd:play";

export function playTrack(track: Track): void {
  window.dispatchEvent(new CustomEvent<Track>(PLAY_EVENT, { detail: track }));
}

/** 1..10 的能量条。未分析时全灰。 */
export function EnergyMeter({ value }: { value: number | null }) {
  const level = value ?? 0;
  return (
    <span className="kd-energy" title={value ? `能量 ${value}/10` : "未分析"}>
      {Array.from({ length: 10 }, (_, index) => (
        <i
          key={index}
          data-on={index < level ? "true" : "false"}
          // 高度随档位递增，扫一眼就能比较，不用去读数字
          style={{ height: `${35 + index * 6.5}%` }}
        />
      ))}
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
    <span className="kd-camelot" style={{ background: camelotColor(code) }}>
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
 * 所以标题是唯一**不写 width** 的列，在 `table-layout: fixed` 下自动吃掉剩余空间。
 *
 * 艺人和专辑用 `clamp(下限, 理想值, 上限)`：面板一窄就先缩到下限，
 * 把省出来的宽度让给标题。下限故意留得能看见几个字 + 省略号——
 * **让位不等于消失**，一列全空白和一列没有是两回事。
 * 专辑的下限比艺人更小，所以挤压时它先让。
 */
const COLUMNS: Column[] = [
  { id: "title", label: "标题", key: "title" },
  // 标题单元格里还装着封面缩略图 + 「视频」角标（约 70px），它们都算在标题头上，
  // 所以其余列的预留只能更抠：艺人/专辑的理想占比与上限都压小
  //（曲库里一大片视频行这两列本来就全是"—"），数字列给到刚好放下内容为止。
  { id: "artist", label: "艺人", width: "clamp(3.2rem, 9%, 9rem)", key: "artist" },
  { id: "album", label: "专辑", width: "clamp(2.6rem, 7%, 7rem)", key: "album" },
  { id: "bpm", label: "BPM", width: "4.2rem", align: "num", key: "bpm" },
  { id: "camelot", label: "KEY", width: "3.4rem", key: "camelot" },
  // 能量表本体 10 根柱 ≈ 39px，3.8rem 足够，不裁柱子
  { id: "energy", label: "能量", width: "3.8rem", key: "energy" },
  { id: "duration", label: "时长", width: "4rem", align: "num", key: "duration" },
  { id: null, label: "格式", width: "3.4rem", key: "format" },
];

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
  const selected = new Set(selectedIds);
  /** 行内拖动的插入位置指示：悬停行上半 = 插到它前面。 */
  const [drop, setDrop] = useState<{ id: number; before: boolean } | null>(null);

  if (loading && tracks.length === 0) {
    return <EmptyState icon={<LoaderCircle className="kd-spin" size={22} />} title="正在读取曲库" />;
  }

  if (tracks.length === 0) {
    return (
      <EmptyState
        icon={<FolderSearch size={22} />}
        title="曲库是空的"
        hint="点上方「添加文件夹」把本地音乐加进来，导入和分析都在后台自动完成；下载好的曲目会自己入库。"
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
      ref={observeTrackScroller}
      onScroll={(event) => {
        const el = event.currentTarget;
        // 距底 200px 就预取下一页，滚到底再等请求会有明显空白
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) onScrollEnd();
      }}
    >
      {/* data-kind 区分曲库表和搜索结果表（两者共用 .kd-table，但结果表里有
          视频大行那套自排版，套不得两行式）；data-layout 是两行式的开关，
          见 TrackTableProps.layout 里为什么不能交给容器宽度判。 */}
      <table className="kd-table" data-kind="library" data-layout={layout}>
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th
                key={column.label}
                data-col={column.key}
                style={column.width ? { width: column.width } : undefined}
                className={column.align === "num" ? "kd-td-num" : undefined}
                data-sortable={column.id ? "true" : undefined}
                onClick={column.id ? () => onSort(column.id as TrackSort) : undefined}
                data-sort={column.id === sort ? "1" : column.id === sort2 ? "2" : undefined}
                title={
                  column.id
                    ? column.id === sort
                      ? "再点一下换方向；方向转回来那一下取消这一列的排序"
                      : column.id === sort2
                        ? "副排序键。再点一下把它升为主排序（原主排序降为副）"
                        : "点一下按它排。已经有主排序时，这一下加的是副排序"
                    : undefined
                }
              >
                {column.label}
                {/* ①②：哪个是主、哪个是副，光靠箭头分不出来。
                    数字标出层级，箭头标出方向，两件事各归各的符号。 */}
                {column.id === sort && (
                  <span className="kd-sort-mark">①{order === "asc" ? "↑" : "↓"}</span>
                )}
                {column.id !== sort && column.id === sort2 && (
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
              draggable
              onClick={(event) => onSelect(track.id, selectMode(event))}
              onDoubleClick={() => playTrack(track)}
              onDragStart={(event) => {
                // 拖没选中的行 = 先选中它再拖，和访达一致；
                // 拖选中的行则整批一起走，不改选区。
                const ids = selected.has(track.id) ? selectedIds : [track.id];
                if (!selected.has(track.id)) onSelect(track.id, "replace");
                event.dataTransfer.setData(TRACK_DND_TYPE, JSON.stringify(ids));
                event.dataTransfer.effectAllowed = "copyMove";
              }}
              onDragEnd={() => setDrop(null)}
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
              <td data-col="title" className="kd-td-strong" title={track.title || track.filename}>
                {/* 内嵌封面缩略图。没图时 onError 藏掉 img，底下的灰格子当占位，
                    行高不会跳。lazy：一页 200 行，只拉滚到眼前的。
                    版本号挂 modified_at：换封面会更新它，列表里的小图才能跟着换——
                    封面响应带 max-age=3600，不带版本号要干等缓存过期。 */}
                <span className="kd-thumb">
                  <img
                    src={api.coverUrl(track.id, track.modified_at)}
                    alt=""
                    loading="lazy"
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
              {/* data-empty 是给竖屏用的：那边没有"列"要对齐，
                  一个孤零零的破折号只是噪声，直接不占位 */}
              <td data-col="artist" data-empty={track.artist ? undefined : "true"} title={track.artist}>
                {track.artist || DASH}
              </td>
              <td data-col="album" className="kd-muted" title={track.album}>
                {track.album || DASH}
              </td>
              <td data-col="bpm" className="kd-td-num">{formatBpm(track.bpm)}</td>
              <td data-col="camelot">
                <CamelotChip code={track.camelot} />
              </td>
              <td data-col="energy">
                <EnergyMeter value={track.energy} />
              </td>
              <td data-col="duration" className="kd-td-num">{formatDuration(track.duration)}</td>
              <td data-col="format" className="kd-mono kd-muted">{track.format.toUpperCase() || DASH}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {loadingMore && (
        <div className="kd-row kd-muted" style={{ justifyContent: "center", padding: "0.6rem" }}>
          <LoaderCircle className="kd-spin" size={13} /> 加载更多
        </div>
      )}
    </div>
  );
}
