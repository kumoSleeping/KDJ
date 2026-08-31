import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeSidebarRootOrder,
  moveSidebarRootOrder,
  normalizeSidebarRootOrder,
  orderSidebarRootItems,
} from "../src/lib/sidebarRootOrder.ts";

test("sidebar root order normalization removes invalid and duplicate ids", () => {
  assert.deepEqual(
    normalizeSidebarRootOrder(["all", "stream:wyy", "all", null, ""]),
    ["all", "stream:wyy"],
  );
});

test("saved roots lead while unseen roots keep their default relative order", () => {
  const items = ["all", "stream:wyy", "local:/Music", "outside"].map((id) => ({ id }));
  assert.deepEqual(
    orderSidebarRootItems(items, ["local:/Music", "all"]).map((item) => item.id),
    ["local:/Music", "all", "stream:wyy", "outside"],
  );
});

test("root items can move to either side of every other visible root", () => {
  const current = ["all", "stream:wyy", "stream:qqm", "local:/Music"];
  assert.deepEqual(
    moveSidebarRootOrder(current, "local:/Music", "all", "before"),
    ["local:/Music", "all", "stream:wyy", "stream:qqm"],
  );
  assert.deepEqual(
    moveSidebarRootOrder(current, "all", "local:/Music", "after"),
    ["stream:wyy", "stream:qqm", "local:/Music", "all"],
  );
});

test("saving a visible reorder preserves temporarily hidden root ids", () => {
  assert.deepEqual(
    mergeSidebarRootOrder(
      ["all", "stream:hidden", "stream:wyy", "local:/Music"],
      ["local:/Music", "all", "stream:wyy"],
    ),
    ["local:/Music", "stream:hidden", "all", "stream:wyy"],
  );
});
