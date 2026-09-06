/**
 * 视频和曲库音频之间的同步协议。
 *
 * 播放器和视频组件的生命周期不同，直接互传 ref 会让换页、卸载和 DJ
 * 双 deck 变得很脆。用事件传递走带动作和音频时钟，两边只需要认自己的
 * owner；position 由音频播放器广播，视频侧按需要纠偏。
 */
import { getLiveDeckClock, getLiveForegroundDeck, runtimePlayer, subscribeLivePlaybackClock } from "./unifiedPlayer";
import { liveWaveformPlaybackRate, loopedWaveformPosition } from "./waveformMotion";

export const MEDIA_SYNC_EVENT = "kd:media-sync";

export type MediaSyncOwner = "player" | "preview" | "local-video";
export type MediaSyncAction = "play" | "pause" | "seek" | "position";

export interface MediaSyncDetail {
  owner: MediaSyncOwner;
  action: MediaSyncAction;
  /** 本地视频和音频要配对；在线预览由当前协同会话隐式配对。 */
  trackId?: number;
  /** position 对 player 是音频时间，对视频是修正后的目标时间。 */
  position?: number;
  /** Rust / WebAudio 权威走带速度；本地静音视频以它为中心做轻微漂移修正。 */
  rate?: number;
}

// 详情面板可能在播放器开始播放之后才挂载。保留最后一次播放器状态，
// 新挂载的视频可以立即接上，而不用等下一次 play/timeupdate 事件。
let latestPlayerSync: MediaSyncDetail | null = null;
let latestPlayerPlaying = false;

export function broadcastMediaSync(detail: MediaSyncDetail): void {
  if (detail.owner === "player") {
    if (detail.action === "play") latestPlayerPlaying = true;
    if (detail.action === "pause") latestPlayerPlaying = false;
    latestPlayerSync = {
      ...detail,
      action: latestPlayerPlaying ? "play" : "pause",
    };
  }
  window.dispatchEvent(new CustomEvent<MediaSyncDetail>(MEDIA_SYNC_EVENT, { detail }));
}

export function getLatestPlayerSync(trackId: number): MediaSyncDetail | null {
  return latestPlayerSync?.trackId === trackId ? latestPlayerSync : null;
}

export interface LocalVideoClock {
  trackId: number;
  sourceId: number;
  discontinuityRevision: number;
  loopGeneration: number;
  loopWrapCount: number;
  position: number;
  rate: number;
  playing: boolean;
  /** A short IPC gap can preserve transport, but cannot authorize alignment or a seek landing. */
  fresh?: boolean;
}

const LOCAL_VIDEO_CLOCK_FRESH_MS = 250;
export const LOCAL_VIDEO_CLOCK_TIMEOUT_MS = 1_500;

export function usesLocalVideoDeviceClock(): boolean {
  return runtimePlayer().kind === "desktop-native";
}

/** Device-correlated source time, never PlayerBar's optimistically pinned seek position. */
export function getLocalVideoClock(trackId: number): LocalVideoClock | null {
  const player = runtimePlayer();
  if (player.kind !== "desktop-native") return null;
  const state = player.state();
  const foreground = getLiveForegroundDeck();
  const live = getLiveDeckClock(foreground);
  const now = performance.now();
  if (state.trackId !== trackId || state.buffering || ["idle", "loading", "error"].includes(state.status)
    || live?.trackId !== trackId || !Number.isFinite(live.clientPresentationTimeMs)
    || Math.abs(now - live.clientPresentationTimeMs) > LOCAL_VIDEO_CLOCK_TIMEOUT_MS) return null;
  const deck = state.decks[foreground];
  if (deck.trackId === trackId && live.discontinuityRevision < deck.discontinuityRevision) return null;
  const rate = liveWaveformPlaybackRate(live.targetRate, live.audibleRate, live.scratchHeld);
  const age = now - live.clientPresentationTimeMs;
  const position = live.currentTime + Math.max(-0.25, age / 1000) * rate;
  return {
    trackId, sourceId: live.sourceId, discontinuityRevision: live.discontinuityRevision,
    loopGeneration: live.loopGeneration, loopWrapCount: live.loopWrapCount,
    position: loopedWaveformPosition(Math.max(0, state.duration > 0 ? Math.min(state.duration, position) : position),
      live.loopStart, live.loopLength),
    fresh: Math.abs(age) <= LOCAL_VIDEO_CLOCK_FRESH_MS,
    rate, playing: live.playing || Math.abs(rate) > 0.02,
  };
}

export function subscribeLocalVideoClock(trackId: number, listener: (clock: LocalVideoClock | null) => void): () => void {
  let staleTimer = 0;
  const update = () => {
    window.clearTimeout(staleTimer);
    // Sample expiry is relative to the device timestamp, not the last full-state notification.
    // Unrelated state updates must not keep a dead clock alive indefinitely.
    const live = getLiveDeckClock(getLiveForegroundDeck());
    const age = live ? performance.now() - live.clientPresentationTimeMs : LOCAL_VIDEO_CLOCK_TIMEOUT_MS + 1;
    const deadline = age <= LOCAL_VIDEO_CLOCK_FRESH_MS ? LOCAL_VIDEO_CLOCK_FRESH_MS : LOCAL_VIDEO_CLOCK_TIMEOUT_MS;
    if (Number.isFinite(age) && age <= deadline) staleTimer = window.setTimeout(update, deadline - age + 1);
    listener(getLocalVideoClock(trackId));
  };
  const unlistenLive = subscribeLivePlaybackClock(update);
  const unlistenState = runtimePlayer().subscribe(update);
  return () => { window.clearTimeout(staleTimer); unlistenLive(); unlistenState(); };
}

export interface LocalVideoSeekFence {
  trackId: number;
  sourceId: number | null;
  discontinuityRevision: number;
}

/** Capture immediately before submitting the native seek, even if it is queued by PlayerBar. */
export function captureLocalVideoSeekFence(trackId: number): LocalVideoSeekFence {
  const foreground = getLiveForegroundDeck();
  const live = getLiveDeckClock(foreground);
  const deck = runtimePlayer().state().decks[foreground];
  return {
    trackId,
    sourceId: live?.trackId === trackId ? live.sourceId : null,
    discontinuityRevision: Math.max(live?.trackId === trackId ? live.discontinuityRevision : -1,
      deck.trackId === trackId ? deck.discontinuityRevision : -1),
  };
}

export function localVideoSeekHasLanded(fence: LocalVideoSeekFence, clock: LocalVideoClock | null): boolean {
  return clock !== null && clock.fresh !== false && clock.trackId === fence.trackId
    && (clock.sourceId !== fence.sourceId || clock.discontinuityRevision > fence.discontinuityRevision);
}

/** A timer bounds failure only; it never authorizes a landing or invents a playback position. */
export function waitForLocalVideoSeekLanding(
  fence: LocalVideoSeekFence,
  isCurrent: () => boolean,
  timeoutMs = 2_000,
): Promise<LocalVideoClock | null> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (clock: LocalVideoClock | null) => {
      if (settled) return;
      settled = true; window.clearTimeout(timer); unsubscribe?.(); resolve(clock);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    unsubscribe = subscribeLocalVideoClock(fence.trackId, (clock) => {
      if (!isCurrent()) finish(null);
      else if (localVideoSeekHasLanded(fence, clock)) finish(clock);
    });
    if (settled) unsubscribe();
  });
}
