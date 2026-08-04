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

function smootherstep(value: number): number {
  const x = Math.min(1, Math.max(0, value));
  return x * x * x * (x * (x * 6 - 15) + 10);
}
