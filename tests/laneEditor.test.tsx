import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";

test("the editor shows a project's three lanes, and everything about what is chosen in one place under them", async () => {
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
  try {
    // Nothing open: the editor stands empty — its lanes and tools, nothing written in the lanes.
    await act(async () => root.render(createElement(LaneEditor)));
    assert.ok(document.querySelector(".kd-lanes[data-empty]"));
    assert.equal(document.querySelectorAll(".kd-lanes-lane").length, 3, "branches, picture, songs");
    assert.equal([...document.querySelectorAll(".kd-lanes-lane")].map(lane => lane.textContent).join(""), "");
    assert.equal((button("字幕") as HTMLButtonElement).disabled, true);
    assert.equal(document.querySelector(".kd-lanes-panel"), null, "nothing under the lanes");

    const doc = {
      kdjv: 2 as const, title: "Set",
      songs: [{ src: "/m/a.flac", in: 0, out: 60 }, { src: "/m/b.flac", in: 0, out: 40 }],
      main: [{ id: "c1", src: "/v/op.mp4", in: 0, out: 30, muted: true, fill: true }, { gap: 70 }],
      branches: [],
    };
    const layout = {
      duration: 100, main_end: 100,
      main: [{ index: 0, at: 0, length: 30, id: "c1", src: "/v/op.mp4" }, { index: 1, at: 30, length: 70, gap: true as const }],
      branches: [],
      songs: [{ index: 0, at: 0, length: 60, src: "/m/a.flac", in: 0 }, { index: 1, at: 60, length: 40, src: "/m/b.flac", in: 0 }],
    };
    await act(async () => useLaneEditor.setState({
      open: true, active: "/p/set.kdjv", selected: null,
      projects: [{ path: "/p/set.kdjv", trackId: 7, songIds: [1, 2], doc, layout, grid: { downbeats: [0, 2, 4], beats: [0, 0.5, 1, 1.5, 2] }, analysing: false, lengths: {} }],
    }));
    assert.equal(document.querySelectorAll(".kd-lanes-lane").length, 3, "branches, picture, songs");
    assert.deepEqual([...document.querySelectorAll(".kd-lanes-song")].map(node => node.textContent), ["a", "b"]);
    assert.equal(document.querySelectorAll(".kd-lanes-clip").length, 1);

    // Nothing chosen: what acts on every picture.
    assert.ok(button("全部铺满"));
    // A clip chosen: its cut, picture, sound, branches and (in a VJ) its place in the song, together.
    await click(document.querySelector(".kd-lanes-clip"));
    assert.deepEqual([...document.querySelectorAll(".kd-lanes-section-label")].map(node => node.textContent), ["剪", "画面", "声音", "转场", "校准"]);
    assert.ok(button("切开"));
    assert.ok(document.querySelector('.kd-lanes-panel [role="radiogroup"][aria-label="画面大小"]'));
    assert.ok(button("对齐到歌"));
    assert.equal(button("全部铺满"), undefined);

    // A song chosen: its place in the song lane and its volume.
    await click(document.querySelectorAll(".kd-lanes-song")[1]);
    assert.ok(button("删掉这首歌"));
    assert.equal((button("往后") as HTMLButtonElement).disabled, true, "the last song cannot go later");
    assert.equal(button("切开"), undefined);

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
