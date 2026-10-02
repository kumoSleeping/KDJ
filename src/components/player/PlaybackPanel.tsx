import { useEffectiveTopPanels, usePlaybackPanelPrefs } from "../../lib/playbackPanelPrefs";
import { useAppStore } from "../../stores/appStore";
import { NowPlayingControlPanel } from "./NowPlayingControlPanel";
import { NowPlayingWaveformPanel } from "./NowPlayingWaveformPanel";
import { topPanelItems } from "./TopPanelIndex";
import { cloneElement, isValidElement, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import { InlineNotice, Panel } from "../common";
import { PanelStack } from "../common/PanelStack";
import { DetailVisualizerPanel } from "../library/DetailVisualizerPanel";
import { canShowPlaybackVisual, isLocalPlaybackVideo, playbackPanelItemsForTrack } from "./playbackPanelItems";
import { NowPlayingVideoPanel } from "./NowPlayingVideoPanel";
import { LyricsDetailPanel } from "./LyricsView";
import { TrackDetail } from "../library/TrackDetail";
import { StreamTrackDetail } from "./StreamTrackDetail";
import { isStreamTrack } from "../../lib/streamTrack";
import "./PlaybackPanel.css";

/** Active tasks and transport live in the right drawer, independent of selection. */
export function PlaybackPanel({ indexTarget = null, searchOpen = true, renderSearch, sidebar }: {
  indexTarget?: HTMLElement | null;
  searchOpen?: boolean;
  sidebar?: { open: boolean; toggle(): void };
  renderSearch?(): ReactNode;
}) {
  const previewOpen = usePlaybackPanelPrefs(state => state.open);
  const enabled = useEffectiveTopPanels();
  const configuredEnabled = usePlaybackPanelPrefs(state => state.enabled);
  const setEnabled = usePlaybackPanelPrefs(state => state.setEnabled);
  const keyNotation = useAppStore(state => state.settings?.key_notation ?? "camelot");
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const editingTrackId = useVisualizerStudioStore(state => state.inlineSettings ? null : state.track?.id ?? null);
  const inlineSettings = useVisualizerStudioStore(state => state.inlineSettings);
  const [error, setError] = useState("");
  useEffect(() => setError(""), [track?.id]);
  useEffect(() => {
    if (!inlineSettings) return;
    const editor = useVisualizerStudioStore.getState();
    if (track && canShowPlaybackVisual(track, null) && !isLocalPlaybackVideo(track)) editor.follow(track);
    else editor.close();
  }, [track, inlineSettings]);
  const hasVisualizer = canShowPlaybackVisual(track, editingTrackId);
  const video = isLocalPlaybackVideo(track);
  // Stable keys and panel membership: resolving media updates bodies, not the dock composition.
  const panels = (information?: ReactNode, metadata?: ReactNode, analysis?: ReactNode) => <div className="kd-playback-panels">
    <PanelStack reorderable initialFirstIds={["search"]} defaultFirstIds={["search", "visualizer", "lyrics"]} defaultLastIds={["information", "metadata"]} storageKey="kd-activity-panels" index={{
      sections: { defaultSide: "right", sidebar, panels: {
        control: { side: previewOpen ? "top" : "right", legacyDockId: "kd-top-playback-panels:control" },
        waveform: { side: previewOpen ? "top" : "right", legacyDockId: "kd-top-playback-panels:waveform" },
        search: { side: searchOpen ? "top" : "right", legacyDockId: "kd-top-search-panels:search" },
      } },
      controls: {
        control: { visible: configuredEnabled.control, setVisible: value => setEnabled("control", value) },
        waveform: { visible: configuredEnabled.waveform, setVisible: value => setEnabled("waveform", value) },
        search: { visible: configuredEnabled.search, setVisible: value => setEnabled("search", value) },
      },
      panels:{ ...playbackPanelItemsForTrack(track), ...topPanelItems, analysis: { label: "Analysis", icon: topPanelItems.waveform.icon } }, target:indexTarget, triggerClassName: "kd-chrome-btn", hideTrigger: !indexTarget,
    }}>
      {!previewOpen && enabled.control && (track
        ? <NowPlayingControlPanel key="control" track={track} keyNotation={keyNotation} onError={setError} />
        : <Panel key="control" heading="播放控制" className="kd-panel-placeholder" dense />)}
      {!previewOpen && enabled.waveform && (track
        ? <NowPlayingWaveformPanel key="waveform" track={track} />
        : <Panel key="waveform" heading="波形" dense />)}
      {!searchOpen && enabled.search && <Panel key="search" heading="聚合搜索" dense padded={false}>
        <div className="kd-detail-search">{renderSearch?.()}</div>
      </Panel>}
      {isValidElement(analysis) ? cloneElement(analysis, { key: "analysis" }) : <Panel key="analysis" heading="Analysis" className="kd-panel-placeholder" dense />}
      {track && !video ? <LyricsDetailPanel key="lyrics" track={track} reserveEmpty /> : <Panel key="lyrics" heading="歌词" dense />}
      {track && hasVisualizer ? (video ? <NowPlayingVideoPanel key="visualizer" track={track} />
        : <DetailVisualizerPanel key="visualizer" track={track} />) : <Panel key="visualizer" heading="视窗" dense />}
      <Panel key="information" heading={video ? "视频信息" : "曲目信息"} className={!track ? "kd-panel-placeholder" : undefined} dense>{information}</Panel>
      {metadata ?? <Panel key="metadata" heading="Meta" className="kd-panel-placeholder" dense />}
    </PanelStack>
  </div>;
  return <section id="kd-playback-panel" className="kd-playback-panel" aria-label="详情">
    <InlineNotice text={error} onDismiss={() => setError("")} />
    {!track && panels()}
    {track && (isStreamTrack(track) ? <StreamTrackDetail track={track} restoreTarget={indexTarget} renderPanels={panels} />
      : <TrackDetail track={track} mode="summary" renderPanels={panels} />)}
  </section>;
}
