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
 * Down: the whole window fades away as it is; the mini player appears where the bubble stood
 * and jumps, in an arc like something thrown, to the place the listener last left it at. Back:
 * it jumps to the bubble's corner of the whole window, is gone as it lands, and the whole
 * window is there as it was. The fade and the jump are the window's own (the native side's);
 * nothing else is seen to move.
 *
 * A WebView shows its last picture until the page has drawn for a new size, so the window is
 * never given another size where it can be seen. Everything the page does for the other
 * size (the bar going or coming, the bubble becoming the transport or giving it back, the
 * layout) is done while the window is out of sight, at once and without its own motion, and
 * the window is shown when the page has drawn (`reveal`). That is the one wait there is, and
 * it lasts as long as the drawing takes.
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
/** How tall the mini player was the last time: what the window is given before the bubble can
 *  be measured as one, so that it seldom needs a second size. */
let lastHeight = 0;

/** The page keeps the whole window's layout while the window is the bubble. */
function keepLayout(of: { width: number; height: number }): void {
  const style = document.documentElement.style;
  style.setProperty("--kd-mini-w", `${of.width}px`);
  style.setProperty("--kd-mini-h", `${of.height}px`);
}

/** Nothing of the mini player is left on the page. */
function clearPage(): void {
  for (const name of ["--kd-mini-w", "--kd-mini-h"]) document.documentElement.style.removeProperty(name);
}

/**
 * The page has the size the window was given, and has drawn for it: the frame that lays it
 * out and the one that shows it. The window is out of sight meanwhile; shown before the page
 * has the size, it shows the last picture of the other one.
 */
async function drawnFor(width: number, height: number): Promise<void> {
  const until = performance.now() + RESIZE_WAIT_MS;
  while (performance.now() < until && (Math.abs(window.innerWidth - width) > 2 || Math.abs(window.innerHeight - height) > 2)) await frame();
  await frame();
  await frame();
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
    const foreseen = Math.max(lastHeight, Math.ceil(box.height));
    whole = { width: window.innerWidth, height: window.innerHeight };
    const marks = [performance.now()];
    // The whole window goes as it is: nothing in it has moved.
    const state = await bridge.collapse({ x: box.left, y: box.top, width: box.width, height: box.height, tall: foreseen }, animated);
    marks.push(performance.now());
    useMiniPlayer.setState({ onTop: state.onTop });
    // Out of sight: the bar goes, and the bubble is the transport and the window.
    keepLayout(whole);
    useWindowTaken.getState().take(MINI_PLAYER, () => { void expandFromMiniPlayer(); });
    setPhase("on");
    const bubble = await transportBubble();
    if (!bubble) throw new Error("no playing song to show");
    await drawnFor(box.width, foreseen);
    // Should the bubble be another height than was foreseen, the window takes it now, and not
    // a moment after it is shown.
    const tall = Math.ceil(bubble.getBoundingClientRect().height);
    if (tall > 0 && Math.abs(tall - window.innerHeight) >= 1) {
      await bridge.fit(window.innerWidth, tall).catch(() => {});
      await drawnFor(window.innerWidth, tall);
    }
    if (tall > 0) lastHeight = tall;
    marks.push(performance.now());
    // It appears where the bubble stood and jumps to its place.
    await bridge.reveal(animated);
    marks.push(performance.now());
    traced("mini-down", marks, ["fade", "unseen", "jump"]);
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
    // It jumps back to the bubble's corner of the whole window and is gone as it lands.
    await bridge.expand(animated);
    marks.push(performance.now());
    // Out of sight: the bar is in its row again and the bubble on it, without their slides.
    useWindowTaken.getState().release(MINI_PLAYER);
    await barAtRest();
    clearPage();
    setPhase("off");
    if (whole) await drawnFor(whole.width, whole.height);
    marks.push(performance.now());
    await bridge.reveal(animated);
    marks.push(performance.now());
    traced("mini-back", marks, ["jump", "unseen", "fade"]);
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
