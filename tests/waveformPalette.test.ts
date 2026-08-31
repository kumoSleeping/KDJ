import assert from "node:assert/strict";
import test from "node:test";

import {
  PERFORMANCE_DETAIL_BACKGROUND,
  PERFORMANCE_DETAIL_CONTRAST,
  RELEASE_OVERVIEW_CONTRAST,
  RELEASE_OVERVIEW_LIGHT_BACKGROUND,
  performanceDetailWaveformDisplayRgb,
  releaseOverviewWaveformDisplayRgb,
  waveformDisplayRgb,
  waveformSurfaceContrastRgb,
} from "../src/lib/waveformPalette";

test("surface contrast factors are literal around their real backgrounds", () => {
  const overview = waveformSurfaceContrastRgb(
    [200, 180, 220],
    RELEASE_OVERVIEW_LIGHT_BACKGROUND,
    RELEASE_OVERVIEW_CONTRAST,
  );
  assert.deepEqual(overview, [195, 173, 217]);
  assert.equal(
    RELEASE_OVERVIEW_LIGHT_BACKGROUND[0] - overview[0],
    Math.round((RELEASE_OVERVIEW_LIGHT_BACKGROUND[0] - 200) * 1.1),
  );

  const detail = waveformSurfaceContrastRgb(
    [200, 180, 220],
    PERFORMANCE_DETAIL_BACKGROUND,
    PERFORMANCE_DETAIL_CONTRAST,
  );
  assert.deepEqual(detail, [181, 163, 199]);
});

test("release overview preserves evidence ratios with the approved display cap", () => {
  assert.deepEqual(releaseOverviewWaveformDisplayRgb(255, 31, 80), [213, 54, 90]);
  assert.deepEqual(releaseOverviewWaveformDisplayRgb(31, 92, 255), [56, 101, 221]);
  assert.deepEqual(releaseOverviewWaveformDisplayRgb(92, 255, 31), [101, 221, 56]);

  const softened = releaseOverviewWaveformDisplayRgb(255, 31, 31);
  assert.ok(softened[0] > softened[1] && softened[0] > softened[2]);
  assert.ok(Math.max(...softened) >= 200, "overview should remain clear rather than pale");
});

test("performance detail shares overview hues but keeps navigation contrast", () => {
  const inputs = [
    [255, 31, 31],
    [31, 255, 31],
    [31, 31, 255],
  ] as const;
  for (const input of inputs) {
    const overview = releaseOverviewWaveformDisplayRgb(...input);
    const detail = performanceDetailWaveformDisplayRgb(...input, 1);
    const overviewDominant = overview.indexOf(Math.max(...overview));
    const detailDominant = detail.indexOf(Math.max(...detail));
    assert.equal(detailDominant, overviewDominant, "frequency identity must not change by zoom");
    assert.ok(Math.max(...detail) >= 225, "detail remains legible below beat-grid lines");
    const overviewChroma = (Math.max(...overview) - Math.min(...overview)) / Math.max(...overview);
    const detailChroma = (Math.max(...detail) - Math.min(...detail)) / Math.max(...detail);
    assert.ok(detailChroma < overviewChroma, "detail lifts secondary bands to avoid RGB confetti");
  }

  const neutral = performanceDetailWaveformDisplayRgb(255, 255, 255, 1);
  assert.ok(Math.min(...neutral) >= 175 && Math.max(...neutral) <= 190);
});

test("detail texture and transient evidence lift value without changing frequency identity", () => {
  const stable = performanceDetailWaveformDisplayRgb(232, 116, 58, 0.7, 0);
  const textured = performanceDetailWaveformDisplayRgb(255, 128, 64, 0.7, 0);
  const drumCore = performanceDetailWaveformDisplayRgb(255, 128, 64, 0.7, 1);
  assert.equal(stable.indexOf(Math.max(...stable)), 0);
  assert.equal(textured.indexOf(Math.max(...textured)), 0);
  assert.equal(drumCore.indexOf(Math.max(...drumCore)), 0);
  assert.ok(Math.max(...textured) > Math.max(...stable));
  assert.ok(Math.max(...drumCore) > Math.max(...textured));
  assert.ok(Math.max(...drumCore) <= 238);
});

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
