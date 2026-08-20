import type { StemName } from "../types";

export const ORIGINAL_WAVE_BIT = 16;
export const STEM_WAVE_BITS: Record<StemName, number> = {
  drums: 1,
  bass: 2,
  other: 4,
  vocals: 8,
};
export const ALL_PERFORMANCE_WAVE_BITS = 31;
/** STEM display is opt-in. The original mix starts visible but can be hidden independently. */
export const DEFAULT_PERFORMANCE_WAVE_MASK = ORIGINAL_WAVE_BIT;
export const STEM_LANE_BITS = 0b1111;
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
  return typeof stored === "number" && Number.isInteger(stored)
    ? stored & ALL_PERFORMANCE_WAVE_BITS
    : DEFAULT_PERFORMANCE_WAVE_MASK;
}
