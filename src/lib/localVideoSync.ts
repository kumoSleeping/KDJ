export const VIDEO_SYNC_EXPLICIT_TOLERANCE_SEC = 0.05;

const VIDEO_SYNC_RATE_EPSILON = 0.001;
const VIDEO_SEEK_ECHO_TOLERANCE_SEC = 0.75;
const VIDEO_SEEK_ECHO_TTL_MS = 2_000;
const VIDEO_SEEK_ECHO_LIMIT = 8;
const VIDEO_TRANSPORT_ECHO_TTL_MS = 2_000;
const VIDEO_TRANSPORT_ECHO_LIMIT = 8;

export type VideoSyncKind = "heartbeat" | "explicit";

export type VideoSyncDecision =
  | { type: "rate"; rate: number }
  | { type: "seek"; target: number; rate: number };

// Kept as a policy value rather than hidden class state so transport behavior remains easy to
// unit-test. The phase-locked strategy currently needs no accumulating heartbeat state.
export type VideoSyncPolicyState = Record<string, never>;

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
  return Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1;
}

/**
 * Plans one local-video clock update without touching a media element.
 *
 * Rust publishes its audio clock about every 100ms. Those snapshots are observations, not
 * transport commands: seeking or changing WebKit's playback rate for them repeatedly flushes the
 * video pipeline and turns a healthy 30fps file into visible stop/start playback. Only explicit
 * play/seek/resume edges may realign the timeline. Between those edges both clocks free-run at the
 * same authoritative rate.
 */
export function planVideoSync(
  input: VideoSyncPolicyInput,
  previous: VideoSyncPolicyState,
): VideoSyncPolicyResult {
  const rate = normalizedRate(input.baseRate);
  const target = Math.max(0, input.target);
  const distance = Math.abs(target - Math.max(0, input.presentedTime));

  if (input.kind === "explicit" && distance > VIDEO_SYNC_EXPLICIT_TOLERANCE_SEC) {
    return { decision: { type: "seek", target, rate }, state: previous };
  }

  return { decision: { type: "rate", rate }, state: previous };
}

type ProgrammaticSeek = (video: HTMLVideoElement, target: number) => void;

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

/** Shared phase-locked synchronizer used by both local-video surfaces. */
export class LocalVideoSynchronizer {
  private policy = initialVideoSyncPolicyState();

  sync(
    video: HTMLVideoElement,
    target: number,
    kind: VideoSyncKind,
    baseRate = 1,
    seek: ProgrammaticSeek = (element, position) => {
      element.currentTime = position;
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
      this.policy,
    );
    this.policy = result.state;
    this.applyRate(video, result.decision.rate);
    if (result.decision.type === "seek") seek(video, result.decision.target);
    return result.decision;
  }

  setBaseRate(video: HTMLVideoElement, baseRate = 1): void {
    this.applyRate(video, normalizedRate(baseRate));
  }

  reset(video?: HTMLVideoElement | null): void {
    this.policy = initialVideoSyncPolicyState();
    if (video) this.applyRate(video, 1);
  }

  dispose(): void {
    this.policy = initialVideoSyncPolicyState();
  }

  private applyRate(video: HTMLVideoElement, rate: number): void {
    if (Math.abs(video.playbackRate - rate) <= VIDEO_SYNC_RATE_EPSILON) return;
    video.playbackRate = rate;
  }
}
