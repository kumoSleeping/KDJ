import { create } from "zustand";
import { prefersReducedMotion } from "./motion";
import { useWindowTaken } from "./windowTaken";

/**
 * The mini player: the whole window taken down to the playing song's bubble, and brought back.
 * It is the same window and the same page, so playback and everything the page holds stay as
 * they are; the window's frame is the native side's (src-tauri/src/mini_player.rs) and what is
 * drawn, and in which order, is decided here.
 *
 * The page is on show all the way. While the window changes size the page keeps the layout of
 * the whole window and is drawn smaller to fit the window as it is at that moment, and the
 * bubble, drawn to fill the window, comes up over it. So the listener watches the window they
 * had become the bubble, and the bubble become that window again; at no point is there an
 * empty window to wait in front of.
 *
 * Down: the bar leaves and the bubble becomes the transport (`readying`, a few frames, enough
 * to know how tall the bubble will be); the window comes down to where the bubble stands
 * (`shrinking`); it is the bubble (`on`) and goes to the place the listener last left it at.
 * Back: it returns to its corner of the whole window, and the window grows (`growing`).
 *
 * Everything drawn during a change of size is a function of the window's width alone and is
 * anchored at the window's top-left corner. A WebView shows its last picture from that corner
 * until the page has drawn for the new size, so a picture that is one frame late is then a
 * frame late and nothing else; anything held to another corner, or to a place on the screen,
 * would be thrown about by however late that frame is.
 *
 * The phase is written on the document element (`data-kd-mini`); MiniPlayer.css draws each.
 * While it lasts the mini player has the window (lib/windowTaken.ts), which is what makes the
 * page inert and sends the bar away.
 */
export type MiniPlayerPhase = "off" | "readying" | "shrinking" | "on" | "growing";

/** Who has the window (`data-taken-by`) while the mini player lasts. */
export const MINI_PLAYER = "mini-player";
export const MINI_PLAYER_ATTR = "data-kd-mini";
/** The playing song's bubble in its stack: the mini player is this element and nothing else. */
export const MINI_PLAYER_BUBBLE = '.kd-task-host > .kd-task-slot > .kd-task[data-kind="playing"]';
const BUBBLE_HOST = '.kd-task-host[data-place="bottom"]';
const PAGE = ".kd-body";

/** How many frames the bubble may take to come up as the transport once the bar is sent away. */
const READY_FRAMES = 15;
/** The gap a bubble keeps to the window's edges (--kd-task-gap), where it cannot be measured. */
const BUBBLE_EDGE = 12;
/**
 * The bubble comes up over the page between these shares of the way down, and goes between
 * them on the way back: the page is whole while the window has hardly moved, and the bubble is
 * whole well before the window is its size.
 */
const BUBBLE_FROM = 0.1;
const BUBBLE_BY = 0.62;

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
const share = (value: number) => Math.min(1, Math.max(0, value));

/** The whole window the mini player came from, in CSS px, and the gap its bubble kept there. */
interface Whole { width: number; height: number; edge: number }
let whole: Whole | null = null;
/** A change of size that is being drawn: the whole window, the bubble's width, the copy of the
 *  bubble that stands in the page meanwhile, and the window width last drawn for. */
let morph: { whole: Whole; bubble: number; ghost: HTMLElement | null; drawn: number } | null = null;

/** The page keeps the whole window's layout from here on, whatever size the window is. */
function keepLayout(of: Whole, bubble: number): void {
  const style = document.documentElement.style;
  style.setProperty("--kd-mini-w", `${of.width}px`);
  style.setProperty("--kd-mini-h", `${of.height}px`);
  style.setProperty("--kd-mini-bw", `${bubble}px`);
}

/**
 * Draws for the window as wide as it is now: the page as small as the window is of the whole
 * one, the bubble as large as fills it. Written on the three elements themselves: a custom
 * property on the root would have every element of the page restyled on every frame.
 */
function follow(): void {
  if (!morph) return;
  const width = window.innerWidth;
  if (width === morph.drawn) return;
  morph.drawn = width;
  const fit = `scale(${(width / morph.whole.width).toFixed(5)})`;
  const page = document.querySelector<HTMLElement>(PAGE);
  if (page) page.style.transform = fit;
  if (morph.ghost) morph.ghost.style.transform = fit;
  const host = document.querySelector<HTMLElement>(BUBBLE_HOST);
  if (!host) return;
  const down = share((morph.whole.width - width) / Math.max(1, morph.whole.width - morph.bubble));
  host.style.setProperty("--kd-mini-bs", (width / morph.bubble).toFixed(5));
  host.style.setProperty("--kd-mini-o", share((down - BUBBLE_FROM) / (BUBBLE_BY - BUBBLE_FROM)).toFixed(3));
}

/** Runs a change of the window's size and keeps the page drawn for every size on the way. */
async function following<T>(change: () => Promise<T>): Promise<T> {
  let live = true;
  const tick = () => {
    if (!live) return;
    follow();
    requestAnimationFrame(tick);
  };
  window.addEventListener("resize", follow);
  requestAnimationFrame(tick);
  try {
    return await change();
  } finally {
    live = false;
    window.removeEventListener("resize", follow);
    follow();
  }
}

/** The change of size is over: the bubble is drawn as it lies, and its copy is gone. */
function endMorph(): void {
  morph?.ghost?.remove();
  morph = null;
  const host = document.querySelector<HTMLElement>(BUBBLE_HOST);
  host?.style.removeProperty("--kd-mini-bs");
  host?.style.removeProperty("--kd-mini-o");
}

/** Nothing of the mini player is left on the page. */
function clearPage(): void {
  endMorph();
  document.querySelector<HTMLElement>(PAGE)?.style.removeProperty("transform");
  for (const name of ["--kd-mini-w", "--kd-mini-h", "--kd-mini-bw"]) document.documentElement.style.removeProperty(name);
}

/**
 * A copy of the bubble that stands in the page, where the bubble is in the whole window, while
 * the bubble itself is drawn to fill the window: the page that shrinks away still has its
 * bubble, and the one that grows back has it where the real one will be. It is a picture: it
 * takes no pointer and no focus and is not read out.
 */
function ghostOf(slot: HTMLElement, at: { left: number; top: number; width: number }): HTMLElement | null {
  const host = slot.parentElement;
  if (!host) return null;
  const ghost = document.createElement("div");
  ghost.className = "kd-mini-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  const copy = slot.cloneNode(true) as HTMLElement;
  Object.assign(copy.style, {
    top: `${at.top}px`, right: "auto", bottom: "auto", left: `${at.left}px`, width: `${at.width}px`,
    transform: "none", opacity: "1",
  });
  // A copied canvas is empty: what the original shows is drawn across.
  const drawn = slot.querySelectorAll("canvas");
  copy.querySelectorAll("canvas").forEach((canvas, index) => {
    try { canvas.getContext("2d")?.drawImage(drawn[index], 0, 0); } catch { /* an empty canvas is the panel colour */ }
  });
  ghost.append(copy);
  host.append(ghost);
  return ghost;
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
async function restore(animated: boolean): Promise<void> {
  const bridge = window.kdj?.miniPlayer;
  if (bridge && (await bridge.state().catch(() => null))?.active) await bridge.expand(animated).catch(() => {});
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
    // Where the bubble stands once the bar is gone: its corner of the whole window.
    const home = { x: box.left, y: Math.max(0, size.height - edge - height), width: box.width, height };
    morph = { whole, bubble: box.width, ghost: ghostOf(slot, box), drawn: Number.NaN };
    keepLayout(whole, box.width);
    setPhase("shrinking");
    follow();
    // The page is drawn once as the picture it is from here on before the window moves.
    await frame();
    await frame();
    const state = await following(() => bridge.collapse(home, animated));
    useMiniPlayer.setState({ onTop: state.onTop });
    setPhase("on");
    endMorph();
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
    const slot = document.querySelector<HTMLElement>(MINI_PLAYER_BUBBLE)?.parentElement;
    if (slot && whole) {
      const box = slot.getBoundingClientRect();
      // The page is under the bubble again, with a copy of the bubble where it is going to be.
      const ghost = ghostOf(slot, { left: whole.width - whole.edge - box.width, top: whole.height - whole.edge - box.height, width: box.width });
      // The copy is the bubble of the whole window: without the key only the mini player has.
      ghost?.querySelector('[data-task-action="mini-top"]')?.remove();
      morph = { whole, bubble: box.width, ghost, drawn: Number.NaN };
      keepLayout(whole, box.width);
      setPhase("growing");
      follow();
      await frame();
      await frame();
    }
    await following(() => bridge.expand(animated));
    // The page lays out for the window as it is now before it is its own size again.
    await frame();
    await frame();
    clearPage();
    setPhase("off");
    useWindowTaken.getState().release(MINI_PLAYER);
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
  if (state.fullWidth && state.fullHeight) {
    whole = { width: state.fullWidth, height: state.fullHeight, edge: BUBBLE_EDGE };
    keepLayout(whole, window.innerWidth);
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
