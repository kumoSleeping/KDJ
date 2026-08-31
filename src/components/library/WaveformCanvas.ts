import type { Waveform as WaveformData } from "../../types";
import { waveformSourceRange } from "../../lib/waveformViewport";
import { waveformEdgeScales } from "../../lib/waveformRenderPolicy";
import {
  PERFORMANCE_DETAIL_BACKGROUND,
  PERFORMANCE_DETAIL_CONTRAST,
  RELEASE_OVERVIEW_CONTRAST,
  RELEASE_OVERVIEW_DARK_BACKGROUND,
  RELEASE_OVERVIEW_LIGHT_BACKGROUND,
  performanceDetailWaveformDisplayRgb,
  releaseOverviewWaveformDisplayRgb,
  waveformDisplayRgb,
  waveformSurfaceContrastRgb,
  type WaveformDisplayRgb,
} from "../../lib/waveformPalette";

export type WaveformCanvasProfile = "current" | "performance-detail" | "release-overview";

interface WaveformDrawBuffers {
  amp: Float32Array;
  minimum: Float32Array;
  maximum: Float32Array;
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
  transient: Uint8Array;
  known: Uint8Array;
  edgeScale: Float32Array;
}

// Live STEM/stream updates redraw an unchanged canvas many times. Reuse one screen-space buffer
// per canvas instead of allocating thousands of PixelColumn objects and two mapped arrays on each
// delta; ResizeObserver replaces it only when the actual rendered column count changes.
const waveformDrawBuffers = new WeakMap<HTMLCanvasElement, WaveformDrawBuffers>();

const srgbLinearLookup = Float32Array.from({ length: 256 }, (_, value) => {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
});

function drawBuffersFor(canvas: HTMLCanvasElement, width: number): WaveformDrawBuffers {
  const cached = waveformDrawBuffers.get(canvas);
  if (cached?.amp.length === width) return cached;
  const buffers: WaveformDrawBuffers = {
    amp: new Float32Array(width),
    minimum: new Float32Array(width),
    maximum: new Float32Array(width),
    r: new Uint8Array(width),
    g: new Uint8Array(width),
    b: new Uint8Array(width),
    transient: new Uint8Array(width),
    known: new Uint8Array(width),
    edgeScale: new Float32Array(width),
  };
  waveformDrawBuffers.set(canvas, buffers);
  return buffers;
}

function srgbToLinear(value: number): number {
  return srgbLinearLookup[Math.max(0, Math.min(255, Math.round(value)))] ?? 0;
}

function linearToSrgb(value: number): number {
  const normalized = Math.max(0, Math.min(1, value));
  const srgb = normalized <= 0.0031308
    ? normalized * 12.92
    : 1.055 * Math.pow(normalized, 1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
}

function contourAvailable(wave: WaveformData): boolean {
  const count = wave.amp.length;
  return count > 0
    && wave.minimum?.length === count
    && wave.maximum?.length === count
    && wave.transient?.length === count;
}

/**
 * Destination-pixel detail renderer. Analysis stays on the absolute 400 Hz source lattice, while
 * every bitmap column integrates the exact source-time interval covered by one physical display
 * pixel. This is temporal area sampling rather than horizontal blur: height retains the interval
 * peak and a detected core onset owns the colour instead of disappearing into its neighbours.
 */
function drawTargetDetailColumns(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  wave: WaveformData,
  known: ArrayLike<boolean | number> | undefined,
  timeStart: number | null,
  timeEnd: number | null,
  profile: WaveformCanvasProfile,
  amplitudeScale: number,
) {
  const count = wave.amp.length;
  const transient = wave.transient as ArrayLike<number> | undefined;
  const width = canvas.width;
  const height = canvas.height;
  const duration = Math.max(1e-9, wave.duration || 0);
  const [sourceStartSec, sourceEndSec] = waveformSourceRange(wave);
  const sourceSpanSec = Math.max(1e-9, sourceEndSec - sourceStartSec);
  const startSec = timeStart ?? 0;
  const endSec = timeEnd ?? duration;
  const spanSec = Math.max(1e-9, endSec - startSec);
  const mid = height / 2;
  const availableHalfHeight = Math.max(0.5, mid - 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const localSourceColumns = count * spanSec / sourceSpanSec;
  const magnifying = width >= localSourceColumns;

  for (let x = 0; x < width; x += 1) {
    const t0 = startSec + (x / width) * spanSec;
    const t1 = startSec + ((x + 1) / width) * spanSec;
    const center = (t0 + t1) / 2;
    if (t1 <= sourceStartSec || t0 >= sourceEndSec) continue;
    let displayAmp = 0;
    let linearR = 0;
    let linearG = 0;
    let linearB = 0;
    let colorWeight = 0;
    let displayTransient = 0;
    let coreStrength = -1;
    let coreR = 0;
    let coreG = 0;
    let coreB = 0;
    if (magnifying) {
      if (center < sourceStartSec || center >= sourceEndSec) continue;
      const source = Math.max(
        0,
        Math.min(count - 1, Math.floor((center - sourceStartSec) / sourceSpanSec * count)),
      );
      if (known && !known[source]) continue;
      displayAmp = Math.max(0, Math.min(1, wave.amp[source] ?? 0));
      linearR = srgbToLinear(wave.r[source] ?? 0);
      linearG = srgbToLinear(wave.g[source] ?? 0);
      linearB = srgbToLinear(wave.b[source] ?? 0);
      colorWeight = 1;
      displayTransient = Math.max(0, Math.min(1, (transient?.[source] ?? 0) / 255));
    } else {
      const sourceStart = Math.max(
        0,
        (Math.max(sourceStartSec, t0) - sourceStartSec) / sourceSpanSec * count,
      );
      const sourceEnd = Math.min(
        count,
        (Math.min(sourceEndSec, t1) - sourceStartSec) / sourceSpanSec * count,
      );
      const firstSource = Math.floor(sourceStart);
      const lastSource = Math.min(count, Math.ceil(sourceEnd));
      for (let source = firstSource; source < lastSource; source += 1) {
        if (known && !known[source]) continue;
        const overlap = Math.max(
          0,
          Math.min(sourceEnd, source + 1) - Math.max(sourceStart, source),
        );
        if (overlap <= 0) continue;
        const amplitude = Math.max(0, Math.min(1, wave.amp[source] ?? 0));
        displayAmp = Math.max(displayAmp, amplitude);
        const weight = overlap * (amplitude + 0.001);
        linearR += srgbToLinear(wave.r[source] ?? 0) * weight;
        linearG += srgbToLinear(wave.g[source] ?? 0) * weight;
        linearB += srgbToLinear(wave.b[source] ?? 0) * weight;
        colorWeight += weight;
        const onset = (transient?.[source] ?? 0) / 255;
        displayTransient = Math.max(displayTransient, onset);
        if (onset > coreStrength) {
          coreStrength = onset;
          coreR = wave.r[source] ?? 0;
          coreG = wave.g[source] ?? 0;
          coreB = wave.b[source] ?? 0;
        }
      }
    }
    if (colorWeight <= 0) continue;
    let sourceR = linearToSrgb(linearR / colorWeight);
    let sourceG = linearToSrgb(linearG / colorWeight);
    let sourceB = linearToSrgb(linearB / colorWeight);
    // A reliable onset is a measured source column, not an extra painted stripe. Selecting its
    // already-fused RGB merely prevents downsampling from averaging that fact away.
    if (coreStrength >= 0.20) {
      sourceR = coreR;
      sourceG = coreG;
      sourceB = coreB;
    }
    const paletteDisplay = profile === "performance-detail"
      ? performanceDetailWaveformDisplayRgb(
        sourceR,
        sourceG,
        sourceB,
        displayAmp,
        displayTransient,
      )
      : waveformDisplayRgb(sourceR, sourceG, sourceB, displayAmp);
    const display = profile === "performance-detail"
      ? waveformSurfaceContrastRgb(
        paletteDisplay,
        PERFORMANCE_DETAIL_BACKGROUND,
        PERFORMANCE_DETAIL_CONTRAST,
      )
      : paletteDisplay;
    const half = Math.max(
      0.5,
      displayAmp * amplitudeScale * availableHalfHeight,
    );
    const top = Math.max(0, Math.round(mid - half));
    const bottom = Math.min(height, Math.round(mid + half));
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgb(${display[0]},${display[1]},${display[2]})`;
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

/**
 * Keep the v0.2.41 solid column style. Each visible CSS pixel independently takes the median of
 * its own source-time interval. Adjacent intervals never overlap, so short outliers are omitted
 * without fitting high and low neighbours into circles or diamonds. Retina only refines edges.
 */
function drawReleaseOverviewColumns(
  ctx: CanvasRenderingContext2D,
  columns: WaveformDrawBuffers,
  width: number,
  cssWidth: number,
  mid: number,
  availableHalfHeight: number,
  edgeScales: ArrayLike<number> | null,
  background: WaveformDisplayRgb,
) {
  const columnWidth = cssWidth / width;
  for (let index = 0; index < width; index += 1) {
    if (!columns.known[index]) continue;
    // A known quiet interval still gets a one-CSS-pixel centre line. Without this floor, low
    // medians become sub-pixel antialiasing (or disappear entirely), making the overview look as
    // though that part of the track has no waveform.
    const half = Math.max(
      0.5,
      Math.max(0, Math.min(1, columns.amp[index]))
        * (edgeScales?.[index] ?? 1)
        * availableHalfHeight,
    );
    const colour = releaseOverviewWaveformDisplayRgb(
      columns.r[index],
      columns.g[index],
      columns.b[index],
    );
    const [r, g, b] = waveformSurfaceContrastRgb(
      colour,
      background,
      RELEASE_OVERVIEW_CONTRAST,
    );
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(index * columnWidth, mid - half, columnWidth + 0.01, half * 2);
  }
}

export function drawWaveformCanvas(
  canvas: HTMLCanvasElement,
  wave: WaveformData,
  cssWidth: number,
  cssHeight: number,
  known?: ArrayLike<boolean | number>,
  timeStart: number | null = null,
  timeEnd: number | null = null,
  profile: WaveformCanvasProfile = "current",
  amplitudeScale = 1,
) {
  const dpr = window.devicePixelRatio || 1;
  const backingWidth = Math.max(1, Math.round(cssWidth * dpr));
  const backingHeight = Math.max(1, Math.round(cssHeight * dpr));
  // Assigning either canvas dimension reallocates and clears the backing store. The old code did
  // that on every live STEM delta even when the rail size had not changed, synchronously flushing
  // several large canvases and occasionally starving the compositor transition.
  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // Full-track overview is a structure map, not an oscilloscope. It keeps the historical `amp`
  // envelope and non-overlapping median intervals; detail integrates into destination pixels.
  if (contourAvailable(wave) && profile !== "release-overview") {
    drawTargetDetailColumns(
      canvas,
      ctx,
      wave,
      known,
      timeStart,
      timeEnd,
      profile,
      Math.max(0, Math.min(1, amplitudeScale)),
    );
    return;
  }
  ctx.setTransform(canvas.width / cssWidth, 0, 0, canvas.height / cssHeight, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const n = wave.amp.length;
  if (n === 0) return;
  const mid = cssHeight / 2;
  const availableHalfHeight = Math.max(0.5, mid - 1);
  const releaseOverview = profile === "release-overview";
  const performanceDetail = profile === "performance-detail";
  // Release overview positions columns at backing-store density. Its signal bandwidth is still
  // limited to visible CSS-pixel intervals below, so Retina improves raster edges rather than
  // exposing sub-pixel transients that cannot carry useful full-track information.
  const renderWidth = releaseOverview
    ? Math.min(canvas.width, 4_096)
    : performanceDetail
      // The moving DJ bitmap must retain physical-pixel detail. Painting one column per CSS pixel
      // duplicates every edge on Retina and makes a normal 60 Hz step toggle whole 2px blocks.
      ? canvas.width
      : Math.min(cssWidth, canvas.width);
  const width = Math.max(1, Math.floor(renderWidth));
  const columnCssWidth = cssWidth / width;
  const waveDuration = wave.duration > 0 ? wave.duration : 0;
  const windowed = timeStart !== null
    && timeEnd !== null
    && timeEnd > timeStart
    && waveDuration > 0;

  const columns = drawBuffersFor(canvas, width);
  const columnAmp = columns.amp;
  const columnR = columns.r;
  const columnG = columns.g;
  const columnB = columns.b;
  const columnKnown = columns.known;
  const releasePreviewWidth = Math.max(1, Math.round(cssWidth));
  let cachedReleasePixel = -1;
  let cachedReleaseAmp = 0;
  let cachedReleaseR = 0;
  let cachedReleaseG = 0;
  let cachedReleaseB = 0;
  let cachedReleaseKnown = 0;
  for (let x = 0; x < width; x += 1) {
    let from: number;
    let to: number;
    if (releaseOverview && !windowed && n > releasePreviewWidth) {
      // Partition the song into non-overlapping logical-pixel intervals. Median rejects details
      // too short to represent at this scale, but unlike a moving average it never leaks one
      // interval into the next. Backing columns that belong to the same CSS pixel intentionally
      // repeat that one independent result.
      const pixel = Math.min(
        releasePreviewWidth - 1,
        Math.floor((x / width) * releasePreviewWidth),
      );
      if (pixel !== cachedReleasePixel) {
        const first = Math.floor((pixel * n) / releasePreviewWidth);
        const last = Math.min(
          n,
          Math.max(first + 1, Math.floor(((pixel + 1) * n) / releasePreviewWidth)),
        );
        const amplitudes: number[] = [];
        let r = 0;
        let g = 0;
        let b = 0;
        let colorWeight = 0;
        for (let index = first; index < last; index += 1) {
          if (known && !known[index]) continue;
          const value = wave.amp[index];
          amplitudes.push(value);
          const sampleWeight = value + 0.001;
          r += wave.r[index] * sampleWeight;
          g += wave.g[index] * sampleWeight;
          b += wave.b[index] * sampleWeight;
          colorWeight += sampleWeight;
        }
        amplitudes.sort((left, right) => left - right);
        const middle = Math.floor(amplitudes.length / 2);
        cachedReleasePixel = pixel;
        cachedReleaseAmp = amplitudes.length === 0
          ? 0
          : amplitudes.length % 2 === 0
            ? (amplitudes[middle - 1] + amplitudes[middle]) / 2
            : amplitudes[middle];
        cachedReleaseR = colorWeight > 0 ? Math.round(r / colorWeight) : 0;
        cachedReleaseG = colorWeight > 0 ? Math.round(g / colorWeight) : 0;
        cachedReleaseB = colorWeight > 0 ? Math.round(b / colorWeight) : 0;
        cachedReleaseKnown = amplitudes.length > 0 ? 1 : 0;
      }
      columnAmp[x] = cachedReleaseAmp;
      columnR[x] = cachedReleaseR;
      columnG[x] = cachedReleaseG;
      columnB[x] = cachedReleaseB;
      columnKnown[x] = cachedReleaseKnown;
      continue;
    }
    if (windowed) {
      const t0 = timeStart + (x / width) * (timeEnd - timeStart);
      const t1 = timeStart + ((x + 1) / width) * (timeEnd - timeStart);
      if (t1 <= 0 || t0 >= waveDuration) {
        columnAmp[x] = 0;
        columnR[x] = 0;
        columnG[x] = 0;
        columnB[x] = 0;
        columnKnown[x] = 0;
        continue;
      }
      from = Math.max(0, Math.floor((Math.max(0, t0) / waveDuration) * n));
      to = Math.min(n, Math.max(from + 1, Math.ceil((Math.min(waveDuration, t1) / waveDuration) * n)));
    } else if (width > n && !releaseOverview) {
      const source = width > 1 ? (x * (n - 1)) / (width - 1) : 0;
      const left = Math.max(0, Math.min(n - 1, Math.floor(source)));
      const right = Math.max(0, Math.min(n - 1, left + 1));
      const mix = source - left;
      const leftKnown = known === undefined || Boolean(known[left]);
      const rightKnown = known === undefined || Boolean(known[right]);
      if (!leftKnown && !rightKnown) {
        columnAmp[x] = 0;
        columnR[x] = 0;
        columnG[x] = 0;
        columnB[x] = 0;
        columnKnown[x] = 0;
        continue;
      }
      const sampleFrom = leftKnown ? left : right;
      const sampleTo = rightKnown ? right : left;
      const ratio = leftKnown && rightKnown ? mix : 0;
      columnAmp[x] = wave.amp[sampleFrom] + (wave.amp[sampleTo] - wave.amp[sampleFrom]) * ratio;
      columnR[x] = Math.round(wave.r[sampleFrom] + (wave.r[sampleTo] - wave.r[sampleFrom]) * ratio);
      columnG[x] = Math.round(wave.g[sampleFrom] + (wave.g[sampleTo] - wave.g[sampleFrom]) * ratio);
      columnB[x] = Math.round(wave.b[sampleFrom] + (wave.b[sampleTo] - wave.b[sampleFrom]) * ratio);
      columnKnown[x] = 1;
      continue;
    } else {
      from = Math.floor((x * n) / width);
      to = Math.max(from + 1, Math.floor(((x + 1) * n) / width));
    }

    let amp = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    let hasKnownSample = known === undefined;
    for (let i = from; i < to && i < n; i += 1) {
      if (known && !known[i]) continue;
      hasKnownSample = true;
      const value = wave.amp[i];
      if (value > amp) amp = value;
      // 颜色按幅度加权平均：安静帧的颜色本来就不可靠，不该和强拍平起平坐。
      const sampleWeight = value + 0.001;
      r += wave.r[i] * sampleWeight;
      g += wave.g[i] * sampleWeight;
      b += wave.b[i] * sampleWeight;
      weight += sampleWeight;
    }
    columnAmp[x] = amp;
    columnR[x] = weight > 0 ? Math.round(r / weight) : 0;
    columnG[x] = weight > 0 ? Math.round(g / weight) : 0;
    columnB[x] = weight > 0 ? Math.round(b / weight) : 0;
    columnKnown[x] = hasKnownSample && weight > 0 ? 1 : 0;
  }

  // 在线渐进波形的首/尾真实桶可能从静音基线一步跳到满高，视觉上会变成截图里
  // 那种整高竖墙。只给最外侧几列做屏幕空间包络；内部瞬态和 unknown 掩码不动。
  const edgeScales = known
    ? waveformEdgeScales(columnAmp, columnKnown, 4, 0.02, columns.edgeScale)
    : null;
  if (releaseOverview) {
    const background = typeof document !== "undefined"
      && document.documentElement?.dataset.theme === "light"
      ? RELEASE_OVERVIEW_LIGHT_BACKGROUND
      : RELEASE_OVERVIEW_DARK_BACKGROUND;
    drawReleaseOverviewColumns(
      ctx,
      columns,
      width,
      cssWidth,
      mid,
      availableHalfHeight,
      edgeScales,
      background,
    );
    return;
  }

  for (let x = 0; x < width; x += 1) {
    if (!columnKnown[x]) continue;
    let displayAmp = columnAmp[x];
    let sourceR = columnR[x];
    let sourceG = columnG[x];
    let sourceB = columnB[x];
    if (performanceDetail) {
      // A one-physical-pixel triangular footprint prevents neighbouring saturated RGB columns
      // from alternating as a translated bitmap crosses the display grid. Peak height still keeps
      // kicks and other short transients crisp; only their unstable colour edge is averaged.
      let red = 0;
      let green = 0;
      let blue = 0;
      let colorWeight = 0;
      for (let offset = -1; offset <= 1; offset += 1) {
        const index = x + offset;
        if (index < 0 || index >= width || !columnKnown[index]) continue;
        const kernel = offset === 0 ? 0.5 : 0.25;
        const weight = kernel * (0.2 + columnAmp[index]);
        displayAmp = Math.max(displayAmp, columnAmp[index]);
        red += columnR[index] * weight;
        green += columnG[index] * weight;
        blue += columnB[index] * weight;
        colorWeight += weight;
      }
      if (colorWeight > 0) {
        sourceR = Math.round(red / colorWeight);
        sourceG = Math.round(green / colorWeight);
        sourceB = Math.round(blue / colorWeight);
      }
    }
    const paletteDisplay = (performanceDetail
      ? performanceDetailWaveformDisplayRgb
      : waveformDisplayRgb)(
      sourceR,
      sourceG,
      sourceB,
      displayAmp,
    );
    const [displayR, displayG, displayB] = performanceDetail
      ? waveformSurfaceContrastRgb(
        paletteDisplay,
        PERFORMANCE_DETAIL_BACKGROUND,
        PERFORMANCE_DETAIL_CONTRAST,
      )
      : paletteDisplay;
    ctx.fillStyle = `rgb(${displayR},${displayG},${displayB})`;
    // 最小 1px：静音段也留一条中线，否则波形会断成几截看着像坏了
    const half = Math.max(
      0.5,
      displayAmp * (edgeScales?.[x] ?? 1) * availableHalfHeight,
    );
    ctx.fillRect(
      x * columnCssWidth,
      mid - half,
      columnCssWidth,
      half * 2,
    );
  }
}
