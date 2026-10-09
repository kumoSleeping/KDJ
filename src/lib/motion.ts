/**
 * The script half of the motion schema (src/motion.css, docs/motion-schema.md).
 *
 * Arriving is CSS alone: a surface carries `data-kd-motion` and plays its gesture when it is
 * mounted. Leaving needs this file, because React removes a surface the moment its owner says
 * so: the removed element is put back as a picture of itself, plays the leaving gesture and is
 * then removed for good. The owner's action has already run; nothing waits for the picture.
 */
import type { RefCallback } from "react";
import { SONG_SWAP_IN_MS, SONG_SWAP_OUT_MS } from "./songSwapMotion";

export type MotionGesture = "unfold" | "pop" | "slide" | "fade";

/** The durations of src/motion.css, for code that has to wait for a gesture. */
export const MOTION_MICRO_MS = 160;
export const MOTION_MICRO_OUT_MS = 110;
/** Upper bound of a menu's opening, its last item included. */
export const MOTION_STAGGER_TOTAL_MS = 220;
export const MOTION_IN_MS = SONG_SWAP_IN_MS;
export const MOTION_OUT_MS = SONG_SWAP_OUT_MS;
export const MOTION_REDUCED_MS = 80;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** How long a surface with this gesture takes to leave. */
export function leaveDuration(gesture: string | null | undefined): number {
  if (prefersReducedMotion()) return MOTION_REDUCED_MS;
  return gesture === "slide" ? MOTION_OUT_MS : MOTION_MICRO_OUT_MS;
}

/**
 * Call from the cleanup of the effect (or ref) that owns `el`, while it is still in the
 * document. If React then removes the element, it is put back where it was — inert, without
 * ids, marked `data-kd-leaving` — and taken out again when its leaving gesture has ended.
 *
 * Only a surface that lies over the page (fixed or absolute) leaves this way: an element in
 * the flow would hold its place open for the length of the gesture.
 */
export function leaveAfterUnmount(el: HTMLElement): void {
  const parent = el.parentNode;
  // No animation engine (unit tests, a very old WebView): the surface simply goes.
  if (!parent || !el.isConnected || typeof el.animate !== "function") return;
  const position = getComputedStyle(el).position;
  if (position !== "fixed" && position !== "absolute") return;
  const next = el.nextSibling;
  const scrollTop = el.scrollTop;
  queueMicrotask(() => {
    // Still there: StrictMode replayed the effect, nothing was removed. Parent gone as well:
    // the surface went with what it belonged to.
    if (el.isConnected || !parent.isConnected) return;
    el.removeAttribute("id");
    el.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
    el.setAttribute("data-kd-leaving", "true");
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("inert", "");
    parent.insertBefore(el, next?.parentNode === parent ? next : null);
    // Leaving the document closed the popover; it folds in the top layer, where it was.
    if (el.hasAttribute("popover")) {
      try { el.showPopover?.(); } catch { /* It then folds as a plain fixed element. */ }
    }
    if (scrollTop) el.scrollTop = scrollTop;
    const remove = () => el.remove();
    // Only the leaving gesture ends the picture: the end of an arrival that finished just
    // before the surface was closed may still be on its way.
    const gesture = getComputedStyle(el).animationName;
    el.addEventListener("animationend", event => {
      if (event.target === el && event.animationName === gesture) remove();
    });
    // A surface whose gesture never runs (hidden by a parent, styles not loaded) still goes.
    window.setTimeout(remove, leaveDuration(el.getAttribute("data-kd-motion")) + 120);
  });
}

const leaveRef: RefCallback<HTMLElement> = el => {
  if (!el) return;
  return () => leaveAfterUnmount(el);
};

/**
 * The one-step opt-in for an element that is rendered while it is open:
 * `<div className="my-popover" {...motion("unfold")}>`. It arrives with the gesture and leaves
 * with its counterpart when React unmounts it.
 */
export function motion(gesture: MotionGesture, options: { edge?: "left" | "right" | "top" | "bottom"; from?: "side" } = {}) {
  return {
    "data-kd-motion": gesture,
    "data-kd-edge": options.edge,
    "data-kd-from": options.from,
    ref: leaveRef,
  };
}
