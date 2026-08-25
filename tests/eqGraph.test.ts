import assert from "node:assert/strict";
import test from "node:test";

import {
  EQ_GRAPH_BAND_COUNT,
  EQ_GRAPH_FREQUENCIES,
  eqControlWeightsAtRatio,
  eqCurveDbAtRatio,
  eqDbToGraphRatio,
  eqFrequencyAtRatio,
  eqGestureWeights,
  eqSpectrumLevelToRatio,
  channelFilterCutoffHz,
  channelFilterDbAtFrequency,
  channelFilterResonanceQ,
  CHANNEL_FILTER_RESONANCE_Q,
} from "../src/lib/eqGraph";

const centreRatio = (index: number) => (index + 0.5) / EQ_GRAPH_BAND_COUNT;

test("15 logarithmic display bands are grouped five per three-band EQ control", () => {
  assert.equal(EQ_GRAPH_FREQUENCIES.length, 15);
  assert.deepEqual(eqControlWeightsAtRatio(centreRatio(2)), { low: 1, mid: 0, high: 0 });
  assert.deepEqual(eqControlWeightsAtRatio(centreRatio(7)), { low: 0, mid: 1, high: 0 });
  assert.deepEqual(eqControlWeightsAtRatio(centreRatio(12)), { low: 0, mid: 0, high: 1 });

  const lowMidBoundary = eqControlWeightsAtRatio(5 / 15);
  assert.ok(Math.abs(lowMidBoundary.low - 0.5) < 1e-9);
  assert.ok(Math.abs(lowMidBoundary.mid - 0.5) < 1e-9);
  assert.equal(lowMidBoundary.high, 0);
  assert.equal(eqFrequencyAtRatio(centreRatio(0)), 40);
  assert.ok(Math.abs(eqFrequencyAtRatio(centreRatio(7)) - 1_000) < 1e-9);
  assert.equal(eqFrequencyAtRatio(centreRatio(14)), 18_000);
});

test("fast gesture segments blend every crossed EQ group", () => {
  const weights = eqGestureWeights(centreRatio(2), centreRatio(12));
  assert.ok(weights.low > 0);
  assert.ok(weights.mid > weights.low);
  assert.ok(weights.high > 0);
  assert.ok(Math.abs(weights.low + weights.mid + weights.high - 1) < 1e-9);
});

test("the preset curve is flat at neutral and uses the selected asymmetric dB range", () => {
  for (let index = 0; index < 15; index += 1) {
    assert.equal(eqCurveDbAtRatio({ low: 0, mid: 0, high: 0 }, centreRatio(index)), 0);
  }
  assert.ok(Math.abs(eqCurveDbAtRatio({ low: -1, mid: 0, high: 1 }, centreRatio(2)) + 26) < 1e-9);
  assert.equal(eqCurveDbAtRatio({ low: -1, mid: 0, high: 1 }, centreRatio(12)), 9);
  const slightMid = eqCurveDbAtRatio({ low: 0, mid: -0.2, high: 0 }, centreRatio(7));
  assert.ok(slightMid > -2.5 && slightMid < 0, `slight mid cut was ${slightMid} dB`);
  assert.equal(eqDbToGraphRatio(9), 0);
  assert.equal(eqDbToGraphRatio(0), 0.5);
  assert.equal(eqDbToGraphRatio(-26), 1);
});

test("narrow-band meter uses a stable dBFS scale", () => {
  assert.equal(eqSpectrumLevelToRatio(0), 0);
  assert.equal(eqSpectrumLevelToRatio(1), 1);
  assert.ok(Math.abs(eqSpectrumLevelToRatio(10 ** (-36 / 20)) - 0.5) < 1e-9);
});

test("channel FILTER curve matches the bipolar LPF/HPF throw", () => {
  const q = channelFilterResonanceQ("high");
  assert.equal(q, CHANNEL_FILTER_RESONANCE_Q.high);
  assert.equal(channelFilterCutoffHz(0), null);
  assert.equal(channelFilterCutoffHz(0.01), null);
  assert.ok((channelFilterCutoffHz(-1) ?? 0) < 100);
  assert.ok((channelFilterCutoffHz(1) ?? 0) > 7_000);

  assert.ok(Math.abs(channelFilterDbAtFrequency(1_000, 0, q)) < 0.05);
  const lowPassBass = channelFilterDbAtFrequency(80, -1, q);
  const lowPassAir = channelFilterDbAtFrequency(12_000, -1, q);
  assert.ok(lowPassBass > -6, `full LPF still attenuated bass: ${lowPassBass}`);
  assert.ok(lowPassAir < -24, `full LPF leaked treble: ${lowPassAir}`);

  const highPassBass = channelFilterDbAtFrequency(80, 1, q);
  const highPassAir = channelFilterDbAtFrequency(12_000, 1, q);
  assert.ok(highPassBass < -24, `full HPF leaked bass: ${highPassBass}`);
  assert.ok(highPassAir > -6, `full HPF still attenuated air: ${highPassAir}`);

  const cutoff = channelFilterCutoffHz(-0.55);
  assert.ok(cutoff != null);
  const peak = channelFilterDbAtFrequency(cutoff, -0.55, q);
  const far = channelFilterDbAtFrequency(cutoff * 8, -0.55, q);
  assert.ok(peak > 3, `resonant LPF had no bump at cutoff: ${peak}`);
  assert.ok(far < peak - 12, `resonant LPF did not fall past cutoff: peak=${peak} far=${far}`);

  const highPassCutoff = channelFilterCutoffHz(0.55);
  assert.ok(highPassCutoff != null);
  const highPassPeak = channelFilterDbAtFrequency(highPassCutoff, 0.55, q);
  assert.ok(
    Math.abs(highPassPeak - peak) < 0.2,
    `LPF and HPF peaks should match after the shared scale: lpf=${peak} hpf=${highPassPeak}`,
  );
});
