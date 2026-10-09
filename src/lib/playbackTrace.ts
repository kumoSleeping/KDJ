import { invoke } from "@tauri-apps/api/core";

/**
 * Slow moments measured in the WebView, written to the native log beside the playback
 * coordinator's own timeline. A hang reported by a listener can then be read from one file:
 * whether the main thread stalled, an input event arrived late, or a command waited.
 */
export function tracePlayback(event: string, detail: Record<string, number | string | null>): void {
  if (!window.__TAURI_INTERNALS__) return;
  void invoke("playback_trace", { event, detail: JSON.stringify(detail) }).catch(() => undefined);
}

const TICK_MS = 100;
/** A timer this late means nothing else on the main thread ran either. */
const STALL_MS = 200;
/** An input event handled this long after the system produced it was waiting for the thread. */
const INPUT_DELAY_MS = 120;

/** Reports main-thread stalls and late pointer input while the window is visible. */
export function watchMainThread(): () => void {
  let last = performance.now();
  let visible = document.visibilityState === "visible";
  const timer = window.setInterval(() => {
    const now = performance.now();
    const late = now - last - TICK_MS;
    last = now;
    const wasVisible = visible;
    visible = document.visibilityState === "visible";
    // A hidden window's timers are throttled by the WebView; that is not a stall.
    if (late > STALL_MS && visible && wasVisible) tracePlayback("stall", { ms: Math.round(late) });
  }, TICK_MS);
  const onPointer = (event: PointerEvent) => {
    const late = performance.now() - event.timeStamp;
    if (late < INPUT_DELAY_MS || late > 60_000) return;
    const target = event.target instanceof Element ? event.target : null;
    tracePlayback("late-input", {
      ms: Math.round(late), type: event.type,
      on: target?.closest("[class]")?.className.toString().split(" ")[0] ?? "",
    });
  };
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("pointerup", onPointer, true);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("pointerup", onPointer, true);
  };
}
