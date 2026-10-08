export interface PointerSessionHandlers {
  move?(event: PointerEvent): void;
  /** `event` is null when the gesture ended without a release: cancel, lost window focus or a hidden page. */
  end(event: PointerEvent | null): void;
}

/**
 * One pointer gesture, observed at the window. The pressed element may be
 * re-parented, hidden or unmounted while it is held; it then never receives
 * its own pointerup, and state owned by the gesture would otherwise stay on.
 * Returns a function that abandons the gesture.
 */
export function trackPointerSession(pointerId: number | undefined, handlers: PointerSessionHandlers): () => void {
  let active = true;
  // Synthetic and legacy mouse events carry no pointer identity.
  const same = (event: PointerEvent) => pointerId === undefined || event.pointerId === undefined || event.pointerId === pointerId;
  const move = (event: PointerEvent) => { if (active && same(event)) handlers.move?.(event); };
  const up = (event: PointerEvent) => { if (same(event)) finish(event); };
  const cancel = (event: PointerEvent) => { if (same(event)) finish(null); };
  const abandon = () => finish(null);
  const hidden = () => { if (document.hidden) finish(null); };
  function finish(event: PointerEvent | null) {
    if (!active) return;
    active = false;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("blur", abandon);
    document.removeEventListener("visibilitychange", hidden);
    handlers.end(event);
  }
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("blur", abandon);
  document.addEventListener("visibilitychange", hidden);
  return abandon;
}

/** Movement below this is a press, not a drag. */
export const DRAG_THRESHOLD_PX = 4;
