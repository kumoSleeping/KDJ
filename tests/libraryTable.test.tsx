import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement, act, StrictMode, Fragment } from "react";
import type { TrackSummary } from "../src/types";

const makeRow = (id: number): TrackSummary => ({ id, path: `/library/${id}.mp3`, filename: `${id}.mp3`,
  title: `Song ${id}`, artist: "Artist", album: "Album", format: "mp3", size: 1000,
  camelot: "8A", modified_at: "a", duration: 100, rating: 0, bpm: 128,
  file_created_at: id, analyzed_at: "now", source_platform: "local" } as TrackSummary);

test("real table/store: direct jump, full selection, shrink, empty result, and bounded pending rows", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const raf = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; };
  const cancel = (id: number) => frames.delete(id);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    HTMLTableRowElement: dom.window.HTMLTableRowElement, MutationObserver: dom.window.MutationObserver,
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get() { return 720; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get() { return 1000; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", { get() { return 1400; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", { get() {
    if (!this.classList.contains("kd-scroll")) return 720;
    return 28 + [...this.querySelectorAll("tbody > tr")].reduce((height, row) =>
      height + (row.hasAttribute("data-spacer") ? parseFloat(row.firstElementChild?.getAttribute("style")?.match(/height: ([\d.]+)px/)?.[1] ?? "0") : 36), 0);
  } });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: this.tagName === "TR" ? 36 : 720,
      width: 1000, height: this.tagName === "THEAD" ? 28 : this.tagName === "TR" ? 36 : 720, toJSON() {} };
  };
  let ids = Array.from({ length: 10000 }, (_, index) => index + 1);
  const requests: number[][] = [];
  const indexQueries: URLSearchParams[] = [];
  const summaryQueries: Record<string, unknown>[] = [];
  /** While set, summaries are not answered: the rows they belong to stay loading rows. */
  let summariesHeld: Promise<void> | null = null;
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
      if (summariesHeld) await summariesHeld;
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
    const { LIST_ARRIVAL_MS, LIST_ARRIVAL_STEPS } = await import("../src/components/library/listArrival");
    const arrivalOf = (scroller: Element) => scroller.getAttribute("data-kd-arrive");
    const arrivingRows = (scroller: Element) => [...scroller.querySelectorAll<HTMLElement>("tbody > tr[data-kd-arrive-row]")];
    const stepOf = (row: HTMLElement) => Number(row.style.getPropertyValue("--kd-arrive-i"));
    const arrivalOver = (gesture: "list" | "chase") => act(async () => { await new Promise(resolve => setTimeout(resolve, LIST_ARRIVAL_MS[gesture] + 40)); });
    {
      const scroller = document.querySelector<HTMLDivElement>(".kd-scroll")!;
      assert.equal(arrivalOf(scroller), "list");
      assert.equal(scroller.getAttribute("data-kd-arrive-from"), "below");
      const rows = arrivingRows(scroller);
      assert.equal(rows.length, 20, "the rows of the viewport: 692px of 36px rows");
      assert.deepEqual(rows.map(row => row.dataset.kdTrackId), Array.from({ length: 20 }, (_, index) => String(index + 1)),
        "the tracks that loaded after the gesture began took their rows' places in it");
      assert.deepEqual(rows.map(stepOf), Array.from({ length: 20 }, (_, index) => Math.min(index, LIST_ARRIVAL_STEPS - 1)));
      assert.deepEqual(rows.map(row => row.getAttribute("data-kd-arrive-row")), Array.from({ length: 20 }, (_, index) => index < LIST_ARRIVAL_STEPS ? "step" : "rest"));
      await arrivalOver("list");
      assert.equal(arrivalOf(scroller), null, "the marks are taken off when the gesture is over");
      assert.equal(arrivingRows(scroller).length, 0);
      assert.equal(scroller.querySelector("tr[style*='--kd-arrive']"), null);
    }
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
    // Layout determines activation; legacy preferences cannot change it or pin details.
    const { playClickForLayout, shouldPinDetailOnClick } = await import("../src/lib/trackClickPrefs");
    for (const layout of ["wide", "narrow"] as const) {
      for (const legacyClick of ["single", "double"] as const) {
        const prefs = { widePlay: legacyClick, narrowPlay: legacyClick };
        assert.equal(playClickForLayout(prefs, layout), layout === "narrow" ? "single" : "double");
        assert.equal(shouldPinDetailOnClick(prefs, layout), false);
      }
    }
    const row = document.querySelector<HTMLElement>("tr[data-kd-track-id]")!;
    await act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    assert.equal(useLibraryStore.getState().selectedId, Number(row.dataset.kdTrackId));
    assert.equal(useLibraryStore.getState().total, 10000);
    assert.ok(document.querySelectorAll("tr[data-kd-track-id]").length <= 102);
    const box = document.querySelector<HTMLDivElement>(".kd-scroll")!;
    const vertical = document.querySelector<HTMLElement>('[role="scrollbar"][data-axis="vertical"]')!;
    assert.equal(vertical.style.display, "");
    assert.equal(vertical.getAttribute("aria-valuemax"), "359308");
    await act(async () => {
      vertical.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
      box.dispatchEvent(new Event("scroll"));
    });
    await flush();
    assert.equal(box.scrollTop, 359308);
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
    await act(async () => { box.scrollTop = 359300; box.dispatchEvent(new Event("scroll")); });
    await flush();
    assert.ok(document.querySelector('tr[data-kd-track-id="10000"]'));
    assert.equal(document.querySelector("tr[data-loading-track]"), null, "no placeholder rows after a far jump");
    assert.equal(requests.length, requestsBeforeJump);
    // Wheel and trackpad scrolling belongs to the WebView's scrolling thread: the page must not cancel it.
    await act(async () => { box.scrollTop = 0; box.dispatchEvent(new Event("scroll")); });
    await flush();
    const wheel = new dom.window.WheelEvent("wheel", { deltaY: 180_000, bubbles: true, cancelable: true });
    box.dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, false, "the list is scrolled by the WebView, not by the page");
    assert.equal(box.scrollTop, 0);
    // The scroll it performs reaches the page as a scroll event; that frame commits the rows.
    let clock = performance.now();
    const frame = (elapsed: number) => act(() => {
      clock += elapsed;
      const current = [...frames.values()]; frames.clear();
      for (const callback of current) callback(clock);
    });
    const rows = () => document.querySelectorAll("tr[data-kd-track-id]").length;
    const ratings = () => document.querySelectorAll("tr[data-kd-track-id] .kd-table-rating").length;
    box.scrollTop = 180_000;
    box.dispatchEvent(new Event("scroll"));
    frame(16);
    assert.ok(document.querySelector('tr[data-kd-track-id="5001"]'), "rows are committed in the frame that reported the scroll");
    assert.equal(document.querySelector("tr[data-loading-track]"), null);
    assert.equal(requests.length, requestsBeforeJump);
    // No canvas here, so there are no stand-in rows: the table builds its own rows at any speed.
    assert.equal(document.querySelectorAll(".kd-table-standins canvas").length, 0);
    const landed = rows();
    assert.ok(landed >= 5 * 19, `two screens either side of the viewport (${landed})`);
    assert.equal(ratings(), landed, "every row is complete");
    // The rows that stay in the window while it moves keep their nodes: only entering rows are rendered.
    const kept = document.querySelector('tr[data-kd-track-id="5001"]')!;
    const keptRating = kept.querySelector(".kd-table-rating");
    for (let step = 1; step <= 24; step += 1) {
      box.scrollTop = 180_000 + step * 30;
      box.dispatchEvent(new Event("scroll"));
      frame(16);
    }
    assert.ok(document.querySelector('tr[data-kd-track-id="5060"]'), "the window followed the scroll");
    assert.equal(document.querySelector('tr[data-kd-track-id="5001"]'), kept);
    assert.equal(kept.querySelector(".kd-table-rating"), keptRating);
    assert.equal(ratings(), rows());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    await flush();
    // Past either end the WebView bounces and reports offsets outside the list. That is not a scroll:
    // the page neither pulls the container back nor moves its rows.
    const end = box.scrollHeight - box.clientHeight;
    box.scrollTop = end;
    box.dispatchEvent(new Event("scroll"));
    frame(16);
    assert.ok(document.querySelector('tr[data-kd-track-id="10000"]'));
    const lastRow = document.querySelector('tr[data-kd-track-id="10000"]');
    const atEnd = rows();
    for (const overshoot of [40, 90, 30, 0]) {
      box.scrollTop = end + overshoot;
      box.dispatchEvent(new Event("scroll"));
      frame(16);
      assert.equal(box.scrollTop, end + overshoot, "the bounce at the bottom is left to the WebView");
      assert.equal(document.querySelector('tr[data-kd-track-id="10000"]'), lastRow);
      assert.equal(rows(), atEnd);
    }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    await flush();
    box.scrollTop = 0;
    box.dispatchEvent(new Event("scroll"));
    frame(16);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    await flush();
    const firstRow = document.querySelector('tr[data-kd-track-id="1"]');
    assert.ok(firstRow);
    for (const overshoot of [-50, -120, -20, 0]) {
      box.scrollTop = overshoot;
      box.dispatchEvent(new Event("scroll"));
      frame(16);
      assert.equal(box.scrollTop, overshoot, "the bounce at the top is left to the WebView");
      assert.equal(document.querySelector('tr[data-kd-track-id="1"]'), firstRow);
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
    const arriving = () => arrivalOf(box);
    assert.equal(arriving(), null);
    await act(async () => { await useLibraryStore.getState().refresh(); });
    await flush();
    assert.ok(box.scrollTop <= 7200);
    assert.ok(document.querySelectorAll("tr[data-kd-track-id]").length > 0);
    // The same list in a new state (shorter, re-read) is not presented again.
    assert.equal(arriving(), null, "a refresh of the same query is not an arrival");
    assert.equal(arrivingRows(box).length, 0);
    await act(async () => {
      useLibraryStore.getState().setFilter({ q: "changed query" });
      await useLibraryStore.getState().refresh();
    });
    await flush();
    assert.equal(box.scrollTop, 0, "query changes reset the actual scroll offset");
    assert.equal(arriving(), "list", "another list arrives");
    const presented = arrivingRows(box);
    assert.deepEqual(presented.map(row => row.dataset.kdTrackId), Array.from({ length: 20 }, (_, index) => String(ids[index])));
    assert.deepEqual(presented.map(stepOf), Array.from({ length: 20 }, (_, index) => Math.min(index, LIST_ARRIVAL_STEPS - 1)));
    // A selection, a row that updates and a re-render leave the gesture as it is: nothing is marked again.
    await act(async () => { useLibraryStore.getState().select(ids[3]); });
    await act(async () => { await useLibraryStore.getState().refreshTrackSummaries([ids[5]]); });
    await flush();
    assert.equal(arriving(), "list");
    assert.deepEqual(arrivingRows(box), presented, "the same rows, the same nodes");
    assert.ok(presented.every(row => !row.style.getPropertyValue("--kd-arrive-lag")), "no row was started again");
    // Replaced again while it is still arriving: the rows in view are arriving, whichever of them are new.
    await act(async () => {
      useLibraryStore.getState().setFilter({ q: "changed again" });
      await useLibraryStore.getState().refresh();
    });
    await flush();
    assert.equal(arriving(), "list");
    assert.equal(arrivingRows(box).length, 20);
    // Leaving the place it arrived at ends it at once; the table goes on from there without the marks.
    box.scrollTop = 720;
    box.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(arriving(), null, "scrolling drops the marks");
    assert.equal(arrivingRows(box).length, 0);
    await flush();
    assert.equal(arriving(), null);
    box.scrollTop = 0;
    box.dispatchEvent(new dom.window.Event("scroll"));
    await flush();
    assert.equal(arriving(), null, "returning to the top is not an arrival");
    // The pane is put away and shown again (it stays mounted, display: none): the list arrives
    // again where it was left, however far down that is.
    box.scrollTop = 100 * 36;
    box.dispatchEvent(new dom.window.Event("scroll"));
    await flush();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    await flush();
    assert.equal(arriving(), null);
    await act(async () => root.render(createElement(StrictMode, {}, createElement(Host, { visible: false }))));
    assert.equal(arriving(), null, "a hidden list does not arrive");
    await act(async () => root.render(createElement(StrictMode, {}, createElement(Host, { visible: true }))));
    assert.equal(arriving(), "list", "shown again: it arrives");
    assert.deepEqual(arrivingRows(box).map(row => row.dataset.kdTrackId), Array.from({ length: 20 }, (_, index) => String(ids[100 + index])),
      "the rows in view, not the top of the list");
    assert.deepEqual(arrivingRows(box).map(stepOf).slice(0, 3), [0, 1, 2]);
    const shownAgain = arrivingRows(box);
    await act(async () => root.render(createElement(StrictMode, {}, createElement(Host, { visible: true }))));
    assert.deepEqual(arrivingRows(box), shownAgain, "a render that changes nothing does not start it again");
    await act(async () => root.render(createElement(StrictMode, {}, createElement(Host, { visible: false }))));
    assert.equal(arriving(), null, "put away mid-arrival: the marks go");
    assert.equal(arrivingRows(box).length, 0);
    await act(async () => root.render(createElement(StrictMode, {}, createElement(Host, { visible: true }))));
    assert.equal(arriving(), "list");
    // Reduced motion: the list is simply there, and one that was arriving stops.
    reducedMotion = true;
    await act(async () => {
      useLibraryStore.getState().setFilter({ q: "changed quietly" });
      await useLibraryStore.getState().refresh();
    });
    await flush();
    assert.equal(box.scrollTop, 0);
    assert.equal(arriving(), null);
    assert.equal(arrivingRows(box).length, 0);
    reducedMotion = false;
    ids = [];
    await act(async () => { await useLibraryStore.getState().refresh(); });
    await flush();
    assert.equal(document.querySelectorAll("tbody tr").length, 0);
    assert.equal(document.querySelector("tbody")!.textContent, "");
    await act(async () => useDownloadStore.setState({ list: Array.from({ length: 10000 }, (_, index) => ({
      id: String(index), state: "queued", dest_dir: "/library", title: `Pending ${index}`, artist: "", progress: 0,
    })) as never }));
    await flush();
    assert.ok(document.querySelectorAll('tr[data-pending="true"]').length <= 102);
    await act(async () => { root.render(null); useDownloadStore.setState({ list: [] }); });
    ids = Array.from({ length: 10000 }, (_, index) => index + 1);
    const { updateLocalWorkspaceSession } = await import("../src/lib/workspaceSession");
    // The table mounted next finds a canvas it can paint on and a row it can measure, so a fast
    // scroll of it holds the rows back and shows stand-ins, as it does in the app (see below).
    Object.assign(globalThis, { Node: dom.window.Node });
    const fakeContext = { setTransform() {}, clearRect() {}, drawImage() {}, beginPath() {}, rect() {}, fill() {}, fillRect() {}, roundRect() {} };
    const paintable = (on: boolean) => {
      dom.window.HTMLCanvasElement.prototype.getContext = (() => on ? fakeContext : null) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
    };
    paintable(true);
    dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 40, y: 10, left: 40, top: 10, right: 80, bottom: 26, width: 40, height: 16, toJSON() {} });
    await act(async () => {
      await useLibraryStore.getState().refresh();
      updateLocalWorkspaceSession({ topVisibleTrackId: 9500, rowOffset: 7, scrollTop: 341971 });
      root.render(createElement(Host));
    });
    await flush();
    const restored = document.querySelector<HTMLDivElement>(".kd-scroll")!;
    paintable(false);
    assert.equal(restored.scrollTop, 9499 * 36 + 7);
    assert.ok(document.querySelector('tr[data-kd-track-id="9500"]'));
    // Presented where it had been left: the rows in view there arrive, not the top of the list.
    assert.equal(arrivalOf(restored), "list");
    assert.equal(arrivingRows(restored)[0], document.querySelector('tr[data-kd-track-id="9500"]'));
    assert.equal(arrivingRows(restored).length, 20);
    // Pressing a row prepares the system drag preview from the thumbnail route, not the original cover.
    await act(async () => {
      const down = pointer("pointerdown", 200);
      Object.defineProperty(down, "pointerType", { value: "mouse" });
      document.querySelector('tr[data-kd-track-id="9500"] td')!.dispatchEvent(down);
      window.dispatchEvent(pointer("pointercancel", 200));
    });
    await flush();
    const dragCovers = coverQueries.filter(url => url.pathname === "/api/library/cover/9500" && url.searchParams.get("size") !== "64");
    assert.ok(dragCovers.length > 0);
    assert.ok(dragCovers.every(url => url.searchParams.get("size") === "256"), dragCovers.join(" "));

    // —— A fast scroll, and the rows catching up with it ——
    {
      paintable(true);
      const table = restored;
      const body = table.querySelector("tbody")!;
      const tiles = () => [...table.querySelectorAll<HTMLCanvasElement>(".kd-table-standins canvas")].filter(canvas => canvas.style.display !== "none");
      const fading = () => table.querySelectorAll(".kd-table-standins canvas[data-leaving]").length;
      const builtRows = () => [...body.children].filter(row => !row.hasAttribute("data-spacer"));
      const rowOf = (index: number) => table.querySelector<HTMLElement>(`tr[data-kd-track-id="${index + 1}"]`);
      /** The rows [first, last) under the viewport: 692px of rows below the header. */
      const inView = () => [Math.floor(table.scrollTop / 36), Math.ceil((table.scrollTop + 692) / 36)] as const;
      const scrollBy = (pixels: number, elapsed = 16) => {
        table.scrollTop += pixels;
        table.dispatchEvent(new Event("scroll"));
        frame(elapsed);
      };
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
      await flush();
      // The clock of timers stands still in this part and is moved by hand: building rows in
      // JSDOM takes longer than the gestures that are timed here.
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const pass = (ms: number) => act(async () => { t.mock.timers.tick(ms); });
      /** Long enough without a scroll frame for the table to take the scroll as over. */
      const rest = async () => { await pass(220); await flush(); };
      // Every change of the rows React makes: a fast scroll must make none.
      const built: MutationRecord[] = [];
      const watch = new dom.window.MutationObserver(records => { built.push(...records); });
      watch.observe(body, { childList: true });
      const commits = () => { built.push(...watch.takeRecords()); const count = built.length; built.length = 0; return count; };

      // A scroll at reading speed marks nothing: rows are committed in the frame, as they are,
      // with no stand-in.
      commits();
      for (let step = 0; step < 40; step += 1) {
        scrollBy(-30);
        assert.equal(arrivalOf(table), null, "reading speed: no arrival");
        assert.equal(tiles().length, 0);
        assert.ok(rowOf(inView()[0]) && rowOf(inView()[1] - 1), "the rows are there in the frame that reported the scroll");
      }
      assert.ok(commits() > 0, "the window followed, a step at a time");
      assert.equal(arrivingRows(table).length, 0);
      await rest();

      // A fling towards the top: no row is built, frame after frame; the stand-ins cover the viewport.
      commits();
      const heldRows = builtRows();
      for (let step = 0; step < 20; step += 1) {
        scrollBy(-3000);
        assert.ok(tiles().length > 0, "stand-ins on show");
        assert.equal(rowOf(inView()[0]), null, "the viewport has run past the rows");
      }
      // It slows down. Until the pace is one rows can be built for, still nothing is built.
      let slowing = 0;
      while (arrivalOf(table) === null && slowing < 80) {
        assert.equal(commits(), 0, "a fast scroll commits no rows");
        assert.deepEqual(builtRows(), heldRows);
        scrollBy(-20);
        slowing += 1;
      }
      assert.ok(slowing > 5 && slowing < 80, `the pace dropped after ${slowing} slow frames`);
      // That frame built the rows here, once, and they run after the scroll: the row nearest to
      // where it came from first (the bottom one), dropping in from above; a screen further on in
      // the direction of travel comes with the last beat; rows the scroll has passed are left alone.
      assert.ok(commits() > 0);
      assert.equal(arrivalOf(table), "chase");
      assert.equal(table.getAttribute("data-kd-arrive-from"), "above");
      let [first, last] = inView();
      let chasing = arrivingRows(table);
      assert.equal(chasing.length, 2 * (last - first), "the viewport and a screen ahead");
      assert.equal(stepOf(rowOf(last - 1)!), 0);
      assert.equal(stepOf(rowOf(last - 2)!), 1);
      assert.equal(stepOf(rowOf(first)!), LIST_ARRIVAL_STEPS - 1);
      assert.equal(rowOf(last - 1)!.getAttribute("data-kd-arrive-row"), "step");
      assert.equal(rowOf(first - 1)!.getAttribute("data-kd-arrive-row"), "rest");
      assert.equal(rowOf(first - (last - first))!.getAttribute("data-kd-arrive-row"), "rest");
      assert.equal(rowOf(first - (last - first) - 1)!.hasAttribute("data-kd-arrive-row"), false, "further ahead: built, not animated");
      assert.equal(rowOf(last)!.hasAttribute("data-kd-arrive-row"), false, "behind the scroll: built, not animated");
      assert.ok(fading() > 0 && fading() === tiles().length, "the stand-ins still in view fade out over the arriving rows");
      // The rest of the scroll plays out at reading speed while they arrive: the window steps on,
      // and no row is started again.
      for (let step = 0; step < 16; step += 1) scrollBy(-20);
      assert.ok(commits() > 0);
      assert.equal(arrivalOf(table), "chase");
      assert.deepEqual(arrivingRows(table).filter(row => row.isConnected), chasing.filter(row => row.isConnected));
      assert.ok(arrivingRows(table).every(row => !row.style.getPropertyValue("--kd-arrive-lag")));

      // A second fling before they have arrived: the rows are simply there, the stand-ins are back.
      scrollBy(-3000);
      assert.equal(arrivalOf(table), null);
      assert.equal(arrivingRows(table).length, 0);
      assert.equal(table.querySelector("tr[style*='--kd-arrive']"), null);
      assert.equal(fading(), 0);
      assert.ok(tiles().length > 0);
      assert.equal(commits(), 0);
      // It stops dead (a dragged handle let go): the rows are built when the scroll has rested, and chase the same way.
      await rest();
      assert.equal(arrivalOf(table), "chase");
      assert.equal(table.getAttribute("data-kd-arrive-from"), "above");
      [first, last] = inView();
      assert.equal(stepOf(rowOf(last - 1)!), 0);
      await pass(LIST_ARRIVAL_MS.chase + 40);
      assert.equal(arrivalOf(table), null, "over in a third of a second");
      assert.equal(arrivingRows(table).length, 0);
      assert.equal(tiles().length, 0, "no canvas stays on show over the rows");

      // Towards the end of the list the rows rise from below, the top one first.
      for (let step = 0; step < 12; step += 1) scrollBy(3000);
      for (slowing = 0; arrivalOf(table) === null && slowing < 80; slowing += 1) scrollBy(20);
      assert.equal(arrivalOf(table), "chase");
      assert.equal(table.getAttribute("data-kd-arrive-from"), "below");
      [first, last] = inView();
      chasing = arrivingRows(table);
      assert.equal(chasing[0], rowOf(first));
      assert.deepEqual(chasing.slice(0, 4).map(stepOf), [0, 1, 2, 3]);
      assert.equal(chasing.at(-1), rowOf(last + (last - first) - 1));
      await rest();
      await pass(LIST_ARRIVAL_MS.chase + 40);

      // A quick flick that never leaves the rows the table had built is not a chase: they were on screen all along.
      commits();
      for (let step = 0; step < 4; step += 1) scrollBy(150);
      assert.ok(tiles().length === 0 || arrivalOf(table) === null);
      for (slowing = 0; slowing < 60; slowing += 1) scrollBy(4);
      assert.equal(arrivalOf(table), null, "nothing new came into view");
      assert.equal(arrivingRows(table).length, 0);
      await rest();
      assert.equal(arrivalOf(table), null);
      assert.equal(tiles().length, 0);

      // Reduced motion: the rows are simply there when the scroll slows down, and the stand-ins go at once.
      reducedMotion = true;
      for (let step = 0; step < 12; step += 1) scrollBy(-3000);
      assert.ok(tiles().length > 0);
      for (slowing = 0; rowOf(inView()[0]) === null && slowing < 80; slowing += 1) scrollBy(-20);
      assert.ok(rowOf(inView()[0]) && rowOf(inView()[1] - 1));
      assert.equal(arrivalOf(table), null);
      assert.equal(tiles().length, 0);
      reducedMotion = false;
      await rest();

      // Rows whose tracks have not loaded: the loading rows chase, and a track that arrives
      // meanwhile takes its row's place in step with the others instead of starting over.
      // (A short list of tracks nobody has seen, so that all of them load in one answer.)
      const turns = async () => { for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setImmediate(resolve)); };
      let release = () => {};
      summariesHeld = new Promise(resolve => { release = resolve; });
      ids = Array.from({ length: 400 }, (_, index) => index + 20001);
      await act(async () => { void useLibraryStore.getState().refresh(); await turns(); });
      await flush();
      assert.ok(table.scrollTop > 13000, "the shorter list is shown at its end");
      for (let step = 0; step < 3; step += 1) scrollBy(-3000);
      for (slowing = 0; arrivalOf(table) === null && slowing < 80; slowing += 1) scrollBy(-20);
      assert.equal(arrivalOf(table), "chase");
      chasing = arrivingRows(table);
      assert.ok(chasing.length > 0 && chasing.every(row => row.hasAttribute("data-loading-track")), "loading rows arrive like any other");
      const steps = chasing.map(stepOf);
      await act(async () => { release(); summariesHeld = null; await turns(); });
      await flush();
      const loaded = arrivingRows(table);
      assert.equal(arrivalOf(table), "chase");
      assert.ok(loaded.length === chasing.length && loaded.every(row => row.hasAttribute("data-kd-track-id")), "the tracks took over their rows");
      assert.deepEqual(loaded.map(stepOf), steps, "each at its row's step");
      assert.ok(loaded.every(row => /^\d+ms$/.test(row.style.getPropertyValue("--kd-arrive-lag"))), "and as far into the gesture as the others are");
      await pass(LIST_ARRIVAL_MS.chase + 40);
      assert.equal(arrivalOf(table), null);
      assert.equal(arrivingRows(table).length, 0);
      await pass(2000);
      t.mock.timers.reset();
      watch.disconnect();
      // Back to the library the rest of the test expects, and to a table without a canvas.
      ids = Array.from({ length: 10000 }, (_, index) => index + 1);
      await act(async () => { await useLibraryStore.getState().refresh(); });
      await flush();
      paintable(false);
    }

    // Mount a second real table, with its own query and keyboard/clipboard owner.
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
    assert.deepEqual(deleted, [temporary.store.getState().selectedIds], "only the active table handles deletion");
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
    frames.clear(); dom.window.close();
  }
});

test("list arrival: the marks outlast the gesture the stylesheet describes, restart cleanly and are taken off", async (t) => {
  const fs = await import("node:fs");
  const { createListArrival, LIST_ARRIVAL_MS, LIST_ARRIVAL_STEPS } = await import("../src/components/library/listArrival");
  // The numbers the marks have to outlast are the stylesheet's.
  const strip = (file: string) => fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const motion = strip("src/motion.css");
  const sheet = strip("src/components/library/ListArrival.css");
  const token = (name: string) => {
    const value = new RegExp(`--kd-motion-${name}:\\s*(\\d+)ms`).exec(motion)?.[1];
    assert.ok(value, `--kd-motion-${name} is defined in ms`);
    return Number(value);
  };
  const lastStep = LIST_ARRIVAL_STEPS - 1;
  const list = token("list-lead") + lastStep * token("list-step") + token("list-cover-after") + token("list-cover");
  assert.ok(token("list-lead") + lastStep * token("list-step") + token("list-row") <= list, "the last cover is the last thing to land");
  assert.ok(LIST_ARRIVAL_MS.list >= list && LIST_ARRIVAL_MS.list <= list + 100, `a presented list is over after ${list}ms`);
  const coverAfter = Number(/\[data-kd-arrive="chase"\][^{]*\.kd-thumb\s*\{[^}]*\+\s*(\d+)ms/.exec(sheet)?.[1]);
  const chase = lastStep * token("stagger") + coverAfter + token("micro");
  assert.match(sheet, /\[data-kd-arrive="chase"\][^{]*\{\s*animation:\s*kd-motion-list-rise\s+var\(--kd-motion-micro\)\s+var\(--kd-ease-list\)\s+calc\(var\(--kd-arrive-i, 0\) \* var\(--kd-motion-stagger\)/);
  assert.ok(LIST_ARRIVAL_MS.chase >= chase && LIST_ARRIVAL_MS.chase <= chase + 60, `the chase is over after ${chase}ms`);
  assert.ok(chase <= 320, "about a quarter of a second, never long enough to stand in the way of reading");

  const dom = new JSDOM("<!doctype html><div class='kd-scroll'><table class='kd-table'><tbody></tbody></table></div>", { url: "http://localhost" });
  let reduced = false;
  dom.window.matchMedia = (() => ({ matches: reduced, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  const styleReads: Element[] = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    getComputedStyle: (element: Element) => { styleReads.push(element); return dom.window.getComputedStyle(element); } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const scroller = document.querySelector<HTMLElement>(".kd-scroll")!;
    const body = document.querySelector("tbody")!;
    const row = () => body.appendChild(document.createElement("tr"));
    const rows = Array.from({ length: 20 }, row);
    const marks = () => rows.map(element => element.getAttribute("data-kd-arrive-row"));
    const arrival = createListArrival(scroller);
    assert.equal(arrival.gesture(), null);

    // Rows in the order they arrive; a row that is not mounted keeps its place as a gap.
    arrival.start("chase", "above", [rows[0], null, rows[2], ...rows.slice(3)]);
    assert.equal(arrival.gesture(), "chase");
    assert.equal(scroller.getAttribute("data-kd-arrive"), "chase");
    assert.equal(scroller.getAttribute("data-kd-arrive-from"), "above");
    assert.equal(marks()[1], null);
    assert.equal(rows[2].style.getPropertyValue("--kd-arrive-i"), "2");
    assert.equal(rows[13].getAttribute("data-kd-arrive-row"), "step");
    assert.equal(rows[14].getAttribute("data-kd-arrive-row"), "rest");
    assert.equal(rows[19].style.getPropertyValue("--kd-arrive-i"), String(lastStep), "past the cascade: with its last beat");
    // The row that was missing is mounted: it joins at its own step, as late as it is; the others are not touched.
    arrival.join(rows);
    assert.equal(rows[1].getAttribute("data-kd-arrive-row"), "step");
    assert.equal(rows[1].style.getPropertyValue("--kd-arrive-i"), "1");
    assert.equal(rows[0].style.getPropertyValue("--kd-arrive-lag"), "");
    // A chase goes on while the scroll plays out.
    scroller.scrollTop = 400;
    scroller.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(arrival.gesture(), "chase");

    // Another gesture over rows that are still arriving: they must be seen without their marks
    // in between, or the animation they already run simply goes on.
    styleReads.length = 0;
    arrival.start("list", "below", rows);
    assert.ok(styleReads.length === 1 && rows.includes(styleReads[0] as HTMLTableRowElement), "the style is settled once, on a row that was marked");
    assert.equal(arrival.gesture(), "list");
    assert.equal(scroller.getAttribute("data-kd-arrive-from"), "below");
    assert.ok(rows.every(element => !element.style.getPropertyValue("--kd-arrive-lag")), "every row starts from its beginning");
    // The first gesture's timer is not this one's end.
    t.mock.timers.tick(LIST_ARRIVAL_MS.chase + 10);
    assert.equal(arrival.gesture(), "list");
    // A presented list is left alone by a scroll: one that leaves the place it arrived at ends it.
    scroller.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(arrival.gesture(), "list", "being put where it is, is not leaving");
    scroller.scrollTop = 440;
    scroller.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(arrival.gesture(), null);
    assert.ok(marks().every(mark => mark === null));
    assert.ok(rows.every(element => element.getAttribute("style") === null || element.getAttribute("style") === ""), "nothing of it stays on a row");
    assert.equal(scroller.hasAttribute("data-kd-arrive") || scroller.hasAttribute("data-kd-arrive-from"), false);

    // A list presented again while it arrives (a filter typed letter by letter): the rows that
    // stay carry on untouched, the ones new to the view start, and the gesture lasts for them.
    arrival.start("list", "below", rows.slice(0, 6));
    t.mock.timers.tick(300);
    styleReads.length = 0;
    const fresh = row();
    arrival.start("list", "below", [rows[0], rows[3], fresh]);
    assert.equal(styleReads.length, 0, "nothing is started again");
    assert.deepEqual([rows[0], rows[3]].map(element => element.style.getPropertyValue("--kd-arrive-i")), ["0", "3"], "a row keeps the step it is arriving on");
    assert.equal(fresh.getAttribute("data-kd-arrive-row"), "step");
    assert.equal(fresh.style.getPropertyValue("--kd-arrive-i"), "2");
    assert.equal(fresh.style.getPropertyValue("--kd-arrive-lag"), "");
    t.mock.timers.tick(LIST_ARRIVAL_MS.list - 1);
    assert.equal(arrival.gesture(), "list", "the time runs from the last presentation");
    t.mock.timers.tick(1);
    assert.equal(arrival.gesture(), null);
    assert.equal(fresh.hasAttribute("data-kd-arrive-row") || rows[0].hasAttribute("data-kd-arrive-row"), false);
    fresh.remove();

    // It ends by itself.
    arrival.start("list", "below", rows);
    t.mock.timers.tick(LIST_ARRIVAL_MS.list - 1);
    assert.equal(arrival.gesture(), "list");
    t.mock.timers.tick(1);
    assert.equal(arrival.gesture(), null);
    assert.ok(marks().every(mark => mark === null));
    // Nothing to mark, or reduced motion: nothing starts.
    arrival.start("chase", "below", [null, undefined]);
    assert.equal(arrival.gesture(), null);
    reduced = true;
    arrival.start("list", "below", rows);
    assert.equal(arrival.gesture(), null);
    assert.ok(marks().every(mark => mark === null));
  } finally {
    t.mock.timers.reset();
    dom.window.close();
  }
});
