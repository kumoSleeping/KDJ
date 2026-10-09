import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useVideoPip, videoPipFloats } from "../../lib/videoPip";
import { canVisualizeTrack, useVisualizerPopup } from "../../lib/visualizerPopup";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";

const VisualizerStudioPanel = lazy(() => import("../composition/VisualizerStudioPanel"));

/** Mounts the playing song's visualizer as a floating window; nothing of it sits in the page. */
export function VisualizerPopup() {
  const open = useVisualizerPopup(state => state.open);
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  // A draft must have only one editor; the studio owns it while explicitly open.
  const editingTrackId = useVisualizerStudioStore(state => state.inlineSettings ? null : state.track?.id ?? null);
  const inlineSettings = useVisualizerStudioStore(state => state.inlineSettings);
  // One floating media window: a floating video (a network preview plays over the song) has it.
  const videoFloats = useVideoPip(videoPipFloats);
  const shown = open && canVisualizeTrack(track) && track.id !== editingTrackId && !videoFloats;
  useEffect(() => {
    if (!inlineSettings) return;
    const editor = useVisualizerStudioStore.getState();
    if (open && canVisualizeTrack(track)) editor.follow(track);
    else editor.close();
  }, [track, inlineSettings, open]);
  return shown ? <div className="kd-viz-popup-host">
    <Suspense fallback={null}>
      <VisualizerStudioPanel key={track.id} inlineTrack={track} showDetails={false} popup
        onClose={() => {
          const editor = useVisualizerStudioStore.getState();
          if (editor.inlineSettings && editor.track?.id === track.id) editor.close();
        }} />
    </Suspense>
  </div> : null;
}
