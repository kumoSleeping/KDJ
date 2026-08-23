import type { CuePoint } from "../types";

export const HOT_CUE_COLORS = [
  { index: 1, name: "pink", css: "#e6579a" },
  { index: 2, name: "red", css: "#e5484d" },
  { index: 3, name: "orange", css: "#ed7b2f" },
  { index: 4, name: "yellow", css: "#d4a900" },
  { index: 5, name: "green", css: "#2eaa62" },
  { index: 6, name: "aqua", css: "#1599ad" },
  { index: 7, name: "blue", css: "#4676df" },
  { index: 8, name: "purple", css: "#9656cc" },
] as const;

/** 演出台 Hot Cue 垫为 4×2 一组，共 8 槽。 */
export const HOT_CUE_PAD_COUNT = 8;

export interface BeatGridMarker {
  positionSec: number;
  beat: 1 | 2 | 3 | 4;
  bar: number;
}

const MAX_BEAT_MARKERS = 8_192;

/**
 * 中心满幅式三次方 crossfader：
 * 居中时两边都保留各自的满音量，不会像 Constant Power 那样把两路都压到 -3 dB；
 * 推向某一边时该边始终满幅，另一边沿镜像 X³ 曲线退到静音。关闭横推时传入 0，
 * 等价于 Pioneer THRU。
 */
export function crossfaderChannelGains(value: number): readonly [number, number] {
  const x = Math.min(1, Math.max(-1, Number.isFinite(value) ? value : 0));
  if (x <= -1) return [1, 0];
  if (x >= 1) return [0, 1];
  const fadingGain = (1 - Math.abs(x)) ** 3;
  return x < 0 ? [1, fadingGain] : [fadingGain, 1];
}

/**
 * 通道竖推：Pioneer / Rekordbox Steep Top（长推子 Smooth≈x²、Exponential≈x⁵ 之间）。
 * 三次方让行程前半段几乎不出声，大约推到 60–70% 才明显起来，满行程仍是 0 dB。
 */
export function channelFaderGain(value: number): number {
  const x = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x ** 3;
}

/** DJ 通道 EQ：中位 0 dB，线性扫到 −24 dB / +6 dB。 */
export function eqBandDb(value: number): number {
  const x = Math.min(1, Math.max(-1, Number.isFinite(value) ? value : 0));
  return x < 0 ? x * 24 : x * 6;
}

/** 不同曲目永远装入另一侧；同曲恢复和第一首保留当前侧。 */
export function nextLoadedDeckIndex(
  active: 0 | 1,
  currentTrackId: number | null,
  nextTrackId: number,
): 0 | 1 {
  return currentTrackId !== null && currentTrackId !== nextTrackId ? (active === 0 ? 1 : 0) : active;
}

export interface PerformanceLoadDeckState {
  trackId: number | null;
  playing: boolean;
  desiredPlaying?: boolean;
}

/**
 * Chooses the physical Deck replaced by a DJ-mode library double-click.
 * Empty/idle hardware is protected before gain is considered; equal cases preserve focus.
 */
export function performanceLoadDeckIndex(
  decks: readonly [PerformanceLoadDeckState, PerformanceLoadDeckState],
  effectiveChannelGains: readonly [number, number],
  focused: 0 | 1,
): 0 | 1 {
  const empty = decks.map((deck) => deck.trackId === null) as [boolean, boolean];
  if (empty[0] && empty[1]) return 0;
  if (empty[0] !== empty[1]) return empty[0] ? 0 : 1;

  const running = decks.map((deck) => deck.playing || deck.desiredPlaying === true) as [boolean, boolean];
  if (running[0] !== running[1]) return running[0] ? 1 : 0;
  if (!running[0]) return focused === 0 ? 1 : 0;

  const gain = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 1;
  const left = gain(effectiveChannelGains[0]);
  const right = gain(effectiveChannelGains[1]);
  if (Math.abs(left - right) < 0.000_1) return focused === 0 ? 1 : 0;
  return left < right ? 0 : 1;
}

export function sortCuePoints(cues: readonly CuePoint[]): CuePoint[] {
  return [...cues].sort(
    (left, right) =>
      left.start_ms - right.start_ms ||
      (left.hot_cue ?? Number.MAX_SAFE_INTEGER) -
        (right.hot_cue ?? Number.MAX_SAFE_INTEGER) ||
      left.id - right.id,
  );
}

export function validateCuePoints(cues: readonly CuePoint[]): string[] {
  const errors: string[] = [];
  const hotSlots = new Set<number>();
  cues.forEach((cue, index) => {
    const label = `Cue ${index + 1}`;
    if (!Number.isSafeInteger(cue.start_ms) || cue.start_ms < 0) {
      errors.push(`${label} 起点无效`);
    }
    if (cue.end_ms !== null && (!Number.isSafeInteger(cue.end_ms) || cue.end_ms <= cue.start_ms)) {
      errors.push(`${label} Loop 终点必须晚于起点`);
    }
    if (cue.active_loop && cue.end_ms === null) errors.push(`${label} Active Loop 缺少终点`);
    if (cue.hot_cue !== null) {
      if (!Number.isInteger(cue.hot_cue) || cue.hot_cue < 1 || cue.hot_cue > 8) {
        errors.push(`${label} Hot Cue 槽位必须为 1 到 8`);
      } else if (hotSlots.has(cue.hot_cue)) {
        errors.push(`Hot Cue ${cue.hot_cue} 槽位重复`);
      } else {
        hotSlots.add(cue.hot_cue);
      }
    }
  });
  return errors;
}

/** Engine DJ 风格 Quantize：用首拍作为网格原点，把位置吸附到最近一拍。 */
export function snapCueSeconds(
  positionSec: number,
  bpm: number | null,
  firstBeatSec: number | null,
  enabled: boolean,
): number {
  const safePosition = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  if (
    !enabled ||
    bpm === null ||
    !Number.isFinite(bpm) ||
    bpm <= 0 ||
    firstBeatSec === null ||
    !Number.isFinite(firstBeatSec)
  ) return safePosition;
  const interval = 60 / bpm;
  const origin = firstBeatSec;
  return Math.max(0, origin + Math.round((safePosition - origin) / interval) * interval);
}

export function upsertHotCue(
  cues: readonly CuePoint[],
  slot: number,
  startMs: number,
): CuePoint[] {
  if (!Number.isInteger(slot) || slot < 1 || slot > 8) return sortCuePoints(cues);
  const color = HOT_CUE_COLORS[slot - 1];
  const existing = cues.find((cue) => cue.hot_cue === slot);
  const replacement: CuePoint = {
    id: existing?.id ?? -slot,
    hot_cue: slot,
    start_ms: Math.max(0, Math.round(startMs)),
    end_ms: existing?.end_ms ?? null,
    color_index: color.index,
    color: color.name,
    comment: existing?.comment ?? "",
    active_loop: existing?.active_loop ?? false,
  };
  return sortCuePoints([...cues.filter((cue) => cue.hot_cue !== slot), replacement]);
}

export function removeHotCue(cues: readonly CuePoint[], slot: number): CuePoint[] {
  return sortCuePoints(cues.filter((cue) => cue.hot_cue !== slot));
}

export function updateHotCueComment(
  cues: readonly CuePoint[],
  slot: number,
  comment: string,
): CuePoint[] {
  return sortCuePoints(
    cues.map((cue) => cue.hot_cue === slot ? { ...cue, comment: comment.trim() } : cue),
  );
}

/** 滚动波形以播放头为原点做相对刮擦；向右拖波形就是回到更早的位置。 */
export function scratchPosition(
  startPosition: number,
  deltaX: number,
  width: number,
  viewportSeconds: number,
  duration: number,
): number {
  const safeStart = Number.isFinite(startPosition) ? Math.max(0, startPosition) : 0;
  if (!Number.isFinite(deltaX) || !Number.isFinite(width) || width <= 0) return safeStart;
  const span = Number.isFinite(viewportSeconds) && viewportSeconds > 0 ? viewportSeconds : 12;
  const end = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.min(end, Math.max(0, safeStart - deltaX / width * span));
}

export function beatGridMarkers(
  durationSec: number,
  bpm: number | null,
  firstBeatSec: number | null,
  rangeStartSec = 0,
  rangeEndSec = durationSec,
  confidence: number | null = null,
): BeatGridMarker[] {
  if (
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    bpm === null ||
    !Number.isFinite(bpm) ||
    bpm <= 0 ||
    firstBeatSec === null ||
    !Number.isFinite(firstBeatSec) ||
    (confidence !== null && (!Number.isFinite(confidence) || confidence < 0.45))
  ) return [];
  const interval = 60 / bpm;
  if (!Number.isFinite(interval) || interval <= 0) return [];
  const bar = interval * 4;
  let origin = firstBeatSec % bar;
  if (origin < 0) origin += bar;

  const rangeStart = Number.isFinite(rangeStartSec) ? Math.max(0, rangeStartSec) : 0;
  const rangeEnd = Number.isFinite(rangeEndSec) ? Math.min(durationSec, rangeEndSec) : durationSec;
  if (rangeEnd < rangeStart || rangeEnd < origin) return [];

  // 直接从可见窗口的首拍开始，不再为整首歌创建数组后过滤；index 仍以整轨
  // 首拍为基准，因而 beat/bar 编号不会随窗口滚动而跳回 1。
  const firstIndex = Math.max(0, Math.ceil((rangeStart - origin) / interval - 1e-9));
  const lastIndex = Math.max(-1, Math.floor((rangeEnd - origin) / interval + 1e-9));
  const count = Math.min(MAX_BEAT_MARKERS, Math.max(0, lastIndex - firstIndex + 1));
  return Array.from({ length: count }, (_, offset) => {
    const index = firstIndex + offset;
    return {
      positionSec: origin + index * interval,
      beat: (index % 4 + 1) as 1 | 2 | 3 | 4,
      bar: Math.floor(index / 4) + 1,
    };
  });
}
