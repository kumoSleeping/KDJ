import assert from "node:assert/strict";
import test from "node:test";
import { shouldIgnorePlayerShortcut } from "../src/lib/playerShortcutPolicy";
import {
  DEFAULT_ARROW_KEY_CONTROL,
  resolveArrowKeyAction,
} from "../src/lib/arrowKeyControl";

function input(type: string): EventTarget {
  return { tagName: "INPUT", type, isContentEditable: false } as unknown as EventTarget;
}

test("Space keeps controlling playback after a range slider receives focus", () => {
  assert.equal(shouldIgnorePlayerShortcut(input("range"), " ", "Space"), false);
  assert.equal(shouldIgnorePlayerShortcut(input("range"), "Spacebar", "Space"), false);
});

test("other editable controls and non-Space range keys stay local", () => {
  assert.equal(shouldIgnorePlayerShortcut(input("number"), " ", "Space"), true);
  assert.equal(shouldIgnorePlayerShortcut(input("text"), " ", "Space"), true);
  assert.equal(shouldIgnorePlayerShortcut(input("range"), "ArrowRight", "ArrowRight"), true);
});

test("non-editable surfaces remain eligible for player shortcuts", () => {
  const surface = { tagName: "DIV", isContentEditable: false } as unknown as EventTarget;
  assert.equal(shouldIgnorePlayerShortcut(surface, " ", "Space"), false);
});

test("arrow key control defaults to horizontal seek and vertical list movement", () => {
  assert.equal(resolveArrowKeyAction("ArrowLeft", { ...DEFAULT_ARROW_KEY_CONTROL }), "seek-backward");
  assert.equal(resolveArrowKeyAction("ArrowRight", { ...DEFAULT_ARROW_KEY_CONTROL }), "seek-forward");
  assert.equal(resolveArrowKeyAction("ArrowUp", { ...DEFAULT_ARROW_KEY_CONTROL }), "list-up");
  assert.equal(resolveArrowKeyAction("ArrowDown", { ...DEFAULT_ARROW_KEY_CONTROL }), "list-down");
});

test("arrow key control maps both configurable alternatives and respects the master switch", () => {
  const alternative = {
    enabled: true,
    horizontalMode: "track" as const,
    verticalMode: "volume" as const,
  };
  assert.equal(resolveArrowKeyAction("ArrowLeft", alternative), "previous-track");
  assert.equal(resolveArrowKeyAction("ArrowRight", alternative), "next-track");
  assert.equal(resolveArrowKeyAction("ArrowUp", alternative), "volume-up");
  assert.equal(resolveArrowKeyAction("ArrowDown", alternative), "volume-down");
  assert.equal(resolveArrowKeyAction("ArrowLeft", { ...alternative, enabled: false }), null);
  assert.equal(resolveArrowKeyAction("Enter", alternative), null);
});
