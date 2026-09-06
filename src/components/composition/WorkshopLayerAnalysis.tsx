import { useState } from "react";
import { ChevronDown, LocateFixed, Square } from "lucide-react";
import { useWorkshopStore } from "../../stores/workshopStore";
import { WorkshopPositionChoices } from "./WorkshopPositionChoices";

export function WorkshopAnalysisControl({ projectId, layerId, sourceTitle, restart = false }: {
  projectId: string; layerId?: string; sourceTitle?: string; restart?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const label = restart ? `重新分析 ${sourceTitle}` : layerId ? `停止 ${sourceTitle} 的自动分析` : "停止全部素材的自动分析";
  return <button type="button" disabled={pending} aria-label={label} title={label} onClick={e => {
    e.stopPropagation();
    setPending(true);
    void useWorkshopStore.getState().controlPositions(projectId, !restart, layerId).finally(() => setPending(false));
  }}>
    {restart ? "重新分析" : <><Square size={11} />{!layerId && "全部停止"}</>}
  </button>;
}

export function WorkshopLayerAnalysis({ projectId, layerId, sourceTitle }: {
  projectId: string; layerId: string; sourceTitle: string;
}) {
  const analysis = useWorkshopStore(s => s.positions[projectId]?.items.find(a => a.layer_id === layerId));
  const saving = useWorkshopStore(s => s.saving > 0);
  if (!analysis) return null;
  const applied = analysis.presets.find(p => p.id === analysis.applied);
  return <div className="vj-layer-analysis">
    {(analysis.phase === "analyzing" || analysis.phase === "waiting") && <div className="vj-analysis-progress">
      {analysis.phase === "analyzing" && <span className="vj-position-status" role="status" title={analysis.reference_title}>
        分析位置 <progress aria-label={`${sourceTitle} 位置分析进度`} max={1} value={analysis.progress} />
      </span>}
      {analysis.phase === "waiting" && <span className="vj-position-status" role="status">{analysis.reason}</span>}
      <WorkshopAnalysisControl projectId={projectId} layerId={layerId} sourceTitle={sourceTitle} />
    </div>}
    {analysis.presets.length > 0 && <details className="vj-layer-positions">
      <summary title={applied?.label || analysis.reference_title}>
        <LocateFixed size={12} /><span>{applied ? applied.label : "片段定位"}</span><ChevronDown size={12} />
      </summary>
      <div className="vj-position-presets">
        <WorkshopPositionChoices analysis={analysis} sourceTitle={sourceTitle} saving={saving}
          onApply={id => void useWorkshopStore.getState().applyPositions(layerId, analysis.id, id)} />
      </div>
    </details>}
    {analysis.reason && analysis.phase !== "waiting" && <span className="vj-position-status" title={analysis.reason}>{analysis.reason}</span>}
    {analysis.phase === "stopped" && <WorkshopAnalysisControl projectId={projectId} layerId={layerId} sourceTitle={sourceTitle} restart />}
    {analysis.phase === "failed" && <button type="button" onClick={() => void useWorkshopStore.getState().refreshPositions()}>重试</button>}
  </div>;
}
