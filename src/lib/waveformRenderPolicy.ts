/**
 * Visual envelope for the first/last audible columns of a progressively known waveform.
 *
 * A fixed-width max bucket can jump from the 1px silence baseline to full height in one column.
 * That is truthful in time but renders as an artificial vertical wall. Tapering only the outermost
 * audible edge over a few screen pixels keeps internal transients untouched and never marks an
 * unknown bucket as known.
 */
export function waveformEdgeScales(
  amplitudes: readonly number[],
  known: readonly boolean[],
  edgePixels = 4,
  audibleThreshold = 0.02,
): number[] {
  const scales = Array(amplitudes.length).fill(1) as number[];
  let first = -1;
  let last = -1;
  for (let index = 0; index < amplitudes.length; index += 1) {
    if (!known[index] || (amplitudes[index] ?? 0) <= audibleThreshold) continue;
    if (first < 0) first = index;
    last = index;
  }
  if (first < 0 || last < 0 || first === last) return scales;

  const radius = Math.min(
    Math.max(0, Math.floor(edgePixels)),
    Math.floor((last - first + 1) / 2),
  );
  if (radius <= 0) return scales;

  for (let offset = 0; offset < radius; offset += 1) {
    const progress = (offset + 1) / (radius + 1);
    const scale = smootherstep(progress);
    scales[first + offset] = Math.min(scales[first + offset] ?? 1, scale);
    scales[last - offset] = Math.min(scales[last - offset] ?? 1, scale);
  }
  return scales;
}

/**
 * Locate the placeholder's source sample for one rendered pixel column.
 *
 * A DJ canvas can cover time before 0 or after the end of a track to keep its
 * playhead centered. The primary waveform correctly leaves those columns
 * unknown. A placeholder must use the same source-time window rather than
 * stretching its entire overview across the canvas, or it paints a phantom
 * waveform in that intentional blank lead-in/tail space.
 */
export function waveformPlaceholderSampleIndex(
  pixel: number,
  pixelCount: number,
  sampleCount: number,
  duration: number,
  sourceStart: number | null = null,
  sourceEnd: number | null = null,
): number | null {
  const pixels = Math.floor(pixelCount);
  const samples = Math.floor(sampleCount);
  const index = Math.floor(pixel);
  if (pixels <= 0 || samples <= 0 || index < 0 || index >= pixels) return null;

  if (sourceStart !== null || sourceEnd !== null) {
    if (
      sourceStart === null
      || sourceEnd === null
      || !Number.isFinite(sourceStart)
      || !Number.isFinite(sourceEnd)
      || sourceEnd <= sourceStart
      || !Number.isFinite(duration)
      || duration <= 0
    ) {
      return null;
    }
    const span = sourceEnd - sourceStart;
    const start = sourceStart + index / pixels * span;
    const end = sourceStart + (index + 1) / pixels * span;
    // Do not borrow an overview sample for the deliberately blank part of a
    // centered deck window. Sampling its first/last real pixel is sufficient
    // for the sub-pixel column that crosses a track boundary.
    if (end <= 0 || start >= duration) return null;
    const midpoint = Math.min(duration, Math.max(0, (start + end) / 2));
    return samples === 1 ? 0 : midpoint / duration * (samples - 1);
  }

  return samples === 1 ? 0 : index / Math.max(1, pixels - 1) * (samples - 1);
}

function smootherstep(value: number): number {
  const x = Math.min(1, Math.max(0, value));
  return x * x * x * (x * (x * 6 - 15) + 10);
}
