import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement, act, StrictMode, Fragment } from "react";
import type { TrackSummary } from "../src/types";

const makeRow = (id: number): TrackSummary => ({ id, path: `/library/${id}.mp3`, filename: `${id}.mp3`,
  title: `Song ${id}`, artist: "Artist", album: "Album", format: "mp3", size: 1000,
  camelot: "8A", modified_at: "a", duration: 100, rating: 0, bpm: 128,
  file_created_at: id, analyzed_at: "now", source_platform: "local" } as TrackSummary);

/** The list's geometry in this document: a 720px scroll box, a 28px head, 36px rows. */
const BOX_H = 720;
const HEAD_H = 28;
const ROW_H = 36;
/** The rows under the viewport at `scrollTop`: [first, last), as the table counts them. */
const inView = (scrollTop: number) => [Math.floor(scrollTop / ROW_H), Math.ceil((scrollTop + BOX_H - HEAD_H) / ROW_H)] as const;

test("real list/store: direct jump, full selection, shrink, empty result, and bounded pending rows", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const raf = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; };
  const cancel = (id: number) => frames.delete(id);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: raf, cancelAnimationFrame: cancel, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  dom.window.requestAnimationFrame = raf;
  dom.window.cancelAnimationFrame = cancel;
  let reducedMotion = false;
  dom.window.matchMedia = ((query: string) => ({ matches: reducedMotion && query.includes("reduced-motion"),
    addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia;
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLCanvasElement.prototype.getContext = (() => null) as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const kind = (element: Element) => element.classList.contains("kd-scroll") ? "box"
    : element.classList.contains("kd-list-row") ? "row" : element.classList.contains("kd-list-head") ? "head" : "other";
  const heightOf = (element: Element) => ({ box: BOX_H, row: ROW_H, head: HEAD_H, other: BOX_H })[kind(element)];
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get() { return BOX_H; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get() { return 1000; } });
  // The virtualizer measures the scroll box by its offset size.
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { get() { return kind(this) === "other" ? 0 : heightOf(this); } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { get() { return 1000; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", { get() { return 1400; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", { get() {
    if (!this.classList.contains("kd-scroll")) return BOX_H;
    const body = this.querySelector<HTMLElement>(".kd-list-body");
    if (!body) return HEAD_H;
    return HEAD_H + (parseFloat(body.style.paddingTop) || 0) + body.querySelectorAll(".kd-list-row").length * ROW_H + (parseFloat(body.style.paddingBottom) || 0);
  } });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const height = heightOf(this);
    return { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: height, width: 1000, height, toJSON() {} };
  };
  let ids = Array.from({ length: 10000 }, (_, index) => index + 1);
  const requests: number[][] = [];
  const indexQueries: URLSearchParams[] = [];
  const summaryQueries: Record<string, unknown>[] = [];
  const coverQueries: URL[] = [];
  const originalFetch = globalThis.fetch;
  // Keep the real API client so URL and JSON serialization are both exercised.
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/library/tracks/index") {
      indexQueries.push(url.searchParams);
      return Response.json({ track_ids: ids, total: ids.length });
    }
    if (url.pathname === "/api/library/tracks/summaries") {
      const body = JSON.parse(String(init?.body));
      summaryQueries.push(body);
      // Axum's JSON extractor rejects string/number values for boolean fields.
      for (const field of ["folder_deep", "analyzed", "include_total"]) {
        if (body[field] !== undefined && typeof body[field] !== "boolean") {
          return new Response(`Invalid boolean: ${field}`, { status: 422, statusText: "Unprocessable Entity" });
        }
      }
      const requested = body.track_ids as number[];
      requests.push(requested);
      return Response.json(requested.filter(id => ids.includes(id)).map(makeRow));
    }
    const detail = url.pathname.match(/^\/api\/library\/tracks\/(\d+)$/);
    if (detail) return Response.json({ ...makeRow(Number(detail[1])), tags: [] });
    if (url.pathname === "/api/library/stats") return Response.json(null);
    if (url.pathname.startsWith("/api/library/cover/")) coverQueries.push(url);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const { createRoot } = await import("react-dom/client");
  const { useLibraryStore } = await import("../src/stores/libraryStore");
  const { useDownloadStore } = await import("../src/stores/downloadStore");
  const { TrackTable } = await import("../src/components/library/TrackTable");
  const { LIST_ARRIVAL_MS, LIST_ARRIVAL_STEPS } = await import("../src/components/common/listArrival");
  // The first render of the real list can take longer than a list's arrival on a busy machine,
  // and the marks would be gone before they are looked at: give the arrival room while here.
  const listArrivalMs = LIST_ARRIVAL_MS.list;
  LIST_ARRIVAL_MS.list = 3000;
  const root = createRoot(document.getElementById("root")!);
  function Host({ shortcutActive = true, visible = true }: { shortcutActive?: boolean; visible?: boolean } = {}) {
    const total = useLibraryStore(state => state.total);
    const loading = useLibraryStore(state => state.loading);
    const selectedId = useLibraryStore(state => state.selectedId);
    const selectedIds = useLibraryStore(state => state.selectedIds);
    return createElement(TrackTable, { total, loading, selectedId, selectedIds, layout: "wide", shortcutActive, visible,
      sort: "file_created_at", order: "desc", sort2: null, order2: "asc",
      onSelect: useLibraryStore.getState().select, onSort() {} });
  }
  const flush = async () => {
    await act(async () => {
      const current = [...frames.values()]; frames.clear();
      for (const callback of current) callback(performance.now());
      await new Promise(resolve => setImmediate(resolve));
    });
  };
  /** The scroll the WebView performs reaches the page as a scroll event. */
  const scrollTo = (box: HTMLElement, top: number) => act(() => { box.scrollTop = top; box.dispatchEvent(new Event("scroll")); });
  const rows = () => [...document.querySelectorAll<HTMLElement>(".kd-list-row[data-kd-track-id]")];
  const rowOf = (id: number) => document.querySelector<HTMLElement>(`.kd-list-row[data-kd-track-id="${id}"]`);
  const arrivingRows = () => [...document.querySelectorAll<HTMLElement>(".kd-list-row[data-kd-arrive]")];
  const arrivalOf = () => { const marks = new Set(arrivingRows().map(row => row.getAttribute("data-kd-arrive"))); assert.ok(marks.size <= 1, "one gesture at a time"); return [...marks][0] ?? null; };
  const stepOf = (row: HTMLElement) => Number(row.style.getPropertyValue("--kd-arrive-i"));
  const arrivalOver = (gesture: "list" | "chase") => act(async () => { await new Promise(resolve => setTimeout(resolve, LIST_ARRIVAL_MS[gesture] + 40)); });
  try {
    await act(async () => {
      useLibraryStore.getState().setFilter({ folder: "/library", folderDeep: true, analyzed: "yes", bpmMin: 120 });
      await useLibraryStore.getState().refresh();
      root.render(createElement(StrictMode, {}, createElement(Host)));
    });
    await flush();
    assert.equal(useLibraryStore.getState().error, "");
    assert.ok(useLibraryStore.getState().summaryById.size > 0);
    // The list is on screen for the first time: the rows in view arrive, the first fourteen one
    // after the other and the rest of the screen with the last beat. Rows out of sight are left alone.
    {
      assert.equal(arrivalOf(), "list");
      const arriving = arrivingRows();
      assert.equal(arriving.length, 20, "the rows of the viewport: 692px of 36px rows");
      assert.deepEqual(arriving.map(row => row.dataset.kdTrackId), Array.from({ length: 20 }, (_, index) => String(index + 1)));
      assert.deepEqual(arriving.map(stepOf), Array.from({ length: 20 }, (_, index) => Math.min(index, LIST_ARRIVAL_STEPS - 1)));
      assert.deepEqual(arriving.map(row => row.getAttribute("data-kd-arrive-row")), Array.from({ length: 20 }, (_, index) => index < LIST_ARRIVAL_STEPS ? "step" : "rest"));
      assert.ok(rows().length > 20, "rows beyond the viewport are built, and not marked");
      await arrivalOver("list");
      assert.equal(arrivalOf(), null, "the marks are taken off when the gesture is over");
      assert.equal(document.querySelector(".kd-list-row[style*='--kd-arrive']"), null);
    }
    // Rows are blocks in the normal flow, not a table and not positioned (a positioned row would
    // be a layer); the body's padding stands in for the rows that are not built.
    assert.equal(document.querySelector("table, tbody, tr, td"), null);
    assert.equal(rowOf(1)!.getAttribute("style") ?? "", "", "a row carries no position of its own");
    const body = () => document.querySelector<HTMLElement>(".kd-list-body")!;
    assert.equal(body().style.paddingTop, "0px");
    assert.equal(parseFloat(body().style.paddingBottom), (10000 - rows().length) * ROW_H);
    assert.equal(indexQueries[0].get("folder_deep"), "true");
    assert.equal(indexQueries[0].get("analyzed"), "true");
    assert.equal(indexQueries[0].get("bpm_min"), "120");
    assert.equal(summaryQueries[0].folder_deep, true);
    assert.equal(summaryQueries[0].analyzed, true);
    assert.equal(summaryQueries[0].bpm_min, 120);
    for (const analyzed of ["no", "all"] as const) {
      await act(async () => {
        useLibraryStore.getState().setFilter({ analyzed, folder: "", bpmMin: null });
        await useLibraryStore.getState().refresh();
      });
      await flush();
      // Cached rows survive the query change, so re-read one to see the new query serialized.
      await act(async () => { await useLibraryStore.getState().refreshTrackSummaries([1]); });
      assert.equal(useLibraryStore.getState().error, "");
      assert.ok(useLibraryStore.getState().summaryById.size > 0);
      assert.equal(indexQueries.at(-1)!.get("analyzed"), analyzed === "no" ? "false" : null);
      assert.equal(summaryQueries.at(-1)!.analyzed, analyzed === "no" ? false : undefined);
      assert.equal(indexQueries.at(-1)!.get("folder_deep"), null);
      assert.equal(summaryQueries.at(-1)!.folder_deep, undefined);
      assert.equal(summaryQueries.at(-1)!.bpm_min, undefined);
    }
    await arrivalOver("list");
    // Layout determines activation; legacy preferences cannot change it or pin details.
    const { playClickForLayout, shouldPinDetailOnClick } = await import("../src/lib/trackClickPrefs");
    for (const layout of ["wide", "narrow"] as const) {
      for (const legacyClick of ["single", "double"] as const) {
        const prefs = { widePlay: legacyClick, narrowPlay: legacyClick };
        assert.equal(playClickForLayout(prefs, layout), layout === "narrow" ? "single" : "double");
        assert.equal(shouldPinDetailOnClick(prefs, layout), false);
      }
    }
    const row = rows()[0];
    await act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    assert.equal(useLibraryStore.getState().selectedId, Number(row.dataset.kdTrackId));
    assert.equal(useLibraryStore.getState().total, 10000);
    assert.ok(rows().length <= 160, "only the rows near the viewport exist");
    const box = document.querySelector<HTMLDivElement>(".kd-scroll")!;
    const vertical = document.querySelector<HTMLElement>('[role="scrollbar"][data-axis="vertical"]')!;
    assert.equal(vertical.style.display, "");
    assert.equal(vertical.getAttribute("aria-valuemax"), String(HEAD_H + 10000 * ROW_H - BOX_H));
    await act(async () => {
      vertical.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
      box.dispatchEvent(new Event("scroll"));
    });
    await flush();
    assert.equal(box.scrollTop, HEAD_H + 10000 * ROW_H - BOX_H);
    const pointer = (type: string, y: number) => {
      const event = new dom.window.MouseEvent(type, { clientY: y, clientX: 999, button: 0, bubbles: true, cancelable: true });
      Object.defineProperty(event, "pointerId", { value: 7 });
      return event;
    };
    await act(async () => {
      vertical.dispatchEvent(pointer("pointerdown", 100));
      window.dispatchEvent(pointer("pointermove", -10000));
      window.dispatchEvent(pointer("pointerup", -10000));
      box.dispatchEvent(new Event("scroll"));
    });
    await flush();
    assert.equal(box.scrollTop, 0);
    assert.equal(document.querySelector(".kd-overlay-scrollbars")!.hasAttribute("data-dragging"), false);
    const horizontal = document.querySelector<HTMLElement>('[role="scrollbar"][data-axis="horizontal"]')!;
    await act(async () => horizontal.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true })));
    assert.equal(box.scrollLeft, 400);
    // The background fill holds every row in memory, so a jump across the library needs no request.
    for (let i = 0; i < 400 && useLibraryStore.getState().summaryById.size < 10000; i += 1) await flush();
    assert.equal(useLibraryStore.getState().summaryById.size, 10000);
    assert.ok(requests.every(values => values.length <= 500));
    const requestsBeforeJump = requests.length;
    await scrollTo(box, 359300);
    await flush();
    assert.ok(rowOf(10000));
    assert.equal(document.querySelector(".kd-list-row[data-loading-track]"), null, "no placeholder rows after a far jump");
    assert.equal(requests.length, requestsBeforeJump);
    // Wheel and trackpad scrolling belongs to the WebView's scrolling thread: the page must not cancel it.
    await scrollTo(box, 0);
    await flush();
    const wheel = new dom.window.WheelEvent("wheel", { deltaY: 180_000, bubbles: true, cancelable: true });
    box.dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, false, "the list is scrolled by the WebView, not by the page");
    assert.equal(box.scrollTop, 0);
    // The scroll it performs reaches the page as a scroll event; the rows are rendered in that event.
    const ratings = () => document.querySelectorAll(".kd-list-row[data-kd-track-id] .kd-table-rating").length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    await scrollTo(box, 180_000);
    assert.ok(rowOf(5001), "rows are rendered in the event that reported the scroll");
    assert.equal(document.querySelector(".kd-list-row[data-loading-track]"), null);
    assert.equal(requests.length, requestsBeforeJump);
    const landed = rows().length;
    assert.ok(landed >= 20 && landed <= 160, `the viewport and three screens either side (${landed})`);
    assert.equal(ratings(), landed, "every row is complete");
    assert.equal(parseFloat(body().style.paddingTop) / ROW_H, Number(rows()[0].dataset.kdTrackId) - 1, "the rows lie at their places under the padding");
    // The rows that stay near the viewport keep their nodes: only entering rows are rendered.
    const kept = rowOf(5001)!;
    const keptRating = kept.querySelector(".kd-table-rating");
    for (let step = 1; step <= 8; step += 1) await scrollTo(box, 180_000 + step * 30);
    assert.ok(rowOf(5030), "the rows followed the scroll");
    assert.equal(rowOf(5001), kept, "a row that stays keeps its node");
    assert.equal(kept.querySelector(".kd-table-rating"), keptRating);
    assert.equal(ratings(), rows().length);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    await flush();
    // Past either end the WebView bounces and reports offsets outside the list. That is not a scroll:
    // the page neither pulls the container back nor moves its rows.
    const end = box.scrollHeight - box.clientHeight;
    await scrollTo(box, end);
    assert.ok(rowOf(10000));
    const lastRow = rowOf(10000);
    for (const overshoot of [40, 90, 30, 0]) {
      await scrollTo(box, end + overshoot);
      assert.equal(box.scrollTop, end + overshoot, "the bounce at the bottom is left to the WebView");
      assert.equal(rowOf(10000), lastRow, "the last row keeps its node through the bounce");
      assert.equal(body().style.paddingBottom, "0px");
    }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    await flush();
    await scrollTo(box, 0);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    await flush();
    const firstRow = rowOf(1);
    assert.ok(firstRow);
    for (const overshoot of [-50, -120, -20, 0]) {
      await scrollTo(box, overshoot);
      assert.equal(box.scrollTop, overshoot, "the bounce at the top is left to the WebView");
      assert.equal(rowOf(1), firstRow, "the first row keeps its node through the bounce");
    }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    await flush();
    await act(async () => useLibraryStore.getState().select(1));
    await act(async () => useLibraryStore.getState().select(10000, "range"));
    assert.equal(useLibraryStore.getState().selectedIds.length, 10000);
    await act(async () => useLibraryStore.getState().selectAll());
    assert.equal(useLibraryStore.getState().selectedIds.length, 10000);
    // Esc that clears a text field must not also drop the multi-selection.
    const field = document.body.appendChild(document.createElement("input"));
    await act(async () => field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    field.remove();
    assert.equal(useLibraryStore.getState().selectedIds.length, 10000);
    // A row menu copies the rows it acts on; right-click never changes the selection.
    useLibraryStore.getState().copyToClipboard("copy", [42]);
    assert.deepEqual(useLibraryStore.getState().clipboard, { ids: [42], op: "copy" });
    useLibraryStore.setState({ clipboard: null });
    ids = ids.slice(0, 200);
    await arrivalOver("chase");
    assert.equal(arrivalOf(), null);
    await act(async () => { await useLibraryStore.getState().refresh(); });
    await flush();
    assert.ok(box.scrollTop <= 7200);
    assert.ok(rows().length > 0);
    // The same list in a new state (shorter, re-read) is not presented again.
    assert.equal(arrivalOf(), null, "a refresh of the same query is not an arrival");
    await act(async () => {
      useLibraryStore.getState().setFilter({ q: "changed query" });
      await useLibraryStore.getState().refresh();
    });
    await flush();
    assert.equal(box.scrollTop, 0, "query changes reset the actual scroll offset");
    await scrollTo(box, 0);
    assert.equal(arrivalOf(), "list", "another list arrives");
    const presented = arrivingRows();
    assert.deepEqual(presented.map(row => row.dataset.kdTrackId), Array.from({ length: 20 }, (_, index) => String(ids[index])));
    assert.deepEqual(presented.map(stepOf), Array.from({ length: 20 }, (_, index) => Math.min(index, LIST_ARRIVAL_STEPS - 1)));
    // A selection, a row that updates and a re-render leave the gesture as it is: nothing is marked again.
    await act(async () => { useLibraryStore.getState().select(ids[3]); });
    await act(async () => { await useLibraryStore.getState().refreshTrackSummaries([ids[5]]); });
    await flush();
    assert.equal(arrivalOf(), "list");
    assert.deepEqual(arrivingRows(), presented, "the same rows, the same nodes");
    assert.ok(presented.every(row => !row.style.getPropertyValue("--kd-arrive-lag")), "no row was started again");
    // Replaced again while it is still arriving: the rows in view are arriving, whichever of them are new.
    await act(async () => {
      useLibraryStore.getState().setFilter({ q: "changed again" });
      await useLibraryStore.getState().refresh();
    });
    await flush();
    await scrollTo(box, 0);
    assert.equal(arrivalOf(), "list");
    assert.equal(arrivingRows().length, 20);
    // Leaving the place it arrived at ends it at once. A screen further on, the rows that were not
    // built yet catch up with the scroll instead (a chase); the presented list is not marked again.
    await scrollTo(box, 720);
    assert.notEqual(arrivalOf(), "list", "scrolling drops the marks of the presented list");
    assert.ok(presented.every(row => !row.hasAttribute("data-kd-arrive")));
    await arrivalOver("chase");
    assert.equal(arrivalOf(), null);
    await scrollTo(box, 0);
    await arrivalOver("chase");
    assert.equal(arrivalOf(), null, "returning to the top is not a presentation");
    // The pane is put away and shown again (it stays mounted, display: none): the list arrives
    // again where it was left, however far down that is.
    await scrollTo(box, 100 * ROW_H);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
    await flush();
    assert.equal(arrivalOf(), null);
    await act(async () => root.render(createElement(StrictMode, {}, createElement(Host, { visible: false }))));
    assert.equal(arrivalOf(), null, "a hidden list does not arrive");
    await act(async () => root.render(createElement(StrictMode, {}, createElement(Host, { visible: true }))));
    assert.equal(arrivalOf(), "list", "shown again: it arrives");
    assert.deepEqual(arrivingRows().map(row => row.dataset.kdTrackId), Array.from({ length: 20 }, (_, index) => String(ids[100 + index])),
      "the rows in view, not the top of the list");
    assert.deepEqual(arrivingRows().map(stepOf).slice(0, 3), [0, 1, 2]);
    const shownAgain = arrivingRows();
    await act(async () => root.render(createElement(StrictMode, {}, createElement(Host, { visible: true }))));
    assert.deepEqual(arrivingRows(), shownAgain, "a render that changes nothing does not start it again");
    await act(async () => root.render(createElement(StrictMode, {}, createElement(Host, { visible: false }))));
    assert.equal(arrivalOf(), null, "put away mid-arrival: the marks go");
    await act(async () => root.render(createElement(StrictMode, {}, createElement(Host, { visible: true }))));
    assert.equal(arrivalOf(), "list");
    await arrivalOver("list");
    // Reduced motion: the list is simply there, and one that was arriving stops.
    reducedMotion = true;
    await act(async () => {
      useLibraryStore.getState().setFilter({ q: "changed quietly" });
      await useLibraryStore.getState().refresh();
    });
    await flush();
    assert.equal(box.scrollTop, 0);
    await scrollTo(box, 0);
    assert.equal(arrivalOf(), null);
    reducedMotion = false;
    ids = [];
    await act(async () => { await useLibraryStore.getState().refresh(); });
    await flush();
    assert.equal(document.querySelectorAll(".kd-list-row").length, 0);
    assert.equal(document.querySelector(".kd-list-body")!.textContent, "");
    await act(async () => useDownloadStore.setState({ list: Array.from({ length: 10000 }, (_, index) => ({
      id: String(index), state: "queued", dest_dir: "/library", title: `Pending ${index}`, artist: "", progress: 0,
    })) as never }));
    await flush();
    const pendingRows = document.querySelectorAll('.kd-list-row[data-pending="true"]').length;
    assert.ok(pendingRows > 0 && pendingRows <= 160, `pending downloads are virtualized too (${pendingRows})`);
    await act(async () => { root.render(null); useDownloadStore.setState({ list: [] }); });
    ids = Array.from({ length: 10000 }, (_, index) => index + 1);
    const { updateLocalWorkspaceSession } = await import("../src/lib/workspaceSession");
    await act(async () => {
      await useLibraryStore.getState().refresh();
      updateLocalWorkspaceSession({ topVisibleTrackId: 9500, rowOffset: 7, scrollTop: 341971 });
      root.render(createElement(Host));
    });
    await flush();
    const restored = document.querySelector<HTMLDivElement>(".kd-scroll")!;
    assert.equal(restored.scrollTop, 9499 * ROW_H + 7);
    // The offset the page wrote reaches it back as a scroll event; the rows there are rendered then.
    await scrollTo(restored, restored.scrollTop);
    assert.ok(rowOf(9500));
    // Presented where it had been left: the rows in view there arrive, not the top of the list.
    assert.equal(arrivalOf(), "list");
    assert.equal(arrivingRows()[0], rowOf(9500), "the restored list arrives from the row the session remembered");
    assert.equal(arrivingRows().length, 20);
    await arrivalOver("list");
    // Pressing a row prepares the system drag preview from the thumbnail route, not the original cover.
    await act(async () => {
      const down = pointer("pointerdown", 200);
      Object.defineProperty(down, "pointerType", { value: "mouse" });
      rowOf(9500)!.querySelector(".kd-list-cell")!.dispatchEvent(down);
      window.dispatchEvent(pointer("pointercancel", 200));
    });
    await flush();
    const dragCovers = coverQueries.filter(url => url.pathname === "/api/library/cover/9500" && url.searchParams.get("size") !== "64");
    assert.ok(dragCovers.length > 0);
    assert.ok(dragCovers.every(url => url.searchParams.get("size") === "256"), dragCovers.join(" "));

    // —— A fast scroll, and the rows catching up with it ——
    {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
      await flush();
      // Timers and animation elapsed time share a deterministic clock; CI may spend
      // several milliseconds mounting rows within one simulated scroll frame.
      let now = performance.now();
      const clock = t.mock.method(performance, "now", () => now);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const pass = (ms: number) => act(async () => { now += ms; t.mock.timers.tick(ms); });
      const scrollBy = async (pixels: number) => {
        await pass(16);
        await scrollTo(restored, restored.scrollTop + pixels);
      };
      /** Long enough without a scroll frame for the list to take the scroll as over. */
      const rest = async () => { await pass(220); await flush(); };
      // Every change of the rows React makes.
      const body = restored.querySelector(".kd-list-body")!;
      const built: MutationRecord[] = [];
      const watch = new dom.window.MutationObserver(records => { built.push(...records); });
      watch.observe(body, { childList: true });
      const commits = () => { built.push(...watch.takeRecords()); const count = built.length; built.length = 0; return count; };

      // A scroll at reading speed marks nothing: the rows it reaches were built beyond the viewport
      // before it got there, in the event of an earlier scroll.
      commits();
      for (let step = 0; step < 40; step += 1) {
        await scrollBy(-30);
        assert.equal(arrivalOf(), null, "reading speed: no arrival");
        const [first, last] = inView(restored.scrollTop);
        assert.ok(rowOf(first + 1) && rowOf(last), "the rows are there in the event that reported the scroll");
      }
      assert.ok(commits() > 0, "the rows followed, a few at a time");
      await rest();

      // A fling towards the top: the viewport lands where no row was built. The rows built in that
      // event chase it: the one nearest to where it came from first (the bottom one), dropping in from
      // above, a step apart; after the fourteenth the rest come with the last beat. Rows beyond the
      // viewport are built without a mark.
      commits();
      await scrollBy(-3000);
      assert.ok(commits() > 0);
      assert.equal(arrivalOf(), "chase");
      let [first, last] = inView(restored.scrollTop);
      let chasing = arrivingRows();
      assert.equal(chasing.length, last - first, "the rows of the viewport");
      assert.ok(chasing.every(row => row.getAttribute("data-kd-arrive-from") === "above"));
      assert.equal(stepOf(rowOf(last)!), 0);
      assert.equal(stepOf(rowOf(last - 1)!), 1);
      assert.equal(stepOf(rowOf(first + 1)!), LIST_ARRIVAL_STEPS - 1);
      assert.equal(rowOf(last)!.getAttribute("data-kd-arrive-row"), "step");
      assert.equal(rowOf(first + 1)!.getAttribute("data-kd-arrive-row"), "rest");
      assert.equal(rowOf(first)!.hasAttribute("data-kd-arrive"), false, "beyond the viewport: built, not animated");
      assert.ok(chasing.every(row => !row.style.getPropertyValue("--kd-arrive-lag")), "the first rows start the clock");
      // The next frame of the fling lands further on: its rows join the same chase, as far into it
      // as the clock already is, each at its own step from the edge.
      await scrollBy(-3000);
      assert.equal(arrivalOf(), "chase");
      [first, last] = inView(restored.scrollTop);
      const joined = arrivingRows().filter(row => !chasing.includes(row));
      assert.ok(joined.length > 0);
      assert.ok(joined.every(row => /^\d+ms$/.test(row.style.getPropertyValue("--kd-arrive-lag"))), "joined late: as far as the others");
      assert.equal(stepOf(rowOf(last)!), 0);
      // The chase is over in a third of a second: the marks come off; the rows stay.
      await pass(LIST_ARRIVAL_MS.chase + 40);
      assert.equal(arrivalOf(), null, "over in a third of a second");
      assert.equal(rowOf(last)!.getAttribute("style") ?? "", "", "nothing of it stays on a row");
      await rest();

      // Towards the end of the list the rows rise from below, the top one first. (Rows built once
      // before would simply be there again: the fling lands past everything built so far.)
      await scrollBy(12000);
      assert.equal(arrivalOf(), "chase");
      [first, last] = inView(restored.scrollTop);
      chasing = arrivingRows();
      assert.ok(chasing.every(row => row.getAttribute("data-kd-arrive-from") === "below"));
      assert.equal(chasing[0], rowOf(first + 1), "towards the end: the top row first");
      assert.deepEqual(chasing.slice(0, 4).map(stepOf), [0, 1, 2, 3]);
      await pass(LIST_ARRIVAL_MS.chase + 40);
      await rest();

      // A quick flick that never leaves the rows the list had built is not a chase: they were there all along.
      commits();
      for (let step = 0; step < 4; step += 1) {
        await scrollBy(150);
        assert.equal(arrivalOf(), null, "nothing new came into view");
      }
      await rest();

      // Rows built before come back as they are: no chase, whatever the speed.
      await scrollBy(-12000);
      assert.equal(arrivalOf(), null, "rows built once do not replay");
      await rest();
      // Reduced motion: the rows are simply there when the scroll lands.
      reducedMotion = true;
      await scrollBy(-6000);
      [first, last] = inView(restored.scrollTop);
      assert.ok(rowOf(first + 1) && rowOf(last));
      assert.equal(arrivalOf(), null);
      reducedMotion = false;
      await rest();
      await pass(2000);
      t.mock.timers.reset();
      clock.mock.restore();
      watch.disconnect();
    }

    // Mount a second real list, with its own query and keyboard/clipboard owner.
    const { createTemporaryLibrary } = await import("../src/stores/temporaryLibraryStore");
    const { TemporaryFolderPane } = await import("../src/components/library/TemporaryFolderPane");
    const { useLibraryClipboard } = await import("../src/lib/useLibraryClipboard");
    const { readWorkspaceSession } = await import("../src/lib/workspaceSession");
    const temporary = createTemporaryLibrary("/library/temporary");
    let activeTemporary = true;
    function ClipboardHost() {
      useLibraryClipboard(undefined, () => activeTemporary ? temporary.store.getState() : useLibraryStore.getState());
      return null;
    }
    const mainBefore = useLibraryStore.getState();
    const sessionBefore = readWorkspaceSession().local;
    await act(async () => root.render(createElement(Fragment, {},
      createElement(Host, { shortcutActive: false }), createElement(ClipboardHost),
      createElement(TemporaryFolderPane, { library: temporary, active: true, layout: "wide",
        onSelect: temporary.store.getState().select, onClose() {} }))));
    await flush(); await flush();
    const temporaryBox = document.querySelector<HTMLDivElement>(".kd-temporary-folder-content .kd-scroll")!;
    assert.equal(temporaryBox.scrollTop, 0, "temporary folders do not restore the main list's scroll position");
    const press = async (key: string, code: string) => act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, code, metaKey: true, bubbles: true, cancelable: true }));
    });
    await act(async () => temporary.store.getState().select(10));
    await act(async () => temporary.store.getState().select(20, "range"));
    assert.deepEqual(temporary.store.getState().selectedIds, Array.from({ length: 11 }, (_, i) => i + 10));
    await press("c", "KeyC");
    assert.deepEqual(useLibraryStore.getState().clipboard?.ids, temporary.store.getState().selectedIds);
    assert.deepEqual(useLibraryStore.getState().selectedIds, mainBefore.selectedIds);
    const originalRemove = useLibraryStore.getState().removeTracks;
    const deleted: number[][] = [];
    await act(async () => useLibraryStore.setState({ removeTracks: async (ids) => { deleted.push(ids); return {}; } }));
    await press("Backspace", "Backspace");
    assert.deepEqual(deleted, [temporary.store.getState().selectedIds], "only the active list handles deletion");
    await act(async () => useLibraryStore.setState({ removeTracks: originalRemove }));

    await press("a", "KeyA");
    assert.equal(temporary.store.getState().selectedIds.length, 10000);
    await act(async () => {
      temporary.store.getState().cycleSort("bpm");
      temporaryBox.scrollTop = 1000;
      temporaryBox.dispatchEvent(new Event("scroll"));
    });
    await flush(); await flush();
    await act(async () => new Promise(resolve => setTimeout(resolve, 170)));
    assert.equal(useLibraryStore.getState().filter, mainBefore.filter);
    assert.equal(useLibraryStore.getState().orderedIds, mainBefore.orderedIds);
    assert.deepEqual(readWorkspaceSession().local, sessionBefore, "temporary browsing never overwrites the main session");
    assert.equal(indexQueries.at(-1)!.get("folder"), "/library/temporary");
    activeTemporary = false;
    await act(async () => useLibraryStore.getState().select(1));
    await press("c", "KeyC");
    assert.deepEqual(temporary.store.getState().clipboard?.ids, [1], "clipboard is shared in both directions");
    await act(async () => root.render(null));
    assert.equal(temporary.store.getState().orderedIds.length, 0, "unmount disposes temporary query data");

    // Exercise native drop and WKWebView's missing-drop fallback through real event listeners.
    const { beginTemporaryFolderDrag, useTemporaryFolderDrop } = await import("../src/lib/temporaryFolderDrag");
    const opened: string[] = [];
    const openFolder = (path: string) => opened.push(path);
    function DropHost() {
      const { offered } = useTemporaryFolderDrop(openFolder, true);
      return offered ? createElement("div", { "data-kd-temporary-folder-drop": "true" }) : null;
    }
    document.elementFromPoint = () => document.querySelector("[data-kd-temporary-folder-drop]");
    await act(async () => root.render(createElement(DropHost)));
    const drag = async (type: string) => act(async () => window.dispatchEvent(
      new dom.window.MouseEvent(type, { clientX: 800, clientY: 200, bubbles: true, cancelable: true })));
    await act(async () => beginTemporaryFolderDrag("/first"));
    await drag("dragover"); await drag("drop"); await drag("dragend");
    assert.deepEqual(opened, ["/first"], "drop plus dragend opens exactly once");
    await act(async () => beginTemporaryFolderDrag("/second"));
    await drag("dragover"); await drag("dragend");
    assert.deepEqual(opened, ["/first", "/second"], "missing WebKit drop still opens the folder");
    await act(async () => beginTemporaryFolderDrag("/cancelled"));
    await drag("dragover");
    await act(async () => window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })));
    await drag("dragend");
    assert.deepEqual(opened, ["/first", "/second"], "Escape cancels the temporary open");
    await act(async () => beginTemporaryFolderDrag("/root-folder"));
    await drag("pointermove"); await drag("pointerup");
    assert.deepEqual(opened, ["/first", "/second", "/root-folder"], "root-folder pointer dragging uses the same temporary slot");

  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    LIST_ARRIVAL_MS.list = listArrivalMs;
    frames.clear(); dom.window.close();
  }
});

test("list arrival: the marks outlast the gesture the stylesheet describes, join one clock, and are taken off", async (t) => {
  const fs = await import("node:fs");
  const { createListArrival, LIST_ARRIVAL_BEATS, LIST_ARRIVAL_MS, LIST_ARRIVAL_STEPS } = await import("../src/components/common/listArrival");
  // The numbers the marks have to outlast are the stylesheet's.
  const strip = (file: string) => fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const motion = strip("src/motion.css");
  const sheet = strip("src/components/common/ListArrival.css");
  const token = (name: string) => {
    const value = new RegExp(`--kd-motion-${name}:\\s*(\\d+)ms`).exec(motion)?.[1];
    assert.ok(value, `--kd-motion-${name} is defined in ms`);
    return Number(value);
  };
  const lastStep = LIST_ARRIVAL_STEPS - 1;
  assert.deepEqual(LIST_ARRIVAL_BEATS.list, { lead: token("list-lead"), step: token("list-step"), row: token("list-row"),
    rest: token("list-rest"), cover: token("list-cover"), coverAfter: token("list-cover-after") });
  const list = token("list-lead") + lastStep * token("list-step") + token("list-cover-after") + token("list-cover");
  assert.ok(token("list-lead") + lastStep * token("list-step") + token("list-row") <= list, "the last cover is the last thing to land");
  assert.ok(LIST_ARRIVAL_MS.list >= list && LIST_ARRIVAL_MS.list <= list + 100, `a presented list is over after ${list}ms`);
  const coverAfter = Number(/\[data-kd-arrive="chase"\][^{]*\.kd-thumb\s*\{[^}]*\+\s*(\d+)ms/.exec(sheet)?.[1]);
  assert.deepEqual(LIST_ARRIVAL_BEATS.chase, { lead: 0, step: token("stagger"), row: token("micro"), rest: token("micro"), cover: token("micro"), coverAfter });
  const chase = lastStep * token("stagger") + coverAfter + token("micro");
  assert.match(sheet, /\.kd-list-row\[data-kd-arrive="chase"\]\s*\{\s*animation:\s*kd-motion-list-rise\s+var\(--kd-motion-micro\)\s+var\(--kd-ease-list\)\s+calc\(var\(--kd-arrive-i, 0\) \* var\(--kd-motion-stagger\)/);
  assert.ok(LIST_ARRIVAL_MS.chase >= chase && LIST_ARRIVAL_MS.chase <= chase + 60, `the chase is over after ${chase}ms`);
  assert.ok(chase <= 320, "about a quarter of a second, never long enough to stand in the way of reading");
  assert.doesNotMatch(sheet, /\[data-kd-arrive[^\]]*\]\s*>|\[data-kd-arrive[^\]]*\]\s+\.kd-list-row/, "the marks are on the rows, never on an ancestor");

  const dom = new JSDOM("<!doctype html><div class='kd-scroll'><div class='kd-list'><div class='kd-list-body'></div></div></div>", { url: "http://localhost" });
  let reduced = false;
  dom.window.matchMedia = (() => ({ matches: reduced, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const scroller = document.querySelector<HTMLElement>(".kd-scroll")!;
    const body = document.querySelector(".kd-list-body")!;
    const row = () => { const element = body.appendChild(document.createElement("div")); element.className = "kd-list-row"; return element; };
    const rows = Array.from({ length: 20 }, row);
    const marks = () => rows.map(element => element.getAttribute("data-kd-arrive-row"));
    const clean = (element: HTMLElement) => !element.hasAttribute("data-kd-arrive") && !element.hasAttribute("data-kd-arrive-row")
      && !element.hasAttribute("data-kd-arrive-from") && (element.getAttribute("style") ?? "") === "";
    const arrival = createListArrival(scroller);
    assert.equal(arrival.gesture(), null);

    // Presented: rows in the order they arrive; a row that is not mounted keeps its place as a gap.
    arrival.present([rows[0], null, rows[2], ...rows.slice(3)]);
    assert.equal(arrival.gesture(), "list");
    assert.equal(rows[0].getAttribute("data-kd-arrive"), "list");
    assert.equal(rows[0].getAttribute("data-kd-arrive-from"), "below");
    assert.equal(marks()[1], null);
    assert.equal(rows[2].style.getPropertyValue("--kd-arrive-i"), "2");
    assert.equal(rows[13].getAttribute("data-kd-arrive-row"), "step");
    assert.equal(rows[14].getAttribute("data-kd-arrive-row"), "rest");
    assert.equal(rows[19].style.getPropertyValue("--kd-arrive-i"), String(lastStep), "past the cascade: with its last beat");
    // Being put where it is, is not leaving; a scroll that leaves that place ends it.
    scroller.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(arrival.gesture(), "list");
    scroller.scrollTop = 40;
    scroller.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(arrival.gesture(), null);
    assert.ok(rows.every(clean), "nothing of it stays on a row");

    // A list presented again while it arrives (a filter typed letter by letter): the rows that
    // stay carry on untouched, the ones new to the view start, and the gesture lasts for them.
    arrival.present(rows.slice(0, 6));
    t.mock.timers.tick(300);
    const fresh = row();
    arrival.present([rows[0], rows[3], fresh]);
    assert.deepEqual([rows[0], rows[3]].map(element => element.style.getPropertyValue("--kd-arrive-i")), ["0", "3"], "a row keeps the step it is arriving on");
    assert.equal(fresh.getAttribute("data-kd-arrive-row"), "step");
    assert.equal(fresh.style.getPropertyValue("--kd-arrive-i"), "2");
    assert.equal(fresh.style.getPropertyValue("--kd-arrive-lag"), "");
    t.mock.timers.tick(LIST_ARRIVAL_MS.list - 1);
    assert.equal(arrival.gesture(), "list", "the time runs from the last presentation");
    t.mock.timers.tick(1);
    assert.equal(arrival.gesture(), null);
    assert.ok(clean(fresh) && clean(rows[0]));
    fresh.remove();

    // A chase: every row joins one clock at its own step; a row late for its landing is simply there.
    arrival.chase(rows[5], 0, "above");
    assert.equal(arrival.gesture(), "chase");
    assert.equal(rows[5].getAttribute("data-kd-arrive-from"), "above");
    assert.equal(rows[5].style.getPropertyValue("--kd-arrive-lag"), "", "the first row starts the clock");
    arrival.chase(rows[4], 1, "above");
    assert.equal(rows[4].style.getPropertyValue("--kd-arrive-i"), "1");
    arrival.chase(rows[0], 19, "above");
    assert.equal(rows[0].getAttribute("data-kd-arrive-row"), "rest");
    // The other side ends the chase and starts another from there.
    arrival.chase(rows[6], 0, "below");
    assert.ok(clean(rows[5]) && clean(rows[4]) && clean(rows[0]));
    assert.equal(rows[6].getAttribute("data-kd-arrive-from"), "below");
    // A presented list is left alone by a chase: it ends first.
    arrival.present(rows.slice(0, 3));
    assert.equal(arrival.gesture(), "list");
    arrival.chase(rows[9], 0, "below");
    assert.equal(arrival.gesture(), "chase");
    assert.ok(clean(rows[0]));
    t.mock.timers.tick(LIST_ARRIVAL_MS.chase + 1);
    assert.equal(arrival.gesture(), null);
    assert.ok(rows.every(clean));
    // Nothing to mark, or reduced motion: nothing starts.
    arrival.present([null, undefined]);
    assert.equal(arrival.gesture(), null);
    reduced = true;
    arrival.present(rows);
    arrival.chase(rows[0], 0, "below");
    assert.equal(arrival.gesture(), null);
    assert.ok(rows.every(clean));
  } finally {
    t.mock.timers.reset();
    dom.window.close();
  }
});
