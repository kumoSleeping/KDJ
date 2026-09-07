import type { LocalVideoClock } from "./mediaSync";
import { waitForVideoFrames } from "./videoFrames";
import { VideoSeekQueue } from "./videoSeekQueue";

export const VIDEO_SYNC_EXPLICIT_TOLERANCE_SEC = 0.05;

const VIDEO_SYNC_RATE_EPSILON = 0.001;
const VIDEO_SYNC_CORRECTION_INTERVAL_MS = 500;
const VIDEO_SYNC_CORRECTION_ENTER_SEC = 0.04;
const VIDEO_SYNC_CORRECTION_EXIT_SEC = 0.015;
const VIDEO_SEEK_ECHO_TOLERANCE_SEC = 0.75;
const VIDEO_SEEK_ECHO_TTL_MS = 2_000;
const VIDEO_SEEK_ECHO_LIMIT = 8;
const VIDEO_TRANSPORT_ECHO_TTL_MS = 2_000;
const VIDEO_TRANSPORT_ECHO_LIMIT = 8;

export type VideoSyncKind = "heartbeat" | "explicit" | "clock";

export type VideoSyncDecision =
  | { type: "rate"; rate: number }
  | { type: "seek"; target: number; rate: number };

export interface VideoSyncPolicyState {
  baseRate?: number;
  rate?: number;
  updatedAt?: number;
  correcting?: boolean;
}

export interface VideoSyncPolicyInput {
  kind: VideoSyncKind;
  target: number;
  presentedTime: number;
  baseRate: number;
  paused: boolean;
  seeking: boolean;
  now: number;
}

export interface VideoSyncPolicyResult {
  decision: VideoSyncDecision;
  state: VideoSyncPolicyState;
}

export function initialVideoSyncPolicyState(): VideoSyncPolicyState {
  return {};
}

function normalizedRate(rate: number): number {
  return Number.isFinite(rate) ? Math.min(16, Math.max(0.0625, rate)) : 1;
}

/**
 * Plans one local-video clock update without touching a media element.
 *
 * Rust publishes its audio clock about every 100ms. Those snapshots are observations, not
 * transport commands: seeking or changing WebKit's playback rate for them repeatedly flushes the
 * video pipeline and turns a healthy 30fps file into visible stop/start playback. Only explicit
 * play/seek/resume edges may realign the timeline. `clock` is a separate, DAC-projected sample.
 * This rate policy is used outside WebKit; WebKit uses stable-tempo alignment below because even
 * bounded rate convergence can repeatedly stall its presentation pipeline.
 */
export function planVideoSync(
  input: VideoSyncPolicyInput,
  previous: VideoSyncPolicyState,
): VideoSyncPolicyResult {
  const rate = normalizedRate(input.baseRate);
  const target = Math.max(0, input.target);
  const distance = Math.abs(target - Math.max(0, input.presentedTime));

  if (input.kind === "explicit" && !input.seeking && distance > VIDEO_SYNC_EXPLICIT_TOLERANCE_SEC) {
    return { decision: { type: "seek", target, rate }, state: {} };
  }

  if (input.kind === "clock" && !input.paused && !input.seeking) {
    const error = target - input.presentedTime;
    // Sub-frame clock noise is not drift. Hold a correction for at least half a second so the
    // media pipeline is not retuned on every IPC/render tick. Transport tempo changes bypass it.
    const sameRate = previous.baseRate === rate;
    if (sameRate && previous.updatedAt !== undefined && input.now >= previous.updatedAt
      && input.now - previous.updatedAt < VIDEO_SYNC_CORRECTION_INTERVAL_MS) {
      return { decision: { type: "rate", rate: previous.rate ?? rate }, state: previous };
    }
    const correcting = distance > (sameRate && previous.correcting
      ? VIDEO_SYNC_CORRECTION_EXIT_SEC : VIDEO_SYNC_CORRECTION_ENTER_SEC);
    const correction = correcting ? Math.max(-rate * 0.12, Math.min(rate * 0.12, error * 1.2)) : 0;
    const corrected = normalizedRate(rate + Math.round(correction / 0.005) * 0.005);
    return { decision: { type: "rate", rate: corrected },
      state: { baseRate: rate, rate: corrected, updatedAt: input.now, correcting } };
  }
  return { decision: { type: "rate", rate }, state: {} };
}

type ProgrammaticSeek = (video: HTMLVideoElement, target: number) => void;
type BackgroundAlignment = (video: HTMLVideoElement) => void;

interface StableVideoClockState {
  baseRate: number;
  seekLead: number;
  landingLead: number | null;
  lastSeekAt: number;
  driftSince: number | null;
  errorBeforeSeek: number;
  retryMs: number;
}

export type VideoTransportAction = "play" | "pause";

interface PendingVideoTransportEcho {
  token: number;
  video: HTMLVideoElement;
  action: VideoTransportAction;
  expiresAt: number;
}

/**
 * Tags play/pause edges issued by the dual-video presenter itself.
 *
 * A standby video is briefly played and paused to make WebKit submit its decoded frame. Once that
 * element becomes the active slot, delayed media events are otherwise indistinguishable from the
 * user's native video controls and can be echoed into the audible transport as a second Play or
 * Pause command.
 */
export class VideoTransportEchoGuard {
  private pending: PendingVideoTransportEcho[] = [];
  private nextToken = 1;

  mark(
    video: HTMLVideoElement,
    action: VideoTransportAction,
    now = performance.now(),
  ): number {
    this.prune(now);
    const token = this.nextToken;
    this.nextToken = (this.nextToken + 1) % Number.MAX_SAFE_INTEGER || 1;
    this.pending.push({
      token,
      video,
      action,
      expiresAt: now + VIDEO_TRANSPORT_ECHO_TTL_MS,
    });
    if (this.pending.length > VIDEO_TRANSPORT_ECHO_LIMIT) {
      this.pending.splice(0, this.pending.length - VIDEO_TRANSPORT_ECHO_LIMIT);
    }
    return token;
  }

  cancel(token: number): void {
    const index = this.pending.findIndex((candidate) => candidate.token === token);
    if (index >= 0) this.pending.splice(index, 1);
  }

  consume(
    video: HTMLVideoElement,
    action: VideoTransportAction,
    now = performance.now(),
  ): boolean {
    this.prune(now);
    const index = this.pending.findIndex(
      (candidate) => candidate.video === video && candidate.action === action,
    );
    if (index < 0) return false;
    this.pending.splice(index, 1);
    return true;
  }

  clear(): void {
    this.pending = [];
  }

  private prune(now: number): void {
    this.pending = this.pending.filter((candidate) => candidate.expiresAt >= now);
  }
}

interface PendingVideoSeekEcho {
  video: HTMLVideoElement;
  target: number;
  expiresAt: number;
}

/**
 * Distinguishes a player-driven video alignment from a seek made in native video/PiP controls.
 *
 * Setting `currentTime` emits the same `seeked` event as a user gesture. The floating-video host
 * needs to forward only the latter to the audible player, otherwise one audio seek is echoed back
 * into a second audio seek after the picture catches up.
 */
export class VideoSeekEchoGuard {
  private pending: PendingVideoSeekEcho[] = [];

  mark(video: HTMLVideoElement, target: number, now = performance.now()): void {
    if (!Number.isFinite(target)) return;
    this.prune(now);
    this.pending.push({
      video,
      target: Math.max(0, target),
      expiresAt: now + VIDEO_SEEK_ECHO_TTL_MS,
    });
    if (this.pending.length > VIDEO_SEEK_ECHO_LIMIT) {
      this.pending.splice(0, this.pending.length - VIDEO_SEEK_ECHO_LIMIT);
    }
  }

  consume(video: HTMLVideoElement, landedAt: number, now = performance.now()): boolean {
    this.prune(now);
    if (!Number.isFinite(landedAt)) return false;

    let matchedIndex = -1;
    let matchedDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.pending.length; index += 1) {
      const candidate = this.pending[index];
      if (candidate.video !== video) continue;
      const distance = Math.abs(candidate.target - landedAt);
      if (distance <= VIDEO_SEEK_ECHO_TOLERANCE_SEC && distance < matchedDistance) {
        matchedIndex = index;
        matchedDistance = distance;
      }
    }
    if (matchedIndex < 0) return false;
    this.pending.splice(matchedIndex, 1);
    return true;
  }

  clear(): void {
    this.pending = [];
  }

  private prune(now: number): void {
    this.pending = this.pending.filter((candidate) => candidate.expiresAt >= now);
  }
}

/** Shared video scheduling over the system media decoder. No copied pixels or bundled codecs.
 * Local playback, streams, YouTube HLS and the mixing editor use the same seek lane and clock
 * policy; official embeds use VideoSeekQueue with their platform command adapter. */
export class VideoPlaybackEngine {
  private seekQueues = new Map<HTMLVideoElement, VideoSeekQueue>();
  private seekTargets = new WeakMap<HTMLVideoElement, { position: number }>();
  private policies = new WeakMap<HTMLVideoElement, VideoSyncPolicyState>();
  private deviceOwners = new WeakMap<HTMLVideoElement, string>();
  private stableClocks = new WeakMap<HTMLVideoElement, StableVideoClockState>();
  private observations = new WeakMap<HTMLVideoElement, { clock: LocalVideoClock; at: number }>();
  private aligning = new WeakSet<HTMLVideoElement>();

  constructor(private readonly timing: "rate" | "webkit" =
    typeof HTMLVideoElement !== "undefined" && "webkitSetPresentationMode" in HTMLVideoElement.prototype
      ? "webkit" : "rate") {}

  /** Coalesce rapid gestures instead of repeatedly flushing an in-flight decoder seek. */
  seek(video: HTMLVideoElement, position: number, onDispatch?: ProgrammaticSeek): Promise<boolean> {
    if (!Number.isFinite(position)) return Promise.resolve(false);
    let queue = this.seekQueues.get(video);
    if (!queue) { queue = new VideoSeekQueue(); this.seekQueues.set(video, queue); }
    const source = video.src;
    const requested = { position: Math.max(0, Number.isFinite(video.duration) ? Math.min(video.duration, position) : position) };
    this.seekTargets.set(video, requested);
    const result = queue.request(signal => new Promise<void>((resolve, reject) => {
      if (signal.aborted || video.src !== source) {
        reject(new DOMException("Video source changed", "AbortError")); return;
      }
      const target = requested.position;
      const finish = (error?: unknown) => {
        window.clearTimeout(timer);
        video.removeEventListener("seeked", ready);
        video.removeEventListener("error", failed);
        video.removeEventListener("emptied", changed);
        signal.removeEventListener("abort", changed);
        error ? reject(error) : resolve();
      };
      const ready = () => finish();
      const changed = () => finish(new DOMException("Video seek canceled", "AbortError"));
      const failed = () => finish(new Error("视频跳转失败"));
      const timer = window.setTimeout(() => finish(new Error("视频跳转超时")), 4000);
      video.addEventListener("seeked", ready, { once: true });
      video.addEventListener("error", failed, { once: true });
      video.addEventListener("emptied", changed, { once: true });
      signal.addEventListener("abort", changed, { once: true });
      try {
        if (onDispatch) onDispatch(video, target);
        else video.currentTime = target;
        if (!video.seeking) finish();
      } catch (error) { finish(error); }
    }));
    return result.finally(() => {
      if (this.seekTargets.get(video) === requested) this.seekTargets.delete(video);
    });
  }

  /** Relative nudges accumulate against the latest intent, even while the decoder is busy. */
  position(video: HTMLVideoElement): number {
    return this.seekTargets.get(video)?.position ?? video.currentTime;
  }

  cancelSeek(video: HTMLVideoElement): void {
    this.seekQueues.get(video)?.cancel();
    this.seekQueues.delete(video);
    this.seekTargets.delete(video);
  }

  followClock(video: HTMLVideoElement, clock: LocalVideoClock, seek: ProgrammaticSeek, align?: BackgroundAlignment): void {
    this.observations.set(video, { clock, at: performance.now() });
    // Keep the decoder running through a bounded IPC gap, but never align or chase stale data.
    if (clock.fresh === false) { this.setBaseRate(video, clock.rate > 0 ? clock.rate : 1); return; }
    const owner = `${clock.trackId}:${clock.sourceId}:${clock.discontinuityRevision}:${clock.loopGeneration}:${clock.loopWrapCount}`;
    if (video.seeking || video.readyState < 2) return;
    const changed = this.deviceOwners.get(video) !== owner;
    this.deviceOwners.set(video, owner);
    if (this.timing === "webkit") {
      this.followStableClock(video, clock, changed, seek, align);
      return;
    }
    this.sync(video, clock.position, changed || !clock.playing || clock.rate <= 0 ? "explicit" : "clock", clock.rate, seek);
  }

  private followStableClock(video: HTMLVideoElement, clock: LocalVideoClock, changed: boolean, seek: ProgrammaticSeek, align?: BackgroundAlignment): void {
    // WKWebView retimes its decoding pipeline on rate changes: even a 500ms PLL can cause a
    // catch-up -> ratechange stall -> catch-up cycle. Keep the actual audio tempo unchanged.
    this.setBaseRate(video, clock.rate > 0 ? clock.rate : 1);
    const now = performance.now();
    const state = this.stableClocks.get(video) ?? {
      baseRate: clock.rate, seekLead: 0, landingLead: null, lastSeekAt: Number.NEGATIVE_INFINITY,
      driftSince: null, errorBeforeSeek: 0, retryMs: 5000,
    };
    this.stableClocks.set(video, state);
    const error = clock.position - video.currentTime;
    if (changed || state.baseRate !== clock.rate) {
      state.landingLead = null; state.driftSince = null; state.retryMs = 5000;
      state.baseRate = clock.rate;
    }
    if (!clock.playing || clock.rate <= 0) {
      state.landingLead = null; state.driftSince = null;
      if (Math.abs(error) > VIDEO_SYNC_EXPLICIT_TOLERANCE_SEC) seek(video, clock.position);
      return;
    }
    if (state.landingLead !== null) {
      // `seeked` can precede WebKit's presentation restart. Reading currentTime immediately
      // after the setter reports the requested cursor, hiding the decoder's subsequent stall.
      // Measure only after that bounded restart window has elapsed and frames can be advancing.
      if (now - state.lastSeekAt < 750) return;
      // Learn this decoder's seek delay from its actual landing. The next alignment targets the
      // audio time at decode completion, not the old time at request dispatch.
      state.seekLead = Math.max(0, Math.min(0.75, state.landingLead + error / clock.rate));
      // A decoder that cannot reduce the phase error must not freeze the image every five
      // seconds forever. Back off failed compensated alignments; transport edges remain immediate.
      state.retryMs = state.landingLead > 0.01 && Math.abs(error) >= state.errorBeforeSeek * 0.8
        ? Math.min(60_000, state.retryMs * 2) : 5000;
      state.landingLead = null;
      state.lastSeekAt = now;
      state.driftSince = null;
      return;
    }
    if (Math.abs(error) <= 0.08) { state.driftSince = null; return; }
    state.driftSince ??= now;
    // One small phase discrepancy is not a seek. Outside transport edges only persistent drift
    // may align, with a cooldown so decoding never becomes a continuous correction loop.
    if (!changed && (now - state.driftSince < 1000 || now - state.lastSeekAt < state.retryMs)) return;
    if (!changed && align) {
      state.lastSeekAt = now;
      state.driftSince = null;
      align(video);
      return;
    }
    state.landingLead = state.seekLead;
    state.errorBeforeSeek = Math.abs(error);
    state.lastSeekAt = now;
    state.driftSince = null;
    const target = clock.position + state.seekLead * clock.rate;
    seek(video, Math.max(0, Number.isFinite(video.duration) ? Math.min(video.duration, target) : target));
  }

  /** Correct only the spare decoder. WebKit can hold its first post-seek frame for hundreds
   * of milliseconds even after seeked; require sustained advancement before making it visible. */
  async alignStandby(
    active: HTMLVideoElement, spare: HTMLVideoElement,
    isCurrent: () => boolean, activate: () => boolean,
  ): Promise<boolean> {
    if (this.aligning.has(active)) return false;
    const initial = this.observations.get(active)?.clock;
    if (!initial) return false;
    const owner = this.deviceOwners.get(active);
    const currentClock = () => {
      const observation = this.observations.get(active);
      if (!isCurrent() || this.deviceOwners.get(active) !== owner || !observation) return null;
      const { clock, at } = observation;
      const age = performance.now() - at;
      if (!clock.playing || clock.fresh === false || clock.rate !== initial.rate || age > 500) return null;
      return { ...clock, position: clock.position + age / 1000 * clock.rate };
    };
    if (!currentClock()) return false;
    this.aligning.add(active);
    let adopted = false;
    let frameWait: AbortController | undefined;
    const sleep = () => new Promise<void>(resolve => window.setTimeout(resolve, 50));
    try {
      spare.muted = true;
      this.setBaseRate(spare, initial.rate);
      let lead = 0.3;
      for (let attempt = 0; attempt < 3; attempt++) {
        const clock = currentClock();
        if (!clock || spare.readyState < 1) return false;
        const target = clock.position + lead * clock.rate;
        if (Number.isFinite(spare.duration) && target >= spare.duration - 0.1) return false;
        spare.currentTime = target;
        frameWait?.abort();
        frameWait = new AbortController();
        const frames = waitForVideoFrames(spare, target, true, frameWait.signal, 1900);
        // Do not await an unbounded play promise: all waits below check ownership and a deadline.
        void spare.play().catch(() => undefined);
        const began = performance.now();
        let previous = spare.currentTime, advancing = 0;
        while (performance.now() - began < 2000) {
          await sleep();
          if (!currentClock()) return false;
          const position = spare.currentTime;
          advancing = !spare.paused && !spare.seeking && spare.readyState >= 2
            && position > previous + 0.01 * clock.rate ? advancing + 1 : 0;
          previous = position;
          if (performance.now() - began >= 750 && advancing >= 3) break;
        }
        if (advancing < 3 || !(await frames)) return false;
        const landed = currentClock();
        if (!landed) return false;
        const error = landed.position - spare.currentTime;
        if (Math.abs(error) <= 0.08) {
          adopted = activate();
          if (adopted) this.adoptClock(spare, landed);
          return adopted;
        }
        lead = Math.max(0, Math.min(1.5, lead + error / landed.rate));
      }
      return false;
    } finally {
      frameWait?.abort();
      this.aligning.delete(active);
      // A user seek may have taken over the spare while this async decode was in flight.
      if (!adopted && isCurrent()) spare.pause();
    }
  }

  /** A prepared slot is already at its decoded landing; do not seek it a second time on adoption. */
  adoptClock(video: HTMLVideoElement, clock: LocalVideoClock): void {
    this.stableClocks.delete(video);
    this.deviceOwners.set(video, `${clock.trackId}:${clock.sourceId}:${clock.discontinuityRevision}:${clock.loopGeneration}:${clock.loopWrapCount}`);
    this.setBaseRate(video, clock.rate);
  }

  releaseClock(video: HTMLVideoElement): void {
    this.cancelSeek(video);
    this.observations.delete(video);
    this.deviceOwners.delete(video);
    this.policies.delete(video);
    this.stableClocks.delete(video);
  }

  sync(
    video: HTMLVideoElement,
    target: number,
    kind: VideoSyncKind,
    baseRate = 1,
    seek: ProgrammaticSeek = (element, position) => {
      void this.seek(element, position).catch(() => undefined);
    },
    now = performance.now(),
  ): VideoSyncDecision | null {
    if (!Number.isFinite(target)) return null;
    const result = planVideoSync(
      {
        kind,
        target,
        presentedTime: video.currentTime,
        baseRate,
        paused: video.paused,
        seeking: video.seeking,
        now,
      },
      this.policies.get(video) ?? initialVideoSyncPolicyState(),
    );
    this.policies.set(video, result.state);
    this.applyRate(video, result.decision.rate);
    if (result.decision.type === "seek") seek(video, result.decision.target);
    return result.decision;
  }

  setBaseRate(video: HTMLVideoElement, baseRate = 1): void {
    this.policies.delete(video);
    this.applyRate(video, normalizedRate(baseRate));
  }

  reset(video?: HTMLVideoElement | null): void {
    for (const video of this.seekQueues.keys()) this.cancelSeek(video);
    this.observations = new WeakMap();
    this.policies = new WeakMap();
    this.deviceOwners = new WeakMap();
    this.stableClocks = new WeakMap();
    if (video) this.applyRate(video, 1);
  }

  dispose(): void {
    for (const video of this.seekQueues.keys()) this.cancelSeek(video);
    this.observations = new WeakMap();
    this.policies = new WeakMap();
    this.deviceOwners = new WeakMap();
    this.stableClocks = new WeakMap();
  }

  private applyRate(video: HTMLVideoElement, rate: number): void {
    if (Math.abs(video.playbackRate - rate) <= VIDEO_SYNC_RATE_EPSILON) return;
    video.playbackRate = rate;
  }
}

/** Shared by the detail panel and floating/system PiP; all programmatic edges carry provenance. */
export function applyLocalVideoClock(
  video: HTMLVideoElement,
  clock: LocalVideoClock | null,
  synchronizer: VideoPlaybackEngine,
  seekGuard: VideoSeekEchoGuard,
  transportGuard: VideoTransportEchoGuard,
  align?: BackgroundAlignment,
): void {
  video.muted = true;
  if (clock) synchronizer.followClock(video, clock, (element, position) => {
    void synchronizer.seek(element, position, (target, time) => {
      seekGuard.mark(target, time); target.currentTime = time;
    }).catch(() => undefined);
  }, align);
  else synchronizer.releaseClock(video);
  const shouldPlay = clock !== null && clock.playing && clock.rate > 0;
  if (shouldPlay && video.paused && video.readyState >= 2) {
    const token = transportGuard.mark(video, "play");
    void video.play().then(() => transportGuard.cancel(token), () => transportGuard.cancel(token));
  } else if (!shouldPlay && !video.paused) {
    transportGuard.mark(video, "pause"); video.pause();
  }
}
