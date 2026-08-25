import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkspacePaneState,
  moveWorkspacePane,
  normalizedWorkspacePaneFractions,
  restoreWorkspacePaneState,
  shouldHandleWorkspaceDelete,
  visibleWorkspacePanes,
} from "../src/lib/workspacePanes.ts";
import { virtualDiskGrowthOptions, virtualDiskSizeGib } from "../src/lib/virtualDisk.ts";
import { normalizeSidebarTreeState } from "../src/lib/sidebarState.ts";
import { normalizeWorkspaceSession } from "../src/lib/workspaceSession.ts";

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

test("visible pane fractions always fill the grid while preserving saved ratios", () => {
  const weights = { local: 0.2, onelibrary: 2.6, search: 0.6 };

  assert.deepEqual(normalizedWorkspacePaneFractions(["local"], weights), [1]);
  assert.deepEqual(
    normalizedWorkspacePaneFractions(["local", "search"], weights).map((value) =>
      Number(value.toFixed(6)),
    ),
    [0.5, 1.5],
  );
  assert.deepEqual(
    normalizedWorkspacePaneFractions(["local", "onelibrary", "search"], {
      local: Number.NaN,
      onelibrary: 1,
      search: 1,
    }),
    [1, 1, 1],
  );
});

test("sidebar expansion persistence keeps explicit closed roots distinct from unseen roots", () => {
  const state = normalizeSidebarTreeState({
    local: { expanded: ["/Music/Open"], knownRoots: ["/Music/Open", "/Music/Closed"] },
    oneLibrary: {
      open: false,
      openDevices: ["/Volumes/KDJ"],
      openFolders: ["/Volumes/KDJ\u00007"],
      knownDevices: ["/Volumes/KDJ", "/Volumes/Closed"],
    },
  });

  assert.deepEqual(state.local.expanded, ["/Music/Open"]);
  assert.deepEqual(state.local.knownRoots, ["/Music/Open", "/Music/Closed"]);
  assert.equal(state.oneLibrary.open, false);
  assert.deepEqual(state.oneLibrary.openFolders, ["/Volumes/KDJ\u00007"]);
});

test("workspace session validates a restorable online playlist and selected row", () => {
  const state = normalizeWorkspaceSession({
    source: "stream",
    local: { folder: "/Music/Set", selectedId: 42, scrollTop: 512 },
    oneLibrary: {},
    stream: {
      playlist: {
        platform: "qqm",
        key: "123",
        title: "收藏歌单",
        cover: "",
        count: 11,
        is_favorite: false,
        origin: "collected",
      },
      inspectedGroup: "0:qqm:123",
      scrollTop: 320,
    },
  });

  assert.equal(state.source, "stream");
  assert.equal(state.local.selectedId, 42);
  assert.equal(state.stream.playlist?.title, "收藏歌单");
  assert.equal(state.stream.inspectedGroup, "0:qqm:123");
  assert.equal(state.stream.scrollTop, 320);
});

test("single-pane intent switches to async content as soon as it becomes available", () => {
  const state = createWorkspacePaneState(
    ["local", "onelibrary", "search"],
    "search",
  );
  assert.deepEqual(
    visibleWorkspacePanes(state, false, {
      local: true,
      search: false,
      onelibrary: false,
    }),
    ["local"],
  );
  assert.deepEqual(
    visibleWorkspacePanes(state, false, {
      local: true,
      search: true,
      onelibrary: false,
    }),
    ["search"],
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
