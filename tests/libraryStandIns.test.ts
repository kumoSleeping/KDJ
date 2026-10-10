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

test("tiles are bars copied from one pattern, never text; they are wiped away ahead of the rows that caught up and never reach past the table", async () => {
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

  // The scroll slowed down and the table built its rows here; they arrive from row 600 downwards,
  // fourteen of them one after the other. The tiles around the viewport are wiped away ahead of
  // them; those further away, and whatever lies behind the first arriving row, go at once.
  const down = { row: 600, direction: 1, rows: 14 } as const;
  const wipe = (canvas: HTMLCanvasElement) => ["from", "to", "wait", "share"].map((name) => canvas.style.getPropertyValue(`--kd-wipe-${name}`));
  const tileAt = (row: number) => shown().find((canvas) => canvas.style.transform === `translate(0px, ${28 + Math.floor(row / STAND_IN_TILE_ROWS) * STAND_IN_TILE_ROWS * 36}px)`)!;
  standIns.update(frame({ speed: 5 }));
  settleFrames();
  assert.ok(shown().length >= 6);
  assert.ok(tileAt(590), "a screen behind a fast scroll is covered");
  assert.equal(standIns.settle(down), true);
  assert.equal(leaving().length, 2, "the tile under the viewport and the next one");
  assert.deepEqual(shown(), leaving());
  // Rows 600…623 are one tile: bars leave rows 600…613 at the pace the rows start, over the whole of the time; the rest waits for the last beat.
  assert.deepEqual(wipe(tileAt(600)), ["inset(0px 0 0px 0)", `inset(${14 * 36}px 0 0px 0)`, "0.000", "1.000"]);
  assert.deepEqual(wipe(tileAt(624)), ["inset(0px 0 0px 0)", "inset(0px 0 0px 0)", "1.000", "0.000"], "rows past the cascade keep their bars until it is over");
  // While they leave, the table asking for its resting state takes nothing away…
  const fading = leaving();
  covered = standIns.update(frame({ direction: 0, windowStart: 560, windowEnd: 680 }));
  assert.deepEqual(covered, [[560, 680]]);
  assert.deepEqual(shown(), fading);
  // …and it is over on the clock of a surface that leaves; nothing of it stays on a canvas.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(shown().length, 0);
  assert.equal(leaving().length, 0);
  assert.ok(canvases().every((canvas) => !canvas.style.getPropertyValue("--kd-wipe-from") && !canvas.style.getPropertyValue("--kd-wipe-to")));

  // Towards the top the rows arrive from the bottom one upwards (row 618 first): the wipe runs the other way.
  standIns.update(frame({ speed: 5, direction: -1, windowStart: 900, windowEnd: 1000 }));
  settleFrames();
  assert.equal(standIns.settle({ row: 618, direction: -1, rows: 14 }), true);
  assert.deepEqual(wipe(tileAt(600)), [`inset(0px 0 ${5 * 36}px 0)`, `inset(0px 0 ${19 * 36}px 0)`, "0.000", "1.000"], "rows 619…623 lie behind the scroll; 605…618 are passed");
  assert.deepEqual(wipe(tileAt(590)), ["inset(0px 0 0px 0)", "inset(0px 0 0px 0)", "1.000", "0.000"]);
  // A wipe that crosses from one tile into the next: each takes its share of the time, one after the other.
  await new Promise((resolve) => setTimeout(resolve, 150));
  standIns.update(frame({ speed: 5 }));
  settleFrames();
  assert.equal(standIns.settle({ row: 616, direction: 1, rows: 14 }), true);
  assert.deepEqual(wipe(tileAt(600)), [`inset(${16 * 36}px 0 0px 0)`, `inset(${24 * 36}px 0 0px 0)`, "0.000", "0.571"], "rows 616…623: eight of the fourteen, first");
  assert.deepEqual(wipe(tileAt(624)), ["inset(0px 0 0px 0)", `inset(${6 * 36}px 0 0px 0)`, "0.571", "0.429"], "rows 624…629: the other six, after them");
  assert.equal(shown().every((canvas) => canvas.style.transform !== tileAt(600).style.transform || canvas === tileAt(600)), true);

  // A second fling while the stand-ins leave: they are bars again at once, none of them leaving.
  covered = standIns.update(frame({ speed: 20, windowStart: 560, windowEnd: 580 }));
  assert.equal(leaving().length, 0);
  assert.equal(standInGap(covered, 600, 619 + 6 * 19), 0);
  assert.ok(shown().length >= 6);
  assert.ok(shown().every((canvas) => !canvas.style.getPropertyValue("--kd-wipe-from")));

  // Reduced motion: nothing is wiped, the stand-ins are simply gone.
  reducedMotion = true;
  assert.equal(standIns.settle(down), false);
  assert.equal(shown().length, 0);
  reducedMotion = false;

  // A table that builds its own rows holds no canvas on show.
  covered = standIns.update(frame({ direction: 0, windowStart: 560, windowEnd: 680 }));
  assert.equal(shown().length, 0);
  assert.deepEqual(covered, [[560, 680]]);
  assert.equal(standIns.settle(down), false, "nothing on show, nothing to wipe");
  standIns.destroy();
  assert.equal(canvases().length, 0);
});
