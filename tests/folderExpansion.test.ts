import assert from "node:assert/strict";
import test from "node:test";

import { expandNewRootPaths } from "../src/lib/folderExpansion.ts";

test("folder refresh preserves the user's expanded and collapsed branches", () => {
  const roots = ["/Music", "/Sets"];
  let seenRoots = new Set<string>();
  let expanded = expandNewRootPaths(new Set<string>(), seenRoots, roots);
  seenRoots = new Set(roots);

  assert.deepEqual([...expanded], roots, "roots expand on their first appearance");

  expanded.delete("/Music");
  expanded.add("/Sets/Friday");
  const beforeRefresh = expanded;
  expanded = expandNewRootPaths(expanded, seenRoots, roots);

  assert.equal(expanded, beforeRefresh, "an unchanged refresh must not replace expansion state");
  assert.equal(expanded.has("/Music"), false, "a manually collapsed root stays collapsed");
  assert.equal(expanded.has("/Sets/Friday"), true, "an expanded child stays expanded");
});

test("a genuinely new root expands once without reopening an old collapsed root", () => {
  const seenRoots = new Set(["/Music", "/Sets"]);
  const expanded = new Set(["/Sets"]);
  const next = expandNewRootPaths(expanded, seenRoots, ["/Music", "/Sets", "/Archive"]);

  assert.equal(next.has("/Music"), false);
  assert.equal(next.has("/Sets"), true);
  assert.equal(next.has("/Archive"), true);
});
