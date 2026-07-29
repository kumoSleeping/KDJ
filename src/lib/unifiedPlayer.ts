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

export type UnifiedPlayerStatus = "idle" | "loading" | "playing" | "ended" | "error";

export interface UnifiedPlayerState {
  trackId: number | null;
  status: UnifiedPlayerStatus;
  currentTime: number;
  duration: number;
  playing: boolean;
  buffering: boolean;
  rate: number;
  error: string;
}

export interface UnifiedPlayerSource {
  src: string;
  track: Track;
  artworkUrl?: string;
}

export interface UnifiedPlayer {
  readonly kind: "mobile-native";
  initialize(): Promise<UnifiedPlayerState>;
  load(source: UnifiedPlayerSource): Promise<UnifiedPlayerState>;
  setQueue(sources: UnifiedPlayerSource[]): Promise<UnifiedPlayerState>;
  play(): Promise<UnifiedPlayerState>;
  pause(): Promise<UnifiedPlayerState>;
  seek(seconds: number): Promise<UnifiedPlayerState>;
  setRate(rate: number): Promise<UnifiedPlayerState>;
  setVolume(volume: number): Promise<UnifiedPlayerState>;
  state(): UnifiedPlayerState;
  refresh(): Promise<UnifiedPlayerState>;
  subscribe(listener: (state: UnifiedPlayerState, previous: UnifiedPlayerState) => void): () => void;
  dispose(): Promise<void>;
}

const INITIAL_STATE: UnifiedPlayerState = {
  trackId: null,
  status: "idle",
  currentTime: 0,
  duration: 0,
  playing: false,
  buffering: false,
  rate: 1,
  error: "",
};

function normalized(raw: NativeAudioState): UnifiedPlayerState {
  return {
    trackId: typeof raw.id === "number" ? raw.id : null,
    status: raw.status,
    currentTime: Number.isFinite(raw.currentTime) ? Math.max(0, raw.currentTime) : 0,
    duration: Number.isFinite(raw.duration) ? Math.max(0, raw.duration) : 0,
    playing: raw.isPlaying,
    buffering: raw.buffering,
    rate: Number.isFinite(raw.rate) && raw.rate > 0 ? raw.rate : 1,
    error: raw.error ?? "",
  };
}

class MobileNativePlayer implements UnifiedPlayer {
  readonly kind = "mobile-native" as const;
  private snapshot: UnifiedPlayerState = INITIAL_STATE;
  private listeners = new Set<(state: UnifiedPlayerState, previous: UnifiedPlayerState) => void>();
  private initPromise: Promise<UnifiedPlayerState> | null = null;
  private removeNativeListener: (() => void) | null = null;
  /** React effects can request load and play in the same commit; serialize native mutations. */
  private operations: Promise<void> = Promise.resolve();

  private publish(raw: NativeAudioState): UnifiedPlayerState {
    const previous = this.snapshot;
    const next = normalized(raw);
    this.snapshot = next;
    for (const listener of this.listeners) listener(next, previous);
    return next;
  }

  initialize(): Promise<UnifiedPlayerState> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      // 先注册再初始化，避免 initialize 的第一帧状态落在监听建立之前。
      this.removeNativeListener = await addStateListener((state) => this.publish(state));
      return this.publish(await initialize());
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
      return this.publish(await operation());
    });
    // A failed command must not poison every later transport command.
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

  setQueue(sources: UnifiedPlayerSource[]): Promise<UnifiedPlayerState> {
    return this.enqueue(() =>
      setNativeQueue(sources.map(({ src, track, artworkUrl }) => ({
        src,
        id: track.id,
        title: track.title || track.filename,
        artist: track.artist || undefined,
        artworkUrl,
      }))),
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
    const normalizedVolume = Math.min(1, Math.max(0, volume));
    return this.enqueue(() => setVolume(normalizedVolume));
  }

  state(): UnifiedPlayerState {
    return this.snapshot;
  }

  async refresh(): Promise<UnifiedPlayerState> {
    await this.initialize();
    return this.publish(await getState());
  }

  subscribe(listener: (state: UnifiedPlayerState, previous: UnifiedPlayerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot, this.snapshot);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.removeNativeListener?.();
    this.removeNativeListener = null;
    this.initPromise = null;
    await dispose();
    this.snapshot = INITIAL_STATE;
  }
}

let mobilePlayer: MobileNativePlayer | null = null;

export function usesNativeMobilePlayer(): boolean {
  const platform = window.kdj?.platform;
  return platform === "android" || platform === "ios";
}

export function nativeMobilePlayer(): UnifiedPlayer {
  if (!usesNativeMobilePlayer()) {
    throw new Error("原生移动播放器只能在 Android/iOS Tauri 壳中使用");
  }
  mobilePlayer ??= new MobileNativePlayer();
  return mobilePlayer;
}
