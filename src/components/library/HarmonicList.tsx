import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Library, LoaderCircle, Play } from "lucide-react";
import { api } from "../../lib/api";
import { formatBpm } from "../../lib/format";
import { useHarmonicScope } from "../../lib/harmonicScope";
import { isOutsideFolder } from "../../lib/outsideFolder";
import { clearTextSelection, hasTextSelectionWithin } from "../../lib/textSelection";
import { endTrackDrag, writeTrackDragData } from "../../lib/trackDrag";
import { useLibraryStore } from "../../stores/libraryStore";
import type { HarmonicMatch, Track } from "../../types";
import { ContextMenu } from "../common";
import { CoverImage } from "../common/VinylPlaceholder";
import { CamelotChip, playTrack } from "./TrackTable";

export interface HarmonicListProps {
  track: Track;
  /** 传整个对象：推荐的歌大多不在当前页里，只给 id 详情栏会找不到人。 */
  onSelect(track: Track): void;
}


/**
 * 和声混音推荐：调性相容、速度对得上的曲子，越靠前越稳。
 *
 * 点一行就直接放：这一栏存在的意义就是"下一首放什么"，
 * 让人先点一次选中、再去别处按播放，等于把一步拆成两步。
 * 后端算好了 relation 和分数，这里只负责展示。
 */
export function HarmonicList({ track, onSelect }: HarmonicListProps) {
  const [matches, setMatches] = useState<HarmonicMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; track: Track } | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  /** 复选框不是常驻装饰：桌面右键、触屏长按后才进入显式批选模式。 */
  const [selectionMode, setSelectionMode] = useState(false);
  const pressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef<number | null>(null);
  const [drop, setDrop] = useState<{ id: number; before: boolean } | null>(null);
  const scope = useHarmonicScope((state) => state.scope);
  const setScope = useHarmonicScope((state) => state.setScope);
  const folder = useLibraryStore((state) => state.filter.folder);
  // 没选文件夹时「当前文件夹」等价于全库——与其给一个点了没反应的开关，
  // 不如让它退回全库并在按钮上说清楚。「其他」也不是真实目录，同样退回全库。
  const activeFolder = scope === "folder" && !isOutsideFolder(folder) ? folder : "";
  const selected = new Set(selectedIds);

  useEffect(() => {
    if (!selectionMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSelectionMode(false);
      setSelectedIds([]);
      setRowMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionMode]);

  useEffect(() => {
    setSelectedIds([]);
    setSelectionMode(false);
    setRowMenu(null);
    setDrop(null);
  }, [track.id]);

  useEffect(() => {
    if (!track.camelot || !track.bpm) {
      setMatches([]);
      setError("");
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .harmonic(track.id, 12, 60, activeFolder)
      .then((result) => {
        if (alive) {
          setMatches(result);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    // 切曲目时把上一条请求的结果作废，慢响应不会覆盖新选中
    return () => {
      alive = false;
    };
  }, [track.id, track.camelot, track.bpm, activeFolder, scope]);

  const toggleSelected = (id: number) => {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]));
  };

  const cancelPress = () => {
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
    pressTimerRef.current = null;
  };

  /** 触屏没有右键：按住 480ms 打开与桌面右键完全相同的菜单。 */
  const beginLongPress = (track: Track, x: number, y: number) => {
    cancelPress();
    pressTimerRef.current = window.setTimeout(() => {
      setRowMenu({ x, y, track });
      suppressClickRef.current = track.id;
      pressTimerRef.current = null;
    }, 480);
  };

  const reorder = (targetId: number, before: boolean) => {
    if (!selectedIds.length || selectedIds.includes(targetId)) return;
    const moving = matches.filter((match) => selected.has(match.track.id));
    const rest = matches.filter((match) => !selected.has(match.track.id));
    const targetIndex = rest.findIndex((match) => match.track.id === targetId);
    if (targetIndex < 0) return;
    rest.splice(before ? targetIndex : targetIndex + 1, 0, ...moving);
    setMatches(rest);
  };

  /** 范围开关：全库 / 当前文件夹。 */
  const scopeBar = (
    <div className="kd-scope" role="group" aria-label="接歌范围">
      <button
        type="button"
        aria-label="全部曲目"
        title="从全部曲目中接歌"
        aria-pressed={scope === "all"}
        onClick={() => setScope("all")}
      >
        <Library size={14} />
      </button>
      <button
        type="button"
        aria-label="当前文件夹"
        aria-pressed={scope === "folder"}
        onClick={() => setScope("folder")}
        title={folder ? `只在 ${folder} 里接` : "先在左边选一个文件夹；没选时等同于全部"}
      >
        <FolderOpen size={14} />
      </button>
      {scope === "folder" && !folder && <span className="kd-faint">（没选文件夹，仍是全部）</span>}
      {selectionMode && (
        <button
          type="button"
          className="kd-scope-done"
          onClick={() => {
            setSelectionMode(false);
            setSelectedIds([]);
          }}
        >
          完成{selectedIds.length ? ` · ${selectedIds.length}` : ""}
        </button>
      )}
    </div>
  );

  const body = !track.camelot || !track.bpm ? (
    <p className="kd-muted">这首还没分析出调号和 BPM，先跑一次分析。</p>
  ) : loading ? (
    <p className="kd-muted kd-row">
      <LoaderCircle className="kd-spin" size={13} /> 正在匹配
    </p>
  ) : error ? (
    <p style={{ color: "var(--kd-danger)" }}>{error}</p>
  ) : matches.length === 0 ? (
    <p className="kd-muted">
      {activeFolder ? "这个文件夹里" : "曲库里"}
      还没有能接上的。判断标准是调性相容且 BPM 在 ±12 以内（半速、倍速也算）。
      {activeFolder && "换成「全部」再看看。"}
    </p>
  ) : null;

  if (body) {
    return (
      <>
        {scopeBar}
        {body}
      </>
    );
  }

  return (
    <div className="kd-col" style={{ gap: 0 }}>
      {scopeBar}
      {matches.slice(0, 40).map((match) => (
        <div
          key={match.track.id}
          className="kd-queue-row"
          data-selecting={selectionMode ? "true" : undefined}
          style={{ cursor: "pointer" }}
          title="点一下播放；Cmd/Ctrl 点击多选；右键或长按进入批选"
          aria-selected={selected.has(match.track.id)}
          draggable
          onDragStart={(event) => {
            clearTextSelection();
            const ids = selected.has(match.track.id) ? selectedIds : [match.track.id];
            if (!selected.has(match.track.id)) setSelectedIds([match.track.id]);
            writeTrackDragData(event.dataTransfer, ids);
          }}
          onDragEnd={() => {
            setDrop(null);
            endTrackDrag();
          }}
          onClick={(event) => {
            if (hasTextSelectionWithin(event.currentTarget)) return;
            if (suppressClickRef.current === match.track.id) {
              suppressClickRef.current = null;
              return;
            }
            if (selectionMode || event.metaKey || event.ctrlKey) {
              toggleSelected(match.track.id);
              return;
            }
            // 先选中再播：详情栏跟着换成这一首，接着往下接就是一条链
            onSelect(match.track);
            playTrack(match.track);
          }}
          onPointerDown={(event) => {
            if (event.pointerType !== "mouse") {
              beginLongPress(match.track, event.clientX, event.clientY);
            }
          }}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          onPointerLeave={cancelPress}
          onContextMenu={(event) => {
            event.preventDefault();
            cancelPress();
            // 右键只打开菜单，复选框由菜单里的「选择」显式开启。
            setRowMenu({ x: event.clientX, y: event.clientY, track: match.track });
          }}
          onDragOver={(event) => {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            setDrop((current) =>
              current?.id === match.track.id && current.before === before
                ? current
                : { id: match.track.id, before },
            );
          }}
          onDragLeave={() => setDrop((current) => (current?.id === match.track.id ? null : current))}
          onDrop={(event) => {
            event.preventDefault();
            const target = drop;
            setDrop(null);
            if (target?.id === match.track.id) reorder(target.id, target.before);
          }}
        >
          {selectionMode && (
            <button
              type="button"
              className="kd-harmonic-select"
              aria-label={selected.has(match.track.id) ? "取消选择" : "选择曲目"}
              aria-pressed={selected.has(match.track.id)}
              onClick={(event) => {
                event.stopPropagation();
                toggleSelected(match.track.id);
              }}
            >
              <Check size={9} style={{ opacity: selected.has(match.track.id) ? 1 : 0 }} />
            </button>
          )}
          <span className="kd-queue-title" title={match.track.title || match.track.filename}>
            <span
              className="kd-thumb"
              draggable
              title="拖动封面调整所选曲目顺序"
              onDragStart={(event) => {
                event.stopPropagation();
                const ids = selected.has(match.track.id) ? selectedIds : [match.track.id];
                if (!selected.has(match.track.id)) setSelectedIds([match.track.id]);
                writeTrackDragData(event.dataTransfer, ids);
              }}
              onDragEnd={() => {
                setDrop(null);
                endTrackDrag();
              }}
            >
              <CoverImage
                src={api.coverUrl(match.track.id, match.track.modified_at)}
                loading="lazy"
              />
            </span>
            {match.track.title || match.track.filename}
          </span>
          <span>
            <CamelotChip code={match.track.camelot} />
          </span>
          <div className="kd-queue-meta">
            {/* 艺人为空时整条不占位，免得留一个孤零零的破折号 */}
            {match.track.artist && <span className="kd-truncate">{match.track.artist}</span>}
            <span className="kd-toolbar-gap" />
            <span className="kd-chip kd-harmonic-relation">{match.relation_label}</span>
            <span
              className="kd-harmonic-bpm"
              title={`BPM ${formatBpm(match.track.bpm)}，相差 ${match.bpm_delta.toFixed(1)}`}
            >
              {formatBpm(match.track.bpm)}
              {match.bpm_delta !== 0 && (
                <span
                  className="kd-harmonic-delta"
                  data-direction={match.bpm_delta > 0 ? "up" : "down"}
                >
                  {" "}
                  ({match.bpm_delta > 0 ? "+" : ""}
                  {match.bpm_delta.toFixed(1)})
                </span>
              )}
            </span>
          </div>
        </div>
      ))}
      {rowMenu && (
        <ContextMenu x={rowMenu.x} y={rowMenu.y} onClose={() => setRowMenu(null)}>
          <button
            type="button"
            onClick={() => {
              setRowMenu(null);
              onSelect(rowMenu.track);
              playTrack(rowMenu.track);
            }}
          >
            <Play size={12} />
            播放
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectionMode(true);
              if (!selected.has(rowMenu.track.id)) toggleSelected(rowMenu.track.id);
              setRowMenu(null);
            }}
          >
            <Check size={12} />
            选择
          </button>
        </ContextMenu>
      )}
    </div>
  );
}
