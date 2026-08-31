import assert from "node:assert/strict";
import test from "node:test";
import {
  managerControlView,
  reconcileManagerControlView,
} from "../src/lib/managerControlView";
import type { UnifiedDeckState, UnifiedPlayerState } from "../src/lib/unifiedPlayer";

function deck(trackId: number | null, playing = false): UnifiedDeckState {
  return {
    trackId,
    currentTime: 0,
    duration: 180,
    playing,
    desiredPlaying: playing,
    buffering: false,
    stemEnabled: false,
    outputBufferMs: 0,
    minimumOutputBufferMs: 0,
    outputUnderruns: 0,
    scratchCacheRequests: 0,
    scratchCacheMisses: 0,
    scratchCacheLoads: 0,
    scratchCacheFailures: 0,
    peakLevel: 0,
    rate: 1,
    pitchSemitones: 0,
    appliedRate: 1,
    audibleRate: 1,
    targetRateRevision: 0,
    appliedRateRevision: 0,
    audibleRateRevision: 0,
    discontinuityRevision: 0,
    scratchHeld: false,
    loopStart: null,
    loopLength: null,
    effectiveLoopGeneration: 0,
    effectiveLoopStart: null,
    effectiveLoopLength: null,
    loopWrapCount: 0,
    loopStallFrames: 0,
  };
}

function state(
  trackId: number | null,
  decks: [UnifiedDeckState, UnifiedDeckState],
): UnifiedPlayerState {
  return {
    trackId,
    preparedTrackId: null,
    status: trackId === null ? "idle" : "playing",
    currentTime: 0,
    duration: 180,
    playing: trackId !== null,
    buffering: false,
    transitioning: false,
    rate: 1,
    error: "",
    sync: {
      enabled: false,
      leader: 0,
      follower: 1,
      phase: "disabled",
      phaseErrorSeconds: 0,
      correctionRate: 1,
      targetBpm: 0,
      multiple: 1,
    },
    decks,
  };
}

test("Control stays mounted across the transient Deck gap of a same-song seek", () => {
  const before = managerControlView(state(7, [deck(7, true), deck(null)]), 7);
  const handoffGap: UnifiedPlayerState = {
    ...state(7, [deck(null), deck(null)]),
    status: "loading",
    buffering: true,
  };

  assert.equal(before.side, 0);
  assert.strictEqual(reconcileManagerControlView(before, handoffGap, 7), before);

  const after = reconcileManagerControlView(before, state(7, [deck(null), deck(7, true)]), 7);
  assert.equal(after.side, 1);
  assert.equal(after.deck?.trackId, 7);
});

test("Control does not preserve a stale binding after the song owner changes", () => {
  const before = managerControlView(state(7, [deck(7, true), deck(null)]), 7);

  assert.equal(
    reconcileManagerControlView(before, state(7, [deck(null), deck(null)]), 7).side,
    null,
  );
  assert.equal(
    reconcileManagerControlView(before, state(null, [deck(null), deck(null)]), 7).side,
    null,
  );
  assert.equal(
    reconcileManagerControlView(before, state(8, [deck(null), deck(8, true)]), 7).side,
    null,
  );
});
