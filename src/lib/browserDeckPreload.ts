/**
 * Pure policy shared by the Web Audio deck preloader and its tests.
 *
 * Keeping these decisions outside `djMix.ts` is intentional: that module creates real media
 * elements at import time, while the timing rules below should stay testable without a browser.
 */

export interface PreparedBrowserDeck {
  deckIndex: 0 | 1;
  trackId: number;
  source: string;
}

export interface RequestedBrowserDeck extends PreparedBrowserDeck {}

export interface ExternalAdoptionKey {
  generation: number;
  deckIndex: 0 | 1;
  source: string;
}

/**
 * Native output stays at full scale until the Web Audio copy is proven audible. During that
 * overlap the copy is capped at -21.9 dB, bounding even perfectly coherent summing below +0.67 dB.
 */
export const EXTERNAL_HANDOFF_OVERLAP_GAIN = 0.08;
/** Ignore implausible driver reports while still covering playback-sized Android buffers. */
const MAX_EXTERNAL_OUTPUT_LATENCY_S = 1;
/** Some Android WebViews expose neither outputLatency nor a useful baseLatency. */
export const ANDROID_EXTERNAL_OUTPUT_LATENCY_FLOOR_S = 0.1;

/** Zero-slope curve used for the short capped-overlap and final takeover ramps. */
export function externalHandoffGain(
  stage: "overlap" | "takeover",
  progress: number,
): number {
  const x = Math.min(1, Math.max(0, progress));
  const shaped = x * x * (3 - 2 * x);
  return stage === "overlap"
    ? shaped * EXTERNAL_HANDOFF_OVERLAP_GAIN
    : EXTERNAL_HANDOFF_OVERLAP_GAIN + shaped * (1 - EXTERNAL_HANDOFF_OVERLAP_GAIN);
}

/**
 * AudioParam automation runs on the context timeline, not at the speaker. Before muting an
 * external owner we must allow both the Web Audio render quantum (`baseLatency`) and the device
 * queue (`outputLatency`) to drain. The sum is deliberately conservative: a slightly longer
 * -21.9 dB overlap is bounded, while releasing even one buffer too early creates a dropout.
 */
export function externalHandoffPhysicalDelayMs(
  baseLatencySeconds: number | null | undefined,
  outputLatencySeconds: number | null | undefined,
  curveSeconds: number,
  settleMs: number,
  minimumLatencySeconds = 0,
): number {
  const finitePositive = (value: number | null | undefined) =>
    Number.isFinite(value) && (value ?? 0) > 0 ? (value as number) : 0;
  const effectiveLatency = Math.min(
    MAX_EXTERNAL_OUTPUT_LATENCY_S,
    Math.max(
      finitePositive(minimumLatencySeconds),
      finitePositive(baseLatencySeconds) + finitePositive(outputLatencySeconds),
    ),
  );
  const curve = Math.max(0, finitePositive(curveSeconds));
  const settle = Number.isFinite(settleMs) ? Math.max(0, settleMs) : 0;
  // Round each independently so floating-point representation can never shave a millisecond
  // from the safety margin (and does not invent one for exact 20+80+6+4ms inputs).
  return Math.ceil(effectiveLatency * 1000) + Math.ceil(curve * 1000) + Math.ceil(settle);
}

/** A prepared element is reusable only when the physical deck and resolved media URL agree. */
export function canReusePreparedBrowserDeck(
  prepared: PreparedBrowserDeck | null,
  requested: RequestedBrowserDeck,
): boolean {
  return Boolean(
    prepared &&
      prepared.deckIndex === requested.deckIndex &&
      prepared.trackId === requested.trackId &&
      prepared.source === requested.source,
  );
}

/**
 * While Rust is the audible owner, Web Audio needs one deck for the current local song and one
 * for the predicted online song. If the prediction already occupies the back deck, adopting the
 * Rust clock must use the current/front deck rather than overwrite the buffered prediction.
 */
export function shouldPreservePreparedBackDeck(
  prepared: PreparedBrowserDeck | null,
  frontIndex: 0 | 1,
  adoptedSource: string,
): boolean {
  if (!prepared) return false;
  const backIndex: 0 | 1 = frontIndex === 0 ? 1 : 0;
  return prepared.deckIndex === backIndex && prepared.source !== adoptedSource;
}

/** Reassigning currentTime, even to the same value, can discard a media element's Range buffer. */
export function needsPreparedCueSeek(currentTime: number, cue: number): boolean {
  return !Number.isFinite(currentTime) || Math.abs(currentTime - cue) > 0.05;
}

/** Project the still-playing external owner while Web Audio loads and seeks its local copy. */
export function projectedExternalPosition(
  capturedPosition: number,
  elapsedMs: number,
  rate: number,
): number {
  const safePosition = Number.isFinite(capturedPosition) ? Math.max(0, capturedPosition) : 0;
  const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return safePosition + (safeElapsed / 1000) * safeRate;
}

/** The browser shadow must be this close to the still-audible native clock before takeover. */
export const EXTERNAL_CLOCK_TOLERANCE_S = 0.04;

export function externalClockAligned(
  mediaPosition: number,
  projectedPosition: number,
): boolean {
  return (
    Number.isFinite(mediaPosition) &&
    Number.isFinite(projectedPosition) &&
    Math.abs(mediaPosition - projectedPosition) <= EXTERNAL_CLOCK_TOLERANCE_S
  );
}

/** At most two Range re-seeks chase the external clock. A stale final seek must fail, never play. */
export function shouldRecalibrateExternalClock(
  mediaPosition: number,
  projectedPosition: number,
  calibrations: number,
): boolean {
  return calibrations < 2 && !externalClockAligned(mediaPosition, projectedPosition);
}

/**
 * Lead time reserved for the native command queue plus one callback. Browser gain automation
 * must be scheduled this much *before* asking Rust to mute: WebAudio's long output queue then
 * reaches the speaker just as the native queue drains, rather than leaving only the -21.9 dB
 * shadow copy audible for a full browser-latency period.
 */
export function externalNativeReleaseSettleMs(platform: string | null | undefined): number {
  return platform === "android" ? 32 : 24;
}

/** A stale async cleanup must never pause a deck that a newer transition has already adopted. */
export function ownsExternalAdoption(
  handle: ExternalAdoptionKey,
  currentGeneration: number,
  frontIndex: 0 | 1,
  currentSource: string,
): boolean {
  return (
    handle.generation === currentGeneration &&
    handle.deckIndex === frontIndex &&
    handle.source === currentSource
  );
}
