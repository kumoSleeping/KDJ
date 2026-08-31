import assert from "node:assert/strict";
import test from "node:test";

import {
  ANDROID_EXTERNAL_OUTPUT_LATENCY_FLOOR_S,
  canReusePreparedBrowserDeck,
  EXTERNAL_CLOCK_TOLERANCE_S,
  EXTERNAL_HANDOFF_OVERLAP_GAIN,
  externalClockAligned,
  externalHandoffGain,
  externalHandoffPhysicalDelayMs,
  externalNativeReleaseSettleMs,
  needsPreparedCueSeek,
  ownsExternalAdoption,
  projectedExternalPosition,
  shouldPreservePreparedBackDeck,
  shouldRecalibrateExternalClock,
} from "../src/lib/browserDeckPreload.ts";
import {
  nextCandidateRoute,
  samePredictionPolicy,
} from "../src/lib/nextCandidatePolicy.ts";
import {
  shouldBeginManagerTransition,
  shouldClearLocalVideoSessionForTrack,
  shouldRequestLocalVideoSessionForTrack,
} from "../src/lib/playerTransitionPolicy.ts";

test("a buffered predicted deck survives native-to-browser clock adoption", () => {
  const prepared = { deckIndex: 1 as const, trackId: -8, source: "http://127.0.0.1/stream/8" };
  assert.equal(shouldPreservePreparedBackDeck(prepared, 0, "http://127.0.0.1/audio/4"), true);
  assert.equal(
    canReusePreparedBrowserDeck(prepared, {
      deckIndex: 1,
      trackId: -8,
      source: "http://127.0.0.1/stream/8",
    }),
    true,
  );
});

test("reusing a prepared cue does not throw away its buffered Range", () => {
  assert.equal(needsPreparedCueSeek(31.005, 31), false);
  assert.equal(needsPreparedCueSeek(0, 31), true);
});

test("external-owner overlap is capped before the final takeover", () => {
  const webPeak = externalHandoffGain("overlap", 1);
  assert.equal(webPeak, EXTERNAL_HANDOFF_OVERLAP_GAIN);
  assert.ok(20 * Math.log10(1 + webPeak) < 0.68, "coherent overlap must stay below +0.68 dB");
  assert.equal(externalHandoffGain("takeover", 0), webPeak);
  assert.equal(externalHandoffGain("takeover", 1), 1);
});

test("external owner is not released before Web Audio reaches the physical output", () => {
  // 20ms render latency + 80ms device queue + 6ms curve + 4ms settle.
  assert.equal(externalHandoffPhysicalDelayMs(0.02, 0.08, 0.006, 4), 110);
  // Browsers without outputLatency still wait for baseLatency instead of reverting to 10ms.
  assert.equal(externalHandoffPhysicalDelayMs(0.04, undefined, 0.006, 4), 50);
  // Broken driver values cannot turn the bounded low-gain overlap into an unbounded timer.
  assert.equal(externalHandoffPhysicalDelayMs(4, 3, 0.006, 4), 1010);
});

test("Android missing latency telemetry keeps a playback-sized safety window", () => {
  assert.equal(
    externalHandoffPhysicalDelayMs(
      0,
      undefined,
      0.006,
      4,
      ANDROID_EXTERNAL_OUTPUT_LATENCY_FLOOR_S,
    ),
    110,
  );
  // Desktop keeps using reported telemetry and does not inherit the Android-only floor.
  assert.equal(externalHandoffPhysicalDelayMs(0, undefined, 0.006, 4), 10);
});

test("external clock advances while the browser copy is preparing", () => {
  const projected = projectedExternalPosition(42, 380, 1.05);
  assert.ok(Math.abs(projected - 42.399) < 0.000_001);
  assert.equal(externalClockAligned(projected - EXTERNAL_CLOCK_TOLERANCE_S, projected), true);
  assert.equal(shouldRecalibrateExternalClock(42, projected, 1), true);
  assert.equal(shouldRecalibrateExternalClock(42, projected, 2), false);
  // A retry cap is not a licence to play stale audio after a delayed Range seek.
  assert.equal(externalClockAligned(42, projected), false);
});

test("native queue gets a bounded lead before the browser takeover reaches speakers", () => {
  assert.equal(externalNativeReleaseSettleMs("android"), 32);
  assert.equal(externalNativeReleaseSettleMs("darwin"), 24);
});

test("stale adoption cleanup cannot pause a newer deck owner", () => {
  const handle = { generation: 7, deckIndex: 0 as const, source: "local://track-a" };
  assert.equal(ownsExternalAdoption(handle, 7, 0, "local://track-a"), true);
  assert.equal(ownsExternalAdoption(handle, 8, 0, "local://track-a"), false);
  assert.equal(ownsExternalAdoption(handle, 7, 1, "local://track-b"), false);
});

test("a pending online source keeps the playing Deck alive for a DJ handoff", () => {
  const onlineReplacement = {
    autoPlay: true,
    currentPlaying: true,
    transitionEnabled: true,
    realtimeTransitionAvailable: true,
    dualDeck: false,
    currentTrackId: -1,
    nextTrackId: -2,
  };
  assert.equal(shouldBeginManagerTransition(onlineReplacement), true);
  assert.equal(
    shouldBeginManagerTransition({ ...onlineReplacement, transitionEnabled: false }),
    false,
    "without Blend the unresolved source must use the ordinary replacement fence",
  );
  assert.equal(
    shouldBeginManagerTransition({ ...onlineReplacement, currentPlaying: false }),
    false,
    "a stopped Deck has no outgoing audio to preserve",
  );
  assert.equal(
    shouldBeginManagerTransition({ ...onlineReplacement, realtimeTransitionAvailable: false }),
    false,
    "platforms without two realtime Decks must keep the safe hard-cut path",
  );
});

test("an automatic audio handoff clears only the stale local-video session", () => {
  assert.equal(shouldClearLocalVideoSessionForTrack("local", 8, 9, false), true);
  assert.equal(
    shouldClearLocalVideoSessionForTrack("local", 8, 9, true),
    true,
    "a missed video-session replacement must not keep the outgoing video",
  );
  assert.equal(shouldClearLocalVideoSessionForTrack("local", 9, 9, true), false);
  assert.equal(
    shouldClearLocalVideoSessionForTrack("network", null, 9, false),
    false,
    "an unrelated network preview owns its own lifecycle",
  );
});

test("a direct Deck handoff creates the incoming local-video session exactly once", () => {
  assert.equal(shouldRequestLocalVideoSessionForTrack(null, null, 9, true), true);
  assert.equal(shouldRequestLocalVideoSessionForTrack("local", 8, 9, true), true);
  assert.equal(
    shouldRequestLocalVideoSessionForTrack("local", 9, 9, true),
    false,
    "an explicit play request may already have prepared this video session",
  );
  assert.equal(
    shouldRequestLocalVideoSessionForTrack("network", null, 9, true),
    true,
    "the incoming local video replaces an unrelated network preview just like playTrack does",
  );
  assert.equal(shouldRequestLocalVideoSessionForTrack(null, null, 9, false), false);
});

test("an exhausted online chain predicts from the local library", () => {
  assert.equal(nextCandidateRoute(true, false, "harmonic", false), "harmonic-profile");
  assert.equal(nextCandidateRoute(true, true, "harmonic", false), "stream-successor");
  assert.equal(nextCandidateRoute(true, false, "order", false), "local-start");
});

test("single repeat keeps auto-repeat but manual next predicts a distinct route", () => {
  assert.equal(nextCandidateRoute(false, false, "one", false), "repeat-current");
  assert.equal(nextCandidateRoute(false, false, "one", true), "harmonic");
  assert.equal(nextCandidateRoute(true, true, "one", true), "stream-successor");
});

test("a mode change invalidates the still-visible old prediction", () => {
  const generated = {
    epoch: 4,
    baseTrackId: 12,
    mode: "harmonic" as const,
    scope: "all",
    folder: "",
    sort: "",
    order: "",
  };
  assert.equal(samePredictionPolicy(generated, generated), true);
  assert.equal(
    samePredictionPolicy(generated, { ...generated, epoch: 5, mode: "shuffle" }),
    false,
  );
});
