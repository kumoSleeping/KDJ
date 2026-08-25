import assert from "node:assert/strict";
import test from "node:test";

import { scaleRangeToUnit, scaleUnitToRange } from "../src/lib/midi/mapping";
import {
  SOFT_TAKEOVER_THRESHOLD,
  SOFT_TAKEOVER_WHIP_MS,
  SoftTakeover,
} from "../src/lib/midi/softTakeover";

test("first hardware value after arm is ignored so a dump-on-connect cannot jump tempo", () => {
  const takeover = new SoftTakeover();
  assert.equal(takeover.ignore(0.5, 0.5, 1_000), true);
  assert.equal(takeover.ignore(0.5, 0.5, 1_100), false);
});

test("SYNC jumps the virtual fader; hardware on the same side is ignored until it crosses", () => {
  const takeover = new SoftTakeover();
  assert.equal(takeover.ignore(0.5, 0.5, 0), true);
  assert.equal(takeover.ignore(0.5, 0.5, 100), false);

  takeover.ignoreNext();
  const virtual = 1;
  assert.equal(takeover.ignore(virtual, 0.5, 200), true, "first packet after SYNC is ignored");
  assert.equal(takeover.ignore(virtual, 0.52, 260), true, "still short of the virtual thumb");
  assert.equal(takeover.ignore(virtual, 0.8, 320), true);
  assert.equal(takeover.ignore(virtual, 1, 380), false, "hardware has met the clamped max");
});

test("crossing the virtual position takes over even if the landing is slightly past it", () => {
  const takeover = new SoftTakeover();
  takeover.ignore(0.7, 0.4, 0);
  assert.equal(takeover.ignore(0.7, 0.41, 80), true);
  assert.equal(takeover.ignore(0.7, 0.72, 140), false);
});

test("values inside the Mixxx threshold take over without requiring an exact cross", () => {
  const takeover = new SoftTakeover();
  takeover.ignore(0.5, 0.1, 0);
  assert.equal(takeover.ignore(0.5, 0.5 - SOFT_TAKEOVER_THRESHOLD, 80), false);
});

test("a whip within the Mixxx window is accepted so slow MIDI does not re-arm takeover", () => {
  const takeover = new SoftTakeover();
  takeover.ignore(0.5, 0.5, 0);
  assert.equal(takeover.ignore(0.5, 0.5, 80), false);
  assert.equal(takeover.ignore(0.5, 0.95, 80 + SOFT_TAKEOVER_WHIP_MS - 1), false);
});

test("scaleRangeToUnit pins overflow to the Pioneer fader edge used by the virtual thumb", () => {
  assert.ok(Math.abs(scaleRangeToUnit(1, 0.9, 1.1) - 0.5) < 1e-12);
  assert.equal(scaleRangeToUnit(1.1, 0.9, 1.1), 0);
  assert.equal(scaleRangeToUnit(1.4, 0.9, 1.1), 0);
  assert.equal(scaleRangeToUnit(0.7, 0.9, 1.1), 1);
  assert.equal(scaleUnitToRange(1, 0.9, 1.1), 0.9);
  assert.equal(scaleUnitToRange(0, 0.9, 1.1), 1.1);
});
