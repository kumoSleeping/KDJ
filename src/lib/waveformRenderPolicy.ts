/**
 * Visual envelope for the first/last audible columns of a progressively known waveform.
 *
 * A fixed-width max bucket can jump from the 1px silence baseline to full height in one column.
 * That is truthful in time but renders as an artificial vertical wall. Tapering only the outermost
 * audible edge over a few screen pixels keeps internal transients untouched and never marks an
 * unknown bucket as known.
 */
export function waveformEdgeScales(
  amplitudes: ArrayLike<number>,
  known: ArrayLike<boolean | number>,
  edgePixels?: number,
  audibleThreshold?: number,
): number[];
export function waveformEdgeScales<T extends Float32Array | Float64Array>(
  amplitudes: ArrayLike<number>,
  known: ArrayLike<boolean | number>,
  edgePixels: number,
  audibleThreshold: number,
  output: T,
): T;
export function waveformEdgeScales(
  amplitudes: ArrayLike<number>,
  known: ArrayLike<boolean | number>,
  edgePixels = 4,
  audibleThreshold = 0.02,
  output?: Float32Array | Float64Array,
): number[] | Float32Array | Float64Array {
  if (output && output.length !== amplitudes.length) {
    throw new RangeError("waveform edge-scale buffer length does not match the rendered width");
  }
  const scales = output ?? new Array<number>(amplitudes.length);
  scales.fill(1);
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
 * The requested surface owns the display profile. Online previews and local tracks shown in the
 * same bottom-bar overview must use the same aggregation and palette; progressive coverage may
 * still be incomplete, but known columns must not change visual language by source type.
 */
export function waveformUsesReleaseOverviewPalette(
  requestedProfile: "current" | "release-overview",
): boolean {
  return requestedProfile === "release-overview";
}

/**
 * The compromise-height performance rail keeps 70% of its vertical range at neutral trim,
 * preserving the old waveform thickness while adding visible headroom. GAIN uses its real
 * −24…+6 dB linear multiplier; boosted peaks that exceed the remaining room clip at the rail edge
 * instead of changing the horizontal time scale.
 */
export function performanceWaveformAmplitudeScale(gain: number): number {
  const normalized = Math.min(1, Math.max(-1, Number.isFinite(gain) ? gain : 0));
  const trimDb = normalized < 0 ? normalized * 24 : normalized * 6;
  return Math.min(1, 0.7 * 10 ** (trimDb / 20));
}

function smootherstep(value: number): number {
  const x = Math.min(1, Math.max(0, value));
  return x * x * x * (x * (x * 6 - 15) + 10);
}
