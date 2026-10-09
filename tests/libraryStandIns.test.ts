import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { STAND_IN_TILE_ROWS, createLibraryStandIns, standInGap, standInPlan, type StandInFrame, type StandInPlanInput } from "../src/lib/libraryStandIns";

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

test("a faster scroll reaches further ahead, up to a limit, and only the near screens are worth their text", () => {
  const at = (lead: number, direction: -1 | 1 = 1) => standInPlan({ ...base, top: 1000 * 36, direction, lead });
  const reach = (plan: ReturnType<typeof standInPlan>, direction: -1 | 1) => direction > 0
    ? Math.max(...plan.map((tile) => tile.end)) - 1019 : 1000 - Math.min(...plan.map((tile) => tile.start));
  assert.ok(reach(at(0), 1) >= 6 * 19 && reach(at(0), 1) < 6 * 19 + STAND_IN_TILE_ROWS, "six screens whatever the speed");
  // 60 px/ms for half a second: 30,000 px, 833 rows.
  for (const direction of [-1, 1] as const) {
    const far = at(30_000, direction);
    assert.ok(reach(far, direction) >= 833 && reach(far, direction) < 833 + STAND_IN_TILE_ROWS);
    assert.equal(standInGap(far.map((tile) => [tile.shownStart, tile.shownEnd] as const), direction > 0 ? 1000 : 1000 - 833, direction > 0 ? 1019 + 833 : 1019), 0);
    assert.ok(far.filter((tile) => tile.near).length <= 9 && far.some((tile) => tile.near) && far.some((tile) => !tile.near));
    assert.ok(far.every((tile) => !tile.urgent || tile.near));
  }
  assert.ok(reach(at(10_000_000), 1) <= 65 * STAND_IN_TILE_ROWS, "no more than the limit of tiles");
  assert.equal(standInPlan({ ...base, top: 1000 * 36, direction: 0, lead: 30_000, windowStart: 900, windowEnd: 1100 }).length, 0);
  assert.equal(standInGap([[0, 5], [8, 12]], 3, 10), 3);
});

test("tiles are repainted in place when rows arrive, hidden only when the order changes, and never reach past the table", () => {
  const dom = new JSDOM(`<!doctype html><html><body><div class="kd-scroll"><table class="kd-table"><thead><tr><th>t</th></tr></thead>
    <tbody><tr data-kd-track-id="1"><td data-col="title"><span><span class="kd-thumb"></span>Song</span></td><td data-col="bpm">128</td></tr></tbody>
    </table><div class="layer"></div></div></body></html>`, { url: "http://localhost" });
  const frames: (() => void)[] = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, localStorage: dom.window.localStorage,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: () => void) => frames.push(callback), cancelAnimationFrame: () => {} });
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
  const texts = new Map<HTMLCanvasElement, string[]>();
  dom.window.HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    const drawn: string[] = [];
    texts.set(this, drawn);
    return { setTransform() {}, clearRect() { drawn.length = 0; }, fillText(text: string) { drawn.push(text); }, drawImage() { drawn.push("(bars)"); },
      beginPath() {}, rect() {}, fill() {}, fillRect() {}, roundRect() {}, save() {}, restore() {}, clip() {} };
  } as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;

  const loaded = new Set<number>();
  for (let row = 0; row < 150; row += 1) loaded.add(row);
  const frame = (over: Partial<StandInFrame> = {}): StandInFrame => ({ rowHeight: 36, count: 2000, first: 0, windowStart: 0, windowEnd: 60, direction: 1, speed: 5,
    version: ["order"], data: "first batch", text: (row, column) => loaded.has(row) ? `${column} ${row}` : undefined, ...over });
  const canvases = () => [...layer.querySelectorAll("canvas")];
  const shown = () => canvases().filter((canvas) => canvas.style.display !== "none");
  const settle = () => { while (frames.length) frames.shift()!(); };
  const standIns = createLibraryStandIns(scroller, layer);
  assert.equal(standIns.ready(), true);

  // A fast scroll, a hundred rows down: every tile of the plan shows something in the frame that asked.
  scrollTop = 100 * 36;
  let covered = standIns.update(frame());
  assert.equal(standInGap(covered, 100, 119 + 6 * 19), 0, "the viewport and six screens ahead are covered at once");
  assert.equal(layer.style.height, `${28 + 2000 * 36}px`, "the layer is the table's box, so no canvas lengthens the scroll range");
  settle();
  assert.ok(shown().length >= 6);
  assert.ok(shown().every((canvas) => canvas.style.transform.startsWith("translate(0px, ")));
  assert.ok([...texts.values()].some((drawn) => drawn.includes("title 100")));
  assert.ok(shown().every((canvas) => !texts.get(canvas)!.includes("(bars)")), "at a readable speed the near screens are text");
  assert.ok([...texts.values()].every((drawn) => !drawn.includes("title 150")), "rows that have not loaded have no text yet");

  // The next batch of rows arrives: nothing on show is hidden, and the new text is painted.
  const before = shown();
  for (let row = 150; row < 400; row += 1) loaded.add(row);
  standIns.update(frame({ data: "second batch" }));
  assert.deepEqual(shown(), before, "arriving rows never blank a tile");
  settle();
  assert.deepEqual(shown(), before);
  assert.ok([...texts.values()].some((drawn) => drawn.includes("title 150")));

  // Being asked to measure again with nothing changed repaints nothing.
  const paints = [...texts.values()].map((drawn) => drawn.length);
  standIns.invalidate();
  standIns.update(frame({ data: "second batch" }));
  settle();
  assert.deepEqual([...texts.values()].map((drawn) => drawn.length), paints);
  assert.deepEqual(shown(), before);

  // A new order: what the tiles show is wrong, so those out of sight wait hidden for their turn.
  standIns.update(frame({ data: "second batch", version: ["another order"] }));
  assert.ok(shown().length < before.length && shown().length >= 1);
  assert.equal(standInGap(standIns.update(frame({ data: "second batch", version: ["another order"] })), 100, 119), 0);
  settle();
  assert.equal(shown().length, before.length);

  // A flick at 60 px/ms: half a second of travel ahead, as bars, all of it within two frames; no text is painted.
  const order = { data: "second batch", version: ["another order"] };
  const textTiles = shown().length;
  covered = standIns.update(frame({ ...order, speed: 60 }));
  if (frames.length) frames.shift()!();
  covered = standIns.update(frame({ ...order, speed: 60 }));
  assert.equal(standInGap(covered, 100, 119 + 833), 0, "thirty thousand pixels ahead are covered");
  assert.ok(shown().length >= 30);
  assert.equal(shown().filter((canvas) => texts.get(canvas)!.includes("(bars)")).length, shown().length - textTiles, "every new tile is bars");
  assert.deepEqual(standIns.takeStats().bars, shown().length - textTiles);
  // The next batch does not touch bars; slowing down turns the near screens into text again.
  standIns.takeStats();
  scrollTop = 600 * 36;
  standIns.update(frame({ ...order, speed: 60 }));
  settle();
  assert.equal(standIns.takeStats().text, 0, "nothing is read at that speed");
  for (let row = 400; row < 2000; row += 1) loaded.add(row);
  standIns.update(frame({ ...order, data: "third batch", speed: 60 }));
  settle();
  assert.equal(standIns.takeStats().text, 0, "arriving rows repaint no bars");
  covered = standIns.update(frame({ ...order, data: "third batch", speed: 5 }));
  assert.equal(standInGap(covered, 600, 619 + 6 * 19), 0);
  settle();
  assert.ok([...texts.values()].some((drawn) => drawn.includes("title 600")), "the viewport reads as text again");
  assert.ok(shown().every((canvas) => !texts.get(canvas)!.includes("(bars)")));

  // The scroll slowed down and the table built its rows here: no canvas stays on show.
  covered = standIns.update(frame({ ...order, data: "third batch", direction: 0, windowStart: 560, windowEnd: 680 }));
  assert.equal(shown().length, 0);
  assert.deepEqual(covered, [[560, 680]]);
  standIns.destroy();
  assert.equal(canvases().length, 0);
});
