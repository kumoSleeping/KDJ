import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SONG_COLOR,
  FIELD_MAX_LUMINANCE,
  INK_FAINT_CONTRAST,
  INK_MUTED_CONTRAST,
  INK_TEXT_CONTRAST,
  GROUND_INK_CONTRAST,
  fieldPeakLuminance,
  inkOnGround,
  inkTone,
  lightColours,
  luminanceContrast,
  parseHex,
  relativeLuminance,
  songColorPalette,
  toneOf,
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

test("song colour: ink on a picture is light while white reads there and the cover's colour past that, never near black", () => {
  const spread = (hex: string) => { const rgb = parseHex(hex)!; return Math.max(...rgb) - Math.min(...rgb); };
  for (const accent of ["#45dce8", "#d2475f", "#8a8a8a", "#f2d24b"]) {
    for (const ground of [0, 0.05, 0.18, 0.29, 0.39, 0.45, 0.6, 0.8, 1]) {
      const ink = inkOnGround(accent, ground), luminance = relativeLuminance(parseHex(ink.color)!);
      assert.equal(ink.light, ground <= 0.4, `${accent} on ${ground}`);
      assert.equal(luminance > ground, ink.light);
      if (ink.light) assert.ok(luminanceContrast(luminance, ground) >= GROUND_INK_CONTRAST - 0.05, `${accent} on ${ground}: ${ink.color}`);
      else if (accent === "#8a8a8a") assert.ok(luminanceContrast(luminance, ground) >= INK_TEXT_CONTRAST - 0.05, `grey on ${ground}: ${ink.color}`);
      else {
        // A colour, and one that still stands off the picture: not a tone so deep it reads as black.
        assert.ok(spread(ink.color) >= 60 && luminance >= 0.08, `${accent} on ${ground}: ${ink.color}`);
        assert.ok(luminanceContrast(luminance, ground) >= 1.9, `${accent} on ${ground}: ${ink.color}`);
      }
    }
  }
  // A grey accent gives grey ink: no hue is invented.
  const grey = parseHex(inkOnGround("#8a8a8a", 0.8).color)!;
  assert.ok(Math.max(...grey) - Math.min(...grey) <= 2, String(grey));
});

test("song colour: a light of a field's colour keeps its hue and is no stronger than the colour was", () => {
  const light = parseHex(toneOf("#7a1f2b", 0.84, 0.13))!;
  assert.ok(light[0] > light[1] && light[0] > light[2], `still red: ${light}`);
  assert.ok(relativeLuminance(light) > 0.5, "and light");
  const grey = parseHex(toneOf("#4a4a4a", 0.84, 0.13))!;
  assert.ok(Math.max(...grey) - Math.min(...grey) <= 2, String(grey));
  assert.equal(toneOf("not a colour", 0.5, 0.1), "not a colour");
});

test("song colour: ink between white and the deep tone goes by the colour, not by grey", () => {
  const spread = (hex: string) => { const rgb = parseHex(hex)!; return Math.max(...rgb) - Math.min(...rgb); };
  const steps = Array.from({ length: 9 }, (_, step) => inkTone("#3f7fd0", step / 8));
  // From all but white to the colour itself, darker at every step but never near black.
  const end = relativeLuminance(parseHex(steps[8])!);
  assert.ok(relativeLuminance(parseHex(steps[0])!) > 0.9 && end > 0.08 && end < 0.3, `${steps[0]} … ${steps[8]}`);
  for (let step = 1; step < steps.length; step += 1) {
    assert.ok(relativeLuminance(parseHex(steps[step])!) < relativeLuminance(parseHex(steps[step - 1])!), `step ${step}: ${steps[step]}`);
  }
  // The colour is taken on early: from the middle on every step is plainly the hue.
  for (let step = 4; step <= 8; step += 1) {
    const rgb = parseHex(steps[step])!;
    assert.ok(spread(steps[step]) > spread(steps[0]) + 40 && rgb[2] > rgb[0], `step ${step}: ${steps[step]}`);
  }
  // A grey accent shades through greys.
  for (let step = 0; step <= 8; step += 1) assert.ok(spread(inkTone("#8a8a8a", step / 8)) <= 2);
});

test("song colour: no light is a grey among coloured ones, and an all-grey field stays grey", () => {
  const spread = (hex: string) => { const rgb = parseHex(hex)!; return Math.max(...rgb) - Math.min(...rgb); };
  // A cover that is mostly white with one colour: one mass carries the white.
  const palette = songColorPalette([{ color: "#f4f4f2", share: 0.6 }, { color: "#d2475f", share: 0.3 }, { color: "#2b2b2b", share: 0.1 }]);
  const lights = lightColours(palette, 0.74, 0.19);
  assert.equal(lights.length, 4);
  for (const light of lights) assert.ok(spread(light) >= 40, `${light} has a hue (${palette.masses})`);
  // None of them is light enough to flash white where it falls.
  for (const light of lights) assert.ok(relativeLuminance(parseHex(light)!) < 0.6, light);
  const grey = lightColours(songColorPalette([{ color: "#eeeeee", share: 0.5 }, { color: "#222222", share: 0.5 }]), 0.74, 0.19);
  for (const light of grey) assert.ok(spread(light) <= 6, light);
});
