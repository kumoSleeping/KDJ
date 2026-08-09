export const VIDEO_SYNC_EXPLICIT_TOLERANCE_SEC = 0.05;

const VIDEO_SYNC_RATE_EPSILON = 0.001;

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
