import { memo, useEffect, useRef, useState } from "react";

/** Reading speed of the scroll, in px per second, whatever the length of the text. */
export const MARQUEE_SPEED = 50;
/** The text rests this long once it is on screen before its first pass. */
export const MARQUEE_LEAD_MS = 550;
/** The pause at the far end, where the tail of the text is read. */
export const MARQUEE_END_HOLD_MS = 1000;
/** The pause back at the start between two passes. */
export const MARQUEE_REST_MS = 1600;
/** An overflow of a few pixels still glides instead of twitching. */
const MARQUEE_MIN_TRAVEL_MS = 600;
/** A text that is measured again (a resized column) starts over after this long at the earliest. */
const MARQUEE_RESTART_MS = 150;
/** The longest arrival of a surrounding surface the first pass waits for. */
const MARQUEE_ARRIVAL_LIMIT_MS = 1200;

export interface MarqueeCycle {
  /** One pass out, the pause, one pass back and the rest at the start, in ms. */
  duration: number;
  /** Keyframe offsets of: leaving the start, reaching the far end, leaving the far end. */
  leave: number;
  arrive: number;
  turn: number;
}

/**
 * One cycle of the scroll for a measured overflow: rest at the start, travel at the reading
 * speed, pause at the far end, travel back. Only the two travels grow with the text.
 */
export function marqueeCycle(overflow: number): MarqueeCycle {
  const travel = Math.max(MARQUEE_MIN_TRAVEL_MS, (overflow / MARQUEE_SPEED) * 1000);
  const duration = MARQUEE_REST_MS + travel + MARQUEE_END_HOLD_MS + travel;
  return {
    duration,
    leave: MARQUEE_REST_MS / duration,
    arrive: (MARQUEE_REST_MS + travel) / duration,
    turn: (MARQUEE_REST_MS + travel + MARQUEE_END_HOLD_MS) / duration,
  };
}

/**
 * How long the text is still arriving: the longest finite animation that moves the box or one of
 * its ancestors (a panel rising out of the player bar, a line swiped in on a song change).
 */
function arrivalRemaining(box: HTMLElement): number {
  if (typeof document.getAnimations !== "function") return 0;
  let wait = 0;
  for (const animation of document.getAnimations()) {
    if (animation.playState !== "running") continue;
    const effect = animation.effect;
    const target = (effect as KeyframeEffect | null)?.target;
    if (!target?.contains(box)) continue;
    const end = effect?.getComputedTiming().endTime;
    if (typeof end !== "number" || !Number.isFinite(end)) continue;
    const at = typeof animation.currentTime === "number" ? animation.currentTime : 0;
    wait = Math.max(wait, end - at);
  }
  return Math.min(wait, MARQUEE_ARRIVAL_LIMIT_MS);
}

/**
 * Measure actual overflow so short text stays still and long text reaches its end. Long text
 * scrolls back and forth at a constant speed with short fixed pauses at both ends; the pointer
 * resting on it pauses the scroll, and reduced motion leaves it still behind an ellipsis.
 */
export const MarqueeText = memo(function MarqueeText({ className, text }: { className: string; text: string }) {
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let alive = true;
    const measure = () => {
      if (!alive || !box.clientWidth) return;
      // Measuring the inner span avoids ellipsis changing the outer scrollWidth.
      const content = box.firstElementChild as HTMLElement | null;
      const over = (content?.scrollWidth ?? box.scrollWidth) - box.clientWidth;
      setShift(over > 1 ? over : 0);
    };
    measure();
    // System CJK font fallback can settle after layout without firing a font event.
    const frame = requestAnimationFrame(measure);
    const timer = window.setTimeout(measure, 400);
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [text]);

  // When this text may first move: once it has arrived and rested for the lead.
  const ready = useRef({ text: "", at: 0 });
  useEffect(() => {
    const box = boxRef.current;
    const content = box?.firstElementChild as HTMLElement | null;
    if (!box || !content || !shift || typeof content.animate !== "function") return;
    const reduced = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    let animation: Animation | null = null;
    const start = () => {
      animation?.cancel();
      animation = null;
      if (reduced?.matches) return;
      const now = performance.now();
      if (ready.current.text !== text) ready.current = { text, at: now + arrivalRemaining(box) + MARQUEE_LEAD_MS };
      const wait = Math.max(MARQUEE_RESTART_MS, ready.current.at - now);
      const cycle = marqueeCycle(shift);
      const home = "translateX(0px)", far = `translateX(${-shift}px)`;
      // Every cycle begins with the rest at the start; the first one is entered partway through
      // it, so the first pass begins after the lead alone.
      animation = content.animate([
        { offset: 0, transform: home },
        { offset: cycle.leave, transform: home },
        { offset: cycle.arrive, transform: far },
        { offset: cycle.turn, transform: far },
        { offset: 1, transform: home },
      ], { duration: cycle.duration, iterations: Infinity, delay: wait - MARQUEE_REST_MS });
      if (box.matches(":hover")) animation.pause();
    };
    start();
    // Resting the pointer on the text holds it still so the whole name can be read.
    const pause = () => animation?.pause();
    const resume = () => animation?.play();
    box.addEventListener("pointerenter", pause);
    box.addEventListener("pointerleave", resume);
    reduced?.addEventListener?.("change", start);
    return () => {
      box.removeEventListener("pointerenter", pause);
      box.removeEventListener("pointerleave", resume);
      reduced?.removeEventListener?.("change", start);
      animation?.cancel();
    };
  }, [shift, text]);

  return <span ref={boxRef} className={`kd-marquee-viewport ${className}`} title={text}
    data-marquee={shift ? "true" : undefined}>
    <span key={text} className="kd-marquee">{text}</span>
  </span>;
});
