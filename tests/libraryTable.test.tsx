import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement, act, StrictMode, Fragment } from "react";
import type { TrackSummary } from "../src/types";

const makeRow = (id: number): TrackSummary => ({ id, path: `/library/${id}.mp3`, filename: `${id}.mp3`,
  title: `Song ${id}`, artist: "Artist", album: "Album", format: "mp3", size: 1000,
  camelot: "8A", modified_at: "a", duration: 100, rating: 0, bpm: 128,
  file_created_at: id, analyzed_at: "now", source_platform: "local" } as TrackSummary);

test("real table/store: direct jump, full selection, shrink, empty result, and bounded pending rows", async () => {
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
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia;
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
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const { createRoot } = await import("react-dom/client");
  const { useLibraryStore } = await import("../src/stores/libraryStore");
  const { useDownloadStore } = await import("../src/stores/downloadStore");
  const { TrackTable } = await import("../src/components/library/TrackTable");
  const root = createRoot(document.getElementById("root")!);
  function Host({ shortcutActive = true }: { shortcutActive?: boolean } = {}) {
    const total = useLibraryStore(state => state.total);
    const loading = useLibraryStore(state => state.loading);
    const selectedId = useLibraryStore(state => state.selectedId);
    const selectedIds = useLibraryStore(state => state.selectedIds);
    return createElement(TrackTable, { total, loading, selectedId, selectedIds, layout: "wide", shortcutActive,
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
      assert.equal(useLibraryStore.getState().error, "");
      assert.ok(useLibraryStore.getState().summaryById.size > 0);
      assert.equal(indexQueries.at(-1)!.get("analyzed"), analyzed === "no" ? "false" : null);
      assert.equal(summaryQueries.at(-1)!.analyzed, analyzed === "no" ? false : undefined);
      assert.equal(indexQueries.at(-1)!.get("folder_deep"), null);
      assert.equal(summaryQueries.at(-1)!.folder_deep, undefined);
      assert.equal(summaryQueries.at(-1)!.bpm_min, undefined);
    }
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
    await act(async () => { box.scrollTop = 359300; box.dispatchEvent(new Event("scroll")); });
    await flush(); await flush();
    assert.ok(document.querySelector('tr[data-kd-track-id="10000"]'));
    assert.ok(requests.some(values => values.includes(10000)));
    assert.ok(requests.flat().every(id => id <= 400 || id >= 9600), "no sequential walk through intermediate songs");
    await act(async () => useLibraryStore.getState().select(1));
    await act(async () => useLibraryStore.getState().select(10000, "range"));
    assert.equal(useLibraryStore.getState().selectedIds.length, 10000);
    await act(async () => useLibraryStore.getState().selectAll());
    assert.equal(useLibraryStore.getState().selectedIds.length, 10000);
    ids = ids.slice(0, 200);
    await act(async () => { await useLibraryStore.getState().refresh(); });
    await flush();
    assert.ok(box.scrollTop <= 7200);
    assert.ok(document.querySelectorAll("tr[data-kd-track-id]").length > 0);
    await act(async () => {
      useLibraryStore.getState().setFilter({ q: "changed query" });
      await useLibraryStore.getState().refresh();
    });
    await flush();
    assert.equal(box.scrollTop, 0, "query changes reset the actual scroll offset");
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
    await act(async () => {
      await useLibraryStore.getState().refresh();
      updateLocalWorkspaceSession({ topVisibleTrackId: 9500, rowOffset: 7, scrollTop: 341971 });
      root.render(createElement(Host));
    });
    await flush();
    const restored = document.querySelector<HTMLDivElement>(".kd-scroll")!;
    assert.equal(restored.scrollTop, 9499 * 36 + 7);
    assert.ok(document.querySelector('tr[data-kd-track-id="9500"]'));

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
