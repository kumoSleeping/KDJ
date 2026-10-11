import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

/**
 * The steps of the mini player in the order the page takes them (src/lib/miniPlayer.ts), with
 * the native side replaced by a record of what it was asked.
 */
test("the window goes down to the bubble and comes back in the same steps, and a step that fails gives the window back", async () => {
  const dom = new JSDOM(`<!doctype html><html><body><div class="kd-app"><article class="kd-task" data-kind="playing"></article></div></body></html>`,
    { url: "http://localhost" });
  // Reduced motion: every wait is over at once, the order of the steps is the same.
  dom.window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  const bubble = dom.window.document.querySelector<HTMLElement>(".kd-task")!;
  let height = 148;
  bubble.getBoundingClientRect = () => ({ left: 964, top: 720, width: 384, height, right: 1348, bottom: 720 + height, x: 964, y: 720, toJSON() {} });
  Object.defineProperties(dom.window, { innerWidth: { value: 384, configurable: true }, innerHeight: { value: 148, configurable: true } });

  const asked: string[] = [];
  let active = false;
  let failCollapse = false;
  const phasesAt: Record<string, string | null> = {};
  const phaseNow = () => dom.window.document.documentElement.getAttribute("data-kd-mini");
  const state = () => ({ active, onTop: true });
  (dom.window as unknown as { kdj: unknown }).kdj = {
    miniPlayer: {
      state: async () => state(),
      collapse: async (rect: { x: number; y: number; width: number; height: number }, animated: boolean) => {
        asked.push(`collapse ${rect.x},${rect.y} ${rect.width}x${rect.height} ${animated}`);
        phasesAt.collapse = phaseNow();
        if (failCollapse) throw new Error("no");
        active = true;
        return state();
      },
      settle: async () => { asked.push("settle"); phasesAt.settle = phaseNow(); },
      recall: async () => { asked.push("recall"); phasesAt.recall = phaseNow(); },
      expand: async () => { asked.push("expand"); phasesAt.expand = phaseNow(); active = false; return state(); },
      fit: async (width: number, tall: number) => { asked.push(`fit ${width}x${tall}`); },
      setOnTop: async (onTop: boolean) => { asked.push(`top ${onTop}`); return { active, onTop }; },
    },
  };

  const mini = await import("../src/lib/miniPlayer");
  const { useWindowTaken } = await import("../src/lib/windowTaken");
  assert.equal(mini.miniPlayerOffered(), true);

  // Another app has the window: it gives it back first.
  let lyricsLeft = 0;
  useWindowTaken.getState().take("lyrics", () => { lyricsLeft += 1; useWindowTaken.getState().release("lyrics"); });
  await mini.collapseToMiniPlayer();
  assert.equal(lyricsLeft, 1);
  assert.deepEqual(asked, ["collapse 964,720 384x148 false", "settle"]);
  // The window changes size while nothing but its colour is drawn, and moves with the bubble on show.
  assert.equal(phasesAt.collapse, "flat");
  assert.equal(phasesAt.settle, "on");
  assert.equal(phaseNow(), "on");
  assert.equal(mini.useMiniPlayer.getState().phase, "on");
  assert.equal(useWindowTaken.getState().by, mini.MINI_PLAYER, "the page is hidden and the bar away while it lasts");

  // A second press while it is the mini player does nothing.
  await mini.collapseToMiniPlayer();
  assert.equal(asked.length, 2);

  // The window keeps the bubble's height; with no bubble to show the caller is told.
  assert.equal(mini.fitMiniPlayer(), true);
  assert.equal(asked.length, 2, "same height: nothing asked");
  height = 176;
  assert.equal(mini.fitMiniPlayer(), true);
  assert.equal(asked.pop(), "fit 384x176");
  bubble.remove();
  assert.equal(mini.fitMiniPlayer(), false);
  dom.window.document.querySelector(".kd-app")!.append(bubble);

  await mini.setMiniPlayerOnTop(false);
  assert.equal(asked.pop(), "top false");
  assert.equal(mini.useMiniPlayer.getState().onTop, false);

  // Back: the bubble's own key and the window's `leave` are the same way.
  useWindowTaken.getState().leave?.();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(asked.slice(2), ["recall", "expand"]);
  assert.equal(phasesAt.recall, "on");
  assert.equal(phasesAt.expand, "flat");
  assert.equal(phaseNow(), null);
  assert.equal(mini.useMiniPlayer.getState().phase, "off");
  assert.equal(useWindowTaken.getState().by, null);

  // The native side refuses: the whole window is there again, nothing is left hidden.
  asked.length = 0;
  failCollapse = true;
  const warn = console.warn;
  console.warn = () => {};
  try { await mini.collapseToMiniPlayer(); } finally { console.warn = warn; }
  assert.equal(asked.length, 1);
  assert.equal(phaseNow(), null);
  assert.equal(useWindowTaken.getState().by, null);

  // A page loaded again inside a window that is the mini player takes up where the window is.
  active = true;
  await mini.syncMiniPlayer();
  assert.equal(phaseNow(), "on");
  assert.equal(useWindowTaken.getState().by, mini.MINI_PLAYER);
  await mini.expandFromMiniPlayer();
  assert.equal(phaseNow(), null);
});
