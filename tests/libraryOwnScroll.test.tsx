import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement, act, Profiler } from "react";
import type { TrackSummary } from "../src/types";

/** A library of the size that showed the problem: whole, it is twenty thousand layers to WebKit. */
const N = 1959;
const makeRow = (id: number): TrackSummary => ({ id, path: `/library/${id}.mp3`, filename: `${id}.mp3`,
  title: `Song ${id}`, artist: "Artist", album: "Album", format: "mp3", size: 1000,
  camelot: "8A", modified_at: "a", duration: 100, rating: 0, bpm: 128, energy: 5, rms_db: -12, peak_db: -1,
  file_created_at: id, analyzed_at: "now", source_platform: "local" } as TrackSummary);
const BOX_H = 720, HEAD_H = 28, ROW_H = 36;
/** The rows under the viewport at `scrollTop`, as 1-based numbers [first, last]. */
const inView = (scrollTop: number) => [Math.floor(scrollTop / ROW_H) + 1, Math.ceil((scrollTop + BOX_H - HEAD_H) / ROW_H)] as const;

test("a list that scrolls itself: few rows exist, the rows of a scroll are there in its event, a jump shows numbers first, and the stats render nothing", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const raf = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; };
  const cancel = (id: number) => frames.delete(id);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: raf, cancelAnimationFrame: cancel, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  // The macOS WebView: the engine in which the list scrolls itself.
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)" } });
  dom.window.requestAnimationFrame = raf;
  dom.window.cancelAnimationFrame = cancel;
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLCanvasElement.prototype.getContext = (() => null) as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const kind = (element: Element) => element.classList.contains("kd-scroll") ? "box"
    : element.classList.contains("kd-list-row") ? "row" : element.classList.contains("kd-list-head") ? "head" : "other";
  const heightOf = (element: Element) => ({ box: BOX_H, row: ROW_H, head: HEAD_H, other: BOX_H })[kind(element)];
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get() { return BOX_H; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get() { return 1000; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { get() { return kind(this) === "other" ? 0 : heightOf(this); } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { get() { return 1000; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", { get() { return 1400; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", { get() {
    return this.classList.contains("kd-scroll") ? HEAD_H + N * ROW_H : BOX_H;
  } });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const height = heightOf(this);
    return { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: height, width: 1000, height, toJSON() {} };
  };
  const ids = Array.from({ length: N }, (_, index) => index + 1);
  const stats = () => ({ total: N, analyzed: N, total_duration: 1, total_size: 1, energy_median: 5, rms_db_median: -12,
    peak_db_median: -1, by_camelot: {}, by_bpm_bucket: {}, by_platform: {} });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/library/tracks/index") return Response.json({ track_ids: ids, total: ids.length });
    if (url.pathname === "/api/library/tracks/summaries") {
      const requested = JSON.parse(String(init?.body)).track_ids as number[];
      return Response.json(requested.map(makeRow));
    }
    const detail = url.pathname.match(/^\/api\/library\/tracks\/(\d+)$/);
    if (detail) return Response.json({ ...makeRow(Number(detail[1])), tags: [] });
    if (url.pathname === "/api/library/stats") return Response.json(stats());
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const { createRoot } = await import("react-dom/client");
  const { useLibraryStore } = await import("../src/stores/libraryStore");
  const { TrackTable } = await import("../src/components/library/TrackTable");
  const root = createRoot(document.getElementById("root")!);
  let commits = 0;
  function Host() {
    const total = useLibraryStore(state => state.total);
    const loading = useLibraryStore(state => state.loading);
    const selectedId = useLibraryStore(state => state.selectedId);
    const selectedIds = useLibraryStore(state => state.selectedIds);
    return createElement(Profiler, { id: "table", onRender: () => { commits += 1; } },
      createElement(TrackTable, { total, loading, selectedId, selectedIds, layout: "wide", shortcutActive: true, visible: true,
        sort: "file_created_at", order: "desc", sort2: null, order2: "asc",
        onSelect: useLibraryStore.getState().select, onSort() {} }));
  }
  const settle = (ms: number) => act(async () => {
    const current = [...frames.values()]; frames.clear();
    for (const callback of current) callback(performance.now());
    await new Promise(resolve => setTimeout(resolve, ms));
  });
  const until = async (done: () => boolean, what: string) => {
    for (let step = 0; step < 400 && !done(); step += 1) await settle(10);
    assert.ok(done(), what);
  };
  const built = () => [...document.querySelectorAll<HTMLElement>(".kd-list-row[data-kd-row-key]")];
  const rowOf = (id: number) => document.querySelector<HTMLElement>(`.kd-list-row[data-kd-row-key="${id}"]`);
  const numberOf = (row: HTMLElement) => row.querySelector('[data-col="index"]')!.textContent;
  const whole = (row: HTMLElement | null) => row?.dataset.kdTrackId !== undefined;
  const paddingOf = () => { const body = document.querySelector<HTMLElement>(".kd-list-body")!; return [parseFloat(body.style.paddingTop), parseFloat(body.style.paddingBottom)]; };
  try {
    await act(async () => {
      useLibraryStore.getState().setFilter({ folder: "", folderDeep: true });
      await useLibraryStore.getState().refresh();
      await useLibraryStore.getState().refreshStats();
      root.render(createElement(Host));
    });
    const box = document.querySelector<HTMLElement>(".kd-scroll")!;
    await until(() => useLibraryStore.getState().summaryById.size === N, "every summary is in memory");
    await settle(400);

    // Only the rows around the viewport exist, however long anyone waits: the rest is the body's
    // padding, so the list is as tall as all of it.
    const window = built().length;
    assert.ok(window >= 20 && window <= 60, `a screen and a margin of rows, not the list: ${window}`);
    assert.deepEqual(built().map(row => Number(row.dataset.kdRowKey)), ids.slice(0, window), "one run from the top");
    assert.ok(built().every(whole), "the presented list is whole rows");
    assert.deepEqual(paddingOf(), [0, (N - window) * ROW_H]);

    // The list takes the wheel: the page moves it, the WebView does not.
    const wheel = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 90 });
    await act(async () => { rowOf(3)!.dispatchEvent(wheel); });
    assert.equal(wheel.defaultPrevented, true);
    assert.equal(box.scrollTop, 90);
    // The rows of the place a wheel moves the list to are built before it is moved there: no scroll
    // event has reported anything yet (this document sends none for a written offset).
    const flick = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 2000 });
    Object.defineProperty(flick, "timeStamp", { value: wheel.timeStamp + 1000 });
    await act(async () => { rowOf(3)!.dispatchEvent(flick); });
    assert.equal(box.scrollTop, 2090);
    { const [first, last] = inView(2090); for (let id = first; id <= last; id += 1) assert.ok(whole(rowOf(id)), `row ${id} was there before the list moved`); }
    await act(async () => { box.dispatchEvent(new Event("scroll")); });
    // A wheel at the list's end moves nothing and starts no scroll.
    await act(async () => { box.scrollTop = 0; box.dispatchEvent(new Event("scroll")); });
    const up = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -300 });
    Object.defineProperty(up, "timeStamp", { value: wheel.timeStamp + 3000 });
    await act(async () => { rowOf(3)!.dispatchEvent(up); });
    assert.equal(up.defaultPrevented, true);
    assert.ok(rowOf(1), "the top is still there");
    await act(async () => { box.scrollTop = 90; box.dispatchEvent(new Event("scroll")); });
    await until(() => built().every(whole), "the rows that came as numbers on the way back are filled in");

    // The rows a scroll reaches are there in the event that reports it: a listener that runs after
    // the list's own finds them built. At reading speed they are whole rows.
    let inEvent: boolean[] = [];
    const check = () => { const [first, last] = inView(box.scrollTop); inEvent = []; for (let id = first; id <= last; id += 1) inEvent.push(rowOf(id) !== null); };
    box.addEventListener("scroll", check);
    for (let step = 1; step <= 30; step += 1) {
      await act(async () => { box.scrollTop = 90 + step * 100; box.dispatchEvent(new Event("scroll")); });
      assert.ok(inEvent.length > 0 && inEvent.every(Boolean), `the rows at ${box.scrollTop}px are there in the event`);
      const [first, last] = inView(box.scrollTop);
      for (let id = first; id <= last; id += 1) assert.ok(whole(rowOf(id)), `row ${id} came whole`);
      assert.ok(built().length <= 60, "rows that were left behind are gone");
    }
    assert.ok(paddingOf()[0] > 0, "the rows above are the padding now");

    // A jump across the list (the scroll handle, a search for the playing song): every row under
    // the viewport is there in the event with its number, and its contents follow.
    await act(async () => { box.scrollTop = 1500 * ROW_H; box.dispatchEvent(new Event("scroll")); });
    assert.ok(inEvent.every(Boolean), "the rows of the jump are there in the event");
    const [first, last] = inView(box.scrollTop);
    const landed = rowOf(first)!;
    for (let id = first; id <= last; id += 1) {
      const row = rowOf(id)!;
      assert.equal(numberOf(row), String(id), "its number is on it");
      assert.equal(whole(row), false, "its contents are not, yet");
    }
    await until(() => { for (let id = first; id <= last; id += 1) if (!whole(rowOf(id))) return false; return true; }, "the contents arrive");
    assert.equal(rowOf(first), landed, "in the same node");
    assert.equal(landed.querySelector('[data-col="title"]')?.textContent, `Song ${first}`);
    await until(() => built().every(whole), "and in the rows beyond the viewport");
    // Jumping on while the contents are on their way leaves no row behind as a number.
    await act(async () => { box.scrollTop = 300 * ROW_H; box.dispatchEvent(new Event("scroll")); });
    await act(async () => { box.scrollTop = 900 * ROW_H; box.dispatchEvent(new Event("scroll")); });
    assert.ok(inEvent.every(Boolean));
    await until(() => built().length > 0 && built().every(whole), "the last place is filled in");
    assert.ok(built().length <= 60);
    box.removeEventListener("scroll", check);
    await settle(200);

    // The stats come as a new object with every analysed batch: the same medians render nothing.
    commits = 0;
    await act(async () => { useLibraryStore.setState({ stats: stats() as never }); });
    assert.equal(commits, 0, "the same medians: no render of the table");
    await act(async () => { useLibraryStore.setState({ stats: { ...stats(), rms_db_median: -9 } as never }); });
    assert.ok(commits > 0, "another median reaches the rows");

    // Another list is presented whole at its top, not as numbers.
    await act(async () => {
      useLibraryStore.getState().setFilter({ q: "another list" });
      await useLibraryStore.getState().refresh();
    });
    await settle(0);
    await act(async () => { box.dispatchEvent(new Event("scroll")); });
    assert.equal(box.scrollTop, 0);
    assert.ok(built().length >= 20 && built().every(whole), "the new list's first screen is whole rows");
    assert.equal(Number(built()[0].dataset.kdRowKey), 1);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    if (navigatorBefore) Object.defineProperty(globalThis, "navigator", navigatorBefore);
    frames.clear(); dom.window.close();
  }
});
