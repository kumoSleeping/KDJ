import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, LocateFixed, RotateCcw, Square } from "lucide-react";
import { useWorkshopStore } from "../../stores/workshopStore";
import { WorkshopPositionChoices } from "./WorkshopPositionChoices";
import { ContextMenu } from "../common/ContextMenu";

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
  const [menu, setMenu] = useState<{x:number; y:number} | null>(null);
  useEffect(() => setMenu(null), [projectId, layerId, analysis?.id]);
  if (!analysis) return null;
  const hasPositions = analysis.presets.length > 0;
  const busy = analysis.phase === "analyzing";
  if (!hasPositions && !busy && analysis.phase !== "failed" && analysis.phase !== "stopped") return null;
  const applied = analysis.presets.find(p => p.id === analysis.applied);
  const status = analysis.reason || (busy ? "分析位置" : applied?.label || (hasPositions ? "片段定位" : analysis.phase === "failed" ? "分析失败" : "已停止"));
  return <div className="vj-layer-analysis">
    <button type="button" className="vj-layer-position-trigger" aria-haspopup="menu" aria-expanded={Boolean(menu)}
      aria-label={`${hasPositions ? "片段定位" : "位置分析"}：${sourceTitle}`} data-active={Boolean(applied) || undefined} data-busy={busy || undefined}
      title={`${status}${analysis.reference_title ? ` · ${analysis.reference_title}` : ""}`}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        setMenu(menu ? null : {x:r.left, y:r.bottom + 4});
      }}>
      {hasPositions ? <LocateFixed size={13} /> : busy ? <LoaderCircle size={13} /> : analysis.phase === "failed" ? <CircleAlert size={13} /> : <RotateCcw size={13} />}
    </button>
    {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} className="vj-position-popup">
    {(analysis.phase === "analyzing" || analysis.phase === "waiting") && <div className="vj-analysis-progress">
      {analysis.phase === "analyzing" && <span className="vj-position-status" role="status" title={analysis.reference_title}>
        分析位置 <progress aria-label={`${sourceTitle} 位置分析进度`} max={1} value={analysis.progress} />
      </span>}
      {analysis.phase === "waiting" && <span className="vj-position-status" role="status">{analysis.reason}</span>}
      <WorkshopAnalysisControl projectId={projectId} layerId={layerId} sourceTitle={sourceTitle} />
    </div>}
    <WorkshopPositionChoices analysis={analysis} sourceTitle={sourceTitle} saving={saving}
      onApply={id => { setMenu(null); void useWorkshopStore.getState().applyPositions(layerId, analysis.id, id); }} />
    {analysis.reason && analysis.phase !== "waiting" && <span className="vj-position-status" title={analysis.reason}>{analysis.reason}</span>}
    {analysis.phase === "stopped" && <WorkshopAnalysisControl projectId={projectId} layerId={layerId} sourceTitle={sourceTitle} restart />}
    {analysis.phase === "failed" && <button type="button" onClick={() => void useWorkshopStore.getState().refreshPositions()}>重试</button>}
    </ContextMenu>}
  </div>;
}
