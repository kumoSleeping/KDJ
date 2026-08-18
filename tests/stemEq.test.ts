import assert from "node:assert/strict";
import test from "node:test";
import {
  clampStemGain,
  STEM_GAIN_MAX,
  STEM_GAIN_UNITY,
  stemEqPointerAngle,
  stemEqRingFillPath,
  stemEqToGain,
  stemGainToEq,
} from "../src/lib/stemEq";

test("STEM EQ 中位是原曲音量，两端是静音和 +6 dB", () => {
  assert.equal(stemEqToGain(0), STEM_GAIN_UNITY);
  assert.equal(stemEqToGain(-1), 0);
  assert.equal(stemEqToGain(1), STEM_GAIN_MAX);
});

test("linear gain round-trips through the bipolar STEM EQ scale", () => {
  for (const gain of [0, 0.5, 1, 1.5, 2]) {
    assert.equal(stemEqToGain(stemGainToEq(gain)), gain);
  }
});

test("invalid or out-of-range gains fall back to a usable mix", () => {
  assert.equal(clampStemGain(Number.NaN), STEM_GAIN_UNITY);
  assert.equal(clampStemGain(-4), 0);
  assert.equal(clampStemGain(9), STEM_GAIN_MAX);
  assert.equal(stemEqToGain(Number.POSITIVE_INFINITY), STEM_GAIN_UNITY);
});

test("STEM EQ 填充从 12 点跟到指针，切除走左侧", () => {
  assert.equal(stemEqPointerAngle(0), 0);
  assert.equal(stemEqPointerAngle(-1), -135);
  assert.equal(stemEqPointerAngle(1), 135);
  assert.equal(stemEqRingFillPath(0), null);
  const cut = stemEqRingFillPath(-1);
  assert.ok(cut && cut.includes("A 14.5 14.5 0 0 0"), cut);
  const boost = stemEqRingFillPath(1);
  assert.ok(boost && boost.includes("A 14.5 14.5 0 0 1"), boost);
});
