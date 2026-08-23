import assert from "node:assert/strict";
import test from "node:test";
import {
  isDualDeckSession,
  parseWorkMode,
  readWorkMode,
  shouldDriveGlobalTransport,
  shouldReconcileSingleTrackOwner,
  WORK_MODE_STORAGE_KEY,
  writeWorkMode,
} from "../src/lib/workMode";

test("work mode accepts DJ and falls back to manager", () => {
  assert.equal(parseWorkMode("dj"), "dj");
  assert.equal(parseWorkMode("manager"), "manager");
  assert.equal(parseWorkMode("unknown"), "manager");
});

test("DJ mode never runs the manager single-track owner reconciliation", () => {
  assert.equal(shouldReconcileSingleTrackOwner("manager"), true);
  assert.equal(shouldReconcileSingleTrackOwner("dj"), false);
  assert.equal(shouldDriveGlobalTransport("manager"), true);
  assert.equal(shouldDriveGlobalTransport("dj"), false);
});

test("manager with Performance popped open is a dual-deck session", () => {
  assert.equal(isDualDeckSession("manager"), false);
  assert.equal(isDualDeckSession("manager", false), false);
  assert.equal(isDualDeckSession("manager", true), true);
  assert.equal(isDualDeckSession("dj", false), true);
  assert.equal(shouldReconcileSingleTrackOwner("manager", true), false);
  assert.equal(shouldDriveGlobalTransport("manager", true), false);
});

test("work mode storage round trips without owning application state", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };

  writeWorkMode("dj", storage);
  assert.equal(values.get(WORK_MODE_STORAGE_KEY), "dj");
  assert.equal(readWorkMode(storage), "dj");
});

test("unavailable storage safely uses manager mode", () => {
  assert.equal(readWorkMode({ getItem: () => { throw new Error("blocked"); } }), "manager");
  assert.doesNotThrow(() => writeWorkMode("dj", { setItem: () => { throw new Error("blocked"); } }));
});
