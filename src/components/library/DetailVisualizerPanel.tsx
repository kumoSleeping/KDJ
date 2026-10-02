import { lazy, Suspense } from "react";
import type { Track } from "../../types";
import { useVisualizerStudioStore } from "../../stores/visualizerStudioStore";
import { Panel } from "../common";

const VisualizerStudioPanel = lazy(() => import("../composition/VisualizerStudioPanel"));

export function DetailVisualizerPanel({ track }: { track: Track }) {
  return <Panel heading="视窗" className="kd-detail-viz-panel" dense padded={false}>
    <Suspense fallback={null}><VisualizerStudioPanel inlineTrack={track} showDetails={false}
      onClose={() => {
        const editor = useVisualizerStudioStore.getState();
        if (editor.inlineSettings && editor.track?.id === track.id) editor.close();
      }} /></Suspense>
  </Panel>;
}
