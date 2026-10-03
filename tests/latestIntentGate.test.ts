import assert from "node:assert/strict";
import test from "node:test";
import { canDispatchNativeSeek } from "../src/lib/latestIntentGate";

const rust = { foldsIntoPendingLoad: true, landingTrackId: null };

test("a seek right after a track switch is folded into the pending load, not held behind it", () => {
  // Load accepted: the coordinator already reports song 2 and is still decoding/opening it.
  assert.equal(canDispatchNativeSeek(2, { ...rust, stateTrackId: 2, busy: true }), true);
  // Our earlier seek of the previous song never holds the new song's seek.
  assert.equal(canDispatchNativeSeek(2, { ...rust, stateTrackId: 2, busy: true, landingTrackId: 1 }), true);
  // Load not accepted yet: the previous song's state cannot take song 2's position.
  assert.equal(canDispatchNativeSeek(2, { ...rust, stateTrackId: 1, busy: false }), false);
});

test("a same-song burst sends one seek per busy stretch: load, Seeking or a stalled live stream", () => {
  // Our seek was sent and the state has stayed busy since (folded load, Seeking, or buffering
  // on a starved online track): the rest of the burst waits in the slot.
  assert.equal(canDispatchNativeSeek(2, { ...rust, stateTrackId: 2, busy: true, landingTrackId: 2 }), false);
  // Landed (state no longer busy): the slot's latest target goes out.
  assert.equal(canDispatchNativeSeek(2, { ...rust, stateTrackId: 2, busy: false, landingTrackId: 2 }), true);
  // Nothing of ours in flight on a stalled live stream: the first seek restarts it once.
  assert.equal(canDispatchNativeSeek(2, { ...rust, stateTrackId: 2, busy: true }), true);
});

test("iOS AVPlayer still waits for a ready item", () => {
  assert.equal(canDispatchNativeSeek(2, { foldsIntoPendingLoad: false, landingTrackId: null, stateTrackId: 2, busy: true }), false);
  assert.equal(canDispatchNativeSeek(2, { foldsIntoPendingLoad: false, landingTrackId: null, stateTrackId: 2, busy: false }), true);
});
