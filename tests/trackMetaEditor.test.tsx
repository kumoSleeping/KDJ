import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement, act } from "react";
import type { Track } from "../src/types";

const makeTrack = (id: number): Track => ({ id, path: `/library/${id}.mp3`, filename: `${id}.mp3`,
  title: `Song ${id}`, artist: "Artist", album: "Album", genre: "House", year: "2021", comment: "",
  tags: ["vocal"], format: "mp3", size: 1000, duration: 100, bitrate: 320, samplerate: 44100, channels: 2,
  rating: 0, bpm: 128, camelot: "8A", modified_at: "a", file_created_at: id, added_at: "2024-01-01",
  analyzed_at: "now", source_platform: "local" } as unknown as Track);

test("placement: beside the panel on its roomier side, above the player bar, clamped", async () => {
  const { placeTrackMetaEditor } = await import("../src/lib/trackMetaEditor");
  const size = { width: 340, height: 500 };
  const viewport = { width: 1400, floor: 780 };
  // 曲目信息 docked bottom-right: the editor stands to its left and shares its bottom edge.
  assert.deepEqual(placeTrackMetaEditor({ rect: { left: 1080, top: 600, right: 1400, bottom: 780 } }, size, viewport),
    { left: 1080 - 8 - 340, top: 780 - 500 - 8 });
  // Docked bottom-left: to its right.
  assert.deepEqual(placeTrackMetaEditor({ rect: { left: 0, top: 600, right: 432, bottom: 780 } }, size, viewport),
    { left: 440, top: 272 });
  // A panel as wide as the window leaves no side: the editor stands above it.
  assert.deepEqual(placeTrackMetaEditor({ rect: { left: 0, top: 600, right: 500, bottom: 780 } }, size, { width: 500, floor: 780 }),
    { left: 8, top: 600 - 8 - 500 });
  // From a row menu: just off the pointer, below the row while that fits above the bar.
  assert.deepEqual(placeTrackMetaEditor({ x: 300, y: 100 }, size, viewport), { left: 308, top: 108 });
  // Near the bottom right it flips to the other side of the pointer and stays on screen.
  const corner = placeTrackMetaEditor({ x: 1390, y: 700 }, size, viewport);
  assert.deepEqual(corner, { left: 1390 - 8 - 340, top: 700 - 8 - 500 });
  assert.ok(corner.top + size.height <= viewport.floor, "never over the player bar");
});

test("the floating editor edits one track, writes only changed fields and holds an unsaved draft", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia;
  // JSDOM lays nothing out: give the window a size and the player bar a top edge (768 - 100).
  const bar = document.body.appendChild(document.createElement("div"));
  bar.className = "kd-player";
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const box = this.classList.contains("kd-player") ? { left: 0, top: 668, width: 1024, height: 100 }
      : this.classList.contains("kd-internal-window")
        ? { left: parseFloat(this.style.left) || 0, top: parseFloat(this.style.top) || 0, width: 340, height: 500 }
        : { left: 0, top: 0, width: 0, height: 0 };
    return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON() {} };
  };
  const records = new Map<number, Track>([[7, makeTrack(7)], [8, makeTrack(8)]]);
  const patches: { id: number; body: Record<string, unknown> }[] = [];
  let tagWriteError = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const detail = url.pathname.match(/^\/api\/library\/tracks\/(\d+)$/);
    if (detail) {
      const id = Number(detail[1]);
      const record = records.get(id);
      if (!record) return new Response("missing", { status: 404, statusText: "Not Found" });
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push({ id, body });
        const next = { ...record, ...body, modified_at: `${record.modified_at}+` } as Track;
        records.set(id, next);
        return Response.json(tagWriteError ? { ...next, tag_write_error: tagWriteError } : next);
      }
      return Response.json(record);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const { useTrackMetaEditor } = await import("../src/lib/trackMetaEditor");
  const { TrackMetaEditorHost } = await import("../src/components/library/TrackMetaEditor");
  const root = createRoot(document.getElementById("root")!);
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const editor = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="编辑 Meta"]');
  const field = (index: number) => editor()!.querySelectorAll<HTMLInputElement>("input.kd-input")[index];
  const button = (label: string) => [...editor()!.querySelectorAll("button")].find(item =>
    item.textContent?.trim() === label || item.getAttribute("aria-label") === label)!;
  const type = async (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const press = async (target: Element, key: string) => act(async () => {
    target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  const store = () => useTrackMetaEditor.getState();
  try {
    await act(async () => root.render(createElement(TrackMetaEditorHost)));
    assert.equal(editor(), null, "nothing is mounted until a track is asked for");
    assert.equal(store().open(-3), false, "an online track has no record to edit");
    assert.equal(editor(), null);

    await act(async () => { store().open(7, { x: 200, y: 200 }); });
    await settle();
    assert.ok(editor(), "the editor floats in the document, outside every panel");
    assert.equal(editor()!.parentElement, document.body);
    assert.equal(field(0).value, "Song 7");
    assert.equal(document.activeElement, field(0), "it opens on its first field");
    assert.deepEqual([editor()!.style.left, editor()!.style.top], ["208px", "160px"],
      "it opens off the pointer and is lifted clear of the player bar");
    assert.equal(store().dirty, false);

    await type(field(0), "Renamed");
    assert.equal(store().dirty, true);
    await act(async () => {
      assert.equal(store().open(8), false, "another track does not replace an unsaved draft");
    });
    assert.equal(store().trackId, 7);
    assert.equal(field(0).value, "Renamed");
    assert.match(editor()!.textContent ?? "", /还没保存/);

    await press(editor()!, "Escape");
    assert.ok(editor(), "Escape does not drop the draft");
    await act(async () => button("关闭 Meta 编辑").click());
    assert.ok(editor(), "nor does the close button");
    assert.equal(patches.length, 0);

    tagWriteError = "read-only file";
    await act(async () => button("保存").click());
    await settle();
    assert.deepEqual(patches, [{ id: 7, body: { title: "Renamed" } }], "only the changed field is written");
    assert.equal(store().dirty, false);
    assert.equal(field(0), undefined, "a save ends the edit");
    assert.match(editor()!.textContent ?? "", /已存进曲库，但文件标签没写成：read-only file/);
    assert.match(editor()!.textContent ?? "", /Renamed/, "the saved record is the one shown");

    tagWriteError = "";
    await act(async () => { store().open(7); });
    await settle();
    assert.equal(field(0).value, "Renamed", "asking again returns to the form, seeded from the saved record");
    await act(async () => button("保存").click());
    await settle();
    assert.equal(patches.length, 1, "an untouched form writes nothing");

    await act(async () => { assert.equal(store().open(8), true); });
    await settle();
    assert.equal(editor()!.querySelector(".kd-internal-window-head span")?.textContent, "Song 8");
    assert.equal(field(0).value, "Song 8");
    await press(field(0), "Escape");
    assert.ok(editor(), "Escape inside a field belongs to the field, even with nothing to lose");
    await type(field(1), "Someone");
    await act(async () => button("取消").click());
    assert.equal(store().dirty, false, "cancel discards the draft");
    assert.equal(patches.length, 1);

    await press(editor()!, "Escape");
    assert.equal(editor(), null, "Escape closes an editor with nothing unsaved");
    assert.equal(store().trackId, null);

    await act(async () => { store().setPosition({ left: 50, top: 60 }); store().open(8, { x: 900, y: 10 }); });
    await settle();
    assert.deepEqual([editor()!.style.left, editor()!.style.top], ["50px", "60px"],
      "for the rest of the session it reopens where it was last left");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
