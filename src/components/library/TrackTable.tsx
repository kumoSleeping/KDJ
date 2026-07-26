import { useState } from "react";
import { FolderSearch, Link2, LoaderCircle } from "lucide-react";
import { api } from "../../lib/api";
import { camelotColor } from "../../lib/camelot";
import { DASH, formatBpm, formatDuration } from "../../lib/format";
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
}

const COLUMNS: Column[] = [
  { id: "title", label: "标题" },
  { id: "artist", label: "艺人", width: "18%" },
  { id: "album", label: "专辑", width: "14%" },
  { id: "bpm", label: "BPM", width: "4.5rem", align: "num" },
  { id: "camelot", label: "KEY", width: "4rem" },
  { id: "energy", label: "能量", width: "4.5rem" },
  { id: "duration", label: "时长", width: "4.5rem", align: "num" },
  { id: null, label: "格式", width: "4rem" },
];

export interface TrackTableProps {
  tracks: Track[];
  loading: boolean;
  selectedId: number | null;
  selectedIds: number[];
  sort: TrackSort;
  order: SortOrder;
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
  selectedId,
  selectedIds,
  sort,
  order,
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
        hint="点上方「扫描目录」把本地音乐加进来；下载完成的曲目会自动入库。"
      />
    );
  }

  return (
    <div
      className="kd-scroll"
      style={{ height: "100%" }}
      onScroll={(event) => {
        const el = event.currentTarget;
        // 距底 200px 就预取下一页，滚到底再等请求会有明显空白
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) onScrollEnd();
      }}
    >
      <table className="kd-table">
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th
                key={column.label}
                style={column.width ? { width: column.width } : undefined}
                className={column.align === "num" ? "kd-td-num" : undefined}
                data-sortable={column.id ? "true" : undefined}
                onClick={column.id ? () => onSort(column.id as TrackSort) : undefined}
              >
                {column.label}
                {column.id === sort && <span> {order === "asc" ? "↑" : "↓"}</span>}
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
              <td className="kd-td-strong" title={track.title || track.filename}>
                {/* 内嵌封面缩略图。没图时 onError 藏掉 img，底下的灰格子当占位，
                    行高不会跳。lazy：一页 200 行，只拉滚到眼前的。 */}
                <span className="kd-thumb">
                  <img
                    src={api.coverUrl(track.id)}
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
                {track.title || track.filename}
              </td>
              <td title={track.artist}>{track.artist || DASH}</td>
              <td className="kd-muted" title={track.album}>
                {track.album || DASH}
              </td>
              <td className="kd-td-num">{formatBpm(track.bpm)}</td>
              <td>
                <CamelotChip code={track.camelot} />
              </td>
              <td>
                <EnergyMeter value={track.energy} />
              </td>
              <td className="kd-td-num">{formatDuration(track.duration)}</td>
              <td className="kd-mono kd-muted">{track.format.toUpperCase() || DASH}</td>
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
