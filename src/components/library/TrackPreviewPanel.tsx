import { PanelStack } from "../common/PanelStack";
import { topPanelItems } from "../player/TopPanelIndex";
import { useState } from "react";
import { InlineNotice, Panel } from "../common";
import type { Track } from "../../types";
import { useEffectiveTopPanels, usePlaybackPanelPrefs } from "../../lib/playbackPanelPrefs";
import { useAppStore } from "../../stores/appStore";
import { NowPlayingControlPanel } from "../player/NowPlayingControlPanel";
import { NowPlayingWaveformPanel } from "../player/NowPlayingWaveformPanel";
import "./TrackPreviewPanel.css";

/** The loaded deck owns both controls and waveform, independently of list selection. */
export function TrackPreviewPanel({ track }: { track: Track | null }) {
  const keyNotation = useAppStore(state => state.settings?.key_notation ?? "camelot");
  const [error, setError] = useState("");
  const enabled = useEffectiveTopPanels();
  const configuredEnabled = usePlaybackPanelPrefs(state => state.enabled);
  const setEnabled = usePlaybackPanelPrefs(state => state.setEnabled);
  const open = usePlaybackPanelPrefs(state => state.open);
  if (!open || (!enabled.control && !enabled.waveform)) return null;
  return <section id="kd-track-preview" className="kd-track-preview-row" aria-label="当前曲目">
    <PanelStack reorderable storageKey="kd-top-playback-panels" dockKey="kd-activity-panels" index={{
      panels: topPanelItems, hideTrigger: true,
      controls: {
        control: { visible: configuredEnabled.control, setVisible: value => setEnabled("control", value) },
        waveform: { visible: configuredEnabled.waveform, setVisible: value => setEnabled("waveform", value) },
      },
    }}>
    {enabled.control && <div key="control" className="kd-track-preview-eq">
      {track ? <NowPlayingControlPanel track={track} keyNotation={keyNotation} onError={setError} />
        : <Panel heading="EQ / 播放控制" className="kd-panel-placeholder" dense />}
      <InlineNotice text={error} onDismiss={() => setError("")} />
    </div>}
    {enabled.waveform && <div key="waveform" className="kd-track-preview-waveform">
      {track ? <NowPlayingWaveformPanel track={track} /> : <Panel heading="波形" dense />}
    </div>}
    </PanelStack>
  </section>;
}
