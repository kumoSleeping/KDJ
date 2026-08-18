import type { StemName } from "../types";

export const ORIGINAL_WAVE_BIT = 16;
export const STEM_WAVE_BITS: Record<StemName, number> = {
  drums: 1,
  bass: 2,
  other: 4,
  vocals: 8,
};
export const ALL_PERFORMANCE_WAVE_BITS = 31;
/** STEM display is opt-in. The original mix is the permanent visual reference rail. */
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
 * A/B 共用一套波形显示偏好。ORG 是永久参考车道，不能被旧存档或组合按键隐藏；
 * 否则未显式启动 STEM 的 Deck 只剩四条空槽，看起来像整个波形渲染器坏了。
 * 旧版存的是两台 Deck 的数组；迁移时沿用 A 侧的 STEM 选择。
 *
 * 打开分轨车道只改变布局；它既不启动扫描，也不切换可听音频。显式启动 STEM
 * 音频后，实时 worker 发布到达的分轨波形块。
 */
export function normalizePerformanceWaveMask(value: unknown): number {
  const stored = Array.isArray(value) && value.length === 2 ? value[0] : value;
  const stemBits = typeof stored === "number" && Number.isInteger(stored)
    ? stored & STEM_LANE_BITS
    : 0;
  return ORIGINAL_WAVE_BIT | stemBits;
}
