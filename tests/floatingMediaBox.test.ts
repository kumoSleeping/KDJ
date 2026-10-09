import assert from "node:assert/strict";
import test from "node:test";
import {
  FLOAT_MEDIA_MARGIN,
  FLOAT_MOTION_PAD,
  defaultFloatRect,
  fitFloatRect,
  nearestFloatEdge,
  parseStoredFloatRect,
  planFloatSlide,
  resizeFloatRect,
  resolveFloatRect,
  serializeFloatRect,
  type FloatRect,
} from "../src/lib/floatingMediaBox";

const viewport = { width: 1440, height: 900 };
const wide = { ratio: 16 / 9 };
const tall = { ratio: 9 / 16 };
const platform = { ratio: 16 / 9, extraHeight: 36, minWidth: 360 };
const near = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `${actual} ≈ ${expected}`);

test("another picture opens with the remembered width and its own height", () => {
  const remembered: FloatRect = { x: 100, y: 80, w: 480, h: 270 };
  assert.deepEqual(resolveFloatRect(remembered, viewport, wide), remembered);
  const square = resolveFloatRect(remembered, viewport, { ratio: 1 });
  assert.deepEqual(square, { x: 100, y: 80, w: 480, h: 480 });
});

test("the edge nearer to its side of the viewport is the one that stays", () => {
  // Parked bottom-right: the right and bottom edges hold, the box grows up and to the left.
  const remembered: FloatRect = { x: 1072, y: 618, w: 352, h: 198 };
  const portrait = resolveFloatRect(remembered, viewport, tall);
  near(portrait.w, 352);
  near(portrait.h, 352 * 16 / 9);
  near(portrait.x + portrait.w, 1072 + 352);
  near(portrait.y + portrait.h, 618 + 198);
  // The platform player's title strip is outside the picture and grows the same way.
  const embedded = resolveFloatRect(remembered, viewport, platform);
  near(embedded.w, 360);
  near(embedded.h, 360 * 9 / 16 + 36);
  near(embedded.x + embedded.w, 1072 + 352);
  near(embedded.y + embedded.h, 618 + 198);
});

test("opening never drifts: resolving is idempotent and remembers nothing", () => {
  const remembered: FloatRect = { x: 1010.4, y: 601.25, w: 413.7, h: 232.70625 };
  const frozen = { ...remembered };
  const a1 = resolveFloatRect(remembered, viewport, wide);
  const b = resolveFloatRect(remembered, viewport, tall);
  const a2 = resolveFloatRect(remembered, viewport, wide);
  assert.deepEqual(remembered, frozen);
  assert.deepEqual(a2, a1);
  assert.deepEqual(resolveFloatRect(a1, viewport, wide), a1, "a resolved box resolves to itself");
  assert.deepEqual(resolveFloatRect(b, viewport, tall), b);
  // A → B → A where each step is committed as if the user had nudged the window by nothing.
  assert.deepEqual(resolveFloatRect(resolveFloatRect(a1, viewport, tall), viewport, wide), a1);
});

test("a box that does not fit is clamped into the viewport without touching its memory", () => {
  const remembered: FloatRect = { x: 1072, y: 618, w: 352, h: 198 };
  const small = { width: 700, height: 420 };
  const shown = resolveFloatRect(remembered, small, wide);
  assert.ok(shown.x >= FLOAT_MEDIA_MARGIN && shown.x + shown.w <= small.width - FLOAT_MEDIA_MARGIN);
  assert.ok(shown.y >= FLOAT_MEDIA_MARGIN && shown.y + shown.h <= small.height - FLOAT_MEDIA_MARGIN);
  assert.deepEqual(resolveFloatRect(remembered, viewport, wide), remembered, "the larger window gets its place back");
  const huge = resolveFloatRect({ x: 0, y: 0, w: 5000, h: 2812.5 }, viewport, wide);
  near(huge.w, 1424);
  const tiny = resolveFloatRect({ x: 300, y: 300, w: 10, h: 5.625 }, viewport, wide);
  near(tiny.w, 240);
});

test("dragging and resizing keep the hand's corner", () => {
  const start: FloatRect = { x: 400, y: 300, w: 400, h: 225 };
  assert.deepEqual(fitFloatRect({ ...start, x: -50, y: 2000 }, viewport, wide), { x: 8, y: 900 - 225 - 8, w: 400, h: 225 });
  const east = resizeFloatRect(start, "e", 80, 0, viewport, wide);
  assert.deepEqual(east, { x: 400, y: 300, w: 480, h: 270 });
  const northWest = resizeFloatRect(start, "nw", -80, -10, viewport, wide);
  near(northWest.x + northWest.w, 800);
  near(northWest.y + northWest.h, 525);
  near(northWest.w, 480);
  const south = resizeFloatRect(start, "s", 0, 45, viewport, wide);
  near(south.h, 270);
  near(south.w, 480);
});

test("the default sits above the right end of the player bar", () => {
  const box = defaultFloatRect(viewport);
  assert.deepEqual(box, { x: 1072, y: 618, w: 352, h: 198 });
  assert.equal(nearestFloatEdge(box, viewport), "right");
  assert.equal(defaultFloatRect(viewport, 104).y, 900 - 104 - 16 - 198 - 8, "a taller bar lifts it");
});

test("stored boxes round-trip, keep unknown keys and reject damage", () => {
  const stored = parseStoredFloatRect('{"v":1,"x":12.5,"y":30,"w":400,"h":225,"future":{"pinned":true}}');
  assert.deepEqual(stored?.rect, { x: 12.5, y: 30, w: 400, h: 225 });
  assert.deepEqual(stored?.extra, { v: 1, future: { pinned: true } });
  const written = serializeFloatRect({ x: 13.123456, y: 30, w: 400, h: 225 }, stored?.extra);
  assert.deepEqual(JSON.parse(written), { v: 1, future: { pinned: true }, x: 13.12, y: 30, w: 400, h: 225 });
  assert.equal(serializeFloatRect(stored!.rect, stored!.extra), serializeFloatRect(stored!.rect, stored!.extra));
  for (const damaged of [null, "", "null", "[]", "{", '{"x":1,"y":2,"w":0,"h":3}', '{"x":"1","y":2,"w":3,"h":4}', '{"x":1,"y":2,"w":3}']) {
    assert.equal(parseStoredFloatRect(damaged), null, String(damaged));
  }
});

test("the nearest edge decides; a corner prefers its side, then the bottom", () => {
  const size = { w: 352, h: 198 };
  assert.equal(nearestFloatEdge({ x: 1080, y: 40, ...size }, viewport), "right");
  assert.equal(nearestFloatEdge({ x: 1080, y: 8.2, ...size }, viewport), "right", "8 and 8.2 tie, the side wins");
  assert.equal(nearestFloatEdge({ x: 8, y: 694, ...size }, viewport), "left");
  assert.equal(nearestFloatEdge({ x: 500, y: 20, ...size }, viewport), "top");
  assert.equal(nearestFloatEdge({ x: 500, y: 600, ...size }, viewport), "bottom");
  assert.equal(nearestFloatEdge({ x: 8, y: 8, w: 1424, h: 801 }, viewport), "right", "all four tie");
  assert.equal(nearestFloatEdge({ x: 544, y: 351, ...size }, viewport), "bottom", "a centred window leaves downwards");
});

test("the window slides in and out just beyond its nearest edge", () => {
  const box: FloatRect = { x: 1072, y: 618, w: 352, h: 198 };
  assert.deepEqual(planFloatSlide(box, viewport), { edge: "right", offset: { x: 16 + 352 + FLOAT_MOTION_PAD, y: 0 } });
  assert.deepEqual(planFloatSlide({ x: 500, y: 20, w: 352, h: 198 }, viewport),
    { edge: "top", offset: { x: 0, y: -(20 + 198 + FLOAT_MOTION_PAD) } });
  assert.deepEqual(planFloatSlide({ x: 8, y: 300, w: 352, h: 198 }, viewport).offset, { x: -(8 + 352 + FLOAT_MOTION_PAD), y: 0 });
  // A window caught halfway out keeps leaving by the edge of the place it rested in.
  assert.deepEqual(planFloatSlide({ ...box, x: 1300 }, viewport, box), { edge: "right", offset: { x: 1440 - 1300 + FLOAT_MOTION_PAD, y: 0 } });
  assert.deepEqual(planFloatSlide({ ...box, x: 1600 }, viewport, box).offset, { x: 0, y: 0 }, "already outside: nowhere left to go");
});
