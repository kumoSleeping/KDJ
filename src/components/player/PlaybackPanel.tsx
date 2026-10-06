import { useEffectiveTopPanels, usePlaybackPanelPrefs } from "../../lib/playbackPanelPrefs";
import { useDetailVisualizerPrefs } from "../../lib/detailVisualizerPrefs";
import { usePanelViewport } from "../../lib/panelViewport";
import { hasVisibleLyrics } from "../../lib/lyricsVisibility";
import { isVideoTrack } from "../../lib/format";
import { useLyricsStore } from "../../stores/lyricsStore";
import { TextQuote } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { NowPlayingControlPanel } from "./NowPlayingControlPanel";
import { NowPlayingWaveformPanel } from "./NowPlayingWaveformPanel";
import { topPanelItems } from "./TopPanelIndex";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import { InlineNotice, Panel } from "../common";
import { PanelStack } from "../common/PanelStack";
import { AsyncPanelBody } from "../common/AsyncPanelBody";
import { DownloadTaskPanel, taskPanelItems } from "./TaskPanels";
import { DetailVisualizerPanel } from "../library/DetailVisualizerPanel";
import { canShowPlaybackVisual, isLocalPlaybackVideo, playbackPanelItemsForTrack } from "./playbackPanelItems";
import { NowPlayingVideoPanel } from "./NowPlayingVideoPanel";
import { LyricsDetailPanel } from "./LyricsView";
import { TrackDetail } from "../library/TrackDetail";
import { StreamTrackDetail } from "./StreamTrackDetail";
import { isStreamTrack, streamMeta } from "../../lib/streamTrack";
import "./PlaybackPanel.css";

/** Active tasks and transport live in the right drawer, independent of selection. */
export function PlaybackPanel({ indexTarget = null, searchOpen = true, renderSearch }: {
  indexTarget?: HTMLElement | null;
  searchOpen?: boolean;
  renderSearch?(): ReactNode;
}) {
  const previewOpen = usePlaybackPanelPrefs(state => state.open);
  const enabled = useEffectiveTopPanels();
  const configuredEnabled = usePlaybackPanelPrefs(state => state.enabled);
  const setEnabled = usePlaybackPanelPrefs(state => state.setEnabled);
  const keyNotation = useAppStore(state => state.settings?.key_notation ?? "camelot");
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const lyricsEntry = useLyricsStore(state => state.get(track?.id));
  const lyricsReady = !!track && !isVideoTrack(track.format) && streamMeta(track)?.kind !== "video"
    && hasVisibleLyrics(lyricsEntry.lines);
  const expandedPanelId = usePanelViewport(state => state.expandedPanelId);
  useEffect(() => {
    if (!lyricsReady && expandedPanelId === "kd-activity-panels:lyrics")
      usePanelViewport.getState().setExpandedPanel(null);
  }, [lyricsReady, expandedPanelId]);
  const editingTrackId = useVisualizerStudioStore(state => state.inlineSettings ? null : state.track?.id ?? null);
  const inlineSettings = useVisualizerStudioStore(state => state.inlineSettings);
  const showVisualization = useDetailVisualizerPrefs(state => state.showVisualization);
  const setShowVisualization = useDetailVisualizerPrefs(state => state.setShowVisualization);
  const [error, setError] = useState("");
  const [metadataReveal, setMetadataReveal] = useState(0);
  useEffect(() => setError(""), [track?.id]);
  useEffect(() => {
    if (!inlineSettings) return;
    const editor = useVisualizerStudioStore.getState();
    if (showVisualization && track && canShowPlaybackVisual(track, null) && !isLocalPlaybackVideo(track)) editor.follow(track);
    else editor.close();
  }, [track, inlineSettings, showVisualization]);
  const video = isLocalPlaybackVideo(track);
  const hasVisualizer = (video || showVisualization) && canShowPlaybackVisual(track, editingTrackId);
  // Stable keys and panel membership: resolving media updates bodies, not the dock composition.
  const panels = (information?: ReactNode, metadata?: ReactNode) => <div className="kd-playback-panels">
    <PanelStack reorderable initialFirstIds={["downloads", "search"]} defaultFirstIds={["downloads", "search", "visualizer", "lyrics"]} defaultLastIds={["information", "metadata"]} storageKey="kd-activity-panels" portraitOverlayIds={["lyrics"]}
      reveal={metadataReveal ? { id: "metadata", revision: metadataReveal } : undefined} index={{
      sections: { defaultSide: "right", options: {
        visualizer: <label className="kd-check kd-panel-index-option">
          <input type="checkbox" checked={showVisualization}
            onChange={event => setShowVisualization(event.currentTarget.checked)} />
          <span>展示可视化</span>
        </label>,
      }, panels: {
        control: { side: previewOpen ? "top" : "right", legacyDockId: "kd-top-playback-panels:control" },
        waveform: { side: previewOpen ? "top" : "right", legacyDockId: "kd-top-playback-panels:waveform" },
        search: { side: searchOpen ? "top" : "right", legacyDockId: "kd-top-search-panels:search" },
      } },
      controls: {
        control: { visible: configuredEnabled.control, setVisible: value => setEnabled("control", value) },
        waveform: { visible: configuredEnabled.waveform, setVisible: value => setEnabled("waveform", value) },
        search: { visible: configuredEnabled.search, setVisible: value => setEnabled("search", value) },
      },
      panels:{ ...playbackPanelItemsForTrack(track), ...topPanelItems, ...taskPanelItems }, target:indexTarget, triggerClassName: "kd-chrome-btn", hideTrigger: !indexTarget,
    }}>
      <DownloadTaskPanel key="downloads" />
      {!previewOpen && enabled.control && (track
        ? <NowPlayingControlPanel key="control" track={track} keyNotation={keyNotation} onError={setError} />
        : <Panel key="control" heading="播放控制" className="kd-panel-placeholder" dense />)}
      {!previewOpen && enabled.waveform && (track
        ? <NowPlayingWaveformPanel key="waveform" track={track} />
        : <Panel key="waveform" heading="波形" dense />)}
      {!searchOpen && enabled.search && <Panel key="search" heading="聚合搜索" dense padded={false}>
        <div className="kd-detail-search">{renderSearch?.()}</div>
      </Panel>}
      {track ? <LyricsDetailPanel key="lyrics" track={track} reserveEmpty expandKey="kd-activity-panels:lyrics" />
        : <Panel key="lyrics" heading="歌词" dense /> }
      {track && hasVisualizer ? (video ? <NowPlayingVideoPanel key="visualizer" track={track} />
        : <DetailVisualizerPanel key="visualizer" track={track} />) : <Panel key="visualizer" heading="视窗" floatingHeader dense padded={false} className="kd-panel-empty-media">
          {track && <AsyncPanelBody kind="visualizer" state="empty" />}
        </Panel>}
      <Panel key="information" heading={video ? "视频信息" : "曲目信息"} className={!track ? "kd-panel-placeholder" : undefined}
        visibleHeader={!!track && !video} actions={track && !video && lyricsReady ? <button type="button" className="kd-manager-panel-action" aria-label="打开歌词"
          title="打开歌词" onClick={() => usePanelViewport.getState().setExpandedPanel("kd-activity-panels:lyrics")}>
          <TextQuote size={14} aria-hidden="true" />
        </button> : undefined} dense>{information}</Panel>
      {metadata ?? <Panel key="metadata" heading="Meta" className="kd-panel-placeholder" dense />}
    </PanelStack>
  </div>;
  return <section id="kd-playback-panel" className="kd-playback-panel" aria-label="详情">
    <InlineNotice text={error} onDismiss={() => setError("")} />
    {!track && panels()}
    {track && (isStreamTrack(track) ? <StreamTrackDetail track={track} restoreTarget={indexTarget} renderPanels={panels} />
      : <TrackDetail track={track} mode="summary" renderPanels={panels}
          onRevealMetadata={() => setMetadataReveal(value => value + 1)} />)}
  </section>;
}
