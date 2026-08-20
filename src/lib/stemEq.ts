/**
 * STEM EQ：双极性旋钮，0 为原曲音量，负向切、正向推。
 * 引擎侧仍用线性增益：0 静音、1 原量、2 约 +6 dB。
 */

export const STEM_GAIN_MIN = 0;
export const STEM_GAIN_UNITY = 1;
export const STEM_GAIN_MAX = 2;

export const STEM_EQ_MIN = -1;
export const STEM_EQ_MAX = 1;

export function clampStemGain(gain: number): number {
  if (!Number.isFinite(gain)) return STEM_GAIN_UNITY;
  return Math.min(STEM_GAIN_MAX, Math.max(STEM_GAIN_MIN, gain));
}

export function clampStemEq(eq: number): number {
  if (!Number.isFinite(eq)) return 0;
  return Math.min(STEM_EQ_MAX, Math.max(STEM_EQ_MIN, eq));
}

export function stemEqToGain(eq: number): number {
  return clampStemGain(clampStemEq(eq) + STEM_GAIN_UNITY);
}

export function stemGainToEq(gain: number): number {
  return clampStemEq(clampStemGain(gain) - STEM_GAIN_UNITY);
}

/** A first knob move is retained while viewport separation is still running, then applied once
 * the matching track exposes its live model path. */
export function stemGainRequestReady(
  status: { trackId: number; state: string } | null | undefined,
  trackId: number,
): boolean {
  return status?.trackId === trackId && status.state === "ready";
}

/** CSS 0° 在 12 点，顺时针为正，和 STEM EQ 指针一致。 */
export function stemEqPointerAngle(eq: number): number {
  return -135 + (clampStemEq(eq) + 1) / 2 * 270;
}

function polarCss(cx: number, cy: number, r: number, cssDeg: number): { x: number; y: number } {
  const rad = cssDeg * Math.PI / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function arc(from: { x: number; y: number }, to: { x: number; y: number }, r: number, large: 0 | 1, sweep: 0 | 1): string {
  return `M ${from.x.toFixed(3)} ${from.y.toFixed(3)} A ${r} ${r} 0 ${large} ${sweep} ${to.x.toFixed(3)} ${to.y.toFixed(3)}`;
}

/** 270° 底轨：7 点到 5 点，顺时针。 */
export function stemEqRingTrackPath(cx = 18, cy = 18, r = 14.5): string {
  return arc(polarCss(cx, cy, r, -135), polarCss(cx, cy, r, 135), r, 1, 1);
}

/** 从 12 点填到指针：推升顺时针，切除逆时针。中位不画。 */
export function stemEqRingFillPath(eq: number, cx = 18, cy = 18, r = 14.5): string | null {
  const value = clampStemEq(eq);
  if (Math.abs(value) < 0.008) return null;
  const angle = value * 135;
  return arc(polarCss(cx, cy, r, 0), polarCss(cx, cy, r, angle), r, 0, angle >= 0 ? 1 : 0);
}
