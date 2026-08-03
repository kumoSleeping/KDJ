import { useState, useSyncExternalStore } from "react";
import { Download, LoaderCircle, Pause, Play, RotateCcw } from "lucide-react";
import { formatDuration } from "../../lib/format";
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
import { useAppStore } from "../../stores/appStore";
import { useDownloadStore } from "../../stores/downloadStore";
import type { Track } from "../../types";
import { Button, InlineNotice, Panel } from "../common";
import { CoverImage } from "../common/VinylPlaceholder";
import { PLATFORM_LABEL } from "../download/MergedGroupRow";
import { PlatformMark } from "../download/PlatformMark";
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

/**
 * 在线曲目沿用本地详情的“封面 + 标题事实 + 文字动作 + Explore”骨架。
 * 它没有本地文件与分析记录，因此不渲染 Metadata、BPM、调性或 Cue 面板；
 * 真正的媒体元素仍只在底部 PlayerBar，这里只发播放命令或发起首次解析。
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
  const openQueuePanel = useAppStore((state) => state.openQueuePanel);
  const enqueue = useDownloadStore((state) => state.enqueue);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [actionError, setActionError] = useState("");

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
      await enqueue([source], {
        quality: settings?.default_quality ?? null,
        // 在线详情不分析；下载完成后的全局自动分析策略仍由下载后端统一处理。
        analyze: null,
      });
      openQueuePanel();
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
    <div className="kd-col" style={{ gap: "0.6rem", padding: "0.7rem" }}>
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
          variant="primary"
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

      <Panel heading="Explore" padded dense>
        <VjSearchPanel track={track} />
      </Panel>
    </div>
  );
}
