import assert from "node:assert/strict";
import test from "node:test";
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
