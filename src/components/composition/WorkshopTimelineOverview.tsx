import { useLayoutEffect, useRef, useState } from "react";
import { scrollFromThumb, thumbPosition } from "../../lib/scrollThumb";

/** Horizontal viewport scrollbar, kept below the scrolling track list. */
export function WorkshopTimelineOverview({ viewport, content, offset, controls, onScroll }: {
  viewport: number; content: number; offset: number;
  controls: string; onScroll(offset: number): void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(viewport), [dragging, setDragging] = useState(false);
  const drag = useRef<{pointer:number; x:number; initial:number; extent:number; travel:number} | null>(null);
  const scrollable = content - viewport > 1;
  useLayoutEffect(() => {
    const node = rail.current;
    if (!node) return;
    const measure = () => setMeasured(node.clientWidth || viewport);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [viewport, scrollable]);
  const width = measured || viewport, extent = Math.max(0, content-viewport);
  const length = Math.min(width, Math.max(28, width*viewport/Math.max(1,content)));
  const travel = Math.max(0,width-length), left = thumbPosition(offset,extent,travel);
  return <div className="vj-timeline-overview" hidden={!scrollable}>
    {scrollable && <div ref={rail} className="vj-overview-viewport" role="scrollbar" tabIndex={0}
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
  </div>;
}
