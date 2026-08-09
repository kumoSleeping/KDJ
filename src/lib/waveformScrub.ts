/** Convert a pointer's viewport X coordinate into a clamped waveform position. */
export function waveformScrubPosition(
  clientX: number,
  trackLeft: number,
  trackWidth: number,
  duration: number,
): number {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(trackLeft) ||
    !Number.isFinite(trackWidth) ||
    trackWidth <= 0 ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return 0;
  }
  const ratio = Math.min(1, Math.max(0, (clientX - trackLeft) / trackWidth));
  return ratio * duration;
}
