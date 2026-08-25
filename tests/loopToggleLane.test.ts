import assert from "node:assert/strict";
import test from "node:test";
import { LoopToggleParity } from "../src/lib/loopToggleLane";

test("queued loop clicks collapse by parity instead of replaying every stale generation", () => {
  const lane = new LoopToggleParity();
  lane.push();
  lane.push();
  assert.equal(lane.consume(), false, "two queued clicks preserve the current state");

  lane.push();
  lane.push();
  lane.push();
  assert.equal(lane.consume(), true, "three queued clicks become one native toggle");
  assert.equal(lane.consume(), false, "a consumed burst cannot replay later");
});

test("an explicit resize/load boundary clears queued loop parity", () => {
  const lane = new LoopToggleParity();
  lane.push();
  lane.clear();
  assert.equal(lane.consume(), false);
});
