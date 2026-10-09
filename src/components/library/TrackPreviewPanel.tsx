import { AudioLines, ScanSearch } from "lucide-react";
import { PanelStack } from "../common/PanelStack";
import { Panel } from "../common";
import type { Track } from "../../types";
import { useTopPanels } from "../../lib/playbackPanelPrefs";
import { NowPlayingWaveformPanel } from "../player/NowPlayingWaveformPanel";
import "./TrackPreviewPanel.css";

const topPanels = {
  search: { label: "聚合搜索", icon: <ScanSearch size={14} /> },
  waveform: { label: "波形", icon: <AudioLines size={14} /> },
};

/** The loaded deck's waveform sits above the list, independently of list selection. */
export function TrackPreviewPanel({ track, indexTarget }: { track: Track | null; indexTarget: HTMLElement | null }) {
  const enabled = useTopPanels(state => state.enabled);
  const setEnabled = useTopPanels(state => state.setEnabled);
  return <section id="kd-track-preview" className="kd-track-preview-row" aria-label="当前曲目">
    <PanelStack storageKey="kd-top-playback-panels" index={{
      panels: topPanels, target: indexTarget, triggerClassName: "kd-chrome-btn", hideTrigger: !indexTarget,
      controls: {
        search: { visible: enabled.search, setVisible: value => setEnabled("search", value) },
        waveform: { visible: enabled.waveform, setVisible: value => setEnabled("waveform", value) },
      },
    }}>
      <div key="waveform" className="kd-track-preview-waveform">
        {track ? <NowPlayingWaveformPanel track={track} /> : <Panel heading="波形" dense />}
      </div>
    </PanelStack>
  </section>;
}
