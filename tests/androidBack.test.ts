import assert from "node:assert/strict";
import test from "node:test";

test("the back key is an Escape for the top layer, and counts as used only when a layer took it", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body><input id=field></body>", { url: "http://localhost/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent });
  const { closeTopLayer } = await import("../src/lib/androidBack");
  assert.equal(closeTopLayer(), false, "nothing open: the system has the back key");
  let closed = 0;
  // A layer that closes on Escape (the drawer, a menu, a floating window) takes it.
  const drawer = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (event.target instanceof dom.window.Element && event.target.closest("input")) return;
    event.preventDefault();
    closed += 1;
  };
  dom.window.addEventListener("keydown", drawer);
  try {
    assert.equal(closeTopLayer(), true);
    assert.equal(closed, 1, "one layer per press");
    // A focused field gives up its focus: the back key closes the layer around it.
    const field = document.getElementById("field") as HTMLInputElement;
    field.focus();
    assert.equal(document.activeElement, field);
    assert.equal(closeTopLayer(), true);
    assert.equal(closed, 2);
    assert.notEqual(document.activeElement, field);
  } finally {
    dom.window.removeEventListener("keydown", drawer);
  }
});
