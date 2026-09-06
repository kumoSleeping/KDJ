import { memo, useId, useLayoutEffect, useRef, type RefObject } from "react";
import { scrollFromThumb, scrollThumb, thumbPosition } from "../../lib/scrollThumb";

type Axis = "vertical" | "horizontal";
/** Floating handles only: no painted rail, no reserved gutter, no per-scroll React updates. */
export const OverlayScrollbars = memo(function OverlayScrollbars({ scroller }: {
  scroller: RefObject<HTMLElement | null>;
}) {
  const generatedId = useId();
  const vertical = useRef<HTMLDivElement>(null);
  const horizontal = useRef<HTMLDivElement>(null);
  const activity = useRef<HTMLDivElement>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const geometry = useRef({ vertical: scrollThumb(0, 0, 0, 0), horizontal: scrollThumb(0, 0, 0, 0) });
  const paintRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (!node.id) node.id = `scroll-${generatedId}`;
    let frame = 0;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const paint = () => {
      frame = 0;
      for (const axis of ["vertical", "horizontal"] as const) {
        const handle = axis === "vertical" ? vertical.current : horizontal.current;
        if (!handle) continue;
        const metric = geometry.current[axis];
        const offset = axis === "vertical" ? node.scrollTop : node.scrollLeft;
        const position = metric.inset + thumbPosition(offset, metric.extent, metric.travel);
        handle.style.transform = axis === "vertical" ? `translate3d(0, ${position}px, 0)` : `translate3d(${position}px, 0, 0)`;
        handle.style.display = metric.extent > 1 && metric.travel > 0 ? "" : "none";
        handle.style[axis === "vertical" ? "height" : "width"] = `${metric.length}px`;
        handle.setAttribute("aria-controls", node.id);
        handle.setAttribute("aria-valuemax", String(Math.round(metric.extent)));
        handle.setAttribute("aria-valuenow", String(Math.round(Math.max(0, offset))));
      }
    };
    paintRef.current = paint;
    const measure = () => {
      const hasVertical = node.scrollHeight > node.clientHeight + 1;
      const hasHorizontal = node.scrollWidth > node.clientWidth + 1;
      geometry.current = {
        vertical: scrollThumb(node.clientHeight, node.scrollHeight, 2, hasHorizontal ? 12 : 2),
        horizontal: scrollThumb(node.clientWidth, node.scrollWidth, 2, hasVertical ? 12 : 2),
      };
      paint();
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(paint);
      activity.current?.setAttribute("data-active", "true");
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => activity.current?.removeAttribute("data-active"), 800);
    };
    const onWheel = (event: WheelEvent) => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
      if (event.shiftKey && !event.deltaX) node.scrollLeft += event.deltaY * unit;
      else { node.scrollLeft += event.deltaX * unit; node.scrollTop += event.deltaY * unit; }
      event.preventDefault();
    };
    const overlay = activity.current;
    overlay?.addEventListener("wheel", onWheel, { passive: false });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      overlay?.removeEventListener("wheel", onWheel);
      node.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      if (idle !== null) clearTimeout(idle);
      dragCleanup.current?.();
    };
  }, [scroller, generatedId]);

  const beginDrag = (axis: Axis, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const node = scroller.current;
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    dragCleanup.current?.();
    const handle = event.currentTarget;
    handle.focus({ preventScroll: true });
    const pointerId = event.pointerId;
    const coordinate = (move: { clientX: number; clientY: number }) => axis === "vertical" ? move.clientY : move.clientX;
    const start = coordinate(event);
    const offset = axis === "vertical" ? node.scrollTop : node.scrollLeft;
    const metric = geometry.current[axis];
    const initial = thumbPosition(offset, metric.extent, metric.travel);
    activity.current?.setAttribute("data-dragging", axis);
    try { handle.setPointerCapture(pointerId); } catch { /* Window listeners cover lost capture. */ }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      e.preventDefault();
      const value = scrollFromThumb(initial + coordinate(e) - start, metric.extent, metric.travel);
      if (axis === "vertical") node.scrollTop = value;
      else node.scrollLeft = value;
      paintRef.current();
    };
    const end = (e: PointerEvent) => { if (e.pointerId === pointerId) cleanup(); };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", cleanup);
      handle.removeEventListener("lostpointercapture", cleanup);
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* Already released. */ }
      activity.current?.removeAttribute("data-dragging");
      if (dragCleanup.current === cleanup) dragCleanup.current = null;
    };
    dragCleanup.current = cleanup;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", cleanup);
    handle.addEventListener("lostpointercapture", cleanup);
  };
  const onKey = (axis: Axis, event: React.KeyboardEvent) => {
    const node = scroller.current;
    if (!node) return;
    const metric = geometry.current[axis];
    const current = axis === "vertical" ? node.scrollTop : node.scrollLeft;
    const page = axis === "vertical" ? node.clientHeight : node.clientWidth;
    let next: number;
    switch (event.key) {
      case "Home": next = 0; break;
      case "End": next = metric.extent; break;
      case "PageUp": next = current - page * 0.9; break;
      case "PageDown": next = current + page * 0.9; break;
      case "ArrowUp": if (axis !== "vertical") return; next = current - 36; break;
      case "ArrowDown": if (axis !== "vertical") return; next = current + 36; break;
      case "ArrowLeft": if (axis !== "horizontal") return; next = current - 40; break;
      case "ArrowRight": if (axis !== "horizontal") return; next = current + 40; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    const value = Math.min(metric.extent, Math.max(0, next));
    if (axis === "vertical") node.scrollTop = value;
    else node.scrollLeft = value;
    paintRef.current();
  };
  return (
    <div className="kd-overlay-scrollbars" ref={activity}>
      {(["vertical", "horizontal"] as const).map(axis => (
        <div key={axis} ref={axis === "vertical" ? vertical : horizontal}
          className="kd-scroll-handle" data-axis={axis} role="scrollbar" tabIndex={0}
          aria-label={axis === "vertical" ? "纵向滚动" : "横向滚动"} aria-orientation={axis}
          aria-valuemin={0} aria-valuemax={0} aria-valuenow={0}
          onPointerDown={event => beginDrag(axis, event)} onKeyDown={event => onKey(axis, event)} />
      ))}
    </div>
  );
});
