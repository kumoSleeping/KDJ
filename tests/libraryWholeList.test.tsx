import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement, act, Profiler } from "react";
import type { TrackSummary } from "../src/types";

/** A list short enough to be rendered whole (rowList.ts), long enough to be built in steps. */
const N = 600;
const makeRow = (id: number): TrackSummary => ({ id, path: `/library/${id}.mp3`, filename: `${id}.mp3`,
  title: `Song ${id}`, artist: "Artist", album: "Album", format: "mp3", size: 1000,
  camelot: "8A", modified_at: "a", duration: 100, rating: 0, bpm: 128, energy: 5, rms_db: -12, peak_db: -1,
  file_created_at: id, analyzed_at: "now", source_platform: "local" } as TrackSummary);
const BOX_H = 720, HEAD_H = 28, ROW_H = 36;

test("a list left to the WebView: it is built whole without a scroll, and a refresh of the stats renders nothing", async () => {
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
    if (!this.classList.contains("kd-scroll")) return BOX_H;
    const body = this.querySelector<HTMLElement>(".kd-list-body");
    return HEAD_H + (body ? parseFloat(body.style.height) || 0 : 0);
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
    for (let step = 0; step < 600 && !done(); step += 1) await settle(10);
    assert.ok(done(), what);
  };
  const built = () => document.querySelectorAll<HTMLElement>(".kd-list-row[data-kd-row-key]");
  const filled = () => document.querySelectorAll<HTMLElement>(".kd-list-row[data-kd-track-id]");
  const rowOf = (id: number) => document.querySelector<HTMLElement>(`.kd-list-row[data-kd-row-key="${id}"]`);
  let scrolls = 0;
  try {
    await act(async () => {
      useLibraryStore.getState().setFilter({ folder: "", folderDeep: true });
      await useLibraryStore.getState().refresh();
      await useLibraryStore.getState().refreshStats();
      root.render(createElement(Host));
    });
    const box = document.querySelector<HTMLElement>(".kd-scroll")!;
    box.addEventListener("scroll", () => { scrolls += 1; });
    await until(() => useLibraryStore.getState().summaryById.size === N, "every summary is in memory");

    // Left to the WebView, a short list is built whole a chunk at a time with nobody scrolling: a
    // chunk that waited for the next scroll would be built in that scroll's frame, all of it at once.
    await until(() => built().length === N, "every row is there without a scroll");
    assert.equal(scrolls, 0);
    assert.equal(filled().length, N);
    assert.deepEqual([...document.querySelector(".kd-list-body")!.children].map(row => (row as HTMLElement).dataset.kdRowKey),
      ids.map(String));
    const body = document.querySelector<HTMLElement>(".kd-list-body")!;
    assert.deepEqual([parseFloat(body.style.paddingTop), parseFloat(body.style.paddingBottom)], [0, 0], "nothing stands in for a row");
    await settle(60);

    // The stats come as a new object with every analysed batch: the same medians render nothing.
    commits = 0;
    await act(async () => { useLibraryStore.setState({ stats: stats() as never }); });
    assert.equal(commits, 0, "the same medians: no render of the table");
    await act(async () => { useLibraryStore.setState({ stats: { ...stats(), rms_db_median: -9 } as never }); });
    assert.ok(commits > 0, "another median reaches the rows");

    // Another list is built whole again, again without a scroll.
    await act(async () => {
      useLibraryStore.getState().setFilter({ q: "another list" });
      await useLibraryStore.getState().refresh();
    });
    await settle(0);
    await until(() => built().length === N, "the next list is whole too");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    frames.clear(); dom.window.close();
  }
});
