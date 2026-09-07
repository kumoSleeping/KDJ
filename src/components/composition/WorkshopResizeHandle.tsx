import { useRef, useState } from "react";
type Part = "preview" | "timeline";
const selectors: Record<Part, string> = {preview:".vj-main", timeline:".vj-timeline"};
const minimum: Record<Part, number> = {preview:60, timeline:100};
export function WorkshopResizeHandle({ before, after }: { before: Part; after: Part }) {
  const drag = useRef<{root:HTMLElement; y:number; heights:Record<Part,number>; previous:string[]} | null>(null);
  const [value, setValue] = useState(50), [dragging, setDragging] = useState(false);
  const read = (node: HTMLElement) => {
    const root = node.closest<HTMLElement>('[aria-label="工作站"]')!;
    const heights = Object.fromEntries(Object.entries(selectors).map(([part, selector]) => [part, root.querySelector(selector)!.getBoundingClientRect().height])) as Record<Part,number>;
    return {root, heights};
  };
  const apply = (root: HTMLElement, heights:Record<Part,number>, delta:number) => {
    const sum = heights[before] + heights[after];
    const first = Math.max(minimum[before], Math.min(sum-minimum[after], heights[before]+delta));
    const next = {...heights, [before]:first, [after]:Math.max(minimum[after],sum-first)};
    for (const part of Object.keys(selectors) as Part[]) root.style.setProperty(`--vj-${part}-weight`, String(Math.max(1,next[part])));
    setValue(Math.round(first / Math.max(1,sum) * 100));
  };
  return <div role="separator" tabIndex={0} aria-orientation="horizontal" aria-label={before === "preview" ? "调整预览和轨道高度" : "调整轨道和素材区高度"} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} className="vj-height-handle" title="拖动调整区域高度 · 双击还原" data-dragging={dragging || undefined}
    onPointerDown={e => { if(e.button !== 0) return; e.preventDefault(); const {root,heights}=read(e.currentTarget); drag.current={root,heights,y:e.clientY,previous:Object.keys(selectors).map(k=>root.style.getPropertyValue(`--vj-${k}-weight`))}; setDragging(true); e.currentTarget.focus({preventScroll:true}); e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerMove={e => {const d=drag.current; if(d) apply(d.root,d.heights,e.clientY-d.y);}}
    onPointerUp={() => {drag.current=null; setDragging(false);}}
    onPointerCancel={() => {const d=drag.current; if(d) Object.keys(selectors).forEach((k,i)=> d.root.style.setProperty(`--vj-${k}-weight`,d.previous[i])); drag.current=null; setDragging(false);}}
    onLostPointerCapture={() => {drag.current=null; setDragging(false);}}
    onKeyDown={e => {if(e.key !== "ArrowUp" && e.key !== "ArrowDown") return; e.preventDefault(); e.stopPropagation(); const {root,heights}=read(e.currentTarget); apply(root,heights,(e.key === "ArrowUp" ? -1 : 1)*(e.shiftKey ? 40 : 10));}}
    onDoubleClick={e => {const {root}=read(e.currentTarget); Object.keys(selectors).forEach(k=>root.style.removeProperty(`--vj-${k}-weight`)); setValue(50);}}><i /></div>;
}
