const MOTION_REGRESSION_TOLERANCE_SECONDS = 0.12;
const MOTION_FORWARD_LANDING_SECONDS = 0.3;
const MOTION_HARD_DISCONTINUITY_SECONDS = 1.25;
/** Plant jitter at a bake edge is still this window; a far seek is not. */
const WAVEFORM_ANIMATION_EDGE_SLACK_SEC = 0.05;

export function liveWaveformPlaybackRate(
  targetRate: number,
  audibleRate: number,
  scratchActive = false,
): number {
  const target = Number.isFinite(targetRate) && targetRate > 0 ? targetRate : null;
  void scratchActive;
  // Post-Rubber-Band PCM can trail a target change by its bounded output cushion. Advancing the
  // rail at target rate before those packets reach the DAC creates phase debt; touching the
  // platter then reveals it as a small snap. The callback-tagged audible rate is always the
  // timeline truth, including zero for a parked Deck and negative scratch motion.
  if (Number.isFinite(audibleRate)) return audibleRate;
  if (target != null) return target;
  return 1;
}

export function shouldRetargetLiveWaveformClock(
  _errorMs: number,
  _discontinuity: boolean,
): boolean {
  // PCM bake and beat-grid rail are separate Web Animations. Seeking currentTime on them
  // independently (or a second time after layout already landed) is the visible relative shake
  // on Play/Seek. Live clock may only change playbackRate; layout owns currentTime.
  return false;
}

/** Platter phase is landed once at grab (or a real source discontinuity), never every clock tick. */
export function shouldLandPlatterWaveform(
  wasActive: boolean,
  active: boolean,
  discontinuity: boolean,
): boolean {
  return active ? !wasActive || discontinuity : wasActive;
}

/**
 * Seek replacements briefly report not-playing while the landing is already the authority.
 * Pausing the compositor there freezes the rail; the next in-range sample then jumps currentTime
 * ahead of that freeze — a pause followed by a fast-forward.
 */
export function shouldPauseLiveWaveformClock(
  playing: boolean,
  scratchHeld: boolean,
  inRange: boolean,
  discontinuity: boolean,
  audibleRate = 0,
): boolean {
  if (playing) return false;
  // A held platter owns the needle even while Play is off. Only park the compositor when
  // the platter itself is still — otherwise scratch ticks keep audio moving with a frozen rail.
  if (scratchHeld && Math.abs(audibleRate) > 0.02) return false;
  if (Math.abs(audibleRate) > 0.02) return false;
  return inRange && !discontinuity;
}

/**
 * Presentation-time projection keeps a running rail aligned to the DAC.
 * Seeks and Play edges must land on the authority sample itself: projecting that sample by the
 * leftover output buffer is what shoves the waveform a little forward or back.
 */
export function liveWaveformAuthoritySeconds(
  currentTime: number,
  projectedSeconds: number,
  landRaw: boolean,
): number {
  if (landRaw) return currentTime;
  return projectedSeconds;
}

/** Project an audio-callback cursor onto `performance.now()` using the DAC-correlated timestamp. */
export function projectedLiveWaveformPosition(
  currentTime: number,
  clientPresentationTimeMs: number,
  nowMs: number,
  rate: number,
  duration: number,
): number {
  const current = Number.isFinite(currentTime) ? currentTime : 0;
  const presentation = Number.isFinite(clientPresentationTimeMs) ? clientPresentationTimeMs : nowMs;
  const now = Number.isFinite(nowMs) ? nowMs : presentation;
  // The event bridge should be well inside this bound. Limiting a bad device-clock sample keeps
  // a temporary mapping reset from becoming an apparent seek. Negative projection is valid when
  // the snapshot describes audio already queued for a future DAC time.
  const elapsed = Math.max(-0.25, Math.min(0.25, (now - presentation) / 1_000));
  const projected = current + elapsed * (Number.isFinite(rate) ? rate : 0);
  return Number.isFinite(duration) && duration > 0 ? Math.min(duration, projected) : projected;
}

/**
 * Map a live-clock sample onto a Web Animation's local timeline.
 *
 * Returns null when the sample is outside this effect. Clamping that sample to 0 or `duration`
 * is what made a far seek flash the waveform to the start or end of the *old* bake window
 * before layout rebuilt the canvas around the landing.
 */
export function liveWaveformAnimationTimeMs(
  sourceSeconds: number,
  animationSpanSec: number,
): number | null {
  if (!Number.isFinite(sourceSeconds) || !Number.isFinite(animationSpanSec) || animationSpanSec <= 0) {
    return null;
  }
  if (
    sourceSeconds < -WAVEFORM_ANIMATION_EDGE_SLACK_SEC
    || sourceSeconds > animationSpanSec + WAVEFORM_ANIMATION_EDGE_SLACK_SEC
  ) {
    return null;
  }
  return Math.max(0, Math.min(animationSpanSec, sourceSeconds)) * 1_000;
}

/** Local time for an infinitely repeating compositor loop. */
export function liveWaveformLoopAnimationTimeMs(
  sourceSeconds: number,
  loopStart: number,
  loopLength: number,
): number | null {
  if (
    !Number.isFinite(sourceSeconds)
    || !Number.isFinite(loopStart)
    || !Number.isFinite(loopLength)
    || loopLength <= 0
    || sourceSeconds < loopStart - WAVEFORM_ANIMATION_EDGE_SLACK_SEC
  ) return null;
  const relative = (sourceSeconds - loopStart) % loopLength;
  return (relative < 0 ? relative + loopLength : relative) * 1_000;
}

export interface WaveformMotionSample {
  trackId: number;
  position: number;
  duration: number;
  rate: number;
  playing: boolean;
  /** Scratches and explicit transport landings must follow the authority immediately. */
  discrete: boolean;
  /** Native SYNC/seek acknowledgement. A changed revision is an exact phase landing. */
  motionRevision?: number;
  /** Active native loop. Linear playback before loop-in remains valid; only loop-out wraps. */
  loopStart?: number | null;
  loopLength?: number | null;
}

export interface WaveformMotionClock {
  trackId: number;
  anchorPosition: number;
  anchorTimeMs: number;
  authoritativePosition: number;
  duration: number;
  rate: number;
  playing: boolean;
  motionRevision: number;
  loopStart: number | null;
  loopLength: number | null;
  /** True when this update represents a transport landing rather than continuous motion. */
  snapped: boolean;
}

function finiteNonNegative(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function normalizedRate(value: number): number {
  return Number.isFinite(value) ? value : 1;
}

function clampPosition(position: number, duration: number): number {
  const safe = Number.isFinite(position) ? position : 0;
  return duration > 0 ? Math.min(duration, safe) : safe;
}

function normalizedLoop(
  startValue: number | null | undefined,
  lengthValue: number | null | undefined,
  duration: number,
): { start: number; length: number } | null {
  if (
    typeof startValue !== "number"
    || typeof lengthValue !== "number"
    || !Number.isFinite(startValue)
    || !Number.isFinite(lengthValue)
    || startValue < 0
    || lengthValue <= 0
  ) return null;
  const start = clampPosition(startValue, duration);
  const end = duration > 0 ? Math.min(duration, start + lengthValue) : start + lengthValue;
  return end > start ? { start, length: end - start } : null;
}

export function loopedWaveformPosition(
  position: number,
  loopStart: number | null,
  loopLength: number | null,
): number {
  if (loopStart === null || loopLength === null || loopLength <= 0 || position < loopStart) {
    return position;
  }
  const relative = (position - loopStart) % loopLength;
  return loopStart + (relative < 0 ? relative + loopLength : relative);
}

function loopDistance(from: number, to: number, loopStart: number | null, loopLength: number | null): number {
  if (
    loopStart === null
    || loopLength === null
    || from < loopStart
    || to < loopStart
  ) return to - from;
  const direct = to - from;
  const wrapped = direct < 0 ? direct + loopLength : direct - loopLength;
  return Math.abs(wrapped) < Math.abs(direct) ? wrapped : direct;
}

export function waveformMotionClockPosition(
  clock: WaveformMotionClock,
  nowMs: number,
): number {
  if (!clock.playing) return clampPosition(clock.anchorPosition, clock.duration);
  const elapsed = Math.max(
    0,
    (finiteNonNegative(nowMs, clock.anchorTimeMs) - clock.anchorTimeMs) / 1_000,
  );
  return clampPosition(
    loopedWaveformPosition(
      clock.anchorPosition + elapsed * clock.rate,
      clock.loopStart,
      clock.loopLength,
    ),
    clock.duration,
  );
}

function snappedClock(sample: WaveformMotionSample, nowMs: number): WaveformMotionClock {
  const duration = finiteNonNegative(sample.duration);
  const loop = normalizedLoop(sample.loopStart, sample.loopLength, duration);
  const position = clampPosition(
    loopedWaveformPosition(sample.position, loop?.start ?? null, loop?.length ?? null),
    duration,
  );
  return {
    trackId: sample.trackId,
    anchorPosition: position,
    anchorTimeMs: finiteNonNegative(nowMs),
    authoritativePosition: position,
    duration,
    rate: normalizedRate(sample.rate),
    playing: sample.playing && !sample.discrete,
    motionRevision: sample.motionRevision ?? 0,
    loopStart: loop?.start ?? null,
    loopLength: loop?.length ?? null,
    snapped: true,
  };
}

/**
 * Convert the native Deck's sparse authority snapshots into a compositor clock.
 *
 * Ordinary samples leave the already-running native animation alone. In particular, clock error
 * is never converted into a temporary acceleration: that made SYNC visibly chase the other Deck
 * for seconds. Explicit native SYNC/seek revisions and real discontinuities land in one frame;
 * TEMPO only changes this clock's playback rate and can therefore compose with that phase jump.
 */
export function updateWaveformMotionClock(
  previous: WaveformMotionClock | null,
  sample: WaveformMotionSample,
  nowMs: number,
): WaveformMotionClock {
  const now = finiteNonNegative(nowMs);
  const duration = finiteNonNegative(sample.duration);
  const loop = normalizedLoop(sample.loopStart, sample.loopLength, duration);
  const position = clampPosition(
    loopedWaveformPosition(sample.position, loop?.start ?? null, loop?.length ?? null),
    duration,
  );
  const rate = normalizedRate(sample.rate);
  if (
    previous === null
    || previous.trackId !== sample.trackId
    || previous.motionRevision !== (sample.motionRevision ?? 0)
    || previous.loopStart !== (loop?.start ?? null)
    || previous.loopLength !== (loop?.length ?? null)
    || sample.discrete
    || !sample.playing
    || !previous.playing
  ) {
    return snappedClock({ ...sample, position, duration, rate }, now);
  }

  const predicted = waveformMotionClockPosition(previous, now);
  const authorityDelta = loopDistance(
    previous.authoritativePosition,
    position,
    previous.loopStart,
    previous.loopLength,
  );
  const error = loopDistance(predicted, position, previous.loopStart, previous.loopLength);
  const insideLoop = previous.loopStart !== null
    && previous.loopLength !== null
    && predicted >= previous.loopStart
    && predicted < previous.loopStart + previous.loopLength
    && position >= previous.loopStart
    && position < previous.loopStart + previous.loopLength;
  if (
    !insideLoop
    && (
      authorityDelta < -MOTION_REGRESSION_TOLERANCE_SECONDS
      || Math.abs(error) > MOTION_HARD_DISCONTINUITY_SECONDS
      || (error > MOTION_FORWARD_LANDING_SECONDS && authorityDelta > MOTION_FORWARD_LANDING_SECONDS)
    )
  ) {
    return snappedClock({ ...sample, position, duration, rate }, now);
  }

  return {
    trackId: sample.trackId,
    // Keep the exact phase already on screen. Sparse-snapshot error is neither a jump nor a
    // hidden pitch bend; the next explicit native transport revision remains authoritative.
    anchorPosition: predicted,
    anchorTimeMs: now,
    authoritativePosition: position,
    duration,
    rate,
    playing: true,
    motionRevision: sample.motionRevision ?? 0,
    loopStart: loop?.start ?? null,
    loopLength: loop?.length ?? null,
    snapped: false,
  };
}
