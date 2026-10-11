import assert from "node:assert/strict";
import test from "node:test";
import { createElement, act } from "react";
import type { TrackSummary } from "../src/types";
import { layoutOf, setUpDom } from "./rowSelectionDom";

test("the library table: picking rows opens no column, a plain click picks, the head's mark picks all", async () => {
  const { dom, flush, click, key, menuItem, mouse } = setUpDom();
  const makeRow = (id: number): TrackSummary => ({ id, path: `/library/${id}.mp3`, filename: `${id}.mp3`,
    title: `Song ${id}`, artist: "Artist", album: "Album", format: "mp3", size: 1000,
    camelot: "8A", modified_at: "a", duration: 100, rating: 0, bpm: 128,
    file_created_at: id, analyzed_at: "now",
    // Song 3 was downloaded from SoundCloud: the library keeps its URN, not its page.
    source_platform: id === 3 ? "soundcloud" : "local", source_key: id === 3 ? "soundcloud:tracks:777" : "" } as TrackSummary);
  const ids = Array.from({ length: 30 }, (_, index) => index + 1);
  const resolved: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/library/tracks/index") return Response.json({ track_ids: ids, total: ids.length });
    if (url.pathname === "/api/library/tracks/summaries") {
      return Response.json((JSON.parse(String(init?.body)).track_ids as number[]).map(makeRow));
    }
    const detail = url.pathname.match(/^\/api\/library\/tracks\/(\d+)$/);
    if (detail) return Response.json({ ...makeRow(Number(detail[1])), tags: [] });
    if (url.pathname === "/api/resolve") {
      resolved.push(JSON.parse(String(init?.body)).url);
      return Response.json({ kind: "song", platform: "soundcloud", title: "Song 3", sources: [{
        platform: "soundcloud", key: "soundcloud:tracks:777", title: "Song 3", artists: ["Artist"], album: "", duration: 100,
        cover: "", max_quality: null, vip: false, payload: { permalink_url: "https://soundcloud.com/artist/song-3" } }] });
    }
    if (url.pathname === "/api/library/stats") return Response.json(null);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const { createRoot } = await import("react-dom/client");
  const { useLibraryStore } = await import("../src/stores/libraryStore");
  const { TrackTable } = await import("../src/components/library/TrackTable");
  const root = createRoot(document.getElementById("root")!);
  function Host() {
    const total = useLibraryStore(state => state.total);
    const loading = useLibraryStore(state => state.loading);
    const selectedId = useLibraryStore(state => state.selectedId);
    const selectedIds = useLibraryStore(state => state.selectedIds);
    return createElement(TrackTable, { total, loading, selectedId, selectedIds, layout: "wide", shortcutActive: true,
      sort: "file_created_at", order: "desc", sort2: null, order2: "asc",
      onSelect: useLibraryStore.getState().select, onSort() {} });
  }
  const state = () => useLibraryStore.getState();
  const row = (id: number) => document.querySelector<HTMLElement>(`.kd-list-row[data-kd-track-id="${id}"]`)!;
  const marks = () => document.querySelectorAll('.kd-list-row[data-kd-track-id] [role="checkbox"]');
  const head = () => document.querySelector<HTMLElement>('.kd-list-head [role="checkbox"]');
  try {
    await act(async () => {
      await state().refresh();
      root.render(createElement(Host));
    });
    await flush(); await flush();
    const table = document.querySelector(".kd-list")!;
    const rows = document.querySelectorAll(".kd-list-row[data-kd-track-id]").length;
    assert.equal(rows, 30);
    const idle = layoutOf(table);
    assert.equal(marks().length, 0, "no mark while nothing is being picked");
    assert.equal(head(), null);
    assert.equal(row(2).querySelector('.kd-list-cell[data-col="index"]')?.textContent, "2");

    // A plain click selects one row: that is the current row, not a batch.
    await click(row(2));
    assert.deepEqual(state().selectedIds, [2]);
    assert.equal(marks().length, 0);

    // ⌘/Ctrl-click starts a batch: every row shows the mark in its index cell, nothing else changes.
    await click(row(5), { metaKey: true });
    assert.deepEqual(state().selectedIds, [2, 5]);
    assert.equal(marks().length, rows, "one mark per row");
    assert.equal(layoutOf(table), idle, "no column is added and none changes width");
    assert.equal(row(5).querySelector('.kd-list-cell[data-col="index"] [role="checkbox"]')?.getAttribute("aria-checked"), "true");
    assert.equal(row(6).querySelector('.kd-list-cell[data-col="index"] [role="checkbox"]')?.getAttribute("aria-checked"), "false");
    assert.equal(row(5).querySelector('.kd-list-cell[data-col="title"] [role="checkbox"], .kd-list-cell[data-col="title"] input'), null, "nothing is put in front of the title");
    assert.equal(row(5).getAttribute("aria-selected"), "true");
    assert.equal(row(6).getAttribute("data-selecting"), "true");
    assert.equal(head()?.getAttribute("aria-checked"), "mixed");
    assert.equal(head()?.getAttribute("aria-label"), "全选");
    // The number is still there under the mark (it only steps back), so the cell keeps its size.
    assert.equal(row(6).querySelector(".kd-row-number")?.textContent, "6");

    // A plain click anywhere on a row picks it or drops it; it replaces nothing and plays nothing.
    await click(row(8).querySelector('.kd-list-cell[data-col="artist"]')!);
    assert.deepEqual(state().selectedIds, [2, 5, 8]);
    await click(row(5).querySelector('.kd-list-cell[data-col="title"]')!);
    assert.deepEqual(state().selectedIds, [2, 8]);
    // Shift-click takes the run from the row touched last; what was picked stays picked.
    await click(row(12), { shiftKey: true });
    assert.deepEqual(state().selectedIds, [2, 8, 9, 10, 11, 12]);
    // A batch that was never asked for ends when it is down to the one current row.
    await key("Escape");
    await click(row(2));
    await click(row(5), { metaKey: true });
    await click(row(5));
    assert.deepEqual(state().selectedIds, [2]);
    assert.equal(marks().length, 0);
    await click(row(8), { metaKey: true });
    await click(row(9), { shiftKey: true });
    assert.deepEqual(state().selectedIds, [2, 8, 9]);
    // The mark itself is a control with a name; a click on it is one pick, not two.
    const mark = row(15).querySelector<HTMLElement>('[role="checkbox"]')!;
    assert.equal(mark.getAttribute("aria-label"), "选择 Song 15");
    await click(mark);
    assert.ok(state().selectedIds.includes(15));
    await click(mark);
    assert.ok(!state().selectedIds.includes(15));
    // A double click is two picks and never playback.
    const { getPlayingTrack } = await import("../src/lib/playingTrack");
    await click(row(20));
    await click(row(20), { detail: 2 });
    await act(async () => { row(20).dispatchEvent(mouse("dblclick", { detail: 2 })); });
    assert.ok(!state().selectedIds.includes(20));
    assert.equal(getPlayingTrack(), null);

    // The head's mark: all, then none — and it stays in the mode with nothing picked.
    await click(head()!);
    assert.equal(state().selectedIds.length, 30);
    assert.equal(head()?.getAttribute("aria-checked"), "true");
    await click(head()!);
    assert.equal(state().selectedIds.length, 0);
    assert.equal(marks().length, rows);
    assert.equal(head()?.getAttribute("aria-checked"), "false");
    await click(row(4));
    assert.deepEqual(state().selectedIds, [4]);
    assert.equal(marks().length, rows, "one picked row in the mode is still a batch");

    // Esc leaves: the marks go, the numbers are back, nothing has moved.
    await key("Escape");
    assert.equal(state().selectionMode, false);
    assert.deepEqual(state().selectedIds, []);
    assert.equal(marks().length, 0);
    assert.equal(head(), null);
    assert.equal(layoutOf(table), idle);

    // The row menu: 选择 starts a batch with that row alone; the analysis items are gone.
    await click(row(2));
    await act(async () => { row(7).dispatchEvent(mouse("contextmenu", { clientX: 200, clientY: 200 })); });
    const items = [...document.querySelectorAll(".kd-context-menu button")].map(button => button.textContent?.trim() ?? "");
    assert.ok(items.includes("选择"));
    assert.ok(!items.some(text => text.includes("重新分析") || text.includes("BPM V4")), items.join(" | "));
    assert.ok(!items.some(text => text.includes("分享")), "a file without a source has nothing to share");
    await click(menuItem("选择")!);
    assert.equal(state().selectionMode, true);
    assert.deepEqual(state().selectedIds, [7], "the row that was merely current is not part of the batch");
    assert.equal(marks().length, rows);
    await key("Escape");

    // A SoundCloud download can be shared: its page is looked up by the stored id.
    await act(async () => { row(3).dispatchEvent(mouse("contextmenu", { clientX: 200, clientY: 200 })); });
    await flush(); await flush();
    assert.deepEqual(resolved, ["https://api.soundcloud.com/tracks/777"]);
    const share = menuItem("复制分享内容");
    assert.ok(share && !share.disabled);
    await key("Escape", document.querySelector(".kd-context-menu")!);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
