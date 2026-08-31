import assert from "node:assert/strict";
import test from "node:test";
import {
  playerVolumeMeterClipping,
  playerVolumeMeterLevel,
  playerVolumeMeterLagMs,
  smoothPlayerVolumeMeter,
} from "../src/lib/playerVolumeMeter";

test("volume meter uses a compact logarithmic scale without lighting silence", () => {
  assert.equal(playerVolumeMeterLevel(0, 1), 0);
  assert.equal(playerVolumeMeterLevel(1, 1), 1);
  assert.ok(playerVolumeMeterLevel(0.5, 1) > 0.7);
  assert.ok(playerVolumeMeterLevel(0.8, 1) > playerVolumeMeterLevel(0.5, 1));
  assert.ok(playerVolumeMeterLevel(0.1, 0.5) < playerVolumeMeterLevel(0.1, 1));
  const highSixDb = playerVolumeMeterLevel(1, 1) - playerVolumeMeterLevel(0.5, 1);
  const lowSixDb = playerVolumeMeterLevel(0.125, 1) - playerVolumeMeterLevel(0.0625, 1);
  assert.ok(highSixDb > lowSixDb * 2);
});

test("red overload state starts only at post-master full scale", () => {
  assert.equal(playerVolumeMeterClipping(0.999, 1), false);
  assert.equal(playerVolumeMeterClipping(1, 1), true);
  assert.equal(playerVolumeMeterClipping(1.2, 0.8), false);
  assert.equal(playerVolumeMeterClipping(1.25, 0.8), true);
});

test("upper row uses a short quarter-beat lag", () => {
  assert.equal(playerVolumeMeterLagMs(120), 125);
  assert.equal(playerVolumeMeterLagMs(200), 75);
  assert.equal(playerVolumeMeterLagMs(null), 96);
  assert.equal(playerVolumeMeterLagMs(500), 64);
  assert.equal(playerVolumeMeterLagMs(30), 140);
});

test("meter restores the earlier fast visual attack and release", () => {
  const attack = smoothPlayerVolumeMeter(0, 1, 0.016);
  const release = smoothPlayerVolumeMeter(1, 0, 0.016);
  assert.ok(attack > 0.95);
  assert.ok(release < 0.5);
  assert.ok(attack > 1 - release);
});
