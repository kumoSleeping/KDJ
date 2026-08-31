import type { Waveform } from "../types";

/** Absolute source-time lattice shared by stored detail assets and live playback windows. */
export const DETAIL_WAVEFORM_COLUMNS_PER_SECOND = 400;
const MIN_DETAIL_WAVEFORM_BUCKETS = 2_000;
const MAX_DETAIL_WAVEFORM_BUCKETS = 100_000;
export const PERFORMANCE_WAVEFORM_SECONDS_PER_SCREEN = 30;
/** Manager detail panel favors closer beat-level inspection over Performance's wider runway. */
export const MANAGER_WAVEFORM_SECONDS_PER_SCREEN = 6;
/** Baked DJ canvas covers this many screens so CSS can interpolate between 100ms snapshots. */
export const PERFORMANCE_WAVEFORM_BAKE_SCREENS = 3;
/**
 * Native Deck snapshots normally arrive every 100 ms, but a canvas commit, STEM update, or WebView
 * scheduling pause can make one edge late. The transform target is projected by this same amount,
 * so the longer compositor runway does not add visual latency; it only prevents a missed snapshot
 * from exhausting the animation and visibly stopping the rail.
 */
export const PERFORMANCE_WAVEFORM_SMOOTHING_MS = 240;
/** A held platter publishes visual targets at animation-frame cadence, not the 100ms audio clock. */
export const PERFORMANCE_WAVEFORM_SCRATCH_SMOOTHING_MS = 16;
/** A fast physical spin can accumulate a whole bar between two animation frames. */
export const PERFORMANCE_WAVEFORM_SCRATCH_MAX_STEP_SECONDS = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/**
 * Performance zoom is a source-time scale, not a transport-rate control.
 *
 * Rekordbox/Mixxx-style rails keep the PCM and beat lattice fixed while TEMPO changes their
 * velocity under the needle. Scaling the viewport on every fader packet made React zoom the rail
 * at the requested rate while the DAC clock updated its translation at the audible rate. Those
 * two owners produced a visible stop/start cadence on an otherwise idle Deck.
 *
 * Keep the argument for the stable public helper used by callers/tests, but deliberately ignore
 * it until zoom becomes an explicit user preference.
 */
export function performanceWaveformViewportSeconds(_playbackRate: number): number {
  return PERFORMANCE_WAVEFORM_SECONDS_PER_SCREEN;
}

export function managerWaveformViewportSeconds(_playbackRate: number): number {
  return MANAGER_WAVEFORM_SECONDS_PER_SCREEN;
}

/**
 * Native request width for the Manager detail rail.
 *
 * Always request the same margin used by the coverage predicate. A non-zero local or online cue
 * can then backfill both visible sides with one stable random-access generation instead of
 * cancelling a narrow first pass for a wider second one.
 */
export function managerWaveformRequestSeconds(
  viewportSeconds: number,
  renewalMarginSeconds: number,
): number {
  const viewport = Number.isFinite(viewportSeconds) ? Math.max(0, viewportSeconds) : 0;
  const margin = Number.isFinite(renewalMarginSeconds)
    ? Math.max(0, renewalMarginSeconds)
    : 0;
  return viewport + margin * 2;
}

export interface ManagerWaveformRasterGeometry {
  /** Absolute display-pixel index on the track-time lattice. */
  firstPixel: number;
  /** Exclusive absolute display-pixel index on the track-time lattice. */
  lastPixel: number;
  startSec: number;
  endSec: number;
  spanSec: number;
  backingWidth: number;
  cssWidth: number;
  pixelsPerSecond: number;
}

/**
 * Raster geometry for the Manager rail, anchored to absolute track time.
 *
 * Analysis remains on its lossless 400 Hz lattice, but the bitmap has exactly one column per
 * destination physical pixel. Anchoring the destination lattice at track time zero means two
 * overlapping rolling windows partition the same kick into the same display columns, so a window
 * renewal cannot make an already-visible transient shimmer merely because its left edge moved.
 */
export function managerWaveformRasterGeometry(
  sourceStartSeconds: number,
  sourceEndSeconds: number,
  viewportCssWidth: number,
  devicePixelRatio: number,
  viewportSeconds: number,
): ManagerWaveformRasterGeometry {
  const sourceStart = Number.isFinite(sourceStartSeconds)
    ? Math.max(0, sourceStartSeconds)
    : 0;
  const sourceEnd = Number.isFinite(sourceEndSeconds)
    ? Math.max(sourceStart, sourceEndSeconds)
    : sourceStart;
  const width = Number.isFinite(viewportCssWidth) ? Math.max(0, viewportCssWidth) : 0;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const viewport = Number.isFinite(viewportSeconds) ? Math.max(0, viewportSeconds) : 0;
  const pixelsPerSecond = width > 0 && viewport > 0 ? width * dpr / viewport : 0;
  if (pixelsPerSecond <= 0 || sourceEnd <= sourceStart) {
    return {
      firstPixel: 0,
      lastPixel: 0,
      startSec: sourceStart,
      endSec: sourceEnd,
      spanSec: sourceEnd - sourceStart,
      backingWidth: 0,
      cssWidth: 0,
      pixelsPerSecond,
    };
  }

  // The epsilon keeps an endpoint that is already on a display-pixel boundary from growing a
  // duplicate edge column because of floating-point multiplication noise.
  const epsilon = 1.0e-9;
  const firstPixel = Math.floor(sourceStart * pixelsPerSecond + epsilon);
  const lastPixel = Math.max(
    firstPixel + 1,
    Math.ceil(sourceEnd * pixelsPerSecond - epsilon),
  );
  const backingWidth = lastPixel - firstPixel;
  const startSec = firstPixel / pixelsPerSecond;
  const endSec = lastPixel / pixelsPerSecond;
  return {
    firstPixel,
    lastPixel,
    startSec,
    endSec,
    spanSec: endSec - startSec,
    backingWidth,
    cssWidth: backingWidth / dpr,
    pixelsPerSecond,
  };
}

export function waveformSourceRange(waveform: Waveform): [number, number] {
  const duration = Number.isFinite(waveform.duration) ? Math.max(0, waveform.duration) : 0;
  const start = Number.isFinite(waveform.source_start)
    ? Math.max(0, Math.min(duration, waveform.source_start as number))
    : 0;
  const end = Number.isFinite(waveform.source_end)
    ? Math.max(start, Math.min(duration, waveform.source_end as number))
    : duration;
  return [start, end];
}

function waveformViewportRange(
  durationSeconds: number,
  positionSeconds: number,
  viewportSeconds: number,
  marginSeconds: number,
): [number, number] {
  const duration = Math.max(0, durationSeconds || 0);
  const position = duration > 0
    ? Math.max(0, Math.min(duration, positionSeconds))
    : Math.max(0, positionSeconds);
  const half = Math.max(0, viewportSeconds) * 0.5;
  const margin = Math.max(0, marginSeconds);
  return [
    Math.max(0, position - half - margin),
    duration > 0
      ? Math.min(duration, position + half + margin)
      : position + half + margin,
  ];
}

function knownRangeState(
  waveform: Waveform,
  rangeStart: number,
  rangeEnd: number,
): "none" | "partial" | "complete" {
  const known = waveform.known;
  if (!known || known.length !== waveform.amp.length) return "complete";
  const [sourceStart, sourceEnd] = waveformSourceRange(waveform);
  const span = sourceEnd - sourceStart;
  if (span <= 0 || rangeEnd <= rangeStart) return "none";
  const overlapStart = Math.max(sourceStart, rangeStart);
  const overlapEnd = Math.min(sourceEnd, rangeEnd);
  if (overlapEnd <= overlapStart) return "none";
  const count = waveform.amp.length;
  const first = Math.max(
    0,
    Math.min(count - 1, Math.floor(((overlapStart - sourceStart) / span) * count)),
  );
  const last = Math.max(
    first + 1,
    Math.min(count, Math.ceil(((overlapEnd - sourceStart) / span) * count)),
  );
  let seen = false;
  let missing = false;
  for (let index = first; index < last; index += 1) {
    if (known[index]) {
      seen = true;
    } else {
      missing = true;
    }
  }
  if (!seen) return "none";
  return missing ? "partial" : "complete";
}

/** Crop a full-song detail asset without stretching its source-time columns. */
export function waveformWindowFromFullDetail(
  waveform: Waveform,
  centerSeconds: number,
  windowSeconds: number,
): Waveform | null {
  const duration = Number.isFinite(waveform.duration) ? Math.max(0, waveform.duration) : 0;
  const count = waveform.amp.length;
  if (
    duration <= 0
    || count === 0
    || waveform.r.length !== count
    || waveform.g.length !== count
    || waveform.b.length !== count
  ) return null;
  const center = Math.max(0, Math.min(duration, centerSeconds));
  const half = Math.max(0, windowSeconds) * 0.5;
  const desiredStart = Math.max(0, center - half);
  const desiredEnd = Math.min(duration, center + half);
  const first = Math.max(0, Math.min(count - 1, Math.floor((desiredStart / duration) * count)));
  const last = Math.max(
    first + 1,
    Math.min(count, Math.ceil((desiredEnd / duration) * count)),
  );
  const hasContour = waveform.minimum?.length === count
    && waveform.maximum?.length === count
    && waveform.transient?.length === count;
  return {
    track_id: waveform.track_id,
    duration,
    source_start: first / count * duration,
    source_end: last / count * duration,
    amp: waveform.amp.slice(first, last),
    minimum: hasContour ? waveform.minimum?.slice(first, last) : undefined,
    maximum: hasContour ? waveform.maximum?.slice(first, last) : undefined,
    r: waveform.r.slice(first, last),
    g: waveform.g.slice(first, last),
    b: waveform.b.slice(first, last),
    transient: hasContour ? waveform.transient?.slice(first, last) : undefined,
    known: waveform.known?.length === count
      ? waveform.known.slice(first, last)
      : undefined,
  };
}

/** Whether any bounded PCM is currently visible in the centred Manager interval. */
export function waveformIntersectsViewport(
  waveform: Waveform | null,
  trackId: number,
  positionSeconds: number,
  viewportSeconds: number,
): boolean {
  if (!waveform || waveform.track_id !== trackId || waveform.amp.length === 0) return false;
  const [desiredStart, desiredEnd] = waveformViewportRange(
    waveform.duration,
    positionSeconds,
    viewportSeconds,
    0,
  );
  const [sourceStart, sourceEnd] = waveformSourceRange(waveform);
  return sourceStart < desiredEnd
    && sourceEnd > desiredStart
    && knownRangeState(waveform, desiredStart, desiredEnd) !== "none";
}

/** Whether a bounded PCM asset owns the complete visible interval plus renewal margin. */
export function waveformCoversViewport(
  waveform: Waveform | null,
  trackId: number,
  positionSeconds: number,
  viewportSeconds: number,
  renewalMarginSeconds = 0,
): boolean {
  if (!waveform || waveform.track_id !== trackId || waveform.amp.length === 0) return false;
  const [desiredStart, desiredEnd] = waveformViewportRange(
    waveform.duration,
    positionSeconds,
    viewportSeconds,
    renewalMarginSeconds,
  );
  const [sourceStart, sourceEnd] = waveformSourceRange(waveform);
  // A live window is canonicalised to the whole-track 400 Hz lattice before publication. Its
  // first/last *complete* cell can sit less than one lattice step inside the PCM snapshot even
  // though the requested viewport is covered. Treat only that sub-column trim as equivalent;
  // larger gaps still renew the native window.
  const gridTolerance = 1 / DETAIL_WAVEFORM_COLUMNS_PER_SECOND + 1e-6;
  return sourceStart <= desiredStart + gridTolerance
    && sourceEnd + gridTolerance >= desiredEnd
    && knownRangeState(waveform, desiredStart, desiredEnd) === "complete";
}

/**
 * Project an authoritative transport sample to the end of its compositor runway.
 *
 * A transition aimed at the sample itself is already stale when React commits it. Retargeting
 * that transition every 100 ms makes the rail alternately decelerate and stop whenever one native
 * event is delayed. A linear target equally far in the future keeps the rail at the engine rate,
 * while every later snapshot still corrects the clock. Seeks/scratches bypass this helper.
 */
export function projectedWaveformPosition(
  positionSec: number,
  durationSec: number,
  playbackRate: number,
  runwayMs = PERFORMANCE_WAVEFORM_SMOOTHING_MS,
): number {
  const duration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  const position = Number.isFinite(positionSec) ? positionSec : 0;
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  const runway = Number.isFinite(runwayMs) ? Math.max(0, runwayMs) : 0;
  const projected = position + rate * runway / 1_000;
  if (duration > 0 && projected > duration) return duration;
  return projected;
}

/**
 * Suppress a tiny backwards clock correction while a Deck is otherwise walking forward.
 *
 * Decoder/STEM source promotion can quantize the same logical cursor to a nearby audio frame.
 * Rendering that harmless correction with `transition: none` creates a very visible one-frame
 * reverse kick. Real rewinds, loop wraps, paused seeks, and platter motion remain untouched.
 */
export function stabilizedWaveformPosition(
  previousPosition: number | null,
  position: number | null,
  movingForward: boolean,
  maxRegressionSeconds = 0.12,
): number | null {
  if (
    !movingForward
    || previousPosition === null
    || position === null
    || !Number.isFinite(previousPosition)
    || !Number.isFinite(position)
  ) {
    return position;
  }
  const maxRegression = Number.isFinite(maxRegressionSeconds)
    ? Math.max(0, maxRegressionSeconds)
    : 0;
  const regression = previousPosition - position;
  return regression > 0 && regression <= maxRegression ? previousPosition : position;
}

/** Full-track master density used by the local DJ viewport. */
export function detailWaveformBuckets(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return MIN_DETAIL_WAVEFORM_BUCKETS;
  return Math.min(
    MAX_DETAIL_WAVEFORM_BUCKETS,
    Math.max(
      MIN_DETAIL_WAVEFORM_BUCKETS,
      Math.ceil(durationSec * DETAIL_WAVEFORM_COLUMNS_PER_SECOND),
    ),
  );
}

/**
 * 从 Deck 高密度 master 派生整曲概览。高度和服务端统一为 80% RMS + 20% peak：
 * RMS 避免每个 300–500ms 桶碰到鼓点就顶满，少量 peak 则保留可辨认的瞬态。
 * 颜色仍按响度加权，保留低/中/高的细节变化。
 */
export function overviewWaveformFromDetail(wave: Waveform, requestedColumns: number): Waveform {
  const sourceLength = wave.amp.length;
  const columns = Math.max(1, Math.round(requestedColumns));
  if (
    sourceLength <= columns ||
    sourceLength === 0 ||
    wave.r.length !== sourceLength ||
    wave.g.length !== sourceLength ||
    wave.b.length !== sourceLength
  ) return wave;

  const amp: number[] = [];
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const hasContour = wave.minimum?.length === sourceLength
    && wave.maximum?.length === sourceLength
    && wave.transient?.length === sourceLength;
  const minimum: number[] = [];
  const maximum: number[] = [];
  const transient: number[] = [];
  for (let target = 0; target < columns; target += 1) {
    const start = target * sourceLength / columns;
    const end = (target + 1) * sourceLength / columns;
    const first = Math.floor(start);
    const last = Math.min(sourceLength, Math.ceil(end));
    let peak = 0;
    let squareSum = 0;
    let amplitudeWeight = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    let colorWeight = 0;
    let lower = 0;
    let upper = 0;
    let onset = 0;
    for (let source = first; source < last; source += 1) {
      const overlap = Math.max(0, Math.min(end, source + 1) - Math.max(start, source));
      if (overlap <= 0) continue;
      const value = Math.min(1, Math.max(0, wave.amp[source] ?? 0));
      peak = Math.max(peak, value);
      squareSum += value * value * overlap;
      amplitudeWeight += overlap;
      const weight = overlap * (value + 0.001);
      red += (wave.r[source] ?? 0) * weight;
      green += (wave.g[source] ?? 0) * weight;
      blue += (wave.b[source] ?? 0) * weight;
      colorWeight += weight;
      if (hasContour) {
        lower = Math.min(lower, wave.minimum?.[source] ?? 0);
        upper = Math.max(upper, wave.maximum?.[source] ?? 0);
        onset = Math.max(onset, wave.transient?.[source] ?? 0);
      }
    }
    const fallback = Math.min(sourceLength - 1, first);
    const rms = amplitudeWeight > 0 ? Math.sqrt(squareSum / amplitudeWeight) : peak;
    amp.push(Math.min(1, Math.max(0, rms * 0.8 + peak * 0.2)));
    r.push(colorWeight > 0 ? Math.round(red / colorWeight) : wave.r[fallback] ?? 0);
    g.push(colorWeight > 0 ? Math.round(green / colorWeight) : wave.g[fallback] ?? 0);
    b.push(colorWeight > 0 ? Math.round(blue / colorWeight) : wave.b[fallback] ?? 0);
    if (hasContour) {
      minimum.push(lower);
      maximum.push(upper);
      transient.push(onset);
    }
  }
  return {
    track_id: wave.track_id,
    duration: wave.duration,
    amp,
    minimum: hasContour ? minimum : undefined,
    maximum: hasContour ? maximum : undefined,
    r,
    g,
    b,
    transient: hasContour ? transient : undefined,
  };
}

export interface WaveformViewportLayout {
  active: boolean;
  /** Combined visual scale (`baseRailScale * tempoScaleX`), kept for pointer math. */
  railScale: number;
  /**
   * TEMPO-independent CSS width of the moving rail, as a multiple of the host.
   * Position interpolation lives on this layer so a fader move cannot retarget it.
   */
  baseRailScale: number;
  /**
   * Horizontal zoom around the playhead (`30 / viewportSeconds` = `1 / rate`).
   * Applied on an inner layer; never mixed into the translating transform.
   */
  tempoScaleX: number;
  railTranslatePercent: number;
  playheadPercent: number;
  viewStartSec: number;
  viewEndSec: number;
}

/**
 * Map a pointer X coordinate onto the visible waveform.
 *
 * DJ rails keep the playhead centered, so 50% is the current transport time and
 * the left/right edges are `viewportSeconds / 2` away. Full-track overviews
 * (no viewport) fall back to a linear 0…duration mapping.
 */
export function waveformPointerSeconds(
  clientX: number,
  trackLeft: number,
  trackWidth: number,
  durationSec: number,
  positionSec: number,
  viewportSeconds: number | null,
): number {
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (
    duration <= 0
    || !Number.isFinite(clientX)
    || !Number.isFinite(trackLeft)
    || !Number.isFinite(trackWidth)
    || trackWidth <= 0
  ) {
    return 0;
  }
  const ratio = Math.min(1, Math.max(0, (clientX - trackLeft) / trackWidth));
  const layout = waveformViewportLayout(duration, positionSec, viewportSeconds);
  if (!layout.active) return ratio * duration;
  const span = layout.viewEndSec - layout.viewStartSec;
  return layout.viewStartSec + ratio * span;
}

/**
 * Place a beat on a painted range (bake window or visible viewport).
 *
 * Mixxx / Rekordbox keep one absolute lattice: at −5 s the needle is 50% and bar 1
 * (t = 0) sits to its right. Mapping beats onto 0…duration and clipping `left < 0`
 * is what redrew 1/2/3 on top of the song.
 */
export function beatMarkerRangePercent(
  positionSec: number,
  rangeStartSec: number,
  rangeEndSec: number,
): number {
  const span = rangeEndSec - rangeStartSec;
  if (!(span > 0) || !Number.isFinite(positionSec)) return 50;
  return ((positionSec - rangeStartSec) / span) * 100;
}

/**
 * DJ 波形窗口：整轨波形作为一条横向轨道移动，播放线始终留在视口正中。
 * 曲首/曲尾不钳制窗口，留出的空白能保证播放线不会为了贴边而移动。
 */
export function waveformViewportLayout(
  durationSec: number,
  positionSec: number | null,
  viewportSeconds: number | null,
): WaveformViewportLayout {
  const duration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  const viewport = viewportSeconds !== null && Number.isFinite(viewportSeconds)
    ? Math.max(0, viewportSeconds)
    : 0;
  if (duration <= 0 || positionSec === null || !Number.isFinite(positionSec) || viewport <= 0) {
    const ratio = duration > 0 && positionSec !== null
      ? clamp(positionSec / duration, 0, 1)
      : 0;
    return {
      active: false,
      railScale: 1,
      baseRailScale: 1,
      tempoScaleX: 1,
      railTranslatePercent: 0,
      playheadPercent: ratio * 100,
      viewStartSec: 0,
      viewEndSec: duration,
    };
  }

  // Performance pre-roll leaves the track before 0 under the fixed center needle. Mixxx / Serato
  // paint that lead-in as part of the same absolute timeline, so bar numbers continue backward
  // instead of lifting the song and redrawing 1/2/3.
  const position = Math.min(duration, positionSec);
  // 不得限制为固定最大 zoom。旧的 12x 上限会让 3 分钟和 8 分钟曲目分别显示
  // 不同秒数，从而即使 rate 相同，波形也以不同像素速度移动。Canvas 自己限制
  // backing store；这里必须忠实保留调用方请求的时间窗口。
  const railScale = Math.max(1, duration / viewport);
  const baseRailScale = Math.max(1, duration / PERFORMANCE_WAVEFORM_SECONDS_PER_SCREEN);
  const tempoScaleX = railScale / baseRailScale;
  const visibleSeconds = duration / railScale;
  return {
    active: true,
    railScale,
    baseRailScale,
    tempoScaleX,
    railTranslatePercent: (position / duration) * 100,
    playheadPercent: 50,
    viewStartSec: position - visibleSeconds / 2,
    viewEndSec: position + visibleSeconds / 2,
  };
}

export interface WaveformBakeWindow {
  startSec: number;
  endSec: number;
  viewportSeconds: number;
  durationSec: number;
  /** CSS width of the baked canvas as a multiple of the host. */
  widthScale: number;
  /** Playhead location along the baked canvas, percent of that canvas. */
  translatePercent: number;
}

/** Translate a fixed bake range so the requested source time sits under the center needle. */
export function waveformBakeTranslatePercent(
  bake: WaveformBakeWindow,
  positionSec: number | null,
): number {
  const span = bake.endSec - bake.startSec;
  const position = Number.isFinite(positionSec) ? (positionSec as number) : bake.startSec;
  return span > 0 ? ((position - bake.startSec) / span) * 100 : 50;
}

/**
 * Whether a VSync-owned transform needs its first write or a later position update.
 *
 * The initial sentinel is `NaN`. Comparing `Math.abs(next - NaN)` is always false, which used to
 * leave both native rails permanently at their untransformed CSS origin. Keep the finite guard in
 * this shared helper so a future epsilon optimisation cannot silently reintroduce that freeze.
 */
export function shouldWriteWaveformTransform(
  previousPercent: number,
  nextPercent: number,
  epsilon = 1.0e-7,
): boolean {
  return Number.isFinite(nextPercent)
    && (
      !Number.isFinite(previousPercent)
      || Math.abs(nextPercent - previousPercent) > Math.max(0, epsilon)
    );
}

/**
 * A rebake replaces the canvas pixels with a different source-time range. Its translate must
 * land synchronously: interpolating from the old range would briefly put the newly painted
 * playhead nearly a whole screen away from the fixed needle.
 *
 * The caller must compare against the last range committed to the DOM, rather than a value
 * mutated during React render. Render work may be restarted before it is committed.
 */
export function waveformBakeRangeChanged(
  previous: WaveformBakeWindow | null,
  next: WaveformBakeWindow | null,
): boolean {
  return Boolean(
    previous
    && next
    && (
      Math.abs(previous.startSec - next.startSec) >= 1e-6
      || Math.abs(previous.endSec - next.endSec) >= 1e-6
      || Math.abs(previous.durationSec - next.durationSec) >= 1e-6
    ),
  );
}

/**
 * Sliding window for the DJ canvas. The source-time window is baked at the requested viewport
 * scale, so Manager's 5.5-second detail rail and Performance's 30-second rail both remain native
 * backing-store pixels instead of stretching the same 30-second bitmap with CSS.
 */
export function waveformBakeWindow(
  durationSec: number,
  positionSec: number | null,
  viewportSeconds: number,
  previous: WaveformBakeWindow | null,
): WaveformBakeWindow {
  const displayView = Number.isFinite(viewportSeconds) && viewportSeconds > 0
    ? viewportSeconds
    : PERFORMANCE_WAVEFORM_SECONDS_PER_SCREEN;
  const duration = Number.isFinite(durationSec) ? durationSec : 0;
  const windowSec = displayView * PERFORMANCE_WAVEFORM_BAKE_SCREENS;
  const position = Number.isFinite(positionSec) ? (positionSec as number) : 0;
  if (
    previous
    && Math.abs(previous.durationSec - duration) < 1e-6
    && Math.abs(previous.viewportSeconds - displayView) < 1e-6
    && previous.endSec - previous.startSec > 0
  ) {
    const visibleHalf = displayView / 2;
    const slack = PERFORMANCE_WAVEFORM_SECONDS_PER_SCREEN * 0.08;
    if (
      position - visibleHalf >= previous.startSec + slack
      && position + visibleHalf <= previous.endSec - slack
    ) {
      return {
        ...previous,
        viewportSeconds: displayView,
        translatePercent: waveformBakeTranslatePercent(previous, position),
      };
    }
    // Empty time before frame 0 has no PCM. Mixxx keeps t=0 painted at a stable canvas
    // coordinate and just translates further left; recentering here lifted the song and
    // redrew the 1/2/3 grid on top of it.
    const viewEnd = position + visibleHalf;
    const audibleStart = Math.max(0, position - visibleHalf);
    const audibleEnd = duration > 0 ? Math.min(duration, viewEnd) : viewEnd;
    const needsAudiblePixels = audibleEnd > audibleStart;
    const audibleStillBaked = !needsAudiblePixels
      || (audibleStart >= previous.startSec && audibleEnd <= previous.endSec);
    if (viewEnd <= previous.endSec - slack && audibleStillBaked) {
      return {
        ...previous,
        viewportSeconds: displayView,
        translatePercent: waveformBakeTranslatePercent(previous, position),
      };
    }
  }
  const start = position - windowSec / 2;
  return {
    startSec: start,
    endSec: start + windowSec,
    viewportSeconds: displayView,
    durationSec: duration,
    widthScale: PERFORMANCE_WAVEFORM_BAKE_SCREENS,
    translatePercent: 50,
  };
}

/**
 * Keep the CSS rail transition alive for ordinary same-track clock samples.
 * The UI pause intent can flip before the media clock reaches its final time;
 * animation therefore depends on clock continuity, not on a separate playing flag.
 *
 * TEMPO zoom lives on a separate `scaleX` layer, so a rate change must not
 * cancel this translate interpolation — that is what made the rail stutter.
 */
export function shouldAnimateWaveformRail(
  viewportActive: boolean,
  previousTrackId: number | null,
  trackId: number,
  previousPosition: number | null,
  position: number | null,
  maxStepSeconds = 1.25,
  allowReverse = false,
): boolean {
  if (
    !viewportActive ||
    previousTrackId !== trackId ||
    previousPosition === null ||
    position === null ||
    !Number.isFinite(previousPosition) ||
    !Number.isFinite(position)
  ) {
    return false;
  }
  const delta = position - previousPosition;
  return (allowReverse ? Math.abs(delta) : delta) <= maxStepSeconds && (allowReverse || delta >= 0);
}
