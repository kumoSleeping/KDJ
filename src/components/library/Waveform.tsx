import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  cachedWaveform,
  loadWaveformForTrack,
  loadWaveformById,
  streamWaveformSnapshot,
  subscribeStreamWaveform,
  updateStreamWaveform,
  type StreamWaveformSnapshot,
} from "../../lib/waveformCache";
import type { CuePoint, Track, Waveform as WaveformData } from "../../types";
import {
  cueColor,
  cueNearTime,
  cueTitle,
  hotCueLabel,
  waveformLoopRegions,
} from "../../lib/cuePoints";
import { isOneLibraryPlaybackTrack } from "../../lib/playbackTrackSource";
import { waveformEdgeScales, waveformPlaceholderSampleIndex } from "../../lib/waveformRenderPolicy";
import {
  PERFORMANCE_WAVEFORM_SMOOTHING_MS,
  PERFORMANCE_WAVEFORM_SCRATCH_MAX_STEP_SECONDS,
  PERFORMANCE_WAVEFORM_SCRATCH_SMOOTHING_MS,
  projectedWaveformPosition,
  shouldAnimateWaveformRail,
  stabilizedWaveformPosition,
  waveformBakeTranslatePercent,
  waveformBakeWindow,
  waveformBakeRangeChanged,
  waveformPointerSeconds,
  waveformViewportLayout,
  type WaveformBakeWindow,
} from "../../lib/waveformViewport";
import { beatGridMarkers } from "../../lib/performanceCues";
import { barPhaseAlignedSeek } from "../../lib/beatGridSync";
import { ContextMenu } from "../common";

/** 点波形跳转：PlayerBar 监听它，和 kd:play / kd:position 一套约定。 */
export const SEEK_EVENT = "kd:seek";
/** Let a newly loaded Deck paint/respond before upgrading its cached 640-column preview. */
const DETAIL_WAVEFORM_IDLE_DELAY_MS = 750;
export interface SeekDetail {
  trackId: number;
  position: number;
  /** 拖动中的视觉预览不启动解码；松手或键盘操作时才真正跳转。 */
  preview?: boolean;
  /**
   * scrub 手势边界：pointerdown 发 true，pointerup（随正式跳转）/pointercancel
   * 发 false。拖动期间 PlayerBar 压制权威时钟，不把播放头从手底下顶回去。
   */
  scrubbing?: boolean;
  /** 同一次手势的最终落点不能被媒体同步回声去重吞掉。 */
  forceCommit?: boolean;
}

/**
 * Serato / Rekordbox 那种彩色波形。
 *
 * 模型来自 libdjwaveform：**一列 = 一根柱子**，高度是这一列的响度，
 * 颜色是这一列的频谱构成（红=低频鼓组、绿=中频人声、蓝=高频镲片）。
 * 后端 `/api/library/waveform` 已经把每列的 amp + rgb 算好，这里只负责画。
 *
 * 用 canvas 而不是 SVG：几百到上千根柱子如果各是一个 <rect>，
 * 光是 DOM 节点就够让曲库切曲卡一下；canvas 一次 fillRect 循环画完。
 */
export interface WaveformProps {
  trackId: number;
  /** 负数 id 不再等同于在线试听；OneLibrary 需要这份来源快照加载外置文件波形。 */
  track?: Track | null;
  /** 播放位置（秒）。传 null 就不画播放头。 */
  position?: number | null;
  /** 波形尚未返回时用于进度条跳转的媒体时长（秒）。 */
  duration?: number;
  /** 开始点（毫秒）。有值时顶部画主题色小三角。 */
  cueMs?: number | null;
  /** 结束点（毫秒）。有值时顶部画主题色小三角。 */
  endMs?: number | null;
  /** DJ 软件写入的标准 Cue / Loop；仅展示，不参与现有起止点操作。 */
  cuePoints?: readonly CuePoint[];
  /** 现场 Loop 窗口（秒）。有值时在波形上铺一层预览，对上 Cue Loop 则改用该 Cue 色。 */
  loopStart?: number | null;
  loopLength?: number | null;
  /**
   * 右键设起止点。返回错误文案则菜单旁提示；返回 void/空串表示成功。
   * 不传则不挂右键菜单。
   */
  onSetPoint?: (kind: "start" | "end", positionSec: number) => void | string | Promise<void | string>;
  height?: number;
  /** 已播部分压暗，凸显未播部分（底部进度条用）。 */
  dimPlayed?: boolean;
  /** 点击是否跳转。 */
  seekable?: boolean;
  /** 自定义 scrub 接收器；用于非当前 Deck，避免错误派发全局播放跳转。 */
  onSeek?: (detail: Omit<SeekDetail, "trackId">) => void;
  /**
   * 自动对拍：按下时记下当前小节相位，点击/拖动松手落到被点小节内的同一相位。
   * 关掉或没有网格时仍是精确落点。
   */
  preserveBarPhase?: boolean;
  /** 按分析 BPM / 首拍绘制拍线；每四拍加重为小节线。 */
  showBeatGrid?: boolean;
  /** 请求的波形采样列数；演出视图使用高精度档，普通预览保持默认值。 */
  buckets?: number;
  /** DJ 局部窗口（秒）。有值时播放线固定居中，整条波形轨道在其下方移动。 */
  viewportSeconds?: number | null;
  /** Deck 真实走带意图；局部波形用它把稀疏时钟样本投影到合成器时间线。 */
  playing?: boolean;
  /** 曲目时间相对墙钟的推进倍率。仅在局部波形走带时使用。 */
  playbackRate?: number;
  className?: string;
  /** Precomputed alternate lane (for example one SCNet stem); bypasses the library waveform API. */
  waveform?: WaveformData;
  /** Empty vertical space reserved above and below the rendered columns (0..0.45 each side). */
  verticalInsetRatio?: number;
  /** 低于该幅度（0..1）的列直接留空，不画 1px 中线；分轨车道用来隐藏纯底噪段。 */
  silenceThreshold?: number;
  /** 未分析到的列改用这份波形（主轨）的淡化版顶替，表示“正在分析中”。 */
  placeholder?: WaveformData | null;
  /** 整轨透明度：分轨车道跟随分轨音量，静音时最淡但不消失。 */
  opacity?: number;
  /** A held hardware platter may move backward at frame rate; interpolate both directions. */
  interactiveScrub?: boolean;
  /** Skip CSS rail interpolation for this paint — SYNC/seek landings must not slide then bounce. */
  snapRail?: boolean;
}

function draw(
  canvas: HTMLCanvasElement,
  wave: WaveformData,
  cssWidth: number,
  cssHeight: number,
  known?: readonly boolean[],
  verticalInsetRatio = 0,
  silenceThreshold = 0,
  placeholder?: WaveformData | null,
  timeStart: number | null = null,
  timeEnd: number | null = null,
) {
  const dpr = window.devicePixelRatio || 1;
  // 局部 DJ 轨道会比视口宽数倍；限制 backing store，避免长曲在 Retina 屏上
  // 超过 WebKit 的 canvas 尺寸上限。CSS 仍保持完整时间尺度。
  const maxBackingWidth = 16_384;
  const backingWidth = Math.max(1, Math.min(maxBackingWidth, Math.round(cssWidth * dpr)));
  const backingHeight = Math.max(1, Math.round(cssHeight * dpr));
  // Assigning either canvas dimension reallocates and clears the backing store. The old code did
  // that on every live STEM delta even when the rail size had not changed, synchronously flushing
  // several large canvases and occasionally starving the compositor transition.
  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(canvas.width / cssWidth, 0, 0, canvas.height / cssHeight, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const n = wave.amp.length;
  if (n === 0) return;
  const mid = cssHeight / 2;
  const inset = Math.min(0.45, Math.max(0, verticalInsetRatio)) * cssHeight;
  const availableHalfHeight = Math.max(0.5, mid - inset - 1);
  const width = Math.max(1, Math.floor(Math.min(cssWidth, canvas.width)));
  const columnCssWidth = cssWidth / width;
  const waveDuration = wave.duration > 0 ? wave.duration : 0;
  const windowed = timeStart !== null
    && timeEnd !== null
    && timeEnd > timeStart
    && waveDuration > 0;

  interface PixelColumn {
    amp: number;
    r: number;
    g: number;
    b: number;
    known: boolean;
  }
  const columns: PixelColumn[] = [];
  for (let x = 0; x < width; x += 1) {
    let from: number;
    let to: number;
    if (windowed) {
      const t0 = timeStart + (x / width) * (timeEnd - timeStart);
      const t1 = timeStart + ((x + 1) / width) * (timeEnd - timeStart);
      if (t1 <= 0 || t0 >= waveDuration) {
        columns.push({ amp: 0, r: 0, g: 0, b: 0, known: false });
        continue;
      }
      from = Math.max(0, Math.floor((Math.max(0, t0) / waveDuration) * n));
      to = Math.min(n, Math.max(from + 1, Math.ceil((Math.min(waveDuration, t1) / waveDuration) * n)));
    } else if (width > n) {
      const source = width > 1 ? (x * (n - 1)) / (width - 1) : 0;
      const left = Math.max(0, Math.min(n - 1, Math.floor(source)));
      const right = Math.max(0, Math.min(n - 1, left + 1));
      const mix = source - left;
      const leftKnown = known === undefined || Boolean(known[left]);
      const rightKnown = known === undefined || Boolean(known[right]);
      if (!leftKnown && !rightKnown) {
        columns.push({ amp: 0, r: 0, g: 0, b: 0, known: false });
        continue;
      }
      const from = leftKnown ? left : right;
      const to = rightKnown ? right : left;
      const ratio = leftKnown && rightKnown ? mix : 0;
      columns.push({
        amp: wave.amp[from] + (wave.amp[to] - wave.amp[from]) * ratio,
        r: Math.round(wave.r[from] + (wave.r[to] - wave.r[from]) * ratio),
        g: Math.round(wave.g[from] + (wave.g[to] - wave.g[from]) * ratio),
        b: Math.round(wave.b[from] + (wave.b[to] - wave.b[from]) * ratio),
        known: true,
      });
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
    columns.push({
      amp,
      r: weight > 0 ? Math.round(r / weight) : 0,
      g: weight > 0 ? Math.round(g / weight) : 0,
      b: weight > 0 ? Math.round(b / weight) : 0,
      known: hasKnownSample && weight > 0,
    });
  }

  // 在线渐进波形的首/尾真实桶可能从静音基线一步跳到满高，视觉上会变成截图里
  // 那种整高竖墙。只给最外侧几列做屏幕空间包络；内部瞬态和 unknown 掩码不动。
  const edgeScales = known
    ? waveformEdgeScales(
        columns.map((column) => column.amp),
        columns.map((column) => column.known),
      )
    : null;
  for (let x = 0; x < columns.length; x += 1) {
    const column = columns[x];
    if (!column.known) {
      // 未分析到的列：有占位主波形就画它的淡化版，表示“正在分析中”；
      // 否则交给 DOM 下层的流媒体渐变轨道，不拿灰柱或随机柱冒充波形。
      if (placeholder && placeholder.amp.length > 0) {
        const pn = placeholder.amp.length;
        const placeholderDuration = placeholder.duration > 0 ? placeholder.duration : waveDuration;
        const source = waveformPlaceholderSampleIndex(
          x,
          width,
          pn,
          placeholderDuration,
          windowed ? timeStart : null,
          windowed ? timeEnd : null,
        );
        // DJ 窗口在曲首/曲尾本来就会露出超出曲目的空白。这里绝不能拿整首
        // overview 去填它，否则左/右半边会凭空出现一段彩色“波形”。
        if (source === null) continue;
        const pl = Math.max(0, Math.min(pn - 1, Math.floor(source)));
        const pr = Math.max(0, Math.min(pn - 1, pl + 1));
        const pm = source - pl;
        const pAmp = placeholder.amp[pl] + (placeholder.amp[pr] - placeholder.amp[pl]) * pm;
        if (pAmp > 0.01) {
          const half = Math.max(0.5, pAmp * availableHalfHeight);
          const prr = Math.round(placeholder.r[pl] + (placeholder.r[pr] - placeholder.r[pl]) * pm);
          const pgg = Math.round(placeholder.g[pl] + (placeholder.g[pr] - placeholder.g[pl]) * pm);
          const pbb = Math.round(placeholder.b[pl] + (placeholder.b[pr] - placeholder.b[pl]) * pm);
          ctx.globalAlpha = 0.3;
          ctx.fillStyle = `rgb(${prr},${pgg},${pbb})`;
          ctx.fillRect(x * columnCssWidth, mid - half, columnCssWidth, half * 2);
          ctx.globalAlpha = 1;
        }
      }
      continue;
    }
    if (silenceThreshold > 0 && column.amp <= silenceThreshold) {
      // 分轨车道里“这段没有这个乐器”只剩底噪；留空，不画成一条平线假装有内容。
      continue;
    }
    ctx.fillStyle = `rgb(${column.r},${column.g},${column.b})`;
    // 最小 1px：静音段也留一条中线，否则波形会断成几截看着像坏了
    const half = Math.max(
      0.5,
      column.amp * (edgeScales?.[x] ?? 1) * availableHalfHeight,
    );
    ctx.fillRect(x * columnCssWidth, mid - half, columnCssWidth, half * 2);
  }
}

function markerRatio(ms: number | null | undefined, totalSec: number): number | null {
  if (ms == null || totalSec <= 0) return null;
  return Math.min(1, Math.max(0, ms / 1000 / totalSec));
}

function timeRatio(timeSec: number, totalSec: number): number | null {
  if (!Number.isFinite(timeSec) || totalSec <= 0) return null;
  return Math.min(1, Math.max(0, timeSec / totalSec));
}

function loopRegionStyle(start: number, end: number, color: string): CSSProperties {
  return {
    left: `${start * 100}%`,
    width: `${Math.max(0, end - start) * 100}%`,
    "--kd-cue-color": color,
  } as CSSProperties;
}

function cueMarkerStyle(at: number, color: string): CSSProperties {
  return {
    left: `${at * 100}%`,
    "--kd-cue-color": color,
  } as CSSProperties;
}

/** 半透明 Loop 区间。Beat grid 应画在这层上面，Cue 三角竖线再盖上来。 */
export function WaveformLoopFills({
  total,
  cuePoints = [],
  loopStart = null,
  loopLength = null,
}: {
  total: number;
  cuePoints?: readonly CuePoint[];
  loopStart?: number | null;
  loopLength?: number | null;
}) {
  if (total <= 0) return null;
  return (
    <>
      {waveformLoopRegions(cuePoints, loopStart, loopLength).map((region) => {
        const start = timeRatio(region.startSec, total);
        const end = timeRatio(region.endSec, total);
        if (start === null || end === null || end <= start) return null;
        return (
          <span
            key={region.key}
            className="kd-wave-cue-loop"
            data-active={region.active || undefined}
            style={loopRegionStyle(start, end, region.color)}
            aria-hidden="true"
          />
        );
      })}
    </>
  );
}

/** Cue 点：上下三角 + 竖线。普通 Loop 只有色带，不画 Cue 锚点。 */
export function WaveformCueMarkers({
  total,
  cuePoints = [],
}: {
  total: number;
  cuePoints?: readonly CuePoint[];
}) {
  if (total <= 0) return null;
  return (
    <>
      {cuePoints.map((cue) => {
        const at = markerRatio(cue.start_ms, total);
        if (at === null) return null;
        const hot = hotCueLabel(cue.hot_cue);
        return (
          <span
            key={`cue:${cue.id}`}
            className="kd-wave-cue"
            data-kind={hot ? "hot" : "memory"}
            data-loop={cue.end_ms !== null ? "true" : undefined}
            style={cueMarkerStyle(at, cueColor(cue))}
            title={cueTitle(cue)}
            aria-hidden="true"
          />
        );
      })}
      {cuePoints.map((cue) => {
        if (cue.end_ms === null || cue.end_ms <= cue.start_ms) return null;
        const end = markerRatio(cue.end_ms, total);
        if (end === null || cueNearTime(cuePoints, cue.end_ms / 1_000) !== undefined) return null;
        return (
          <span
            key={`cue:${cue.id}:end`}
            className="kd-wave-cue"
            data-kind="loop-end"
            style={cueMarkerStyle(end, cueColor(cue))}
            aria-hidden="true"
          />
        );
      })}
    </>
  );
}

/** 校验起止点并生成 patch；不合法返回中文原因。 */
export function pointPatch(
  kind: "start" | "end",
  positionSec: number,
  cueMs: number | null | undefined,
  endMs: number | null | undefined,
): { cue_ms: number } | { end_ms: number } | string {
  const ms = Math.max(0, Math.round(positionSec * 1000));
  if (kind === "start") {
    if (endMs != null && ms >= endMs) return "开始点必须早于结束点";
    return { cue_ms: ms };
  }
  if (cueMs != null && ms <= cueMs) return "结束点必须晚于开始点";
  return { end_ms: ms };
}

export function Waveform({
  trackId,
  track = null,
  position = null,
  duration = 0,
  cueMs = null,
  endMs = null,
  cuePoints = [],
  loopStart = null,
  loopLength = null,
  onSetPoint,
  height = 56,
  dimPlayed = false,
  seekable = true,
  onSeek,
  preserveBarPhase = false,
  showBeatGrid = false,
  buckets = 640,
  viewportSeconds = null,
  playing = false,
  playbackRate = 1,
  className,
  waveform: providedWaveform,
  verticalInsetRatio = 0,
  silenceThreshold = 0,
  placeholder = null,
  opacity,
  interactiveScrub = false,
  snapRail = false,
}: WaveformProps) {
  const oneLibraryTrack =
    track?.id === trackId && isOneLibraryPlaybackTrack(track) ? track : null;
  const progressiveStream = trackId < 0 && oneLibraryTrack === null;
  const [wave, setWave] = useState<WaveformData | null>(() =>
    providedWaveform ?? cachedWaveform(trackId, buckets),
  );
  const [streamSnapshot, setStreamSnapshot] = useState<StreamWaveformSnapshot | null>(() =>
    progressiveStream ? streamWaveformSnapshot(trackId) : null,
  );
  const [error, setError] = useState("");
  // 右键设点永远取当时正在播放的位置，不能让鼠标点到波形哪里就误落到哪里。
  const [menu, setMenu] = useState<{ x: number; y: number; position: number } | null>(null);
  const [menuError, setMenuError] = useState("");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const bakeRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previousTrackRef = useRef(trackId);
  const previousPositionRef = useRef<number | null>(position);
  /**
   * Last bake range that actually reached the DOM. Do not write this while rendering: a React
   * render may be restarted, and then a rebake can be mistaken for an ordinary 100ms movement.
   */
  const committedBakeWindowRef = useRef<WaveformBakeWindow | null>(null);
  const customSeekRef = useRef(onSeek);
  const draggingRef = useRef(false);
  const previewFrameRef = useRef<number | null>(null);
  const previewPositionRef = useRef(0);
  const phaseAnchorRef = useRef<number | null>(null);
  const preserveBarPhaseRef = useRef(preserveBarPhase);
  const gridRef = useRef({ bpm: track?.bpm ?? null, firstBeat: track?.first_beat ?? null });
  const [railAnimationReady, setRailAnimationReady] = useState(
    () => document.visibilityState === "visible",
  );

  useEffect(() => {
    const syncVisibility = () => {
      const visible = document.visibilityState === "visible";
      setRailAnimationReady(visible);
      // Only an actually hidden document discards interpolation history. A visible Tauri window
      // may lose keyboard focus while remaining on another monitor; treating blur as background
      // disabled every 90 ms rail interpolation and made its 100 ms native clock visibly step.
      previousPositionRef.current = null;
    };
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, []);

  useEffect(
    () => () => {
      if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
    },
    [],
  );

  const dispatchSeek = (
    nextPosition: number,
    preview = false,
    scrubbing?: boolean,
    forceCommit = false,
  ) => {
    const detail = { position: nextPosition, preview, scrubbing, forceCommit };
    if (onSeek) {
      onSeek(detail);
      return;
    }
    window.dispatchEvent(
      new CustomEvent<SeekDetail>(SEEK_EVENT, {
        detail: { trackId, ...detail },
      }),
    );
  };

  const mapSeekPosition = (raw: number) => {
    const anchor = phaseAnchorRef.current;
    if (anchor == null) return raw;
    const { bpm, firstBeat } = gridRef.current;
    return barPhaseAlignedSeek(raw, anchor, bpm, firstBeat);
  };

  const trackIdRef = useRef(trackId);
  useEffect(() => {
    trackIdRef.current = trackId;
    customSeekRef.current = onSeek;
    preserveBarPhaseRef.current = preserveBarPhase;
    gridRef.current = { bpm: track?.bpm ?? null, firstBeat: track?.first_beat ?? null };
  }, [trackId, onSeek, preserveBarPhase, track?.bpm, track?.first_beat]);

  // 拖动中组件被卸载（切歌/切试听流）也必须松开 PlayerBar 的 scrub 标记，
  // 否则权威时钟被永久压制、播放头冻结。卸载时 trackId 可能已换，走 ref。
  useEffect(
    () => () => {
      if (draggingRef.current) {
        const detail = {
          position: previewPositionRef.current,
          preview: true,
          scrubbing: false,
        };
        if (customSeekRef.current) {
          customSeekRef.current(detail);
        } else {
          window.dispatchEvent(
            new CustomEvent<SeekDetail>(SEEK_EVENT, {
              detail: { trackId: trackIdRef.current, ...detail },
            }),
          );
        }
      }
    },
    [],
  );

  // 原生 range 在指针下自己移动；播放头预览最多每帧同步一次。整个指针手势只在
  // pointerup 提交最终落点，避免第一次 input 先启动原生 seek 后，受控 value 和
  // WebKit 的原生滑块跟踪争抢同一根拇指，表现成“按得下但拖不动”。
  const previewSeek = (nextPosition: number) => {
    previewPositionRef.current = nextPosition;
    if (previewFrameRef.current !== null) return;
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;
      dispatchSeek(previewPositionRef.current, true);
    });
  };

  const pointerPosition = (input: HTMLInputElement, clientX: number) => {
    const rect = input.getBoundingClientRect();
    return waveformPointerSeconds(
      clientX,
      rect.left,
      rect.width,
      total,
      position ?? 0,
      viewportSeconds ?? null,
    );
  };

  useEffect(() => {
    if (providedWaveform) {
      setWave(providedWaveform);
      setError("");
      return;
    }
    if (progressiveStream) {
      // 在线曲的波形只由当前媒体的 buffered + analyser 渐进生成，不能从这里另拉整首。
      setWave(null);
      setError("");
      return;
    }
    let alive = true;
    // Performance 的局部滚动波形会按曲长要 100 列/秒，但曲库分析预先写好的是 640 桶。
    // 先拿 canonical 预览立即画，再在它之后后台升级；旧逻辑直接等详细档，等于
    // 每次装盘都绕开已有缓存现场整轨解码，overview 还会再用 960 解第二次。
    const previewBuckets = Math.min(640, buckets);
    const detailed = cachedWaveform(trackId, buckets);
    const preview = detailed ?? cachedWaveform(trackId, previewBuckets);
    setWave(preview);
    setError("");
    if (detailed) return;
    const loadAt = (count: number) => oneLibraryTrack
      ? loadWaveformForTrack(oneLibraryTrack, count)
      : loadWaveformById(trackId, count);
    // Keep a cached canonical rail responsive through a new Deck load. The detailed request is
    // intentionally deferred and globally serialized by the backend; current/predicted Decks
    // must not launch several full-track decodes while a platter or waveform needs input now.
    let detailTimer: number | null = null;
    const request = preview && buckets > previewBuckets
      ? new Promise<WaveformData>((resolve, reject) => {
          detailTimer = window.setTimeout(() => {
            detailTimer = null;
            void loadAt(buckets).then(resolve, reject);
          }, DETAIL_WAVEFORM_IDLE_DELAY_MS);
        })
      : loadAt(buckets);
    request
      .then((result) => {
        if (alive) setWave(result);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      });
    // 切曲目时作废上一条请求，慢响应不会画到新曲子上
    return () => {
      alive = false;
      if (detailTimer !== null) window.clearTimeout(detailTimer);
    };
  }, [trackId, oneLibraryTrack?.source_key, progressiveStream, buckets, providedWaveform]);

  useEffect(() => {
    if (!progressiveStream) {
      setStreamSnapshot(null);
      return;
    }
    const sync = () => setStreamSnapshot(streamWaveformSnapshot(trackId));
    const unsubscribe = subscribeStreamWaveform(trackId, sync);
    // 首帧也建固定桶：即使媒体还没触发 progress，底栏仍有“未缓存”基线。
    if (!streamWaveformSnapshot(trackId)) {
      updateStreamWaveform(trackId, 0, duration, null, []);
    }
    sync();
    return unsubscribe;
  }, [trackId, progressiveStream]);

  useEffect(() => {
    if (progressiveStream && duration > 0) {
      // loadedmetadata 可能晚于首帧；只补时长，不清掉 PlayerBar 已喂入的缓存区间。
      updateStreamWaveform(trackId, 0, duration, null);
    }
  }, [trackId, duration, progressiveStream]);

  const activeStreamSnapshot =
    streamSnapshot?.waveform.track_id === trackId ? streamSnapshot : null;
  const displayWave = progressiveStream ? activeStreamSnapshot?.waveform ?? null : wave;

  // 波形计算可能要几秒；期间直接使用曲库/媒体元数据里的时长，让用户可以立刻拖动跳转。
  const waveDuration = displayWave?.duration ?? 0;
  const total = waveDuration > 0 ? waveDuration : duration;
  const ratio = total > 0 && position !== null ? Math.min(1, Math.max(0, position / total)) : null;
  const analysisFrontierRatio = total > 0 && displayWave?.analysis_frontier != null
    ? Math.min(1, Math.max(0, displayWave.analysis_frontier / total))
    : null;
  const analysisBackFrontierRatio = total > 0 && displayWave?.analysis_back_frontier != null
    ? Math.min(1, Math.max(0, displayWave.analysis_back_frontier / total))
    : null;
  const previousPosition = previousPositionRef.current;
  const railPosition = stabilizedWaveformPosition(
    previousPosition,
    position,
    playing && !interactiveScrub && !snapRail,
  );
  const viewport = waveformViewportLayout(total, railPosition, viewportSeconds);
  const animateRail = !snapRail && railAnimationReady && shouldAnimateWaveformRail(
    viewport.active,
    previousTrackRef.current,
    trackId,
    previousPosition,
    railPosition,
    interactiveScrub ? PERFORMANCE_WAVEFORM_SCRATCH_MAX_STEP_SECONDS : undefined,
    interactiveScrub,
  );
  const motionPosition = animateRail && playing && !interactiveScrub && railPosition !== null
    ? projectedWaveformPosition(railPosition, total, playbackRate)
    : railPosition;
  const motionViewport = waveformViewportLayout(total, motionPosition, viewportSeconds);
  const committedBake = previousTrackRef.current === trackId && viewport.active
    ? committedBakeWindowRef.current
    : null;
  const bakeWindow = viewport.active && viewportSeconds
    ? waveformBakeWindow(total, railPosition, viewportSeconds, committedBake)
    : null;
  // A rebase swaps the canvas's source-time range, not merely its CSS position. It must never
  // inherit the translating rail's transition or the new image visibly travels in from the old
  // range. Compare with the last *committed* range (see layout effect below).
  const bakeRangeChanged = waveformBakeRangeChanged(committedBake, bakeWindow);
  const bake = bakeWindow
    ? {
        ...bakeWindow,
        // Rebase pixels and their raw clock atomically. The layout effect below starts the
        // projected compositor runway on the following frame; jumping straight to that future
        // target here would create a forward kick at every three-screen window boundary.
        translatePercent: waveformBakeTranslatePercent(
          bakeWindow,
          bakeRangeChanged ? railPosition : motionPosition,
        ),
      }
    : null;

  useLayoutEffect(() => {
    previousTrackRef.current = trackId;
    previousPositionRef.current = position;
  }, [position, trackId]);

  useLayoutEffect(() => {
    // This runs only after React committed the matching transform. Keeping the ref at this
    // boundary makes an aborted/restarted render still see the old canvas range and reliably
    // disable CSS interpolation for the eventual rebake commit.
    committedBakeWindowRef.current = bake;
  }, [bake?.durationSec, bake?.endSec, bake?.startSec, trackId, viewport.active]);

  useLayoutEffect(() => {
    if (
      !bakeRangeChanged
      || !animateRail
      || !bake
      || motionPosition === null
      || railPosition === null
    ) return;
    const rail = bakeRef.current;
    if (!rail) return;
    const target = waveformBakeTranslatePercent(bake, motionPosition);
    // Establish the rebased transform as a real transition start even if React committed just
    // before the browser's frame deadline and no paint has happened yet.
    void rail.offsetWidth;
    const frame = window.requestAnimationFrame(() => {
      // The newly drawn source range is already visible at the exact raw clock. Start its normal
      // future target one paint later, so the rebase costs at most one frame instead of freezing
      // until the next 100 ms native snapshot.
      rail.style.transition = `transform ${PERFORMANCE_WAVEFORM_SMOOTHING_MS}ms linear`;
      rail.style.transform = `translate3d(-${target}%, 0, 0)`;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    animateRail,
    bake?.endSec,
    bake?.startSec,
    bakeRangeChanged,
    motionPosition,
    railPosition,
  ]);

  // Viewport Decks paint a 3-screen sliding window; overview still uses the host width.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const rail = railRef.current;
    const canvas = canvasRef.current;
    if (!host || !rail || !canvas || !displayWave) return;
    const render = () => {
      const renderedHeight = (viewport.active ? host.clientHeight : rail.clientHeight) || height;
      const width = viewport.active && bake
        ? host.clientWidth * bake.widthScale
        : rail.clientWidth;
      if (width <= 0 || renderedHeight <= 0) return;
      draw(
        canvas,
        displayWave,
        width,
        renderedHeight,
        activeStreamSnapshot?.known ?? displayWave.known,
        verticalInsetRatio,
        silenceThreshold,
        placeholder,
        bake?.startSec ?? null,
        bake?.endSec ?? null,
      );
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(host);
    return () => observer.disconnect();
  }, [
    displayWave,
    activeStreamSnapshot,
    height,
    verticalInsetRatio,
    silenceThreshold,
    placeholder,
    viewport.active,
    bake?.startSec,
    bake?.endSec,
    bake?.widthScale,
  ]);

  const cueRatio = markerRatio(cueMs, total);
  const endRatio = markerRatio(endMs, total);
  const ready = displayWave !== null && displayWave.amp.length > 0;
  const beatMarkers = showBeatGrid && track
    ? beatGridMarkers(
        total,
        track.bpm,
        track.first_beat,
        viewport.active ? viewport.viewStartSec - 1 : 0,
        viewport.active ? viewport.viewEndSec + 1 : total,
        track.bpm_confidence,
      )
    : [];

  const applyPoint = async (kind: "start" | "end") => {
    if (!menu || !onSetPoint) return;
    setMenuError("");
    try {
      const result = await onSetPoint(kind, menu.position);
      if (typeof result === "string" && result) {
        setMenuError(result);
        return;
      }
      setMenu(null);
    } catch (reason: unknown) {
      setMenuError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div
      ref={hostRef}
      className={className}
      data-viewport={viewport.active ? "true" : undefined}
      data-wave-seek={seekable ? undefined : "off"}
      style={{
        position: "relative",
        height,
        background: progressiveStream ? "transparent" : "var(--kd-panel-inset)",
        cursor: seekable && total > 0 ? "pointer" : "default",
        overflow: "hidden",
        opacity,
        pointerEvents: seekable ? undefined : "none",
      }}
      // 只在冒泡阶段拦住可跳转波形，让滑轨先处理点击；捕获阶段拦截会让
      // React 19 的根监听在事件到达 range 之前就停掉，表现为点哪都不跳。
      onPointerDown={seekable ? (event) => event.stopPropagation() : undefined}
      onContextMenu={
        onSetPoint
          ? (event) => {
              event.preventDefault();
              // 没有播放头（例如详情里看的不是正在播放的歌）就不猜一个位置。
              // 用户明确要的是“当前播放位置”，不是右键落点。
              if (position === null || total <= 0) return;
              setMenuError("");
              setMenu({ x: event.clientX, y: event.clientY, position });
            }
          : undefined
      }
      title={
        onSetPoint
          ? position !== null
            ? "点击跳转；右键在当前播放位置设开始/结束点"
            : "点击跳转；播放时可右键设开始/结束点"
          : seekable && total > 0
            ? "点击跳转"
            : undefined
      }
    >
      {viewport.active && bake ? (
        <div
          className="kd-wave-bake-zoom"
          style={{
            position: "absolute",
            inset: 0,
            transform: `scaleX(${viewport.tempoScaleX})`,
            transformOrigin: "50% 50%",
            pointerEvents: "none",
            zIndex: 1,
          }}
        >
          <div
            ref={bakeRef}
            className="kd-wave-bake"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: "50%",
              width: `${bake.widthScale * 100}%`,
              transform: `translate3d(-${bake.translatePercent}%, 0, 0)`,
              transition: animateRail && !bakeRangeChanged
                ? `transform ${interactiveScrub ? PERFORMANCE_WAVEFORM_SCRATCH_SMOOTHING_MS : PERFORMANCE_WAVEFORM_SMOOTHING_MS}ms linear`
                : "none",
              willChange: "transform",
              pointerEvents: "none",
            }}
          >
            <canvas
              ref={canvasRef}
              style={{
                display: ready ? "block" : "none",
                width: "100%",
                height: "100%",
              }}
              role="img"
              aria-label="频谱波形"
            />
          </div>
        </div>
      ) : null}
      <div
        className="kd-wave-rail-zoom"
        style={viewport.active
          ? {
              position: "absolute",
              inset: 0,
              transform: `scaleX(${viewport.tempoScaleX})`,
              transformOrigin: "50% 50%",
              pointerEvents: "none",
            }
          : { display: "contents" }}
      >
      <div
        ref={railRef}
        className="kd-wave-rail"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: viewport.active ? "50%" : 0,
          width: `${viewport.baseRailScale * 100}%`,
          transform: viewport.active
            ? `translate3d(-${motionViewport.railTranslatePercent}%, 0, 0)`
            : "none",
          // Deck snapshots arrive about every 100 ms. A small overlap absorbs scheduler jitter;
          // retargeting the compositor transition stays smooth without queuing delayed frames.
          transition: animateRail
            ? `transform ${interactiveScrub ? PERFORMANCE_WAVEFORM_SCRATCH_SMOOTHING_MS : PERFORMANCE_WAVEFORM_SMOOTHING_MS}ms linear`
            : "none",
          willChange: viewport.active ? "transform" : undefined,
        }}
      >
      {progressiveStream && (
        <span className="kd-wave-stream-bed" aria-hidden="true">
          {(activeStreamSnapshot?.bufferedRanges ?? []).map((range, index) => {
            if (total <= 0) return null;
            const left = clampRatio(range.start / total) * 100;
            const right = clampRatio(range.end / total) * 100;
            return (
              <i
                key={`${index}:${range.start}:${range.end}`}
                style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }}
              />
            );
          })}
        </span>
      )}
      {!viewport.active ? (
      <canvas
        ref={canvasRef}
        style={{
          display: ready ? "block" : "none",
          position: "relative",
          zIndex: 1,
          width: "100%",
          height: "100%",
        }}
        role="img"
        aria-label="频谱波形"
      />
      ) : null}
      {analysisFrontierRatio !== null ? (
        <span
          className="kd-wave-analysis-frontier"
          aria-hidden="true"
          style={{ left: `${analysisFrontierRatio * 100}%` }}
        />
      ) : null}
      {analysisBackFrontierRatio !== null
      && (analysisFrontierRatio === null || analysisBackFrontierRatio < analysisFrontierRatio) ? (
        <span
          className="kd-wave-analysis-frontier"
          data-direction="back"
          aria-hidden="true"
          style={{ left: `${analysisBackFrontierRatio * 100}%` }}
        />
      ) : null}
      {/* 在线流即使还没有第一帧 analyser 数据，也始终显示上面的渐变缓存轨；
          不能让通用的灰色 fallback 在首帧或媒体等待期间盖住它。 */}
      {!ready && !progressiveStream && (
        <div
          className="kd-wave-fallback"
          aria-hidden="true"
          title={error ? `波形不可用：${error}` : undefined}
        >
          <span
            className="kd-wave-fallback-fill"
            data-error={error ? "true" : undefined}
            style={{ width: `${ratio !== null ? ratio * 100 : 0}%` }}
          />
        </div>
      )}

      <WaveformLoopFills
        total={total}
        cuePoints={cuePoints}
        loopStart={loopStart}
        loopLength={loopLength}
      />

      {beatMarkers.length > 0 ? (
        <span className="kd-wave-beat-grid" aria-hidden="true">
          {beatMarkers.map((marker) => (
            <i
              key={`${marker.positionSec}:${marker.beat}`}
              data-bar={marker.beat === 1 ? "true" : undefined}
              style={{
                left: `${(marker.positionSec / total) * 100}%`,
                transform: viewport.tempoScaleX !== 1 ? `scaleX(${1 / viewport.tempoScaleX})` : undefined,
                transformOrigin: "0 50%",
              }}
            >
              {marker.beat === 1 ? marker.bar : null}
            </i>
          ))}
        </span>
      ) : null}

      {/* 已播部分压暗：不换色，只盖一层半透明遮罩，颜色信息还在。
          遮罩色跟主题走：深色主题盖黑、浅色主题盖白，白天才不会糊成一团黑 */}
      {dimPlayed && ratio !== null && ratio > 0 && (
        <span
          className="kd-wave-dim"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${ratio * 100}%`,
            background: "var(--kd-wave-dim, rgba(0,0,0,0.55))",
            pointerEvents: "none",
          }}
        />
      )}

      <WaveformCueMarkers
        total={total}
        cuePoints={cuePoints}
      />

      {cueRatio !== null && (
        <span
          className="kd-wave-marker"
          data-kind="start"
          style={{ left: `${cueRatio * 100}%` }}
          title={`开始 ${((cueMs ?? 0) / 1000).toFixed(2)}s`}
          aria-hidden="true"
        />
      )}
      {endRatio !== null && (
        <span
          className="kd-wave-marker"
          data-kind="end"
          style={{ left: `${endRatio * 100}%` }}
          title={`结束 ${((endMs ?? 0) / 1000).toFixed(2)}s`}
          aria-hidden="true"
        />
      )}
      </div>
      </div>

      {ratio !== null && (
        <span
          className="kd-wave-playhead"
          style={{
            position: "absolute",
            left: `${viewport.playheadPercent}%`,
            width: 1,
            pointerEvents: "none",
          }}
        />
      )}

      {seekable && (
        <input
          type="range"
          min={0}
          max={Math.max(total, 1)}
          step="0.001"
          value={total > 0 && position !== null ? Math.min(total, Math.max(0, position)) : 0}
          disabled={total <= 0}
          aria-label="频谱波形，点击跳转"
          onPointerDown={(event) => {
            event.stopPropagation();
            if (event.pointerType === "mouse" && event.button !== 0) return;
            // WKWebView 的透明原生 range 在受控 value 更新时可能丢掉系统拇指跟踪。
            // 手势改由 pointer 坐标驱动；阻止原生默认动作，避免两套跟踪互相覆盖。
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            draggingRef.current = true;
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // A cancelled platform gesture can make capture unavailable; in-bounds moves work.
            }
            phaseAnchorRef.current =
              preserveBarPhaseRef.current && position !== null && Number.isFinite(position)
                ? position
                : null;
            const mapped = mapSeekPosition(pointerPosition(event.currentTarget, event.clientX));
            previewPositionRef.current = mapped;
            // scrub 开始：告诉 PlayerBar 压制权威时钟，别顶回播放头。
            dispatchSeek(mapped, true, true);
          }}
          onPointerMove={(event) => {
            if (!draggingRef.current) return;
            event.stopPropagation();
            event.preventDefault();
            previewSeek(mapSeekPosition(pointerPosition(event.currentTarget, event.clientX)));
          }}
          onPointerUp={(event) => {
            if (!draggingRef.current) return;
            event.stopPropagation();
            event.preventDefault();
            draggingRef.current = false;
            try {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            } catch {
              // The platform may already have released capture before this React event.
            }
            if (previewFrameRef.current !== null) {
              cancelAnimationFrame(previewFrameRef.current);
              previewFrameRef.current = null;
            }
            const finalPosition = mapSeekPosition(pointerPosition(event.currentTarget, event.clientX));
            previewPositionRef.current = finalPosition;
            phaseAnchorRef.current = null;
            // 点击和拖动都只在这里落一次真实 transport；forceCommit 避免相邻位置的
            // 媒体回声去重规则误吞用户刚完成的手势。
            dispatchSeek(finalPosition, false, false, true);
          }}
          onPointerCancel={(event) => {
            event.stopPropagation();
            draggingRef.current = false;
            try {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            } catch {
              // The cancelled gesture may already have released capture.
            }
            if (previewFrameRef.current !== null) {
              cancelAnimationFrame(previewFrameRef.current);
              previewFrameRef.current = null;
            }
            phaseAnchorRef.current = null;
            // scrub 中止：不发正式跳转，只松开时钟压制。
            dispatchSeek(previewPositionRef.current, true, false);
          }}
          onClick={(event) => event.stopPropagation()}
          onInput={(event) => {
            event.stopPropagation();
            if (menu || total <= 0) return;
            const nextPosition = Number(event.currentTarget.value);
            if (!draggingRef.current) {
              dispatchSeek(nextPosition);
              return;
            }
            previewSeek(nextPosition);
          }}
          style={{
            position: "absolute",
            zIndex: 8,
            inset: 0,
            width: "100%",
            height: "100%",
            margin: 0,
            cursor: "pointer",
            opacity: 0,
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(null);
            setMenuError("");
          }}
        >
          <button type="button" onClick={() => void applyPoint("start")}>
            将当前点设为开始点
          </button>
          <button type="button" onClick={() => void applyPoint("end")}>
            将当前点设为结束点
          </button>
          {menuError ? (
            <p className="kd-wave-menu-error" role="alert">
              {menuError}
            </p>
          ) : null}
        </ContextMenu>
      )}
    </div>
  );
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
