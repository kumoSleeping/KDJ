/**
 * Performance Decks may run through silent time before the first media frame so DJs can align a
 * downbeat at wall-clock zero. Compressed media still starts at 0; the native renderer owns this
 * bounded negative pre-roll timeline.
 */
export const PERFORMANCE_PREROLL_SECONDS = 30;

export function clampPerformanceDeckPosition(position: number, duration: number): number {
  const value = Number.isFinite(position) ? position : 0;
  const lower = -PERFORMANCE_PREROLL_SECONDS;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(lower, value);
  return Math.min(duration, Math.max(lower, value));
}
