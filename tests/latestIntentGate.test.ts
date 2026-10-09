import assert from "node:assert/strict";
import test from "node:test";
import { holdsSeekPosition, nativeSeekDispatchDelay, SEEK_RESTART_INTERVAL_MS, SEEK_SETTLE_MS } from "../src/lib/latestIntentGate";

const rust = { foldsIntoPendingLoad: true, sinceUnlandedSeekMs: null };

test("a seek right after a track switch is folded into the pending load, not held behind it", () => {
  // Load accepted: the coordinator already reports song 2 and is still decoding/opening it.
  assert.equal(nativeSeekDispatchDelay(2, { ...rust, stateTrackId: 2, busy: true }), 0);
  // Load not accepted yet: the previous song's state cannot take song 2's position.
  assert.equal(nativeSeekDispatchDelay(2, { ...rust, stateTrackId: 1, busy: false }), null);
});

test("a same-song burst is spaced out while a seek has not landed, never held until it lands", () => {
  // Our seek was just sent and the state is still busy: the rest of the burst waits its turn.
  assert.equal(nativeSeekDispatchDelay(2, { ...rust, stateTrackId: 2, busy: true, sinceUnlandedSeekMs: 0 }), SEEK_RESTART_INTERVAL_MS);
  assert.equal(nativeSeekDispatchDelay(2, { ...rust, stateTrackId: 2, busy: true, sinceUnlandedSeekMs: 100 }), SEEK_RESTART_INTERVAL_MS - 100);
  // A stream that never leaves Seeking/buffering still takes the next seek: it is what restarts it.
  assert.equal(nativeSeekDispatchDelay(2, { ...rust, stateTrackId: 2, busy: true, sinceUnlandedSeekMs: 60_000 }), 0);
  // Landed (state no longer busy): the slot's latest target goes out at once.
  assert.equal(nativeSeekDispatchDelay(2, { ...rust, stateTrackId: 2, busy: false, sinceUnlandedSeekMs: 10 }), 0);
});

test("iOS AVPlayer still waits for a ready item", () => {
  assert.equal(nativeSeekDispatchDelay(2, { foldsIntoPendingLoad: false, sinceUnlandedSeekMs: null, stateTrackId: 2, busy: true }), null);
  assert.equal(nativeSeekDispatchDelay(2, { foldsIntoPendingLoad: false, sinceUnlandedSeekMs: null, stateTrackId: 2, busy: false }), 0);
});

test("the progress bar holds the clicked position only while the player supports it", () => {
  const settled = { awaitingAck: false, sameTrack: true, busy: false, errored: false, distance: 0, settledMs: 0 };
  // Not sent or not acknowledged yet, and the whole load/Seeking stretch after the ACK.
  assert.equal(holdsSeekPosition({ ...settled, awaitingAck: true, distance: 90 }), true);
  assert.equal(holdsSeekPosition({ ...settled, busy: true, distance: 90, settledMs: 60_000 }), true);
  // Landed near the target: the clock takes over.
  assert.equal(holdsSeekPosition({ ...settled, distance: 0.2 }), false);
  // Acknowledged, not busy, yet elsewhere: the seek was dropped, clamped or replaced. Wait out
  // one settle window for the clock to catch up, then show where the player really is.
  assert.equal(holdsSeekPosition({ ...settled, distance: 90, settledMs: SEEK_SETTLE_MS - 1 }), true);
  assert.equal(holdsSeekPosition({ ...settled, distance: 90, settledMs: SEEK_SETTLE_MS }), false);
  // Another song or an error never keeps the old target.
  assert.equal(holdsSeekPosition({ ...settled, sameTrack: false, awaitingAck: true }), false);
  assert.equal(holdsSeekPosition({ ...settled, errored: true, busy: true }), false);
});
