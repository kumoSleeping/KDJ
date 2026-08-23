import type { Waveform } from "../types";

const WAVEFORM_COLUMNS_PER_SECOND = 100;
const MIN_DETAIL_WAVEFORM_BUCKETS = 2_000;
const MAX_DETAIL_WAVEFORM_BUCKETS = 24_000;
export const PERFORMANCE_WAVEFORM_SECONDS_PER_SCREEN = 30;
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
export const PERFORMANCE_WAVEFORM_SCRATCH_SMOOTHING_MS = 32;
/** A fast physical spin can accumulate a whole bar between two animation frames. */
export const PERFORMANCE_WAVEFORM_SCRATCH_MAX_STEP_SECONDS = 8;

/**
 * Performance 波形固定屏幕移动速度。引擎位置按 playback rate 推进，因此可视的
 * “曲目秒数”也按同一倍率缩放：rate 越高，一屏包含的源音频越多，每个拍格越窄；
 * rate 越低则相反。这样 rate / viewport 始终不变，两台 Deck 每秒移动同样像素。
 *
 * 这只应改内层 CSS `scaleX`，不得重绘波形 backing store，也不得改外层
 * 位移轨道的宽度。PCM 柱是源时间轴上的固定图；TEMPO 变化等于绕播放头缩放。
 */
export function performanceWaveformViewportSeconds(playbackRate: number): number {
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  return PERFORMANCE_WAVEFORM_SECONDS_PER_SCREEN * rate;
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
  const position = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  const runway = Number.isFinite(runwayMs) ? Math.max(0, runwayMs) : 0;
  const projected = position + rate * runway / 1_000;
  return duration > 0 ? Math.min(duration, projected) : projected;
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
    Math.max(MIN_DETAIL_WAVEFORM_BUCKETS, Math.ceil(durationSec * WAVEFORM_COLUMNS_PER_SECOND)),
  );
}

/**
 * 从 Deck 高密度 master 派生整曲概览。高度按时间面积平均，不能用屏幕像素峰值，
 * 否则每个 300–500ms 概览桶总能碰到一个鼓点，整首就会变成顶满的实心带。
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
  for (let target = 0; target < columns; target += 1) {
    const start = target * sourceLength / columns;
    const end = (target + 1) * sourceLength / columns;
    const first = Math.floor(start);
    const last = Math.min(sourceLength, Math.ceil(end));
    let amplitudeSum = 0;
    let area = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    let colorWeight = 0;
    for (let source = first; source < last; source += 1) {
      const overlap = Math.max(0, Math.min(end, source + 1) - Math.max(start, source));
      if (overlap <= 0) continue;
      const value = Math.min(1, Math.max(0, wave.amp[source] ?? 0));
      amplitudeSum += value * overlap;
      area += overlap;
      const weight = overlap * (value + 0.001);
      red += (wave.r[source] ?? 0) * weight;
      green += (wave.g[source] ?? 0) * weight;
      blue += (wave.b[source] ?? 0) * weight;
      colorWeight += weight;
    }
    const fallback = Math.min(sourceLength - 1, first);
    amp.push(area > 0 ? amplitudeSum / area : wave.amp[fallback] ?? 0);
    r.push(colorWeight > 0 ? Math.round(red / colorWeight) : wave.r[fallback] ?? 0);
    g.push(colorWeight > 0 ? Math.round(green / colorWeight) : wave.g[fallback] ?? 0);
    b.push(colorWeight > 0 ? Math.round(blue / colorWeight) : wave.b[fallback] ?? 0);
  }
  return { track_id: wave.track_id, duration: wave.duration, amp, r, g, b };
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
  return Math.min(duration, Math.max(0, layout.viewStartSec + ratio * span));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
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

  const position = clamp(positionSec, 0, duration);
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
 * Sliding window for the DJ canvas. Pixels are baked in a TEMPO-independent
 * 1× track-time window; SYNC / fader zoom is CSS `scaleX` around the playhead.
 * Rebuilding on every rate tick used to freeze both STEM rails at once.
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
  const windowSec = PERFORMANCE_WAVEFORM_SECONDS_PER_SCREEN * PERFORMANCE_WAVEFORM_BAKE_SCREENS;
  const position = Number.isFinite(positionSec) ? (positionSec as number) : 0;
  if (
    previous
    && Math.abs(previous.durationSec - duration) < 1e-6
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
