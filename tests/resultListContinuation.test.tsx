import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { IntakeItem, SongSource } from "../src/types";

test("collection batches append without replacing rows; selection and the first-column download stay independent", async () => {
  const dom = new JSDOM("<body><div id='root'></div></body>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, HTMLTableRowElement: dom.window.HTMLTableRowElement,
    CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true });
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { ResultTable } = await import("../src/components/download/ResultTable");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const item: IntakeItem = { entry: "qqm:playlist:1", kind: "playlist", platform: "qqm", title: "Playlist", collections: [], errors: {}, error: "",
    groups: Array.from({ length: 230 }, (_, i) => ({ group_id: String(i), title: `Song ${i}`, artists: ["Artist"], album: "Album", duration: 100, cover: "", best_source_index: 0, score: 0,
      sources: [{ platform: "qqm", key: String(i), title: `Song ${i}`, artists: ["Artist"], album: "Album", duration: 100, cover: "", payload: {} } as SongSource] })) };
  let selected = "", downloads = 0;
  const props = { items: [item], video: null, loading: false, searched: true, layout: "wide" as const,
    selected: new Set<string>(), selectionMode: false, onSelectionModeChange() {}, expandedGroups: new Set<string>(),
    collapsedItems: new Set<number>(), sourceIndex: {}, inspectedGroup: null, collectionPage: 1,
    onToggleSelect(key: string) { selected = key; }, onToggleExpand() {}, onPickSource() {}, onToggleItem() {}, onToggleItemAll() {},
    onToggleAll() {}, onDownloadGroup() { downloads++; }, onDownloadSelected() {}, onInspectGroup() {}, onLoadCollection() {}, loadingCollections: new Set<string>() };
  const rows = () => [...document.querySelectorAll<HTMLTableRowElement>('tr[data-kd-search-result]')];
  try {
    await act(async () => root.render(createElement(ResultTable, props)));
    assert.equal(rows().length, 50);
    const first = rows()[0];
    assert.equal(first.querySelector('[data-col="index"] button'), null);
    const firstCell = first.querySelector('.kd-result-first-cell')!;
    assert.equal(firstCell.getAttribute("data-col"), "title");
    await act(async () => (firstCell.querySelector('button[aria-label*="加入下载队列"]') as HTMLButtonElement).click());
    assert.equal(downloads, 1);
    assert.equal(selected, "", "a download click does not change the selection");
    await act(async () => root.render(createElement(ResultTable, { ...props, collectionPage: 2 })));
    assert.equal(rows().length, 100);
    assert.equal(rows()[0], first, "the first page keeps its actual DOM rows and scroll anchors");
    await act(async () => root.render(createElement(ResultTable, { ...props, collectionPage: 2, selectionMode: true })));
    await act(async () => first.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.ok(selected, "plain clicks select once selection mode is entered");
    assert.equal(rows()[0], first);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
