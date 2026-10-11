import { create } from "zustand";
import { MOTION_IN_MS, MOTION_OUT_MS, prefersReducedMotion } from "./motion";
import { usePlayerBarAway } from "./playerBarAway";
import { useWindowTaken } from "./windowTaken";

/**
 * The mini player: the whole window taken down to the playing song's bubble, and brought back.
 * It is the same window and the same page, so playback and everything the page holds stay as
 * they are; the window's frame is the native side's (src-tauri/src/mini_player.rs) and what is
 * drawn, and in which order, is decided here.
 *
 * Down: the page folds into the bubble while the player bar leaves and the bubble becomes the
 * transport (`folding`); the bubble fades and the window, one flat colour now, comes down to
 * where the bubble stood (`flat`); the bubble fills it and comes back (`on`), and it goes to
 * the place the listener last left it at. Back: it returns to its corner of the whole window,
 * fades (`flat`), the window grows, and the page unfolds out of it (`unfolding`).
 *
 * The window only changes size while it shows one flat colour. A WebView draws its last
 * picture from the top-left corner until the page has laid out for the new size, so a bubble
 * on show at the bottom right would jump on every step of the way.
 *
 * The phase is written on the document element (`data-kd-mini`); MiniPlayer.css draws each.
 * While it lasts the mini player has the window (lib/windowTaken.ts), which is what hides the
 * page, makes it inert and sends the bar away.
 */
export type MiniPlayerPhase = "off" | "folding" | "flat" | "on" | "unfolding";

/** Who has the window (`data-taken-by`) while the mini player lasts. */
export const MINI_PLAYER = "mini-player";
export const MINI_PLAYER_ATTR = "data-kd-mini";
/** The playing song's bubble: the mini player is this element and nothing else. */
export const MINI_PLAYER_BUBBLE = '.kd-task[data-kind="playing"]';

/** The page folds on the clock the bar leaves by, and unfolds on the one it returns by. */
const FOLD_MS = MOTION_OUT_MS;
const UNFOLD_MS = MOTION_IN_MS;
/** The bubble gives way to the flat window, and comes back in it (MiniPlayer.css). */
const FLAT_MS = 110;
/** How long the bubble may take to come up and stop changing size once the bar has left. */
const BUBBLE_WAIT_MS = 1500;

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

const wait = (ms: number) => new Promise<void>(resolve => { if (ms > 0) window.setTimeout(resolve, ms); else resolve(); });
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** The bubble once it is up and has kept its box for a few frames, or null if none came. */
async function settledBubble(): Promise<DOMRect | null> {
  const deadline = performance.now() + BUBBLE_WAIT_MS;
  let last: DOMRect | null = null;
  let still = 0;
  while (performance.now() < deadline) {
    await frame();
    const moving = usePlayerBarAway.getState().phase;
    const box = document.querySelector<HTMLElement>(MINI_PLAYER_BUBBLE)?.getBoundingClientRect() ?? null;
    const same = !!box && !!last && Math.abs(box.left - last.left) < 0.5 && Math.abs(box.top - last.top) < 0.5
      && Math.abs(box.width - last.width) < 0.5 && Math.abs(box.height - last.height) < 0.5;
    still = same && moving !== "leaving" && moving !== "returning" ? still + 1 : 0;
    last = box;
    if (box && still >= 4) return box;
  }
  return last;
}

/** Where the page folds to: the bubble if it is up, else the corner it will come up in. */
function aimAt(box: DOMRect | null): void {
  const style = document.documentElement.style;
  style.setProperty("--kd-mini-x", box ? `${box.left + box.width / 2}px` : "calc(100% - 13rem)");
  style.setProperty("--kd-mini-y", box ? `${box.top + box.height / 2}px` : "calc(100% - 5rem)");
}

let switching = false;

/** The whole window again, from whatever step went wrong. */
async function restore(animated: boolean): Promise<void> {
  const bridge = window.kdj?.miniPlayer;
  if (bridge && (await bridge.state().catch(() => null))?.active) await bridge.expand(animated).catch(() => {});
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
    aimAt(document.querySelector<HTMLElement>(MINI_PLAYER_BUBBLE)?.getBoundingClientRect() ?? null);
    setPhase("folding");
    useWindowTaken.getState().take(MINI_PLAYER, () => { void expandFromMiniPlayer(); });
    const [box] = await Promise.all([settledBubble(), wait(animated ? FOLD_MS : 0)]);
    if (!box) throw new Error("no playing song to show");
    setPhase("flat");
    await wait(animated ? FLAT_MS : 0);
    await frame();
    const state = await bridge.collapse({ x: box.left, y: box.top, width: box.width, height: box.height }, animated);
    useMiniPlayer.setState({ onTop: state.onTop });
    setPhase("on");
    await frame();
    await frame();
    await bridge.settle(animated).catch(() => {});
  } catch (error) {
    console.warn("mini player: collapse failed", error);
    await restore(animated);
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
    await bridge.recall(animated).catch(() => {});
    setPhase("flat");
    await wait(animated ? FLAT_MS : 0);
    await frame();
    await bridge.expand(animated);
    // The page lays out for the whole window before it is shown unfolding.
    await frame();
    await frame();
    setPhase("unfolding");
    useWindowTaken.getState().release(MINI_PLAYER);
    await wait(animated ? UNFOLD_MS : 0);
    setPhase("off");
  } catch (error) {
    console.warn("mini player: expand failed", error);
    await restore(animated);
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
