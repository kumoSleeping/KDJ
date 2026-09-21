import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { clampVideoFloatBox, type VideoFloatBox } from "../../lib/videoFloatBox";

const edges = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Edge = typeof edges[number];
const edgeLabels: Record<Edge, string> = { n: "上边", s: "下边", e: "右边", w: "左边", ne: "右上角", nw: "左上角", se: "右下角", sw: "左下角" };

/** Floating geometry only; the caller owns rendering, transport and picture editing. */
export function FloatingPreviewFrame({ floating, fullscreen, editing, ratio, children, onEscape }: {
  floating: boolean; fullscreen: boolean; editing: boolean; ratio: number;
  children: ReactNode; onEscape(): void;
}) {
  const fit = (box: VideoFloatBox) => clampVideoFloatBox(box, window.innerWidth, window.innerHeight, ratio);
  const [box, setBox] = useState(() => fit({ x: window.innerWidth - 524, y: 60, w: 512 }));
  const drag = useRef<{ x: number; y: number; box: VideoFloatBox; edge?: Edge } | null>(null);
  useEffect(() => {
    const resize = () => setBox(current => fit(current));
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [ratio]);
  const down = (e: PointerEvent<HTMLElement>, edge?: Edge) => {
    if (!floating || fullscreen || e.button !== 0 || !e.isPrimary) return;
    if (!edge && (e.target as HTMLElement).closest("button, [role=button], [role=slider]")) return;
    if (!edge && editing && (e.target as HTMLElement).closest("canvas")) return;
    e.preventDefault(); e.stopPropagation();
    drag.current = { x: e.clientX, y: e.clientY, box, edge };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!start.edge) { setBox(fit({ ...start.box, x: start.box.x + dx, y: start.box.y + dy })); return; }
    const horizontal = start.edge.includes("e") ? dx : start.edge.includes("w") ? -dx : 0;
    const vertical = (start.edge.includes("s") ? dy : start.edge.includes("n") ? -dy : 0) * ratio;
    const delta = Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
    const w = fit({ ...start.box, w: start.box.w + delta }).w;
    setBox(fit({ w, x: start.box.x + (start.edge.includes("w") ? start.box.w - w : 0),
      y: start.box.y + (start.edge.includes("n") ? (start.box.w - w) / ratio : 0) }));
  };
  const end = (e: PointerEvent<HTMLElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const detached = floating || fullscreen;
  const preview = <div className={`kd-pip-float ${detached ? "kd-viz-floating-preview" : "kd-viz-preview"}`}
    role={detached ? "dialog" : undefined} aria-label={fullscreen ? "可视化全屏预览" : floating ? "可视化预览小窗" : undefined}
    data-fullscreen={fullscreen || undefined}
    data-picture-editing={editing || undefined}
    style={floating ? { left: box.x, top: box.y, width: box.w } : undefined}
    onPointerDown={down} onPointerMove={move} onPointerUp={end} onLostPointerCapture={() => { drag.current = null; }}
    onPointerCancel={e => { if (drag.current) setBox(drag.current.box); end(e); }}
    onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onEscape(); } }}>
    <div className="kd-pip-float-stage" style={{ aspectRatio: fullscreen ? "auto" : String(ratio) }}>
      {children}
      {floating && !fullscreen && edges.map(edge => <span key={edge} className="kd-pip-resize" data-edge={edge}
        role="button" tabIndex={edge === "se" ? 0 : -1} aria-label={`调整可视化小窗大小：${edgeLabels[edge]}`} title="拖动缩放 · 方向键微调"
        onPointerDown={e => down(e, edge)}
        onKeyDown={e => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
          e.preventDefault(); e.stopPropagation();
          setBox(current => fit({ ...current, w: current.w + (["ArrowRight", "ArrowUp"].includes(e.key) ? 24 : -24) }));
        }} />)}
    </div>
  </div>;
  return detached ? createPortal(preview, document.body) : preview;
}
