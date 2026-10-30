import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement, act } from "react";
import type { ResultTableProps } from "../src/components/download/ResultTable";
import type { IntakeItem, MergedGroup, SongSource } from "../src/types";

const ROW = 36;
const HEAD = 28;
const BOX = 720;

const source = (key: string): SongSource => ({ platform: "wyy", key, title: key, artists: ["a"], album: "",
  duration: 100, cover: "", max_quality: null, vip: false, payload: {} });
const group = (id: string): MergedGroup => ({ group_id: id, title: id, artists: ["a"], album: "", duration: 100,
  cover: "", sources: [source(id)], best_source_index: 0, score: 1 });
const playlist = (rows: number): IntakeItem => ({ entry: "p", kind: "playlist", platform: null, title: "p",
  groups: Array.from({ length: rows }, (_, index) => group(`p-${index}`)), collections: [], errors: {}, error: "" });

test("the result list in WebKit scrolls itself: it takes the wheel, keeps the blocks around the viewport, and grows under a gesture", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  // The macOS WebView: the engine in which a list scrolls itself.
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)" } });
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia;
  const proto = dom.window.HTMLElement.prototype;
  const heightOf = (element: HTMLElement): number => element.classList.contains("kd-scroll") ? BOX
    : element.classList.contains("kd-list-row") ? ROW
    : element.classList.contains("kd-list-head") ? HEAD
    : element.classList.contains("kd-list-block") ? element.querySelectorAll(".kd-list-row").length * ROW : 0;
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get(this: HTMLElement) { return heightOf(this); } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 1000; } });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return BOX; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return 1000; } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get(this: HTMLElement) {
    const body = this.querySelector<HTMLElement>(".kd-list-body");
    const rows = body ? (parseFloat(body.style.paddingTop) || 0) + body.querySelectorAll(".kd-list-row").length * ROW + (parseFloat(body.style.paddingBottom) || 0) : 0;
    return (this.querySelector(".kd-list-head") ? HEAD : 0) + rows + (this.querySelector(".kd-result-more") ? 44 : 0);
  } });
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get() { return 1000; } });
  proto.getBoundingClientRect = function () {
    const height = heightOf(this) || BOX;
    return { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: height, width: 1000, height, toJSON() {} };
  };

  const { createRoot } = await import("react-dom/client");
  const { ResultTable } = await import("../src/components/download/ResultTable");
  const root = createRoot(document.getElementById("root")!);
  const noop = () => {};
  let asked = 0;
  let props: ResultTableProps = {
    items: [playlist(120)], video: null, loading: false, searched: true, delivery: { id: 1, top: 0, left: 0 }, paneShown: true,
    selected: new Set(), selectionMode: false, onSelectionModeChange: noop,
    expandedGroups: new Set(), collapsedItems: new Set(), sourceIndex: {}, inspectedGroup: null,
    collectionShown: 50, hasMoreRows: true, loadingMoreRows: false, onShowMoreRows: () => { asked += 1; },
    onToggleSelect: noop, onToggleExpand: noop, onPickSource: noop, onToggleItem: noop, onToggleItemAll: noop,
    onToggleAll: noop, onDownloadGroup: noop, onDownloadSelected: noop, onInspectGroup: noop,
    onLoadCollection: noop, loadingCollections: new Set(),
  };
  const render = (patch: Partial<ResultTableProps>) => act(async () => {
    props = { ...props, ...patch };
    root.render(createElement("div", { className: "kd-scroll" }, createElement(ResultTable, props)));
  });
  const scroller = () => document.querySelector<HTMLElement>(".kd-scroll")!;
  const rows = () => [...document.querySelectorAll<HTMLElement>(".kd-list-row")];
  const title = (row: Element) => row.querySelector(".kd-result-title-text")?.textContent ?? "";
  const rowsOf = () => Number(document.querySelector(".kd-list")?.getAttribute("aria-rowcount") ?? 0);
  /** The scroll the page wrote reaches it back as a scroll event, and the rows for it are rendered there. */
  const scrolled = () => act(async () => { scroller().dispatchEvent(new dom.window.Event("scroll")); });
  try {
    await render({});
    await scrolled();
    // Never built whole: the blocks around the viewport, and padding for the rest.
    assert.equal(rowsOf(), 50);
    const window = rows().length;
    assert.ok(window >= 20 && window < 50, `a screen and a margin of rows, not the list: ${window}`);
    const body = document.querySelector<HTMLElement>(".kd-list-body")!;
    assert.equal(parseFloat(body.style.paddingTop), 0);
    assert.equal(parseFloat(body.style.paddingBottom), (50 - window) * ROW);
    assert.equal(title(rows()[0]), "p-0");

    // The list takes the wheel: the page moves it; the WebView does not.
    const wheel = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 900 });
    await act(async () => { rows()[3].dispatchEvent(wheel); });
    assert.equal(wheel.defaultPrevented, true);
    assert.equal(scroller().scrollTop, 900);
    await scrolled();
    const first = rows()[0];
    assert.ok(Number(title(first).slice(2)) > 0 && Number(title(first).slice(2)) <= 25, `the rows moved with the scroll (${title(first)})`);
    assert.ok(parseFloat(body.style.paddingTop) > 0, "what lies above is padding now");
    // A wheel over something that scrolls inside the list is left alone (none here); a pinch is.
    const pinch = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 50, ctrlKey: true });
    await act(async () => { rows()[3].dispatchEvent(pinch); });
    assert.equal(pinch.defaultPrevented, false);

    // The end of what is shown comes into reach under the gesture: the next batch is asked for,
    // lands while the wheel is still turning, and the blocks that were there stay the same nodes.
    const end = HEAD + 50 * ROW + 44 - BOX;
    const toEnd = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: end - 900 });
    await act(async () => { rows()[3].dispatchEvent(toEnd); });
    await scrolled();
    assert.equal(asked, 1);
    const before = rows();
    await render({ loadingMoreRows: true });
    await render({ loadingMoreRows: false, collectionShown: 100 });
    await act(async () => { rows()[3].dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 200 })); });
    await scrolled();
    assert.equal(rowsOf(), 100);
    assert.ok(before.every((row) => !row.isConnected || rows().includes(row)));
    assert.ok(rows().some((row) => Number(title(row).slice(2)) >= 50), "the new blocks are built as the scroll reaches them");
    assert.ok(rows().length < 100, "still only the blocks around the viewport");
  } finally {
    await act(async () => root.unmount());
    if (navigatorBefore) Object.defineProperty(globalThis, "navigator", navigatorBefore);
    dom.window.close();
  }
});
