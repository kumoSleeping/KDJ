import assert from "node:assert/strict";
import test from "node:test";

/** What the WebView has stored, with every write counted. */
function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: string[] = [];
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { writes.push(key); values.set(key, String(value)); },
      removeItem: (key: string) => { writes.push(key); values.delete(key); },
    },
  });
  return { values, writes };
}

import {
  SIDEBAR_TALL_KEY,
  SIDEBAR_WIDE_EXPANDED_KEY,
  SIDEBAR_WIDE_WIDTH_KEY,
  readSidebarState,
  sameSidebarState,
  writeSidebarState,
} from "../src/lib/sidebarShape";

test("the wide window reads the keys it always had", () => {
  storage({ [SIDEBAR_WIDE_EXPANDED_KEY]: "0", [SIDEBAR_WIDE_WIDTH_KEY]: "312" });
  assert.deepEqual(readSidebarState("wide", true), { expanded: false, width: 312 });

  storage();
  assert.deepEqual(readSidebarState("wide", true), { expanded: true, width: null });
  assert.deepEqual(readSidebarState("wide", false), { expanded: false, width: null });
});

test("a tall window with nothing of its own starts from the wide window's state, and reading writes nothing", () => {
  const { writes } = storage({ [SIDEBAR_WIDE_EXPANDED_KEY]: "1", [SIDEBAR_WIDE_WIDTH_KEY]: "280" });
  assert.deepEqual(readSidebarState("tall", true), { expanded: true, width: 280 });
  assert.deepEqual(writes, []);
});

test("an adjustment while tall is kept by the tall window alone", () => {
  const { values } = storage({ [SIDEBAR_WIDE_EXPANDED_KEY]: "1", [SIDEBAR_WIDE_WIDTH_KEY]: "280" });
  writeSidebarState("tall", { expanded: false, width: 280 });

  assert.deepEqual(readSidebarState("tall", true), { expanded: false, width: 280 });
  assert.deepEqual(readSidebarState("wide", true), { expanded: true, width: 280 });
  assert.equal(values.get(SIDEBAR_WIDE_EXPANDED_KEY), "1");
  assert.equal(values.get(SIDEBAR_WIDE_WIDTH_KEY), "280");
});

test("an adjustment while wide leaves a tall window that has its own state alone", () => {
  const { values } = storage({ [SIDEBAR_TALL_KEY]: JSON.stringify({ expanded: false, width: 200 }) });
  const tall = values.get(SIDEBAR_TALL_KEY);
  writeSidebarState("wide", { expanded: true, width: 360 });

  assert.deepEqual(readSidebarState("wide", true), { expanded: true, width: 360 });
  assert.deepEqual(readSidebarState("tall", true), { expanded: false, width: 200 });
  assert.equal(values.get(SIDEBAR_TALL_KEY), tall);
});

test("until the tall window is adjusted it keeps following the wide one", () => {
  storage({ [SIDEBAR_WIDE_EXPANDED_KEY]: "1", [SIDEBAR_WIDE_WIDTH_KEY]: "280" });
  writeSidebarState("wide", { expanded: false, width: 280 });
  assert.deepEqual(readSidebarState("tall", true), { expanded: false, width: 280 });
});

test("the default width is a state of its own: a reset while tall does not fall back to the wide width", () => {
  const { values } = storage({ [SIDEBAR_WIDE_EXPANDED_KEY]: "1", [SIDEBAR_WIDE_WIDTH_KEY]: "280" });
  writeSidebarState("tall", { expanded: true, width: null });
  assert.deepEqual(readSidebarState("tall", true), { expanded: true, width: null });

  writeSidebarState("wide", { expanded: true, width: null });
  assert.equal(values.has(SIDEBAR_WIDE_WIDTH_KEY), false);
  assert.deepEqual(readSidebarState("wide", true), { expanded: true, width: null });
});

test("a damaged tall value counts as none", () => {
  storage({ [SIDEBAR_WIDE_EXPANDED_KEY]: "0", [SIDEBAR_TALL_KEY]: "{not json" });
  assert.deepEqual(readSidebarState("tall", true), { expanded: false, width: null });

  storage({ [SIDEBAR_WIDE_EXPANDED_KEY]: "0", [SIDEBAR_TALL_KEY]: JSON.stringify({ width: 240 }) });
  assert.deepEqual(readSidebarState("tall", true), { expanded: false, width: null });
});

test("a press on the handle that changes nothing is not an adjustment", () => {
  assert.equal(sameSidebarState({ expanded: true, width: 280 }, { expanded: true, width: 280 }), true);
  assert.equal(sameSidebarState({ expanded: true, width: 280 }, { expanded: true, width: 281 }), false);
  assert.equal(sameSidebarState({ expanded: true, width: null }, { expanded: false, width: null }), false);
});
