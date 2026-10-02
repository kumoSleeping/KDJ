import assert from "node:assert/strict";
import test from "node:test";
import { managerControlView, reconcileManagerControlView } from "../src/lib/managerControlView";
import type { UnifiedDeckState, UnifiedPlayerState } from "../src/lib/unifiedPlayer";

function snapshot(status: UnifiedPlayerState["status"], side: 0 | 1 | null): UnifiedPlayerState {
  return {
    trackId: 42, status, buffering: false, transitioning: false,
    decks: [0, 1].map(index => ({
      trackId: index === side ? 42 : null, duration: 180,
      playing: index === side && status === "playing", desiredPlaying: false,
      rate: 1.08, pitchSemitones: 2,
    } as UnifiedDeckState)),
  } as UnifiedPlayerState;
}

test("same-song deck gaps retain controls even before transition flags arrive", () => {
  for (const status of ["playing", "paused", "loading"] as const) {
    const current = managerControlView(snapshot(status, 0), 42);
    const gap = reconcileManagerControlView(current, snapshot(status, null), 42);
    assert.equal(gap, current);
    const swapped = reconcileManagerControlView(gap, snapshot(status, 1), 42);
    assert.equal(swapped.side, 1);
    assert.equal(swapped.deck?.rate, 1.08);
    assert.equal(swapped.deck?.pitchSemitones, 2);
  }
});

test("stopped, failed, cleared and replaced songs never retain a stale deck", () => {
  const current = managerControlView(snapshot("playing", 0), 42);
  for (const status of ["idle", "ended", "error"] as const) {
    assert.equal(reconcileManagerControlView(current, snapshot(status, null), 42).deck, null);
  }
  for (const trackId of [null, 43]) {
    const next = { ...snapshot("loading", null), trackId };
    assert.equal(reconcileManagerControlView(current, next, 42).deck, null);
    if (trackId !== null) assert.equal(reconcileManagerControlView(current, next, trackId).deck, null);
  }
  const empty = managerControlView(snapshot("loading", null), 42);
  assert.equal(reconcileManagerControlView(empty, snapshot("loading", null), 42).deck, null);
});
