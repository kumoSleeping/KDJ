import type { VisualizerImage } from "./audioVisualizerImage";
import { clamp } from "./visualizerStudio";

export interface StudioPalette { accent: string; colors: { color: string; share: number }[]; shade: { color: string; alphaScale: number } }
type ColorBin = { r: number; g: number; b: number; weight: number };
const palettes = new WeakMap<VisualizerImage, StudioPalette>();
const hex = (rgb: number[]) => `#${rgb.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
const distance = (a: ColorBin, b: ColorBin) => .3 * (a.r - b.r) ** 2 + .59 * (a.g - b.g) ** 2 + .11 * (a.b - b.b) ** 2;
function hue(color: ColorBin): [number, number, number] {
  const r = color.r / 255, g = color.g / 255, b = color.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, light = (max + min) / 2;
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, d === 0 ? 0 : d / (1 - Math.abs(2 * light - 1)), light];
}
function hslRgb(h: number, s: number, l: number): number[] {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => { const k = (n + h / 30) % 12; return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255; };
  return [channel(0), channel(8), channel(4)];
}
function readableAccent(color: ColorBin): string {
  const [h, saturation, light] = hue(color);
  // Preserve neutrals on monochrome art; don't invent a blue fallback hue.
  const s = saturation < .08 ? saturation : clamp(saturation, .32, .78), l = clamp(light, .48, .64);
  return hex(hslRgb(h, s, l));
}
function themeShade(colors: ColorBin[]): StudioPalette["shade"] {
  const total = colors.reduce((sum, color) => sum + color.weight, 0);
  const chromatic = colors.map(color => ({ ...color, hsl: hue(color) })).filter(color => color.weight > 0 && color.hsl[1] >= .14 && color.hsl[2] > .06 && color.hsl[2] < .94);
  const cyan = (h: number) => h >= 155 && h <= 205;
  const coloredWeight = chromatic.reduce((sum, color) => sum + color.weight, 0);
  const cyanWeight = chromatic.reduce((sum, color) => sum + (cyan(color.hsl[0]) ? color.weight : 0), 0);
  // A small cyan highlight must not tint an otherwise warm/purple album.
  const cyanIsTheme = cyanWeight >= total * .12 && cyanWeight >= coloredWeight * .45;
  const candidates = chromatic.filter(color => cyanIsTheme || !cyan(color.hsl[0]));
  if (!candidates.length) return { color: "#626262", alphaScale: 1 };
  const score = (color: typeof candidates[number]) => candidates.reduce((sum, other) => {
    const delta = Math.abs(color.hsl[0] - other.hsl[0]);
    return sum + (Math.min(delta, 360 - delta) <= 35 ? other.weight : 0);
  }, 0) * (.75 + color.hsl[1] * .25);
  const dominant = candidates.reduce((a, b) => score(b) > score(a) ? b : a);
  const [h, saturation] = dominant.hsl, isCyan = cyan(h);
  const s = clamp(saturation, .45, isCyan ? .55 : .72);
  // Match perceived luminance across hues: equal HSL lightness makes purple
  // much darker than green. Keep a clear chromatic shade, not near-black mud.
  let lo = 0, hi = 1;
  for (let i = 0; i < 14; i++) {
    const l = (lo + hi) / 2;
    const [r, g, b] = hslRgb(h, s, l).map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
    if (.2126 * r + .7152 * g + .0722 * b < .12) lo = l; else hi = l;
  }
  return { color: hex(hslRgb(h, s, (lo + hi) / 2)), alphaScale: isCyan ? .7 : 1 };
}

/** Area-weighted color clustering, independent of preview size and animation.
 * Percentages describe actual nontransparent pixels, not saturation-biased scores.
 * Accent selection discounts near-white/black backgrounds, then blends only
 * neighboring hues: opposing colors must not average into muddy gray. */
export function extractStudioPalette(image: VisualizerImage): StudioPalette {
  const cached = palettes.get(image); if (cached) return cached;
  const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 96;
  const c = canvas.getContext("2d", { willReadFrequently: true })!;
  c.drawImage(image, 0, 0, 96, 96);
  const pixels = c.getImageData(0, 0, 96, 96).data, histogram = new Map<number, ColorBin>();
  for (let i = 0; i < pixels.length; i += 4) {
    const weight = pixels[i + 3] / 255; if (weight < .2) continue;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
    const bin = histogram.get(key) || { r: 0, g: 0, b: 0, weight: 0 };
    bin.r += r * weight; bin.g += g * weight; bin.b += b * weight; bin.weight += weight; histogram.set(key, bin);
  }
  const bins = [...histogram.values()].map(b => ({ r: b.r / b.weight, g: b.g / b.weight, b: b.b / b.weight, weight: b.weight })).sort((a, b) => b.weight - a.weight);
  if (!bins.length) {
    const empty = { accent: "#a6a6a6", colors: [], shade: themeShade([]) };
    palettes.set(image, empty); return empty;
  }
  const centers = [{ ...bins[0] }];
  while (centers.length < Math.min(5, bins.length)) {
    let best = bins[0], score = 0;
    for (const bin of bins) {
      const value = Math.min(...centers.map(center => distance(bin, center))) * Math.sqrt(bin.weight);
      if (value > score) { best = bin; score = value; }
    }
    if (!score) break;
    centers.push({ ...best });
  }
  for (let pass = 0; pass < 7; pass++) {
    const sums = centers.map(() => ({ r: 0, g: 0, b: 0, weight: 0 }));
    for (const bin of bins) {
      let closest = 0;
      for (let i = 1; i < centers.length; i++) if (distance(bin, centers[i]) < distance(bin, centers[closest])) closest = i;
      const sum = sums[closest]; sum.r += bin.r * bin.weight; sum.g += bin.g * bin.weight; sum.b += bin.b * bin.weight; sum.weight += bin.weight;
    }
    sums.forEach((sum, i) => { centers[i] = sum.weight ? { r: sum.r / sum.weight, g: sum.g / sum.weight, b: sum.b / sum.weight, weight: sum.weight } : { ...centers[i], weight: 0 }; });
  }
  centers.sort((a, b) => b.weight - a.weight);
  const score = (color: ColorBin) => {
    const [, s, l] = hue(color);
    return color.weight * (.12 + s) * (l < .08 || l > .94 ? .12 : 1);
  };
  const dominant = centers.reduce((a, b) => score(b) > score(a) ? b : a), [dominantHue, saturation] = hue(dominant);
  const family = centers.filter(color => {
    const [h, s] = hue(color), delta = Math.abs(h - dominantHue);
    return color.weight > 0 && (saturation < .08 ? s < .08 : s >= .08 && Math.min(delta, 360 - delta) < 40);
  });
  const total = centers.reduce((sum, color) => sum + color.weight, 0), weight = family.reduce((sum, color) => sum + color.weight, 0);
  const average = family.reduce((sum, color) => ({ r: sum.r + color.r * color.weight / weight, g: sum.g + color.g * color.weight / weight, b: sum.b + color.b * color.weight / weight, weight: 1 }), { r: 0, g: 0, b: 0, weight: 1 });
  const result = { accent: readableAccent(average), colors: centers.filter(color => color.weight > 0).map(color => ({ color: hex([color.r, color.g, color.b]), share: color.weight / total })), shade: themeShade(centers) };
  palettes.set(image, result); return result;
}
