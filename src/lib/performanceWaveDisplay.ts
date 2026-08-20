import type { StemName } from "../types";

export const ORIGINAL_WAVE_BIT = 16;
export const STEM_WAVE_BITS: Record<StemName, number> = {
  drums: 1,
  bass: 2,
  other: 4,
  vocals: 8,
};
/** Performance exposes the original mix plus one optional vocal rail. Other STEM lanes remain
 * audio-only internals and must never re-enter the waveform preference through old storage. */
export const VOCAL_WAVE_BIT = STEM_WAVE_BITS.vocals;
export const ALL_PERFORMANCE_WAVE_BITS = ORIGINAL_WAVE_BIT | VOCAL_WAVE_BIT;
/** The original mix is mandatory; the vocal rail remains opt-in. */
export const DEFAULT_PERFORMANCE_WAVE_MASK = ORIGINAL_WAVE_BIT;
export const STEM_LANE_BITS = VOCAL_WAVE_BIT;
// v2 made all four STEM rails the default and coupled that preference to live inference.  Do not
// carry that implicit performance cost forward for existing users.
export const PERFORMANCE_WAVE_DISPLAY_STORAGE_KEY = "kd-performance-wave-display-v3";

/** True when the user chose to render at least one STEM rail. This is display-only state. */
export function performanceStemLanesVisible(mask: number): boolean {
  return (mask & STEM_LANE_BITS) !== 0;
}

export function readPerformanceWaveMask(): number {
  try {
    return normalizePerformanceWaveMask(
      JSON.parse(localStorage.getItem(PERFORMANCE_WAVE_DISPLAY_STORAGE_KEY) ?? "null"),
    );
  } catch {
    return DEFAULT_PERFORMANCE_WAVE_MASK;
  }
}

/**
 * A/B 共用一套波形显示偏好。旧版存的是两台 Deck 的数组；迁移时沿用 A 侧选择。
 *
 * 打开分轨车道只改变布局；它既不启动扫描，也不切换可听音频。显式启动 STEM
 * 音频后，实时 worker 发布到达的分轨波形块。
 */
export function normalizePerformanceWaveMask(value: unknown): number {
  const stored = Array.isArray(value) && value.length === 2 ? value[0] : value;
  const optional = typeof stored === "number" && Number.isInteger(stored)
    ? stored & VOCAL_WAVE_BIT
    : 0;
  return ORIGINAL_WAVE_BIT | optional;
}
