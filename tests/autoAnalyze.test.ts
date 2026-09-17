import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function harness() {
  let poll!: () => void;
  let changed!: (state: any, previous: any) => void;
  let pending = Array.from({ length: 21 }, (_, index) => ({ id: index + 1 }));
  const submissions: number[][] = [];
  let failNext = false;
  const state = {
    autoAnalyzeSuspended: false, analyze: null, scan: null, filter: { folder: "" },
    stats: { total: 21, analyzed: 0, bpm_key_v3_pending: 0 },
    async startAnalyze(ids: number[]) {
      submissions.push([...ids]);
      if (failNext) { failNext = false; throw new Error("disconnected"); }
      return { job_id: "job", queued: ids.length };
    },
    clearAnalyzeProgress() {},
  };
  const modules: Record<string, unknown> = {
    "./api": { api: { async tracks(query: { offset: number; limit: number }) {
      return { items: pending.slice(query.offset, query.offset + query.limit) };
    } } },
    "../stores/appStore": { useAppStore: { getState: () => ({ settings: {} }) } },
    "../stores/downloadStore": { useDownloadStore: { getState: () => ({ list: [] }) } },
    "../stores/libraryStore": {
      selectAnalyzing: () => false,
      useLibraryStore: { getState: () => state, subscribe(callback: typeof changed) { changed = callback; return () => {}; } },
    },
    "./outsideFolder": { isOutsideFolder: () => false },
    "./streamTrack": { isStreamTrack: () => false },
    "./unifiedPlayer": { runtimePlayer: () => ({ state: () => ({ playing: true, decks: [] }) }) },
    "./autoAnalysisMode": { resolveAutoAnalysisMode: () => "full" },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync("src/lib/autoAnalyze.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, require(name: string) { assert.ok(name in modules, name); return modules[name]; },
    setTimeout, clearTimeout, setInterval(callback: () => void) { poll = callback; return 1; }, clearInterval() {},
    document: { addEventListener() {}, removeEventListener() {} },
  });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  return {
    exports, state, submissions, flush,
    async tick() { poll(); await flush(); },
    fail() { failNext = true; },
    importTrack(id: number) {
      const previous = { ...state, stats: { ...state.stats } };
      pending = [{ id }, ...pending];
      state.stats = { ...state.stats, total: pending.length };
      changed(state, previous);
    },
  };
}

test("unfinished head page does not stop later songs or new imports", async () => {
  const h = harness();
  for (let id = 1; id <= 20; id++) h.exports.analyzePlaying({ id });
  h.submissions.length = 0;
  const stop = h.exports.startAutoAnalyze();
  try {
    await h.flush();
    assert.equal(h.submissions.length, 0);
    await h.tick();
    assert.deepEqual(h.submissions, [[21]]);
    // Walk past the submitted page, then import at the head while the cursor is beyond it.
    await h.tick();
    h.importTrack(22);
    await h.tick();
    assert.deepEqual(h.submissions, [[21], [22]]);
  } finally { stop(); }
});

test("failed background submission is retried without losing its songs", async () => {
  const h = harness();
  h.fail();
  const stop = h.exports.startAutoAnalyze();
  try {
    await h.flush();
    await h.tick();
    assert.deepEqual(h.submissions, [[1, 2, 3, 4], [1, 2, 3, 4]]);
  } finally { stop(); }
});

test("reset also allows the current song to be analyzed again", async () => {
  const h = harness();
  h.exports.analyzePlaying({ id: 1 });
  h.exports.analyzePlaying({ id: 1 });
  assert.equal(h.submissions.length, 1);
  h.exports.forgetQueuedAnalysis();
  h.exports.analyzePlaying({ id: 1 });
  assert.equal(h.submissions.length, 2);
});
