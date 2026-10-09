/**
 * How the floating media window arrives, leaves and changes song.
 *
 * It comes in across the viewport edge it is nearest to and leaves the same way. On a song
 * change the old picture leaves first and the new one then comes out of that same edge, on the
 * clock every surface of the playing song shares (see songSwapMotion.ts), so the window and the
 * 曲目信息 panel move as one.
 *
 * Presentation only. A window is moved by an animation on its own box; its media elements are
 * never remounted, resized or re-timed here, and nothing waits on this module. The picture
 * that leaves is one still copy (a "ghost"), never a second decoder. There is at most one
 * ghost and one entrance at any time; a newer song restarts the wait, it never stacks.
 */

import {
  FLOAT_MEDIA_CHROME_FALLBACK,
  planFloatSlide,
  type FloatOffset,
  type FloatRect,
  type FloatViewport,
} from "./floatingMediaBox";
import { getPlayingTrack, subscribePlayingTrack } from "./playingTrack";
import { copyPictureFrame, prefersReducedSeekMotion } from "./seekTransition";
import {
  SONG_SWAP_IN_EASE,
  SONG_SWAP_IN_MS,
  SONG_SWAP_OUT_EASE,
  SONG_SWAP_OUT_MS,
  setSongSurfacePresent,
  songSwapEntranceDelay,
} from "./songSwapMotion";

/** One window that can occupy the shared box. Its owner keeps the fields current while shown. */
export interface FloatingMediaPresenter {
  element: HTMLElement | null;
  /** Resting place of the window, without any transform. */
  rect: FloatRect;
  /** False where an animation cannot carry the picture (fullscreen, a native platform embed). */
  animate: boolean;
  ghostClass: string;
  title: string;
  /** The library track whose picture this is, when the window follows the playing song. */
  song: number | null;
  /** The element whose current frame is the window's picture. */
  picture(): HTMLVideoElement | HTMLCanvasElement | null;
}

interface Ghost {
  node: HTMLElement;
  owner: FloatingMediaPresenter;
  /** Which song's picture this is. */
  key: string;
  home: FloatRect;
  animation: Animation | null;
  startedAt: number;
  expiry: number;
}

/** What a window looked like when it was last asked for. */
interface Still {
  picture: HTMLCanvasElement | null;
  /** A lifeless copy of the window's own stage (caption, empty state), when it could be read. */
  stage: HTMLElement | null;
}

interface Showing {
  key: string;
  title: string;
}

interface Entrance {
  owner: FloatingMediaPresenter;
  animation: Animation;
  /** Until then the window waits out of sight for what is leaving. */
  revealAt: number;
}

const SURFACE = "float-window";
const SUPERSEDED = "data-float-superseded";
const NO_OFFSET: FloatOffset = { x: 0, y: 0 };
const FADE_MS = 140;
const PRESERVED_FOR_MS = 250;
/** A window that arrives with a new song is not something that song has to wait for. */
const NEWCOMER_QUIET_MS = 80;

/** The app's top chrome: window controls, history and the global actions live there. */
export function floatChromeElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".kd-app-chrome");
}

/**
 * The area a floating media window may occupy: the viewport below the top chrome. The chrome is
 * measured where it is drawn, since its height differs between platforms and theme packs.
 */
export function measureFloatViewport(): FloatViewport {
  const chrome = floatChromeElement();
  const bottom = chrome?.getBoundingClientRect().bottom;
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    top: Math.round(bottom && bottom > 0 ? bottom : FLOAT_MEDIA_CHROME_FALLBACK),
  };
}

function translate(offset: FloatOffset): string {
  return `translate(${offset.x}px, ${offset.y}px)`;
}

function currentOffset(element: HTMLElement | null): FloatOffset {
  if (!element?.isConnected) return NO_OFFSET;
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") return NO_OFFSET;
  const matrix = new DOMMatrixReadOnly(transform);
  return { x: matrix.m41, y: matrix.m42 };
}

/** Copies markup only: no media element is ever cloned, so nothing starts loading or decoding. */
function cloneStill(node: Element): Element | null {
  if (node instanceof HTMLMediaElement || node instanceof HTMLCanvasElement || node instanceof HTMLIFrameElement) return null;
  if (node.classList.contains("kd-pip-resize")) return null;
  const copy = node.cloneNode(false) as Element;
  copy.removeAttribute("id");
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) copy.append(child.cloneNode(false));
    else if (child instanceof Element) {
      const still = cloneStill(child);
      if (still) copy.append(still);
    }
  }
  return copy;
}

function startNow(animation: Animation, element: HTMLElement): void {
  // This presentation frame, not a later pending Web Animations play task.
  const time = element.ownerDocument.timeline?.currentTime;
  if (typeof time === "number") animation.startTime = time;
}

class FloatingMediaMotion {
  private readonly shown = new Map<FloatingMediaPresenter, Showing>();
  private readonly superseded = new Set<FloatingMediaPresenter>();
  private ghost: Ghost | null = null;
  private entrance: Entrance | null = null;
  private preserved: { owner: FloatingMediaPresenter; still: Still; at: number } | null = null;
  private leaving: { presenter: FloatingMediaPresenter; offset: FloatOffset; still: Still | null } | null = null;
  /** The last change of the playing song, and what was on screen to leave at that moment. */
  private songChange: { at: number; wait: number } | null = null;
  private quietUntil = 0;
  private quietTimer = 0;
  private recoverTimer = 0;

  constructor() {
    let playing = getPlayingTrack()?.id ?? null;
    subscribePlayingTrack(() => {
      const next = getPlayingTrack()?.id ?? null;
      if (next === playing) return;
      playing = next;
      this.songChange = { at: performance.now(), wait: songSwapEntranceDelay() };
    });
  }

  /** A window appeared in the shared box, showing `key`. */
  show(presenter: FloatingMediaPresenter, key: string): void {
    const element = presenter.element;
    if (!element) return;
    const leaving = this.leaving;
    if (leaving?.presenter === presenter && this.shown.get(presenter)?.key === key) {
      // Taken down and put back within one turn (React re-running a mount): nothing happened.
      this.leaving = null;
      return;
    }
    this.commitHide();
    if (this.superseded.delete(presenter)) element.removeAttribute(SUPERSEDED);
    const others = [...this.shown.keys()].filter(other => other !== presenter);
    const wasPresent = this.ghost !== null || others.some(other => other.animate);
    // Read before this window counts as present itself.
    let hold = this.songWait(presenter);
    this.shown.set(presenter, { key, title: presenter.title });
    const ghost = this.ghost;
    if (!presenter.animate || typeof element.animate !== "function") {
      if (ghost?.owner === presenter) this.removeGhost();
      this.publishPresence();
      return;
    }
    if (ghost && ghost.owner === presenter && ghost.key === key) {
      // The same picture came back before it had left: return along the way it was going.
      const rect = ghost.node.getBoundingClientRect();
      this.removeGhost();
      this.arrive(presenter, 0, { x: rect.left - presenter.rect.x, y: rect.top - presenter.rect.y });
      this.publishPresence();
      return;
    }
    if (ghost) {
      // The previous picture is on its way out: come out once it has gone.
      hold = Math.max(hold, SONG_SWAP_OUT_MS - (performance.now() - ghost.startedAt));
    } else if (others[0]) {
      // The new window mounted before the old one was taken down: its picture leaves now.
      const other = others[0];
      const showing = this.shown.get(other)!;
      const still = this.capture(other, true);
      this.shown.delete(other);
      this.superseded.add(other);
      other.element?.setAttribute(SUPERSEDED, "");
      this.ghost = this.buildGhost(other, showing, still, NO_OFFSET);
      this.leave(this.ghost);
      hold = Math.max(hold, SONG_SWAP_OUT_MS);
    }
    // Arriving alone for a song that is only now becoming the playing one: let the others
    // of that song arrive with it instead of waiting for this entrance as if it were an exit.
    if (!wasPresent && hold === 0 && this.arrivesWithSong(presenter)) {
      this.quietUntil = performance.now() + NEWCOMER_QUIET_MS;
      window.clearTimeout(this.quietTimer);
      this.quietTimer = window.setTimeout(() => this.publishPresence(), NEWCOMER_QUIET_MS);
    }
    this.arrive(presenter, Math.max(0, hold));
    this.publishPresence();
  }

  /** The window left the shared box. Its last picture leaves on its behalf. */
  hide(presenter: FloatingMediaPresenter): void {
    this.commitHide();
    if (this.superseded.delete(presenter)) {
      presenter.element?.removeAttribute(SUPERSEDED);
      return;
    }
    if (!this.shown.has(presenter)) return;
    // Read the window now, while it is still in the document. What follows waits for the end
    // of the turn, so that a `show` of the very same window can still call it off.
    const preserved = this.takePreserved(presenter);
    this.leaving = {
      presenter,
      offset: this.entrance?.owner === presenter ? currentOffset(presenter.element) : NO_OFFSET,
      still: presenter.animate ? preserved ?? this.capture(presenter, true) : null,
    };
    queueMicrotask(() => this.commitHide());
  }

  private commitHide(): void {
    const leaving = this.leaving;
    if (!leaving) return;
    this.leaving = null;
    const { presenter, offset, still } = leaving;
    const showing = this.shown.get(presenter);
    if (!showing) return;
    this.shown.delete(presenter);
    let inSight = true;
    if (this.entrance?.owner === presenter) {
      inSight = performance.now() >= this.entrance.revealAt;
      this.cancelEntrance();
    }
    // A window that had not come out yet has nothing to take away; what was leaving goes on.
    if (inSight) {
      this.removeGhost();
      if (still && typeof document.body.animate === "function") {
        this.ghost = this.buildGhost(presenter, showing, still, offset);
        this.leave(this.ghost);
      }
    }
    this.publishPresence();
  }

  /** The same window now shows another song: the old picture leaves, then the new one comes out. */
  swap(presenter: FloatingMediaPresenter, key: string): void {
    this.commitHide();
    const previous = this.shown.get(presenter);
    const element = presenter.element;
    if (!previous || !element) return;
    this.shown.set(presenter, { key, title: presenter.title });
    if (!presenter.animate || typeof element.animate !== "function") {
      this.settle();
      return;
    }
    const entrance = this.entrance?.owner === presenter ? this.entrance : null;
    if (entrance && performance.now() < entrance.revealAt) {
      // Still out of sight from the last change: the newest song takes the turn, and the wait
      // starts over, exactly as it does for the panel.
      this.arrive(presenter, SONG_SWAP_OUT_MS);
      return;
    }
    const offset = entrance ? currentOffset(element) : NO_OFFSET;
    this.cancelEntrance();
    this.removeGhost();
    // The box already carries the new song's caption; only its picture is still the old one.
    const still = this.takePreserved(presenter) ?? this.capture(presenter, false);
    this.ghost = this.buildGhost(presenter, previous, still, offset);
    this.leave(this.ghost);
    this.arrive(presenter, SONG_SWAP_OUT_MS);
    this.publishPresence();
  }

  /** Copy the picture now, for a `hide` that follows a teardown of the media in the same turn. */
  preserve(presenter: FloatingMediaPresenter): void {
    this.commitHide();
    if (!this.shown.has(presenter) || !presenter.animate) return;
    this.preserved = { owner: presenter, still: this.capture(presenter, true), at: performance.now() };
  }

  /** End every motion where it would have ended. The hand takes over. */
  settle(): void {
    this.commitHide();
    this.cancelEntrance();
    this.removeGhost();
    this.publishPresence();
  }

  /** Whether the window shows a song the player is only about to announce as playing. */
  private arrivesWithSong(presenter: FloatingMediaPresenter): boolean {
    return presenter.song !== null && presenter.song !== (getPlayingTrack()?.id ?? null);
  }

  /** How long an entrance waits for what the song change still has to take away. */
  private songWait(presenter: FloatingMediaPresenter): number {
    const change = this.songChange;
    const remaining = change ? change.at + change.wait - performance.now() : 0;
    return Math.max(0, remaining, this.arrivesWithSong(presenter) ? songSwapEntranceDelay() : 0);
  }

  /** On screen from the start of an entrance until the last exit has finished. */
  private publishPresence(): void {
    const settled = performance.now() >= this.quietUntil;
    setSongSurfacePresent(SURFACE, this.ghost !== null
      || (settled && [...this.shown.keys()].some(presenter => presenter.animate)));
  }

  private capture(presenter: FloatingMediaPresenter, withStage: boolean): Still {
    let picture: HTMLCanvasElement | null = null;
    try {
      const source = presenter.picture();
      picture = source ? copyPictureFrame(source) : null;
    } catch {
      picture = null;
    }
    // Only a box that still is the window can be copied; a host that has already been
    // re-rendered into something else contributes its picture alone.
    const box = presenter.element;
    const live = withStage && box?.isConnected && box.classList.contains("kd-pip-float")
      ? box.querySelector(":scope > .kd-pip-float-stage") : null;
    return { picture, stage: live ? cloneStill(live) as HTMLElement | null : null };
  }

  private takePreserved(presenter: FloatingMediaPresenter): Still | null {
    const preserved = this.preserved;
    this.preserved = null;
    return preserved && preserved.owner === presenter && performance.now() - preserved.at < PRESERVED_FOR_MS
      ? preserved.still : null;
  }

  private buildGhost(owner: FloatingMediaPresenter, showing: Showing, still: Still, offset: FloatOffset): Ghost {
    const node = document.createElement("div");
    node.className = `${owner.ghostClass} kd-float-ghost`;
    node.setAttribute("aria-hidden", "true");
    node.inert = true;
    const rect = owner.rect;
    Object.assign(node.style, {
      left: `${rect.x + offset.x}px`, top: `${rect.y + offset.y}px`, width: `${rect.w}px`, height: `${rect.h}px`,
    });
    let stage = still.stage;
    if (!stage) {
      stage = document.createElement("div");
      stage.className = "kd-pip-float-stage";
      if (showing.title) {
        // Themes that keep the caption on screen keep it on the leaving picture too.
        const chrome = document.createElement("div");
        chrome.className = "kd-pip-float-chrome";
        const top = document.createElement("div");
        top.className = "kd-pip-float-top";
        const label = document.createElement("span");
        label.className = "kd-truncate";
        label.textContent = showing.title;
        top.append(label);
        chrome.append(top);
        stage.append(chrome);
      }
    }
    if (still.picture) {
      still.picture.className = "kd-float-ghost-picture";
      stage.prepend(still.picture);
    }
    node.append(stage);
    document.body.append(node);
    return { node, owner, key: showing.key, home: rect, animation: null, startedAt: performance.now(), expiry: 0 };
  }

  private removeGhost(): void {
    const ghost = this.ghost;
    if (!ghost) return;
    this.ghost = null;
    window.clearTimeout(ghost.expiry);
    if (ghost.animation) {
      ghost.animation.onfinish = null;
      ghost.animation.cancel();
    }
    ghost.node.remove();
    // A window that was covered by its ghost is normally taken down by its owner in the same
    // turn. Should it still be there, it must not stay invisible.
    if (this.superseded.size && !this.recoverTimer) {
      this.recoverTimer = window.setTimeout(() => {
        this.recoverTimer = 0;
        for (const presenter of this.superseded) {
          presenter.element?.removeAttribute(SUPERSEDED);
          this.shown.set(presenter, { key: "", title: presenter.title });
        }
        this.superseded.clear();
      }, 400);
    }
  }

  private cancelEntrance(): void {
    const entrance = this.entrance;
    if (!entrance) return;
    this.entrance = null;
    entrance.animation.onfinish = null;
    entrance.animation.cancel();
  }

  /** The window comes out of its nearest edge, after waiting `hold` ms out of sight. */
  private arrive(presenter: FloatingMediaPresenter, hold: number, from?: FloatOffset): void {
    const element = presenter.element!;
    this.cancelEntrance();
    let animation: Animation;
    if (prefersReducedSeekMotion()) {
      // No travel and no wait. Over a leaving picture the cross-fade is that picture's.
      if (this.ghost) return;
      animation = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out" });
      hold = 0;
    } else {
      const start = translate(from ?? planFloatSlide(presenter.rect, measureFloatViewport()).offset);
      const rest = translate(NO_OFFSET);
      const duration = hold + SONG_SWAP_IN_MS;
      // While it waits the window stays in its place, unseen, so its video keeps a real
      // on-screen box to decode into; then it jumps outside the edge and slides in.
      animation = element.animate(hold > 0 ? [
        { offset: 0, opacity: 0, transform: rest, easing: "step-end" },
        { offset: hold / duration, opacity: 1, transform: start, easing: SONG_SWAP_IN_EASE },
        { offset: 1, opacity: 1, transform: rest },
      ] : [
        { transform: start, easing: SONG_SWAP_IN_EASE },
        { transform: rest },
      ], { duration, fill: "backwards" });
    }
    startNow(animation, element);
    this.entrance = { owner: presenter, animation, revealAt: performance.now() + hold };
    animation.onfinish = () => { if (this.entrance?.animation === animation) this.entrance = null; };
  }

  /** The still picture goes out across the nearest edge of the place its window rested in. */
  private leave(ghost: Ghost): void {
    let duration = SONG_SWAP_OUT_MS;
    if (prefersReducedSeekMotion()) {
      duration = FADE_MS;
      ghost.animation = ghost.node.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: "ease-in", fill: "forwards" });
    } else {
      const at = ghost.node.getBoundingClientRect();
      const slide = planFloatSlide({ x: at.left, y: at.top, w: at.width, h: at.height }, measureFloatViewport(), ghost.home);
      ghost.animation = ghost.node.animate(
        [{ transform: translate(NO_OFFSET) }, { transform: translate(slide.offset) }],
        { duration, easing: SONG_SWAP_OUT_EASE, fill: "forwards" },
      );
    }
    startNow(ghost.animation, ghost.node);
    ghost.startedAt = performance.now();
    const done = () => {
      if (this.ghost !== ghost) return;
      this.removeGhost();
      this.publishPresence();
    };
    ghost.animation.onfinish = done;
    // A hidden or throttled page must not keep a still picture on screen.
    ghost.expiry = window.setTimeout(done, duration + 600);
  }
}

export const floatingMediaMotion = new FloatingMediaMotion();
