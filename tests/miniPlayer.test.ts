import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

/**
 * The steps of the mini player in the order the page takes them (src/lib/miniPlayer.ts), with
 * the native side replaced by a record of what it was asked and of what the page showed then.
 */
test("the whole window goes as it is, the page changes out of sight, and the window is shown when it has drawn; a step that fails gives the window back", async () => {
  const dom = new JSDOM(`<!doctype html><html><body><div class="kd-app"><div class="kd-body"></div>
    <div class="kd-task-host" data-place="bottom"><div class="kd-task-slot"><article class="kd-task" data-kind="playing"><div class="kd-task-controls-clip"></div></article></div></div></div></body></html>`,
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
  let at = { left: 964, top: 640 }, height = 120;
  const box = () => ({ ...at, width: 384, height, right: at.left + 384, bottom: at.top + height, x: at.left, y: at.top, toJSON() {} });
  slot.getBoundingClientRect = box;
  bubble.getBoundingClientRect = box;

  const asked: string[] = [];
  let active = false;
  let failCollapse = false;
  const phaseNow = () => dom.window.document.documentElement.getAttribute("data-kd-mini");
  /** The size the page keeps its layout at, whatever the window's is. */
  const kept = () => dom.window.document.body.style.getPropertyValue("--kd-mini-w") || "none";
  const ask = (what: string) => { asked.push(`${what} @${phaseNow() ?? "off"}`); };
  const state = () => ({ active, onTop: true, fullWidth: active ? 1360 : 0, fullHeight: active ? 880 : 0 });
  (dom.window as unknown as { kdj: unknown }).kdj = {
    miniPlayer: {
      state: async () => state(),
      collapse: async (rect: { x: number; y: number; width: number; height: number }, _animated: boolean) => {
        ask(`collapse ${rect.x},${rect.y} ${rect.width}x${rect.height} in ${dom.window.innerWidth}x${dom.window.innerHeight}`);
        if (failCollapse) throw new Error("no");
        // As the mini player the bubble has its transport row: taller than on the bar.
        at = { left: 0, top: 0 };
        height = 148;
        active = true;
        return state();
      },
      reveal: async () => { ask("reveal"); return state(); },
      expand: async () => {
        ask("expand");
        resize(1360, 880);
        at = { left: 964, top: 640 };
        height = 120;
        active = false;
        return state();
      },
      fit: async (width: number, tall: number) => { ask(`fit ${width}x${tall} kept ${kept()}`); resize(width, tall); },
      setOnTop: async (onTop: boolean) => { ask(`top ${onTop}`); return { active, onTop }; },
    },
  };

  const mini = await import("../src/lib/miniPlayer");
  const { useWindowTaken } = await import("../src/lib/windowTaken");
  const { usePlayerBarAway } = await import("../src/lib/playerBarAway");
  assert.equal(mini.miniPlayerOffered(), true);

  // Another app has the window: it gives it back first.
  let lyricsLeft = 0;
  useWindowTaken.getState().take("lyrics", () => { lyricsLeft += 1; useWindowTaken.getState().release("lyrics"); });
  await mini.collapseToMiniPlayer();
  assert.equal(lyricsLeft, 1);
  assert.deepEqual(asked, [
    // The whole window goes with the page as it is, and keeps its size: the bubble where it
    // stands on the bar, and nothing of the mini player on the page yet.
    "collapse 964,640 384x120 in 1360x880 @off",
    // Out of sight the bubble became the transport. Only now, with the page holding the whole
    // window's layout, is the window given the bubble's size.
    "fit 384x148 kept 1360px @on",
    "reveal @on",
  ]);
  assert.equal(mini.useMiniPlayer.getState().phase, "on");
  assert.equal(useWindowTaken.getState().by, mini.MINI_PLAYER, "the page is inert and the bar away while it lasts");
  assert.equal(kept(), "1360px", "the page keeps the whole window's layout");
  assert.equal(dom.window.document.body.style.getPropertyValue("--kd-mini-bw"), "384px", "and the bubble its width");

  // A second press while it is the mini player does nothing.
  asked.length = 0;
  await mini.collapseToMiniPlayer();
  assert.equal(asked.length, 0);

  // The window keeps the bubble's height; with no bubble to show the caller is told.
  assert.equal(mini.fitMiniPlayer(), true);
  assert.equal(asked.length, 0, "same height: nothing asked");
  height = 176;
  assert.equal(mini.fitMiniPlayer(), true);
  assert.equal(asked.pop(), "fit 384x176 kept 1360px @on");
  slot.remove();
  assert.equal(mini.fitMiniPlayer(), false);
  host.append(slot);

  await mini.setMiniPlayerOnTop(false);
  assert.equal(asked.pop(), "top false @on");
  assert.equal(mini.useMiniPlayer.getState().onTop, false);

  // Back: the mini player goes first; out of sight the page is the whole window's again, the
  // bar at rest without its slide; then the window is shown. The bubble's key and the
  // window's `leave` are the same way.
  usePlayerBarAway.getState().setPhase("returning");
  useWindowTaken.getState().leave?.();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(asked, ["expand @on", "reveal @off"]);
  assert.equal(usePlayerBarAway.getState().phase, "up");
  assert.equal(phaseNow(), null);
  assert.equal(mini.useMiniPlayer.getState().phase, "off");
  assert.equal(useWindowTaken.getState().by, null);
  assert.equal(kept(), "none");

  // The page is given the whole window's size back only when the window has it: the stand-in
  // for the native side makes it whole a little late.
  asked.length = 0;
  await mini.collapseToMiniPlayer();
  let keptWhenWhole = "";
  const late = setTimeout(() => { keptWhenWhole = kept(); resize(1360, 880); }, 30);
  const expand = (dom.window as unknown as { kdj: { miniPlayer: { expand: () => Promise<unknown> } } }).kdj.miniPlayer;
  const whole = expand.expand;
  expand.expand = async () => { ask("expand"); at = { left: 964, top: 640 }; height = 120; active = false; return state(); };
  asked.length = 0;
  await mini.expandFromMiniPlayer();
  clearTimeout(late);
  expand.expand = whole;
  assert.deepEqual(asked, ["expand @on", "reveal @off"]);
  assert.equal(keptWhenWhole, "1360px", "still kept while the window was the bubble's size");
  assert.equal(kept(), "none");

  // The native side refuses: the whole window is there again, nothing is left on the page.
  asked.length = 0;
  failCollapse = true;
  const warn = console.warn;
  console.warn = () => {};
  try { await mini.collapseToMiniPlayer(); } finally { console.warn = warn; }
  assert.equal(asked.length, 1);
  assert.equal(phaseNow(), null);
  assert.equal(kept(), "none");
  assert.equal(useWindowTaken.getState().by, null);

  // A page loaded again inside a window that is the mini player takes up where the window is,
  // and knows the whole window it goes back to.
  active = true;
  resize(384, 148);
  at = { left: 0, top: 0 };
  await mini.syncMiniPlayer();
  assert.equal(phaseNow(), "on");
  assert.equal(useWindowTaken.getState().by, mini.MINI_PLAYER);
  assert.equal(kept(), "1360px");
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
