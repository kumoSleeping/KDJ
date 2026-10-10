import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement, act, StrictMode } from "react";
import type { ResultTableProps } from "../src/components/download/ResultTable";
import type { IntakeItem, MergedGroup, SongSource } from "../src/types";

const ROW = 36;
const HEAD = 28;

const source = (key: string): SongSource => ({ platform: "wyy", key, title: key, artists: ["a"], album: "",
  duration: 100, cover: "", max_quality: null, vip: false, payload: {} });
const group = (id: string): MergedGroup => ({ group_id: id, title: id, artists: ["a"], album: "", duration: 100,
  cover: "", sources: [source(id)], best_source_index: 0, score: 1 });
const item = (kind: IntakeItem["kind"], entry: string, rows: number): IntakeItem => ({ entry, kind, platform: null,
  title: entry, groups: Array.from({ length: rows }, (_, index) => group(`${entry}-${index}`)), collections: [],
  errors: {}, error: "" });

test("the result table: every presented list cascades once, and an opened collection grows at its end", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    HTMLTableRowElement: dom.window.HTMLTableRowElement, MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia;
  // The pane's size observers, so the test can say "the pane was resized".
  const resizeObservers = new Set<() => void>();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    private readonly notify: () => void;
    constructor(callback: () => void) { this.notify = callback; }
    observe() { resizeObservers.add(this.notify); }
    unobserve() { resizeObservers.delete(this.notify); }
    disconnect() { resizeObservers.delete(this.notify); }
  };

  // A layout for JSDOM: rows of 36px under a 28px header, in a pane 720px tall that scrolls.
  const proto = dom.window.HTMLElement.prototype;
  const bodyRows = (element: Element) => [...(element.closest("table")?.querySelectorAll("tbody > tr") ?? [])];
  Object.defineProperty(proto, "offsetTop", { configurable: true, get(this: HTMLElement) {
    return this.tagName === "TR" ? HEAD + bodyRows(this).indexOf(this) * ROW : 0;
  } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get(this: HTMLElement) {
    return this.tagName === "TR" ? ROW : this.tagName === "THEAD" ? HEAD : 0;
  } });
  let paneHeight = 720;
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return paneHeight; } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get(this: HTMLElement) {
    return HEAD + this.querySelectorAll("tbody > tr").length * ROW + (this.querySelector(".kd-result-more") ? 44 : 0);
  } });

  const { createRoot } = await import("react-dom/client");
  const { ResultTable } = await import("../src/components/download/ResultTable");
  const { RESULT_ARRIVAL_MS } = await import("../src/components/download/resultArrival");
  // The timers that end an arrival are held here and run by `settle`, so the test does not wait
  // a second for each of them. Every other timer is the real one.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const arrivalTimers = new Map<object, () => void>();
  globalThis.setTimeout = ((callback: () => void, delay?: number, ...rest: unknown[]) => {
    if (delay !== RESULT_ARRIVAL_MS) return realSetTimeout(callback, delay, ...rest);
    const id = {};
    arrivalTimers.set(id, callback);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    if (typeof id === "object" && id !== null && arrivalTimers.delete(id)) return;
    realClearTimeout(id as never);
  }) as typeof clearTimeout;
  const root = createRoot(document.getElementById("root")!);
  const noop = () => {};
  let asked = 0;
  const base: ResultTableProps = {
    items: [], video: null, loading: false, searched: true, delivery: { id: 0, top: 0, left: 0 }, paneShown: true,
    layout: "wide", selected: new Set(), selectionMode: false, onSelectionModeChange: noop,
    expandedGroups: new Set(), collapsedItems: new Set(), sourceIndex: {}, inspectedGroup: null,
    collectionShown: 50, hasMoreRows: false, loadingMoreRows: false, onShowMoreRows: () => { asked += 1; },
    onToggleSelect: noop, onToggleExpand: noop, onPickSource: noop, onToggleItem: noop, onToggleItemAll: noop,
    onToggleAll: noop, onDownloadGroup: noop, onDownloadSelected: noop, onInspectGroup: noop,
    onLoadCollection: noop, loadingCollections: new Set(),
  };
  let props = base;
  const render = (patch: Partial<ResultTableProps>) => act(async () => {
    props = { ...props, ...patch };
    // The table lives in the pane's scroller, as in the workspace.
    root.render(createElement(StrictMode, {},
      createElement("div", { className: "kd-scroll" }, createElement(ResultTable, props))));
  });
  const scroller = () => document.querySelector<HTMLElement>(".kd-scroll")!;
  const rows = () => [...document.querySelectorAll<HTMLElement>("tbody > tr")];
  const marks = () => rows().map((row) => row.getAttribute("data-reveal"));
  /** The cascade as marked: the index of its first row, how many rise, how many follow together. */
  const cascade = () => {
    const all = marks();
    return {
      from: all.findIndex((mark) => mark === "0"),
      steps: all.filter((mark) => mark !== null && mark !== "rest").length,
      rest: all.filter((mark) => mark === "rest").length,
    };
  };
  /** The arrivals that are running come to their end. */
  const settle = async () => {
    await act(async () => {
      const due = [...arrivalTimers.values()];
      arrivalTimers.clear();
      for (const callback of due) callback();
    });
  };
  const scrollTo = async (top: number) => {
    await act(async () => {
      scroller().scrollTop = top;
      scroller().dispatchEvent(new dom.window.Event("scroll"));
    });
  };

  try {
    // —— A: the cascade ——
    // The first search: a spinner, then its answer rises row after row from the top.
    await render({ loading: true });
    assert.ok(document.querySelector(".kd-search-loading"));
    await render({ loading: false, items: [item("search", "one", 40)], delivery: { id: 1, top: 0, left: 0 } });
    assert.equal(rows().length, 40);
    assert.deepEqual(marks().slice(0, 16), [..."0123456789"].concat(["10", "11", "12", "13", "rest", "rest"]));
    assert.deepEqual(cascade(), { from: 0, steps: 14, rest: 26 });
    const firstBody = document.querySelector("tbody");

    // A re-render, a selection and a row with its sources opened present nothing again, and
    // the marks come off when the gesture is over.
    await settle();
    assert.deepEqual(cascade(), { from: -1, steps: 0, rest: 0 });
    await render({ selected: new Set(["0:one-3"]), selectionMode: true });
    await render({ expandedGroups: new Set(["one-2"]) });
    assert.deepEqual(cascade(), { from: -1, steps: 0, rest: 0 });
    assert.equal(document.querySelector("tbody"), firstBody);
    await render({ selected: new Set(), selectionMode: false, expandedGroups: new Set() });

    // The second search runs under the rows of the first (no spinner) and its answer replaces
    // them: this is the delivery that used to arrive without a cascade, every row merely
    // "late". Scrolled down in the old list, the new one still starts at its top.
    await scrollTo(400);
    await render({ loading: true });
    assert.equal(document.querySelector(".kd-search-loading"), null);
    assert.deepEqual(cascade(), { from: -1, steps: 0, rest: 0 });
    await render({ loading: false, items: [item("search", "two", 30)], delivery: { id: 2, top: 0, left: 0 } });
    assert.equal(scroller().scrollTop, 0);
    assert.deepEqual(cascade(), { from: 0, steps: 14, rest: 16 });
    assert.equal(rows().filter((row) => row.hasAttribute("data-enter")).length, 0);
    assert.notEqual(document.querySelector("tbody"), firstBody);

    // The same answer delivered again while that cascade is still running starts over on rows
    // that are new, so nothing is left half-way and nothing is shown whole first.
    const running = rows();
    await render({ items: [item("search", "two", 30)], delivery: { id: 3, top: 0, left: 0 } });
    assert.ok(rows().every((row) => !running.includes(row)));
    assert.deepEqual(cascade(), { from: 0, steps: 14, rest: 16 });
    await settle();
    // The cascade that was cut short took its own marks with it and left the new one's alone.
    assert.deepEqual(cascade(), { from: -1, steps: 0, rest: 0 });

    // A collection opened from the candidates and going back to the previous results are
    // deliveries without any loading state at all. Going back returns to where the list was
    // left, and the cascade starts on the first row in view there, not on rows out of sight.
    await render({ items: [item("search", "one", 40)], delivery: { id: 4, top: 10 * ROW + 18, left: 0 } });
    assert.equal(scroller().scrollTop, 10 * ROW + 18);
    assert.deepEqual(cascade(), { from: 10, steps: 14, rest: 16 });
    assert.equal(marks()[9], null);
    await settle();

    // The pane goes away (the local list is shown) and comes back: its list is presented again,
    // from the row that is in view, and keeps its place. Nothing happens while it is away.
    await render({ paneShown: false });
    assert.deepEqual(cascade(), { from: -1, steps: 0, rest: 0 });
    await render({ paneShown: true });
    assert.equal(scroller().scrollTop, 10 * ROW + 18);
    assert.deepEqual(cascade(), { from: 10, steps: 14, rest: 16 });
    // Shown again before the last cascade is over: it starts over (the pane was not rendered
    // in between, so the browser starts the animations afresh).
    await render({ paneShown: false });
    await render({ paneShown: true });
    assert.deepEqual(cascade(), { from: 10, steps: 14, rest: 16 });
    await settle();
    assert.deepEqual(cascade(), { from: -1, steps: 0, rest: 0 });

    // Rows of a package opened again slot in on their own, once: the mark the row puts on
    // itself comes off when its animation ends, so showing the pane again cannot replay it.
    await render({ items: [item("search", "a", 3), item("search", "b", 3)], delivery: { id: 5, top: 0, left: 0 } });
    assert.equal(rows().filter((row) => row.hasAttribute("data-enter")).length, 0);
    await settle();
    await render({ collapsedItems: new Set([0]) });
    // The package folds away in its own time (searchMotion.ts) before its rows are gone.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    await render({ collapsedItems: new Set() });
    const late = rows().filter((row) => row.getAttribute("data-enter") === "late");
    assert.equal(late.length, 3);
    assert.deepEqual(cascade(), { from: -1, steps: 0, rest: 0 });
    await act(async () => {
      // A cover inside the row finishing its own animation is not the row's gesture.
      late[0].querySelector("td")!.dispatchEvent(new dom.window.Event("animationend", { bubbles: true }));
    });
    assert.equal(late[0].getAttribute("data-enter"), "late");
    await act(async () => {
      late[0].dispatchEvent(new dom.window.Event("animationend", { bubbles: true }));
      late[1].dispatchEvent(new dom.window.Event("animationcancel", { bubbles: true }));
    });
    assert.deepEqual(late.map((row) => row.getAttribute("data-enter")), [null, null, "late"]);

    // —— B: one growing list ——
    // A playlist of 120 opens with its first 50 rows and a foot that holds room for more.
    asked = 0;
    await render({ items: [item("playlist", "p", 120)], delivery: { id: 6, top: 0, left: 0 }, collapsedItems: new Set(),
      collectionShown: 50, hasMoreRows: true });
    assert.equal(rows().length, 50);
    assert.deepEqual(cascade(), { from: 0, steps: 14, rest: 36 });
    const foot = () => document.querySelector(".kd-result-more");
    assert.ok(foot());
    assert.equal(foot()!.querySelector("svg"), null);
    assert.equal(asked, 0);
    await settle();

    // Scrolling inside the list asks for nothing until its end is in reach.
    await scrollTo(600);
    assert.equal(asked, 0);
    const end = HEAD + 50 * ROW + 44 - paneHeight;
    await scrollTo(end - 40);
    assert.equal(asked, 1);

    // While the batch is fetched a ring turns at the foot; nothing else is asked for.
    await render({ loadingMoreRows: true });
    assert.ok(foot()!.querySelector("svg.kd-spin"));
    assert.equal(foot()!.getAttribute("role"), "status");
    await scrollTo(end);
    assert.equal(asked, 1);

    // The fetch fails: the list is as it was, the ring is gone, and the batch is not asked for
    // again by itself — not even when the notice about it resizes the pane. The user's next
    // scroll asks again, and so does a turn of the wheel at the very end, where nothing scrolls.
    await render({ loadingMoreRows: false });
    assert.equal(foot()!.querySelector("svg"), null);
    await act(async () => { for (const notify of [...resizeObservers]) notify(); });
    assert.equal(asked, 1);
    assert.equal(rows().length, 50);
    await act(async () => {
      scroller().dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -40 }));
    });
    assert.equal(asked, 1);
    await act(async () => {
      scroller().dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: 40 }));
    });
    assert.equal(asked, 2);
    await render({ loadingMoreRows: true });
    await render({ loadingMoreRows: false });
    await scrollTo(end - 10);
    assert.equal(asked, 3);

    // The batch lands: the rows that were there are the same rows and do not move, the scroll
    // position is kept, and only the new rows arrive, one after another.
    const before = rows();
    await render({ collectionShown: 100 });
    const after = rows();
    assert.equal(after.length, 100);
    assert.ok(before.every((row, index) => after[index] === row));
    assert.equal(scroller().scrollTop, end - 10);
    assert.ok(marks().slice(0, 50).every((mark) => mark === null));
    assert.deepEqual(cascade(), { from: 50, steps: 14, rest: 36 });
    assert.equal(after.filter((row) => row.hasAttribute("data-enter")).length, 0);
    // The end is out of reach again, so no further batch is asked for.
    assert.equal(asked, 3);
    await settle();
    assert.deepEqual(cascade(), { from: -1, steps: 0, rest: 0 });

    // The last batch: the list is whole and the foot is gone.
    await scrollTo(HEAD + 100 * ROW + 44 - paneHeight);
    assert.equal(asked, 4);
    await render({ collectionShown: 120, hasMoreRows: false });
    assert.equal(rows().length, 120);
    assert.deepEqual(cascade(), { from: 100, steps: 14, rest: 6 });
    assert.equal(foot(), null);
    await scrollTo(HEAD + 120 * ROW - paneHeight);
    assert.equal(asked, 4);
    await settle();

    // A first batch that does not fill a tall pane asks for the next one without a scroll, and
    // goes on until the pane is full.
    asked = 0;
    paneHeight = 2400;
    await render({ items: [item("album", "tall", 160)], delivery: { id: 7, top: 0, left: 0 }, collectionShown: 50,
      hasMoreRows: true });
    assert.equal(asked, 1);
    await render({ collectionShown: 100 });
    assert.equal(asked, 1);
    assert.equal(rows().length, 100);
    // The window is made taller than the list: no scroll can happen, so the resize asks.
    paneHeight = 4800;
    await act(async () => { for (const notify of [...resizeObservers]) notify(); });
    assert.equal(asked, 2);
    paneHeight = 720;

    // A hidden pane never asks: it has no size, and its list is not being read.
    asked = 0;
    await render({ paneShown: false });
    await scrollTo(999999);
    assert.equal(asked, 0);
    await render({ paneShown: true });

    // Nothing below a partly shown collection is there yet, so a batch is always added at the
    // very end of the table.
    await render({ items: [item("playlist", "x", 70), item("search", "words", 4), item("album", "y", 30)],
      delivery: { id: 8, top: 0, left: 0 }, collectionShown: 50, hasMoreRows: true });
    assert.equal(rows().length, 50);
    await settle();
    const head = rows();
    await render({ collectionShown: 100, hasMoreRows: false });
    // 70 + the package (its head row and 4 results) + 30.
    assert.equal(rows().length, 70 + 5 + 30);
    assert.ok(head.every((row, index) => rows()[index] === row));
    assert.equal(cascade().from, 50);
    // Taking the table away ends what is running: no timer is left behind.
    await act(async () => root.unmount());
    assert.equal(arrivalTimers.size, 0);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});
