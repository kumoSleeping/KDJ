import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { readLocalStorage, writeLocalStorageNow } from "../../lib/storageWrite";
import { DRAG_THRESHOLD_PX } from "../../lib/pointerSession";
import "./FloatingPanelWindow.css";

type WindowBounds = { left: number; top: number; width: number; height: number };
function loadBounds(key?: string): WindowBounds | null {
  if (!key) return null;
  try {
    const value = JSON.parse(readLocalStorage(key) ?? "null");
    return value && [value.left, value.top, value.width, value.height].every(Number.isFinite)
      && value.width > 0 && value.height > 0 ? value : null;
  } catch { return null; }
}

/** An app-owned, non-modal window: the timeline remains usable behind it. */
export function FloatingPanelWindow({ title, subtitle, children, close, closeLabel, busy = false, className = "", initialPosition, place, bottomInset, storageKey, onMoveStart, onMove, onMoveEnd, onMoveCancel }: {
  onMoveStart?(): void; onMove?(x: number, y: number): void; onMoveEnd?(x: number, y: number): void; onMoveCancel?(): void;
  title: string; subtitle?: string; children: ReactNode; close(): void; closeLabel: string; busy?: boolean; className?: string; storageKey?: string; initialPosition?: { left: number; top: number };
  /** Where a window without a position first appears, once its size is known. */
  place?(box: { width: number; height: number }): { left: number; top: number };
  /** Height at the bottom of the viewport this window stays clear of, also as its content grows. */
  bottomInset?(): number;
}) {
  const root = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moving: boolean } | null>(null);
  const resize = useRef<{x:number; y:number; left:number; top:number; width:number; height:number; edge:string} | null>(null);
  const [saved] = useState(() => loadBounds(storageKey));
  const rememberBounds = () => {
    const box = root.current?.getBoundingClientRect();
    if (!storageKey || !box || box.width <= 0 || box.height <= 0) return;
    // Merge future metadata; opening or fitting a window never rewrites the preference.
    const previous = loadBounds(storageKey);
    writeLocalStorageNow(storageKey, JSON.stringify({ ...previous, left: box.left, top: box.top, width: box.width, height: box.height }));
  };
  const [size, setSize] = useState<{width:number; height:number} | null>(saved ? { width: saved.width, height: saved.height } : null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(saved ? { left: saved.left, top: saved.top } : initialPosition ?? null);
  useEffect(() => {
    const previous = document.activeElement;
    (root.current?.querySelector<HTMLElement>("textarea") ?? root.current)?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const floor = () => window.innerHeight - Math.max(0, bottomInset?.() ?? 0);
  useLayoutEffect(() => {
    let placed = !place || !!saved || !!initialPosition;
    const fit = () => {
      const box = root.current?.getBoundingClientRect();
      if (!box || box.width <= 0 || box.height <= 0) return;
      const width = Math.min(box.width, Math.max(1, window.innerWidth - 16));
      const height = Math.min(box.height, Math.max(1, floor() - 16));
      const at = placed ? box : place!({ width, height });
      placed = true;
      const left = Math.max(8, Math.min(at.left, window.innerWidth - width - 8));
      const top = Math.max(8, Math.min(at.top, floor() - height - 8));
      setPosition(current => current?.left === left && current.top === top ? current : { left, top });
      setSize(current => current ? { width, height } : current);
    };
    fit();
    window.addEventListener("resize", fit);
    // A content-sized window that grows is brought back above the reserved strip.
    const grown = bottomInset && typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    if (root.current) grown?.observe(root.current);
    return () => {
      window.removeEventListener("resize", fit);
      grown?.disconnect();
    };
  }, []);
  return createPortal(<section ref={root} className={`kd-panel kd-internal-window ${className}`} style={{ ...position, ...size }}
    role="dialog" aria-label={title} tabIndex={-1}
    onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && !event.defaultPrevented && !busy) { event.preventDefault(); close(); }
    }}>
    <header className="kd-panel-head kd-internal-window-head"
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        const box = root.current!.getBoundingClientRect();
        drag.current = { x: event.clientX, y: event.clientY, left: box.left, top: box.top, moving: false };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        if (!start.moving) {
          // Holding the title is not a move.
          if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD_PX) return;
          start.moving = true;
          onMoveStart?.();
        }
        const box = root.current!.getBoundingClientRect();
        onMove?.(event.clientX, event.clientY);
        setPosition({ left: Math.max(8, Math.min(start.left + event.clientX - start.x, window.innerWidth - box.width - 8)),
          top: Math.max(8, Math.min(start.top + event.clientY - start.y, floor() - box.height - 8)) });
      }}
      onPointerUp={event => {
        const start = drag.current;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (!start?.moving) return;
        rememberBounds();
        onMoveEnd?.(event.clientX, event.clientY);
      }}
      onPointerCancel={() => { if (drag.current?.moving) onMoveCancel?.(); drag.current = null; }}
      onLostPointerCapture={() => { if (drag.current?.moving) { rememberBounds(); onMoveCancel?.(); } drag.current = null; }}>
      <strong>{title}</strong>{subtitle && <span title={subtitle}>{subtitle}</span>}
      <button type="button" className="kd-aside-head-close" aria-label={closeLabel} title="关闭" disabled={busy} onClick={close}><X size={15} /></button>
    </header>
    <div className="kd-panel-body kd-internal-window-body">{children}</div>
    {["n","s","e","w","ne","nw","se","sw"].map(edge => <span key={edge} className="kd-pip-resize" data-edge={edge}
      role="button" tabIndex={edge === "se" ? 0 : -1} aria-label={`调整${title}窗口大小 ${edge}`}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const box = root.current!.getBoundingClientRect();
        resize.current = {x:event.clientX,y:event.clientY,left:box.left,top:box.top,width:box.width,height:box.height,edge};
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const start = resize.current;
        if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const dx=event.clientX-start.x, dy=event.clientY-start.y;
        const minWidth=Math.min(300,window.innerWidth-16), minHeight=Math.min(160,window.innerHeight-16);
        let left=start.left, top=start.top, right=left+start.width, bottom=top+start.height;
        if (edge.includes("w")) left=Math.max(8,Math.min(right-minWidth,left+dx));
        if (edge.includes("e")) right=Math.min(window.innerWidth-8,Math.max(left+minWidth,right+dx));
        if (edge.includes("n")) top=Math.max(8,Math.min(bottom-minHeight,top+dy));
        if (edge.includes("s")) bottom=Math.min(floor()-8,Math.max(top+minHeight,bottom+dy));
        setPosition({left,top}); setSize({width:right-left,height:bottom-top});
      }}
      onPointerUp={event => {if (resize.current) rememberBounds(); resize.current=null; if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);}}
      onLostPointerCapture={() => {if (resize.current) rememberBounds(); resize.current=null;}}
      onKeyUp={event => { if (event.key.startsWith("Arrow")) rememberBounds(); }}
      onBlur={rememberBounds}
      onKeyDown={event => {
        if (!event.key.startsWith("Arrow")) return;
        event.preventDefault(); event.stopPropagation();
        const box=root.current!.getBoundingClientRect();
        setSize({width:Math.min(window.innerWidth-box.left-8,Math.max(Math.min(300,window.innerWidth-16),box.width+(event.key==="ArrowRight"?16:event.key==="ArrowLeft"?-16:0))),
          height:Math.min(floor()-box.top-8,Math.max(Math.min(160,window.innerHeight-16),box.height+(event.key==="ArrowDown"?16:event.key==="ArrowUp"?-16:0)))});
      }} />)}
  </section>, document.body);
}
