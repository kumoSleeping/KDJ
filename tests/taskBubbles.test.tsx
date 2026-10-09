import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("task bubbles: one bubble per id, a capped stack, and one bubble for a run of tasks", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const { useTaskBubbles, showTask, updateTask, dismissTask, taskIsUp } = await import("../src/components/tasks/taskBubbleStore");
  const { TASK_STAY_MS, TASK_VISIBLE_LIMIT, taskStay } = await import("../src/components/tasks/taskBubbleSchema");
  const { createBatchReporter, TASK_BATCH_SETTLE_MS } = await import("../src/components/tasks/taskBatch");
  const { noticeTone } = await import("../src/stores/toastStore");
  const up = () => useTaskBubbles.getState().entries.filter(entry => !entry.leaving).map(entry => entry.spec.id);
  const spec = (id: string) => useTaskBubbles.getState().entries.find(entry => entry.spec.id === id && !entry.leaving)?.spec;
  const clear = () => useTaskBubbles.setState({ entries: [] });

  assert.equal(taskStay({}), TASK_STAY_MS.info);
  assert.ok(taskStay({ tone: "error" }) > taskStay({ tone: "info" }), "an error stays readable for longer");
  assert.equal(taskStay({ stay: 0, tone: "error" }), 0);
  assert.equal(noticeTone("播放失败：x"), "error");
  assert.equal(noticeTone("下一首已替换为：x"), "info");

  // The same id is the same bubble; showing it again restarts its stay, updating does not.
  showTask({ id: "a", kind: "notice", title: "one" });
  const first = useTaskBubbles.getState().entries[0];
  updateTask("a", { detail: "more" });
  assert.equal(useTaskBubbles.getState().entries[0].token, first.token);
  assert.equal(spec("a")?.detail, "more");
  showTask({ id: "a", kind: "notice", title: "two" });
  assert.deepEqual(up(), ["a"]);
  assert.notEqual(useTaskBubbles.getState().entries[0].token, first.token);
  assert.equal(useTaskBubbles.getState().entries[0].order, first.order, "it keeps its place in the stack");
  updateTask("missing", { title: "nothing" });
  assert.deepEqual(up(), ["a"], "updating a bubble that is not up shows nothing");

  // Leaving: the owner hears why, once; a bubble on its way down is not updated, and showing
  // it again brings up a new one.
  const reasons: string[] = [];
  showTask({ id: "b", kind: "notice", title: "b", onDismiss: reason => reasons.push(reason) });
  dismissTask("b", "user");
  dismissTask("b", "user");
  assert.deepEqual(reasons, ["user"]);
  assert.equal(taskIsUp("b"), false);
  updateTask("b", { title: "late" });
  showTask({ id: "b", kind: "notice", title: "again" });
  assert.equal(useTaskBubbles.getState().entries.filter(entry => entry.spec.id === "b").length, 1);
  assert.equal(spec("b")?.title, "again");

  // More than the limit: the oldest that leave by themselves go; one that is kept up stays.
  clear();
  showTask({ id: "kept", kind: "playing", title: "kept", stay: 0 });
  showTask({ id: "1", kind: "notice", title: "1", tone: "error" });
  for (const id of ["2", "3"]) showTask({ id, kind: "notice", title: id });
  assert.equal(TASK_VISIBLE_LIMIT, 3);
  assert.deepEqual(up(), ["kept", "1", "2", "3"], "a bubble that is kept up is not counted");
  showTask({ id: "4", kind: "notice", title: "4" });
  assert.deepEqual(up(), ["kept", "1", "3", "4"], "an error is the last to make room");

  // A run of like tasks is one bubble.
  clear();
  let listed = false;
  const opened: boolean[] = [];
  const reporter = createBatchReporter({
    id: "downloads", kind: "download", unit: "首", started: "开始下载", running: "下载中", finished: "下载完成", failed: "下载失败",
    listed: () => listed, open: finished => opened.push(finished),
  });
  const member = (key: string, state: "active" | "done" | "failed" | "gone", extra = {}) =>
    ({ key, title: key.toUpperCase(), covers: [`cover-${key}`], state, progress: 0, error: "", fresh: true, ...extra });
  reporter.report([member("a", "active")]);
  reporter.report([member("a", "active"), member("b", "active"), member("c", "active"), member("d", "active")]);
  assert.deepEqual(up(), [], "a start waits for the burst to end");
  await sleep(TASK_BATCH_SETTLE_MS + 60);
  assert.deepEqual(up(), ["downloads"]);
  assert.equal(spec("downloads")?.title, "A 等 4 首");
  assert.equal(spec("downloads")?.detail, "开始下载");
  assert.equal(spec("downloads")?.covers?.length, 4, "the host shows three and counts the rest");
  // Progress moves the bubble that is up without restarting its stay.
  const token = useTaskBubbles.getState().entries[0].token;
  await sleep(300);
  reporter.report([member("a", "done"), member("b", "active", { progress: 0.5 }), member("c", "active"), member("d", "active")]);
  assert.equal(useTaskBubbles.getState().entries[0].token, token);
  assert.equal(spec("downloads")?.detail, "下载中 1/4");
  assert.ok(Math.abs((spec("downloads")?.progress ?? 0) - 1.5 / 4) < 1e-9);
  // A failure is said at once, in the same bubble.
  reporter.report([member("a", "done"), member("b", "failed", { error: "没有地址" }), member("c", "active"), member("d", "active")]);
  assert.equal(spec("downloads")?.tone, "error");
  assert.equal(spec("downloads")?.title, "B");
  assert.equal(spec("downloads")?.detail, "下载失败 · 没有地址");
  // A cancelled one leaves the run without a word; the end reports what failed and what did not.
  reporter.report([member("a", "done"), member("b", "failed", { error: "没有地址" }), member("c", "gone"), member("d", "done")]);
  assert.equal(spec("downloads")?.tone, "error");
  assert.equal(spec("downloads")?.title, "B");
  assert.equal(spec("downloads")?.detail, "下载失败 · 没有地址 · 2 首已完成");
  spec("downloads")?.onOpen?.();
  assert.deepEqual(opened, [false], "a failed run opens the queue, not the history");

  // While its list is open a start is not announced, and what was found already running is
  // not a start either; the end always is.
  clear();
  listed = true;
  reporter.report([member("e", "active")]);
  await sleep(TASK_BATCH_SETTLE_MS + 60);
  assert.deepEqual(up(), []);
  reporter.report([member("e", "done")]);
  assert.equal(spec("downloads")?.tone, "success");
  assert.equal(spec("downloads")?.detail, "下载完成");
  spec("downloads")?.onOpen?.();
  assert.deepEqual(opened, [false, true]);
  clear();
  listed = false;
  reporter.report([member("f", "active", { fresh: false })]);
  await sleep(TASK_BATCH_SETTLE_MS + 60);
  assert.deepEqual(up(), [], "found under way: no start");
  reporter.report([member("old", "failed"), member("f", "done")]);
  assert.equal(spec("downloads")?.title, "F", "a failure from before the run is not part of it");
  assert.equal(spec("downloads")?.tone, "success");
  reporter.stop();
});
