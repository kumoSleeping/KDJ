import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("the pointer demos play every scene, survive a change of scene mid-loop, and the tips pages switch", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { PointerDemo } = await import("../src/components/common/PointerDemo");
  const { SearchTipsPanel } = await import("../src/components/download/SearchTipsPanel");
  const { useTipsPage, tipsPages } = await import("../src/lib/tipsPages");
  const root = createRoot(document.getElementById("root")!);
  const scenes = ["search", "pick-range", "pick-toggle", "drag-in", "viz-tune", "pip", "player-keys"] as const;
  try {
    // The same element changes scene while it is deep in the longest scene's beats: the place it
    // was at does not exist in a shorter scene (this crashed the tips drawer once).
    for (const scene of scenes) {
      await act(async () => root.render(createElement(PointerDemo, { scene })));
      await act(async () => { await sleep(260); });
    }
    for (const from of scenes) for (const to of scenes) {
      await act(async () => root.render(createElement(PointerDemo, { scene: from, label: from })));
      await act(async () => root.render(createElement(PointerDemo, { scene: to, label: to })));
      assert.ok(document.querySelector("svg.kd-demo"), `${from} → ${to} draws`);
    }
    // Every page of the tips panel draws, in turn, with its own pictures.
    for (const page of tipsPages) {
      await act(async () => useTipsPage.getState().setPage(page.id));
      await act(async () => root.render(createElement(SearchTipsPanel)));
      assert.ok(document.querySelector(".kd-tips-panel"), `${page.id} page`);
      if (page.id !== "all") assert.ok(document.querySelector("svg.kd-demo"), `${page.id} has a picture`);
    }
    await act(async () => root.render(createElement(SearchTipsPanel, { stacked: true })));
    assert.equal(document.querySelectorAll(".kd-tips-panel section").length, tipsPages.length);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
