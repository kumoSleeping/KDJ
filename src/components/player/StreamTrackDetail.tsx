import { useCallback, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Download, LoaderCircle, Pause, Play, RotateCcw } from "lucide-react";
import { DASH, formatBpm, formatDate, formatDuration } from "../../lib/format";
import {
  getPlayerSession,
  requestPlayerCommand,
  subscribePlayerSession,
} from "../../lib/playerSession";
import {
  getSongPreviewState,
  playSongPreview,
  retrySongPreview,
  sourceKey,
  subscribeSongPreviewState,
} from "../../lib/songPreview";
import { streamCoverUrl, streamMeta } from "../../lib/streamTrack";
import { enqueueMediaDownloads } from "../../lib/mediaActions";
import {
  streamAnalysisSnapshot,
  subscribeStreamAnalysis,
  type StreamAnalysisSnapshot,
} from "../../lib/streamAnalysis";
import { useAppStore } from "../../stores/appStore";
import type { Track } from "../../types";
import { Button, InlineNotice, Panel } from "../common";
import { CoverImage } from "../common/VinylPlaceholder";
import { PLATFORM_LABEL } from "../download/MergedGroupRow";
import { PlatformMark } from "../download/PlatformMark";
import { CamelotWheel } from "../library/CamelotWheel";
import { VjSearchPanel } from "../library/VjSearchPanel";

const STATUS_LABEL = {
  idle: "等待播放",
  resolving: "正在解析试听地址",
  loading: "正在加载",
  buffering: "正在缓冲",
  playing: "正在播放",
  paused: "已暂停",
  ended: "播放结束",
  error: "播放失败",
} as const;

function qualityLabel(value: string | null | undefined): string {
  if (!value) return "自动音质";
  return value === "flac" ? "FLAC" : `${value}K`;
}

function StreamAnalysisPanel({ snapshot }: { snapshot: StreamAnalysisSnapshot }) {
  const result = snapshot.result;
  const ready = snapshot.phase === "ready" && result;

  if (!ready) {
    const copy =
      snapshot.phase === "analyzing"
        ? "完整音频已就绪，正在分析 BPM、调号与响度…"
        : snapshot.phase === "waiting"
          ? "正在等待播放器收齐完整音频…"
          : snapshot.phase === "failed"
            ? "完整音频已收到，但没有生成可用的分析结果。"
            : "开始播放后，完整音频一旦收齐就会自动分析。";
    return (
      <Panel heading="Analysis" padded dense>
        <div
          className="kd-stream-analysis-status"
          data-state={snapshot.phase}
          aria-live="polite"
        >
          {snapshot.phase === "analyzing" ? (
            <LoaderCircle size={15} className="kd-spin" aria-hidden="true" />
          ) : null}
          <div>
            <strong>{copy}</strong>
            <span>直接复用在线播放已经落盘的媒体，不会为分析再下载一份。</span>
          </div>
        </div>
        <InlineNotice text={snapshot.phase === "failed" ? snapshot.error : ""} block />
      </Panel>
    );
  }

  const bpmConfidence =
    result.bpm_confidence !== null ? Math.round(result.bpm_confidence * 100) : null;
  const keyConfidence =
    result.key_confidence !== null ? Math.round(result.key_confidence * 100) : null;
  const warning = snapshot.error || result.errors.join("；");

  return (
    <Panel heading="Analysis" padded dense>
      <div className="kd-analysis-deck">
        <div
          className="kd-analysis-wheel"
          title={`${result.key || "调号未知"}${keyConfidence !== null ? ` · 置信度 ${keyConfidence}%` : ""}`}
        >
          <CamelotWheel code={result.camelot} size={112} />
        </div>

        <div className="kd-analysis-readout" aria-label="在线歌曲节奏与响度">
          <div className="kd-analysis-metric">
            <span className="kd-analysis-metric-label">BPM</span>
            <span className="kd-analysis-metric-value">{formatBpm(result.bpm)}</span>
            <div
              className="kd-analysis-meter"
              style={
                bpmConfidence !== null
                  ? ({ "--kd-meter": `${bpmConfidence}%` } as CSSProperties)
                  : undefined
              }
              data-empty={bpmConfidence === null || undefined}
              title={bpmConfidence !== null ? `置信度 ${bpmConfidence}%` : "未检出稳定节拍"}
            >
              <i aria-hidden="true" />
            </div>
            <span className="kd-analysis-metric-hint">
              置信度 {bpmConfidence !== null ? `${bpmConfidence}%` : DASH}
            </span>
          </div>

          <div className="kd-analysis-metric-sep" aria-hidden="true" />

          <div className="kd-analysis-metric">
            <span className="kd-analysis-metric-label">能量 / 响度</span>
            <span className="kd-analysis-metric-value">
              {result.energy !== null ? `${result.energy}/10` : DASH}
            </span>
            <span className="kd-analysis-metric-hint">
              {result.rms_db !== null ? `RMS ${result.rms_db.toFixed(1)} dBFS` : DASH}
              {result.peak_db !== null ? ` · Peak ${result.peak_db.toFixed(1)}` : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="kd-row kd-faint kd-analysis-meta">
        调号 {result.key || result.key_short || DASH}
        <span className="kd-toolbar-gap" />
        调性置信度 {keyConfidence !== null ? `${keyConfidence}%` : DASH}
        <span className="kd-toolbar-gap" />
        首拍 {result.first_beat !== null ? `${result.first_beat.toFixed(3)}s` : DASH}
        <span className="kd-toolbar-gap" />
        分析长度 {formatDuration(result.duration)}
        {snapshot.completedAt ? (
          <>
            <span className="kd-toolbar-gap" />
            分析于 {formatDate(snapshot.completedAt)}
          </>
        ) : null}
      </div>
      {warning ? <p className="kd-stream-analysis-warning">部分分析提示：{warning}</p> : null}
      <p className="kd-faint kd-stream-analysis-note">本次在线试听的临时结果，不会写入曲库或文件标签。</p>
    </Panel>
  );
}

/**
 * 在线曲目沿用本地详情的“封面 + 标题事实 + 文字动作 + Explore”骨架。
 * 它没有曲库记录，但代理收到完整媒体后会复用会话文件做一次临时分析；
 * 真正的媒体元素仍只在底部 PlayerBar，这里只发播放命令或展示共享分析快照。
 */
export function StreamTrackDetail({ track }: { track: Track }) {
  const session = useSyncExternalStore(
    subscribePlayerSession,
    getPlayerSession,
    getPlayerSession,
  );
  const preview = useSyncExternalStore(
    subscribeSongPreviewState,
    getSongPreviewState,
    getSongPreviewState,
  );
  const settings = useAppStore((state) => state.settings);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const subscribeAnalysis = useCallback(
    (listener: () => void) => subscribeStreamAnalysis(track.id, listener),
    [track.id],
  );
  const readAnalysis = useCallback(() => streamAnalysisSnapshot(track.id), [track.id]);
  const analysis = useSyncExternalStore(subscribeAnalysis, readAnalysis, readAnalysis);

  const meta = streamMeta(track);
  const source = meta?.source ?? null;
  const active = session.trackId === track.id;
  const duration = active ? session.duration || track.duration || 0 : track.duration || 0;
  const matchingPreview = source && preview.sourceKey === sourceKey(source) ? preview : null;
  const status = matchingPreview?.phase === "resolving"
    ? "resolving"
    : active
      ? session.status
      : "idle";

  const togglePlayback = async () => {
    if (!source) return;
    setActionError("");
    if (active) {
      requestPlayerCommand({ type: "toggle" });
      return;
    }
    try {
      await playSongPreview({
        source,
        title: track.title,
        artist: track.artist,
        autoPlay: true,
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const retry = async () => {
    if (!source) return;
    setActionError("");
    try {
      if (matchingPreview?.request) await retrySongPreview(matchingPreview.request);
      else {
        await playSongPreview({
          source,
          title: track.title,
          artist: track.artist,
          autoPlay: true,
          bypassCache: true,
        });
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const download = async () => {
    if (!source || downloadBusy) return;
    setDownloadBusy(true);
    setActionError("");
    try {
      await enqueueMediaDownloads([source], {
        quality: settings?.default_quality ?? null,
        // 这里只不覆盖“下载后入库分析”策略；上面的试听临时分析与下载任务无关。
        analyze: null,
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDownloadBusy(false);
    }
  };

  const errorText =
    actionError || matchingPreview?.error || (active ? session.error : "");
  const cover = streamCoverUrl(track);

  return (
    <div className="kd-col kd-track-detail" style={{ gap: "0.6rem", padding: "0.7rem" }}>
      <div className="kd-row" style={{ gap: "0.6rem", alignItems: "flex-start" }}>
        <div
          className="kd-cover kd-stream-detail-cover"
          style={{ width: 76, height: 76 }}
          aria-label="在线曲目封面"
        >
          <CoverImage
            src={cover}
            alt=""
            className="kd-stream-detail-cover-image"
            loading="eager"
          />
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            className="kd-truncate"
            style={{ fontWeight: 700, fontSize: "var(--kd-size-lg)" }}
            title={track.title || track.filename}
          >
            {track.title || track.filename}
          </div>
          <div className="kd-truncate kd-muted" title={track.artist}>
            {track.artist || "未知艺术家"}
          </div>
          <div className="kd-truncate kd-faint" title={track.album}>
            {track.album || "—"}
          </div>
          <div
            className="kd-row kd-faint kd-stream-detail-facts"
            style={{ gap: "0.4rem", fontSize: "var(--kd-size-xs)" }}
            aria-live="polite"
          >
            {source ? <PlatformMark id={source.platform} size={13} /> : null}
            <span>{source ? PLATFORM_LABEL[source.platform] : "在线来源"}</span>
            <span>{qualityLabel(source?.max_quality)}</span>
            <span>{formatDuration(duration)}</span>
            {source?.vip ? (
              <span className="kd-chip" data-tone="warn">
                VIP
              </span>
            ) : null}
            <span>{STATUS_LABEL[status]}</span>
          </div>
        </div>
      </div>

      <div className="kd-row" style={{ flexWrap: "wrap", gap: "0.3rem" }}>
        <Button
          size="sm"
          variant="ghost"
          disabled={!source || matchingPreview?.phase === "resolving"}
          onClick={() => void togglePlayback()}
        >
          {matchingPreview?.phase === "resolving" ? (
            <LoaderCircle size={12} className="kd-spin" />
          ) : session.playing && active ? (
            <Pause size={12} />
          ) : (
            <Play size={12} />
          )}
          {matchingPreview?.phase === "resolving"
            ? "解析中…"
            : session.playing && active
              ? "暂停"
              : "播放"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!source || downloadBusy}
          onClick={() => void download()}
        >
          {downloadBusy ? (
            <LoaderCircle size={12} className="kd-spin" />
          ) : (
            <Download size={12} />
          )}
          {downloadBusy ? "正在加入…" : "下载"}
        </Button>
        {(status === "error" || matchingPreview?.canRetry) && source ? (
          <Button size="sm" variant="ghost" onClick={() => void retry()}>
            {matchingPreview?.phase === "resolving" ? (
              <LoaderCircle size={12} className="kd-spin" />
            ) : (
              <RotateCcw size={12} />
            )}
            重试试听
          </Button>
        ) : null}
      </div>

      <InlineNotice
        text={errorText}
        onDismiss={actionError ? () => setActionError("") : undefined}
      />

      <StreamAnalysisPanel snapshot={analysis} />

      <Panel heading="Explore" padded dense>
        <VjSearchPanel track={track} />
      </Panel>
    </div>
  );
}
