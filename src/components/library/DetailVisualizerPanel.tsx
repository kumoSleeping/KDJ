import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { Track } from "../../types";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import { Panel } from "../common";
import { AsyncPanelBody, type PanelContentState } from "../common/AsyncPanelBody";

const VisualizerStudioPanel = lazy(() => import("../composition/VisualizerStudioPanel"));

export function DetailVisualizerPanel({ track }: { track: Track }) {
  const [content, setContent] = useState<{ trackId: number; state: PanelContentState } | null>(null);
  const onState = useCallback((state: PanelContentState) => setContent({ trackId: track.id, state }), [track.id]);
  return <Panel heading="视窗" floatingHeader className="kd-detail-viz-panel" dense padded={false}>
    <AsyncPanelBody kind="visualizer" state={content?.trackId === track.id ? content.state : "loading"}>
      <VisualizerBody key={track.id} track={track} onState={onState} />
    </AsyncPanelBody>
  </Panel>;
}

function VisualizerBody({ track, onState }: { track: Track; onState(state: PanelContentState): void }) {
  const [admitted, setAdmitted] = useState(false);
  useEffect(() => {
    // Paint the ordinary panel before importing/mounting the canvas editor.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setAdmitted(true));
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, []);
  return admitted ? <Suspense fallback={null}><VisualizerStudioPanel inlineTrack={track} showDetails={false}
      onContentStateChange={onState}
      onClose={() => {
        const editor = useVisualizerStudioStore.getState();
        if (editor.inlineSettings && editor.track?.id === track.id) editor.close();
      }} /></Suspense> : null;
}
