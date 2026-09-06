import { useLayoutEffect, useRef, useState } from "react";
import type { CompositionProject } from "../../types/workshop";
import { clipDuration, projectDuration } from "../../lib/workshop";
import { scrollFromThumb, thumbPosition } from "../../lib/scrollThumb";

/** Global seeking below a separate, small viewport scroll handle. */
export function WorkshopTimelineOverview({ project, viewport, content, offset, controls, position, onScroll, onSeek, onSeekStart, onSeekEnd }: {
  project: CompositionProject; viewport: number; content: number; offset: number;
  controls: string; position: number; onScroll(offset: number): void;
  onSeek(ms:number): void; onSeekStart(): void; onSeekEnd(): void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(viewport), [dragging, setDragging] = useState(false);
  const drag = useRef<{pointer:number; x:number; initial:number; extent:number; travel:number} | null>(null);
  const seeking = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = rail.current;
    if (!node) return;
    const measure = () => setMeasured(node.clientWidth || viewport);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [viewport]);
  const width = measured || viewport, extent = Math.max(0, content-viewport);
  const length = Math.min(width, Math.max(28, width*viewport/Math.max(1,content)));
  const travel = Math.max(0,width-length), left = thumbPosition(offset,extent,travel);
  const duration = Math.max(1,projectDuration(project));
  const seekAt = (node:HTMLElement, clientX:number) => {
    const rect=node.getBoundingClientRect(), span=rect.width || width;
    const ms=Math.max(0,Math.min(1,(clientX-rect.left)/Math.max(1,span)))*duration;
    const frame=1000/Math.max(1,project.canvas.fps);
    onSeek(Math.min(duration,Math.round(ms/frame)*frame));
  };
  const finishSeek = () => {if(seeking.current !== null) {seeking.current=null; onSeekEnd();}};
  return <div className="vj-timeline-overview">
    {extent > 1 && <div className="vj-overview-viewport" role="scrollbar" tabIndex={0}
      aria-label="时间轴全局位置" aria-orientation="horizontal" aria-controls={controls}
      aria-valuemin={0} aria-valuemax={Math.round(extent)} aria-valuenow={Math.round(Math.max(0,Math.min(extent,offset)))}
      data-dragging={dragging || undefined}
      onPointerDown={e => {
        if(e.button !== 0) return; e.preventDefault(); e.stopPropagation();
        const x=e.clientX-e.currentTarget.getBoundingClientRect().left;
        const initial = x >= left && x <= left+length ? left : Math.max(0,Math.min(travel,x-length/2));
        onScroll(scrollFromThumb(initial,extent,travel));
        drag.current={pointer:e.pointerId,x:e.clientX,initial,extent,travel}; setDragging(true);
        e.currentTarget.focus({preventScroll:true}); e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {const d=drag.current; if(d && d.pointer === e.pointerId) {e.preventDefault(); onScroll(scrollFromThumb(d.initial+e.clientX-d.x,d.extent,d.travel));}}}
      onPointerUp={e => {if(drag.current?.pointer === e.pointerId) {drag.current=null; setDragging(false);}}}
      onPointerCancel={() => {drag.current=null; setDragging(false);}}
      onLostPointerCapture={() => {drag.current=null; setDragging(false);}}
      onKeyDown={e => {
        const next = e.key === "Home" ? 0 : e.key === "End" ? extent
          : e.key === "ArrowLeft" ? offset-viewport*.1 : e.key === "ArrowRight" ? offset+viewport*.1
          : e.key === "PageUp" ? offset-viewport*.9 : e.key === "PageDown" ? offset+viewport*.9 : null;
        if(next === null) return; e.preventDefault(); e.stopPropagation(); onScroll(Math.max(0,Math.min(extent,next)));
      }}>
      <div className="vj-overview-thumb" style={{left,width:length}} aria-hidden="true"><i /></div>
    </div>}
    <div ref={rail} className="vj-overview-rail" role="slider" tabIndex={0} aria-label="全局预览位置"
      aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(position)}
      onPointerDown={e => {if(e.button !== 0) return; e.preventDefault(); e.stopPropagation(); seeking.current=e.pointerId; onSeekStart(); e.currentTarget.focus({preventScroll:true}); e.currentTarget.setPointerCapture(e.pointerId); seekAt(e.currentTarget,e.clientX);}}
      onPointerMove={e => {if(seeking.current !== null && seeking.current === e.pointerId) {e.preventDefault(); seekAt(e.currentTarget,e.clientX);}}}
      onPointerUp={e => {if(seeking.current !== null && seeking.current === e.pointerId) {seekAt(e.currentTarget,e.clientX); finishSeek();}}}
      onPointerCancel={finishSeek} onLostPointerCapture={finishSeek}
      onKeyDown={e => {
        const step=1000/Math.max(1,project.canvas.fps)*(e.shiftKey ? 10 : 1);
        const next=e.key === "Home" ? 0 : e.key === "End" ? duration : e.key === "ArrowLeft" ? position-step : e.key === "ArrowRight" ? position+step : null;
        if(next === null) return; e.preventDefault(); e.stopPropagation(); onSeek(Math.max(0,Math.min(duration,next)));
      }}>
      <div className="vj-overview-content" aria-hidden="true">{project.layers.map(layer => <div key={layer.id}>{layer.clips.map(c =>
        <i key={c.id} style={{left:`${c.start_ms/duration*100}%`,width:`${clipDuration(c)/duration*100}%`}} />
      )}</div>)}</div>
      <i className="vj-overview-playhead" style={{left:`${Math.max(0,Math.min(1,position/duration))*100}%`}} aria-hidden="true" />
    </div>
  </div>;
}
