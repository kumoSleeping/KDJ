import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { create } from "zustand";
import { createSettingsWriteBarrier } from "../src/lib/settingsWriteBarrier";
import * as downloadDisplay from "../src/lib/downloadDisplay";
import * as downloadOrder from "../src/lib/downloadOrder";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function loadStore(file: string, modules: Record<string, unknown>): Record<string, any> {
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, require(name: string) { assert.ok(name in modules, name); return modules[name]; },
    console, setTimeout, clearTimeout,
  });
  return exports;
}

test("reconnect downloads reconcile missed completions without regressing newer events", async () => {
  let pending = deferred<unknown[]>();
  const store = loadStore("src/stores/downloadStore.ts", {
    zustand: { create }, "../lib/api": { api: { downloads: () => pending.promise } },
    "../lib/downloadDisplay": downloadDisplay, "../lib/downloadOrder": downloadOrder,
    "../lib/queueTaskDraft": { forgetQueueDraft() {}, rememberVideoEnqueue() {} },
    "../lib/downloadDisplayCache": {
      hintForDownload() {}, pruneDownloadDisplayCache() {}, rememberDownloadDisplays() {}, syncDownloadDisplayCache() {},
    },
  }).useDownloadStore;
  const task = (id: string, progress: number, state = "running") => ({
    id, state, progress, title: id, artist: "artist", platform: "qq", created_at: 1,
  });
  store.getState().mergeTasks([task("gone", 20), task("live", 10)]);
  store.getState().handleEvent({ type: "connection.open" });
  store.getState().handleEvent({ type: "download.updated", payload: task("live", 80) });
  pending.resolve([task("live", 10)]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(store.getState().tasks.has("gone"), false);
  assert.equal(store.getState().tasks.get("live").progress, 80);
  pending = deferred();
  const refresh = store.getState().refresh();
  store.getState().handleEvent({ type: "download.updated", payload: task("live", 100, "done") });
  pending.resolve([task("live", 80)]);
  await refresh;
  assert.equal(store.getState().tasks.size, 0);
  pending = deferred();
  const refresh2 = store.getState().refresh();
  store.getState().handleEvent({ type: "download.list", payload: [task("new", 90)] });
  pending.resolve([task("old", 10)]);
  await refresh2;
  assert.equal(store.getState().tasks.get("new").progress, 90);
  assert.equal(store.getState().tasks.has("old"), false);
});

test("library reconnect refreshes data and replaces lost terminal progress", async () => {
  const invalidated: number[][] = [];
  const modules = {
    zustand: { create }, "../lib/api": { api: { invalidateTrackDetail: (ids: number[]) => invalidated.push(ids) } },
    "../lib/folderStartup": {}, "../lib/libraryPaste": {}, "../lib/outsideFolder": {}, "../lib/tableSort": {},
    "../lib/workspaceSession": { readWorkspaceSession: () => ({ local: {} }) },
    "../lib/libraryWindow": { LibraryWindow: class { invalidate(ids: number[]) { invalidated.push(ids); } } },
  };
  const store = loadStore("src/stores/libraryStore.ts", modules).useLibraryStore;
  let refreshed = 0;
  const refresh = async () => { refreshed += 1; };
  store.setState({ orderedIds: [1, 2], selectedIds: [3], refresh, refreshStats: refresh,
    refreshFolders: refresh, refreshUndo: refresh, analyze: { job_id: "a", done: 1, total: 3 },
    scan: { job_id: "s", phase: "tags" }, maintenance: [{ kind: "upgrade", phase: "running" }],
  });
  store.getState().handleEvent({ type: "connection.open" });
  assert.equal(refreshed, 4);
  assert.equal(invalidated.length, 2);
  assert.equal(invalidated[0].join(","), "1,2,3");
  store.getState().handleEvent({ type: "library.progress.snapshot", payload: { events: [
    { type: "scan.progress", payload: { job_id: "s", phase: "done" } },
    { type: "analyze.progress", payload: { job_id: "a", done: 3, total: 3 } },
    { type: "maintenance.progress", payload: { job_id: "m", kind: "upgrade", phase: "done" } },
  ] } });
  assert.equal(store.getState().scan.phase, "done");
  assert.equal(store.getState().analyze, null);
  assert.equal(store.getState().maintenance.length, 0);
  store.getState().handleEvent({ type: "library.progress.snapshot", payload: { events: [
    { type: "analyze.progress", payload: { job_id: "unknown", done: 0, total: 0 } },
  ] } });
  assert.equal(store.getState().analyze.job_id, "unknown");
});

test("rollback releases future actions but preserves failure for existing waiters", async () => {
  const barrier = createSettingsWriteBarrier();
  const pending = deferred<void>();
  const write = barrier.enqueue(async () => {
    try { await pending.promise; }
    catch (error) { barrier.acknowledgeRollback(); throw error; }
  });
  const waiter = barrier.wait();
  const failedWrite = assert.rejects(write, /disk offline/);
  const failedWaiter = assert.rejects(waiter, /disk offline/);
  pending.reject(new Error("disk offline"));
  await Promise.all([failedWrite, failedWaiter]);
  await barrier.wait();
  await barrier.enqueue(async () => {});
  await barrier.wait();
});

function appStore(api: Record<string, unknown>) {
  const barrier = createSettingsWriteBarrier();
  const noStore = { getState: () => ({ restorePlatforms() {} }) };
  const modules: Record<string, unknown> = {
    zustand: { create },
    "../lib/api": { api, events: { subscribe: () => () => {} } },
    "../lib/settingsWriteBarrier": {
      enqueueSettingsWrite: barrier.enqueue,
      acknowledgeSettingsRollback: barrier.acknowledgeRollback,
    },
    "../lib/enabledPlatforms": { normalizeEnabledPlatforms: () => [], isPlatformEnabled: () => true },
    "../lib/workspaceSession": { readWorkspaceSession: () => ({}) },
    "./downloadStore": { useDownloadStore: noStore },
    "./workshopStore": { useWorkshopStore: noStore },
    "./compositionStore": { useCompositionStore: noStore },
    "./libraryStore": { useLibraryStore: noStore },
    "./streamBrowseStore": { useStreamBrowseStore: noStore },
    "./sidebarVisibilityStore": { useSidebarVisibilityStore: noStore },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync("src/stores/appStore.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, require(name: string) { assert.ok(name in modules, name); return modules[name]; },
    window: { matchMedia: () => ({ matches: false }) },
    document: { documentElement: { dataset: {} } },
    localStorage: { setItem() {} }, console, setTimeout, clearTimeout,
  });
  return { store: exports.useAppStore, barrier };
}

test("late account verification cannot replace a login or logout event", async () => {
  for (const nextState of ["logged_in", "logged_out"]) {
    const request = deferred<unknown[]>();
    const { store } = appStore({ accounts: () => request.promise });
    store.setState({ accounts: [{ platform: "qq", state: "logged_in", account_key: "A" }] });
    const pending = store.getState().refreshAccounts();
    store.getState().handleEvent({ type: "account.changed", payload: {
      platform: "qq", state: nextState, account_key: nextState === "logged_in" ? "B" : "",
    } });
    request.resolve([{ platform: "qq", state: "logged_in", account_key: "A" }]);
    await pending;
    assert.equal(store.getState().accounts[0].state, nextState);
    assert.equal(store.getState().accounts[0].account_key, nextState === "logged_in" ? "B" : "");
  }
});

test("account snapshots accept newer requests in either response order", async () => {
  for (const newerFirst of [false, true]) {
    const old = deferred<unknown[]>(), fresh = deferred<unknown[]>();
    const { store } = appStore({ accounts: () => old.promise, cachedAccounts: () => fresh.promise });
    const verifying = store.getState().refreshAccounts();
    store.getState().handleEvent({ type: "connection.open" });
    const resolveOld = async () => { old.resolve([{ platform: "qq", state: "logged_in", account_key: "old" }]); await verifying; };
    const resolveFresh = async () => { fresh.resolve([{ platform: "qq", state: "logged_out", account_key: "" }]); await new Promise(resolve => setTimeout(resolve, 0)); };
    if (newerFirst) { await resolveFresh(); await resolveOld(); }
    else { await resolveOld(); await resolveFresh(); }
    assert.equal(store.getState().accounts[0].state, "logged_out");
  }
});

test("failed settings save rolls back UI and unblocks subsequent enqueue", async () => {
  const { store, barrier } = appStore({ putSettings: async () => { throw new Error("offline"); } });
  store.setState({ settings: { theme: "light", enabled_platforms: [] } });
  const saving = store.getState().saveSettings({ theme: "dark" });
  const waiting = assert.rejects(barrier.wait(), /offline/);
  await assert.rejects(saving, /offline/);
  await waiting;
  assert.equal(store.getState().settings.theme, "light");
  assert.equal(store.getState().savingSettings, false);
  await barrier.wait();
});

test("version helper updates both npm lock roots without changing dependency versions", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "kdj-version-regression-"));
  try {
    mkdirSync(join(root, "src-tauri"));
    mkdirSync(join(root, "crates"));
    mkdirSync(join(root, "bin"));
    const fakeCargo = join(root, "bin/cargo");
    writeFileSync(fakeCargo, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCargo, 0o755);
    for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
      writeFileSync(join(root, file), '{"version":"1.0.0", "name":"test"}\n');
    }
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version: "1.0.0", packages: {
      "": { name: "test", version: "1.0.0" }, "node_modules/example": { version: "7.8.9" },
    } }));
    writeFileSync(join(root, "Cargo.toml"), '[workspace.package]\nversion = "1.0.0"\n');
    writeFileSync(join(root, "src-tauri/Cargo.toml"), '[package]\nversion.workspace = true\n');
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/set-version.mjs"), "1.0.1"], {
      cwd: root, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "1.0.1");
    assert.equal(lock.packages[""].version, "1.0.1");
    assert.equal(lock.packages["node_modules/example"].version, "7.8.9");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
