/** 悬浮歌词取色：色相线上的位置 ↔ `#RRGGBB`。 */

/** 主行 / 未唱：黑、白、灰、单色（色相线）、渐变。灰主要给未唱用。 */
export type LyricsFillMode = "black" | "white" | "gray" | "solid" | "gradient";
/** 副行多一个「跟随」主行已唱色。 */
export type LyricsSecondaryMode = LyricsFillMode | "follow";
/** 边框多一个「无」。 */
export type LyricsStrokeMode = LyricsFillMode | "none";
export type LyricsColorMode = LyricsFillMode | "none" | "follow";

/** 未唱「灰」预设，约等于旧版半透明白在深色底上的观感。 */
export const LYRICS_GRAY_HEX = "#9e9e9e";

export interface LyricsColorPaint {
  mode: LyricsColorMode;
  /** 单色，或渐变左端。黑 / 白 / 灰 / 无 / 跟随 模式下可忽略。 */
  start: string;
  /** 渐变右端。 */
  end: string;
}

export function normalizeHex(value: unknown, fallback = "#ffffff"): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(trimmed) ? trimmed : fallback;
}

export function normalizeColorMode(
  value: unknown,
  options: { allowNone?: boolean; allowFollow?: boolean } = {},
): LyricsColorMode {
  if (
    value === "black" ||
    value === "white" ||
    value === "gray" ||
    value === "solid" ||
    value === "gradient"
  ) {
    return value;
  }
  if (options.allowNone && value === "none") return "none";
  if (options.allowFollow && value === "follow") return "follow";
  return "solid";
}

export function normalizePaint(
  mode: unknown,
  start: unknown,
  end: unknown,
  fallback: LyricsColorPaint,
  options: boolean | { allowNone?: boolean; allowFollow?: boolean } = false,
): LyricsColorPaint {
  const flags = typeof options === "boolean" ? { allowNone: options } : options;
  return {
    mode: normalizeColorMode(mode ?? fallback.mode, flags),
    start: normalizeHex(start, fallback.start),
    end: normalizeHex(end, fallback.end),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const light = clamp01(l);
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (channel: number) =>
    Math.round((channel + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHex(hex, "");
  if (!normalized) return null;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return { h: h * 360, s, l };
}

/** 解析后的实际填色（黑 / 白会盖过 start；跟随需先 resolve 再传入）。 */
export function effectivePaint(paint: LyricsColorPaint): {
  mode: "solid" | "gradient" | "none";
  start: string;
  end: string;
} {
  if (paint.mode === "none" || paint.mode === "follow") {
    return { mode: "none", start: "#000000", end: "#000000" };
  }
  if (paint.mode === "black") return { mode: "solid", start: "#000000", end: "#000000" };
  if (paint.mode === "white") return { mode: "solid", start: "#ffffff", end: "#ffffff" };
  if (paint.mode === "gray") return { mode: "solid", start: LYRICS_GRAY_HEX, end: LYRICS_GRAY_HEX };
  if (paint.mode === "gradient") {
    return { mode: "gradient", start: paint.start, end: paint.end };
  }
  return { mode: "solid", start: paint.start, end: paint.start };
}

/** 色相线是否需要展示（只有单色 / 渐变）。 */
export function needsHueLine(mode: LyricsColorMode): boolean {
  return mode === "solid" || mode === "gradient";
}

/** 副行选「跟随」时用主行已唱色。 */
export function resolveFollowPaint(
  paint: LyricsColorPaint,
  accent: LyricsColorPaint,
): LyricsColorPaint {
  return paint.mode === "follow" ? accent : paint;
}

/** 色相线位置 → 颜色。整条都是满饱和色相，不含黑白。 */
export function tToHex(t: number): string {
  return hslToHex(clamp01(t) * 360, 1, 0.5);
}

/** 颜色 → 色相线位置；非彩色（近灰）回落到 0。 */
export function hexToT(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  if (s < 0.12 || l < 0.08 || l > 0.96) return 0;
  return clamp01(h / 360);
}

/** 纯彩色相线（无黑白端）。 */
export const HUE_LINE_GRADIENT =
  "linear-gradient(90deg, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)";

export function paintCss(paint: LyricsColorPaint): {
  color: string;
  backgroundImage: string | undefined;
  clipText: boolean;
} {
  const effective = effectivePaint(paint);
  if (effective.mode === "none") {
    return { color: "transparent", backgroundImage: undefined, clipText: false };
  }
  if (effective.mode === "gradient") {
    return {
      color: "transparent",
      backgroundImage: `linear-gradient(90deg, ${effective.start}, ${effective.end})`,
      clipText: true,
    };
  }
  return { color: effective.start, backgroundImage: undefined, clipText: false };
}

export function strokeCss(paint: LyricsColorPaint): {
  color: string;
  widthPrimary: string;
  widthSecondary: string;
} {
  const effective = effectivePaint(paint);
  if (effective.mode === "none") {
    return { color: "transparent", widthPrimary: "0px", widthSecondary: "0px" };
  }
  let color = effective.start;
  if (effective.mode === "gradient") {
    const a = hexToRgb(effective.start);
    const b = hexToRgb(effective.end);
    if (a && b) {
      const mid = {
        r: Math.round((a.r + b.r) / 2),
        g: Math.round((a.g + b.g) / 2),
        b: Math.round((a.b + b.b) / 2),
      };
      const to = (n: number) => n.toString(16).padStart(2, "0");
      color = `#${to(mid.r)}${to(mid.g)}${to(mid.b)}`;
    }
  }
  // 旧版 3px / 2px 太粗，压到接近细描边。
  return { color, widthPrimary: "1.15px", widthSecondary: "0.85px" };
}
