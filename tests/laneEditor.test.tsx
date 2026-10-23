import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";

test("the editor shows a project's tracks, and everything about what is chosen in one place under them", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { LaneEditor } = await import("../src/components/editor/LaneEditor");
  const { useLaneEditor } = await import("../src/stores/laneEditorStore");
  const root = createRoot(document.getElementById("root")!);
  const click = async (element: Element | null | undefined) => {
    assert.ok(element, "there is something to press");
    await act(async () => { (element as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  };
  const button = (text: string) => [...document.querySelectorAll("button")].find(node => node.textContent?.includes(text));
  const names = () => [...document.querySelectorAll(".kd-lanes-name-text")].map(node => node.textContent);
  try {
    // Nothing open: the editor stands empty — a picture track and a sound track, nothing in them.
    await act(async () => root.render(createElement(LaneEditor)));
    assert.ok(document.querySelector(".kd-lanes[data-empty]"));
    assert.deepEqual(names(), ["画面 1", "声音 1"]);
    assert.equal([...document.querySelectorAll(".kd-lanes-lane")].map(lane => lane.textContent).join(""), "");
    assert.equal((button("字幕") as HTMLButtonElement).disabled, true);
    assert.equal(document.querySelector(".kd-lanes-panel"), null, "nothing under the tracks");

    const doc = {
      kdjv: 3 as const, title: "Set",
      tracks: [
        { id: "v2", kind: "picture" as const, clips: [{ id: "c2", src: "/v/ed.mp4", at: 20, in: 0, out: 10, muted: true }] },
        { id: "v1", kind: "picture" as const, clips: [{ id: "c1", src: "/v/op.mp4", at: 0, in: 0, out: 30, muted: true, fill: true }] },
        { id: "a1", kind: "sound" as const, clips: [{ id: "s1", src: "/m/a.flac", at: 0, in: 0, out: 60 }, { id: "s2", src: "/m/b.flac", at: 60, in: 0, out: 40 }] },
      ],
      folds: [{ id: "f1", tracks: ["v2", "v1"] }],
    };
    const layout = {
      duration: 100, folds: doc.folds,
      tracks: doc.tracks.map((track, index) => ({ index, id: track.id, kind: track.kind,
        clips: track.clips.map(c => ({ id: c.id, src: c.src, at: c.at, length: c.out - c.in, in: c.in, out: c.out })) })),
      songs: [{ index: 0, at: 0, length: 60, src: "/m/a.flac", in: 0 }, { index: 1, at: 60, length: 40, src: "/m/b.flac", in: 0 }],
    };
    await act(async () => useLaneEditor.setState({
      open: true, active: "/p/set.kdjv", selected: null,
      projects: [{ path: "/p/set.kdjv", trackId: 7, songIds: [1, 2], doc, layout, grid: { downbeats: [0, 2, 4], beats: [0, 0.5, 1, 1.5, 2] }, analysing: false, lengths: {} }],
    }));
    // The two picture tracks are folded into one row: both clips in it, the upper drawn over the lower.
    assert.deepEqual(names(), ["画面 1 + 画面 2", "声音 1"]);
    assert.equal(document.querySelectorAll(".kd-lanes-lane").length, 2);
    assert.equal(document.querySelectorAll(".kd-lanes-clip").length, 4);
    // Opened, each is a row again; the fold stays.
    await click(document.querySelector('[aria-label="展开合并的轨道"]'));
    assert.deepEqual(names(), ["画面 1", "画面 2", "声音 1"]);
    assert.ok(button("画面"), "a key adds a picture track");

    // Nothing chosen: what acts on every picture.
    assert.ok(button("全部铺满"));
    // A picture clip chosen: its cut, picture, sound, fades and (with songs) its place in the song.
    await click(document.querySelector('.kd-lanes-clip[data-kind="picture"]'));
    assert.deepEqual([...document.querySelectorAll(".kd-lanes-section-label")].map(node => node.textContent), ["剪", "画面", "声音", "淡入淡出", "校准"]);
    assert.ok(button("切开"));
    assert.ok(document.querySelector('.kd-lanes-panel [role="radiogroup"][aria-label="画面大小"]'));
    assert.ok(button("对齐到歌"));
    assert.equal(button("全部铺满"), undefined);

    // A sound clip chosen: no picture to set.
    await click(document.querySelectorAll('.kd-lanes-clip[data-kind="sound"]')[1]);
    assert.deepEqual([...document.querySelectorAll(".kd-lanes-section-label")].map(node => node.textContent), ["剪", "声音", "淡入淡出"]);

    // 字幕 offers a new title at the playhead; 导出 its settings; nothing to undo yet.
    await click(button("字幕"));
    assert.ok(document.querySelector('.kd-lanes-panel textarea[aria-label="字幕的字"]'));
    await click(button("导出"));
    assert.ok(document.querySelector('.kd-lanes-panel [role="radiogroup"][aria-label="尺寸"]'));
    assert.ok(button("导出 MP4"));
    assert.equal((document.querySelector('[aria-label="撤销"]') as HTMLButtonElement).disabled, true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
