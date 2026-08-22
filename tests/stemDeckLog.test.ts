import assert from "node:assert/strict";
import test from "node:test";
import { knobBias, snapKnobToCenter, stemDeckLog, stemJobLine, stemRuntimeLine } from "../src/lib/stemDeckLog";
import type { StemRuntimeDiagnostics, StemRuntimeStatus, TrackStemStatus } from "../src/types";

function diagnostics(patch: Partial<StemRuntimeDiagnostics> = {}): StemRuntimeDiagnostics {
  return {
    runtime: "Classical Redress", provider: "Rust FFT · CPU", initializationMs: 1,
    firstBlockMs: 12, lastBlockMs: 9, p95BlockMs: 11, chunkBudgetMs: 92,
    processedChunks: 3, lateChunks: 0, outputUnderruns: 0, memoryErrors: 0, lastError: "",
    instantAvailable: false, instantReadyDecks: 0, instantPcmPreloadMs: null,
    instantPcmCacheHits: 0, instantFirstHopMs: null, instantLastHopMs: null,
    instantP95HopMs: null, instantLateHops: 0, instantFailures: 0, refinementDeferred: 0,
    ...patch,
  };
}

function runtime(patch: Partial<StemRuntimeStatus> = {}): StemRuntimeStatus {
  return { id: "classical-redress-v1", version: "redress-test-b", state: "ready", diagnostics: diagnostics(), ...patch };
}

function status(patch: Partial<TrackStemStatus> = {}): TrackStemStatus {
  return { trackId: 1, state: "separating", progress: 0.42, cachePath: "classical-redress-v1", duration: 180, error: "", ...patch };
}

test("knobBias keeps the software centre detent", () => {
  assert.equal(knobBias(0.01, -1, 1), null);
  assert.equal(knobBias(0.011, -1, 1), "boost");
  assert.equal(snapKnobToCenter(-0.008, -1, 1), 0);
});

test("job line reports bounded classical scan work", () => {
  assert.equal(stemJobLine(null, null), "");
  assert.equal(stemJobLine(status(), runtime()), "SEPARATING 42%");
  assert.equal(stemJobLine(status({ state: "ready", phase: "done" }), runtime()), "READY");
  assert.equal(stemJobLine(status({ state: "ready", phase: "window", windowStart: 0, windowEnd: 30, windowCoveredSeconds: 4.1 }), runtime()), "NOW 4.1s/30s");
});

test("runtime line names Redress and measured CPU timing", () => {
  const line = stemRuntimeLine(runtime());
  assert.equal(line.text, "Redress redress-test-b · Classical Redress · Rust FFT · CPU · F 12ms · B 9ms · P95 11ms");
  assert.equal(line.error, false);
  assert.match(line.title, /initialization: 1ms/);
});

test("deck log surfaces separation errors", () => {
  const log = stemDeckLog(status({ state: "error", error: "FFT failed" }), runtime());
  assert.equal(log.job, "FFT failed");
  assert.equal(log.error, true);
});
