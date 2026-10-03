import { lazy, Suspense, useEffect, useState } from "react";
import type { Track } from "../../types";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import { Panel } from "../common";
import { AsyncPanelBody, type PanelContentState } from "../common/AsyncPanelBody";

const VisualizerStudioPanel = lazy(() => import("../composition/VisualizerStudioPanel"));

export function DetailVisualizerPanel({ track }: { track: Track }) {
  return <Panel heading="视窗" className="kd-detail-viz-panel" dense padded={false}>
    <VisualizerBody key={track.id} track={track} />
  </Panel>;
}

function VisualizerBody({ track }: { track: Track }) {
  const [state, setState] = useState<PanelContentState>("loading");
  const [admitted, setAdmitted] = useState(false);
  useEffect(() => {
    // Paint the ordinary panel before importing/mounting the canvas editor.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setAdmitted(true));
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, []);
  return <AsyncPanelBody kind="visualizer" state={state}>
    {admitted && <Suspense fallback={null}><VisualizerStudioPanel inlineTrack={track} showDetails={false}
      onContentStateChange={setState}
      onClose={() => {
        const editor = useVisualizerStudioStore.getState();
        if (editor.inlineSettings && editor.track?.id === track.id) editor.close();
      }} /></Suspense>}
  </AsyncPanelBody>;
}
