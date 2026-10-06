import { useContext } from "react";
import { PanelTopClose, PanelTopOpen } from "lucide-react";
import { PlaybackPanelIndexTargetContext } from "./playbackPanelIndex";
import { usePlaybackPanelPrefs } from "../../lib/playbackPanelPrefs";
import { usePanelViewport } from "../../lib/panelViewport";
import { toggleResponsivePanel } from "../common/panelDock";

export function PlaybackPanelToggle({ inPanel = false }: { inPanel?: boolean }) {
  const indexTarget = useContext(PlaybackPanelIndexTargetContext);
  const open = usePlaybackPanelPrefs(state => state.open);
  const setOpen = usePlaybackPanelPrefs(state => state.setOpen);
  const viewport = usePanelViewport();
  const expanded = viewport.compact ? viewport.activeIds.includes("kd-activity-panels:control") : open;
  const label = expanded ? "收起曲目预览" : "展开曲目预览";
  return <>{!viewport.narrow && (inPanel ? expanded : !expanded) && <button type="button" className="kd-activity-search-toggle kd-playback-panel-toggle"
    title={label} aria-label={label} aria-expanded={expanded} aria-controls="kd-track-preview"
    aria-pressed={expanded} onClick={() => viewport.compact ? toggleResponsivePanel("kd-activity-panels:control") : setOpen(!open)}>
    {expanded ? <PanelTopClose size={14} /> : <PanelTopOpen size={14} />}
  </button>}{!inPanel && indexTarget && <span className="kd-playback-panel-index-slot" ref={indexTarget} />}</>;
}
