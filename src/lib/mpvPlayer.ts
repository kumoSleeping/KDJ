/**
 * The libmpv video window (src-tauri/src/mpv_player.rs) as a controller for VideoPipHost.
 *
 * mpv draws in a native view under the page at the rectangle given here, and the page leaves a
 * hole there (videoHoles.ts), so controls drawn outside #root show over the picture. The build
 * may not carry libmpv at all (tauri.mpv.conf.json bundles it): then `mpvAvailable()` stays
 * false and VideoPipHost keeps its WebView `<video>` player.
 */
import { useEffect, useState } from "react";
import { getBridge } from "./bridge";
import { tracePlayback } from "./playbackTrace";
import { createVideoHole } from "./videoHoles";
import { useAppStore } from "../stores/appStore";
import type { MpvAvailability, MpvPlaybackStatus } from "../types";

let availability: MpvAvailability | null = null;
let availabilityRequest: Promise<MpvAvailability> | null = null;
const availabilityListeners = new Set<() => void>();

function unavailable(error: string): MpvAvailability {
  return { available: false, version: null, error };
}

/** Asks the shell once whether libmpv could be loaded. */
export function loadMpvAvailability(): Promise<MpvAvailability> {
  if (availabilityRequest) return availabilityRequest;
  let mpv: ReturnType<typeof getBridge>["mpv"];
  try {
    mpv = getBridge().mpv;
  } catch {
    // The bridge is not up yet: ask again next time.
    return Promise.resolve(unavailable("桥接尚未就绪"));
  }
  availabilityRequest = (mpv ? mpv.status() : Promise.resolve(unavailable("当前系统没有 mpv 视频窗口")))
    .catch((error: unknown) => unavailable(error instanceof Error ? error.message : String(error)))
    .then(result => {
      availability = result;
      tracePlayback("mpv-available", { available: result.available ? 1 : 0, error: result.error });
      for (const listener of availabilityListeners) listener();
      return result;
    });
  return availabilityRequest;
}

export function mpvAvailable(): boolean {
  return availability?.available === true;
}

export function useMpvAvailable(): boolean {
  const [available, setAvailable] = useState(mpvAvailable);
  useEffect(() => {
    const update = () => setAvailable(mpvAvailable());
    availabilityListeners.add(update);
    void loadMpvAvailability().then(update);
    return () => { availabilityListeners.delete(update); };
  }, []);
  return available;
}

/**
 * macOS (the shell offers mpv): the WebView video players are switched off for now — their code
 * stays — and every video plays in mpv. A video mpv cannot play shows its error; nothing falls
 * back to a `<video>`. Other systems keep the WebView players until mpv is wired there.
 */
export function webVideoOff(): boolean {
  try {
    return Boolean(getBridge().mpv);
  } catch {
    return false;
  }
}

/** The video window uses mpv: always on macOS, else when the build carries it and the setting allows. */
export function prefersMpv(): boolean {
  return webVideoOff() || (mpvAvailable() && (useAppStore.getState().settings?.video_player ?? "mpv") === "mpv");
}

export interface MpvBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The slot's rectangle, and whether all of it can be seen: a native view is not clipped by the
 * page, so a slot scrolled partly out of its panel hides the picture instead of overlapping
 * what is around it.
 */
export function nativeSlotBounds(node: HTMLElement): { bounds: MpvBounds; visible: boolean } {
  const rect = node.getBoundingClientRect();
  const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  let visible = rect.width >= 40 && rect.height >= 24 && rect.top >= -1 && rect.left >= -1
    && rect.bottom <= window.innerHeight + 1 && rect.right <= window.innerWidth + 1;
  for (let parent = node.parentElement; visible && parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const clip = parent.getBoundingClientRect();
    visible = rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1
      && rect.left >= clip.left - 1 && rect.right <= clip.right + 1;
  }
  return { bounds, visible };
}

/** What can open over a picture inside the page: menus, sheets, dialogs, other floating windows. */
const COVERING = ".kd-context-menu, .kd-sheet, [role='dialog'], [role='menu'], [role='listbox'], .kd-pip-float";

/**
 * Whether something of the page lies over a slot inside #root. The hole there cuts it away
 * (hit testing too, so this compares rectangles): the caller hides its picture instead.
 */
export function pageCovers(bounds: MpvBounds, slot: HTMLElement): boolean {
  for (const element of document.querySelectorAll<HTMLElement>(COVERING)) {
    // The slot's own frame, and what draws over pictures from outside #root.
    if (element.contains(slot) || !document.getElementById("root")?.contains(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.left < bounds.x + bounds.width && rect.right > bounds.x
      && rect.top < bounds.y + bounds.height && rect.bottom > bounds.y) return true;
  }
  return false;
}

/**
 * Follows a slot inside #root (a panel's video): its rectangle, and whether a picture may show
 * there (all of it in sight, nothing of the page over it). Calls `onPlace` when either changes,
 * while the panel scrolls, resizes, moves, or a menu opens. Returns the stop.
 */
export function trackNativeSlot(slot: HTMLElement, onPlace: (bounds: MpvBounds, visible: boolean) => void): () => void {
  let last = "";
  let frame = 0;
  const place = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const placed = nativeSlotBounds(slot);
      const { bounds } = placed;
      // A menu, sheet or other window over the slot would be cut by the hole: the picture is
      // hidden (the black frame shows) while it is there.
      const visible = placed.visible && !pageCovers(bounds, slot);
      const next = `${bounds.x},${bounds.y},${bounds.width},${bounds.height},${visible}`;
      if (next === last) return;
      last = next;
      onPlace(bounds, visible);
    });
  };
  const observer = new ResizeObserver(place);
  for (let node: HTMLElement | null = slot; node; node = node.parentElement) observer.observe(node);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
  // Menus and sheets open on these; look again at once rather than at the next poll.
  const soon = () => window.setTimeout(place, 0);
  const types = ["pointerdown", "pointerup", "contextmenu", "keydown"];
  for (const type of types) window.addEventListener(type, soon, true);
  // A sibling growing above the panel moves the slot without resizing anything watched.
  const poll = window.setInterval(place, 250);
  place();
  return () => {
    cancelAnimationFrame(frame);
    window.clearInterval(poll);
    observer.disconnect();
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, true);
    for (const type of types) window.removeEventListener(type, soon, true);
  };
}

/**
 * Holds a progress bar on the spot the user jumped to. A local video's jump goes to the song
 * first and the picture follows its clock, so for a moment mpv still reports the old spot.
 */
export class SeekHold {
  private target: number | null = null;
  private until = 0;

  set(target: number): void {
    this.target = target;
    this.until = performance.now() + 1500;
  }

  /** Whether a reported position may be shown; the hold ends once mpv is near the target. */
  accept(position: number): boolean {
    if (this.target === null) return true;
    if (Math.abs(position - this.target) < 0.5 || performance.now() > this.until) {
      this.target = null;
      return true;
    }
    return false;
  }
}

export interface MpvClock {
  position: number;
  rate: number;
  playing: boolean;
}

export interface MpvVideoOptions {
  /** A loopback URL of KDJ's server, or the promise of one (YouTube prepares its HLS first). */
  url: string | Promise<string>;
  /** Picture only, following KDJ's audio clock through `follow()`. */
  follow: boolean;
  bounds: MpvBounds;
  volume: number;
  start?: number;
  paused: boolean;
  onStatus: (status: MpvPlaybackStatus) => void;
  onError: (error: Error) => void;
  /** Called once when the controller is disposed (YouTube revokes its HLS session). */
  release?: () => Promise<void>;
  /** The hole this picture shows through: its corner radius, or false when the caller cuts one
   * hole for several pictures (a project's clips). */
  hole?: { radius?: number } | false;
  /** Opacity of the picture (a project's fades) and its order among pictures, lowest first. */
  opacity?: number;
  layer?: number;
  crop?: string;
  stretch?: boolean;
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** One mpv playback; `dispose()` closes the native view. */
export class MpvVideoController {
  readonly done: Promise<void>;
  private generation: number | null = null;
  private disposed = false;
  private paused: boolean;
  private bounds: MpvBounds;
  private visible = true;
  private volume: number;
  private unlisten: (() => void) | null = null;
  /** The clock sent last, to send only what mpv could not have predicted from it. */
  private lastClock: (MpvClock & { at: number }) | null | undefined = undefined;
  private readonly options: MpvVideoOptions;
  private readonly hole: ReturnType<typeof createVideoHole> | null;
  private opacity: number;
  private radius: number | undefined;
  private layer: number;

  constructor(options: MpvVideoOptions) {
    this.options = options;
    this.paused = options.paused;
    this.bounds = options.bounds;
    this.volume = options.volume;
    this.opacity = options.opacity ?? 1;
    this.layer = options.layer ?? 0;
    this.hole = options.hole === false ? null : createVideoHole();
    this.radius = options.hole ? options.hole.radius : undefined;
    this.done = this.open();
    this.done.catch((reason: unknown) => {
      const error = asError(reason);
      if (error.name !== "AbortError") tracePlayback("mpv-open-failed", { error: error.message });
      this.dispose();
    });
  }

  private async open(): Promise<void> {
    const { options } = this;
    const mpv = getBridge().mpv;
    if (!mpv) throw new Error("当前系统没有 mpv 视频窗口");
    const url = await options.url;
    if (this.disposed) throw new DOMException("mpv playback disposed", "AbortError");
    this.unlisten = mpv.onStatus(status => {
      if (this.disposed || status.generation !== this.generation) return;
      if (status.error) tracePlayback("mpv-error", { generation: status.generation, error: status.error });
      if (status.error) options.onError(new Error(status.error));
      else options.onStatus(status);
    });
    // Bounds and volume that change while it opens are pushed once it is open.
    const generation = await mpv.open({
      url,
      follow: options.follow,
      ...options.bounds,
      volume: options.volume,
      start: Math.max(0, options.start ?? 0),
      paused: options.paused,
      crop: options.crop,
      stretch: options.stretch,
    });
    this.generation = generation;
    tracePlayback("mpv-open", { generation, follow: options.follow ? 1 : 0 });
    if (this.disposed) {
      void mpv.close(generation).catch(() => undefined);
      throw new DOMException("mpv playback disposed", "AbortError");
    }
    await this.pushBounds();
    if (this.volume !== options.volume) await mpv.control(generation, "volume", this.volume);
    if (!this.paused && !options.follow) await mpv.control(generation, "play");
  }

  private async pushBounds(): Promise<void> {
    const mpv = getBridge().mpv;
    if (!mpv || this.generation === null || this.disposed) return;
    this.hole?.set(this.visible ? { ...this.bounds, radius: this.radius } : null);
    await mpv.setBounds({
      generation: this.generation, ...this.bounds, visible: this.visible, opacity: this.opacity, layer: this.layer,
    });
  }

  private async control(action: "play" | "pause" | "seek" | "volume", value?: number): Promise<void> {
    await this.done;
    const mpv = getBridge().mpv;
    if (!mpv || this.generation === null || this.disposed) return;
    await mpv.control(this.generation, action, value);
  }

  play(): Promise<void> {
    this.paused = false;
    return this.control("play");
  }

  pause(): Promise<void> {
    this.paused = true;
    return this.control("pause");
  }

  seek(position: number): Promise<void> {
    return this.control("seek", position);
  }

  setVolume(volume: number): Promise<void> {
    this.volume = volume;
    return this.control("volume", volume);
  }

  /** `radius`: the corner radius of the hole, when the box around the picture is rounded. */
  setBounds(bounds: MpvBounds, visible = true, radius?: number): Promise<void> {
    this.bounds = bounds;
    this.visible = visible;
    if (radius !== undefined) this.radius = radius;
    return this.pushBounds();
  }

  /** A project clip's opacity and stacking. */
  setLook(opacity: number, layer: number): Promise<void> {
    if (opacity === this.opacity && layer === this.layer) return Promise.resolve();
    this.opacity = opacity;
    this.layer = layer;
    return this.pushBounds();
  }

  /** The audio clock to follow; null holds the picture where it is. */
  follow(clock: MpvClock | null): void {
    const mpv = getBridge().mpv;
    if (!mpv || this.generation === null || this.disposed) return;
    // The clock updates many times a second. mpv extrapolates it by itself, so a new sample is
    // sent only when transport or rate changed, it left the extrapolation by 20 ms, or once a second.
    const now = performance.now();
    const last = this.lastClock;
    if (last !== undefined && (last === null) === (clock === null)) {
      if (!clock || !last) return;
      const predicted = last.position + (last.playing ? (now - last.at) / 1000 * last.rate : 0);
      if (clock.playing === last.playing && Math.abs(clock.rate - last.rate) < 1e-3
        && Math.abs(clock.position - predicted) < 0.02 && now - last.at < 1000) return;
    }
    this.lastClock = clock ? { ...clock, at: now } : null;
    void mpv.follow(this.generation, clock ? clock.position : null, clock?.rate ?? 1, clock?.playing ?? false)
      .catch(() => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    this.hole?.dispose();
    const mpv = getBridge().mpv;
    if (mpv && this.generation !== null) void mpv.close(this.generation).catch(() => undefined);
    void this.options.release?.().catch((reason: unknown) => console.warn(asError(reason).message));
  }
}
