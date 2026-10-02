import { useCallback, useState, useSyncExternalStore, type ReactNode, type CSSProperties } from "react";
import { DASH, formatBpm, formatDuration } from "../../lib/format";
import { getPlayerSession, subscribePlayerSession } from "../../lib/playerSession";
import {
  getSongPreviewState,
  sourceKey,
  subscribeSongPreviewState,
} from "../../lib/songPreview";
import { streamCoverUrl, streamMeta, streamTrackById } from "../../lib/streamTrack";
import {
  streamAnalysisSnapshot,
  subscribeStreamAnalysis,
  trackWithStreamAnalysis,
  type StreamAnalysisSnapshot,
} from "../../lib/streamAnalysis";
import {
  streamCueSnapshot,
  subscribeStreamCue,
  trackWithStreamCue,
} from "../../lib/streamCue";
import { useLibraryStore } from "../../stores/libraryStore";
import type { Track } from "../../types";
import { InlineNotice, Panel } from "../common";
import { DetailPanelStack } from "../library/DetailPanelStack";
import { CoverImage } from "../common/VinylPlaceholder";
import { PLATFORM_LABEL } from "../download/MergedGroupRow";
import { PlatformMark } from "../download/PlatformMark";
import { CamelotWheel } from "../library/CamelotWheel";
import { EnergyMeter } from "../library/TrackTable";
import { OnlineTrackCacheFacts } from "./OnlineTrackCacheFacts";
import { LyricsDetailPanel } from "./LyricsView";

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

function StreamAnalysisPanel({
  snapshot,
  track,
}: {
  snapshot: StreamAnalysisSnapshot;
  track: Track;
}) {
  const keyFilter = useLibraryStore((state) => state.filter.key);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const result = snapshot.result;
  const ready = snapshot.phase === "ready" && result;

  // 播放面板保留加载中的槽位；独立详情是否显示仍由调用方决定。
  if (!ready) return <Panel heading="Analysis" className="kd-panel-placeholder" padded dense />;

  const bpmConfidence =
    result.bpm_confidence !== null ? Math.round(result.bpm_confidence * 100) : null;
  const warning = snapshot.error || result.errors.join("；");

  return (
    <Panel heading="Analysis" padded dense>
      <div className="kd-analysis-deck">
        <div
          className="kd-analysis-wheel"
          title="亮起的是能和它接上的调；点任意一格按调筛选曲库"
        >
          <CamelotWheel
            code={track.camelot}
            size={128}
            onPick={(code) => setFilter({ key: keyFilter === code ? "" : code })}
          />
          {keyFilter && (
            <button
              type="button"
              className="kd-wheel-filter"
              title="清除调号筛选"
              onClick={() => setFilter({ key: "" })}
            >
              正在筛选 {keyFilter}
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>

        <div className="kd-analysis-readout" aria-label="在线歌曲节奏与响度">
          <div className="kd-analysis-metric">
            <span className="kd-analysis-metric-label">BPM</span>
            <span className="kd-analysis-metric-value" data-with-version="true">
              {formatBpm(track.bpm)}
              <small className="kd-analysis-version">V3</small>
            </span>
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
            <span className="kd-analysis-metric-label">相对响度</span>
            <span className="kd-analysis-metric-value">
              <EnergyMeter value={track.energy} rmsDb={track.rms_db} peakDb={track.peak_db} />
            </span>
            <span className="kd-analysis-metric-hint">
              {track.rms_db !== null ? `${track.rms_db.toFixed(1)} dBFS` : DASH}
              {track.peak_db !== null ? ` · peak ${track.peak_db.toFixed(1)}` : ""}
            </span>
          </div>
        </div>
      </div>

      {warning ? <p className="kd-stream-analysis-warning">部分分析提示：{warning}</p> : null}
    </Panel>
  );
}

/**
 * 在线曲目沿用本地详情的封面与曲目信息布局。
 * 它没有曲库记录，但代理收到完整媒体后会复用会话文件做一次临时分析；
 * 真正的媒体元素与列表动作都留在播放器 / 结果列表，这里只展示共享快照。
 */
export function StreamTrackDetail({ track, restoreTarget = null, mode = "detail", renderPanels }: {
  track: Track; restoreTarget?: HTMLElement | null; mode?: "detail" | "preview";
  renderPanels?(information: ReactNode, metadata?: ReactNode, analysis?: ReactNode): ReactNode;
}) {
  const isPreview = mode === "preview";
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
  const [actionError, setActionError] = useState("");
  const meta = streamMeta(track);
  const source = meta?.source ?? null;
  const matchingPreview = source && preview.sourceKey === sourceKey(source) ? preview : null;
  // 搜索列表条目与真正装进播放器的临时曲目编号不同；同一来源必须跟到播放器实例，
  // 否则状态、波形和缓存会永远停在“未开始”。
  const detailTrackId = matchingPreview?.trackId ?? track.id;
  const detailTrack = streamTrackById(detailTrackId) ?? track;
  const subscribeAnalysis = useCallback(
    (listener: () => void) => subscribeStreamAnalysis(detailTrackId, listener),
    [detailTrackId],
  );
  const readAnalysis = useCallback(
    () => streamAnalysisSnapshot(detailTrackId),
    [detailTrackId],
  );
  const analysis = useSyncExternalStore(subscribeAnalysis, readAnalysis, readAnalysis);
  const subscribeCue = useCallback(
    (listener: () => void) => subscribeStreamCue(detailTrackId, listener),
    [detailTrackId],
  );
  const readCue = useCallback(() => streamCueSnapshot(detailTrackId), [detailTrackId]);
  useSyncExternalStore(subscribeCue, readCue, readCue);
  const analyzedTrack = trackWithStreamCue(trackWithStreamAnalysis(detailTrack, analysis));
  const analysisReady = analysis.phase === "ready" && analysis.result !== null;

  const active = session.trackId === detailTrackId;
  const duration = active
    ? session.duration || detailTrack.duration || 0
    : detailTrack.duration || 0;
  const status = matchingPreview?.phase === "resolving"
    ? "resolving"
    : active
      ? session.status
      : "idle";

  const errorText =
    actionError || matchingPreview?.error || (active ? session.error : "");
  const cover = streamCoverUrl(track);

  const information = (
      <div
        className="kd-row kd-track-detail-hero"
        style={{ gap: "0.6rem", alignItems: "flex-start" }}
      >
        <div className="kd-stream-detail-cover-stack">
          <div
            className="kd-cover kd-stream-detail-cover"
            style={{ width: 88, height: 88 }}
            aria-label="在线曲目封面"
          >
            <CoverImage
              src={cover}
              alt=""
              className="kd-stream-detail-cover-image"
              loading="eager"
            />
          </div>
        </div>
        <div className="kd-track-detail-summary" style={{ minWidth: 0 }}>
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
            className="kd-row kd-faint kd-track-detail-facts"
            style={{
              columnGap: "0.4rem",
              rowGap: 0,
              fontSize: "var(--kd-size-xs)",
              flexWrap: "wrap",
            }}
            aria-live="polite"
          >
            {source ? <PlatformMark id={source.platform} size={13} branded /> : null}
            <span>{source ? PLATFORM_LABEL[source.platform] : "在线来源"}</span>
            <span>{qualityLabel(source?.max_quality)}</span>
            <span>{formatDuration(isPreview ? track.duration : duration)}</span>
            {source?.vip ? (
              <span className="kd-chip" data-tone="warn">
                VIP
              </span>
            ) : null}
            {!isPreview && <span>{STATUS_LABEL[status]}</span>}
            <OnlineTrackCacheFacts
              source={source}
              preview={matchingPreview}
              trackId={detailTrackId}
              video={streamMeta(track)?.kind === "video"}
            />
            {track.genre && <span>{track.genre}</span>}
            {track.year && <span>{track.year}</span>}
            {track.tags.map(tag => <span key={tag}>{tag}</span>)}
            {track.comment && <span>{track.comment}</span>}
          </div>
        </div>
      </div>
  );

  return (
    <div className={`kd-col kd-track-detail${isPreview ? " kd-track-preview" : ""}`}
      style={isPreview || renderPanels ? undefined : { gap: "0.6rem", padding: "0.7rem" }}>
      {!isPreview && !renderPanels && information}
      <InlineNotice
        text={isPreview ? actionError : errorText}
        onDismiss={actionError ? () => setActionError("") : undefined}
      />

      {renderPanels ? renderPanels(information, undefined,
        <StreamAnalysisPanel snapshot={analysis} track={analyzedTrack} />)
        : <DetailPanelStack restoreTarget={restoreTarget} preview={isPreview}>
        {!isPreview && <LyricsDetailPanel key="lyrics" track={detailTrack} />}

        {(isPreview || analysisReady) && (
          <StreamAnalysisPanel
            key="analysis"
            snapshot={analysis}
            track={analyzedTrack}
          />
        )}

      </DetailPanelStack>}
    </div>
  );
}
