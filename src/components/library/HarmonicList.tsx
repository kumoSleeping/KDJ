import { useEffect, useRef, useState } from "react";
import { Check, ListMusic, ListStart, LoaderCircle, Play } from "lucide-react";
import { api } from "../../lib/api";
import { formatBpm } from "../../lib/format";
import { useHarmonicScope } from "../../lib/harmonicScope";
import { useLibraryStore } from "../../stores/libraryStore";
import { useQueueStore } from "../../stores/queueStore";
import type { HarmonicMatch, Track } from "../../types";
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
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [drop, setDrop] = useState<{ id: number; before: boolean } | null>(null);
  const scope = useHarmonicScope((state) => state.scope);
  const setScope = useHarmonicScope((state) => state.setScope);
  const folder = useLibraryStore((state) => state.filter.folder);
  const queueCount = useQueueStore((state) => state.ids.length);
  // 没选文件夹时「当前文件夹」等价于全库——与其给一个点了没反应的开关，
  // 不如让它退回全库并在按钮上说清楚
  const activeFolder = scope === "folder" ? folder : "";
  const selected = new Set(selectedIds);

  useEffect(() => {
    setSelectedIds([]);
    setRowMenu(null);
    setDrop(null);
  }, [track.id]);

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

  useEffect(() => {
    if (scope === "queue") {
      setMatches([]);
      setLoading(false);
      setError("");
      return;
    }
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

  const menuTracks = rowMenu
    ? matches
        .filter((match) =>
          (selected.has(rowMenu.track.id) ? selected : new Set([rowMenu.track.id])).has(
            match.track.id,
          ),
        )
        .map((match) => match.track)
    : [];

  const toggleSelected = (id: number) => {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]));
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

  /** 范围开关：三枚小按钮常驻在列表顶上，任何状态下都能切。 */
  const scopeBar = (
    <div className="kd-scope" role="group" aria-label="接歌范围">
      <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>
        全部
      </button>
      <button
        type="button"
        aria-pressed={scope === "folder"}
        onClick={() => setScope("folder")}
        title={folder ? `只在 ${folder} 里接` : "先在左边选一个文件夹；没选时等同于全部"}
      >
        当前文件夹
      </button>
      <button
        type="button"
        aria-pressed={scope === "queue"}
        onClick={() => setScope("queue")}
        title="只播放临时列表，放空后停止"
      >
        临时列表
      </button>
      {scope === "folder" && !folder && <span className="kd-faint">（没选文件夹，仍是全部）</span>}
    </div>
  );

  const body = scope === "queue" ? (
    <p className="kd-muted">
      临时列表里有 {queueCount} 首，将按排队顺序播放；放空后停止。
    </p>
  ) : !track.camelot || !track.bpm ? (
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
          style={{ cursor: "pointer" }}
          title="点一下播放；勾选后可批量加入或拖动排序"
          aria-selected={selected.has(match.track.id)}
          draggable
          onClick={() => {
            // 先选中再播：详情栏跟着换成这一首，接着往下接就是一条链
            onSelect(match.track);
            playTrack(match.track);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            if (!selected.has(match.track.id)) setSelectedIds([match.track.id]);
            setRowMenu({ x: event.clientX, y: event.clientY, track: match.track });
          }}
          onDragStart={(event) => {
            if (!selected.has(match.track.id)) setSelectedIds([match.track.id]);
            event.dataTransfer.effectAllowed = "copyMove";
            event.dataTransfer.setData("text/plain", String(match.track.id));
          }}
          onDragEnd={() => setDrop(null)}
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
            <Check size={11} style={{ opacity: selected.has(match.track.id) ? 1 : 0 }} />
          </button>
          <span className="kd-queue-title" title={match.track.title || match.track.filename}>
            {match.track.title || match.track.filename}
          </span>
          <CamelotChip code={match.track.camelot} />
          <div className="kd-queue-meta">
            {/* 艺人为空时整条不占位，免得留一个孤零零的破折号 */}
            {match.track.artist && <span className="kd-truncate">{match.track.artist}</span>}
            <span className="kd-toolbar-gap" />
            <span className="kd-chip">{match.relation_label}</span>
            <span title={`BPM ${formatBpm(match.track.bpm)}，相差 ${match.bpm_delta.toFixed(1)}`}>
              {formatBpm(match.track.bpm)}
              {match.bpm_delta !== 0 && (
                <span className="kd-faint">
                  {" "}
                  ({match.bpm_delta > 0 ? "+" : ""}
                  {match.bpm_delta.toFixed(1)})
                </span>
              )}
            </span>
            {/* tempo_ratio ≠ 1 表示要靠半速/倍速接，DJ 得知道 */}
            {Math.abs(match.tempo_ratio - 1) > 0.01 && (
              <span className="kd-chip" data-tone="warn">
                ×{match.tempo_ratio.toFixed(2)}
              </span>
            )}
          </div>
        </div>
      ))}
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
              setRowMenu(null);
              useQueueStore.getState().add(menuTracks);
            }}
          >
            <ListMusic size={12} />
            加入临时列表{menuTracks.length > 1 ? `（${menuTracks.length} 首）` : ""}
          </button>
          <button
            type="button"
            onClick={() => {
              setRowMenu(null);
              useQueueStore.getState().add(menuTracks, true);
            }}
          >
            <ListStart size={12} />
            下一首播放（插队）{menuTracks.length > 1 ? `（${menuTracks.length} 首）` : ""}
          </button>
        </div>
      )}
    </div>
  );
}
