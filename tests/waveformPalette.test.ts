import assert from "node:assert/strict";
import test from "node:test";

import {
  vocalGuideWaveformDisplayRgb,
  waveformDisplayRgb,
} from "../src/lib/waveformPalette";

test("waveform palette keeps unmistakable RGB frequency identities", () => {
  const low = waveformDisplayRgb(255, 0, 0);
  const mid = waveformDisplayRgb(0, 255, 0);
  const high = waveformDisplayRgb(0, 0, 255);
  assert.ok(low[0] > low[1] + 90 && low[0] > low[2] + 90);
  assert.ok(mid[1] > mid[0] + 90 && mid[1] > mid[2] + 90);
  assert.ok(high[2] > high[0] + 90 && high[2] > high[1] + 90);
});

test("quiet coloured sections remain explicitly bright", () => {
  const quiet = waveformDisplayRgb(255, 70, 18, 0);
  const loud = waveformDisplayRgb(255, 70, 18, 1);
  assert.ok(Math.max(...quiet) >= 210);
  assert.ok(Math.min(...quiet) >= 85);
  assert.ok(Math.max(...loud) > Math.max(...quiet));
  assert.ok(Math.max(...loud) - Math.max(...quiet) <= 20);
});

test("palette lowers saturation by lifting secondary channels rather than dimming peaks", () => {
  const primaries = [
    waveformDisplayRgb(255, 0, 0, 1),
    waveformDisplayRgb(0, 255, 0, 1),
    waveformDisplayRgb(0, 0, 255, 1),
  ];
  for (const colour of primaries) {
    const peak = Math.max(...colour);
    const floor = Math.min(...colour);
    assert.ok(peak >= 225);
    assert.ok(floor >= 90);
    assert.ok((peak - floor) / peak <= 0.63);
  }
});

test("broadband columns stay bright grey instead of clipping into a white wall", () => {
  const broadband = waveformDisplayRgb(255, 255, 255, 1);
  assert.ok(Math.min(...broadband) >= 165);
  assert.ok(Math.max(...broadband) <= 190);
});

test("different frequency balances remain visibly distinct", () => {
  const warm = waveformDisplayRgb(255, 150, 45, 0.7);
  const cool = waveformDisplayRgb(45, 150, 255, 0.7);
  const distance = warm.reduce(
    (sum, channel, index) => sum + Math.abs(channel - cool[index]),
    0,
  );
  assert.ok(distance >= 80);
});

test("silent colour input remains black", () => {
  assert.deepEqual(waveformDisplayRgb(0, 0, 0, 1), [0, 0, 0]);
});

test("vocal guide palette stays vivid from yellow through green", () => {
  const warm = vocalGuideWaveformDisplayRgb(255, 0, 0, 1);
  const presence = vocalGuideWaveformDisplayRgb(0, 255, 0, 1);
  const air = vocalGuideWaveformDisplayRgb(0, 0, 255, 1);
  const broadband = vocalGuideWaveformDisplayRgb(255, 255, 255, 1);

  for (const colour of [warm, presence, air, broadband]) {
    assert.ok(Math.max(...colour) >= 230, "guide remains bright");
    assert.ok(colour[2] <= 90, "guide never drifts into blue/cyan");
  }
  assert.ok(warm[0] > warm[1] && warm[1] > warm[2] * 8, "warm vocals read yellow");
  assert.ok(presence[1] > presence[0] && presence[0] > presence[2] * 5, "presence reads yellow-green");
  assert.ok(air[1] > air[0] * 4 && air[1] > air[2] * 2, "air reads green");
});

test("vocal guide brightness is stable because amplitude already controls height", () => {
  const quiet = vocalGuideWaveformDisplayRgb(90, 210, 35, 0);
  const loud = vocalGuideWaveformDisplayRgb(90, 210, 35, 1);
  assert.ok(loud.every((channel, index) => channel >= quiet[index]));
  assert.ok(loud.every((channel, index) => channel - quiet[index] <= 26));
  assert.deepEqual(vocalGuideWaveformDisplayRgb(0, 0, 0, 1), [0, 0, 0]);
});
