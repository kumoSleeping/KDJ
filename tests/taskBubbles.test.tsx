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
  assert.equal(pinned.spec.base, true, "it is the floor of the stack: later notices rest above it");
  assert.equal(pinned.spec.placement, undefined, "at the bottom");
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

test("the host: a stack at the bottom and one at the top, and a base bubble that nothing moves", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div class='kd-app'><div class='kd-drawer-area'></div></div><div id='root'></div></body></html>",
    { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (frame: number) => clearTimeout(frame),
  });
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  // JSDOM lays nothing out: a bubble is as tall as its kind says here, the window 1440 wide,
  // and the drawer's place starts under an 87px head and ends 300px short of the right edge.
  const HEIGHTS: Record<string, number> = { song: 120, note: 40, report: 60, long: 150, row: 0 };
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("kd-task-controls-clip")) return HEIGHTS.row;
      return this.classList.contains("kd-task") ? HEIGHTS[this.dataset.kind ?? ""] ?? 0 : 0;
    },
  });
  // The row of controls a bubble unfolds needs 50px (`row` is what it has of that now).
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains("kd-task-controls-clip") ? 50 : 0; },
  });
  Object.defineProperty(dom.window.document.documentElement, "clientWidth", { configurable: true, get: () => 1440 });
  dom.window.document.querySelector<HTMLElement>(".kd-drawer-area")!.getBoundingClientRect = () =>
    ({ top: 87, right: 1140, bottom: 800, left: 716, width: 424, height: 713, x: 716, y: 87, toJSON() {} }) as DOMRect;

  const { createRoot } = await import("react-dom/client");
  const { TaskBubbleHost } = await import("../src/components/tasks/TaskBubbleHost");
  const { useTaskBubbles, showTask, updateTask, dismissTask } = await import("../src/components/tasks/taskBubbleStore");
  const { TASK_VISIBLE_LIMIT, taskPlacement } = await import("../src/components/tasks/taskBubbleSchema");
  const { SONG_SWAP_IN_MS, SONG_SWAP_OUT_MS } = await import("../src/lib/songSwapMotion");
  const { usePlayerBarAway } = await import("../src/lib/playerBarAway");
  const page = dom.window.document;
  const rootStyle = (name: string) => page.documentElement.style.getPropertyValue(name);
  const up = (place?: "bottom" | "top") => useTaskBubbles.getState().entries
    .filter(entry => !entry.leaving && (!place || entry.place === place)).map(entry => entry.spec.id);
  /** A bubble as the host drew it; the test gives every bubble its id as its title. */
  const drawn = (id: string, leaving = false) => {
    const bubble = [...page.querySelectorAll<HTMLElement>(`.kd-task[data-phase="${leaving ? "out" : "in"}"]`)]
      .find(node => node.querySelector(".kd-task-title")?.textContent === id);
    const slot = bubble?.parentElement;
    if (!bubble || !slot) return null;
    return {
      place: slot.parentElement?.dataset.place,
      lift: slot.style.getPropertyValue("--kd-task-lift"),
      away: slot.style.getPropertyValue("--kd-task-away"),
      front: Number(slot.style.zIndex),
      held: bubble.dataset.held === "true",
      bubble,
    };
  };
  const note = (id: string, extra: Record<string, unknown> = {}) =>
    showTask({ id, kind: "note", title: id, stay: 60_000, ...extra });
  const left = () => act(async () => { await sleep(SONG_SWAP_OUT_MS + 80); });
  const settled = () => act(async () => { await sleep(SONG_SWAP_IN_MS + 80); });

  useTaskBubbles.setState({ entries: [] });
  usePlayerBarAway.setState({ tall: false, collapsed: false, phase: "up" });
  const root = createRoot(page.getElementById("root")!);
  await act(async () => root.render(createElement(TaskBubbleHost, {})));
  assert.equal(page.querySelector(".kd-task-host"), null, "nothing is drawn for an empty stack");

  // --- The bottom stack as it always was: the newest nearest the bar, lifting the older.
  assert.equal(taskPlacement({}), "bottom");
  await act(async () => { note("n1"); note("r1", { kind: "report" }); });
  assert.equal(drawn("n1")?.place, "bottom");
  assert.equal(drawn("r1")?.lift, "0px");
  assert.equal(drawn("n1")?.lift, "68px", "the older one is lifted by the newer one's height and the gap");
  assert.ok(drawn("r1")!.front > drawn("n1")!.front, "the newer one is in front");
  assert.equal(drawn("r1")?.away, "", "without a base a bubble travels to the stack's edge");
  assert.equal(rootStyle("--kd-info-lift"), "", "bubbles that leave by themselves do not hold the drawer up");
  assert.equal(rootStyle("--kd-info-drop"), "", "nor does a bottom stack push it down");
  await act(async () => { dismissTask("n1"); dismissTask("r1"); });
  await left();
  assert.equal(page.querySelector(".kd-task"), null);

  // --- The base: the kept playing song is the floor of its stack.
  await act(async () => { showTask({ id: "song", kind: "song", title: "song", size: "large", base: true, stay: 0 }); });
  assert.equal(drawn("song")?.lift, "0px");
  assert.equal(rootStyle("--kd-info-lift"), "144px", "its height and the gap on either side");
  await act(async () => { note("n1"); });
  assert.equal(drawn("song")?.lift, "0px", "a later notice does not go under it");
  assert.equal(drawn("n1")?.lift, "128px", "it rests above the base");
  assert.equal(rootStyle("--kd-info-lift"), "144px", "the page and the drawer are not moved by the notice");
  assert.ok(drawn("song")!.front > drawn("n1")!.front, "the base is in front of what comes out from behind it");
  assert.equal(drawn("n1")?.away, "14px", "out of sight just inside the base's top edge, not below the bar");
  await act(async () => { note("r1", { kind: "report" }); });
  assert.equal(drawn("song")?.lift, "0px");
  assert.equal(drawn("r1")?.lift, "128px", "the newest is the one nearest the base");
  assert.equal(drawn("n1")?.lift, "196px");
  assert.equal(drawn("n1")?.away, "82px");
  assert.ok(drawn("r1")!.front > drawn("n1")!.front);
  assert.equal(rootStyle("--kd-info-lift"), "144px");
  // One that the base cannot hide travels to the stack's edge like any other.
  await act(async () => { note("tall", { kind: "long" }); });
  assert.equal(drawn("tall")?.lift, "128px");
  assert.equal(drawn("tall")?.away, "");
  // The base's controls unfold (its transport, as the bar goes): the host measures where its
  // height is going once, and what rests above it moves there in one step. The base stays.
  await act(async () => { updateTask("song", { controls: createElement("span", null, "transport") }); });
  assert.equal(drawn("song")?.lift, "0px");
  assert.equal(drawn("tall")?.lift, "178px", "lifted by the row's height before the row has moved");
  assert.equal(drawn("r1")?.lift, "336px");
  assert.equal(rootStyle("--kd-info-lift"), "194px", "the kept strip grows with the base alone");
  HEIGHTS.song = 170;
  HEIGHTS.row = 50;
  await settled();
  assert.equal(drawn("tall")?.lift, "178px", "the height it arrived at is the one that was foreseen");
  // A leaving notice keeps its lift; the others close up above the base, which stays.
  await act(async () => { dismissTask("tall"); });
  assert.equal(drawn("tall", true)?.lift, "178px", "one that is leaving keeps the lift it had");
  assert.equal(drawn("r1")?.lift, "178px");
  assert.equal(drawn("song")?.lift, "0px");
  await left();
  await act(async () => { updateTask("song", { controls: undefined }); });
  assert.equal(drawn("r1")?.lift, "128px", "and back down as the row starts to fold away");
  assert.equal(rootStyle("--kd-info-lift"), "144px");
  HEIGHTS.song = 120;
  HEIGHTS.row = 0;
  await settled();
  assert.equal(drawn("r1")?.lift, "128px");
  // The base leaves: the notices come down to the bar. It comes back: lowest again, under them.
  await act(async () => { dismissTask("song"); });
  assert.equal(drawn("r1")?.lift, "0px");
  assert.equal(drawn("n1")?.lift, "68px");
  assert.equal(rootStyle("--kd-info-lift"), "");
  await left();
  await act(async () => { showTask({ id: "song", kind: "song", title: "song", size: "large", base: true, stay: 5_000 }); });
  assert.equal(drawn("song")?.lift, "0px", "a base that arrives last still rests lowest");
  assert.equal(drawn("r1")?.lift, "128px");
  assert.equal(drawn("n1")?.lift, "196px");
  assert.equal(rootStyle("--kd-info-lift"), "", "a base that leaves by itself holds nothing up");
  // Shown again as kept: the same bubble in the same place.
  const order = useTaskBubbles.getState().entries.find(entry => entry.spec.id === "song")!.order;
  await act(async () => { showTask({ id: "song", kind: "song", title: "song", size: "large", base: true, stay: 0 }); });
  assert.equal(useTaskBubbles.getState().entries.find(entry => entry.spec.id === "song")!.order, order);
  assert.equal(drawn("r1")?.lift, "128px", "nothing above it moved");
  assert.equal(rootStyle("--kd-info-lift"), "144px");

  // --- The top place: a stack of its own, a mirror of the bottom one, which pushes the drawer.
  await act(async () => { note("t1", { placement: "top" }); });
  assert.equal(drawn("t1")?.place, "top");
  assert.equal(drawn("t1")?.lift, "0px");
  const topHost = page.querySelector<HTMLElement>('.kd-task-host[data-place="top"]')!;
  assert.equal(topHost.style.getPropertyValue("--kd-task-ceiling"), "87px", "it hangs under the search row");
  assert.equal(topHost.style.getPropertyValue("--kd-task-ceiling-right"), "300px", "and ends where the list's column ends");
  assert.equal(rootStyle("--kd-info-drop"), "58px", "the drawer is pushed down by the gap, the bubble and the gap after it");
  assert.equal(rootStyle("--kd-info-drop-clock"), "", "pushed on the arriving clock, the stylesheet's own");
  assert.equal(drawn("r1")?.lift, "128px", "the bottom stack is not touched");
  assert.equal(drawn("song")?.lift, "0px");
  assert.equal(rootStyle("--kd-info-lift"), "144px");
  await act(async () => { note("t2", { kind: "report", placement: "top" }); });
  assert.equal(drawn("t2")?.lift, "0px", "the newest is nearest the top edge");
  assert.equal(drawn("t1")?.lift, "68px", "the older one is pushed down");
  assert.equal(rootStyle("--kd-info-drop"), "126px");
  // A top bubble that is kept up pushes the drawer too, and holds nothing up at the bottom.
  await act(async () => { note("t2", { kind: "report", placement: "top", stay: 0 }); });
  assert.equal(rootStyle("--kd-info-drop"), "126px");
  assert.equal(rootStyle("--kd-info-lift"), "144px");
  // The hold is a stack's own: the focus in the top stack stops its rings only.
  await act(async () => { drawn("t1")!.bubble.querySelector("button")!.focus(); });
  assert.equal(drawn("t1")?.held, true);
  assert.equal(drawn("t2")?.held, true);
  assert.equal(drawn("r1")?.held, false, "the bottom stack keeps counting");
  await act(async () => { drawn("t1")!.bubble.querySelector("button")!.blur(); });
  assert.equal(drawn("t1")?.held, false);
  // Leaving: the place is given up at once, so the drawer starts back as the bubble starts up.
  await act(async () => { dismissTask("t2"); });
  assert.equal(drawn("t2", true)?.lift, "0px");
  assert.equal(drawn("t1")?.lift, "0px");
  assert.equal(rootStyle("--kd-info-drop"), "58px");
  assert.equal(rootStyle("--kd-info-drop-clock"), "var(--kd-motion-out) var(--kd-ease-in)", "released on the leaving clock");
  await act(async () => { note("t3", { placement: "top" }); });
  assert.equal(rootStyle("--kd-info-drop"), "106px");
  assert.equal(rootStyle("--kd-info-drop-clock"), "", "and pushed again on the arriving one");
  await act(async () => { dismissTask("t1"); dismissTask("t3"); });
  assert.equal(rootStyle("--kd-info-drop"), "", "nothing is left at the top: the drawer is where it was");
  assert.equal(rootStyle("--kd-info-drop-clock"), "var(--kd-motion-out) var(--kd-ease-in)");
  await left();
  assert.equal(page.querySelector('.kd-task-host[data-place="top"]'), null);
  assert.ok(page.querySelector('.kd-task-host[data-place="bottom"]'));

  // --- The limit is each place's own.
  await act(async () => { useTaskBubbles.setState({ entries: [] }); });
  await act(async () => {
    for (const id of ["b1", "b2", "b3"]) showTask({ id, kind: "note", title: id });
    for (const id of ["t1", "t2", "t3"]) showTask({ id, kind: "note", title: id, placement: "top" });
  });
  assert.deepEqual(up("bottom"), ["b1", "b2", "b3"]);
  assert.deepEqual(up("top"), ["t1", "t2", "t3"], `${TASK_VISIBLE_LIMIT} in each place`);
  await act(async () => { showTask({ id: "t4", kind: "note", title: "t4", placement: "top" }); });
  assert.deepEqual(up("top"), ["t2", "t3", "t4"], "the oldest at the top makes room");
  assert.deepEqual(up("bottom"), ["b1", "b2", "b3"], "the bottom is not crowded by it");

  // --- An id is one bubble, in one place. Updating it does not move it; showing it at the
  // other place sends the one that is up away from where it is and brings a new one up.
  await act(async () => { useTaskBubbles.setState({ entries: [] }); });
  const reasons: string[] = [];
  await act(async () => { note("m", { onDismiss: (reason: string) => reasons.push(reason) }); });
  await act(async () => { updateTask("m", { placement: "top" }); });
  assert.equal(drawn("m")?.place, "bottom", "a bubble that is up stays where it came up");
  await act(async () => { note("m", { placement: "top", onDismiss: (reason: string) => reasons.push(reason) }); });
  assert.deepEqual(up(), ["m"]);
  assert.equal(drawn("m")?.place, "top");
  assert.equal(drawn("m", true)?.place, "bottom", "the old one rolls down where it was");
  assert.deepEqual(reasons, [], "its owner is not told that it was dismissed");
  assert.equal(rootStyle("--kd-info-drop"), "58px");
  await left();
  assert.equal(page.querySelectorAll(".kd-task").length, 1);
  assert.equal(drawn("m")?.lift, "0px", "the one that arrived keeps its books when its twin has gone");
  await act(async () => { dismissTask("m", "user"); });
  assert.deepEqual(reasons, ["user"]);

  await act(async () => root.unmount());
  assert.equal(rootStyle("--kd-info-drop"), "");
  assert.equal(rootStyle("--kd-info-drop-clock"), "");
  useTaskBubbles.setState({ entries: [] });
});
