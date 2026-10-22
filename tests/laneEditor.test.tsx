import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";

test("the editor shows a project's three lanes, and each tool unfolds its own controls for what is chosen", async () => {
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
    // Nothing open: a place to drop into, with nothing written in it.
    await act(async () => root.render(createElement(LaneEditor)));
    assert.ok(document.querySelector(".kd-lanes-empty"));
    assert.equal(document.querySelector(".kd-lanes-empty")?.textContent, "");

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
      projects: [{ path: "/p/set.kdjv", trackId: 7, songIds: [1, 2], doc, layout, grid: { downbeats: [0, 2, 4], beats: [0, 0.5, 1, 1.5, 2] }, analysing: false }],
    }));
    assert.equal(document.querySelectorAll(".kd-lanes-lane").length, 3, "branches, picture, songs");
    assert.deepEqual([...document.querySelectorAll(".kd-lanes-song")].map(node => node.textContent), ["a", "b"]);
    assert.equal(document.querySelectorAll(".kd-lanes-clip").length, 1);
    assert.equal(document.querySelector(".kd-lanes-panel"), null, "no tool unfolded yet");

    // 画面 with nothing chosen acts on every picture; with a clip chosen, on that clip.
    await click(button("画面"));
    assert.ok(button("全部铺满"));
    await click(document.querySelector(".kd-lanes-clip"));
    assert.ok(document.querySelector('.kd-lanes-panel [role="radiogroup"][aria-label="画面大小"]'));
    assert.equal(button("全部铺满"), undefined);

    // 剪切 for a song: its place in the song lane.
    await click(button("剪切"));
    assert.ok(button("切开"));
    await click(document.querySelectorAll(".kd-lanes-song")[1]);
    assert.ok(button("删掉这首歌"));
    assert.equal((button("往后") as HTMLButtonElement).disabled, true, "the last song cannot go later");

    // The same tool again folds it away.
    await click(button("剪切"));
    assert.equal(document.querySelector(".kd-lanes-panel"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
