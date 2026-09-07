import { useRef, useState } from "react";
import { Blend, X } from "lucide-react";
import { ContextMenu } from "../common/ContextMenu";
import { useWorkshopStore } from "../../stores/workshopStore";
import { clipQuantum, smooth } from "../../lib/workshop";
import { setVideoTransition, videoTransitionSpan } from "../../lib/workshopTransitions";
import type { CompositionProject, VideoTransition, WorkshopClip } from "../../types/workshop";

export function WorkshopVideoTransition({project, left, right, scale}: {
  project: CompositionProject; left: WorkshopClip; right: WorkshopClip; scale: number;
}) {
  const [menu, setMenu] = useState<{x:number; y:number} | null>(null);
  const drag = useRef<{project:CompositionProject; x:number; duration:number; alignment:VideoTransition["alignment"]; factor:number} | null>(null);
  const config = right.video_transition, span = videoTransitionSpan(left, right);
  const duration = span ? span.before + span.after : 0;
  const alignment = config?.alignment ?? 0;
  const quantum = clipQuantum(project, right);
  const change = (value:VideoTransition | null) => useWorkshopStore.getState().edit(p => setVideoTransition(p, right.id, value));
  const curves = [false, true].map(incoming => Array.from({length:25}, (_,i) => {
    const weight = smooth(i/24);
    // Show alpha, just like the individual picture fade curves, not the
    // resulting mix weights. Source-over keeps the outgoing plane opaque;
    // incoming alpha alone reveals it. Two half-alpha planes would leak black.
    // Same coordinates as workshopFadeCurvePath: opaque=4, transparent=27.
    return `${i ? "L" : "M"}${i/24*100},${27-(incoming ? weight : 1)*23}`;
  }).join(" "));
  const at = right.start_ms * scale;
  const resizeAt = span ? (alignment === -1 ? at-span.before*scale : at+span.after*scale) : at;
  return <>
    {span && <svg className="vj-transition-curves" aria-label="画面过渡透明度曲线" viewBox="0 0 100 30" preserveAspectRatio="none"
      style={{left:at-span.before*scale, width:Math.max(1,duration*scale)}}>
      {curves.map((d,i) => <path key={i} d={d} aria-label={i ? "后段透明度" : "前段透明度"} vectorEffect="non-scaling-stroke" />)}
    </svg>}
    <button type="button" className="vj-transition-trigger" style={{left:at}} aria-label="画面过渡" aria-haspopup="menu" aria-expanded={Boolean(menu)}
      aria-pressed={Boolean(span)} title={`画面过渡${duration ? ` · ${(duration/1000).toFixed(2)} s` : ""}`}
      onPointerDown={e => e.stopPropagation()} onClick={e => {
        e.stopPropagation(); const r=e.currentTarget.getBoundingClientRect(); setMenu(menu ? null : {x:r.left, y:r.bottom});
      }} onContextMenu={e => {e.preventDefault(); e.stopPropagation(); setMenu({x:e.clientX,y:e.clientY});}}><Blend size={12}/></button>
    {config && <button type="button" className="vj-transition-resize" style={{left:resizeAt}} role="slider" aria-label="联合调整画面过渡时长"
      aria-valuemin={0} aria-valuemax={10000} aria-valuenow={duration} aria-valuetext={`${(duration/1000).toFixed(2)} 秒`}
      onPointerDown={e => {
        if(e.button !== 0) return; e.preventDefault(); e.stopPropagation();
        const state=useWorkshopStore.getState(); state.begin();
        drag.current={project:state.draft!,x:e.clientX,duration,alignment,factor:alignment === 0 ? 2 : alignment === -1 ? -1 : 1};
        e.currentTarget.setPointerCapture(e.pointerId);
      }} onPointerMove={e => {
        const d=drag.current; if(!d)return; e.stopPropagation();
        const ms=Math.max(0,Math.round((d.duration+(e.clientX-d.x)/scale*d.factor)/quantum)*quantum);
        useWorkshopStore.getState().transient(setVideoTransition(d.project,right.id,{duration_ms:ms,alignment:d.alignment}));
      }} onPointerUp={e => {e.stopPropagation();if(drag.current){drag.current=null;useWorkshopStore.getState().commit();}}}
      onPointerCancel={e => {e.stopPropagation();drag.current=null;useWorkshopStore.getState().abort();}}
      onKeyDown={e => {
        if(!["ArrowLeft","ArrowRight","Home"].includes(e.key))return;
        e.preventDefault();e.stopPropagation(); change({duration_ms:e.key === "Home" ? 0 : duration+(e.key === "ArrowRight" ? quantum : -quantum),alignment});
      }} />}
    {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} className="vj-transition-popup">
      <div className="vj-transition-settings" role="group" aria-label="画面过渡设置" onPointerDown={e => e.stopPropagation()}>
        <div className="vj-transition-heading"><span>画面过渡</span><button type="button" aria-label="移除画面过渡" disabled={!config} onClick={() => {change(null);setMenu(null);}}><X size={12}/></button></div>
        {!duration && <button type="button" onClick={() => change({duration_ms:500,alignment})}>交叉淡化</button>}
        <label>时长 <input aria-label="画面过渡时长（秒）" type="number" min={0} max={10} step={.05} value={Number((duration/1000).toFixed(3))}
          onChange={e => {const n=e.currentTarget.valueAsNumber;if(Number.isFinite(n))change({duration_ms:n*1000,alignment});}}/> s</label>
        <div className="vj-transition-align" role="group" aria-label="过渡对齐">
          {([-1,0,1] as const).map((value,i) => <button type="button" key={value} aria-pressed={alignment===value}
            onClick={() => change({duration_ms:duration || 500,alignment:value})}>{["靠前","居中","靠后"][i]}</button>)}
        </div>
        {config && config.duration_ms > 0 && !span && <span role="status">素材余量不足</span>}
      </div>
    </ContextMenu>}
  </>;
}
