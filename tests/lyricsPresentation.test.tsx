import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";

test("lyrics fullscreen follows window shape and restores the previous transport hold", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost" });
  let tall = true;
  const listeners = new Set<() => void>();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ get matches() { return tall; }, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) }) });
  const { createRoot } = await import("react-dom/client");
  const { LyricsPresentation } = await import("../src/components/player/LyricsPresentation");
  const { useLyricsPresentation } = await import("../src/lib/lyricsPresentation");
  const { useNowPlayingInfo } = await import("../src/lib/nowPlayingInfo");
  const { usePlayerBarAway } = await import("../src/lib/playerBarAway");
  const collapsed = usePlayerBarAway.getState().collapsed;
  useNowPlayingInfo.setState({ open: false });
  useLyricsPresentation.setState({ extent: "fullscreen" });
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(LyricsPresentation, null, "lyrics")));
    assert.equal(document.documentElement.dataset.lyricsFullscreen, "true");
    assert.equal(useNowPlayingInfo.getState().open, true, "fullscreen holds transport");
    await act(async () => { tall = false; listeners.forEach(fn => fn()); });
    assert.equal(document.querySelector(".kd-lyrics-presentation")?.getAttribute("data-extent"), "long");
    assert.equal(document.documentElement.dataset.lyricsFullscreen, undefined);
    assert.equal(useNowPlayingInfo.getState().open, false);
    await act(async () => { tall = true; listeners.forEach(fn => fn()); });
    assert.equal(document.documentElement.dataset.lyricsFullscreen, "true");
    assert.equal(usePlayerBarAway.getState().collapsed, collapsed, "returning to portrait preserves its preference");
    assert.equal(localStorage.getItem("kd-player-bar-collapsed-tall"), null);
    assert.equal(localStorage.getItem("kd-player-bar-collapsed"), null);
    await act(async () => useLyricsPresentation.getState().setExtent("standard"));
    assert.equal(document.documentElement.dataset.lyricsFullscreen, undefined);
    assert.equal(useNowPlayingInfo.getState().open, false);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
