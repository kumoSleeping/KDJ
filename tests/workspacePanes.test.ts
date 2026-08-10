import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkspacePaneState,
  moveWorkspacePane,
  restoreWorkspacePaneState,
  shouldHandleWorkspaceDelete,
  visibleWorkspacePanes,
} from "../src/lib/workspacePanes.ts";
import { virtualDiskGrowthOptions, virtualDiskSizeGib } from "../src/lib/virtualDisk.ts";

test("workspace pane state migrates the old two-slot layout and keeps all three preferences", () => {
  const state = restoreWorkspacePaneState(null, {
    left: "search",
    right: "onelibrary",
    active: "right",
  });

  assert.deepEqual(state, {
    order: ["local", "search", "onelibrary"],
    active: "onelibrary",
  });
});

test("delete shortcuts belong only to the active workspace pane", () => {
  assert.equal(shouldHandleWorkspaceDelete(true, "local", "Delete", false), true);
  assert.equal(shouldHandleWorkspaceDelete(false, "local", "Delete", false), false);
  assert.equal(shouldHandleWorkspaceDelete(true, "onelibrary", "Delete", false), true);
  assert.equal(shouldHandleWorkspaceDelete(false, "onelibrary", "Backspace", false), false);
  assert.equal(
    shouldHandleWorkspaceDelete(true, "local", "Backspace", false),
    false,
    "local bare Backspace keeps its existing safety boundary",
  );
  assert.equal(shouldHandleWorkspaceDelete(true, "local", "Backspace", true), true);
  assert.equal(shouldHandleWorkspaceDelete(true, "onelibrary", "Backspace", false), true);
});

test("virtual disk growth exposes only larger supported capacities", () => {
  assert.equal(virtualDiskSizeGib(8 * 1024 ** 3), 8);
  assert.deepEqual(virtualDiskGrowthOptions(8 * 1024 ** 3), [16, 32, 64]);
  assert.deepEqual(virtualDiskGrowthOptions(64 * 1024 ** 3), []);
});

test("local library stays left while remote and OneLibrary panes can swap", () => {
  const initial = createWorkspacePaneState(
    ["local", "onelibrary", "search"],
    "local",
  );
  const swapped = moveWorkspacePane(initial, "search", "onelibrary");

  assert.deepEqual(swapped.order, ["local", "search", "onelibrary"]);
  assert.equal(swapped.active, "search");
  assert.deepEqual(
    moveWorkspacePane(swapped, "onelibrary", "local").order,
    ["local", "onelibrary", "search"],
    "a drop on the left edge must not move a pane ahead of local content",
  );
});

test("multi-pane visibility supports two and three panes without exceeding three", () => {
  const state = createWorkspacePaneState(
    ["local", "search", "onelibrary"],
    "search",
  );

  assert.deepEqual(
    visibleWorkspacePanes(state, true, {
      local: true,
      search: true,
      onelibrary: false,
    }),
    ["local", "search"],
  );
  assert.deepEqual(
    visibleWorkspacePanes(state, true, {
      local: true,
      search: true,
      onelibrary: true,
    }),
    ["local", "search", "onelibrary"],
  );
});

test("single-pane mode falls back to an available pane when the active content closes", () => {
  const state = createWorkspacePaneState(
    ["local", "onelibrary", "search"],
    "search",
  );

  assert.deepEqual(
    visibleWorkspacePanes(state, false, {
      local: true,
      search: false,
      onelibrary: true,
    }),
    ["local"],
  );
});
