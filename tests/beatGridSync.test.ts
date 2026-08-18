import assert from "node:assert/strict";
import test from "node:test";
import {
  barPhase,
  barPhaseAlignedSeek,
  barPhaseLock,
  deckSyncRate,
  ENGINE_TEMPO_MAX,
  ENGINE_TEMPO_MIN,
  msUntilNextBoundary,
  nearestGridSnap,
  phaseAlignedFollowerPosition,
  phaseNudgeRate,
  scratchSnapAdjustment,
  scratchVelocityRate,
  shouldQuantizeSyncOnPlay,
  SYNC_SEEK_LEAD_SEC,
  syncFollowerSeekPosition,
  syncFollowerSeekPositionWithLead,
  wrapSigned,
} from "../src/lib/beatGridSync";

const almost = (actual: number, expected: number, epsilon = 1e-6) => {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${expected} ± ${epsilon}, got ${actual}`,
  );
};

test("bar phase is the fraction within the analyzed 4/4 bar", () => {
  // 120 BPM, first beat at 0.1s, bar = 2s. One third of a bar is +2/3s.
  almost(barPhase(0.1 + 2 / 3, 120, 0.1) ?? -1, 1 / 3);
  almost(barPhase(0.6, 120, 0.6) ?? -1, 0);
  almost(barPhase(1.1, 120, 0.6) ?? -1, 0.25);
  assert.equal(barPhase(1, null, 0.1), null);
  assert.equal(barPhase(1, 120, null), null);
});

test("a waveform click lands at the same bar phase as the playhead", () => {
  const playhead = 0.1 + 2 / 3;
  const click = 5.0;
  const landed = barPhaseAlignedSeek(click, playhead, 120, 0.1);
  almost(barPhase(landed, 120, 0.1) ?? -1, 1 / 3);
  almost(landed, 0.1 + 2 * 2 + 2 / 3);
});

test("phase-preserving seek falls back to the raw click without a grid", () => {
  assert.equal(barPhaseAlignedSeek(4.1, 0.7, null, 0.1), 4.1);
});

test("signed wrap folds errors onto the nearest equivalent", () => {
  almost(wrapSigned(1.6, 2), -0.4);
  almost(wrapSigned(-1.6, 2), 0.4);
  almost(wrapSigned(1, 2), 1);
});

test("two decks on the same grid report zero phase error", () => {
  const lock = barPhaseLock({
    followerPositionSec: 1.1,
    followerBpm: 128,
    followerFirstBeatSec: 0.1,
    followerRate: 1,
    masterPositionSec: 1.1,
    masterBpm: 128,
    masterFirstBeatSec: 0.1,
    masterRate: 1,
    multiple: 1,
  });
  assert.ok(lock);
  almost(lock.errorSec, 0);
});

test("a follower 200ms ahead of the master needs to slow down", () => {
  const lock = barPhaseLock({
    followerPositionSec: 1.3,
    followerBpm: 120,
    followerFirstBeatSec: 0.1,
    followerRate: 1,
    masterPositionSec: 1.1,
    masterBpm: 120,
    masterFirstBeatSec: 0.1,
    masterRate: 1,
    multiple: 1,
  });
  assert.ok(lock);
  almost(lock.errorSec, 0.2);
  const aligned = phaseAlignedFollowerPosition(1.3, 1, lock.errorSec);
  almost(aligned, 1.1);
  assert.ok(phaseNudgeRate(lock.errorSec, 1) < 1);
  almost(phaseNudgeRate(0, 1), 1);
});

test("bar phase lock preserves a downbeat that is not the first beat-period wrap", () => {
  const lock = barPhaseLock({
    followerPositionSec: 1.1,
    followerBpm: 120,
    followerFirstBeatSec: 0.6,
    followerRate: 1,
    masterPositionSec: 1.1,
    masterBpm: 120,
    masterFirstBeatSec: 0.1,
    masterRate: 1,
    multiple: 1,
  });
  assert.ok(lock);
  almost(lock.errorSec, -0.5);
  almost(phaseAlignedFollowerPosition(1.1, 1, lock.errorSec), 1.6);
});

test("bar snap uses a tighter window than half and quarter", () => {
  const bar = nearestGridSnap(0.04 * 2, 2);
  assert.equal(bar?.kind, "bar");
  const half = nearestGridSnap(0.5 * 2, 2);
  assert.equal(half?.kind, "half");
  const quarter = nearestGridSnap(0.25 * 2, 2);
  assert.equal(quarter?.kind, "quarter");
  // 0.16 of a bar is outside the bar window but inside the quarter window.
  const pulled = nearestGridSnap(0.16 * 2, 2);
  assert.equal(pulled?.kind, "quarter");
  // 0.38 sits in the gap between quarter and half, so dragging can rest there.
  assert.equal(nearestGridSnap(0.38 * 2, 2), null);
});

test("scratch snap pulls harder when closer to a grid line", () => {
  const farError = 0.05 * 2;
  const nearError = 0.015 * 2;
  const far = scratchSnapAdjustment(farError, 2, false);
  const near = scratchSnapAdjustment(nearError, 2, false);
  const hard = scratchSnapAdjustment(farError, 2, true);
  assert.ok(Math.abs(near / nearError) > Math.abs(far / farError));
  almost(hard, farError);
});

test("scratch velocity is track delta over wall time and can reverse", () => {
  almost(scratchVelocityRate(0.4, 0.2), 2);
  almost(scratchVelocityRate(-0.4, 0.2), -2);
  assert.equal(scratchVelocityRate(0.4, 0), 0);
});

test("handoff waits for the next bar when auto-sync is on, otherwise the next beat", () => {
  // On the grid origin the remaining time is 0, so the helper skips to the next full cell.
  almost(msUntilNextBoundary(0.1, 120, 0.1, 1, 1) ?? -1, 500);
  almost(msUntilNextBoundary(0.1, 120, 0.1, 1, 4) ?? -1, 2000);
  almost(msUntilNextBoundary(0.5, 120, 0.1, 1, 1) ?? -1, 100);
});

test("sync play-quantize only fires for the deck that just started against a live counterpart", () => {
  assert.equal(shouldQuantizeSyncOnPlay(true, false, true), true);
  assert.equal(shouldQuantizeSyncOnPlay(true, true, true), false);
  assert.equal(shouldQuantizeSyncOnPlay(true, false, false), false);
  assert.equal(shouldQuantizeSyncOnPlay(false, false, true), false);
});

test("a large phase error yields a seek target; a locked pair does not", () => {
  const aligned = syncFollowerSeekPosition({
    followerPositionSec: 1.3,
    followerBpm: 120,
    followerFirstBeatSec: 0.1,
    followerRate: 1,
    masterPositionSec: 1.1,
    masterBpm: 120,
    masterFirstBeatSec: 0.1,
    masterRate: 1,
    multiple: 1,
  });
  almost(aligned ?? -1, 1.1);
  assert.equal(syncFollowerSeekPosition({
    followerPositionSec: 1.1,
    followerBpm: 120,
    followerFirstBeatSec: 0.1,
    followerRate: 1,
    masterPositionSec: 1.1,
    masterBpm: 120,
    masterFirstBeatSec: 0.1,
    masterRate: 1,
    multiple: 1,
  }), null);
});

test("sync target accounts for the decoded seek cushion without moving an already locked pair", () => {
  const input = {
    followerPositionSec: 10.2,
    followerBpm: 120,
    followerFirstBeatSec: 0,
    followerRate: 1,
    masterPositionSec: 10,
    masterBpm: 120,
    masterFirstBeatSec: 0,
    masterRate: 1,
    multiple: 1,
  };
  almost(SYNC_SEEK_LEAD_SEC, 0.08);
  almost(syncFollowerSeekPositionWithLead(input, SYNC_SEEK_LEAD_SEC) ?? -1, 10 + SYNC_SEEK_LEAD_SEC);
  assert.equal(syncFollowerSeekPositionWithLead({ ...input, followerPositionSec: 10 }, SYNC_SEEK_LEAD_SEC), null);
});

test("manual SYNC matches 80.9 to 128.4 as half-time without pinning to a ±10% fader", () => {
  const plan = deckSyncRate(128.4, 80.9, ENGINE_TEMPO_MIN, ENGINE_TEMPO_MAX);
  assert.ok(plan);
  assert.equal(plan.multiple, 2);
  almost(plan.rate, 128.4 / (80.9 * 2), 1e-9);
  assert.ok(plan.rate < 0.9, "±10% would have wrongly stopped at 0.9 and shown 72.8 BPM");
  const clamped = deckSyncRate(128.4, 80.9, 0.9, 1.1);
  assert.ok(clamped);
  almost(clamped.rate, 0.9);
});

test("beat lock treats a one-beat offset as already aligned; bar lock does not", () => {
  const input = {
    followerPositionSec: 0.6,
    followerBpm: 120,
    followerFirstBeatSec: 0.1,
    followerRate: 1,
    masterPositionSec: 0.1,
    masterBpm: 120,
    masterFirstBeatSec: 0.1,
    masterRate: 1,
    multiple: 1,
  };
  const beat = barPhaseLock({ ...input, beatsPerCell: 1 });
  const bar = barPhaseLock({ ...input, beatsPerCell: 4 });
  assert.ok(beat);
  assert.ok(bar);
  almost(beat.errorSec, 0);
  almost(bar.errorSec, 0.5);
});

test("half-time bar lock prefers the downbeat over the follower's third beat", () => {
  const input = {
    followerPositionSec: 1.875,
    followerBpm: 64,
    followerFirstBeatSec: 0,
    followerRate: 1,
    masterPositionSec: 0,
    masterBpm: 128,
    masterFirstBeatSec: 0,
    masterRate: 1,
    multiple: 2,
    beatsPerCell: 4,
  };
  const lock = barPhaseLock(input);
  assert.ok(lock);
  almost(Math.abs(lock.errorSec), 1.875, 1e-6);
  almost(phaseAlignedFollowerPosition(1.875, 1, lock.errorSec), 0);
});
