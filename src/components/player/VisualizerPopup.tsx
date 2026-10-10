import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useVideoPip, videoPipFloats } from "../../lib/videoPip";
import { canVisualizeTrack, useVisualizerPopup } from "../../lib/visualizerPopup";
import { popupPictureAfter, popupSettingsStay, type PopupPicture } from "../../lib/visualizerPopupPicture";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";

const VisualizerStudioPanel = lazy(() => import("../composition/VisualizerStudioPanel"));

/**
 * Mounts the playing song's visualizer as a floating window; nothing of it sits in the page.
 * Mounted is not on screen: the window comes up with the song's first picture, so a song that
 * has none (no cover, no picture saved with its project) passes without one and the window is
 * back with the next song that has.
 */
export function VisualizerPopup() {
  const open = useVisualizerPopup(state => state.open);
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  // A draft must have only one editor; the studio owns it while explicitly open.
  const editingTrackId = useVisualizerStudioStore(state => state.inlineSettings ? null : state.track?.id ?? null);
  const inlineSettings = useVisualizerStudioStore(state => state.inlineSettings);
  // One floating media window: a floating video (a network preview plays over the song) has it.
  const videoFloats = useVideoPip(videoPipFloats);
  const shown = open && canVisualizeTrack(track) && track.id !== editingTrackId && !videoFloats;
  // What the mounted picture has reported about the song it was mounted for; a picture that is
  // taken down has reported nothing.
  const [picture, setPicture] = useState<PopupPicture | null>(null);
  const trackId = track?.id ?? null;
  const report = useCallback((content: PopupPicture["content"]) => {
    if (trackId !== null) setPicture(before => popupPictureAfter(before, trackId, content));
  }, [trackId]);
  useEffect(() => { if (!shown) setPicture(null); }, [shown]);
  // The controls in the drawer are the window's own. A song that brings no window takes them
  // away, as a song that cannot be visualized does; they are not left open over nothing.
  const settingsStay = open && canVisualizeTrack(track) && popupSettingsStay(picture, track.id);
  useEffect(() => {
    if (!inlineSettings) return;
    const editor = useVisualizerStudioStore.getState();
    if (settingsStay && track) editor.follow(track);
    else editor.close();
  }, [track, inlineSettings, settingsStay]);
  return shown ? <div className="kd-viz-popup-host">
    <Suspense fallback={null}>
      <VisualizerStudioPanel key={track.id} inlineTrack={track} showDetails={false} popup
        onContentStateChange={report}
        onClose={() => {
          const editor = useVisualizerStudioStore.getState();
          if (editor.inlineSettings && editor.track?.id === track.id) editor.close();
        }} />
    </Suspense>
  </div> : null;
}
