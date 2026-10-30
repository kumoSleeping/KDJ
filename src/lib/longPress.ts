/**
 * A long press: the right click of a finger or a pen.
 *
 * A row is pressed for one of three things, told apart by holding and moving:
 *   1. Held still for LONG_PRESS_MS: the menu the right click opens, under the finger. The click
 *      the release makes is swallowed, and nothing is dragged from this press any more.
 *   2. Still held, still unmoved, until LONG_PRESS_HOLD_MS: `hold` (where the row has one, the
 *      menu gives way to dragging its files out to another app — Android's own drag and drop).
 *   3. Moved past the slop before (1): not a press. The list scrolls under a finger; the row's
 *      own drags (the mouse's, to a folder, a deck or the downloads key) are left alone.
 *
 * The WebView's own long press (a `contextmenu` event near 500 ms on Android) and its HTML5
 * drag of a `draggable` cell are both part of this one gesture while it is held: the first opens
 * the menu if the timer has not, the second is refused, so neither opens a second menu or pulls a
 * drag ghost out from under the first. The mouse is not served here: it has its right button.
 *
 * On Android the WebView's long press opens the menu and the timer only stands in for it: a menu
 * that comes up before that long press makes the WebView cancel the touch right after it, and the
 * second stage needs the touch (a system drag starts only inside the press that asks for it).
 */
export const LONG_PRESS_MS = 480;
/** Where the WebView's own long press opens the menu, the timer waits this long for it. */
export const LONG_PRESS_NATIVE_WAIT_MS = 700;
export const LONG_PRESS_HOLD_MS = 1100;
/** A finger's jitter while it is held. Further than this is a scroll or a drag. */
export const LONG_PRESS_SLOP_PX = 10;

export interface LongPressHandlers {
  /** Stage one: open the row's menu at this point. */
  open(x: number, y: number): void;
  /** Stage two, if the row has one. */
  hold?(): void;
}

type Down = Pick<PointerEvent, "pointerId" | "pointerType" | "clientX" | "clientY" | "isPrimary" | "button">;

/** Starts watching a press; returns a function that abandons it. Mouse presses are ignored. */
export function startLongPress(down: Down, handlers: LongPressHandlers): () => void {
  if (down.pointerType === "mouse" || !down.isPrimary || down.button > 0) return () => undefined;
  const { pointerId, clientX: x, clientY: y } = down;
  let stage: 0 | 1 | 2 = 0;
  let done = false;
  const started = performance.now();
  const first = window.setTimeout(() => open(), window.kdj?.platform === "android" ? LONG_PRESS_NATIVE_WAIT_MS : LONG_PRESS_MS);
  let second = 0;

  function open() {
    if (done || stage) return;
    stage = 1;
    window.clearTimeout(first);
    handlers.open(x, y);
    if (handlers.hold) second = window.setTimeout(() => {
      if (done || stage !== 1) return;
      stage = 2;
      handlers.hold!();
    }, Math.max(0, LONG_PRESS_HOLD_MS - (performance.now() - started)));
  }
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (Math.hypot(event.clientX - x, event.clientY - y) <= LONG_PRESS_SLOP_PX) return;
    // Before the menu: a scroll or a drag, and no press at all. After it: the menu stays, and
    // only the second stage is given up.
    if (stage === 0) finish(false); else window.clearTimeout(second);
  };
  const up = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(stage > 0); };
  const cancel = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(false); };
  const menu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    open();
  };
  const drag = (event: DragEvent) => { event.preventDefault(); };
  function finish(swallowClick: boolean) {
    if (done) return;
    done = true;
    window.clearTimeout(first);
    window.clearTimeout(second);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("dragstart", drag, true);
    // The WebView's own contextmenu can arrive just after the release; it belongs to this press.
    window.setTimeout(() => window.removeEventListener("contextmenu", menu, true), stage ? 250 : 0);
    if (swallowClick) swallowNextClick();
  }
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("contextmenu", menu, true);
  window.addEventListener("dragstart", drag, true);
  return () => finish(false);
}

/** The click a release makes after a long press is not a click on the row (or on the menu). */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    stop();
  };
  const stop = () => {
    window.clearTimeout(timer);
    window.removeEventListener("click", swallow, true);
  };
  const timer = window.setTimeout(stop, 400);
  window.addEventListener("click", swallow, true);
}
