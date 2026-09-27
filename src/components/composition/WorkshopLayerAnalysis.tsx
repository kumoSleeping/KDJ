import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, LocateFixed, Square } from "lucide-react";
import { useWorkshopStore } from "../../stores/workshopStore";
import { WorkshopPositionChoices } from "./WorkshopPositionChoices";
import { ContextMenu } from "../common/ContextMenu";

export function WorkshopAnalysisControl({ projectId, layerId, sourceTitle, restart = false }: {
  projectId: string; layerId?: string; sourceTitle?: string; restart?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const label = restart ? `重新分析 ${sourceTitle}` : layerId ? `停止 ${sourceTitle} 的位置分析` : "停止全部位置分析";
  return <button type="button" disabled={pending} aria-label={label} title={label} onClick={e => {
    e.stopPropagation();
    setPending(true);
    const state = useWorkshopStore.getState();
    const action = restart ? state.analyzePositions(layerId, true) : state.controlPositions(projectId, true, layerId);
    void action.finally(() => setPending(false));
  }}>
    {restart ? "重新分析" : <><Square size={11} />{!layerId && "全部停止"}</>}
  </button>;
}

/**
 * The locate control is the only way position matching starts: nothing is
 * analyzed on import or edit. First press matches the row, later presses open
 * the result it already holds.
 */
export function WorkshopLayerAnalysis({ projectId, layerId, sourceTitle }: {
  projectId: string; layerId: string; sourceTitle: string;
}) {
  const analysis = useWorkshopStore(s => s.positions[projectId]?.items.find(a => a.layer_id === layerId));
  const saving = useWorkshopStore(s => s.saving > 0);
  const [menu, setMenu] = useState<{x:number; y:number} | null>(null);
  useEffect(() => setMenu(null), [projectId, layerId, analysis?.id]);
  const phase = analysis?.phase;
  const busy = phase === "analyzing";
  const waiting = phase === "waiting";
  const hasPositions = Boolean(analysis?.presets.length);
  const applied = analysis?.presets.find(p => p.id === analysis.applied);
  // A stopped row keeps nothing worth showing; the next press matches it again.
  const stopped = phase === "stopped";
  const analyzed = Boolean(analysis) && !stopped;
  const status = analysis?.reason || (busy ? "分析位置" : applied?.label || (hasPositions ? "片段定位" : phase === "failed" ? "分析失败" : ""));
  return <div className="vj-layer-analysis">
    <button type="button" className="vj-layer-position-trigger" aria-haspopup={analyzed ? "menu" : undefined}
      aria-expanded={analyzed ? Boolean(menu) : undefined}
      aria-label={`${analyzed ? (hasPositions ? "片段定位" : "位置分析") : "手动分析位置"}：${sourceTitle}`}
      data-active={Boolean(applied) || undefined} data-busy={busy || undefined}
      title={analyzed
        ? `${status}${analysis?.reference_title ? ` · ${analysis.reference_title}` : ""}`
        : `手动分析位置：${sourceTitle}`}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation();
        if (!analyzed) {
          void useWorkshopStore.getState().analyzePositions(layerId, stopped);
          return;
        }
        const r = e.currentTarget.getBoundingClientRect();
        setMenu(menu ? null : {x:r.left, y:r.bottom + 4});
      }}>
      {busy ? <LoaderCircle size={13} className="kd-spin" /> : phase === "failed" ? <CircleAlert size={13} /> : <LocateFixed size={13} />}
    </button>
    {menu && analysis && <ContextMenu {...menu} onClose={() => setMenu(null)} keepOpen=".vj-layer-position-trigger" className="vj-position-popup">
    {busy || waiting ? <div className="vj-analysis-progress">
      {busy && <span className="vj-position-status" role="status" title={analysis.reference_title}>
        分析位置 <progress aria-label={`${sourceTitle} 位置分析进度`} max={1} value={analysis.progress} />
      </span>}
      {waiting && <span className="vj-position-status" role="status">{analysis.reason}</span>}
      <WorkshopAnalysisControl projectId={projectId} layerId={layerId} sourceTitle={sourceTitle} />
    </div> : <WorkshopAnalysisControl projectId={projectId} layerId={layerId} sourceTitle={sourceTitle} restart />}
    <WorkshopPositionChoices analysis={analysis} sourceTitle={sourceTitle} saving={saving}
      onApply={id => { setMenu(null); void useWorkshopStore.getState().applyPositions(layerId, analysis.id, id); }} />
    {analysis.reason && !waiting && <span className="vj-position-status" title={analysis.reason}>{analysis.reason}</span>}
    </ContextMenu>}
  </div>;
}
