/**
 * 歌曲色彩: from the colours of a cover to the colours of the field behind the lyrics and the
 * playing song's bubble (SongColorBackdrop).
 *
 * The cover is read by the palette extractor the visualizer already has
 * (visualizerStudioPalette.ts): up to five colours with the share of the picture each one
 * covers. This file only decides what the field makes of them. The field is deep and the text
 * on it light, as in Apple Music's lyrics, in the light theme and the dark one alike — so every
 * colour is brought into a band of lightness that light ink reads on, its chroma kept rich but
 * capped, and the four masses are pushed apart when the cover gives colours that are too alike.
 * The ink for the two surfaces is derived from the same result and holds a contrast floor
 * against the brightest the field gets.
 *
 * Pure: no DOM, no canvas. Colours are worked in OKLCH, where a step of lightness or hue looks
 * the same size whatever the hue is.
 */

export type Rgb = readonly [number, number, number];

/** What ink reads on the field: the values a surface takes for its text colours. */
export interface SongColorInk {
  /** Titles, the sung line, keys that are on. */
  text: string;
  /** Running text. */
  body: string;
  /** Secondary text, keys at rest, the waveform still to play. */
  muted: string;
  /** The quietest line (BPM, key, length). */
  faint: string;
}

export interface SongColorPalette {
  /** Where the colours come from: the cover, or nothing that could be read. */
  source: "cover" | "default";
  /** The floor of the field: its deepest colour. */
  base: string;
  /** The masses that drift over the floor, the one that covers most first. */
  masses: readonly [string, string, string, string];
  /** The light that swells on the beat. */
  glow: string;
  ink: SongColorInk;
}

/** How bright (relative luminance) a mass may be. White ink on it is then about 7:1. */
export const FIELD_MAX_LUMINANCE = 0.095;
/** The glow at the top of a beat is this much of what is seen where it is strongest. */
export const GLOW_PEAK_ALPHA = 0.3;
/** Contrast floors: the main text against the field under the glow's peak, the quieter inks
 *  against the brightest mass at rest. */
export const INK_TEXT_CONTRAST = 4.5;
export const INK_MUTED_CONTRAST = 4;
export const INK_FAINT_CONTRAST = 3;

const MASS_LIGHT_FLOOR = 0.27;
const MASS_LIGHT_SPAN = 0.2;
const MASS_CHROMA_MIN = 0.06;
const MASS_CHROMA_MAX = 0.15;
/** Below this chroma a colour has no hue worth keeping: black, white, grey. A light colour
 *  shows its hue at less chroma than a dark one does (a pastel is still a colour). */
const NEUTRAL_CHROMA = 0.035;
const neutralChroma = (lightness: number) => 0.02 + 0.02 * (1 - clamp(lightness, 0, 1));
/** Masses closer than this (OKLab distance) read as one. */
const MASS_APART = 0.07;
const GLOW_LIGHT = 0.66;

interface Lch { l: number; c: number; h: number }
interface Cluster extends Lch { share: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const toLinear = (channel: number) => {
  const n = channel / 255;
  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (value: number) => {
  const n = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(clamp(n, 0, 1) * 255);
};

export function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map(channel => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance, 0..1. */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
}

/** WCAG contrast of two luminances, 1..21. */
export function luminanceContrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function contrastRatio(a: string, b: string): number {
  const first = parseHex(a), second = parseHex(b);
  if (!first || !second) return 1;
  return luminanceContrast(relativeLuminance(first), relativeLuminance(second));
}

function rgbToLch(rgb: Rgb): Lch {
  const r = toLinear(rgb[0]), g = toLinear(rgb[1]), b = toLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: lightness, c: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360 };
}

function lchToLinear({ l, c, h }: Lch): [number, number, number] {
  const a = c * Math.cos(h * Math.PI / 180), b = c * Math.sin(h * Math.PI / 180);
  const ll = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const ss = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
    -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
    -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss,
  ];
}

const inGamut = (linear: readonly number[]) => linear.every(value => value >= -0.0005 && value <= 1.0005);

/** The colour as sRGB; chroma the screen cannot show is given up, lightness and hue are kept. */
function lchToRgb(colour: Lch): Rgb {
  let linear = lchToLinear(colour);
  if (!inGamut(linear)) {
    let low = 0, high = colour.c;
    for (let step = 0; step < 18; step += 1) {
      const middle = (low + high) / 2;
      if (inGamut(lchToLinear({ ...colour, c: middle }))) low = middle; else high = middle;
    }
    linear = lchToLinear({ ...colour, c: low });
  }
  return [fromLinear(linear[0]), fromLinear(linear[1]), fromLinear(linear[2])];
}

/** A colour of the field: in gamut and no brighter than a mass may be. */
function fieldRgb(colour: Lch, cap = FIELD_MAX_LUMINANCE): Rgb {
  let lightness = colour.l, rgb = lchToRgb(colour);
  for (let step = 0; step < 40 && relativeLuminance(rgb) > cap; step += 1) {
    lightness -= 0.01;
    rgb = lchToRgb({ ...colour, l: lightness });
  }
  return rgb;
}

function labDistance(a: Rgb, b: Rgb): number {
  const first = rgbToLch(a), second = rgbToLch(b);
  const ax = first.c * Math.cos(first.h * Math.PI / 180), ay = first.c * Math.sin(first.h * Math.PI / 180);
  const bx = second.c * Math.cos(second.h * Math.PI / 180), by = second.c * Math.sin(second.h * Math.PI / 180);
  return Math.hypot(first.l - second.l, ax - bx, ay - by);
}

/** A cover's colour as a mass: its hue, its place between the cover's dark and light colours,
 *  and more chroma the lighter it was — a pastel that is only darkened turns to mud. */
function massFrom(colour: Lch): Lch {
  return {
    l: MASS_LIGHT_FLOOR + MASS_LIGHT_SPAN * clamp(colour.l, 0, 1),
    c: clamp(colour.c * (1.2 + 0.6 * clamp(colour.l, 0, 1)), MASS_CHROMA_MIN, MASS_CHROMA_MAX),
    h: colour.h,
  };
}

/** Light ink at `lightness`, lifted until it holds `floor` against a field as bright as `against`. */
function inkAt(lightness: number, hue: number, chroma: number, against: number, floor: number): string {
  let l = lightness, rgb = lchToRgb({ l, c: chroma, h: hue });
  while (l < 1 && luminanceContrast(relativeLuminance(rgb), against) < floor) {
    l = Math.min(1, l + 0.01);
    rgb = lchToRgb({ l, c: chroma, h: hue });
  }
  return toHex(rgb);
}

function finish(source: SongColorPalette["source"], masses: Lch[], base: Lch, glow: Lch): SongColorPalette {
  const shown = masses.map(mass => fieldRgb(mass));
  // Colours that came out alike are moved apart: away from the nearest one in lightness, and
  // once, a step round the hue circle. A grey has only its lightness to differ by.
  const top = MASS_LIGHT_FLOOR + MASS_LIGHT_SPAN + 0.02, bottom = MASS_LIGHT_FLOOR - 0.1;
  for (let index = 1; index < shown.length; index += 1) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const nearest = masses.slice(0, index).reduce((best, _mass, at) =>
        labDistance(shown[at], shown[index]) < labDistance(shown[best], shown[index]) ? at : best, 0);
      if (labDistance(shown[nearest], shown[index]) >= MASS_APART) break;
      const way = masses[index].l >= masses[nearest].l ? 1 : -1;
      // At the end of the band there is nowhere further to go; moving back would only close in.
      if (masses[index].l + way * 0.045 > top || masses[index].l + way * 0.045 < bottom) break;
      masses[index] = {
        l: masses[index].l + way * 0.045,
        c: masses[index].c,
        h: attempt === 1 ? (masses[index].h + way * 20 + 360) % 360 : masses[index].h,
      };
      shown[index] = fieldRgb(masses[index]);
    }
  }
  const brightest = Math.max(...shown.map(relativeLuminance));
  const glowRgb = lchToRgb(glow);
  const peak = brightest * (1 - GLOW_PEAK_ALPHA) + relativeLuminance(glowRgb) * GLOW_PEAK_ALPHA;
  const tint = glow.c < NEUTRAL_CHROMA ? 0 : 0.012;
  return {
    source,
    base: toHex(fieldRgb(base, FIELD_MAX_LUMINANCE * 0.5)),
    masses: [toHex(shown[0]), toHex(shown[1]), toHex(shown[2]), toHex(shown[3])],
    glow: toHex(glowRgb),
    ink: {
      text: inkAt(0.985, glow.h, tint, peak, INK_TEXT_CONTRAST),
      body: inkAt(0.95, glow.h, tint, peak, INK_TEXT_CONTRAST),
      muted: inkAt(0.86, glow.h, tint * 1.6, brightest, INK_MUTED_CONTRAST),
      faint: inkAt(0.77, glow.h, tint * 2, brightest, INK_FAINT_CONTRAST),
    },
  };
}

/** A field without a hue of its own: greys set apart by lightness only. */
function neutralPalette(source: SongColorPalette["source"], tint: Lch | null, light: number): SongColorPalette {
  const c = tint ? Math.min(tint.c, 0.014) : 0, h = tint?.h ?? 0;
  // A light picture gives a lighter field, a dark one a darker field, within the band.
  const lift = (clamp(light, 0, 1) - 0.5) * 0.06;
  return finish(source,
    [0.37, 0.29, 0.45, 0.22].map(l => ({ l: l + lift, c, h })),
    { l: 0.17 + lift, c, h },
    { l: GLOW_LIGHT + 0.04, c, h });
}

/** The calm field of a song without a cover that can be read: cool slate. */
export const DEFAULT_SONG_COLOR: SongColorPalette = finish("default",
  [{ l: 0.36, c: 0.045, h: 255 }, { l: 0.28, c: 0.05, h: 285 }, { l: 0.44, c: 0.04, h: 228 }, { l: 0.24, c: 0.04, h: 210 }],
  { l: 0.19, c: 0.025, h: 262 },
  { l: GLOW_LIGHT, c: 0.045, h: 240 });

/**
 * The field of a picture, from the colours the extractor found in it (`#rrggbb` and the share
 * of the picture each covers). Nothing to go on gives the default.
 */
export function songColorPalette(
  colours: readonly { color: string; share: number }[],
  source: SongColorPalette["source"] = "cover",
): SongColorPalette {
  const clusters: Cluster[] = [];
  for (const entry of colours) {
    const rgb = parseHex(entry.color);
    if (rgb && entry.share > 0.008) clusters.push({ ...rgbToLch(rgb), share: entry.share });
  }
  if (!clusters.length) return DEFAULT_SONG_COLOR;
  const total = clusters.reduce((sum, cluster) => sum + cluster.share, 0);
  const light = clusters.reduce((sum, cluster) => sum + cluster.l * cluster.share, 0) / total;
  // Near black and near white carry no hue the eye would name, whatever their chroma says.
  const chromatic = clusters.filter(cluster => cluster.c >= neutralChroma(cluster.l) && cluster.l > 0.16 && cluster.l < 0.97);
  const coloured = chromatic.reduce((sum, cluster) => sum + cluster.share, 0) / total;
  if (coloured < 0.05) {
    // Monochrome art stays monochrome: no hue is invented for it.
    const widest = clusters.reduce((a, b) => b.share > a.share ? b : a);
    return neutralPalette(source, widest.c > 0.006 ? widest : null, light);
  }
  // Area counts, but a colour counts for more than a grey of the same area.
  const weight = (cluster: Cluster) => Math.sqrt(cluster.share / total) * (0.4 + Math.min(cluster.c, 0.2) / 0.2);
  const ranked = [...chromatic].sort((a, b) => weight(b) - weight(a));
  const lead = ranked[0];
  const masses = ranked.slice(0, 4).map(massFrom);
  // A cover that is mostly black, white or grey keeps that in the field: one mass carries it,
  // faintly tinted by the leading colour, as dark or as light as the band allows.
  const neutrals = clusters.filter(cluster => !chromatic.includes(cluster));
  const neutralShare = neutrals.reduce((sum, cluster) => sum + cluster.share, 0) / total;
  if (neutralShare > 0.3 && masses.length < 4) {
    const tone = neutrals.reduce((sum, cluster) => sum + cluster.l * cluster.share, 0) / (neutralShare * total);
    masses.splice(1, 0, { l: MASS_LIGHT_FLOOR - 0.02 + (MASS_LIGHT_SPAN + 0.02) * tone, c: 0.03, h: lead.h });
  }
  // Fewer colours than masses: neighbours of the leading colour fill in.
  const leadMass = massFrom(lead);
  const fill: readonly [number, number, number][] = [[-0.06, 26, 0.9], [0.07, -22, 1], [-0.02, -44, 0.8]];
  for (let index = 0; masses.length < 4; index += 1) {
    const [dl, dh, scale] = fill[index % fill.length];
    masses.push({ l: leadMass.l + dl, c: leadMass.c * scale, h: (leadMass.h + dh + 360) % 360 });
  }
  const floor = Math.min(...masses.map(mass => mass.l));
  // The glow takes the hue of the lightest colour that has one.
  const lightest = chromatic.reduce((a, b) => b.l > a.l ? b : a);
  return finish(source, masses,
    { l: clamp(floor - 0.07, 0.16, 0.24), c: Math.min(leadMass.c * 0.5, 0.07), h: lead.h },
    { l: GLOW_LIGHT, c: clamp(lightest.c * 1.2, 0.04, 0.12), h: lightest.h });
}

/** The brightest the field gets where the glow is at its peak, as a relative luminance. */
export function fieldPeakLuminance(palette: SongColorPalette): number {
  const brightest = Math.max(...palette.masses.map(mass => relativeLuminance(parseHex(mass) ?? [0, 0, 0])));
  const glow = relativeLuminance(parseHex(palette.glow) ?? [0, 0, 0]);
  return brightest * (1 - GLOW_PEAK_ALPHA) + glow * GLOW_PEAK_ALPHA;
}
