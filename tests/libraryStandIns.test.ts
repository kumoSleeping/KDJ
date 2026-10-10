import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { STAND_IN_LEAVING_ATTR, STAND_IN_TILE_ROWS, createLibraryStandIns, standInGap, standInPlan, type StandInFrame, type StandInPlanInput } from "../src/lib/libraryStandIns";

const base: StandInPlanInput = { top: 0, height: 684, rowHeight: 36, count: 10_000, first: 0, windowStart: 0, windowEnd: 0, direction: 0 };
const shown = (input: StandInPlanInput) => standInPlan(input).map((tile) => [tile.shownStart, tile.shownEnd] as const);

test("stand-in tiles cover the viewport and several screens ahead of a scroll, never the table's own rows", () => {
  for (const direction of [-1, 0, 1] as const) for (const row of [0, 7, 500, 5000, 9990]) {
    for (const [windowStart, windowEnd] of [[0, 0], [row - 30, row + 60], [row + 5, row + 80], [0, 10_000]] as const) {
      const input = { ...base, top: row * 36, direction, windowStart: Math.max(0, windowStart), windowEnd: Math.min(10_000, windowEnd) };
      const plan = standInPlan(input);
      const first = Math.min(10_000, row), last = Math.min(10_000, row + 19);
      const covered = [[input.windowStart, input.windowEnd] as const, ...shown(input)];
      assert.equal(standInGap(covered, first, last), 0, "every row of the viewport has something to show");
      for (const tile of plan) {
        assert.ok(tile.start >= tile.index * STAND_IN_TILE_ROWS && tile.end <= (tile.index + 1) * STAND_IN_TILE_ROWS && tile.end <= 10_000);
        assert.ok(tile.start <= tile.shownStart && tile.shownStart < tile.shownEnd && tile.shownEnd <= tile.end);
        assert.ok(tile.shownEnd <= input.windowStart || tile.shownStart >= input.windowEnd, "a stand-in is never drawn over a real row");
        assert.equal(tile.urgent, tile.shownStart < last && tile.shownEnd > first);
      }
      assert.ok(plan.length <= 12);
      assert.ok(plan.every((tile, at) => at === 0 || !tile.urgent || plan[at - 1].urgent), "tiles under the viewport come first");
      // Six screens ahead of a fast scroll; nothing beyond the viewport for a table that builds its own rows.
      if (direction) {
        const edge = Math.min(9_999, Math.max(0, direction < 0 ? first - 6 * 19 : last + 6 * 19 - 1));
        assert.equal(standInGap(covered, edge, edge + 1), 0);
      } else {
        assert.ok(plan.every((tile) => tile.urgent), "no canvas is held for rows out of sight");
      }
    }
  }
  assert.deepEqual(standInPlan({ ...base, windowStart: 0, windowEnd: 10_000 }), []);
  assert.deepEqual(standInPlan({ ...base, count: 0 }), []);
});

test("pending downloads keep their own rows; the last tile ends with the table", () => {
  const plan = standInPlan({ ...base, count: 60, first: 10, top: 0, direction: 1 });
  assert.equal(Math.min(...plan.map((tile) => tile.start)), 10);
  assert.equal(Math.max(...plan.map((tile) => tile.end)), 60);
});

test("a faster scroll reaches further ahead, up to a limit", () => {
  const at = (lead: number, direction: -1 | 1 = 1) => standInPlan({ ...base, top: 1000 * 36, direction, lead });
  const reach = (plan: ReturnType<typeof standInPlan>, direction: -1 | 1) => direction > 0
    ? Math.max(...plan.map((tile) => tile.end)) - 1019 : 1000 - Math.min(...plan.map((tile) => tile.start));
  assert.ok(reach(at(0), 1) >= 6 * 19 && reach(at(0), 1) < 6 * 19 + STAND_IN_TILE_ROWS, "six screens whatever the speed");
  // 60 px/ms for half a second: 30,000 px, 833 rows.
  for (const direction of [-1, 1] as const) {
    const far = at(30_000, direction);
    assert.ok(reach(far, direction) >= 833 && reach(far, direction) < 833 + STAND_IN_TILE_ROWS);
    assert.equal(standInGap(far.map((tile) => [tile.shownStart, tile.shownEnd] as const), direction > 0 ? 1000 : 1000 - 833, direction > 0 ? 1019 + 833 : 1019), 0);
    assert.ok(far.filter((tile) => tile.urgent).length <= 2 && far.some((tile) => tile.urgent));
  }
  assert.ok(reach(at(10_000_000), 1) <= 65 * STAND_IN_TILE_ROWS, "no more than the limit of tiles");
  assert.equal(standInPlan({ ...base, top: 1000 * 36, direction: 0, lead: 30_000, windowStart: 900, windowEnd: 1100 }).length, 0);
  assert.equal(standInGap([[0, 5], [8, 12]], 3, 10), 3);
});

test("tiles are bars copied from one pattern, never text; they fade out over the rows that caught up and never reach past the table", async () => {
  const dom = new JSDOM(`<!doctype html><html><body><div class="kd-scroll"><table class="kd-table"><thead><tr><th>t</th></tr></thead>
    <tbody><tr data-kd-track-id="1"><td data-col="title"><span><span class="kd-thumb"></span>Song</span></td><td data-col="bpm">128</td></tr></tbody>
    </table><div class="layer"></div></div></body></html>`, { url: "http://localhost" });
  const frames: (() => void)[] = [];
  let reducedMotion = false;
  dom.window.matchMedia = (() => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, localStorage: dom.window.localStorage,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: () => void) => frames.push(callback), cancelAnimationFrame: () => { frames.length = 0; } });
  const { document } = dom.window;
  const scroller = document.querySelector<HTMLElement>(".kd-scroll")!;
  const layer = document.querySelector<HTMLElement>(".layer")!;
  const table = document.querySelector<HTMLElement>("table")!;
  let scrollTop = 0;
  Object.defineProperties(scroller, { clientHeight: { value: 712 }, clientWidth: { value: 1000 },
    scrollTop: { get: () => scrollTop, set: (value: number) => { scrollTop = value; } } });
  Object.defineProperties(table, { offsetHeight: { value: 28 + 2000 * 36 }, offsetWidth: { value: 1000 } });
  const box = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.tagName === "TBODY") return box(0, 28 - scrollTop, 1000, 72000);
    if (this.tagName === "TR") return box(0, 28 - scrollTop, 1000, 36);
    if (this.tagName === "TD") return this.dataset.col === "title" ? box(0, 28 - scrollTop, 600, 36) : box(600, 28 - scrollTop, 400, 36);
    if (this.classList.contains("kd-thumb")) return box(10, 35 - scrollTop, 22, 22);
    return box(0, 0, 1000, 712);
  };
  dom.window.Range.prototype.getBoundingClientRect = function () {
    return this.startContainer.parentElement!.closest("td")!.dataset.col === "title" ? box(40, 38 - scrollTop, 30, 16) : box(610, 38 - scrollTop, 20, 16);
  };
  // What each canvas was asked to draw: the pattern is made of rectangles, a tile is one copy of it.
  const drawn = new Map<HTMLCanvasElement, string[]>();
  dom.window.HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    const calls = drawn.get(this) ?? [];
    drawn.set(this, calls);
    return { setTransform() {}, clearRect() { calls.length = 0; }, fillText() { calls.push("text"); }, drawImage() { calls.push("copy"); },
      beginPath() {}, rect() {}, fill() {}, fillRect() { calls.push("bar"); }, roundRect() {}, save() {}, restore() {}, clip() {} };
  } as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;

  const frame = (over: Partial<StandInFrame> = {}): StandInFrame =>
    ({ rowHeight: 36, count: 2000, first: 0, windowStart: 0, windowEnd: 60, direction: 1, speed: 5, ...over });
  const canvases = () => [...layer.querySelectorAll("canvas")];
  const shown = () => canvases().filter((canvas) => canvas.style.display !== "none");
  const leaving = () => canvases().filter((canvas) => canvas.hasAttribute(STAND_IN_LEAVING_ATTR));
  const settleFrames = () => { while (frames.length) frames.shift()!(); };
  const standIns = createLibraryStandIns(scroller, layer);
  assert.equal(standIns.ready(), true);

  // A fast scroll, a hundred rows down: every tile of the plan shows something in the frame that asked.
  scrollTop = 100 * 36;
  let covered = standIns.update(frame());
  assert.equal(standInGap(covered, 100, 119 + 6 * 19), 0, "the viewport and six screens ahead are covered at once");
  assert.equal(layer.style.height, `${28 + 2000 * 36}px`, "the layer is the table's box, so no canvas lengthens the scroll range");
  settleFrames();
  const before = shown();
  assert.ok(before.length >= 6);
  assert.ok(before.every((canvas) => canvas.style.transform.startsWith("translate(0px, ")));
  assert.ok(before.every((canvas) => drawn.get(canvas)!.join() === "copy"), "a tile is one copy of the pattern");
  assert.ok([...drawn.values()].every((calls) => !calls.includes("text")), "no text is ever painted");
  assert.equal(standIns.takeStats().bars, before.length);

  // The same frame again, rows that arrive, a request to measure again with nothing changed: nothing is painted.
  standIns.update(frame());
  standIns.invalidate();
  standIns.update(frame());
  settleFrames();
  assert.equal(standIns.takeStats().bars, 0);
  assert.deepEqual(shown(), before);

  // A flick at 60 px/ms: half a second of travel ahead, all of it within two frames.
  covered = standIns.update(frame({ speed: 60 }));
  if (frames.length) frames.shift()!();
  covered = standIns.update(frame({ speed: 60 }));
  assert.equal(standInGap(covered, 100, 119 + 833), 0, "thirty thousand pixels ahead are covered");
  assert.ok(shown().length >= 30);
  assert.equal(standIns.takeStats().bars, shown().length - before.length, "only the new tiles are painted");

  // The list got shorter under the viewport: the last tile ends with the table.
  scrollTop = 600 * 36;
  covered = standIns.update(frame({ speed: 5, count: 700 }));
  settleFrames();
  assert.equal(standInGap(covered, 600, 700), 0);
  assert.ok(covered.every(([, end]) => end <= 700));

  // The scroll slowed down and the table built its rows here. The tiles around the viewport fade
  // out over them; those further away go at once.
  standIns.update(frame({ speed: 5 }));
  settleFrames();
  assert.ok(shown().length >= 6);
  assert.equal(standIns.settle(), true);
  assert.ok(leaving().length >= 1 && leaving().length <= 3, `only the tiles a screen either side of the viewport fade (${leaving().length})`);
  assert.deepEqual(shown(), leaving());
  // While they fade, the table asking for its resting state takes nothing away…
  const fading = leaving();
  covered = standIns.update(frame({ direction: 0, windowStart: 560, windowEnd: 680 }));
  assert.deepEqual(covered, [[560, 680]]);
  assert.deepEqual(shown(), fading);
  // …and the fade ends on the clock of a surface that leaves.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(shown().length, 0);
  assert.equal(leaving().length, 0);

  // A second fling while the stand-ins fade: they are bars again at once, none of them fading.
  standIns.update(frame({ speed: 5 }));
  settleFrames();
  assert.equal(standIns.settle(), true);
  covered = standIns.update(frame({ speed: 20, windowStart: 560, windowEnd: 680 }));
  assert.equal(leaving().length, 0);
  assert.equal(standInGap(covered, 600, 619 + 6 * 19), 0);
  assert.ok(shown().length >= 6);

  // Reduced motion: nothing fades, the stand-ins are simply gone.
  reducedMotion = true;
  assert.equal(standIns.settle(), false);
  assert.equal(shown().length, 0);
  reducedMotion = false;

  // A table that builds its own rows holds no canvas on show.
  covered = standIns.update(frame({ direction: 0, windowStart: 560, windowEnd: 680 }));
  assert.equal(shown().length, 0);
  assert.deepEqual(covered, [[560, 680]]);
  assert.equal(standIns.settle(), false, "nothing on show, nothing to fade");
  standIns.destroy();
  assert.equal(canvases().length, 0);
});
