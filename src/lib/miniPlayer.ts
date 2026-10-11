import { create } from "zustand";
import { prefersReducedMotion } from "./motion";
import { useWindowTaken } from "./windowTaken";

/**
 * The mini player: the whole window taken down to the playing song's bubble, and brought back.
 * It is the same window and the same page, so playback and everything the page holds stay as
 * they are; the window's frame is the native side's (src-tauri/src/mini_player.rs) and what is
 * drawn, and in which order, is decided here.
 *
 * Nothing is animated about the window's size. The whole window fades away and the bubble is
 * there in its place, as a window of its own; back, the bubble fades and the whole window is
 * there. The one thing that moves is the bubble: it flies in an arc, like something thrown,
 * between its corner of the whole window and the place the listener last left it at.
 *
 * Down: the bar leaves and the bubble becomes the transport (`readying`, a few frames); the
 * bubble flies to its place (`flying`); the whole window is gone and the bubble is the window
 * (`on`). Back: the whole window is there, its bubble's corner empty and the bubble still at
 * its place; the bubble flies back into the corner (`landing`).
 *
 * That is what is seen when the place lies inside the whole window's frame, and the page
 * draws the flight itself. A place outside it cannot be drawn by a page that ends at the
 * window's edge: then the mini player's own window flies, after the whole window has gone and
 * before it is back.
 *
 * A WebView shows its last picture until the page has drawn for a new size, so the window is
 * never given another size where it can be seen: the native side puts it beyond the screens
 * first and shows it again when the page says it has drawn (`reveal`).
 *
 * The phase is written on the document element (`data-kd-mini`); MiniPlayer.css draws each.
 * While it lasts the mini player has the window (lib/windowTaken.ts), which is what makes the
 * page inert and sends the bar away.
 */
export type MiniPlayerPhase = "off" | "readying" | "flying" | "on" | "landing";

/** Who has the window (`data-taken-by`) while the mini player lasts. */
export const MINI_PLAYER = "mini-player";
export const MINI_PLAYER_ATTR = "data-kd-mini";
/** The playing song's bubble in its stack: the mini player is this element and nothing else. */
export const MINI_PLAYER_BUBBLE = '.kd-task-host > .kd-task-slot > .kd-task[data-kind="playing"]';

/** How many frames the bubble may take to come up as the transport once the bar is sent away. */
const READY_FRAMES = 15;
/** The gap a bubble keeps to the window's edges (--kd-task-gap), where it cannot be measured. */
const BUBBLE_EDGE = 12;
/** The bubble's flight, and how high it rises above the straight line, in px: a share of the
 *  distance within limits. The native side flies its window by the same numbers. */
const FLIGHT_MS = 420;
const FLIGHT_EASE = "cubic-bezier(0.65, 0, 0.35, 1)";
const FLIGHT_RISE = { share: 0.3, least: 56, most: 240 } as const;
/** Another song: how long the mini player takes to leave the screen and to come back onto it,
 *  and how long it stays away: at least long enough for the bubble to have let the old song
 *  go, at most this long whatever the bubble does. */
const DIP_OUT_MS = 240;
const DIP_IN_MS = 380;
const DIP_AWAY_MS = { least: 160, most: 1400 } as const;

export const useMiniPlayer = create<{ phase: MiniPlayerPhase; onTop: boolean }>(() => ({ phase: "off", onTop: true }));

/** Only the desktop's main window can become one. */
export function miniPlayerOffered(): boolean {
  return typeof window !== "undefined" && !!window.kdj?.miniPlayer;
}

function setPhase(phase: MiniPlayerPhase): void {
  if (phase === "off") document.documentElement.removeAttribute(MINI_PLAYER_ATTR);
  else document.documentElement.setAttribute(MINI_PLAYER_ATTR, phase);
  useMiniPlayer.setState({ phase });
}

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

interface Point { x: number; y: number }
/** The whole window the mini player came from, in CSS px, and the gap its bubble kept there. */
interface Whole { width: number; height: number; edge: number }
let whole: Whole | null = null;
/** The bubble's flight inside the page, while it lasts. */
let flight: Animation | null = null;

/** The page keeps the whole window's layout while the window is the bubble. */
function keepLayout(of: Whole): void {
  const style = document.documentElement.style;
  style.setProperty("--kd-mini-w", `${of.width}px`);
  style.setProperty("--kd-mini-h", `${of.height}px`);
}

/** Nothing of the mini player is left on the page. */
function clearPage(): void {
  flight?.cancel();
  flight = null;
  for (const name of ["--kd-mini-w", "--kd-mini-h"]) document.documentElement.style.removeProperty(name);
}

/** The points of an arc from `from` to `to`, both measured from where the bubble is laid out. */
export function flightPath(from: Point, to: Point, steps = 24): Point[] {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const rise = distance < 1 ? 0 : Math.min(FLIGHT_RISE.most, Math.max(FLIGHT_RISE.least, distance * FLIGHT_RISE.share));
  return Array.from({ length: steps + 1 }, (_, step) => {
    const t = step / steps;
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t - rise * 4 * t * (1 - t) };
  });
}

/** Flies the bubble inside the page. It holds both ends until it is cancelled. */
function fly(slot: HTMLElement, from: Point, to: Point, animated: boolean): Animation | null {
  if (typeof slot.animate !== "function") return null;
  return slot.animate(
    flightPath(from, to).map(point => ({ transform: `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)` })),
    { duration: animated ? FLIGHT_MS : 0, easing: FLIGHT_EASE, fill: "both" },
  );
}

/** A bubble of this size at `place` (from the window's top-left corner) is all inside the window. */
function insideWindow(place: readonly [number, number] | null | undefined, width: number, height: number, of: { width: number; height: number }): place is readonly [number, number] {
  return !!place && place[0] >= 0 && place[1] >= 0 && place[0] + width <= of.width && place[1] + height <= of.height;
}

/** How long the page may take to learn the window's new size, in ms. */
const RESIZE_WAIT_MS = 700;

/**
 * The page has the size the window was given, and has drawn for it. Nothing is hurried here:
 * the window is out of sight meanwhile, and showing it a frame early shows the last picture
 * of the other size.
 */
async function drawnFor(width: number, height: number): Promise<void> {
  const until = performance.now() + RESIZE_WAIT_MS;
  while (performance.now() < until && (Math.abs(window.innerWidth - width) > 2 || Math.abs(window.innerHeight - height) > 2)) await frame();
  for (let drawn = 0; drawn < 4; drawn += 1) await frame();
}

/** The bubble once it is the transport (the bar has been sent away), or as it is if it never is. */
async function transportBubble(): Promise<HTMLElement | null> {
  let bubble: HTMLElement | null = null;
  for (let waited = 0; waited < READY_FRAMES; waited += 1) {
    await frame();
    bubble = document.querySelector<HTMLElement>(MINI_PLAYER_BUBBLE);
    if (bubble?.querySelector(".kd-task-controls-clip")) return bubble;
  }
  return bubble;
}

/** How tall the bubble is going to be when its transport row has opened (TaskBubbleHost.tsx). */
function restingHeight(bubble: HTMLElement): number {
  const tall = bubble.offsetHeight || bubble.getBoundingClientRect().height;
  const clip = bubble.querySelector<HTMLElement>(".kd-task-controls-clip");
  return Math.ceil(clip ? tall - clip.offsetHeight + clip.scrollHeight : tall);
}

let switching = false;

/** The whole window again, from whatever step went wrong. */
async function restore(): Promise<void> {
  const bridge = window.kdj?.miniPlayer;
  if (bridge && (await bridge.state().catch(() => null))?.active) {
    await bridge.expand(false).catch(() => {});
    await bridge.reveal(false).catch(() => {});
  }
  clearPage();
  useWindowTaken.getState().release(MINI_PLAYER);
  setPhase("off");
}

export async function collapseToMiniPlayer(): Promise<void> {
  const bridge = window.kdj?.miniPlayer;
  if (!bridge || switching || useMiniPlayer.getState().phase !== "off") return;
  switching = true;
  const animated = !prefersReducedMotion();
  try {
    // An app that has the window (full-screen lyrics) is a drawer again first.
    const taken = useWindowTaken.getState();
    if (taken.by && taken.by !== MINI_PLAYER) {
      taken.leave?.();
      await frame();
    }
    const size = { width: window.innerWidth, height: window.innerHeight };
    setPhase("readying");
    useWindowTaken.getState().take(MINI_PLAYER, () => { void expandFromMiniPlayer(); });
    const bubble = await transportBubble();
    const slot = bubble?.parentElement;
    if (!bubble || !slot) throw new Error("no playing song to show");
    const box = slot.getBoundingClientRect();
    const height = restingHeight(bubble);
    const edge = Math.max(0, Math.round(size.width - box.right));
    whole = { ...size, edge };
    // Its own corner of the whole window: where it stands once the bar is gone.
    const home = { x: box.left, y: Math.max(0, size.height - edge - height) };
    let at = home;
    const place = await bridge.place(box.width, height).catch(() => null);
    if (insideWindow(place, box.width, height, size) && Math.hypot(place[0] - home.x, place[1] - home.y) >= 1) {
      // Its place is inside the whole window: it flies there in front of the page.
      setPhase("flying");
      const laid = { x: home.x, y: size.height - edge - box.height };
      flight = fly(slot, { x: box.left - laid.x, y: box.top - laid.y }, { x: place[0] - home.x, y: place[1] - home.y }, animated);
      await flight?.finished.catch(() => {});
      at = { x: place[0], y: place[1] };
    }
    keepLayout(whole);
    const state = await bridge.collapse({
      x: at.x, y: at.y, width: box.width, height, homeRight: home.x + box.width, homeBottom: home.y + height,
    }, animated);
    useMiniPlayer.setState({ onTop: state.onTop });
    setPhase("on");
    flight?.cancel();
    flight = null;
    // The page draws the bubble as the window before the window is shown again.
    await drawnFor(box.width, height);
    // Should the bubble be another height than was foreseen, the window takes it now, out of
    // sight, and not a moment after it is shown.
    const tall = Math.ceil(bubble.getBoundingClientRect().height);
    if (tall > 0 && Math.abs(tall - window.innerHeight) >= 1) {
      await bridge.fit(window.innerWidth, tall).catch(() => {});
      await drawnFor(window.innerWidth, tall);
    }
    await bridge.reveal(animated);
    // A place outside the whole window: the mini player's own window flies there.
    await bridge.settle(animated).catch(() => {});
  } catch (error) {
    console.warn("mini player: collapse failed", error);
    await restore();
  } finally {
    switching = false;
  }
}

export async function expandFromMiniPlayer(): Promise<void> {
  const bridge = window.kdj?.miniPlayer;
  if (!bridge || switching || useMiniPlayer.getState().phase !== "on") return;
  switching = true;
  const animated = !prefersReducedMotion();
  try {
    await dipping;
    const slot = document.querySelector<HTMLElement>(MINI_PLAYER_BUBBLE)?.parentElement ?? null;
    // From its corner of the whole window to where it is now, when that is inside the window.
    let away: Point | null = null;
    if (slot && whole) {
      const box = slot.getBoundingClientRect();
      const home = { x: whole.width - whole.edge - box.width, y: whole.height - whole.edge - box.height };
      const place = await bridge.place(box.width, box.height).catch(() => null);
      if (insideWindow(place, box.width, box.height, whole) && Math.hypot(place[0] - home.x, place[1] - home.y) >= 1) {
        away = { x: place[0] - home.x, y: place[1] - home.y };
      }
    }
    // Otherwise the mini player's own window flies back to that corner first.
    await bridge.recall(animated, !!away).catch(() => {});
    await bridge.expand(animated);
    setPhase("landing");
    if (away && slot) {
      flight = fly(slot, away, { x: 0, y: 0 }, animated);
      flight?.pause();
    }
    // The page draws the whole window, the bubble still at its place, before it is shown.
    if (whole) await drawnFor(whole.width, whole.height);
    await bridge.reveal(animated);
    flight?.play();
    await flight?.finished.catch(() => {});
    clearPage();
    setPhase("off");
    useWindowTaken.getState().release(MINI_PLAYER);
  } catch (error) {
    console.warn("mini player: expand failed", error);
    await restore();
  } finally {
    switching = false;
  }
}

/** A dip that is on its way: the way back to the whole window waits for it. */
let dipping: Promise<void> = Promise.resolve();
let away = false;

const pause = (ms: number) => new Promise<void>(resolve => { window.setTimeout(resolve, ms); });

/** The bubble shows one song and is not on its way anywhere: the new song is in it. */
function bubbleAtRest(): boolean {
  const bubbles = document.querySelectorAll(MINI_PLAYER_BUBBLE);
  return bubbles.length === 1 && bubbles[0].getAttribute("data-phase") !== "out";
}

/**
 * Another song. In the whole window the bubble rolls down behind the bar with the old song and
 * rises with the new one; the mini player has the screen for a window, so it leaves past the
 * screen's edge, changes what it shows while it is away, and comes back. Once per change: it
 * stays away until the bubble shows the new song and nothing else, however many steps the
 * bubble takes to get there, and a change that comes while it is away is waited out with it.
 */
export function dipMiniPlayer(): void {
  const bridge = window.kdj?.miniPlayer;
  if (!bridge || switching || away || useMiniPlayer.getState().phase !== "on" || prefersReducedMotion()) return;
  away = true;
  dipping = (async () => {
    try {
      if (!await bridge.leave(DIP_OUT_MS)) return;
      const until = performance.now() + DIP_AWAY_MS.most;
      await pause(DIP_AWAY_MS.least);
      // Timers, not frames: a window that is off the screen may not be given any.
      while (performance.now() < until && !bubbleAtRest()) await pause(40);
      const box = document.querySelector<HTMLElement>(MINI_PLAYER_BUBBLE)?.getBoundingClientRect();
      await bridge.comeBack(DIP_IN_MS, box?.width ?? 0, box ? Math.ceil(box.height) : 0);
    } catch {
      // The native side brings it back by itself.
    } finally {
      away = false;
    }
  })();
}

export async function setMiniPlayerOnTop(onTop: boolean): Promise<void> {
  const bridge = window.kdj?.miniPlayer;
  if (!bridge) return;
  useMiniPlayer.setState({ onTop });
  const state = await bridge.setOnTop(onTop).catch(() => null);
  if (state) useMiniPlayer.setState({ onTop: state.onTop });
}

/**
 * What the native side says at launch. A page that was loaded again while its window was the
 * mini player (a reload) takes up where the window is.
 */
export async function syncMiniPlayer(): Promise<void> {
  const state = await window.kdj?.miniPlayer?.state().catch(() => null);
  if (!state) return;
  useMiniPlayer.setState({ onTop: state.onTop });
  if (!state.active || switching || useMiniPlayer.getState().phase !== "off") return;
  if (state.fullWidth && state.fullHeight) {
    whole = { width: state.fullWidth, height: state.fullHeight, edge: BUBBLE_EDGE };
    keepLayout(whole);
  }
  useWindowTaken.getState().take(MINI_PLAYER, () => { void expandFromMiniPlayer(); });
  setPhase("on");
}

/**
 * The window follows the bubble's height (another song's title, a row that came or went).
 * Returns false when there is no bubble to show: the caller gives the window back.
 */
export function fitMiniPlayer(): boolean {
  const bridge = window.kdj?.miniPlayer;
  if (!bridge || switching || useMiniPlayer.getState().phase !== "on") return true;
  const bubble = document.querySelector<HTMLElement>(MINI_PLAYER_BUBBLE);
  if (!bubble) return false;
  const height = Math.ceil(bubble.getBoundingClientRect().height);
  if (height > 0 && Math.abs(height - window.innerHeight) >= 1) void bridge.fit(window.innerWidth, height).catch(() => {});
  return true;
}
