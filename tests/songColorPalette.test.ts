import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SONG_COLOR,
  FIELD_MAX_LUMINANCE,
  INK_FAINT_CONTRAST,
  INK_MUTED_CONTRAST,
  INK_TEXT_CONTRAST,
  fieldPeakLuminance,
  luminanceContrast,
  parseHex,
  relativeLuminance,
  songColorPalette,
  type SongColorPalette,
} from "../src/lib/songColorPalette";

const luminance = (hex: string) => relativeLuminance(parseHex(hex)!);
const spread = (hex: string) => { const [r, g, b] = parseHex(hex)!; return Math.max(r, g, b) - Math.min(r, g, b); };

const covers: Record<string, { color: string; share: number }[]> = {
  bright: [{ color: "#ffd23f", share: 0.4 }, { color: "#ff6b9d", share: 0.3 }, { color: "#3ec1d3", share: 0.2 }, { color: "#ffffff", share: 0.1 }],
  dark: [{ color: "#0a0a14", share: 0.7 }, { color: "#1b1f4b", share: 0.2 }, { color: "#e63946", share: 0.06 }, { color: "#f1faee", share: 0.04 }],
  pastel: [{ color: "#f8d7e3", share: 0.5 }, { color: "#d7e8f8", share: 0.3 }, { color: "#fdf3c4", share: 0.2 }],
  grey: [{ color: "#e8e8e8", share: 0.5 }, { color: "#8a8a8a", share: 0.3 }, { color: "#1e1e1e", share: 0.2 }],
  white: [{ color: "#ffffff", share: 1 }],
  black: [{ color: "#000000", share: 1 }],
  oneRed: [{ color: "#c1121f", share: 1 }],
  neon: [{ color: "#00ff00", share: 0.5 }, { color: "#ff00ff", share: 0.5 }],
};

/** Every field, whatever it was made from, is one that light ink reads on. */
function assertLegible(name: string, palette: SongColorPalette): void {
  const masses = palette.masses.map(luminance);
  const brightest = Math.max(...masses);
  for (const mass of masses) assert.ok(mass <= FIELD_MAX_LUMINANCE + 0.004, `${name}: a mass is no brighter than the cap (${mass.toFixed(3)})`);
  assert.ok(luminance(palette.base) <= brightest, `${name}: the floor is the deepest colour`);
  const peak = fieldPeakLuminance(palette);
  assert.ok(luminanceContrast(luminance(palette.ink.text), peak) >= INK_TEXT_CONTRAST, `${name}: text holds ${INK_TEXT_CONTRAST}:1 under the glow's peak`);
  assert.ok(luminanceContrast(luminance(palette.ink.body), peak) >= INK_TEXT_CONTRAST, `${name}: running text holds it too`);
  assert.ok(luminanceContrast(luminance(palette.ink.muted), brightest) >= INK_MUTED_CONTRAST, `${name}: muted ink holds ${INK_MUTED_CONTRAST}:1 on the brightest mass`);
  assert.ok(luminanceContrast(luminance(palette.ink.faint), brightest) >= INK_FAINT_CONTRAST, `${name}: the faintest ink holds ${INK_FAINT_CONTRAST}:1`);
  assert.ok(luminanceContrast(luminance(palette.ink.muted), peak) >= 3, `${name}: muted ink stays readable where the glow peaks`);
  // The three inks are still three levels.
  assert.ok(luminance(palette.ink.text) > luminance(palette.ink.muted) && luminance(palette.ink.muted) > luminance(palette.ink.faint), `${name}: text, muted and faint differ`);
}

test("song colour: every field keeps the contrast floor for light ink, from a light cover and a dark one", () => {
  for (const [name, colours] of Object.entries(covers)) assertLegible(name, songColorPalette(colours));
  assertLegible("default", DEFAULT_SONG_COLOR);
  // The ink is light whatever the cover: the field is deep in both themes.
  assert.ok(luminance(songColorPalette(covers.bright).ink.text) > 0.9);
  assert.ok(luminance(songColorPalette(covers.dark).ink.text) > 0.9);
});

test("song colour: the masses are the cover's colours, rich but capped, and told apart", () => {
  const bright = songColorPalette(covers.bright);
  assert.equal(bright.source, "cover");
  for (const mass of bright.masses) assert.ok(spread(mass) >= 60, `a colourful cover gives colourful masses (${mass})`);
  // No two masses of a field are the same colour, even from one colour or from none.
  for (const [name, colours] of Object.entries(covers)) {
    const palette = songColorPalette(colours);
    for (let a = 0; a < 4; a += 1) for (let b = a + 1; b < 4; b += 1) {
      const [first, second] = [parseHex(palette.masses[a])!, parseHex(palette.masses[b])!];
      const apart = Math.abs(first[0] - second[0]) + Math.abs(first[1] - second[1]) + Math.abs(first[2] - second[2]);
      assert.ok(apart >= 24, `${name}: masses ${a} and ${b} can be told apart (${palette.masses[a]} ${palette.masses[b]})`);
    }
  }
  // A dark cover gives a darker field than a bright one.
  const dark = songColorPalette(covers.dark);
  const mean = (palette: SongColorPalette) => palette.masses.reduce((sum, mass) => sum + luminance(mass), 0) / 4;
  assert.ok(mean(dark) < mean(bright));
  // Its small red sun is among the masses: a colour counts for more than a grey of its area.
  assert.ok(dark.masses.some(mass => { const [r, g, b] = parseHex(mass)!; return r > 2 * g && r > 2 * b; }), dark.masses.join(" "));
});

test("song colour: monochrome art stays monochrome, and nothing to go on is the calm default", () => {
  for (const name of ["grey", "white", "black"]) {
    const palette = songColorPalette(covers[name]);
    for (const colour of [...palette.masses, palette.base, palette.glow]) assert.ok(spread(colour) <= 6, `${name}: no hue is invented (${colour})`);
  }
  assert.equal(songColorPalette([]), DEFAULT_SONG_COLOR);
  assert.equal(songColorPalette([{ color: "not a colour", share: 1 }]), DEFAULT_SONG_COLOR);
  assert.equal(DEFAULT_SONG_COLOR.source, "default");
  // The default is quiet: far less chroma than a cover's field.
  for (const mass of DEFAULT_SONG_COLOR.masses) assert.ok(spread(mass) < 60, mass);
});
