import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_APP_FONT_SCALE,
  APP_FONT_SCALE_MAX,
  APP_FONT_SCALE_MIN,
  normalizeAppFontScale,
} from "../src/lib/fontScale";

test("app font scale accepts every whole-percent step from 75% through 150%", () => {
  for (let scale = APP_FONT_SCALE_MIN; scale <= APP_FONT_SCALE_MAX; scale += 1) {
    assert.equal(normalizeAppFontScale(scale), scale);
    assert.equal(normalizeAppFontScale(String(scale)), scale);
  }
});

test("app font scale falls back to the slightly larger default for invalid values", () => {
  for (const value of [null, undefined, 74, 151, 106.5, "large", {}, []]) {
    assert.equal(normalizeAppFontScale(value), DEFAULT_APP_FONT_SCALE);
  }
});
