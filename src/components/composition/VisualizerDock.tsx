import { lazy, Suspense, useCallback, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { AsideHead } from "../chrome/AsideHead";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import "./VisualizerDock.css";

const VisualizerStudioPanel = lazy(() => import("./VisualizerStudioPanel"));

/**
 * The visualizer configuration as one app of the right column: the song it belongs to, the way
 * out, and either the whole editor or, while the floating picture is the editor, its controls.
 */
export function VisualizerDock() {
  const openTrack = useVisualizerStudioStore(state => state.track);
  const openInline = useVisualizerStudioStore(state => state.inlineSettings);
  const requestClose = useVisualizerStudioStore(state => state.requestClose);
  // The column keeps a closed app on screen while it leaves; keep showing what it showed.
  const shown = useRef({ track: openTrack, inlineSettings: openInline });
  if (openTrack) shown.current = { track: openTrack, inlineSettings: openInline };
  const host = useRef<HTMLDivElement | null>(null);
  const setHost = useCallback((node: HTMLDivElement | null) => {
    const editor = useVisualizerStudioStore.getState();
    // A host on its way out must not take the target away from the one that replaced it.
    if (node) editor.setSettingsTarget(node);
    else if (editor.settingsTarget === host.current) editor.setSettingsTarget(null);
    host.current = node;
  }, []);
  // The floating picture withdraws its controls the moment the app closes. Leave their last
  // appearance behind for the way out; this runs before React removes them.
  const ghost = useRef<HTMLDivElement | null>(null);
  useEffect(() => useVisualizerStudioStore.subscribe((state, previous) => {
    const live = host.current, still = ghost.current;
    if (!still) return;
    if (state.track) { still.replaceChildren(); return; }
    if (!previous.track || !previous.inlineSettings || !live) return;
    still.replaceChildren(...[...live.childNodes].map(node => node.cloneNode(true)));
    const scrolled = live.querySelector(".kd-viz-settings"), copy = still.querySelector(".kd-viz-settings");
    if (scrolled && copy) copy.scrollTop = scrolled.scrollTop;
  }), []);
  const { track, inlineSettings } = shown.current;
  if (!track) return null;
  const name = track.title || track.filename;
  return <div className="kd-viz-dock">
    <AsideHead title="可视化配置" tools={<>
      <span className="kd-viz-dock-song" title={track.artist ? `${name} · ${track.artist}` : name}>{name}</span>
      <button type="button" className="kd-aside-head-close" aria-label="关闭可视化配置" title="关闭可视化配置" onClick={requestClose}><X size={15} /></button>
    </>} />
    <div className="kd-viz-dock-body">
      {inlineSettings ? <>
        <div className="kd-viz-panel kd-viz-settings-host" ref={setHost} />
        <div className="kd-viz-panel kd-viz-settings-host" ref={ghost} aria-hidden="true" inert />
      </> : <Suspense fallback={null}><VisualizerStudioPanel track={track} onClose={requestClose} /></Suspense>}
    </div>
  </div>;
}
