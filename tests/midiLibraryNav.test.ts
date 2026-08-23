import assert from "node:assert/strict";
import test from "node:test";
import {
  currentBrowseIndex,
  nextBrowseIndex,
  paneForSidebarHint,
  toggleBrowseFocus,
} from "../src/lib/midiLibraryNav";

test("browse encoder stops at the ends instead of wrapping", () => {
  assert.equal(nextBrowseIndex(5, 0, -1), 0);
  assert.equal(nextBrowseIndex(5, 4, 1), 4);
  assert.equal(nextBrowseIndex(5, 2, 1), 3);
  assert.equal(nextBrowseIndex(5, 2, -1), 1);
});

test("browse encoder with no current row starts at the matching end", () => {
  assert.equal(nextBrowseIndex(4, -1, 1), 0);
  assert.equal(nextBrowseIndex(4, -1, -1), 3);
});

test("pressing the browse encoder flips sidebar and pane focus", () => {
  assert.equal(toggleBrowseFocus("sidebar"), "pane");
  assert.equal(toggleBrowseFocus("pane"), "sidebar");
});

test("sidebar cursor follows a stable id instead of the first active row", () => {
  const node = (id: string, active = false, cursor = false) => {
    const el = { dataset: { active: active ? "true" : undefined } } as HTMLElement;
    el.getAttribute = (name: string) => {
      if (name === "data-kd-browse-id") return id;
      if (name === "data-kd-browse-cursor") return cursor ? "true" : null;
      return null;
    };
    return el;
  };
  const items = [node("local:all", true), node("search:root:wyy"), node("local:folder:/Music")];
  assert.equal(currentBrowseIndex(items, "search:root:wyy"), 1);
  assert.equal(currentBrowseIndex(items, null), 0);
  const bothActive = [node("local:all", true), node("search:root:wyy", true)];
  assert.equal(currentBrowseIndex(bothActive, null), -1);
});
