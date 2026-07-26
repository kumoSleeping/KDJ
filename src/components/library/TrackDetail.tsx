import { useEffect, useRef, useState } from "react";
import { FolderOpen, Play, RefreshCw, Star, Tag, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { camelotToLabel } from "../../lib/camelot";
import { DASH, formatBpm, formatBytes, formatDate, formatDuration } from "../../lib/format";
import { useAppStore } from "../../stores/appStore";
import { useLibraryStore } from "../../stores/libraryStore";
import type { Track } from "../../types";
import { Button, Panel } from "../common";
import { CamelotWheel } from "./CamelotWheel";
import { HarmonicList } from "./HarmonicList";
import { Waveform } from "./Waveform";
import { CamelotChip, EnergyMeter, playTrack } from "./TrackTable";

/** PlayerBar 播放时广播的位置，用来在节拍网格上画播放头。 */
export const POSITION_EVENT = "kd:position";
export interface PositionDetail {
  trackId: number;
  position: number;
}

const COMMENT_SAVE_DELAY_MS = 600;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kd-row" style={{ justifyContent: "space-between", gap: "0.75rem" }}>
      <span className="kd-muted kd-nowrap">{label}</span>
      <span className="kd-truncate" style={{ textAlign: "right" }}>
        {children}
      </span>
    </div>
  );
}

export function TrackDetail({ track }: { track: Track }) {
  const pushToast = useAppStore((state) => state.pushToast);
  const updateTrack = useLibraryStore((state) => state.updateTrack);
  const writeTags = useLibraryStore((state) => state.writeTags);
  const removeTrack = useLibraryStore((state) => state.removeTrack);
  const startAnalyze = useLibraryStore((state) => state.startAnalyze);
  const selectTrack = useLibraryStore((state) => state.selectTrack);
  const setFilter = useLibraryStore((state) => state.setFilter);

  const [comment, setComment] = useState(track.comment);
  const [position, setPosition] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const commentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 切曲目时把草稿换成新曲目的备注，并取消上一首还没落盘的保存
  useEffect(() => {
    setComment(track.comment);
    setPosition(null);
    if (commentTimer.current) {
      clearTimeout(commentTimer.current);
      commentTimer.current = null;
    }
  }, [track.id, track.comment]);

  useEffect(() => {
    const onPosition = (event: Event) => {
      const detail = (event as CustomEvent<PositionDetail>).detail;
      setPosition(detail.trackId === track.id ? detail.position : null);
    };
    window.addEventListener(POSITION_EVENT, onPosition);
    return () => window.removeEventListener(POSITION_EVENT, onPosition);
  }, [track.id]);

  useEffect(
    () => () => {
      if (commentTimer.current) clearTimeout(commentTimer.current);
    },
    [],
  );

  const saveComment = (value: string) => {
    setComment(value);
    if (commentTimer.current) clearTimeout(commentTimer.current);
    commentTimer.current = setTimeout(() => {
      commentTimer.current = null;
      void updateTrack(track.id, { comment: value }).catch((error: unknown) =>
        pushToast("error", `备注保存失败：${(error as Error).message}`),
      );
    }, COMMENT_SAVE_DELAY_MS);
  };

  const run = (label: string, action: () => Promise<unknown>) => () => {
    setBusy(true);
    action()
      .then(() => pushToast("info", `${label}完成`))
      .catch((error: unknown) => pushToast("error", `${label}失败：${(error as Error).message}`))
      .finally(() => setBusy(false));
  };

  return (
    <div className="kd-col" style={{ gap: "0.6rem", padding: "0.7rem" }}>
      <div className="kd-row" style={{ gap: "0.6rem", alignItems: "flex-start" }}>
        <img
          className="kd-cover"
          style={{ width: 64, height: 64 }}
          src={api.coverUrl(track.id)}
          alt=""
          // 没封面时后端返回 404，隐藏掉，不要留一个破图标
          onError={(event) => {
            event.currentTarget.style.visibility = "hidden";
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div className="kd-truncate" style={{ fontWeight: 700, fontSize: "var(--kd-size-lg)" }}>
            {track.title || track.filename}
          </div>
          <div className="kd-truncate kd-muted">{track.artist || DASH}</div>
          <div className="kd-truncate kd-faint">{track.album || DASH}</div>
          <div className="kd-row kd-faint" style={{ gap: "0.4rem", fontSize: "var(--kd-size-xs)" }}>
            <span>{track.format.toUpperCase() || DASH}</span>
            {track.bitrate ? <span>{track.bitrate} kbps</span> : null}
            <span>{formatDuration(track.duration)}</span>
            <span>{formatBytes(track.size)}</span>
          </div>
        </div>
      </div>

      <div className="kd-row" style={{ flexWrap: "wrap", gap: "0.3rem" }}>
        <Button size="sm" variant="primary" onClick={() => playTrack(track)}>
          <Play size={12} />
          播放
        </Button>
        <Button
          size="sm"
          disabled={busy}
          title="重新跑一遍 BPM / 调性 / 能量分析"
          onClick={run("重新分析", () => startAnalyze([track.id], true))}
        >
          <RefreshCw size={12} />
          重新分析
        </Button>
        <Button
          size="sm"
          disabled={busy || !track.analyzed_at}
          title="把 BPM / KEY 写进文件标签，Rekordbox、Serato、Traktor 都能直接读"
          onClick={run("写入标签", () => writeTags(track.id))}
        >
          <Tag size={12} />
          写标签
        </Button>
        <Button size="sm" variant="ghost" iconOnly aria-label="在文件夹中显示"
          onClick={() => void window.kumodeck?.revealPath(track.path)}>
          <FolderOpen size={12} />
        </Button>
        <Button
          size="sm"
          variant="danger"
          iconOnly
          aria-label="移出曲库"
          disabled={busy}
          title="只移出曲库，不删文件"
          onClick={run("移出曲库", () => removeTrack(track.id, false))}
        >
          <Trash2 size={12} />
        </Button>
      </div>

      <Panel heading="分析" padded dense>
        <div className="kd-stat-grid" data-dense="true" style={{ marginBottom: "0.5rem" }}>
          <div className="kd-stat">
            <div className="kd-stat-label">BPM</div>
            <div className="kd-stat-value">{formatBpm(track.bpm)}</div>
            <div className="kd-stat-hint">
              置信度 {track.bpm_confidence !== null ? `${Math.round(track.bpm_confidence * 100)}%` : DASH}
            </div>
          </div>
          <div className="kd-stat">
            <div className="kd-stat-label">KEY</div>
            <div className="kd-stat-value kd-row" style={{ gap: "0.4rem" }}>
              <CamelotChip code={track.camelot} />
            </div>
            <div className="kd-stat-hint">{track.music_key || camelotToLabel(track.camelot) || DASH}</div>
          </div>
          <div className="kd-stat">
            <div className="kd-stat-label">能量</div>
            <div className="kd-stat-value kd-row" style={{ gap: "0.35rem" }}>
              <EnergyMeter value={track.energy} />
              <span>{track.energy ?? DASH}</span>
            </div>
            <div className="kd-stat-hint">
              {track.rms_db !== null ? `${track.rms_db.toFixed(1)} dBFS` : DASH}
            </div>
          </div>
        </div>

        {/* 只留波形。原来波形下面还有一条"首拍附近 16 秒的拍子网格"，
            但它是由 bpm+first_beat 外推出来的，既不能编辑也不能对齐，看着像装饰，已删。 */}
        <Waveform trackId={track.id} position={position} height={64} />
        <div className="kd-row kd-faint" style={{ marginTop: "0.35rem", fontSize: "var(--kd-size-xs)" }}>
          首拍 {track.first_beat !== null ? `${track.first_beat.toFixed(3)}s` : DASH}
          <span className="kd-toolbar-gap" />
          {track.analyzed_at ? `分析于 ${formatDate(track.analyzed_at)}` : "未分析"}
        </div>
        {track.analysis_error && (
          <p style={{ color: "var(--kd-warn)", marginTop: "0.4rem" }}>{track.analysis_error}</p>
        )}
      </Panel>

      <Panel heading="接下一首" padded dense>
        {/* 放宽筛选之后这里动辄三四十首，不封高度会把下面的面板挤到看不见 */}
        <div className="kd-scroll" style={{ maxHeight: "13rem" }}>
          <HarmonicList track={track} onSelect={selectTrack} />
        </div>
      </Panel>

      <Panel heading="文件" padded dense>
        <div className="kd-col" style={{ gap: "0.2rem", fontSize: "var(--kd-size-sm)" }}>
          {/* 时长/格式/大小已经在顶部标题下那行显示过了，这里不重复 */}
          <Row label="采样率">
            {track.samplerate ? `${(track.samplerate / 1000).toFixed(1)} kHz` : DASH}
            {track.channels ? ` · ${track.channels}ch` : ""}
          </Row>
          <Row label="来源">{track.source_platform || "local"}</Row>
          <Row label="入库">{formatDate(track.added_at)}</Row>
          <Row label="路径">
            <span className="kd-mono kd-faint" title={track.path}>
              {track.path}
            </span>
          </Row>
        </div>
      </Panel>

      <Panel heading="标记" padded dense>
        <div className="kd-row" style={{ gap: "0.15rem", marginBottom: "0.4rem" }}>
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              className="kd-btn kd-btn-icon"
              data-variant="ghost"
              data-size="sm"
              aria-label={`${value} 星`}
              // 再点当前星级 = 清零，不然打错了没法撤
              onClick={() =>
                void updateTrack(track.id, { rating: track.rating === value ? 0 : value }).catch(
                  (error: unknown) => pushToast("error", `评分失败：${(error as Error).message}`),
                )
              }
            >
              <Star
                size={13}
                fill={value <= track.rating ? "var(--kd-theme)" : "none"}
                color={value <= track.rating ? "var(--kd-theme)" : "currentColor"}
              />
            </button>
          ))}
        </div>
        <textarea
          className="kd-textarea"
          style={{ width: "100%" }}
          rows={2}
          value={comment}
          placeholder="备注：这首放在哪个段落、和谁接过、要不要练"
          onChange={(event) => saveComment(event.target.value)}
        />
      </Panel>

      <Panel
        heading="调号轮"
        padded
        dense
        // 说明文字挪进 title：它只在第一次有用，占一整行不值
        className="kd-relative"
      >
        <div
          style={{ display: "flex", justifyContent: "center" }}
          title="亮起的是能和它接上的调；点任意一格按调筛选曲库"
        >
          <CamelotWheel code={track.camelot} size={168} onPick={(code) => setFilter({ key: code })} />
        </div>
      </Panel>
    </div>
  );
}
