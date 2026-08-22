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
  assert.equal(eqCurveDbAtRatio({ low: -1, mid: 0, high: 1 }, centreRatio(2)), -24);
  assert.equal(eqCurveDbAtRatio({ low: -1, mid: 0, high: 1 }, centreRatio(12)), 6);
  assert.equal(eqDbToGraphRatio(6), 0);
  assert.equal(eqDbToGraphRatio(0), 0.5);
  assert.equal(eqDbToGraphRatio(-24), 1);
});

test("narrow-band meter uses a stable dBFS scale", () => {
  assert.equal(eqSpectrumLevelToRatio(0), 0);
  assert.equal(eqSpectrumLevelToRatio(1), 1);
  assert.ok(Math.abs(eqSpectrumLevelToRatio(10 ** (-36 / 20)) - 0.5) < 1e-9);
});
