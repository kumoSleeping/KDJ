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
  private readonly options: MpvVideoOptions;

  constructor(options: MpvVideoOptions) {
    this.options = options;
    this.paused = options.paused;
    this.bounds = options.bounds;
    this.volume = options.volume;
    this.done = this.open();
    this.done.catch(() => this.dispose());
  }

  private async open(): Promise<void> {
    const { options } = this;
    const mpv = getBridge().mpv;
    if (!mpv) throw new Error("当前系统没有 mpv 视频窗口");
    const url = await options.url;
    if (this.disposed) throw new DOMException("mpv playback disposed", "AbortError");
    this.unlisten = mpv.onStatus(status => {
      if (this.disposed || status.generation !== this.generation) return;
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
