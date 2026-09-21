import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { create } from "zustand";

function setup() {
  let phase = "idle", toolState = "missing", error: string | null = null;
  let statusChecks = 0, installs = 0, accept = true;
  let timer: (() => void) | undefined;
  const modules = {
    zustand: { create },
    "../lib/api": { api: { ffmpegInstallationStatus: async () => {
      statusChecks++;
      return { platform: "windows", arch: "x86_64", ffmpeg: {state: toolState}, ffprobe: {state: toolState} };
    } } },
    "../lib/bridge": { getBridge: () => ({
      installMediaTools: async () => { installs++; if (accept) phase = "preparing"; return accept; },
      mediaToolsProgress: async () => ({ phase, downloaded: 1024, total: 2048, error }),
    }) },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync("src/stores/ffmpegStore.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, require: (name: keyof typeof modules) => { assert.ok(name in modules); return modules[name]; },
    setTimeout: (fn: () => void) => { timer = fn; return 1; },
    clearTimeout: () => { timer = undefined; },
  });
  return {
    store: exports.useFfmpegStore,
    change(next: string, tool = toolState, failure: string | null = null) { phase = next; toolState = tool; error = failure; },
    cancel() { accept = false; },
    counts: () => ({statusChecks, installs}),
    hasTimer: () => !!timer,
    async tick() { const fn = timer; timer = undefined; fn?.(); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test("installation polls progress without repeatedly spawning version checks and refreshes readiness on completion", async () => {
  const h = setup();
  await h.store.getState().refresh();
  await h.store.getState().install("download");
  assert.equal(h.store.getState().progress.phase, "preparing");
  h.change("downloading"); await h.tick();
  assert.equal(h.store.getState().progress.downloaded, 1024);
  h.change("validating"); await h.tick();
  assert.equal(h.counts().statusChecks, 1);
  h.change("done", "ready"); await h.tick();
  assert.equal(h.store.getState().status.ffmpeg.state, "ready");
  assert.equal(h.store.getState().status.ffprobe.state, "ready");
  assert.equal(h.counts().statusChecks, 2);
  assert.equal(h.hasTimer(), false);
});

test("reopening a panel reconnects to an installation already in progress", async () => {
  const h = setup(); h.change("extracting");
  await h.store.getState().refresh();
  assert.equal(h.store.getState().progress.phase, "extracting");
  assert.equal(h.hasTimer(), true);
  await h.store.getState().install("zip");
  assert.equal(h.counts().installs, 0);
  h.change("failed", "missing", "ZIP 文件损坏"); await h.tick();
  assert.equal(h.store.getState().error, "ZIP 文件损坏");
  assert.equal(h.hasTimer(), false);
  await h.store.getState().install("zip");
  assert.equal(h.counts().installs, 1);
  assert.equal(h.store.getState().choosing, false);
});

test("canceling the native picker leaves the existing tools untouched", async () => {
  const h = setup(); h.change("idle", "ready"); h.cancel();
  await h.store.getState().refresh();
  await h.store.getState().install("folder");
  assert.equal(h.store.getState().status.ffmpeg.state, "ready");
  assert.equal(h.store.getState().progress.phase, "idle");
  assert.equal(h.store.getState().choosing, false);
  assert.equal(h.hasTimer(), false);
});

test("duplicate install requests launch only one native picker", async () => {
  const h = setup();
  await Promise.all([h.store.getState().install("folder"), h.store.getState().install("zip")]);
  assert.equal(h.counts().installs, 1);
});
