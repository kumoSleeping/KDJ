import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { Track } from "../src/types";

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

test("the playing song's bubble: a message beside the bar, the transport while the bar is away", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  const { createRoot } = await import("react-dom/client");
  const { NowPlayingTask, NOW_PLAYING_TASK } = await import("../src/components/player/NowPlayingTask");
  const { useTaskBubbles } = await import("../src/components/tasks/taskBubbleStore");
  const { useNowPlayingInfo } = await import("../src/lib/nowPlayingInfo");
  const { usePlayerBarAway } = await import("../src/lib/playerBarAway");
  const { setPlayingTrack } = await import("../src/lib/playingTrack");
  const info = () => useNowPlayingInfo.getState();
  const entry = () => useTaskBubbles.getState().entries.find(candidate => candidate.spec.id === NOW_PLAYING_TASK && !candidate.leaving);
  const keys = () => entry()?.spec.actions?.map(action => action.id);

  useTaskBubbles.setState({ entries: [] });
  usePlayerBarAway.setState({ tall: false, collapsed: true, phase: "up" });
  useNowPlayingInfo.setState({ open: false, pinned: true, peek: 0, barAway: false });
  setPlayingTrack({ id: 7, path: "/library/7.mp3", filename: "7.mp3", title: "Song", artist: "Artist", album: "",
    format: "mp3", size: 1, duration: 200, bpm: 128, modified_at: "a", source_platform: "bilibili", music_key: "",
    camelot: "8A", open_key: "", tags: [], cue_points: [] } as unknown as Track);
  let popups = 0;
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(createElement(NowPlayingTask, {
    trackId: 7, playing: false, popup: "visualizer", popupOn: false, onPopup: () => { popups += 1; },
  })));

  // Pinned beside the bar: the bar is the transport, the bubble an ordinary message.
  const pinned = entry();
  assert.ok(pinned, "a pinned bubble is up");
  assert.equal(pinned.spec.controls, undefined, "no transport beside the bar");
  assert.equal(pinned.spec.dismiss, undefined, "its key simply rolls it down");
  assert.equal(pinned.spec.stay, 0);
  assert.equal(pinned.spec.body, undefined, "it does not expand");
  assert.equal(pinned.spec.origin?.label, "B站", "where the file was downloaded from");
  assert.deepEqual(keys(), ["lyrics", "popup", "meta", "pin"]);
  entry()!.spec.actions!.find(action => action.id === "popup")!.onSelect(dom.window.document.body);
  assert.equal(popups, 1, "the bar's own toggle");

  // The bar starts down: the same bubble is given the transport (the host unfolds the row),
  // and its key says that it brings the bar back.
  await act(async () => info().setBarAway(true));
  assert.equal(entry()?.order, pinned.order, "the bubble that was up, not a new one");
  assert.ok(entry()?.spec.controls != null, "the transport while the bar is away");
  assert.equal(entry()?.spec.dismiss?.label, "展开播放条");
  // The bar starts back: the transport is taken away again and the pinned bubble stays.
  await act(async () => info().setBarAway(false));
  assert.equal(entry()?.order, pinned.order);
  assert.equal(entry()?.spec.controls, undefined);

  // A song's own peek beside the bar is a message too.
  await act(async () => { info().close(); });
  assert.equal(entry(), undefined);
  await act(async () => info().startPeek());
  assert.ok((entry()?.spec.stay ?? 0) > 0);
  assert.equal(entry()?.spec.controls, undefined);
  // The bar goes while it is up: it stays, with the transport.
  await act(async () => info().setBarAway(true));
  assert.equal(entry()?.spec.stay, 0);
  assert.ok(entry()?.spec.controls != null);

  // Rolled down by hand with the bar away: the bar is asked back.
  await act(async () => useTaskBubbles.getState().dismiss(NOW_PLAYING_TASK, "user"));
  assert.equal(entry(), undefined);
  assert.equal(usePlayerBarAway.getState().collapsed, false);
  assert.equal(info().barAway, false);

  await act(async () => root.unmount());
  setPlayingTrack(null);
});
