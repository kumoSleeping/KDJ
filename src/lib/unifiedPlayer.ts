import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  addStateListener,
  dispose,
  getState,
  initialize,
  pause,
  play,
  seekTo,
  setQueue as setNativeQueue,
  setRate,
  setSource,
  setVolume,
  type NativeAudioState,
} from "tauri-plugin-native-audio-api";
import type { Track } from "../types";
import { djEngine } from "./djMix";

export type UnifiedPlayerStatus = "idle" | "loading" | "paused" | "playing" | "ended" | "error";
export type UnifiedPlayerKind = "desktop-native" | "mobile-native" | "browser-preview";

export interface UnifiedPlayerState {
  trackId: number | null;
  preparedTrackId: number | null;
  status: UnifiedPlayerStatus;
  currentTime: number;
  duration: number;
  playing: boolean;
  buffering: boolean;
  transitioning: boolean;
  rate: number;
  error: string;
}

export interface UnifiedTransitionPlan {
  eq: boolean;
  filter: boolean;
  vocalCut: boolean;
  echo: boolean;
  alarm: boolean;
  hydrant: boolean;
  beatSeconds: number;
}

export interface UnifiedPlayerSource {
  src: string;
  track: Track;
  artworkUrl?: string;
  position?: number;
  rate?: number;
  autoplay?: boolean;
}

export interface UnifiedPlayer {
  readonly kind: UnifiedPlayerKind;
  readonly supportsRealtimeDj: boolean;
  initialize(): Promise<UnifiedPlayerState>;
  load(source: UnifiedPlayerSource): Promise<UnifiedPlayerState>;
  prepare(source: UnifiedPlayerSource): Promise<UnifiedPlayerState>;
  handoff(
    trackId: number,
    position: number,
    seconds: number,
    plan?: UnifiedTransitionPlan,
  ): Promise<UnifiedPlayerState>;
  setQueue(sources: UnifiedPlayerSource[]): Promise<UnifiedPlayerState>;
  play(): Promise<UnifiedPlayerState>;
  pause(): Promise<UnifiedPlayerState>;
  seek(seconds: number): Promise<UnifiedPlayerState>;
  setRate(rate: number): Promise<UnifiedPlayerState>;
  setVolume(volume: number): Promise<UnifiedPlayerState>;
  setEq(lowDb: number, highDb: number): Promise<UnifiedPlayerState>;
  state(): UnifiedPlayerState;
  refresh(): Promise<UnifiedPlayerState>;
  subscribe(listener: (state: UnifiedPlayerState, previous: UnifiedPlayerState) => void): () => void;
  dispose(): Promise<void>;
}

const INITIAL_STATE: UnifiedPlayerState = {
  trackId: null,
  preparedTrackId: null,
  status: "idle",
  currentTime: 0,
  duration: 0,
  playing: false,
  buffering: false,
  transitioning: false,
  rate: 1,
  error: "",
};

abstract class PlayerStateOwner {
  protected snapshot: UnifiedPlayerState = INITIAL_STATE;
  protected listeners = new Set<
    (state: UnifiedPlayerState, previous: UnifiedPlayerState) => void
  >();

  protected publish(next: UnifiedPlayerState): UnifiedPlayerState {
    const previous = this.snapshot;
    if (
      next.trackId === previous.trackId &&
      next.preparedTrackId === previous.preparedTrackId &&
      next.status === previous.status &&
      next.currentTime === previous.currentTime &&
      next.duration === previous.duration &&
      next.playing === previous.playing &&
      next.buffering === previous.buffering &&
      next.transitioning === previous.transitioning &&
      next.rate === previous.rate &&
      next.error === previous.error
    ) {
      return previous;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener(next, previous);
    return next;
  }

  state(): UnifiedPlayerState {
    return this.snapshot;
  }

  subscribe(
    listener: (state: UnifiedPlayerState, previous: UnifiedPlayerState) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.snapshot, this.snapshot);
    return () => this.listeners.delete(listener);
  }
}

function normalizedMobile(raw: NativeAudioState): UnifiedPlayerState {
  return {
    trackId: typeof raw.id === "number" ? raw.id : null,
    preparedTrackId: null,
    status: raw.status === "playing" ? "playing" : raw.status === "ended" ? "ended" : raw.status === "error" ? "error" : raw.status === "loading" ? "loading" : raw.id == null ? "idle" : "paused",
    currentTime: Number.isFinite(raw.currentTime) ? Math.max(0, raw.currentTime) : 0,
    duration: Number.isFinite(raw.duration) ? Math.max(0, raw.duration) : 0,
    playing: raw.isPlaying,
    buffering: raw.buffering,
    transitioning: false,
    rate: Number.isFinite(raw.rate) && raw.rate > 0 ? raw.rate : 1,
    error: raw.error ?? "",
  };
}

class MobileNativePlayer extends PlayerStateOwner implements UnifiedPlayer {
  readonly kind = "mobile-native" as const;
  readonly supportsRealtimeDj = false;
  private initPromise: Promise<UnifiedPlayerState> | null = null;
  private removeNativeListener: (() => void) | null = null;
  /** React effects can request load and play in the same commit; serialize native mutations. */
  private operations: Promise<void> = Promise.resolve();

  initialize(): Promise<UnifiedPlayerState> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.removeNativeListener = await addStateListener((state) =>
        this.publish(normalizedMobile(state)),
      );
      return this.publish(normalizedMobile(await initialize()));
    })().catch((error) => {
      this.removeNativeListener?.();
      this.removeNativeListener = null;
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  private enqueue(operation: () => Promise<NativeAudioState>): Promise<UnifiedPlayerState> {
    const result = this.operations.then(async () => {
      await this.initialize();
      return this.publish(normalizedMobile(await operation()));
    });
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }

  load({ src, track, artworkUrl }: UnifiedPlayerSource): Promise<UnifiedPlayerState> {
    return this.enqueue(() =>
      setSource({
        src,
        id: track.id,
        title: track.title || track.filename,
        artist: track.artist || undefined,
        artworkUrl,
      }),
    );
  }

  prepare(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("移动连续播放模式不支持实时双 Deck prepare"));
  }

  handoff(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("移动连续播放模式不支持实时双 Deck handoff"));
  }

  setQueue(sources: UnifiedPlayerSource[]): Promise<UnifiedPlayerState> {
    return this.enqueue(() =>
      setNativeQueue(
        sources.map(({ src, track, artworkUrl }) => ({
          src,
          id: track.id,
          title: track.title || track.filename,
          artist: track.artist || undefined,
          artworkUrl,
        })),
      ),
    );
  }

  play(): Promise<UnifiedPlayerState> {
    return this.enqueue(play);
  }

  pause(): Promise<UnifiedPlayerState> {
    return this.enqueue(pause);
  }

  seek(seconds: number): Promise<UnifiedPlayerState> {
    return this.enqueue(() => seekTo(Math.max(0, seconds)));
  }

  setRate(rate: number): Promise<UnifiedPlayerState> {
    return this.enqueue(() => setRate(rate));
  }

  setVolume(volume: number): Promise<UnifiedPlayerState> {
    return this.enqueue(() => setVolume(Math.min(1, Math.max(0, volume))));
  }

  setEq(): Promise<UnifiedPlayerState> {
    return Promise.resolve(this.snapshot);
  }

  async refresh(): Promise<UnifiedPlayerState> {
    await this.initialize();
    return this.publish(normalizedMobile(await getState()));
  }

  async dispose(): Promise<void> {
    this.removeNativeListener?.();
    this.removeNativeListener = null;
    this.initPromise = null;
    await dispose();
    this.publish(INITIAL_STATE);
  }
}

type DesktopPlaybackPhase =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "seeking"
  | "transitioning"
  | "ended"
  | "error";

interface DesktopPlaybackSnapshotRaw {
  sequence: number;
  lastCommandId: number;
  phase: DesktopPlaybackPhase;
  trackId: number | null;
  preparedTrackId: number | null;
  currentTime: number;
  duration: number;
  desiredPlaying: boolean;
  isPlaying: boolean;
  buffering: boolean;
  transitioning: boolean;
  rate: number;
  volume: number;
  error: string;
}

interface DesktopCommandAckRaw {
  commandId: number;
  acceptedSequence: number;
  snapshot: DesktopPlaybackSnapshotRaw;
}

interface TauriEvent<T> {
  payload: T;
}

function normalizedDesktop(raw: DesktopPlaybackSnapshotRaw): UnifiedPlayerState {
  const status: UnifiedPlayerStatus =
    raw.phase === "error"
      ? "error"
      : raw.phase === "ended"
        ? "ended"
        : raw.phase === "loading" || raw.phase === "seeking"
          ? "loading"
          : raw.phase === "playing" || raw.phase === "transitioning"
            ? "playing"
            : raw.trackId === null
              ? "idle"
              : "paused";
  return {
    trackId: raw.trackId,
    preparedTrackId: raw.preparedTrackId,
    status,
    currentTime: Number.isFinite(raw.currentTime) ? Math.max(0, raw.currentTime) : 0,
    duration: Number.isFinite(raw.duration) ? Math.max(0, raw.duration) : 0,
    // The button renders coordinator intent. `isPlaying` is hardware truth and remains available
    // in the raw contract, but using it here would reintroduce one-buffer play/pause flicker.
    playing: raw.desiredPlaying,
    buffering: raw.buffering,
    transitioning: raw.transitioning,
    rate: Number.isFinite(raw.rate) && raw.rate > 0 ? raw.rate : 1,
    error: raw.error ?? "",
  };
}

class DesktopNativePlayer extends PlayerStateOwner implements UnifiedPlayer {
  readonly kind = "desktop-native" as const;
  readonly supportsRealtimeDj = true;
  private initPromise: Promise<UnifiedPlayerState> | null = null;
  private unlisten: UnlistenFn | null = null;
  private sequence = 0;
  private nextCommandId = 1;

  initialize(): Promise<UnifiedPlayerState> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.unlisten = await listen<DesktopPlaybackSnapshotRaw>(
        "playback-state",
        (event: TauriEvent<DesktopPlaybackSnapshotRaw>) => this.accept(event.payload),
      );
      const snapshot = await invoke<DesktopPlaybackSnapshotRaw>("playback_initialize");
      return this.accept(snapshot);
    })().catch((error) => {
      this.unlisten?.();
      this.unlisten = null;
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  private accept(raw: DesktopPlaybackSnapshotRaw): UnifiedPlayerState {
    if (raw.sequence < this.sequence) return this.snapshot;
    this.sequence = raw.sequence;
    this.nextCommandId = Math.max(this.nextCommandId, raw.lastCommandId + 1);
    return this.publish(normalizedDesktop(raw));
  }

  private async command(command: Record<string, unknown>): Promise<UnifiedPlayerState> {
    await this.initialize();
    const commandId = this.nextCommandId++;
    const ack = await invoke<DesktopCommandAckRaw>("playback_command", { commandId, command });
    return this.accept(ack.snapshot);
  }

  private source(source: UnifiedPlayerSource): Record<string, unknown> {
    return {
      trackId: source.track.id,
      path: source.track.path,
      position: source.position ?? 0,
      duration: source.track.duration,
      rate: source.rate ?? 1,
      autoplay: source.autoplay ?? false,
    };
  }

  load(source: UnifiedPlayerSource): Promise<UnifiedPlayerState> {
    return this.command({ type: "load", source: this.source(source) });
  }

  prepare(source: UnifiedPlayerSource): Promise<UnifiedPlayerState> {
    return this.command({ type: "prepare", source: this.source(source) });
  }

  handoff(
    trackId: number,
    position: number,
    seconds: number,
    plan?: UnifiedTransitionPlan,
  ): Promise<UnifiedPlayerState> {
    return this.command({
      type: "handoff",
      trackId,
      position: Math.max(0, position),
      seconds: Math.max(0, seconds),
      plan: plan ?? {
        eq: false,
        filter: false,
        vocalCut: false,
        echo: false,
        alarm: false,
        hydrant: false,
        beatSeconds: 0.5,
      },
    });
  }

  setQueue(sources: UnifiedPlayerSource[]): Promise<UnifiedPlayerState> {
    return this.command({ type: "setQueue", sources: sources.map((source) => this.source(source)) });
  }

  play(): Promise<UnifiedPlayerState> {
    return this.command({ type: "play" });
  }

  pause(): Promise<UnifiedPlayerState> {
    return this.command({ type: "pause" });
  }

  seek(seconds: number): Promise<UnifiedPlayerState> {
    return this.command({ type: "seek", position: Math.max(0, seconds) });
  }

  setRate(rate: number): Promise<UnifiedPlayerState> {
    if (Math.abs(rate - this.snapshot.rate) < 0.0001) return Promise.resolve(this.snapshot);
    return Promise.reject(new Error("流式不变调处理器尚未接入，速度只能由准备阶段决定"));
  }

  setVolume(volume: number): Promise<UnifiedPlayerState> {
    return this.command({ type: "setVolume", volume: Math.min(1, Math.max(0, volume)) });
  }

  setEq(lowDb: number, highDb: number): Promise<UnifiedPlayerState> {
    return this.command({ type: "setEq", lowDb, highDb });
  }

  async refresh(): Promise<UnifiedPlayerState> {
    await this.initialize();
    const snapshot = await invoke<DesktopPlaybackSnapshotRaw>("playback_state");
    return this.accept(snapshot);
  }

  async dispose(): Promise<void> {
    if (this.initPromise) await this.command({ type: "dispose" }).catch(() => undefined);
    this.unlisten?.();
    this.unlisten = null;
    this.initPromise = null;
    this.sequence = 0;
    this.publish(INITIAL_STATE);
  }
}

class BrowserPreviewPlayer extends PlayerStateOwner implements UnifiedPlayer {
  readonly kind = "browser-preview" as const;
  readonly supportsRealtimeDj = true;

  initialize(): Promise<UnifiedPlayerState> {
    return Promise.resolve(this.snapshot);
  }

  async load(source: UnifiedPlayerSource): Promise<UnifiedPlayerState> {
    djEngine.releaseDecodedPlayback();
    djEngine.cancel();
    const audio = djEngine.frontElement();
    audio.src = source.src;
    audio.load();
    if ((source.position ?? 0) > 0) {
      const seek = () => {
        audio.currentTime = Math.max(0, source.position ?? 0);
      };
      if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
      else audio.addEventListener("loadedmetadata", seek, { once: true });
    }
    djEngine.prepareSeek(source.src);
    djEngine.prepareDecodedSeek(source.track, source.src);
    this.publish({
      ...this.snapshot,
      trackId: source.track.id,
      status: source.autoplay ? "playing" : "paused",
      currentTime: source.position ?? 0,
      duration: source.track.duration ?? 0,
      playing: source.autoplay ?? false,
      rate: source.rate ?? 1,
      error: "",
    });
    if (source.autoplay) await djEngine.hardPlay(audio);
    return this.refresh();
  }

  prepare(source: UnifiedPlayerSource): Promise<UnifiedPlayerState> {
    djEngine.prepareSeek(source.src);
    djEngine.prepareDecodedSeek(source.track, source.src);
    return Promise.resolve(this.snapshot);
  }

  handoff(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("浏览器 DJ handoff 由 Web Audio transition adapter 管理"));
  }

  setQueue(): Promise<UnifiedPlayerState> {
    return Promise.resolve(this.snapshot);
  }

  async play(): Promise<UnifiedPlayerState> {
    await djEngine.hardPlay(djEngine.frontElement());
    return this.publish({ ...this.snapshot, status: "playing", playing: true });
  }

  pause(): Promise<UnifiedPlayerState> {
    djEngine.cancel();
    djEngine.hardPause(djEngine.frontElement());
    return Promise.resolve(this.publish({ ...this.snapshot, status: "paused", playing: false }));
  }

  async seek(seconds: number): Promise<UnifiedPlayerState> {
    const source = djEngine.frontElement().currentSrc || djEngine.frontElement().src;
    await djEngine.seamlessSeek(source, Math.max(0, seconds), this.snapshot.playing);
    return this.publish({ ...this.snapshot, currentTime: Math.max(0, seconds) });
  }

  setRate(rate: number): Promise<UnifiedPlayerState> {
    const value = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const audio = djEngine.frontElement();
    audio.playbackRate = value;
    return Promise.resolve(this.publish({ ...this.snapshot, rate: value }));
  }

  setVolume(volume: number): Promise<UnifiedPlayerState> {
    djEngine.setVolume(Math.min(1, Math.max(0, volume)));
    return Promise.resolve(this.snapshot);
  }

  setEq(): Promise<UnifiedPlayerState> {
    return Promise.resolve(this.snapshot);
  }

  refresh(): Promise<UnifiedPlayerState> {
    const audio = djEngine.frontElement();
    return Promise.resolve(
      this.publish({
        ...this.snapshot,
        currentTime: djEngine.currentTime(audio),
        duration:
          Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : this.snapshot.duration,
        playing: !audio.paused,
        status: audio.ended ? "ended" : audio.paused ? "paused" : "playing",
      }),
    );
  }

  dispose(): Promise<void> {
    djEngine.cancel();
    djEngine.hardPause(djEngine.frontElement());
    this.publish(INITIAL_STATE);
    return Promise.resolve();
  }
}

let mobilePlayer: MobileNativePlayer | null = null;
let desktopPlayer: DesktopNativePlayer | null = null;
let browserPlayer: BrowserPreviewPlayer | null = null;

export function usesNativeMobilePlayer(): boolean {
  const platform = window.kdj?.platform;
  return platform === "android" || platform === "ios";
}

export function usesNativeDesktopPlayer(): boolean {
  const platform = window.kdj?.platform;
  return Boolean(window.__TAURI_INTERNALS__) && ["darwin", "win32", "linux"].includes(platform ?? "");
}

export function nativeMobilePlayer(): UnifiedPlayer {
  if (!usesNativeMobilePlayer()) {
    throw new Error("原生移动播放器只能在 Android/iOS Tauri 壳中使用");
  }
  mobilePlayer ??= new MobileNativePlayer();
  return mobilePlayer;
}

export function nativeDesktopPlayer(): UnifiedPlayer {
  if (!usesNativeDesktopPlayer()) {
    throw new Error("桌面原生播放器只能在 Tauri 桌面壳中使用");
  }
  desktopPlayer ??= new DesktopNativePlayer();
  return desktopPlayer;
}

export function runtimePlayer(): UnifiedPlayer {
  if (usesNativeMobilePlayer()) return nativeMobilePlayer();
  if (usesNativeDesktopPlayer()) return nativeDesktopPlayer();
  browserPlayer ??= new BrowserPreviewPlayer();
  return browserPlayer;
}

/** Kept for callers outside PlayerBar during the staged migration. */
export function runtimeNativePlayer(): UnifiedPlayer | null {
  const player = runtimePlayer();
  return player.kind === "browser-preview" ? null : player;
}
