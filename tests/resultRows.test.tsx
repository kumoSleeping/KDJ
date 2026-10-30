import assert from "node:assert/strict";
import test from "node:test";
import { createElement, act, useState } from "react";
import type { IntakeItem, MergedGroup, SongSource } from "../src/types";
import { layoutOf, setUpDom } from "./rowSelectionDom";

test("the result table: the same picking, and the download key in the first data column", async () => {
  const { dom, flush, click, key, menuItem, mouse } = setUpDom();
  const source = (platform: SongSource["platform"], id: string): SongSource => ({ platform, key: id, title: `Song ${id}`,
    artists: ["Artist"], album: "Album", duration: 200, cover: "", max_quality: "320", vip: false, payload: {} });
  const group = (id: string, sources: SongSource[]): MergedGroup => ({ group_id: id, title: `Song ${id}`, artists: ["Artist"],
    album: "Album", duration: 200, cover: "", sources, best_source_index: 0, score: 1 });
  const items: IntakeItem[] = [{ entry: "song", kind: "search", platform: null, title: "song", collections: [], errors: {}, error: "",
    groups: [
      group("a", [source("wyy", "1")]),
      group("b", [source("wyy", "2"), source("qqm", "2q")]),
      group("c", [source("qqm", "3")]),
      // Already in the library and nowhere else: it cannot be downloaded, so it cannot be picked.
      group("local", [source("local", "9")]),
      group("d", [source("wyy", "4")]),
      group("e", [source("wyy", "5")]),
    ] }];
  const { createRoot } = await import("react-dom/client");
  const { ResultTable, selectableGroups, selectionKey } = await import("../src/components/download/ResultTable");
  const { RESULT_COLUMN_PREFS_KEY } = await import("../src/components/download/resultColumns");
  const { TOSS_ITEM_ATTR } = await import("../src/lib/downloadToss");
  const root = createRoot(document.getElementById("root")!);
  const seen = { chosen: new Set<string>(), mode: false, inspected: [] as string[], downloaded: [] as string[], batches: 0 };
  // The workspace's part: it owns what is picked and whether picking was asked for.
  function Host() {
    const [chosen, setChosen] = useState(new Set<string>());
    const [mode, setMode] = useState(false);
    const [inspected, setInspected] = useState<string | null>(null);
    seen.chosen = chosen; seen.mode = mode;
    const all = selectableGroups(items[0]).map(entry => selectionKey(0, entry.group_id));
    return createElement(ResultTable, {
      items, video: null, loading: false, searched: true,
      selected: chosen, selectionMode: mode, onSelectionModeChange: setMode,
      expandedGroups: new Set<string>(), collapsedItems: new Set<number>(), sourceIndex: {},
      inspectedGroup: inspected, delivery: { id: 1, top: 0, left: 0 }, paneShown: true, collectionShown: 50, hasMoreRows: false, loadingMoreRows: false, onShowMoreRows() {},
      onToggleSelect: (entry: string) => setChosen(current => {
        const next = new Set(current);
        if (!next.delete(entry)) next.add(entry);
        return next;
      }),
      onToggleExpand() {}, onPickSource() {}, onToggleItem() {}, onToggleItemAll() {},
      onToggleAll: () => setChosen(current => current.size >= all.length ? new Set() : new Set(all)),
      onDownloadGroup: (entry: MergedGroup) => { seen.downloaded.push(entry.group_id); },
      onDownloadSelected: () => { seen.batches += 1; },
      onInspectGroup: (_entry: MergedGroup, _index: number, entryKey: string) => { seen.inspected.push(entryKey); setInspected(entryKey); },
      onLoadCollection() {}, loadingCollections: new Set<string>(),
    });
  }
  const row = (id: string) => [...document.querySelectorAll<HTMLElement>(".kd-list-row[data-kd-search-result]")]
    .find(candidate => candidate.getAttribute("aria-label")?.startsWith(`Song ${id}，`))!;
  const marks = () => document.querySelectorAll('.kd-list-body [role="checkbox"]');
  const head = () => document.querySelector<HTMLElement>('.kd-list-head [role="checkbox"]');
  const picked = () => [...seen.chosen].sort();
  const keyCell = () => document.querySelector(".kd-result-key")?.closest(".kd-list-cell")?.getAttribute("data-col");
  try {
    await act(async () => root.render(createElement(Host)));
    await flush();
    const table = document.querySelector(".kd-list")!;
    const idle = layoutOf(table);
    assert.equal(marks().length, 0);
    assert.equal(head(), null);
    assert.equal(table.querySelector("input[type=checkbox]"), null, "no form check box anywhere in the list");
    assert.equal(document.querySelector("table, tbody, tr, td"), null, "the results are a row list, not a table");

    // The download key: in the first data column (the title), never in the index cell.
    assert.equal(row("a").querySelector(".kd-result-lead")?.textContent, "1", "the number stays a number");
    assert.equal(row("a").querySelector(".kd-result-lead button"), null);
    assert.equal(keyCell(), "title");
    assert.equal(document.querySelectorAll(".kd-result-key").length, 5, "one per row that can be downloaded");
    assert.equal(row("local").querySelector(".kd-result-key"), null);
    // It lies beside the title's text; the sources chevron is outside what the key may cover.
    const keyed = row("b").querySelector(".kd-result-keyed")!;
    assert.ok(keyed.querySelector(".kd-result-title-text.kd-result-keyed-body"));
    assert.equal(keyed.querySelector(".kd-result-source-toggle"), null);
    assert.ok(row("b").querySelector(".kd-result-title > .kd-result-source-toggle"));
    await click(row("c").querySelector(".kd-result-key")!);
    assert.deepEqual(seen.downloaded, ["c"]);
    assert.deepEqual(seen.inspected, [], "the key does not open the row");
    // What a batch download knows each row by.
    assert.equal(row("b").getAttribute(TOSS_ITEM_ATTR), "wyy:2");
    assert.equal(row("local").getAttribute(TOSS_ITEM_ATTR), null);

    // A plain click opens a row; it picks nothing.
    await click(row("a"));
    assert.deepEqual(seen.inspected, ["0:a"]);
    assert.equal(marks().length, 0);
    assert.equal(row("a").getAttribute("aria-selected"), "true");

    // ⌘/Ctrl-click starts the picking: marks in the index cells, no column, no download key.
    await click(row("b"), { metaKey: true });
    assert.deepEqual(picked(), ["0:b"]);
    assert.equal(marks().length, 5, "every row that can be downloaded has a mark");
    assert.equal(row("local").querySelector('[role="checkbox"]'), null);
    assert.equal(row("local").querySelector(".kd-result-lead")?.textContent, "4", "a row that cannot be picked keeps its number");
    assert.equal(layoutOf(table), idle, "no column is added and none changes width");
    assert.equal(document.querySelectorAll(".kd-result-key").length, 0, "no download key while rows are being picked");
    assert.equal(head()?.getAttribute("aria-checked"), "mixed");
    assert.equal(row("b").getAttribute("aria-selected"), "true");
    // The open row is not a picked row: it is told apart by its own mark on the row.
    assert.equal(row("a").getAttribute("aria-selected"), "false");
    assert.equal(row("a").getAttribute("data-inspected"), "true");

    // A plain click now picks or drops; nothing is opened.
    await click(row("d").querySelector('.kd-list-cell[data-col="artist"]')!);
    assert.deepEqual(picked(), ["0:b", "0:d"]);
    await click(row("d"));
    assert.deepEqual(picked(), ["0:b"]);
    assert.deepEqual(seen.inspected, ["0:a"]);
    // A row that cannot be downloaded is not picked by a click.
    await click(row("local"));
    assert.deepEqual(picked(), ["0:b"]);
    // Shift-click: the run from the row touched last (d), skipping what cannot be picked.
    await click(row("b"), { shiftKey: true });
    assert.deepEqual(picked(), ["0:b", "0:c", "0:d"]);
    // A picked row drags the whole pick (to the downloads key, a folder or the queue); letting go picks nothing.
    const { activeSearchDrag } = await import("../src/lib/searchDrag");
    document.elementFromPoint = () => null;
    const pointer = (type: string, x: number) => {
      const event = mouse(type, { clientX: x, clientY: 10, button: 0 });
      Object.defineProperties(event, { pointerId: { value: 3 }, pointerType: { value: "mouse" } });
      return event;
    };
    let dragged: string[] = [];
    await act(async () => {
      row("d").dispatchEvent(pointer("pointerdown", 100));
      window.dispatchEvent(pointer("pointermove", 140));
      const payload = activeSearchDrag();
      dragged = payload?.kind === "audio" ? payload.sources.map(entry => `${entry.platform}:${entry.key}`) : [];
      window.dispatchEvent(pointer("pointerup", 140));
    });
    assert.deepEqual(dragged, ["wyy:2", "qqm:3", "wyy:4"]);
    await click(row("d"));
    assert.deepEqual(picked(), ["0:b", "0:c", "0:d"], "the click that ends a drag does not drop the row");
    // Enter / Space on a focused row pick it too.
    await key(" ", row("e"));
    assert.deepEqual(picked(), ["0:b", "0:c", "0:d", "0:e"]);
    await key("Enter", row("e"));
    assert.deepEqual(picked(), ["0:b", "0:c", "0:d"]);
    // A double click is two picks and opens nothing.
    await click(row("e"));
    await click(row("e"), { detail: 2 });
    await act(async () => { row("e").dispatchEvent(mouse("dblclick", { detail: 2 })); });
    assert.deepEqual(picked(), ["0:b", "0:c", "0:d"]);
    assert.deepEqual(seen.inspected, ["0:a"]);

    // The head's mark picks all and drops all, and stays in the mode.
    await click(head()!);
    assert.deepEqual(picked(), ["0:a", "0:b", "0:c", "0:d", "0:e"]);
    assert.equal(head()?.getAttribute("aria-checked"), "true");
    await click(head()!);
    assert.deepEqual(picked(), []);
    assert.equal(seen.mode, true);
    assert.equal(marks().length, 5);
    assert.equal(head()?.getAttribute("aria-checked"), "false");

    // Esc leaves; the numbers and the keys are back and nothing has moved.
    await click(row("c"));
    await key("Escape");
    assert.deepEqual(picked(), []);
    assert.equal(seen.mode, false);
    assert.equal(marks().length, 0);
    assert.equal(layoutOf(table), idle);
    assert.equal(document.querySelectorAll(".kd-result-key").length, 5);

    // Shift-click with nothing picked takes the run from the row that was opened last.
    await click(row("c"));
    assert.deepEqual(seen.inspected, ["0:a", "0:c"]);
    await click(row("e"), { shiftKey: true });
    assert.deepEqual(picked(), ["0:c", "0:d", "0:e"]);
    await key("Escape");

    // The row menu's 选择 asks for the mode and picks its row.
    await act(async () => { row("d").dispatchEvent(mouse("contextmenu", { clientX: 200, clientY: 200 })); });
    await click(menuItem("选择")!);
    assert.equal(seen.mode, true);
    assert.deepEqual(picked(), ["0:d"]);
    await key("Escape");

    // Another column put first carries the key instead of the title.
    await act(async () => root.unmount());
    localStorage.setItem(RESULT_COLUMN_PREFS_KEY, JSON.stringify({ order: ["artist", "title"], hidden: [], widths: {} }));
    const second = createRoot(document.getElementById("root")!);
    await act(async () => second.render(createElement(Host)));
    await flush();
    assert.equal(keyCell(), "artist");
    assert.equal(document.querySelector('.kd-list-cell[data-col="title"] .kd-result-key'), null);
    assert.equal(row("a").querySelector('.kd-list-cell[data-col="artist"] .kd-result-keyed-body')?.textContent, "Artist");
    await act(async () => second.unmount());
    localStorage.clear();

    // A batch of several entries: each package has its own mark for all / some / none of its rows.
    const batch: IntakeItem[] = [
      { ...items[0], entry: "one", title: "one", groups: items[0].groups.slice(0, 3) },
      { ...items[0], entry: "two", title: "two", groups: items[0].groups.slice(3) },
    ];
    const toggledPackages: number[] = [];
    function BatchHost({ chosen, mode }: { chosen: string[]; mode: boolean }) {
      return createElement(ResultTable, {
        items: batch, video: null, loading: false, searched: true,
        selected: new Set(chosen), selectionMode: mode, onSelectionModeChange() {},
        expandedGroups: new Set<string>(), collapsedItems: new Set<number>(), sourceIndex: {},
        inspectedGroup: null, delivery: { id: 1, top: 0, left: 0 }, paneShown: true, collectionShown: 50, hasMoreRows: false, loadingMoreRows: false, onShowMoreRows() {},
        onToggleSelect() {}, onToggleExpand() {}, onPickSource() {}, onToggleItem() {},
        onToggleItemAll: (index: number) => { toggledPackages.push(index); },
        onToggleAll() {}, onDownloadGroup() {}, onDownloadSelected() {}, onInspectGroup() {},
        onLoadCollection() {}, loadingCollections: new Set<string>(),
      });
    }
    const third = createRoot(document.getElementById("root")!);
    const packageMarks = () => [...document.querySelectorAll<HTMLElement>('.kd-list-row[data-tree="parent"] [role="checkbox"]')];
    await act(async () => third.render(createElement(BatchHost, { chosen: [], mode: false })));
    await flush();
    const batchIdle = layoutOf(document.querySelector(".kd-list")!);
    assert.equal(packageMarks().length, 0);
    await act(async () => third.render(createElement(BatchHost, { chosen: ["0:a", "0:b", "0:c", "1:d"], mode: false })));
    assert.deepEqual(packageMarks().map(mark => mark.getAttribute("aria-checked")), ["true", "mixed"]);
    assert.equal(packageMarks()[1].getAttribute("aria-label"), "选择「two」全部曲目");
    assert.equal(layoutOf(document.querySelector(".kd-list")!), batchIdle, "the package's mark takes the empty slot before its chevron");
    // The package's mark picks its rows; it does not fold the package.
    await click(packageMarks()[1]);
    assert.deepEqual(toggledPackages, [1]);
    assert.equal(document.querySelectorAll(".kd-list-row[data-kd-search-result]").length, 6);
    await act(async () => third.unmount());
  } finally {
    localStorage.clear();
    dom.window.close();
  }
});
