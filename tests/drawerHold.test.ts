import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { DRAWER_HOLD_LIMIT_MS, heldDrawerFront, holdDrawer, releaseDrawerHolds, useDrawerHold } from "../src/lib/drawerHold";
import {
  flushTossHandovers, SHEET_DOWN_MS, TOSS_HANDOVER_LEAD_MS, TOSS_HANDOVER_LIMIT_MS, TOSS_LIFT_MS, TOSS_POP_MS, tossArc, tossFlightMs,
  tossHandover, tossHandoverAt, tossRise, waitingTossHandovers,
} from "../src/lib/tossPath";

const held = () => useDrawerHold.getState().heldApp;

test("a hold keeps the drawer on its app until it is released, and releasing twice is harmless", () => {
  const release = holdDrawer("downloads");
  assert.equal(held(), "downloads");
  release();
  assert.equal(held(), null);
  release();
  assert.equal(held(), null);
  assert.deepEqual(useDrawerHold.getState().holds, []);
});

test("overlapping parcels hold together: the drawer is free only after the last one lands", () => {
  const first = holdDrawer("downloads");
  const second = holdDrawer("downloads");
  first();
  assert.equal(held(), "downloads");
  second();
  assert.equal(held(), null);
});

test("a hold nobody releases lets go by itself", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const release = holdDrawer("downloads");
    mock.timers.tick(DRAWER_HOLD_LIMIT_MS - 1);
    assert.equal(held(), "downloads");
    mock.timers.tick(1);
    assert.equal(held(), null);
    release();
    assert.equal(held(), null);
  } finally {
    mock.timers.reset();
  }
});

test("an app that refuses to be covered drops every hold at once", () => {
  const first = holdDrawer("downloads");
  const second = holdDrawer("downloads");
  releaseDrawerHolds();
  assert.equal(held(), null);
  first();
  second();
  assert.equal(held(), null);
});

test("while held, another app that is asked for waits; after the release the latest request wins", () => {
  // The user opens the lyrics while the parcel flies: both are open, the lyrics were asked for last.
  assert.equal(heldDrawerFront("lyrics", "downloads", ["downloads", "lyrics"], "downloads"), "downloads");
  assert.equal(heldDrawerFront("lyrics", null, ["downloads", "lyrics"], null), "lyrics");
  // Then the settings on top of that: still the downloads until the release, then the settings.
  assert.equal(heldDrawerFront("settings", "downloads", ["downloads", "lyrics", "settings"], "downloads"), "downloads");
  assert.equal(heldDrawerFront("settings", null, ["lyrics", "settings"], null), "settings");
});

test("closing the drawer while held keeps the sheet that was shown until the release", () => {
  // The downloads were closed during the flight; their last description is still kept.
  assert.equal(heldDrawerFront(null, "downloads", [], "downloads"), "downloads");
  assert.equal(heldDrawerFront(null, null, [], null), null);
});

test("a hold on an app that was never shown changes nothing", () => {
  assert.equal(heldDrawerFront("lyrics", "downloads", ["lyrics"], null), "lyrics");
  assert.equal(heldDrawerFront(null, "downloads", [], null), null);
});

test("the flight is a parabola from the source to the target that tops out above both", () => {
  for (const [from, to] of [
    [{ x: 420, y: 520 }, { x: 1180, y: 240 }],
    [{ x: 420, y: 180 }, { x: 1180, y: 560 }],
    [{ x: 1300, y: 40 }, { x: 1150, y: 260 }],
    [{ x: 600, y: 300 }, { x: 900, y: 300 }],
  ] as const) {
    const rise = tossRise(from, to, false);
    const arc = tossArc(from, to, rise, 24);
    assert.equal(arc.length, 25);
    assert.ok(arc[0].x === 0 && arc[0].y === 0);
    assert.ok(Math.abs(arc[24].x - (to.x - from.x)) < 1e-6 && Math.abs(arc[24].y - (to.y - from.y)) < 1e-6);
    // Constant horizontal speed, constant vertical acceleration (the second difference is one number).
    const second = arc.slice(2).map((point, index) => point.y - 2 * arc[index + 1].y + arc[index].y);
    assert.ok(second.every(value => Math.abs(value - second[0]) < 1e-6) && second[0] > 0);
    assert.ok(arc.slice(1).every((point, index) => Math.abs(point.x - arc[index].x - (to.x - from.x) / 24) < 1e-6));
    const top = Math.min(...arc.map(point => from.y + point.y));
    assert.ok(Math.abs(top - (Math.min(from.y, to.y) - rise)) < 2, `top ${top} for rise ${rise}`);
    assert.ok(top >= 0);
  }
});

test("a hop from a drop point rises less than a throw, and nothing leaves the window", () => {
  const from = { x: 1200, y: 400 }, to = { x: 1180, y: 300 };
  assert.ok(tossRise(from, to, true) < tossRise({ x: 300, y: 400 }, to, false));
  assert.ok(tossRise({ x: 600, y: 14 }, { x: 900, y: 30 }, false) <= 8);
});

test("the parcel lands just after the sheet has settled, within the planned total", () => {
  // The sheet starts with the toss; the flight starts when the block has turned into the parcel.
  const sheetLeft = SHEET_DOWN_MS - TOSS_LIFT_MS;
  for (const distance of [120, 500, 900, 1600]) {
    const flight = tossFlightMs(distance, sheetLeft, false);
    assert.ok(TOSS_LIFT_MS + flight > SHEET_DOWN_MS, `lands after the sheet at ${distance}px`);
    assert.ok(TOSS_LIFT_MS + flight >= 600 && TOSS_LIFT_MS + flight <= 800, `total ${TOSS_LIFT_MS + flight}`);
  }
  assert.ok(tossFlightMs(80, 0, true) <= 300);
  assert.ok(tossFlightMs(80, 430, true) >= 490);
});

/** Lets the promise callbacks that are already due run. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("the download is handed over shortly before touchdown, not at launch", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const [distance, hop] of [[120, false], [900, false], [1600, false], [80, true], [400, true]] as const) {
      const flight = tossFlightMs(distance, 0, hop);
      const at = tossHandoverAt(flight);
      assert.equal(flight - at, TOSS_HANDOVER_LEAD_MS, "a fixed lead before the landing");
      assert.ok(at >= flight / 2, `in the second half of a ${flight}ms flight`);
      const handover = tossHandover();
      let handed = 0;
      void handover.ready.then(() => { handed += 1; });
      // The parcel lifts off first; nothing is handed over while it does.
      mock.timers.tick(hop ? TOSS_POP_MS : TOSS_LIFT_MS);
      await settle();
      assert.equal(handed, 0);
      handover.within(at);
      mock.timers.tick(at - 1);
      await settle();
      assert.equal(handed, 0, "still in the air");
      mock.timers.tick(1);
      await settle();
      assert.equal(handed, 1);
      assert.ok(handover.delivered());
      // The flight's end, a failure and a flush all deliver again: nothing is enqueued twice.
      handover.deliver();
      handover.within(0);
      flushTossHandovers();
      mock.timers.tick(TOSS_HANDOVER_LIMIT_MS);
      await settle();
      assert.equal(handed, 1);
    }
  } finally {
    mock.timers.reset();
  }
});

test("a flight that never reports back still hands the download over, inside the drawer's hold", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // The longest flight reaches its handover before the limit, and the limit lies inside the hold.
    assert.ok(TOSS_LIFT_MS + tossHandoverAt(tossFlightMs(4000, SHEET_DOWN_MS, false)) < TOSS_HANDOVER_LIMIT_MS);
    assert.ok(TOSS_HANDOVER_LIMIT_MS < DRAWER_HOLD_LIMIT_MS);
    const release = holdDrawer("downloads");
    const handover = tossHandover();
    let handed = 0;
    void handover.ready.then(() => { handed += 1; });
    mock.timers.tick(TOSS_HANDOVER_LIMIT_MS - 1);
    await settle();
    assert.equal(handed, 0);
    mock.timers.tick(1);
    await settle();
    assert.equal(handed, 1, "handed over at the limit although no flight was ever scheduled");
    assert.equal(held(), "downloads", "the drawer is still held at that moment");
    release();
  } finally {
    mock.timers.reset();
  }
});

test("a flight that ends early, a hidden window or a closing one hand over at once", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const early = tossHandover();
    const first = tossHandover();
    const second = tossHandover();
    const order: string[] = [];
    void early.ready.then(() => order.push("early"));
    void first.ready.then(() => order.push("first"));
    void second.ready.then(() => order.push("second"));
    assert.equal(waitingTossHandovers(), 3);
    // The parcel found nowhere to land.
    early.deliver();
    await settle();
    assert.deepEqual(order, ["early"]);
    assert.equal(waitingTossHandovers(), 2);
    // pagehide / visibilitychange: every download still waiting goes now, in the order asked.
    first.within(400);
    flushTossHandovers();
    await settle();
    assert.deepEqual(order, ["early", "first", "second"]);
    assert.equal(waitingTossHandovers(), 0);
    mock.timers.tick(TOSS_HANDOVER_LIMIT_MS);
    await settle();
    assert.deepEqual(order, ["early", "first", "second"]);
  } finally {
    mock.timers.reset();
  }
});
