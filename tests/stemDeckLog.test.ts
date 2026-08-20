import assert from "node:assert/strict";
import test from "node:test";
import {
  knobBias,
  snapKnobToCenter,
  stemDeckLog,
  stemJobLine,
  stemRuntimeLine,
} from "../src/lib/stemDeckLog";
import type { StemModelStatus, StemRuntimeDiagnostics, TrackStemStatus } from "../src/types";

function diagnostics(patch: Partial<StemRuntimeDiagnostics> = {}): StemRuntimeDiagnostics {
  return {
    runtime: "ONNX Runtime",
    provider: "CPU · 4 threads",
    modelLoadMs: 40,
    firstBlockMs: 12,
    lastBlockMs: 9,
    p95BlockMs: 11,
    chunkBudgetMs: 3924,
    processedChunks: 3,
    lateChunks: 0,
    outputUnderruns: 0,
    memoryErrors: 0,
    lastError: "",
    instantAvailable: false,
    instantReadyDecks: 0,
    instantPcmPreloadMs: null,
    instantPcmCacheHits: 0,
    instantFirstHopMs: null,
    instantLastHopMs: null,
    instantP95HopMs: null,
    instantLateHops: 0,
    instantFailures: 0,
    refinementDeferred: 0,
    ...patch,
  };
}

function model(patch: Partial<StemModelStatus> = {}): StemModelStatus {
  return {
    id: "spleeter4-fp16-onnx",
    version: "Best-Practice-87c5b6d",
    supported: true,
    state: "ready",
    progress: 1,
    downloadedBytes: 1,
    totalBytes: 1,
    error: "",
    diagnostics: diagnostics(),
    ...patch,
  };
}

function status(patch: Partial<TrackStemStatus> = {}): TrackStemStatus {
  return {
    trackId: 1,
    state: "separating",
    progress: 0.42,
    cachePath: "",
    duration: 180,
    error: "",
    ...patch,
  };
}

test("knobBias treats ±1% as the 12 o'clock detent", () => {
  assert.equal(knobBias(0, -1, 1), null);
  assert.equal(knobBias(0.01, -1, 1), null);
  assert.equal(knobBias(-0.01, -1, 1), null);
  assert.equal(knobBias(0.011, -1, 1), "boost");
  assert.equal(knobBias(-0.011, -1, 1), "cut");
  assert.equal(snapKnobToCenter(0.008, -1, 1), 0);
  assert.equal(snapKnobToCenter(-0.2, -1, 1), -0.2);
});

test("job line reports live STEM work without filler copy", () => {
  assert.equal(stemJobLine(null, null), "");
  assert.equal(stemJobLine(status({ state: "missing" }), model()), "");
  assert.equal(stemJobLine(status(), model()), "SEPARATING 42%");
  assert.equal(stemJobLine(status({ state: "ready", progress: 1 }), model()), "");
  assert.equal(stemJobLine(status({ state: "ready", progress: 1, phase: "done" }), model()), "READY");
  assert.equal(stemJobLine(null, model({ state: "downloading", progress: 0.3 })), "MODEL 30%");
  assert.equal(stemJobLine(null, model({ state: "missing" }), true), "MODEL MISSING");
  assert.equal(
    stemJobLine(status({
      state: "ready",
      phase: "window",
      windowStart: 0,
      windowEnd: 30,
      windowCoveredSeconds: 4.1,
    }), model()),
    "NOW 4.1s/30s",
  );
  assert.equal(stemJobLine(status({ state: "ready", phase: "fill", progress: 0.42 }), model()), "FILL 42%");
  assert.equal(stemJobLine(status({ state: "ready", phase: "waiting", waitingForDeck: 0 }), model()), "WAIT DECK A");
});

test("runtime line names the model and the selected CPU/GPU path", () => {
  const ready = stemRuntimeLine(model());
  assert.equal(ready.text, "Spleeter-4-FP16 Best-Practice-87c5b6d · ONNX Runtime · CPU · 4 threads · F 12ms · B 9ms · P95 11ms");
  assert.equal(ready.error, false);
  const pending = stemRuntimeLine(model({
    diagnostics: diagnostics({ provider: "pending", firstBlockMs: null, lastBlockMs: null, p95BlockMs: null }),
  }));
  assert.equal(pending.text, "Spleeter-4-FP16 Best-Practice-87c5b6d · ONNX Runtime");
  const mobileNet = stemRuntimeLine(model({
    id: "bytedance-mobilenet-subbandtime-2-fp32-onnx",
    version: "zenodo-5804160-kdj-3s-v1",
  }));
  assert.match(mobileNet.text, /^ByteDance-MobileNet-2-FP32 zenodo-5804160-kdj-3s-v1/);
  const layered = stemRuntimeLine(model({
    diagnostics: diagnostics({ instantAvailable: true, instantReadyDecks: 3, instantP95HopMs: 11 }),
  }));
  assert.match(layered.text, /I95 11ms/);
  assert.match(layered.title, /instant ready Deck mask: 3/);
});

test("deck log keeps two independent lines and surfaces errors", () => {
  const log = stemDeckLog(status(), model());
  assert.equal(log.job, "SEPARATING 42%");
  assert.equal(log.runtime, "Spleeter-4-FP16 Best-Practice-87c5b6d · ONNX Runtime · CPU · 4 threads · F 12ms · B 9ms · P95 11ms");
  const failed = stemDeckLog(status({ state: "error", error: "Vulkan failed" }), model());
  assert.equal(failed.job, "Vulkan failed");
  assert.equal(failed.error, true);
});
