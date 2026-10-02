import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  optionAttributes,
  parseThemeManifest,
  resolveThemeMode,
  themeRgb,
  waveBandRgb,
  type ThemeManifest,
} from "../src/lib/themePack";

const base = {
  kdj: 1,
  id: "sketch",
  name: "手绘",
  modes: ["light", "dark"],
  css: "theme.css",
  window: { light: "#f8f3e8", dark: "#23302b" },
  options: [
    { id: "icon-filter", type: "boolean", label: "图标滤镜", default: true },
    { id: "boil", type: "boolean", label: "抖动" },
    { id: "density", type: "select", label: "未来的类型" },
  ],
};

test("a valid manifest parses and unknown option types are ignored", () => {
  const manifest = parseThemeManifest(base, "sketch") as ThemeManifest;
  assert.equal(manifest.id, "sketch");
  assert.deepEqual(manifest.options.map((o) => o.id), ["icon-filter", "boil"]);
});

test("broken manifests are rejected with a reason", () => {
  for (const [patch, dir] of [
    [{ kdj: 2 }, "sketch"],
    [{}, "other-folder"],
    [{ id: "../x" }, "../x"],
    [{ name: " " }, "sketch"],
    [{ modes: ["sepia"] }, "sketch"],
    [{ css: "../../design.css" }, "sketch"],
    [{ css: "/etc/passwd" }, "sketch"],
    [{ js: "a\\b.js" }, "sketch"],
    [{ window: { light: "#f8f3e8" } }, "sketch"],
    [{ window: { light: "red", dark: "#000000" } }, "sketch"],
  ] as const) {
    assert.equal(typeof parseThemeManifest({ ...base, ...patch }, dir), "string", JSON.stringify(patch));
  }
});

test("options map to attributes; stored values beat defaults", () => {
  const manifest = parseThemeManifest(base, "sketch") as ThemeManifest;
  assert.deepEqual(optionAttributes(manifest, undefined), ["data-theme-opt-icon-filter"]);
  assert.deepEqual(
    optionAttributes(manifest, { "icon-filter": false, boil: true, stale: true }),
    ["data-theme-opt-boil"],
  );
});

test("a single-mode pack forces its mode; no pack leaves the base alone", () => {
  const dual = parseThemeManifest(base, "sketch") as ThemeManifest;
  const darkOnly = parseThemeManifest(
    { ...base, modes: ["dark"], window: { dark: "#0a0b1e" } },
    "sketch",
  ) as ThemeManifest;
  assert.equal(resolveThemeMode(null, "light"), "light");
  assert.equal(resolveThemeMode(dual, "light"), "light");
  assert.equal(resolveThemeMode(darkOnly, "light"), "dark");
});

test("token readers fall back to the default look without a DOM", () => {
  assert.deepEqual(themeRgb("--kd-wave-detail-bg", [8, 10, 13]), [8, 10, 13]);
  assert.deepEqual(waveBandRgb([200, 120, 40]), [200, 120, 40]);
});

test("Sakura wave pigments preserve band hues without clipping mixed columns to white", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previousDocument = globalThis.document;
  const previousComputedStyle = globalThis.getComputedStyle;
  const pigments: Record<string, string> = {
    "--kd-wave-low": "rgb(230, 107, 148)",
    "--kd-wave-mid": "rgb(174, 139, 222)",
    "--kd-wave-high": "rgb(101, 190, 200)",
  };
  globalThis.document = dom.window.document;
  // jsdom does not resolve CSS variables; supply the theme's resolved token colours.
  globalThis.getComputedStyle = ((element: HTMLElement) => ({
    color: pigments[element.style.color.match(/var\(([^,]+)/)?.[1] ?? ""],
  })) as typeof getComputedStyle;
  try {
    assert.deepEqual(waveBandRgb([255, 0, 0]), [230, 107, 148]);
    assert.deepEqual(waveBandRgb([0, 255, 0]), [174, 139, 222]);
    assert.deepEqual(waveBandRgb([0, 0, 255]), [101, 190, 200]);
    assert.deepEqual(waveBandRgb([255, 255, 255]), [168, 145, 190]);
    assert.deepEqual(waveBandRgb([220, 220, 220]), [168, 145, 190]);
    assert.deepEqual(waveBandRgb([0, 0, 0]), [0, 0, 0]);
    assert.deepEqual(waveBandRgb([128, 0, 0]), [115, 54, 74]);
    const neutralDisplay = [200, 200, 200] as const;
    const unchanged = waveBandRgb(neutralDisplay);
    assert.deepEqual(waveBandRgb(neutralDisplay, [255, 0, 0]), unchanged);
    document.documentElement.dataset.themePack = "sakulaptop98";
    // Identical softened display colours must still expose distinct measured bands.
    assert.deepEqual(waveBandRgb(neutralDisplay, [255, 0, 0]), [230, 107, 148]);
    assert.deepEqual(waveBandRgb(neutralDisplay, [0, 255, 0]), [174, 139, 222]);
    assert.deepEqual(waveBandRgb(neutralDisplay, [0, 0, 255]), [101, 190, 200]);
    assert.deepEqual(waveBandRgb(neutralDisplay, [0, 0, 0]), [0, 0, 0]);
    delete document.documentElement.dataset.themePack;
    assert.deepEqual(waveBandRgb(neutralDisplay, [255, 0, 0]), unchanged);
  } finally {
    globalThis.document = previousDocument;
    globalThis.getComputedStyle = previousComputedStyle;
    dom.window.close();
  }
});
