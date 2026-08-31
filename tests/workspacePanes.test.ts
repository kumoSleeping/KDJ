import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkspacePaneState,
  moveWorkspacePane,
  normalizedWorkspacePaneFractions,
  resolveWorkspaceDetailTrack,
  resolveWorkspacePlaybackDetailTarget,
  resolveWorkspaceRequestedTrack,
  restoreWorkspacePaneState,
  shouldHandleWorkspaceDelete,
  visibleWorkspacePanes,
} from "../src/lib/workspacePanes.ts";
import { normalizeSidebarTreeState } from "../src/lib/sidebarState.ts";
import {
  normalizeWorkspaceSession,
  shouldRestoreStreamWorkspace,
} from "../src/lib/workspaceSession.ts";

test("workspace pane state keeps local content anchored and restores online content", () => {
  const state = restoreWorkspacePaneState(null, {
    left: "search",
    right: "removed-pane",
    active: "left",
  });

  assert.deepEqual(state, {
    order: ["local", "search"],
    active: "search",
  });
});

test("delete shortcuts belong only to the active local workspace pane", () => {
  assert.equal(shouldHandleWorkspaceDelete(true, "local", "Delete", false), true);
  assert.equal(shouldHandleWorkspaceDelete(false, "local", "Delete", false), false);
  assert.equal(shouldHandleWorkspaceDelete(true, "local", "Backspace", false), false);
  assert.equal(shouldHandleWorkspaceDelete(true, "local", "Backspace", true), true);
});

test("local library stays left when the online pane is moved", () => {
  const initial = createWorkspacePaneState(["local", "search"], "local");
  const moved = moveWorkspacePane(initial, "search", "local");

  assert.deepEqual(moved.order, ["local", "search"]);
  assert.equal(moved.active, "search");
});

test("multi-pane visibility includes both supported panes", () => {
  const state = createWorkspacePaneState(["local", "search"], "search");

  assert.deepEqual(
    visibleWorkspacePanes(state, true, { local: true, search: true }),
    ["local", "search"],
  );
});

test("visible pane fractions always fill the grid while preserving ratios", () => {
  const weights = { local: 0.2, search: 0.6 };

  assert.deepEqual(normalizedWorkspacePaneFractions(["local"], weights), [1]);
  assert.deepEqual(
    normalizedWorkspacePaneFractions(["local", "search"], weights).map((value) =>
      Number(value.toFixed(6)),
    ),
    [0.5, 1.5],
  );
});

test("sidebar expansion persistence keeps explicit closed roots distinct from unseen roots", () => {
  const state = normalizeSidebarTreeState({
    local: { expanded: ["/Music/Open"], knownRoots: ["/Music/Open", "/Music/Closed"] },
  });

  assert.deepEqual(state.local.expanded, ["/Music/Open"]);
  assert.deepEqual(state.local.knownRoots, ["/Music/Open", "/Music/Closed"]);
});

test("workspace session validates a restorable online playlist and selected row", () => {
  const state = normalizeWorkspaceSession({
    source: "stream",
    local: { folder: "/Music/Set", selectedId: 42, scrollTop: 512 },
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
  assert.equal(state.stream.accountKey, null);
  assert.equal(state.stream.inspectedGroup, "0:qqm:123");
  assert.equal(state.stream.scrollTop, 320);
});

test("legacy implicit library order migrates to filesystem creation order", () => {
  const state = normalizeWorkspaceSession({
    source: "local",
    local: { sort: "added_at", order: "desc" },
  });

  assert.equal(state.local.sort, "file_created_at");
  assert.equal(normalizeWorkspaceSession(null).local.sort, "file_created_at");
});

test("a pinned split restores the online right pane even when local was focused", () => {
  const session = normalizeWorkspaceSession({
    source: "local",
    stream: {
      playlist: {
        platform: "qqm",
        key: "123",
        title: "收藏歌单",
        cover: "",
        count: 11,
        is_favorite: false,
      },
      accountKey: "persistent:qq-account-a",
    },
  });

  assert.equal(shouldRestoreStreamWorkspace(session, false), false);
  assert.equal(shouldRestoreStreamWorkspace(session, true), true);
  assert.equal(session.stream.accountKey, "persistent:qq-account-a");
  assert.deepEqual(
    visibleWorkspacePanes(
      createWorkspacePaneState(["local", "search"], "local"),
      true,
      { local: true, search: true },
    ),
    ["local", "search"],
  );
});

test("workspace session restores every account-backed stream platform", () => {
  for (const platform of ["wyy", "qqm", "soundcloud", "ytm", "youtube", "bilibili"]) {
    const state = normalizeWorkspaceSession({
      source: "stream",
      stream: {
        playlist: {
          platform,
          key: "remote-list",
          title: "Remote list",
          cover: "",
          count: 1,
          is_favorite: false,
          origin: "created",
        },
      },
    });
    assert.equal(state.stream.playlist?.platform, platform);
  }
});

test("single-pane intent switches to online content as soon as it becomes available", () => {
  const state = createWorkspacePaneState(["local", "search"], "search");

  assert.deepEqual(
    visibleWorkspacePanes(state, false, { local: true, search: false }),
    ["local"],
  );
  assert.deepEqual(
    visibleWorkspacePanes(state, false, { local: true, search: true }),
    ["search"],
  );
});

test("single-pane mode falls back to local content when online content closes", () => {
  const state = createWorkspacePaneState(["local", "search"], "search");

  assert.deepEqual(
    visibleWorkspacePanes(state, false, { local: true, search: false }),
    ["local"],
  );
});

test("pinned song detail follows playback and survives a transient empty snapshot", () => {
  const selected = { id: 10, title: "Selected" };
  const firstPlaying = { id: 20, title: "Playing A" };
  const nextPlaying = { id: 21, title: "Playing B" };

  assert.equal(resolveWorkspaceDetailTrack(false, firstPlaying, selected), selected);
  assert.equal(resolveWorkspaceDetailTrack(true, firstPlaying, selected), firstPlaying);
  assert.equal(resolveWorkspaceDetailTrack(true, nextPlaying, selected), nextPlaying);
  assert.equal(resolveWorkspaceDetailTrack(true, null, selected), selected);
  assert.equal(
    resolveWorkspaceDetailTrack(true, null, selected, firstPlaying),
    firstPlaying,
  );
});

test("unpinned detail never substitutes the playing song while its target reloads", () => {
  const playing = { id: 20, title: "Playing" };
  const previousTarget = { id: 10, title: "Previous target" };
  const nextTarget = { id: 11, title: "Next target" };

  assert.equal(
    resolveWorkspaceRequestedTrack(10, playing, null, null, previousTarget),
    previousTarget,
  );
  assert.equal(
    resolveWorkspaceRequestedTrack(11, playing, nextTarget, null, previousTarget),
    nextTarget,
  );
  assert.equal(
    resolveWorkspaceRequestedTrack(null, playing, nextTarget, null, null),
    nextTarget,
    "a fresh list navigation wins over the unrelated playing song",
  );
});

test("visible playback detail advances from an outgoing video to incoming audio", () => {
  assert.equal(
    resolveWorkspacePlaybackDetailTarget(8, 8, 9, false),
    9,
    "the VIDEO detail target follows the playback track it represented",
  );
  assert.equal(
    resolveWorkspacePlaybackDetailTarget(7, 8, 9, false),
    7,
    "an unrelated track the user is browsing stays put",
  );
  assert.equal(
    resolveWorkspacePlaybackDetailTarget(8, 8, 9, true),
    8,
    "the pinned-playing resolver already follows playback and preserves the list target",
  );
});
