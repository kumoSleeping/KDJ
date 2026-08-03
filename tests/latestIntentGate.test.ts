import assert from "node:assert/strict";
import test from "node:test";

import {
  decideNativeLatestIntent,
  LatestIntentGate,
} from "../src/lib/latestIntentGate.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test("three rapid requests run the first and preserve one latest request", async () => {
  const first = deferred();
  const second = deferred();
  const tasks = [first, second];
  let runs = 0;
  const gate = new LatestIntentGate(
    () => true,
    () => tasks[runs++]!.promise,
    (error) => assert.fail(error),
  );

  gate.request();
  gate.request();
  gate.request();
  assert.equal(runs, 1, "only one task may be in flight");

  first.resolve();
  await turn();
  assert.equal(runs, 2, "repeat clicks collapse into one latest request instead of becoming noop");

  second.resolve();
  await turn();
  assert.equal(runs, 2);
});

test("a pending request waits for an explicit safe-state wake", async () => {
  let safe = false;
  let runs = 0;
  const gate = new LatestIntentGate(
    () => safe,
    async () => {
      runs += 1;
    },
    (error) => assert.fail(error),
  );

  gate.request();
  assert.equal(runs, 0);
  safe = true;
  gate.wake();
  await turn();
  assert.equal(runs, 1);
});

test("mobile triple-next preserves one latest click until the native track is safe", async () => {
  const first = deferred();
  let currentTrackId = 1;
  let nativeTrackId = 1;
  let targetTrackId: number | null = null;
  let buffering = false;
  let runs = 0;
  const gate = new LatestIntentGate(
    () => {
      const decision = decideNativeLatestIntent({
        hasActiveTrack: true,
        currentTrackId,
        stateTrackId: nativeTrackId,
        targetTrackId,
        buffering,
        transitioning: false,
        chainDepth: 0,
        allowsDeferredTransition: false,
        errored: false,
        errorRecoveryAvailable: true,
      });
      if (decision.targetSettled) targetTrackId = null;
      return decision.canRun;
    },
    async () => {
      runs += 1;
      if (runs === 1) {
        currentTrackId = 2;
        targetTrackId = 2;
        buffering = true;
        await first.promise;
      }
    },
    (error) => assert.fail(error),
  );

  gate.request();
  gate.request();
  gate.request();
  assert.equal(runs, 1, "three taps must not enqueue three native mutations");

  first.resolve();
  await turn();
  assert.equal(runs, 1, "command acknowledgement is not a safe playback edge");

  nativeTrackId = 2;
  buffering = false;
  gate.wake();
  await turn();
  assert.equal(runs, 2, "the collapsed latest tap runs after native playback settles");
});

test("one manual next may recover an error episode without releasing repeat taps early", async () => {
  const first = deferred();
  let currentTrackId = 1;
  let nativeTrackId = 1;
  let targetTrackId: number | null = null;
  let buffering = false;
  let errored = true;
  let recoveryAvailable = true;
  let runs = 0;
  const gate = new LatestIntentGate(
    () => {
      const decision = decideNativeLatestIntent({
        hasActiveTrack: true,
        currentTrackId,
        stateTrackId: nativeTrackId,
        targetTrackId,
        buffering,
        transitioning: false,
        chainDepth: 0,
        allowsDeferredTransition: false,
        errored,
        errorRecoveryAvailable: recoveryAvailable,
      });
      if (decision.targetSettled) targetTrackId = null;
      if (decision.consumeErrorRecovery) recoveryAvailable = false;
      return decision.canRun;
    },
    async () => {
      runs += 1;
      if (runs === 1) {
        currentTrackId = 2;
        targetTrackId = 2;
        buffering = true;
        await first.promise;
      }
    },
    (error) => assert.fail(error),
  );

  gate.request();
  gate.request();
  gate.request();
  assert.equal(runs, 1, "the error episode admits exactly one recovery mutation");
  first.resolve();
  await turn();
  assert.equal(runs, 1, "repeat taps remain pending while the recovery target is unsafe");

  errored = false;
  gate.wake();
  await turn();
  assert.equal(runs, 1, "leaving error is insufficient before the native target lands");
  nativeTrackId = 2;
  buffering = false;
  gate.wake();
  await turn();
  assert.equal(runs, 2, "the collapsed latest tap resumes only at the safe native edge");
});

test("a display fallback can advance despite a stale native track id", () => {
  const fallback = decideNativeLatestIntent({
    hasActiveTrack: false,
    currentTrackId: null,
    stateTrackId: 99,
    targetTrackId: null,
    buffering: false,
    transitioning: false,
    chainDepth: 0,
    allowsDeferredTransition: true,
    errored: false,
    errorRecoveryAvailable: true,
  });
  assert.equal(fallback.canRun, true, "the visible fallback supplies the first candidate");

  const activeMismatch = decideNativeLatestIntent({
    hasActiveTrack: true,
    currentTrackId: 1,
    stateTrackId: 99,
    targetTrackId: null,
    buffering: false,
    transitioning: false,
    chainDepth: 0,
    allowsDeferredTransition: true,
    errored: false,
    errorRecoveryAvailable: true,
  });
  assert.equal(activeMismatch.canRun, false, "a real active-track mismatch remains guarded");
});
