import { create } from "zustand";
import { prefersReducedMotion } from "./motion";
import { endPlayerBarSlide } from "./nowPlayingInfo";
import { tracePlayback } from "./playbackTrace";
import { playerBarMoving, usePlayerBarAway } from "./playerBarAway";
import { useWindowTaken } from "./windowTaken";

/**
 * The mini player: the whole window taken down to the playing song's bubble, and brought back.
 * It is the same window and the same page, so playback and everything the page holds stay as
 * they are; the window's frame is the native side's (src-tauri/src/mini_player.rs) and what is
 * drawn, and in which order, is decided here.
 *
 * Down: the whole window is gone at once, and the mini player pops out of the nearest corner
 * of its screen at the place the listener last left it at. Back: it goes into that corner
 * again, and the whole window fades in as it was. The pop and the fade are the window's own
 * (the native side's); nothing flies from one place to another and nothing else is seen to
 * move.
 *
 * A WebView shows its last picture until the page has drawn for a new size, so the window is
 * never given another size where it can be seen. Everything the page does for the other
 * size (the bar going or coming, the bubble becoming the transport or giving it back) is done
 * while the window is out of sight, at once and without its own motion, and the window is
 * shown when the page has drawn (`reveal`). That is the one wait there is, and it lasts as
 * long as the drawing takes.
 *
 * The page behind is never laid out for another size, not even once: one layout of a long
 * list costs a few hundred ms, and each of them is time with nothing on the screen (measured
 * 2026-10-12: 0.7 s and more per way, of which the steps themselves were a tenth). So the
 * page is given the whole window's size in px before the window is given the bubble's, keeps
 * it until the window is whole again, and the bar keeps its row meanwhile (MiniPlayer.css).
 *
 * The phase is written on the document element (`data-kd-mini`); MiniPlayer.css draws it.
 * While it lasts the mini player has the window (lib/windowTaken.ts), which is what makes the
 * page inert and sends the bar away.
 */
export type MiniPlayerPhase = "off" | "on";

/** Who has the window (`data-taken-by`) while the mini player lasts. */
export const MINI_PLAYER = "mini-player";
export const MINI_PLAYER_ATTR = "data-kd-mini";
/** The playing song's bubble in its stack: the mini player is this element and nothing else. */
export const MINI_PLAYER_BUBBLE = '.kd-task-host > .kd-task-slot > .kd-task[data-kind="playing"]';

/** How many frames the bubble may take to come up as the transport once the bar is sent away,
 *  and the bar to be at rest once its slide is ended for it. */
const READY_FRAMES = 15;
const BAR_FRAMES = 6;
/** How long the page may take to learn the window's new size, in ms. */
const RESIZE_WAIT_MS = 700;

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

/** The whole window the mini player came from, in CSS px. */
let whole: { width: number; height: number } | null = null;

/** The page keeps the whole window's layout while the window is the bubble, and the bubble
 *  the width it has in the whole window (`bubble`, when it is known). Written on the body: the
 *  list measures itself again whenever the root's own style changes. */
function keepLayout(of: { width: number; height: number }, bubble?: number): void {
  const style = document.body.style;
  style.setProperty("--kd-mini-w", `${of.width}px`);
  style.setProperty("--kd-mini-h", `${of.height}px`);
  if (bubble) style.setProperty("--kd-mini-bw", `${bubble}px`);
}

/** Nothing of the mini player is left on the page. */
function clearPage(): void {
  for (const name of ["--kd-mini-w", "--kd-mini-h", "--kd-mini-bw"]) document.body.style.removeProperty(name);
}

/** The page has the size the window was given. */
async function sized(width: number, height: number): Promise<void> {
  const until = performance.now() + RESIZE_WAIT_MS;
  while (performance.now() < until && (Math.abs(window.innerWidth - width) > 2 || Math.abs(window.innerHeight - height) > 2)) await frame();
}

/** The page has drawn what it is now: the frame that lays it out and the one that shows it. */
async function drawn(): Promise<void> {
  await frame();
  await frame();
}

/**
 * The page has the size the window was given, and has drawn for it. The window is out of
 * sight meanwhile; shown before the page has the size, it shows the last picture of the
 * other one.
 */
async function drawnFor(width: number, height: number): Promise<void> {
  await sized(width, height);
  await drawn();
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

/**
 * The bar is where it is wanted without sliding there (lib/playerBarAway.ts): the window is
 * out of sight, and a slide that began now would be halfway when it is shown.
 */
async function barAtRest(): Promise<void> {
  for (let waited = 0; waited < BAR_FRAMES; waited += 1) {
    await frame();
    if (!playerBarMoving(usePlayerBarAway.getState().phase)) return;
    endPlayerBarSlide();
  }
}

let switching = false;

/** How long each part of a way took, in ms, into the app's log (`mini-down`, `mini-back`): the
 *  window's own motion, the time out of sight, and the showing. */
function traced(event: string, marks: number[], names: string[]): void {
  const detail: Record<string, number> = {};
  names.forEach((name, index) => { detail[name] = Math.round(marks[index + 1] - marks[index]); });
  tracePlayback(event, detail);
}

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
    const slot = document.querySelector<HTMLElement>(MINI_PLAYER_BUBBLE)?.parentElement;
    if (!slot) throw new Error("no playing song to show");
    const box = slot.getBoundingClientRect();
    whole = { width: window.innerWidth, height: window.innerHeight };
    const marks = [performance.now()];
    // The whole window is gone at once, as it is: nothing in it has moved, and it keeps its size.
    const state = await bridge.collapse({ x: box.left, y: box.top, width: box.width, height: box.height }, animated);
    marks.push(performance.now());
    useMiniPlayer.setState({ onTop: state.onTop });
    // Out of sight, and before the window is any smaller: the page keeps the whole window's
    // layout, the bar goes, and the bubble is the transport, as wide as it stood.
    keepLayout(whole, box.width);
    useWindowTaken.getState().take(MINI_PLAYER, () => { void expandFromMiniPlayer(); });
    setPhase("on");
    const bubble = await transportBubble();
    if (!bubble) throw new Error("no playing song to show");
    // The window takes the bubble's size, which is known before it has it.
    const tall = Math.ceil(bubble.getBoundingClientRect().height);
    await bridge.fit(box.width, tall);
    await drawnFor(box.width, tall);
    // Should the bubble be another height in a window of its own after all, the window takes
    // that now, and not a moment after it is shown.
    const real = Math.ceil(bubble.getBoundingClientRect().height);
    if (real > 0 && Math.abs(real - window.innerHeight) >= 1) {
      await bridge.fit(window.innerWidth, real).catch(() => {});
      await drawnFor(window.innerWidth, real);
    }
    marks.push(performance.now());
    // It pops out at its place.
    await bridge.reveal(animated);
    marks.push(performance.now());
    traced("mini-down", marks, ["gone", "unseen", "pop"]);
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
    const marks = [performance.now()];
    // It goes back into its corner of the screen.
    await bridge.expand(animated);
    marks.push(performance.now());
    // Out of sight. The page stays as it is until the window is whole again, so that nothing
    // of it is laid out for a size in between (giving the window back first measured slower:
    // what the bar draws on its return is then drawn again for the new size). Then the bar is
    // in its row and the bubble on it, without their slides.
    if (whole) await sized(whole.width, whole.height);
    useWindowTaken.getState().release(MINI_PLAYER);
    await barAtRest();
    clearPage();
    setPhase("off");
    await drawn();
    marks.push(performance.now());
    await bridge.reveal(animated);
    marks.push(performance.now());
    traced("mini-back", marks, ["pop", "unseen", "fade"]);
  } catch (error) {
    console.warn("mini player: expand failed", error);
    await restore();
  } finally {
    switching = false;
  }
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
    whole = { width: state.fullWidth, height: state.fullHeight };
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
