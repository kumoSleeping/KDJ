import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

/**
 * The steps of the mini player in the order the page takes them (src/lib/miniPlayer.ts), with
 * the native side replaced by a record of what it was asked and of what the page showed then.
 */
test("the whole window goes at once and the bubble flies to its place, and back the same way; a step that fails gives the window back", async () => {
  const dom = new JSDOM(`<!doctype html><html><body><div class="kd-app"><div class="kd-body"></div>
    <div class="kd-task-host" data-place="bottom"><div class="kd-task-slot"><article class="kd-task" data-kind="playing"></article></div></div></div></body></html>`,
    { url: "http://localhost" });
  // Reduced motion: every wait is over at once, the order of the steps is the same.
  dom.window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  const host = dom.window.document.querySelector<HTMLElement>(".kd-task-host")!;
  const slot = dom.window.document.querySelector<HTMLElement>(".kd-task-slot")!;
  const bubble = dom.window.document.querySelector<HTMLElement>(".kd-task")!;
  const resize = (width: number, height: number) => {
    Object.defineProperties(dom.window, { innerWidth: { value: width, configurable: true }, innerHeight: { value: height, configurable: true } });
  };
  // The whole window, with the bubble standing on the bar, 12 px from the right edge.
  resize(1360, 880);
  let at = { left: 964, top: 640 }, height = 148;
  const box = () => ({ ...at, width: 384, height, right: at.left + 384, bottom: at.top + height, x: at.left, y: at.top, toJSON() {} });
  slot.getBoundingClientRect = box;
  bubble.getBoundingClientRect = box;

  const asked: string[] = [];
  let active = false;
  let failCollapse = false;
  let place: [number, number] | null = null;
  const phaseNow = () => dom.window.document.documentElement.getAttribute("data-kd-mini");
  const ask = (what: string) => { asked.push(`${what} @${phaseNow() ?? "off"}`); };
  const state = () => ({ active, onTop: true, fullWidth: active ? 1360 : 0, fullHeight: active ? 880 : 0 });
  (dom.window as unknown as { kdj: unknown }).kdj = {
    miniPlayer: {
      state: async () => state(),
      place: async (width: number, tall: number) => { ask(`place ${width}x${tall}`); return place; },
      collapse: async (rect: { x: number; y: number; width: number; height: number; homeRight: number; homeBottom: number }, _animated: boolean) => {
        ask(`collapse ${rect.x},${rect.y} ${rect.width}x${rect.height} home ${rect.homeRight},${rect.homeBottom}`);
        if (failCollapse) throw new Error("no");
        resize(384, 148);
        at = { left: 0, top: 0 };
        active = true;
        return state();
      },
      reveal: async () => { ask("reveal"); return state(); },
      settle: async (animated: boolean) => { ask(`settle ${animated}`); },
      recall: async (animated: boolean, stay: boolean) => { ask(`recall ${animated} stay=${stay}`); },
      expand: async () => {
        ask("expand");
        resize(1360, 880);
        at = { left: 964, top: 720 };
        active = false;
        return state();
      },
      leave: async (out: number) => { ask(`leave ${out}`); return true; },
      comeBack: async (back: number, width: number, tall: number) => { ask(`back ${back} ${width}x${tall}`); },
      fit: async (width: number, tall: number) => { ask(`fit ${width}x${tall}`); },
      setOnTop: async (onTop: boolean) => { ask(`top ${onTop}`); return { active, onTop }; },
    },
  };

  const mini = await import("../src/lib/miniPlayer");
  const { useWindowTaken } = await import("../src/lib/windowTaken");
  assert.equal(mini.miniPlayerOffered(), true);

  // The flight is an arc: it starts and lands exactly, and rises above the line between.
  const path = mini.flightPath({ x: 0, y: 0 }, { x: -600, y: -200 });
  assert.deepEqual(path[0], { x: 0, y: 0 });
  assert.deepEqual(path[path.length - 1], { x: -600, y: -200 });
  assert.ok(path[12].y < -100 - 150, `halfway it is well above the line: ${path[12].y}`);
  assert.equal(mini.flightPath({ x: 5, y: 5 }, { x: 5, y: 5 })[12].y, 5, "nowhere to go: no arc");

  // —— No place of its own yet: it stays where the bubble is. ——
  // Another app has the window: it gives it back first.
  let lyricsLeft = 0;
  useWindowTaken.getState().take("lyrics", () => { lyricsLeft += 1; useWindowTaken.getState().release("lyrics"); });
  await mini.collapseToMiniPlayer();
  assert.equal(lyricsLeft, 1);
  assert.deepEqual(asked, [
    "place 384x148 @readying",
    // The window is the bubble in its corner of the whole window, on the window's bottom where
    // it stands once the bar is gone; the page is on show until that moment.
    "collapse 964,720 384x148 home 1348,868 @readying",
    // It is shown again only when the page is the bubble.
    "reveal @on",
    "settle false @on",
  ]);
  assert.equal(mini.useMiniPlayer.getState().phase, "on");
  assert.equal(useWindowTaken.getState().by, mini.MINI_PLAYER, "the page is inert and the bar away while it lasts");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--kd-mini-w"), "1360px", "the page keeps the whole window's layout");

  // A second press while it is the mini player does nothing.
  asked.length = 0;
  await mini.collapseToMiniPlayer();
  assert.equal(asked.length, 0);

  // The window keeps the bubble's height; with no bubble to show the caller is told.
  assert.equal(mini.fitMiniPlayer(), true);
  assert.equal(asked.length, 0, "same height: nothing asked");
  height = 176;
  assert.equal(mini.fitMiniPlayer(), true);
  assert.equal(asked.pop(), "fit 384x176 @on");
  slot.remove();
  assert.equal(mini.fitMiniPlayer(), false);
  host.append(slot);
  height = 148;

  await mini.setMiniPlayerOnTop(false);
  assert.equal(asked.pop(), "top false @on");
  assert.equal(mini.useMiniPlayer.getState().onTop, false);

  // Another song takes the window off the screen and back; not under reduced motion.
  mini.dipMiniPlayer(() => true);
  assert.equal(asked.length, 0);

  // Back, from a place outside the whole window (or its own corner): the window flies back
  // first, then the whole window is there. The bubble's key and the window's `leave` are the
  // same way.
  place = [1500, 40];
  useWindowTaken.getState().leave?.();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(asked, ["place 384x148 @on", "recall false stay=false @on", "expand @on", "reveal @landing"]);
  assert.equal(phaseNow(), null);
  assert.equal(mini.useMiniPlayer.getState().phase, "off");
  assert.equal(useWindowTaken.getState().by, null);
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--kd-mini-w"), "");

  // —— A place inside the whole window: the bubble flies there in front of the page, and the
  // whole window goes when it has landed. ——
  asked.length = 0;
  at = { left: 964, top: 640 };
  place = [120, 300];
  await mini.collapseToMiniPlayer();
  assert.deepEqual(asked, [
    "place 384x148 @readying",
    "collapse 120,300 384x148 home 1348,868 @flying",
    "reveal @on",
    "settle false @on",
  ]);
  // Back: the whole window is there first, the bubble still at its place, and then it flies in.
  asked.length = 0;
  await mini.expandFromMiniPlayer();
  assert.deepEqual(asked, ["place 384x148 @on", "recall false stay=true @on", "expand @on", "reveal @landing"]);
  assert.equal(phaseNow(), null);

  // The native side refuses: the whole window is there again, nothing is left on the page.
  asked.length = 0;
  at = { left: 964, top: 640 };
  place = null;
  failCollapse = true;
  const warn = console.warn;
  console.warn = () => {};
  try { await mini.collapseToMiniPlayer(); } finally { console.warn = warn; }
  assert.equal(asked.length, 2);
  assert.equal(phaseNow(), null);
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--kd-mini-w"), "");
  assert.equal(useWindowTaken.getState().by, null);

  // A page loaded again inside a window that is the mini player takes up where the window is,
  // and knows the whole window it goes back to.
  active = true;
  resize(384, 148);
  at = { left: 0, top: 0 };
  await mini.syncMiniPlayer();
  assert.equal(phaseNow(), "on");
  assert.equal(useWindowTaken.getState().by, mini.MINI_PLAYER);
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--kd-mini-w"), "1360px");
  await mini.expandFromMiniPlayer();
  assert.equal(phaseNow(), null);
});

test("the mini player's second line is the lyric that is being sung", async () => {
  const { lyricLineAt } = await import("../src/lib/miniPlayerLyric");
  const lines = [{ time: 10, text: " first " }, { time: 20, text: "", }, { time: 30, text: "third", endTime: 34 }];
  assert.equal(lyricLineAt(lines, 5), "", "before the first line");
  assert.equal(lyricLineAt(lines, 10), "first");
  assert.equal(lyricLineAt(lines, 25), "", "a line without words");
  assert.equal(lyricLineAt(lines, 33), "third");
  assert.equal(lyricLineAt(lines, 34), "", "the platform said the line was over");
  assert.equal(lyricLineAt([], 3), "");
});
