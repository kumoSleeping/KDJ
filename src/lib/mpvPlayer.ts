/**
 * The libmpv video window (src-tauri/src/mpv_player.rs) as a controller for VideoPipHost.
 *
 * mpv draws in a native view laid over the page at the rectangle given here; HTML cannot draw
 * over it, so the floating window keeps its controls above and below that rectangle. The build
 * may not carry libmpv at all (tauri.mpv.conf.json bundles it): then `mpvAvailable()` stays
 * false and VideoPipHost keeps its WebView `<video>` player.
 */
import { useEffect, useState } from "react";
import { getBridge } from "./bridge";
import { tracePlayback } from "./playbackTrace";
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

/** The video window uses mpv when the build carries it and the setting has not turned it off. */
export function prefersMpv(): boolean {
  return mpvAvailable() && (useAppStore.getState().settings?.video_player ?? "mpv") === "mpv";
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

  constructor(options: MpvVideoOptions) {
    this.options = options;
    this.paused = options.paused;
    this.bounds = options.bounds;
    this.volume = options.volume;
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
    await mpv.setBounds({ generation: this.generation, ...this.bounds, visible: this.visible });
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

  setBounds(bounds: MpvBounds, visible = true): Promise<void> {
    this.bounds = bounds;
    this.visible = visible;
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
    const mpv = getBridge().mpv;
    if (mpv && this.generation !== null) void mpv.close(this.generation).catch(() => undefined);
    void this.options.release?.().catch((reason: unknown) => console.warn(asError(reason).message));
  }
}
