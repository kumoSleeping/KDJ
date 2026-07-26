import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { api } from "../../lib/api";
import { formatBpm } from "../../lib/format";
import { useHarmonicScope } from "../../lib/harmonicScope";
import { useLibraryStore } from "../../stores/libraryStore";
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
  const scope = useHarmonicScope((state) => state.scope);
  const setScope = useHarmonicScope((state) => state.setScope);
  const folder = useLibraryStore((state) => state.filter.folder);
  // 没选文件夹时「当前文件夹」等价于全库——与其给一个点了没反应的开关，
  // 不如让它退回全库并在按钮上说清楚
  const activeFolder = scope === "folder" ? folder : "";

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
  }, [track.id, track.camelot, track.bpm, activeFolder]);

  /** 范围开关：两枚小按钮常驻在列表顶上，任何状态下都能切。 */
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
      {scope === "folder" && !folder && <span className="kd-faint">（没选文件夹，仍是全部）</span>}
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
          style={{ cursor: "pointer" }}
          title="点一下就放"
          onClick={() => {
            // 先选中再播：详情栏跟着换成这一首，接着往下接就是一条链
            onSelect(match.track);
            playTrack(match.track);
          }}
        >
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
    </div>
  );
}
