import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  adoptRail, clearRail, RAIL_TURN_STEPS, railTarget, settleRail, startRail, turnRail, type RailTurn,
} from "../src/components/chrome/railTurn";

const picture = (turn: RailTurn) => turn.slots.map((slot) => `${slot.key}:${slot.phase}${slot.phase === "stay" ? "" : slot.step}`).join(" ");
const idOf = (turn: RailTurn, key: string) => turn.slots.find((slot) => slot.key === key && slot.phase !== "out")?.id;
/** A strip at rest that shows `keys`. */
const resting = (...keys: string[]) => settleRail(clearRail(startRail(keys)));

test("a new strip lays its items out, the first one first", () => {
  const start = startRail(["glyph", "name", "count"]);
  assert.equal(start.stage, "out");
  assert.equal(picture(start), "", "nothing is on the strip before the first stage has ended");
  const laid = clearRail(start);
  assert.equal(laid.stage, "in");
  assert.equal(picture(laid), "glyph:in0 name:in1 count:in2");
  const rest = settleRail(laid);
  assert.equal(rest.stage, "rest");
  assert.equal(picture(rest), "glyph:stay name:stay count:stay");
});

test("a turn takes away what goes, the last one first, and only then lays out what comes", () => {
  const idle = resting("glyph", "name", "count", "tools");
  const tools = idOf(idle, "tools");
  const turning = turnRail(idle, ["wave", "progress", "mode", "tools"]);
  assert.equal(turning.stage, "out");
  // The count was laid out last of the three, so it is the first to go; the tools stay put.
  assert.equal(picture(turning), "glyph:out2 name:out1 count:out0 tools:stay");
  assert.deepEqual(railTarget(turning), ["wave", "progress", "mode", "tools"]);
  assert.equal(turning.slots.some((slot) => slot.key === "wave"), false, "the new items wait for the pictures");

  const laid = clearRail(turning);
  assert.equal(laid.stage, "in");
  assert.equal(picture(laid), "wave:in0 progress:in1 mode:in2 tools:stay");
  assert.equal(idOf(laid, "tools"), tools, "an item that is wanted before and after is the same slot");
  assert.equal(picture(settleRail(laid)), "wave:stay progress:stay mode:stay tools:stay");
});

test("the same keys are not a turn, whatever the items say", () => {
  const analysing = resting("wave", "progress", "mode");
  // 「正在分析 3/4 首 · a.wav」 → 「正在分析 4/4 首 · b.wav」 is the same item with other text.
  assert.equal(turnRail(analysing, ["wave", "progress", "mode"]), analysing);
  const turning = turnRail(analysing, ["glyph", "name"]);
  assert.equal(turnRail(turning, ["glyph", "name"]), turning, "nor is asking again for what is already on its way");
});

test("only the item that changed turns: another folder rolls the name over and keeps the glyph", () => {
  const before = resting("glyph", "name:a", "count:a", "tools");
  const glyph = idOf(before, "glyph");
  const turning = turnRail(before, ["glyph", "name:b", "count:b", "tools"]);
  assert.equal(picture(turning), "glyph:stay name:a:out1 count:a:out0 tools:stay");
  const laid = clearRail(turning);
  assert.equal(picture(laid), "glyph:stay name:b:in0 count:b:in1 tools:stay");
  assert.equal(idOf(laid, "glyph"), glyph);
});

test("a change with nothing to take away still passes the first stage, so what stays can be measured", () => {
  const scanning = resting("scan", "scan-text");
  const more = turnRail(scanning, ["scan", "scan-text", "wave", "progress"]);
  assert.equal(more.stage, "out");
  assert.equal(picture(more), "scan:stay scan-text:stay");
  assert.equal(picture(clearRail(more)), "scan:stay scan-text:stay wave:in0 progress:in1");
  // Only removals: the turn ends when the pictures are gone.
  const less = clearRail(turnRail(scanning, ["scan"]));
  assert.equal(less.stage, "rest");
  assert.equal(picture(less), "scan:stay");
});

test("a second change during the leaving joins it", () => {
  const idle = resting("glyph", "name:a", "tools");
  const first = turnRail(idle, ["glyph", "name:b", "tools"]);
  // The user is already somewhere else: the selection takes the strip before name:b was laid out.
  const second = turnRail(first, ["sel", "selection"]);
  assert.equal(second.beat, first.beat + 1, "the rail waits anew: more is leaving now");
  assert.equal(picture(second), "glyph:out1 name:a:out0 tools:out0");
  assert.equal(picture(clearRail(second)), "sel:in0 selection:in1", "name:b never appeared");
});

test("a key that leaves and is wanted again is a new slot behind its own picture", () => {
  const idle = resting("glyph", "name:a");
  const old = idOf(idle, "name:a");
  const away = turnRail(idle, ["glyph", "name:b"]);
  const back = turnRail(away, ["glyph", "name:a"]);
  assert.equal(picture(back), "glyph:stay name:a:out0", "the picture goes on leaving");
  const laid = clearRail(back);
  assert.equal(picture(laid), "glyph:stay name:a:in0");
  assert.notEqual(idOf(laid, "name:a"), old, "the returning item is not the inert picture brought back");
});

test("a change while items arrive: what is unwanted leaves at once, what is wanted goes on arriving", () => {
  const laid = clearRail(turnRail(resting("glyph"), ["glyph", "name", "count"]));
  assert.equal(picture(laid), "glyph:stay name:in0 count:in1");
  const name = idOf(laid, "name");
  const changed = turnRail(laid, ["glyph", "name", "mode"]);
  assert.equal(picture(changed), "glyph:stay name:in0 count:out0");
  const next = clearRail(changed);
  assert.equal(picture(next), "glyph:stay name:in0 mode:in0");
  assert.equal(idOf(next, "name"), name, "its arrival is not started again");
  assert.equal(picture(settleRail(next)), "glyph:stay name:stay mode:stay");
});

test("a stage that was overtaken does not end the turn that replaced it", () => {
  const idle = resting("a");
  const turning = turnRail(idle, ["b"]);
  assert.equal(settleRail(turning), turning, "nothing is arriving");
  const laid = clearRail(turning);
  assert.equal(clearRail(laid), laid, "nothing is leaving");
});

test("a long strip turns as fast as a short one", () => {
  const keys = Array.from({ length: 9 }, (_, index) => `k${index}`);
  const laid = clearRail(startRail(keys));
  assert.deepEqual(laid.slots.map((slot) => slot.step), [0, 1, 2, 3, 3, 3, 3, 3, 3]);
  assert.equal(Math.max(...laid.slots.map((slot) => slot.step)), RAIL_TURN_STEPS);
  const leaving = turnRail(settleRail(laid), []);
  assert.deepEqual(leaving.slots.map((slot) => slot.step), [3, 3, 3, 3, 3, 3, 2, 1, 0]);

  // On the schema's clock: the last picture is out, then the last item is in, within 450 ms.
  const css = fs.readFileSync(new URL("../src/motion.css", import.meta.url), "utf8");
  const ms = (name: string) => Number(new RegExp(`--kd-motion-${name}:\\s*(\\d+)ms`).exec(css)![1]);
  const full = ms("micro-out") + ms("micro") + 2 * RAIL_TURN_STEPS * ms("turn-gap");
  assert.ok(full <= 450, `a full turn takes ${full}ms`);
  assert.equal(ms("micro-out") + ms("micro") + 2 * 2 * ms("turn-gap"), 366, "three items for three");
  // The gesture is the schema's: transform and opacity on the shared tokens, both ways.
  for (const mark of ["out", "in"]) {
    const rule = new RegExp(`\\[data-kd-turn="${mark}"\\]\\s*\\{([^}]*)\\}`).exec(css)![1];
    assert.match(rule, new RegExp(`kd-motion-turn-${mark} var\\(--kd-motion-micro${mark === "out" ? "-out" : ""}\\)`));
    assert.match(rule, /var\(--kd-turn-step, 0\) \* var\(--kd-motion-turn-gap\)/);
  }
});

test("a rail that takes the strip over lets the other rail's items leave, then lays out all of its own", () => {
  // The online rail was mounted but hidden; it holds its items (and their state) already.
  const hidden = resting("mark", "title", "collapse");
  const collapse = idOf(hidden, "collapse");
  const taken = adoptRail(hidden, ["picture:1", "picture:2", "picture:3"]);
  assert.equal(taken.stage, "out");
  assert.equal(picture(taken), "picture:1:out2 picture:2:out1 picture:3:out0 mark:wait0 title:wait0 collapse:wait0");
  assert.deepEqual(railTarget(taken), ["mark", "title", "collapse"]);
  const laid = clearRail(taken);
  assert.equal(picture(laid), "mark:in0 title:in1 collapse:in2");
  assert.equal(idOf(laid, "collapse"), collapse, "its own items were kept mounted while they waited");
  assert.equal(new Set(taken.slots.map((slot) => slot.id)).size, taken.slots.length, "pictures and own items never share an id");

  // Its content changes while the pictures leave: an item that waited and is not wanted is dropped, not shown leaving.
  const changed = turnRail(taken, ["mark", "other", "collapse"]);
  assert.equal(picture(changed), "picture:1:out2 picture:2:out1 picture:3:out0 mark:wait0 collapse:wait0");
  assert.equal(picture(clearRail(changed)), "mark:in0 other:in1 collapse:in2");

  // Taking over once more while the pictures leave (React's StrictMode replays the effect) keeps them.
  assert.equal(picture(adoptRail(taken, [])), picture(taken));
  assert.deepEqual(railTarget(adoptRail(taken, [])), ["mark", "title", "collapse"]);

  // Shown again with nobody to take over from: still laid out anew.
  assert.equal(picture(clearRail(adoptRail(hidden, []))), "mark:in0 title:in1 collapse:in2");
});
