import assert from "node:assert/strict";
import test from "node:test";
import { vjMixSourceOverAlphas, vjMixWeights } from "../src/lib/vjMix";

test("an unlocked crossfader owns the video dissolve", () => {
  assert.deepEqual(vjMixWeights({
    playing: [true, true],
    crossfaderEnabled: true,
    crossfader: -1,
    channelFaders: [0, 1],
  }), [1, 0]);
  assert.deepEqual(vjMixWeights({
    playing: [true, true],
    crossfaderEnabled: true,
    crossfader: 0,
    channelFaders: [0, 1],
  }), [0.5, 0.5]);
  assert.deepEqual(vjMixWeights({
    playing: [true, true],
    crossfaderEnabled: true,
    crossfader: 1,
    channelFaders: [1, 0],
  }), [0, 1]);
});

test("a stopped deck contributes the theme matte instead of a frozen frame", () => {
  assert.deepEqual(vjMixWeights({
    playing: [true, false],
    crossfaderEnabled: true,
    crossfader: 0,
    channelFaders: [1, 1],
  }), [0.5, 0]);
});

test("locked crossfader delegates brightness and overlay ratio to channel faders", () => {
  assert.deepEqual(vjMixWeights({
    playing: [true, true],
    crossfaderEnabled: false,
    crossfader: -1,
    channelFaders: [1, 1],
  }), [0.5, 0.5]);
  assert.deepEqual(vjMixWeights({
    playing: [true, true],
    crossfaderEnabled: false,
    crossfader: 1,
    channelFaders: [0.5, 0],
  }), [0.5, 0]);
  assert.deepEqual(vjMixWeights({
    playing: [true, true],
    crossfaderEnabled: false,
    crossfader: 0,
    channelFaders: [0, 0],
  }), [0, 0]);
});

test("source-over alphas preserve linear video and theme-matte weights", () => {
  const weights = [0.25, 0.25] as const;
  const [leftAlpha, rightAlpha] = vjMixSourceOverAlphas(weights);

  assert.equal(rightAlpha, 0.25);
  assert.equal(leftAlpha, 1 / 3);
  assert.ok(Math.abs(leftAlpha * (1 - rightAlpha) - weights[0]) < 1e-12);
  assert.ok(Math.abs((1 - leftAlpha) * (1 - rightAlpha) - 0.5) < 1e-12);
});
