import { useSyncExternalStore, type ReactNode } from "react";
import { DASH, formatBytes, formatDuration, isVideoTrack } from "../../lib/format";
import { consumeSuppressedCoverClick } from "../../lib/trackDrag";
import { trackMetaEditorAnchor, useTrackMetaEditor } from "../../lib/trackMetaEditor";
import type { Track } from "../../types";
import { InlineNotice, Panel } from "../common";
import { DetailPanelStack } from "./DetailPanelStack";
import { useVideoPip } from "../../lib/videoPip";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { LyricsDetailPanel } from "../player/LyricsView";
import { MarqueeText } from "../common/MarqueeText";
import { LocalVideoPlayer } from "./LocalVideoPlayer";
import { PLATFORM_LABEL } from "../download/MergedGroupRow";
import { PlatformMark } from "../download/PlatformMark";
import {
  LocalTrackCacheFacts,
  localDownloadPlatform,
} from "../player/LocalTrackCacheFacts";
import { TrackCoverBox, useTrackCover } from "./trackCover";

/**
 * 曲目摘要：封面、标题和文件事实。Meta 的查看与编辑在浮动的 TrackMetaEditor 里，
 * 这里只留进入它的封面，以及直接拖到封面上的换图。
 */
export function TrackDetail({ track, restoreTarget = null, mode = "detail", onEdit, onUpdated, renderPanels }: {
  track: Track;
  restoreTarget?: HTMLElement | null;
  /** The host lays the summary out itself. */
  renderPanels?(information: ReactNode): ReactNode;
  mode?: "detail" | "preview" | "summary";
  onEdit?(): void;
  onUpdated?(track: Track): void;
}) {
  const preview = mode === "preview";
  const playingTrack = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  // Playback belongs to the activity panel/float; selection must not mount another decoder.
  const playbackOwnsVideo = playingTrack?.id === track.id;
  const pipOwnsVideo = useVideoPip(
    (state) =>
      state.active &&
      state.session?.source === "local" &&
      state.session.trackId === track.id,
  );
  // 编辑器开在同一首上时，拖到封面上的曲目由它接：一次落点只换一次封面。
  const editorOpen = useTrackMetaEditor((state) => state.trackId === track.id);
  const cover = useTrackCover(track, { onUpdated, receivesDrops: !preview && !editorOpen });
  const { hasCover, busy, notice, setNotice } = cover;

  const openMetaEditor = (from: Element) => {
    if (consumeSuppressedCoverClick() || busy) return;
    if (preview) { onEdit?.(); return; }
    useTrackMetaEditor.getState().open(track.id, trackMetaEditorAnchor(from));
  };

  const downloadPlatform = localDownloadPlatform(track);
  const fileFactsText = [
    downloadPlatform ? PLATFORM_LABEL[downloadPlatform] : "",
    track.format.toUpperCase() || DASH,
    track.bitrate ? `${track.bitrate} kbps` : "",
    formatDuration(track.duration),
    `文件 ${formatBytes(track.size)}`,
  ].filter(Boolean).join(" ");

  const information = (
      <div
        className="kd-row kd-track-detail-hero"
        style={{ gap: "0.6rem", alignItems: "flex-start" }}
      >
        <TrackCoverBox
          track={track}
          cover={cover}
          droppable={!preview}
          label="编辑封面"
          title={hasCover ? "点击编辑曲目信息" : "点击 [+] 编辑曲目信息"}
          onActivate={openMetaEditor}
        />
        <div className="kd-track-detail-summary" style={{ minWidth: 0 }}>
          {/* 标题、艺人、专辑放不下时来回滚动，而不是只截断成省略号。 */}
          <MarqueeText className="kd-track-detail-title" text={track.title || track.filename} />
          <MarqueeText className="kd-muted" text={track.artist || DASH} />
          <MarqueeText className="kd-faint" text={track.album || DASH} />
          <div
            className="kd-faint kd-track-detail-local-facts"
            style={{ fontSize: "var(--kd-size-xs)" }}
          >
            <div className="kd-track-detail-file-facts" title={fileFactsText}>
              {downloadPlatform ? (
                <PlatformMark id={downloadPlatform} size={13} branded />
              ) : null}
              <span className="kd-track-detail-file-facts-copy">{fileFactsText}</span>
            </div>
            <LocalTrackCacheFacts track={track} />
            {track.tags.length > 0 && <div className="kd-row" style={{ gap: "0.25rem", flexWrap: "wrap" }}>
              {track.tags.map(tag => <span key={tag} className="kd-chip" style={{ textTransform: "none" }}>{tag}</span>)}
            </div>}
            {track.comment && <p className="kd-muted" style={{ whiteSpace: "pre-wrap" }}>{track.comment}</p>}
          </div>
        </div>
      </div>
  );

  return (
    <div className={`kd-col kd-track-detail${preview ? " kd-track-preview" : ""}`}
      style={preview || renderPanels ? undefined : { gap: "0.6rem", padding: "0.7rem" }}>
      {!renderPanels && !preview && information}
      <InlineNotice text={notice} onDismiss={() => setNotice("")} />
      {renderPanels ? renderPanels(information) : mode === "summary" ? null : <DetailPanelStack restoreTarget={restoreTarget} preview={preview}>

        {mode === "detail" && <LyricsDetailPanel key="lyrics" track={track} />}
        {mode === "detail" && isVideoTrack(track.format) && !playbackOwnsVideo && !pipOwnsVideo && (
          <Panel key="video" heading="视频" padded={false} dense><LocalVideoPlayer track={track} /></Panel>
        )}
      </DetailPanelStack>}
    </div>
  );
}
