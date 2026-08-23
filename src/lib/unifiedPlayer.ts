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
import type { FilterResonance, Track } from "../types";
import { djEngine } from "./djMix";
import { EQ_GRAPH_BAND_COUNT } from "./eqGraph";
import { usesRemotePlaybackSource } from "./playbackTrackSource";
import {
  SYNC_PHASE_TOLERANCE_SEC,
  syncFollowerSeekPositionWithLead,
} from "./beatGridSync";

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
  decks: [UnifiedDeckState, UnifiedDeckState];
}

export interface UnifiedDeckState {
  trackId: number | null;
  currentTime: number;
  duration: number;
  playing: boolean;
  desiredPlaying: boolean;
  buffering: boolean;
  /** True only after a STEM callback source has actually been installed on this Deck. */
  stemEnabled: boolean;
  outputBufferMs: number;
  minimumOutputBufferMs: number;
  outputUnderruns: number;
  /** Post-EQ peak in linear full scale; values >= 1 indicate clipping. */
  peakLevel: number;
  rate: number;
  /** 引擎级无缝循环窗口（曲目秒）；null 表示线性播放。 */
  loopStart: number | null;
  loopLength: number | null;
}

export interface UnifiedDeckMixer {
  channelGain: number;
  trimDb: number;
  lowDb: number;
  midDb: number;
  highDb: number;
  filter: number;
}

export interface UnifiedDeckFx {
  echo: number;
  echoParameter: number;
  reverb: number;
  reverbParameter: number;
  gater: number;
  gaterParameter: number;
  pad: number;
  beatSeconds: number;
}

export interface UnifiedDeckSyncRequest {
  follower: 0 | 1;
  master: 0 | 1;
  rate: number;
  followerBpm: number;
  followerFirstBeat: number;
  masterBpm: number;
  masterFirstBeat: number;
  beatsPerBar?: number;
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
  stemEnabled?: boolean;
  stemCachePath?: string;
  stemMask?: number;
  stemGains?: [number, number, number, number];
}

export interface UnifiedPlayer {
  readonly kind: UnifiedPlayerKind;
  readonly supportsRealtimeDj: boolean;
  initialize(): Promise<UnifiedPlayerState>;
  load(source: UnifiedPlayerSource): Promise<UnifiedPlayerState>;
  loadDeck(deck: 0 | 1, source: UnifiedPlayerSource): Promise<UnifiedPlayerState>;
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
  playDeck(deck: 0 | 1): Promise<UnifiedPlayerState>;
  pauseDeck(deck: 0 | 1): Promise<UnifiedPlayerState>;
  /** Capacitive platter contact freezes this Deck's audio cursor without changing Play/Pause. */
  setDeckScratchHeld(deck: 0 | 1, held: boolean): Promise<UnifiedPlayerState>;
  seekDeck(deck: 0 | 1, seconds: number): Promise<UnifiedPlayerState>;
  /** Seek a paused physical Deck and resume only after its replacement stream is ready. */
  seekDeckAndPlay(deck: 0 | 1, seconds: number): Promise<UnifiedPlayerState>;
  /** Transient jog-wheel pitch bend; does not mutate the Deck's persistent TEMPO. */
  nudgeDeck(deck: 0 | 1, amount: number): Promise<UnifiedPlayerState>;
  /** Held platter motion in track seconds. Must sum ticks instead of latest-wins. */
  scratchDeck(deck: 0 | 1, delta: number): Promise<UnifiedPlayerState>;
  setDeckRate(deck: 0 | 1, rate: number): Promise<UnifiedPlayerState>;
  /** Linked SYNC tempo update applied to both callback clocks at one boundary. */
  setDeckRates(rates: [number, number]): Promise<UnifiedPlayerState>;
  /** Native-clock BPM + downbeat alignment for one follower Deck. */
  syncDeck(request: UnifiedDeckSyncRequest): Promise<UnifiedPlayerState>;
  setDeckMixer(deck: 0 | 1, mixer: UnifiedDeckMixer): Promise<UnifiedPlayerState>;
  setDeckFx(deck: 0 | 1, fx: UnifiedDeckFx): Promise<UnifiedPlayerState>;
  setFilterResonance(resonance: FilterResonance): Promise<UnifiedPlayerState>;
  setDeckStems(
    trackId: number,
    enabled: boolean,
    cachePath: string,
    mask: number,
    gains?: [number, number, number, number],
  ): Promise<UnifiedPlayerState>;
  /** 引擎级无缝循环：只解码 [start, start+length] 切片并回绕。 */
  setDeckLoop(trackId: number, start: number, length: number): Promise<UnifiedPlayerState>;
  clearDeckLoop(trackId: number): Promise<UnifiedPlayerState>;
  seek(seconds: number): Promise<UnifiedPlayerState>;
  setRate(rate: number): Promise<UnifiedPlayerState>;
  setVolume(volume: number): Promise<UnifiedPlayerState>;
  setEq(lowDb: number, highDb: number): Promise<UnifiedPlayerState>;
  setTransportFade(enabled: boolean): Promise<UnifiedPlayerState>;
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
  decks: [0, 1].map(() => ({
    trackId: null,
    currentTime: 0,
    duration: 0,
    playing: false,
    desiredPlaying: false,
    buffering: false,
    stemEnabled: false,
    outputBufferMs: 0,
    minimumOutputBufferMs: 0,
    outputUnderruns: 0,
    peakLevel: 0,
    rate: 1,
    loopStart: null,
    loopLength: null,
  })) as [UnifiedDeckState, UnifiedDeckState],
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
      next.error === previous.error &&
      next.decks === previous.decks
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
    decks: INITIAL_STATE.decks,
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
        album: track.album || undefined,
        artworkUrl,
      }),
    );
  }

  loadDeck(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("iOS 连续播放模式不支持双 Deck"));
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
          album: track.album || undefined,
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

  playDeck(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("iOS 连续播放模式不支持双 Deck"));
  }

  pauseDeck(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("iOS 连续播放模式不支持双 Deck"));
  }

  setDeckScratchHeld(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("iOS 连续播放模式不支持双 Deck"));
  }

  seekDeck(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("iOS 连续播放模式不支持双 Deck"));
  }

  seekDeckAndPlay(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("iOS 连续播放模式不支持双 Deck"));
  }

  nudgeDeck(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("iOS 连续播放模式不支持双 Deck"));
  }

  scratchDeck(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("iOS 连续播放模式不支持双 Deck"));
  }

  setDeckRate(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("iOS 连续播放模式不支持双 Deck"));
  }

  setDeckRates(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("iOS 连续播放模式不支持双 Deck"));
  }

  syncDeck(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("iOS 连续播放模式不支持双 Deck"));
  }

  setDeckMixer(): Promise<UnifiedPlayerState> {
    return Promise.resolve(this.snapshot);
  }

  setDeckFx(): Promise<UnifiedPlayerState> {
    return Promise.resolve(this.snapshot);
  }

  setFilterResonance(): Promise<UnifiedPlayerState> {
    return Promise.resolve(this.snapshot);
  }

  setDeckStems(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("当前播放器不支持 STEM"));
  }

  setDeckLoop(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("当前播放器不支持 LOOP"));
  }

  clearDeckLoop(): Promise<UnifiedPlayerState> {
    return Promise.resolve(this.snapshot);
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

  setTransportFade(): Promise<UnifiedPlayerState> {
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
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  currentTime: number;
  duration: number;
  desiredPlaying: boolean;
  isPlaying: boolean;
  buffering: boolean;
  transitioning: boolean;
  rate: number;
  volume: number;
  error: string;
  decks: [DesktopDeckSnapshotRaw, DesktopDeckSnapshotRaw];
}

interface DesktopDeckSnapshotRaw {
  trackId: number | null;
  currentTime: number;
  duration: number;
  desiredPlaying: boolean;
  isPlaying: boolean;
  rate: number;
  buffering: boolean;
  stemEnabled?: boolean;
  outputBufferMs?: number;
  minimumOutputBufferMs?: number;
  outputUnderruns?: number;
  peakLevel?: number;
  loopStart?: number | null;
  loopLength?: number | null;
}

interface DesktopCommandAckRaw {
  commandId: number;
  acceptedSequence: number;
  snapshot: DesktopPlaybackSnapshotRaw;
}

interface DesktopLevelsRaw {
  peaks: [number, number];
  bands: [number[], number[]];
}

interface TauriEvent<T> {
  payload: T;
}

const liveDeckLevels: [number, number] = [0, 0];
const liveDeckSpectrum: [number[], number[]] = [
  new Array<number>(EQ_GRAPH_BAND_COUNT).fill(0),
  new Array<number>(EQ_GRAPH_BAND_COUNT).fill(0),
];
let liveDeckLevelsActive = false;
/** 高频电平（~30Hz 轻量事件，绕开 10Hz 全量快照）：电平表在 rAF 里直读，不走 React 状态。 */
export function getLiveDeckPeak(deck: 0 | 1): number | null {
  return liveDeckLevelsActive ? liveDeckLevels[deck] : null;
}

/** Fixed-width post-EQ levels are mutated by the Tauri event listener and read directly in rAF. */
export function getLiveDeckSpectrum(deck: 0 | 1): readonly number[] | null {
  return liveDeckLevelsActive ? liveDeckSpectrum[deck] : null;
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
    decks: raw.decks.map((deck) => ({
      trackId: deck.trackId,
      currentTime: Number.isFinite(deck.currentTime) ? Math.max(0, deck.currentTime) : 0,
      duration: Number.isFinite(deck.duration) ? Math.max(0, deck.duration) : 0,
      playing: deck.isPlaying,
      desiredPlaying: deck.desiredPlaying ?? false,
      buffering: deck.buffering ?? false,
      stemEnabled: deck.stemEnabled ?? false,
      outputBufferMs: Math.max(0, deck.outputBufferMs ?? 0),
      minimumOutputBufferMs: Math.max(0, deck.minimumOutputBufferMs ?? 0),
      outputUnderruns: Math.max(0, deck.outputUnderruns ?? 0),
      peakLevel: Number.isFinite(deck.peakLevel) ? Math.max(0, deck.peakLevel ?? 0) : 0,
      rate: Number.isFinite(deck.rate) && deck.rate > 0 ? deck.rate : 1,
      loopStart: typeof deck.loopStart === "number" ? deck.loopStart : null,
      loopLength: typeof deck.loopLength === "number" ? deck.loopLength : null,
    })) as [UnifiedDeckState, UnifiedDeckState],
  };
}

class DesktopNativePlayer extends PlayerStateOwner implements UnifiedPlayer {
  readonly kind = "desktop-native" as const;
  readonly supportsRealtimeDj = true;
  private initPromise: Promise<UnifiedPlayerState> | null = null;
  private unlisten: UnlistenFn | null = null;
  private unlistenLevels: UnlistenFn | null = null;
  private sequence = 0;
  private nextCommandId = 1;
  /** Tauri invoke 可以并发越序到达；播放命令必须和 commandId 保持同一顺序。 */
  private commandTail: Promise<void> = Promise.resolve();
  /** 队列更新是可丢弃的后台意图；只合并尚未进入 IPC 的旧队列更新。 */
  private queueRevision = 0;
  /** 预测预热同样只保留最后一个尚未进入 IPC 的候选。 */
  private prepareRevision = 0;
  /** 播放/暂停和音量是可合并意图；快速触摸只保留尚未进入 IPC 的最后状态。 */
  private transportRevision = 0;
  private volumeRevision = 0;
  private loadRevision = 0;
  /** TEMPO 走独立控制通道，不占用 load/seek 的 commandId 队列。 */
  private rateTails: [Promise<void>, Promise<void>] = [Promise.resolve(), Promise.resolve()];
  /** Jog 边缘缓动同样走最新值控制通道；旧 tick 不得积压到下一次表演。 */
  private nudgeTails: [Promise<void>, Promise<void>] = [Promise.resolve(), Promise.resolve()];
  /** Held vinyl ticks must be summed; dropping an in-flight packet would skip audible distance. */
  private scratchTails: [Promise<void>, Promise<void>] = [Promise.resolve(), Promise.resolve()];
  private deckScratchPending: [number, number] = [0, 0];
  /** 高频 jog seek 只保留尚未进入 IPC 的最后一个位置。 */
  private seekTails: [Promise<void>, Promise<void>] = [Promise.resolve(), Promise.resolve()];
  /** TEMPO 与混音手势相同：每个物理 Deck 只保留尚未进入 IPC 的最新值。 */
  private deckRateRevisions: [number, number] = [0, 0];
  private deckNudgeRevisions: [number, number] = [0, 0];
  private deckSeekRevisions: [number, number] = [0, 0];
  /** 每个物理 Deck 的高频旋钮手势只让最新值进入 IPC，旧值不能排队追赶。 */
  private deckMixerRevisions: [number, number] = [0, 0];
  private deckFxRevisions: [number, number] = [0, 0];

  initialize(): Promise<UnifiedPlayerState> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.unlisten = await listen<DesktopPlaybackSnapshotRaw>(
        "playback-state",
        (event: TauriEvent<DesktopPlaybackSnapshotRaw>) => this.accept(event.payload),
      );
      this.unlistenLevels = await listen<DesktopLevelsRaw | [number, number]>(
        "playback-levels",
        (event: TauriEvent<DesktopLevelsRaw | [number, number]>) => {
          const payload = event.payload;
          // Array support keeps Vite HMR safe while an already-running pre-spectrum backend is
          // being restarted; production frontend/backend builds always use the object contract.
          if (Array.isArray(payload)) {
            liveDeckLevels[0] = Number.isFinite(payload[0]) ? Math.max(0, payload[0]) : 0;
            liveDeckLevels[1] = Number.isFinite(payload[1]) ? Math.max(0, payload[1]) : 0;
          } else {
            liveDeckLevels[0] = Number.isFinite(payload.peaks?.[0]) ? Math.max(0, payload.peaks[0]) : 0;
            liveDeckLevels[1] = Number.isFinite(payload.peaks?.[1]) ? Math.max(0, payload.peaks[1]) : 0;
            ([0, 1] as const).forEach((deck) => {
              for (let band = 0; band < EQ_GRAPH_BAND_COUNT; band += 1) {
                const value = payload.bands?.[deck]?.[band];
                liveDeckSpectrum[deck][band] = Number.isFinite(value) ? Math.max(0, value) : 0;
              }
            });
          }
          liveDeckLevelsActive = true;
        },
      );
      const snapshot = await invoke<DesktopPlaybackSnapshotRaw>("playback_initialize");
      return this.accept(snapshot);
    })().catch((error) => {
      this.unlisten?.();
      this.unlisten = null;
      this.unlistenLevels?.();
      this.unlistenLevels = null;
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

  private command(
    command: Record<string, unknown>,
    isCurrent: () => boolean = () => true,
    acceptAcknowledgement = true,
  ): Promise<UnifiedPlayerState> {
    const operation = this.commandTail.then(async () => {
      // 只在真正进入 IPC 前检查；旧的后台预热因此不会占用 Rust actor 的命令槽。
      if (!isCurrent()) return this.snapshot;
      await this.initialize();
      const commandId = this.nextCommandId++;
      const ack = await invoke<DesktopCommandAckRaw>("playback_command", { commandId, command });
      // A TEMPO fader acknowledgement contains a full Deck snapshot. Applying dozens of those
      // per second re-renders every waveform despite the compositor having nothing new to draw.
      // The coordinator emits the authoritative latest rate on its normal 100ms state cadence;
      // continuous controls use that edge while ordinary transport commands still accept at once.
      return acceptAcknowledgement ? this.accept(ack.snapshot) : this.snapshot;
    });
    // 失败不能堵死后续播放命令，但调用方仍会收到本次 operation 的原始错误。
    this.commandTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** Continuous TEMPO/mixer controls must not sit behind load/seek on `commandTail`. */
  private control(
    command: Record<string, unknown>,
    isCurrent: () => boolean = () => true,
  ): Promise<UnifiedPlayerState> {
    const operation = (async () => {
      if (!isCurrent()) return this.snapshot;
      await this.initialize();
      await invoke<DesktopCommandAckRaw>("playback_control", { command });
      return this.snapshot;
    })();
    return operation;
  }

  private source(source: UnifiedPlayerSource): Record<string, unknown> {
    const remote = usesRemotePlaybackSource(source.track);
    return {
      trackId: source.track.id,
      // Online previews stay behind the loopback proxy; Rust owns the final PCM/output path on
      // desktop and Android just as it does for local files.
      path: remote ? source.src : source.track.path,
      sourceKind: remote ? "remote" : "local",
      title: source.track.title || source.track.filename,
      artist: source.track.artist || "",
      album: source.track.album || "",
      artworkUrl: source.artworkUrl,
      position: source.position ?? 0,
      duration: source.track.duration,
      rate: source.rate ?? 1,
      autoplay: source.autoplay ?? false,
      stemEnabled: source.stemEnabled ?? false,
      stemCachePath: source.stemCachePath ?? "",
      stemMask: (source.stemMask ?? 0b1111) & 0b1111,
      stemGains: source.stemGains ?? [1, 1, 1, 1],
    };
  }

  load(source: UnifiedPlayerSource): Promise<UnifiedPlayerState> {
    this.prepareRevision += 1;
    this.transportRevision += 1;
    this.deckRateRevisions[0] += 1;
    this.deckRateRevisions[1] += 1;
    this.deckNudgeRevisions[0] += 1;
    this.deckNudgeRevisions[1] += 1;
    this.deckSeekRevisions[0] += 1;
    this.deckSeekRevisions[1] += 1;
    this.deckMixerRevisions[0] += 1;
    this.deckMixerRevisions[1] += 1;
    this.deckFxRevisions[0] += 1;
    this.deckFxRevisions[1] += 1;
    const revision = ++this.loadRevision;
    return this.command(
      { type: "load", source: this.source(source) },
      () => revision === this.loadRevision,
    );
  }

  loadDeck(deck: 0 | 1, source: UnifiedPlayerSource): Promise<UnifiedPlayerState> {
    // A Deck replacement invalidates a trailing fader/knob value from the old song. The native
    // command lane evaluates this revision immediately before IPC, so stale controls cannot land
    // after the new load merely because a rapid gesture was still queued.
    this.deckRateRevisions[deck] += 1;
    this.deckNudgeRevisions[deck] += 1;
    this.deckSeekRevisions[deck] += 1;
    this.deckMixerRevisions[deck] += 1;
    this.deckFxRevisions[deck] += 1;
    return this.command({ type: "loadDeck", deck, source: this.source(source) });
  }

  prepare(source: UnifiedPlayerSource): Promise<UnifiedPlayerState> {
    const revision = ++this.prepareRevision;
    return this.command(
      { type: "prepare", source: this.source(source) },
      () => revision === this.prepareRevision,
    );
  }

  handoff(
    trackId: number,
    position: number,
    seconds: number,
    plan?: UnifiedTransitionPlan,
  ): Promise<UnifiedPlayerState> {
    this.prepareRevision += 1;
    this.transportRevision += 1;
    this.loadRevision += 1;
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
    const revision = ++this.queueRevision;
    return this.command(
      { type: "setQueue", sources: sources.map((source) => this.source(source)) },
      () => revision === this.queueRevision,
    );
  }

  play(): Promise<UnifiedPlayerState> {
    const revision = ++this.transportRevision;
    return this.command({ type: "play" }, () => revision === this.transportRevision);
  }

  pause(): Promise<UnifiedPlayerState> {
    const revision = ++this.transportRevision;
    return this.command({ type: "pause" }, () => revision === this.transportRevision);
  }

  playDeck(deck: 0 | 1): Promise<UnifiedPlayerState> {
    return this.command({ type: "playDeck", deck });
  }

  pauseDeck(deck: 0 | 1): Promise<UnifiedPlayerState> {
    return this.command({ type: "pauseDeck", deck });
  }

  setDeckScratchHeld(deck: 0 | 1, held: boolean): Promise<UnifiedPlayerState> {
    if (held) {
      // A touch must not land behind an already-queued edge seek/nudge and freeze the song at
      // wherever that packet would have taken it.
      this.deckSeekRevisions[deck] += 1;
      this.deckNudgeRevisions[deck] += 1;
    }
    // This shares the ordered transport lane with the final seek. A touch-up can therefore never
    // overtake touch-down and turn an already released platter back into a held one.
    return this.command({ type: "setDeckScratchHeld", deck, held });
  }

  seekDeck(deck: 0 | 1, seconds: number): Promise<UnifiedPlayerState> {
    return this.seekDeckIntent(deck, seconds, false);
  }

  seekDeckAndPlay(deck: 0 | 1, seconds: number): Promise<UnifiedPlayerState> {
    return this.seekDeckIntent(deck, seconds, true);
  }

  private seekDeckIntent(
    deck: 0 | 1,
    seconds: number,
    playWhenReady: boolean,
  ): Promise<UnifiedPlayerState> {
    const revision = this.deckSeekRevisions[deck] + 1;
    this.deckSeekRevisions[deck] = revision;
    const operation = this.seekTails[deck].then(() =>
      this.command(
        { type: "seekDeck", deck, position: Math.max(0, seconds), playWhenReady },
        () => this.deckSeekRevisions[deck] === revision,
      ),
    );
    this.seekTails[deck] = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  nudgeDeck(deck: 0 | 1, amount: number): Promise<UnifiedPlayerState> {
    const bounded = Number.isFinite(amount) ? Math.max(-1, Math.min(1, amount)) : 0;
    if (bounded === 0) return Promise.resolve(this.snapshot);
    const revision = this.deckNudgeRevisions[deck] + 1;
    this.deckNudgeRevisions[deck] = revision;
    const operation = this.nudgeTails[deck].then(() =>
      this.control(
        { type: "nudgeDeck", deck, amount: bounded },
        () => this.deckNudgeRevisions[deck] === revision,
      ),
    );
    this.nudgeTails[deck] = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  scratchDeck(deck: 0 | 1, delta: number): Promise<UnifiedPlayerState> {
    if (!Number.isFinite(delta) || delta === 0) return Promise.resolve(this.snapshot);
    this.deckScratchPending[deck] += delta;
    const operation = this.scratchTails[deck].then(() => {
      const amount = this.deckScratchPending[deck];
      this.deckScratchPending[deck] = 0;
      if (amount === 0) return this.snapshot;
      return this.control({ type: "scratchDeck", deck, delta: amount });
    });
    this.scratchTails[deck] = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  setDeckRate(deck: 0 | 1, rate: number): Promise<UnifiedPlayerState> {
    const revision = this.deckRateRevisions[deck] + 1;
    this.deckRateRevisions[deck] = revision;
    const operation = this.rateTails[deck].then(() =>
      this.control(
        { type: "setDeckRate", deck, rate },
        () => this.deckRateRevisions[deck] === revision,
      ),
    );
    this.rateTails[deck] = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  setDeckRates(rates: [number, number]): Promise<UnifiedPlayerState> {
    const revisions: [number, number] = [
      this.deckRateRevisions[0] + 1,
      this.deckRateRevisions[1] + 1,
    ];
    this.deckRateRevisions = revisions;
    const operation = Promise.all(this.rateTails).then(() =>
      this.control(
        { type: "setDeckRates", rates },
        () => this.deckRateRevisions[0] === revisions[0]
          && this.deckRateRevisions[1] === revisions[1],
      ),
    );
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.rateTails = [tail, tail];
    return operation;
  }

  syncDeck(request: UnifiedDeckSyncRequest): Promise<UnifiedPlayerState> {
    const follower = request.follower;
    const rateRevision = this.deckRateRevisions[follower] + 1;
    const seekRevision = this.deckSeekRevisions[follower] + 1;
    this.deckRateRevisions[follower] = rateRevision;
    this.deckSeekRevisions[follower] = seekRevision;
    const operation = Promise.all([this.rateTails[follower], this.seekTails[follower]]).then(() =>
      this.command(
        {
          type: "syncDeck",
          ...request,
          beatsPerBar: request.beatsPerBar ?? 4,
        },
        () => this.deckRateRevisions[follower] === rateRevision
          && this.deckSeekRevisions[follower] === seekRevision,
      ),
    );
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.rateTails[follower] = tail;
    this.seekTails[follower] = tail;
    return operation;
  }

  setDeckMixer(deck: 0 | 1, mixer: UnifiedDeckMixer): Promise<UnifiedPlayerState> {
    const revision = this.deckMixerRevisions[deck] + 1;
    this.deckMixerRevisions[deck] = revision;
    return this.command(
      { type: "setDeckMixer", deck, ...mixer },
      () => this.deckMixerRevisions[deck] === revision,
    );
  }

  setDeckFx(deck: 0 | 1, fx: UnifiedDeckFx): Promise<UnifiedPlayerState> {
    const revision = this.deckFxRevisions[deck] + 1;
    this.deckFxRevisions[deck] = revision;
    return this.control(
      { type: "setDeckFx", deck, ...fx },
      () => this.deckFxRevisions[deck] === revision,
    );
  }

  setFilterResonance(resonance: FilterResonance): Promise<UnifiedPlayerState> {
    return this.command({ type: "setFilterResonance", resonance });
  }

  setDeckStems(
    trackId: number,
    enabled: boolean,
    cachePath: string,
    mask: number,
    gains: [number, number, number, number] = [1, 1, 1, 1],
  ): Promise<UnifiedPlayerState> {
    // Gain/mute rides the realtime actor path. Parking it on commandTail made STEM EQ wait
    // behind seek/load, so the knobs looked dead until a pad click drained that queue.
    return this.control({
      type: "setDeckStems",
      trackId,
      enabled,
      cachePath,
      mask: mask & 0b1111,
      gains,
    });
  }

  setDeckLoop(trackId: number, start: number, length: number): Promise<UnifiedPlayerState> {
    return this.command({ type: "setDeckLoop", trackId, start, length });
  }

  clearDeckLoop(trackId: number): Promise<UnifiedPlayerState> {
    return this.command({ type: "clearDeckLoop", trackId });
  }

  seek(seconds: number): Promise<UnifiedPlayerState> {
    return this.command({ type: "seek", position: Math.max(0, seconds) });
  }

  setRate(rate: number): Promise<UnifiedPlayerState> {
    if (Math.abs(rate - this.snapshot.rate) < 0.0001) return Promise.resolve(this.snapshot);
    if (this.snapshot.trackId === null) return Promise.resolve(this.snapshot);
    const side = this.snapshot.decks.findIndex(
      (deck) => deck.trackId === this.snapshot.trackId && (deck.playing || deck.desiredPlaying),
    );
    const fallback = this.snapshot.decks.findIndex((deck) => deck.trackId === this.snapshot.trackId);
    const deck = side >= 0 ? side : fallback;
    return deck === 0 || deck === 1
      ? this.setDeckRate(deck, rate)
      : Promise.resolve(this.snapshot);
  }

  setVolume(volume: number): Promise<UnifiedPlayerState> {
    const revision = ++this.volumeRevision;
    return this.command(
      { type: "setVolume", volume: Math.min(1, Math.max(0, volume)) },
      () => revision === this.volumeRevision,
    );
  }

  setEq(lowDb: number, highDb: number): Promise<UnifiedPlayerState> {
    return this.command({ type: "setEq", lowDb, highDb });
  }

  setTransportFade(enabled: boolean): Promise<UnifiedPlayerState> {
    return this.command({ type: "setTransportFade", enabled });
  }

  async refresh(): Promise<UnifiedPlayerState> {
    await this.initialize();
    const snapshot = await invoke<DesktopPlaybackSnapshotRaw>("playback_state");
    return this.accept(snapshot);
  }

  async dispose(): Promise<void> {
    this.queueRevision += 1;
    this.prepareRevision += 1;
    this.transportRevision += 1;
    this.volumeRevision += 1;
    this.loadRevision += 1;
    this.deckRateRevisions[0] += 1;
    this.deckRateRevisions[1] += 1;
    this.deckNudgeRevisions[0] += 1;
    this.deckNudgeRevisions[1] += 1;
    this.deckSeekRevisions[0] += 1;
    this.deckSeekRevisions[1] += 1;
    this.deckMixerRevisions[0] += 1;
    this.deckMixerRevisions[1] += 1;
    this.deckFxRevisions[0] += 1;
    this.deckFxRevisions[1] += 1;
    if (this.initPromise) await this.command({ type: "dispose" }).catch(() => undefined);
    this.unlisten?.();
    this.unlisten = null;
    this.unlistenLevels?.();
    this.unlistenLevels = null;
    liveDeckLevelsActive = false;
    liveDeckLevels[0] = 0;
    liveDeckLevels[1] = 0;
    liveDeckSpectrum[0].fill(0);
    liveDeckSpectrum[1].fill(0);
    this.initPromise = null;
    this.sequence = 0;
    this.commandTail = Promise.resolve();
    this.publish(INITIAL_STATE);
  }
}

class BrowserPreviewPlayer extends PlayerStateOwner implements UnifiedPlayer {
  readonly kind = "browser-preview" as const;
  readonly supportsRealtimeDj = true;
  private deckBaseRates: [number, number] = [1, 1];
  private deckScratchHeld: [boolean, boolean] = [false, false];
  private nudgeTimers: [number | null, number | null] = [null, null];

  private clearNudge(deck: 0 | 1): void {
    const timer = this.nudgeTimers[deck];
    if (timer !== null) window.clearTimeout(timer);
    this.nudgeTimers[deck] = null;
  }

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

  async loadDeck(deck: 0 | 1, source: UnifiedPlayerSource): Promise<UnifiedPlayerState> {
    djEngine.releaseDecodedPlayback();
    this.clearNudge(deck);
    this.deckScratchHeld[deck] = false;
    this.deckBaseRates[deck] = source.rate ?? 1;
    const audio = djEngine.deckElement(deck);
    audio.src = source.src;
    audio.playbackRate = this.deckBaseRates[deck];
    audio.load();
    const position = Math.max(0, source.position ?? 0);
    const seek = () => {
      audio.currentTime = position;
    };
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
    else audio.addEventListener("loadedmetadata", seek, { once: true });
    const decks = [...this.snapshot.decks] as [UnifiedDeckState, UnifiedDeckState];
    decks[deck] = {
      trackId: source.track.id,
      currentTime: position,
      duration: source.track.duration ?? 0,
      playing: false,
      desiredPlaying: source.autoplay ?? false,
      buffering: false,
      stemEnabled: false,
      outputBufferMs: 0,
      minimumOutputBufferMs: 0,
      outputUnderruns: 0,
      peakLevel: 0,
      rate: this.deckBaseRates[deck],
      loopStart: null,
      loopLength: null,
    };
    this.publish({ ...this.snapshot, decks });
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

  async playDeck(deck: 0 | 1): Promise<UnifiedPlayerState> {
    if (this.snapshot.decks[deck].trackId === null) throw new Error("目标 Deck 尚未装入曲目");
    this.deckScratchHeld[deck] = false;
    const audio = djEngine.deckElement(deck);
    audio.playbackRate = this.deckBaseRates[deck];
    await djEngine.hardPlay(audio);
    return this.refresh();
  }

  pauseDeck(deck: 0 | 1): Promise<UnifiedPlayerState> {
    if (this.snapshot.decks[deck].trackId === null) {
      return Promise.reject(new Error("目标 Deck 尚未装入曲目"));
    }
    this.deckScratchHeld[deck] = false;
    djEngine.hardPause(djEngine.deckElement(deck));
    return this.refresh();
  }

  setDeckScratchHeld(deck: 0 | 1, held: boolean): Promise<UnifiedPlayerState> {
    if (this.snapshot.decks[deck].trackId === null) {
      return Promise.reject(new Error("目标 Deck 尚未装入曲目"));
    }
    this.clearNudge(deck);
    this.deckScratchHeld[deck] = held;
    // Browser preview has no callback-owned cursor. A near-zero rate preserves the media
    // element's playing state while providing the same non-Pause hold contract as native.
    djEngine.deckElement(deck).playbackRate = held ? 0.0001 : this.deckBaseRates[deck];
    return this.refresh();
  }

  seekDeck(deck: 0 | 1, seconds: number): Promise<UnifiedPlayerState> {
    if (this.snapshot.decks[deck].trackId === null) {
      return Promise.reject(new Error("目标 Deck 尚未装入曲目"));
    }
    djEngine.deckElement(deck).currentTime = Math.max(0, seconds);
    return this.refresh();
  }

  async seekDeckAndPlay(deck: 0 | 1, seconds: number): Promise<UnifiedPlayerState> {
    await this.seekDeck(deck, seconds);
    return this.playDeck(deck);
  }

  nudgeDeck(deck: 0 | 1, amount: number): Promise<UnifiedPlayerState> {
    if (this.snapshot.decks[deck].trackId === null) {
      return Promise.resolve(this.snapshot);
    }
    const bounded = Number.isFinite(amount) ? Math.max(-1, Math.min(1, amount)) : 0;
    if (bounded === 0) return Promise.resolve(this.snapshot);
    if (this.deckScratchHeld[deck]) return Promise.resolve(this.snapshot);
    const audio = djEngine.deckElement(deck);
    const sourceId = this.snapshot.decks[deck].trackId;
    audio.playbackRate = Math.max(0.5, Math.min(2, this.deckBaseRates[deck] * (1 + bounded * 0.18)));
    this.clearNudge(deck);
    this.nudgeTimers[deck] = window.setTimeout(() => {
      this.nudgeTimers[deck] = null;
      if (this.snapshot.decks[deck].trackId !== sourceId) return;
      audio.playbackRate = this.deckBaseRates[deck];
      void this.refresh();
    }, 90);
    return Promise.resolve(this.snapshot);
  }

  scratchDeck(deck: 0 | 1, delta: number): Promise<UnifiedPlayerState> {
    if (this.snapshot.decks[deck].trackId === null) {
      return Promise.resolve(this.snapshot);
    }
    if (!this.deckScratchHeld[deck] || !Number.isFinite(delta) || delta === 0) {
      return Promise.resolve(this.snapshot);
    }
    const audio = djEngine.deckElement(deck);
    audio.currentTime = Math.max(0, audio.currentTime + delta);
    return this.refresh();
  }

  setDeckRate(deck: 0 | 1, rate: number): Promise<UnifiedPlayerState> {
    if (this.snapshot.decks[deck].trackId === null) {
      return Promise.reject(new Error("目标曲目尚未装入 Deck"));
    }
    this.clearNudge(deck);
    this.deckBaseRates[deck] = rate;
    if (!this.deckScratchHeld[deck]) djEngine.deckElement(deck).playbackRate = rate;
    return this.refresh();
  }

  setDeckRates(rates: [number, number]): Promise<UnifiedPlayerState> {
    ([0, 1] as const).forEach((deck) => {
      if (this.snapshot.decks[deck].trackId === null) {
        throw new Error("SYNC 关联的两首曲目必须都已装入 Deck");
      }
      this.clearNudge(deck);
      this.deckBaseRates[deck] = rates[deck];
      if (!this.deckScratchHeld[deck]) djEngine.deckElement(deck).playbackRate = rates[deck];
    });
    return this.refresh();
  }

  syncDeck(request: UnifiedDeckSyncRequest): Promise<UnifiedPlayerState> {
    const follower = this.snapshot.decks[request.follower];
    const master = this.snapshot.decks[request.master];
    if (follower.trackId === null || master.trackId === null) {
      return Promise.reject(new Error("SYNC 关联的两首曲目必须都已装入 Deck"));
    }
    const followerAudio = djEngine.deckElement(request.follower);
    const masterAudio = djEngine.deckElement(request.master);
    this.clearNudge(request.follower);
    this.deckBaseRates[request.follower] = request.rate;
    if (!this.deckScratchHeld[request.follower]) followerAudio.playbackRate = request.rate;
    const seekTo = syncFollowerSeekPositionWithLead({
      followerPositionSec: followerAudio.currentTime,
      followerBpm: request.followerBpm,
      followerFirstBeatSec: request.followerFirstBeat,
      followerRate: request.rate,
      followerDurationSec: follower.duration,
      masterPositionSec: masterAudio.currentTime,
      masterBpm: request.masterBpm,
      masterFirstBeatSec: request.masterFirstBeat,
      masterRate: this.deckBaseRates[request.master],
      multiple: 1,
      beatsPerCell: request.beatsPerBar ?? 4,
    }, 0, SYNC_PHASE_TOLERANCE_SEC);
    if (seekTo !== null && !followerAudio.paused) followerAudio.currentTime = seekTo;
    return this.refresh();
  }

  setDeckMixer(): Promise<UnifiedPlayerState> {
    return Promise.resolve(this.snapshot);
  }

  setDeckFx(): Promise<UnifiedPlayerState> {
    return Promise.resolve(this.snapshot);
  }

  setFilterResonance(resonance: FilterResonance): Promise<UnifiedPlayerState> {
    djEngine.setFilterResonance(resonance);
    return Promise.resolve(this.snapshot);
  }

  setDeckStems(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("浏览器预览不支持 STEM"));
  }

  setDeckLoop(): Promise<UnifiedPlayerState> {
    return Promise.reject(new Error("浏览器预览不支持 LOOP"));
  }

  clearDeckLoop(): Promise<UnifiedPlayerState> {
    return Promise.resolve(this.snapshot);
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

  setTransportFade(): Promise<UnifiedPlayerState> {
    return Promise.resolve(this.snapshot);
  }

  refresh(): Promise<UnifiedPlayerState> {
    const audio = djEngine.frontElement();
    const decks = this.snapshot.decks.map((deck, index) => {
      const element = djEngine.deckElement(index as 0 | 1);
      return {
        ...deck,
        currentTime: Number.isFinite(element.currentTime) ? element.currentTime : deck.currentTime,
        duration:
          Number.isFinite(element.duration) && element.duration > 0
            ? element.duration
            : deck.duration,
        playing: !element.paused,
        desiredPlaying: !element.paused,
        // A pitch bend must never make the TEMPO control jump. Keep the persistent value in the
        // snapshot while the media element briefly runs faster or slower.
        rate: this.deckBaseRates[index],
      };
    }) as [UnifiedDeckState, UnifiedDeckState];
    return Promise.resolve(
      this.publish({
        ...this.snapshot,
        decks,
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
    this.clearNudge(0);
    this.clearNudge(1);
    this.deckScratchHeld = [false, false];
    djEngine.cancel();
    djEngine.hardPause(djEngine.frontElement());
    this.publish(INITIAL_STATE);
    return Promise.resolve();
  }
}

let mobilePlayer: MobileNativePlayer | null = null;
let desktopPlayer: DesktopNativePlayer | null = null;
let browserPlayer: BrowserPreviewPlayer | null = null;

/** iOS 仍走系统 AVPlayer 连续播放；Android 已切共享 coordinator。 */
export function usesNativeMobilePlayer(): boolean {
  return window.kdj?.platform === "ios";
}

/**
 * 共享 Rust 播放协调器（CPAL）：桌面 + Android。
 * kind 仍叫 desktop-native，避免再拆一套前端契约。
 */
export function usesNativeDesktopPlayer(): boolean {
  const platform = window.kdj?.platform;
  return (
    Boolean(window.__TAURI_INTERNALS__) &&
    ["darwin", "win32", "linux", "android"].includes(platform ?? "")
  );
}

export function nativeMobilePlayer(): UnifiedPlayer {
  if (!usesNativeMobilePlayer()) {
    throw new Error("原生移动播放器只能在 iOS Tauri 壳中使用");
  }
  mobilePlayer ??= new MobileNativePlayer();
  return mobilePlayer;
}

export function nativeDesktopPlayer(): UnifiedPlayer {
  if (!usesNativeDesktopPlayer()) {
    throw new Error("共享原生播放器只能在 Tauri 桌面或 Android 壳中使用");
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
