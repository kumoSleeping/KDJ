import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CuePoint, Track, Waveform as WaveformData } from "../../types";
import {
  PERFORMANCE_WAVEFORM_BAKE_SCREENS,
  PERFORMANCE_WAVEFORM_SECONDS_PER_SCREEN,
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
  beatMarkerRangePercent,
  type WaveformBakeWindow,
} from "../../lib/waveformViewport";
import { beatGridMarkers, type BeatGridMarker } from "../../lib/performanceCues";
import { barPhaseAlignedSeek } from "../../lib/beatGridSync";
import {
  liveWaveformAnimationTimeMs,
  liveWaveformPlaybackRate,
  projectedLiveWaveformPosition,
  shouldPauseLiveWaveformClock,
  updateWaveformMotionClock,
  waveformMotionClockPosition,
  type WaveformMotionClock,
} from "../../lib/waveformMotion";
import { ContextMenu } from "../common";
import { drawWaveformCanvas } from "./WaveformCanvas";
import { useWaveformData } from "./useWaveformData";
import { markerRatio, WaveformCueMarkers, WaveformLoopFills } from "./WaveformMarkers";
import {
  getLiveDeckClock,
  subscribeLivePlaybackClock,
} from "../../lib/unifiedPlayer";
export { pointPatch, WaveformCueMarkers, WaveformLoopFills } from "./WaveformMarkers";

/** 点波形跳转：PlayerBar 监听它，和 kd:play / kd:position 一套约定。 */
export const SEEK_EVENT = "kd:seek";
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

function WaveformBeatGrid({
  markers,
  rangeStartSec,
  rangeEndSec,
  tempoScaleX,
}: {
  markers: readonly BeatGridMarker[];
  rangeStartSec: number;
  rangeEndSec: number;
  tempoScaleX: number;
}) {
  if (markers.length === 0) return null;
  const unstretch = tempoScaleX !== 1 ? `scaleX(${1 / tempoScaleX})` : undefined;
  return (
    <span className="kd-wave-beat-grid" aria-hidden="true">
      {markers.map((marker) => (
        <i
          key={`${marker.positionSec}:${marker.beat}`}
          data-bar={marker.beat === 1 ? "true" : undefined}
          style={{
            left: `${beatMarkerRangePercent(marker.positionSec, rangeStartSec, rangeEndSec)}%`,
            transform: unstretch,
            transformOrigin: "0 50%",
          }}
        >
          {marker.beat === 1 ? marker.bar : null}
        </i>
      ))}
    </span>
  );
}

/**
 * Serato / Rekordbox 那种彩色波形。
 *
 * 绘制方式来自 libdjwaveform：**一列 = 一根柱子**，高度是这一列的响度，
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
   * 自动对拍：按下时记下当前 1/4 小节相位，点击/拖动松手落到被点拍内的同一相位。
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
  /** Precomputed waveform; bypasses the library waveform API. */
  waveform?: WaveformData;
  /** Display-only vertical envelope scale; Performance uses it to visualize live mixer trim. */
  amplitudeScale?: number;
  /** A held hardware platter may move backward at frame rate; interpolate both directions. */
  interactiveScrub?: boolean;
  /** Skip CSS rail interpolation for this paint — SYNC/seek landings must not slide then bounce. */
  snapRail?: boolean;
  /** Changed after native SYNC acknowledges a phase seek; the compositor lands it in one frame. */
  motionRevision?: number;
  /** Physical native Deck whose callback/DAC clock drives this Performance rail. */
  nativeDeck?: 0 | 1;
  /** 整曲预览专用：恢复 v0.2.41 的 STFT 数据、原始高饱和 RGB 与像素汇聚。 */
  renderProfile?: "current" | "release-overview";
  /** Performance may upgrade a cached preview sooner without owning a second acquisition hook. */
  detailUpgradeDelayMs?: number;
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
  amplitudeScale = 1,
  interactiveScrub = false,
  snapRail = false,
  motionRevision = 0,
  nativeDeck,
  renderProfile = "current",
  detailUpgradeDelayMs,
}: WaveformProps) {
  const {
    displayReleaseOverview,
    displayWave,
    error,
  } = useWaveformData({
    trackId,
    track,
    duration,
    buckets,
    providedWaveform,
    renderProfile,
    detailUpgradeDelayMs,
  });
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
  const motionClockRef = useRef<WaveformMotionClock | null>(null);
  const liveDiscontinuityRef = useRef<number | null>(null);
  const livePlatterActiveRef = useRef(false);
  const motionAnimationsRef = useRef<{
    bake: Animation;
    rail: Animation;
    trackId: number;
    bakeStartSec: number;
    bakeEndSec: number;
    totalSec: number;
    railLeadInSec: number;
    loopStartSec: number | null;
    loopLengthSec: number | null;
  } | null>(null);
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
      motionAnimationsRef.current?.bake?.cancel();
      motionAnimationsRef.current?.rail?.cancel();
      motionAnimationsRef.current = null;
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

  // 波形计算可能要几秒；期间直接使用曲库/媒体元数据里的时长，让用户可以立刻拖动跳转。
  const waveDuration = displayWave?.duration ?? 0;
  const total = waveDuration > 0 ? waveDuration : duration;
  const ratio = total > 0 && position !== null ? Math.min(1, Math.max(0, position / total)) : null;
  const hasActiveLoop = loopStart !== null
    && loopLength !== null
    && Number.isFinite(loopStart)
    && Number.isFinite(loopLength)
    && loopLength > 0;
  const previousPosition = previousPositionRef.current;
  const railPosition = stabilizedWaveformPosition(
    previousPosition,
    position,
    playing && !interactiveScrub && !snapRail && !hasActiveLoop,
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
  const animateOverview = !viewport.active
    && !snapRail
    && railAnimationReady
    && playing
    && !interactiveScrub
    && !draggingRef.current
    && shouldAnimateWaveformRail(
      true,
      previousTrackRef.current,
      trackId,
      previousPosition,
      railPosition,
    );
  const compositorLoopStart = hasActiveLoop
    ? Math.min(total, Math.max(0, loopStart as number))
    : null;
  const compositorLoopEnd = compositorLoopStart !== null
    ? Math.min(total, compositorLoopStart + (loopLength as number))
    : null;
  const compositorLoopLength = compositorLoopStart !== null
    && compositorLoopEnd !== null
    && compositorLoopEnd > compositorLoopStart
      ? compositorLoopEnd - compositorLoopStart
      : null;
  // A single compositor animation walks between sparse native clock samples. Retargeting a short
  // CSS transition every 100 ms created a sample-and-hold cadence even when no frame was dropped.
  // Once the callback cursor reaches an active loop, the same native timeline repeats an exact
  // loop-in → loop-out keyframe instead of falling back to ten-hertz wrap snapshots.
  const loopReadyForCompositor = compositorLoopStart !== null
    && compositorLoopEnd !== null
    && compositorLoopLength !== null
    // One stable bitmap must contain the whole loop plus the viewport at both endpoints. Oversized
    // imported loop windows retain the exact snapshot fallback rather than exposing blank canvas.
    && 2 * compositorLoopLength + (viewportSeconds ?? 0)
      <= PERFORMANCE_WAVEFORM_SECONDS_PER_SCREEN * PERFORMANCE_WAVEFORM_BAKE_SCREENS
    && railPosition !== null
    && railPosition >= compositorLoopStart
    && railPosition < compositorLoopEnd;
  const platterLive = interactiveScrub || Math.abs(Number(playbackRate) || 0) > 0.02;
  const continuousRailMotion = viewport.active
    && typeof Element !== "undefined"
    && typeof Element.prototype.animate === "function"
    && railAnimationReady
    && (Boolean(playing) || platterLive)
    && !snapRail
    && railPosition !== null;
  const motionPosition = !continuousRailMotion
    && animateRail
    && playing
    && !interactiveScrub
    && railPosition !== null
    ? projectedWaveformPosition(railPosition, total, playbackRate)
    : railPosition;
  const overviewMotionPosition = animateOverview && railPosition !== null
    ? projectedWaveformPosition(railPosition, total, playbackRate)
    : railPosition;
  const motionRatio = total > 0 && overviewMotionPosition !== null
    ? Math.min(1, Math.max(0, overviewMotionPosition / total))
    : ratio;
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
      continuousRailMotion
      || !bakeRangeChanged
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
    continuousRailMotion,
    motionPosition,
    railPosition,
  ]);

  useLayoutEffect(() => {
    const bakeElement = bakeRef.current;
    const railElement = railRef.current;
    const now = performance.now();
    const clock = updateWaveformMotionClock(
      motionClockRef.current,
      {
        trackId,
        position: railPosition ?? 0,
        duration: total,
        rate: playbackRate,
        playing: continuousRailMotion,
        discrete: !continuousRailMotion,
        motionRevision,
        loopStart: continuousRailMotion && loopReadyForCompositor ? compositorLoopStart : null,
        loopLength: continuousRailMotion && loopReadyForCompositor ? compositorLoopLength : null,
      },
      now,
    );
    motionClockRef.current = clock;

    const cancelAnimations = () => {
      motionAnimationsRef.current?.bake?.cancel();
      motionAnimationsRef.current?.rail?.cancel();
      motionAnimationsRef.current = null;
    };
    if (!continuousRailMotion || !bake || !bakeElement || !railElement || total <= 0) {
      // Cancelling reveals the transform React committed for the fallback path (projected CSS
      // transition, exact scratch/seek, or paused position). Do not imperatively replace it here.
      cancelAnimations();
      return;
    }

    const visualPosition = waveformMotionClockPosition(clock, now);
    const visualRate = Math.abs(clock.rate) < 0.001
      ? (clock.rate < 0 ? -0.001 : 0.001)
      : clock.rate;
    const bakeSpan = bake.endSec - bake.startSec;
    const railLeadInSec = Math.max(
      PERFORMANCE_WAVEFORM_SECONDS_PER_SCREEN * PERFORMANCE_WAVEFORM_BAKE_SCREENS,
      Math.max(0, -bake.startSec),
    );
    const bakeAnimationPosition = visualPosition - bake.startSec;
    const railAnimationPosition = visualPosition + railLeadInSec;
    const owner = motionAnimationsRef.current;
    const sameAnimation = owner
      && owner.trackId === trackId
      && Math.abs(owner.bakeStartSec - bake.startSec) < 1e-6
      && Math.abs(owner.bakeEndSec - bake.endSec) < 1e-6
      // Metadata and decoded waveforms can publish slightly different durations. The full rail's
      // animation duration is source time, so retaining an old effect here changes px/second.
      && Math.abs(owner.totalSec - total) < 1e-6
      && Math.abs(owner.railLeadInSec - railLeadInSec) < 1e-6
      && owner.loopStartSec === clock.loopStart
      && owner.loopLengthSec === clock.loopLength;

    /**
     * Each Web Animation uses source milliseconds as its local timeline. TEMPO is therefore a
     * native playbackRate update, while SYNC writes currentTime once. The outer scaleX layer is
     * independent, so zoom and transport translation continue in the same compositor frame.
     */
    const syncNativeAnimation = (
      animation: Animation,
      sourceTimeMs: number,
      snap: boolean,
      timelineTime: number | null,
    ) => {
      if (snap) {
        animation.pause();
        animation.playbackRate = visualRate;
        animation.currentTime = Math.max(0, sourceTimeMs);
        animation.play();
        if (timelineTime !== null) {
          animation.startTime = timelineTime - Math.max(0, sourceTimeMs) / visualRate;
        }
      } else if (Math.abs(animation.playbackRate - visualRate) > 1e-6) {
        // updatePlaybackRate preserves the current compositor phase instead of restarting the
        // animation. This is the key difference from rebuilding a duration on every BPM tick.
        animation.updatePlaybackRate(visualRate);
      }
    };

    const rawTimelineTime = document.timeline?.currentTime;
    const timelineTime = typeof rawTimelineTime === "number" ? rawTimelineTime : null;
    if (sameAnimation) {
      syncNativeAnimation(owner.bake, bakeAnimationPosition * 1_000, clock.snapped, timelineTime);
      syncNativeAnimation(owner.rail, railAnimationPosition * 1_000, clock.snapped, timelineTime);
      return;
    }

    cancelAnimations();
    if (!(bakeSpan > 0)) return;
    const bakeAnimationStart = bake.startSec;
    const bakeAnimationEnd = bake.endSec;
    const railAnimationStart = -railLeadInSec;
    const railAnimationEnd = total;
    const bakeFrom = waveformBakeTranslatePercent(bake, bakeAnimationStart);
    const bakeTo = waveformBakeTranslatePercent(bake, bakeAnimationEnd);
    const railFrom = (railAnimationStart / total) * 100;
    const railTo = (railAnimationEnd / total) * 100;
    const baseTiming = {
      easing: "linear" as const,
      fill: "both" as const,
      iterations: 1,
    };
    const bakeAnimation = bakeElement.animate(
      [
        { transform: `translate3d(${-bakeFrom}%, 0, 0)` },
        { transform: `translate3d(${-bakeTo}%, 0, 0)` },
      ],
      { ...baseTiming, duration: bakeSpan * 1_000 },
    );
    const railAnimation = railElement.animate(
      [
        { transform: `translate3d(${-railFrom}%, 0, 0)` },
        { transform: `translate3d(${-railTo}%, 0, 0)` },
      ],
      {
        ...baseTiming,
        duration: (total + railLeadInSec) * 1_000,
      },
    );
    syncNativeAnimation(bakeAnimation, bakeAnimationPosition * 1_000, true, timelineTime);
    syncNativeAnimation(railAnimation, railAnimationPosition * 1_000, true, timelineTime);
    motionAnimationsRef.current = {
      bake: bakeAnimation,
      rail: railAnimation,
      trackId,
      bakeStartSec: bake.startSec,
      bakeEndSec: bake.endSec,
      totalSec: total,
      railLeadInSec,
      loopStartSec: clock.loopStart,
      loopLengthSec: clock.loopLength,
    };
  }, [
    bake?.endSec,
    bake?.startSec,
    compositorLoopLength,
    compositorLoopStart,
    continuousRailMotion,
    motionRevision,
    playbackRate,
    railPosition,
    total,
    trackId,
    viewport.active,
  ]);

  useEffect(() => {
    if (nativeDeck === undefined || !viewport.active) return;
    return subscribeLivePlaybackClock(() => {
      const live = getLiveDeckClock(nativeDeck);
      const owner = motionAnimationsRef.current;
      if (!live || !owner || live.trackId !== trackId || owner.trackId !== trackId) return;
      const animations = [owner.bake, owner.rail] as const;
      const discontinuity = liveDiscontinuityRef.current !== live.discontinuityRevision;
      const rate = liveWaveformPlaybackRate(live.targetRate, live.audibleRate, live.scratchHeld);
      const visualRate = Math.abs(rate) < 0.001 ? (rate < 0 ? -0.001 : 0.001) : rate;
      const platterAuthority = live.scratchHeld || livePlatterActiveRef.current;
      livePlatterActiveRef.current = live.scratchHeld;
      if (platterAuthority) {
        // During a grab/coast the callback position is authoritative. Rate-only animation drifts
        // when MIDI packets are coalesced and is the reason the rail used to freeze, then jump on
        // the next touch. Land PCM bake and beat-grid rail in the same JS task, then let both run
        // at the same measured velocity until the next lightweight clock sample.
        const sourcePosition = projectedLiveWaveformPosition(
          live.currentTime,
          live.clientPresentationTimeMs,
          performance.now(),
          rate,
          owner.totalSec,
        );
        const bakeTime = liveWaveformAnimationTimeMs(
          sourcePosition - owner.bakeStartSec,
          owner.bakeEndSec - owner.bakeStartSec,
        );
        const railTime = liveWaveformAnimationTimeMs(
          sourcePosition + owner.railLeadInSec,
          owner.totalSec + owner.railLeadInSec,
        );
        if (bakeTime !== null && railTime !== null) {
          owner.bake.playbackRate = visualRate;
          owner.rail.playbackRate = visualRate;
          owner.bake.currentTime = bakeTime;
          owner.rail.currentTime = railTime;
        }
        liveDiscontinuityRef.current = live.discontinuityRevision;
        animations.forEach((animation) => {
          if (Math.abs(rate) <= 0.02) animation.pause();
          else if (animation.playState !== "running") animation.play();
        });
        return;
      }
      if (shouldPauseLiveWaveformClock(live.playing, live.scratchHeld, true, discontinuity, rate)) {
        liveDiscontinuityRef.current = live.discontinuityRevision;
        animations.forEach((animation) => animation.pause());
        return;
      }
      liveDiscontinuityRef.current = live.discontinuityRevision;
      // Never seek currentTime here. Bake (PCM) and rail (beat grid) are two effects; a second
      // pause/play landing after layout is what made them rock against each other on Play/Seek.
      // But a parked platter / pause edge does call pause() above — when audible rate returns,
      // updatePlaybackRate alone leaves playState=paused, so audio scratches while the rail freezes.
      animations.forEach((animation) => {
        if (animation.playState === "paused") {
          animation.playbackRate = visualRate;
          animation.play();
          return;
        }
        if (Math.abs(animation.playbackRate - visualRate) > 1e-6) {
          animation.updatePlaybackRate(visualRate);
        }
      });
    });
  }, [nativeDeck, trackId, viewport.active]);

  // Overview and DJ detail share frequency hues but deliberately keep different aggregation and
  // contrast policies: macro preview rejects sub-pixel outliers; the beat rail preserves peaks.
  const canvasProfile = displayReleaseOverview
    ? "release-overview"
    : viewport.active
      ? "performance-detail"
      : "current";

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
      drawWaveformCanvas(
        canvas,
        displayWave,
        width,
        renderedHeight,
        displayWave.known,
        bake?.startSec ?? null,
        bake?.endSec ?? null,
        canvasProfile,
      );
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(host);
    window.addEventListener("resize", render);
    // Moving a Tauri window between Retina and non-Retina displays can change DPR without changing
    // the host's CSS box, so ResizeObserver alone leaves a stale backing-store resolution.
    let dprQuery: MediaQueryList | null = null;
    const watchDpr = () => {
      dprQuery?.removeEventListener("change", handleDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener("change", handleDprChange);
    };
    const handleDprChange = () => {
      render();
      watchDpr();
    };
    watchDpr();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", render);
      dprQuery?.removeEventListener("change", handleDprChange);
    };
  }, [
    displayWave,
    height,
    canvasProfile,
    viewport.active,
    bake?.startSec,
    bake?.endSec,
    bake?.widthScale,
  ]);

  const cueRatio = markerRatio(cueMs, total);
  const endRatio = markerRatio(endMs, total);
  const ready = displayWave !== null
    && displayWave.amp.length > 0
    && (displayWave.known === undefined || displayWave.known.some(Boolean));
  const renderedAmplitudeScale = Number.isFinite(amplitudeScale)
    ? Math.min(1, Math.max(0, amplitudeScale))
    : 1;
  const canvasAmplitudeStyle = renderedAmplitudeScale === 1
    ? undefined
    : {
        transform: `scaleY(${renderedAmplitudeScale})`,
        transformOrigin: "50% 50%",
        willChange: "transform",
      };
  const beatRangeMargin = viewport.active ? (viewportSeconds ?? 0) / 2 + 1 : 0;
  const beatRangeStart = viewport.active && bake
    ? bake.startSec
    : viewport.active && loopReadyForCompositor && compositorLoopStart !== null
      ? compositorLoopStart - beatRangeMargin
      : viewport.active
        ? viewport.viewStartSec - 1
        : 0;
  const beatRangeEnd = viewport.active && bake
    ? bake.endSec
    : viewport.active && loopReadyForCompositor && compositorLoopEnd !== null
      ? compositorLoopEnd + beatRangeMargin
      : viewport.active
        ? viewport.viewEndSec + 1
        : total;
  const beatMarkers = showBeatGrid && track
    ? beatGridMarkers(
        total,
        track.bpm,
        track.first_beat,
        beatRangeStart,
        beatRangeEnd,
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
        background: "var(--kd-panel-inset)",
        cursor: seekable && total > 0 ? "pointer" : "default",
        overflow: "hidden",
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
            zIndex: 2,
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
              transition: !continuousRailMotion && animateRail && !bakeRangeChanged
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
                ...canvasAmplitudeStyle,
              }}
              role="img"
              aria-label="频谱波形"
            />
            {showBeatGrid ? (
              <WaveformBeatGrid
                markers={beatMarkers}
                rangeStartSec={bake.startSec}
                rangeEndSec={bake.endSec}
                tempoScaleX={viewport.tempoScaleX}
              />
            ) : null}
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
          // Loop/scratch and old WebView fallback: overlap sparse snapshots without queueing them.
          // Ordinary playback is owned by the continuous compositor animation above.
          transition: !continuousRailMotion && animateRail
            ? `transform ${interactiveScrub ? PERFORMANCE_WAVEFORM_SCRATCH_SMOOTHING_MS : PERFORMANCE_WAVEFORM_SMOOTHING_MS}ms linear`
            : "none",
          willChange: viewport.active ? "transform" : undefined,
        }}
      >
      {!viewport.active ? (
      <canvas
        ref={canvasRef}
        style={{
          display: ready ? "block" : "none",
          position: "relative",
          zIndex: 1,
          width: "100%",
          height: "100%",
          ...canvasAmplitudeStyle,
        }}
        role="img"
        aria-label="频谱波形"
      />
      ) : null}
      {/* Acquisition kind does not change the DJ surface. A detail viewport stays empty until it
          has real columns, while every compact overview uses the same seekable fallback. */}
      {!ready && !viewport.active && (
        <div
          className="kd-wave-fallback"
          aria-hidden="true"
          title={error ? `波形不可用：${error}` : undefined}
        >
          <span
            className="kd-wave-fallback-fill"
            data-error={error ? "true" : undefined}
            style={{
              width: "100%",
              transform: `scaleX(${motionRatio ?? 0})`,
              transformOrigin: "0 50%",
              transition: animateOverview
                ? `transform ${PERFORMANCE_WAVEFORM_SMOOTHING_MS}ms linear`
                : "none",
            }}
          />
        </div>
      )}

      <WaveformLoopFills
        total={total}
        cuePoints={cuePoints}
        loopStart={loopStart}
        loopLength={loopLength}
      />

      {beatMarkers.length > 0 && !viewport.active ? (
        <WaveformBeatGrid
          markers={beatMarkers}
          rangeStartSec={0}
          rangeEndSec={total}
          tempoScaleX={1}
        />
      ) : null}

      {/* 已播部分压暗：不换色，只盖一层半透明遮罩，颜色信息还在。
          遮罩色跟主题走：深色主题盖黑、浅色主题盖白，白天才不会糊成一团黑 */}
      {dimPlayed && motionRatio !== null && motionRatio > 0 && (
        <span
          className="kd-wave-dim"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: "100%",
            transform: `scaleX(${motionRatio})`,
            transformOrigin: "0 50%",
            transition: animateOverview
              ? `transform ${PERFORMANCE_WAVEFORM_SMOOTHING_MS}ms linear`
              : "none",
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
          className="kd-wave-playhead-motion"
          style={{
            transform: `translate3d(${viewport.active ? viewport.playheadPercent : (motionRatio ?? ratio) * 100}%, 0, 0)`,
            transition: animateOverview
              ? `transform ${PERFORMANCE_WAVEFORM_SMOOTHING_MS}ms linear`
              : "none",
          }}
        >
          <span className="kd-wave-playhead" />
        </span>
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
