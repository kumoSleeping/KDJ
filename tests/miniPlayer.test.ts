import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

/**
 * The steps of the mini player in the order the page takes them (src/lib/miniPlayer.ts), with
 * the native side replaced by a record of what it was asked and of what the page showed then.
 */
test("the window goes down to the bubble and comes back with the page on show all the way, and a step that fails gives the window back", async () => {
  const dom = new JSDOM(`<!doctype html><html><body><div class="kd-app"><div class="kd-body"></div>
    <div class="kd-task-host" data-place="bottom"><div class="kd-task-slot"><article class="kd-task" data-kind="playing">
      <button data-task-action="mini-top"></button></article></div></div></div></body></html>`,
    { url: "http://localhost" });
  // Reduced motion: every wait is over at once, the order of the steps is the same.
  dom.window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  const page = dom.window.document.querySelector<HTMLElement>(".kd-body")!;
  const host = dom.window.document.querySelector<HTMLElement>(".kd-task-host")!;
  const slot = dom.window.document.querySelector<HTMLElement>(".kd-task-slot")!;
  const bubble = dom.window.document.querySelector<HTMLElement>(".kd-task")!;
  const resize = (width: number, height: number) => {
    Object.defineProperties(dom.window, { innerWidth: { value: width, configurable: true }, innerHeight: { value: height, configurable: true } });
  };
  // The whole window, with the bubble standing on the bar, 12 px from the right edge.
  resize(1360, 880);
  let place = { left: 964, top: 640 }, height = 148;
  const box = () => ({ ...place, width: 384, height, right: place.left + 384, bottom: place.top + height, x: place.left, y: place.top, toJSON() {} });
  slot.getBoundingClientRect = box;
  bubble.getBoundingClientRect = box;

  const asked: string[] = [];
  let active = false;
  let failCollapse = false;
  const shownAt: Record<string, { phase: string | null; page: string; bubble: string; solid: string; ghost: boolean }> = {};
  const phaseNow = () => dom.window.document.documentElement.getAttribute("data-kd-mini");
  const shown = () => ({
    phase: phaseNow(), page: page.style.transform, bubble: host.style.getPropertyValue("--kd-mini-bs"),
    solid: host.style.getPropertyValue("--kd-mini-o"), ghost: !!host.querySelector(".kd-mini-ghost .kd-task"),
  });
  const state = () => ({ active, onTop: true, fullWidth: active ? 1360 : 0, fullHeight: active ? 880 : 0 });
  (dom.window as unknown as { kdj: unknown }).kdj = {
    miniPlayer: {
      state: async () => state(),
      collapse: async (rect: { x: number; y: number; width: number; height: number }, animated: boolean) => {
        asked.push(`collapse ${rect.x},${rect.y} ${rect.width}x${rect.height} ${animated}`);
        shownAt.collapse = shown();
        if (failCollapse) throw new Error("no");
        // Halfway, as the page sees it: the window is narrower and says so.
        resize(872, 514);
        dom.window.dispatchEvent(new dom.window.Event("resize"));
        shownAt.halfway = shown();
        resize(384, 148);
        place = { left: 0, top: 0 };
        active = true;
        return state();
      },
      settle: async () => { asked.push("settle"); shownAt.settle = shown(); },
      recall: async () => { asked.push("recall"); shownAt.recall = shown(); },
      expand: async () => {
        asked.push("expand");
        shownAt.expand = shown();
        resize(1360, 880);
        place = { left: 964, top: 720 };
        active = false;
        return state();
      },
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
  // The window is asked down to the bubble's corner of the whole window: on the window's
  // bottom, where it stands once the bar is gone.
  assert.deepEqual(asked, ["collapse 964,720 384x148 false", "settle"]);
  // The page is whole when the window starts to move, with a copy of the bubble in it, and the
  // bubble itself is drawn to fill the window and is still clear.
  assert.deepEqual(shownAt.collapse, { phase: "shrinking", page: "scale(1.00000)", bubble: (1360 / 384).toFixed(5), solid: "0.000", ghost: true });
  // On the way the page is as small as the window is of the whole one, and the bubble is up.
  assert.equal(shownAt.halfway.page, `scale(${(872 / 1360).toFixed(5)})`);
  assert.equal(shownAt.halfway.bubble, (872 / 384).toFixed(5));
  assert.ok(Number(shownAt.halfway.solid) > 0.5, `the bubble is coming up: ${shownAt.halfway.solid}`);
  // As the mini player the bubble lies as it is and its copy is gone.
  assert.deepEqual(shownAt.settle, { phase: "on", page: `scale(${(384 / 1360).toFixed(5)})`, bubble: "", solid: "", ghost: false });
  assert.equal(mini.useMiniPlayer.getState().phase, "on");
  assert.equal(useWindowTaken.getState().by, mini.MINI_PLAYER, "the page is inert and the bar away while it lasts");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--kd-mini-w"), "1360px", "the page keeps the whole window's layout");

  // A second press while it is the mini player does nothing.
  await mini.collapseToMiniPlayer();
  assert.equal(asked.length, 2);

  // The window keeps the bubble's height; with no bubble to show the caller is told.
  assert.equal(mini.fitMiniPlayer(), true);
  assert.equal(asked.length, 2, "same height: nothing asked");
  height = 176;
  assert.equal(mini.fitMiniPlayer(), true);
  assert.equal(asked.pop(), "fit 384x176");
  slot.remove();
  assert.equal(mini.fitMiniPlayer(), false);
  host.append(slot);
  height = 148;

  await mini.setMiniPlayerOnTop(false);
  assert.equal(asked.pop(), "top false");
  assert.equal(mini.useMiniPlayer.getState().onTop, false);

  // Back: the bubble's own key and the window's `leave` are the same way.
  useWindowTaken.getState().leave?.();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(asked.slice(2), ["recall", "expand"]);
  assert.equal(shownAt.recall.phase, "on");
  // The page is under the bubble before the window grows, with the bubble's copy where the
  // bubble is going to be; the bubble still fills the window and is solid.
  assert.deepEqual(shownAt.expand, { phase: "growing", page: `scale(${(384 / 1360).toFixed(5)})`, bubble: "1.00000", solid: "1.000", ghost: true });
  assert.equal(phaseNow(), null);
  assert.equal(mini.useMiniPlayer.getState().phase, "off");
  assert.equal(useWindowTaken.getState().by, null);
  assert.deepEqual(shown(), { phase: null, page: "", bubble: "", solid: "", ghost: false }, "nothing of the mini player is left on the page");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--kd-mini-w"), "");

  // The native side refuses: the whole window is there again, nothing is left on the page.
  asked.length = 0;
  failCollapse = true;
  const warn = console.warn;
  console.warn = () => {};
  try { await mini.collapseToMiniPlayer(); } finally { console.warn = warn; }
  assert.equal(asked.length, 1);
  assert.deepEqual(shown(), { phase: null, page: "", bubble: "", solid: "", ghost: false });
  assert.equal(useWindowTaken.getState().by, null);

  // A page loaded again inside a window that is the mini player takes up where the window is,
  // and knows the whole window it goes back to.
  active = true;
  resize(384, 148);
  place = { left: 0, top: 0 };
  await mini.syncMiniPlayer();
  assert.equal(phaseNow(), "on");
  assert.equal(useWindowTaken.getState().by, mini.MINI_PLAYER);
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--kd-mini-w"), "1360px");
  await mini.expandFromMiniPlayer();
  assert.equal(shownAt.expand.ghost, true);
  assert.equal(phaseNow(), null);
});
