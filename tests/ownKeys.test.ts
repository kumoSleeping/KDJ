import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("the page keys of a list that scrolls itself move it by a page, to the ends, and only for it", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div class='kd-scroll'><div class='row'></div></div><input id='field'><div id='other'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, Element: dom.window.Element, KeyboardEvent: dom.window.KeyboardEvent });
  const list = document.querySelector<HTMLElement>(".kd-scroll")!;
  Object.defineProperty(list, "clientHeight", { value: 800 });
  Object.defineProperty(list, "scrollHeight", { value: 10_000 });
  const { ownKeys } = await import("../src/components/common/rowList");
  const release = ownKeys(list);
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    dom.window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const pointer = (target: Element) => target.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  // Nothing pressed, nothing focused: the keys are not the list's.
  assert.equal(press("PageDown"), false);
  assert.equal(list.scrollTop, 0);
  // The pointer last pressed in the list: a page less a line of context.
  pointer(list.firstElementChild!);
  assert.equal(press("PageDown"), true);
  assert.equal(list.scrollTop, 760);
  assert.equal(press("PageDown"), true);
  assert.equal(list.scrollTop, 1520);
  // Space is the player's key, with Shift too: the list leaves it for the player's shortcut to take.
  assert.equal(press(" "), false);
  assert.equal(press(" ", { shiftKey: true }), false);
  assert.equal(list.scrollTop, 1520);
  assert.equal(press("PageUp"), true);
  assert.equal(press("PageUp"), true);
  assert.equal(list.scrollTop, 0);
  assert.equal(press("End"), true);
  assert.equal(list.scrollTop, 10_000);
  assert.equal(press("Home"), true);
  assert.equal(list.scrollTop, 0);
  // Pressed elsewhere since: not the list's.
  pointer(document.getElementById("other")!);
  assert.equal(press("PageDown"), false);
  assert.equal(list.scrollTop, 0);
  // A field has the focus: it keeps its keys even after a press in the list.
  pointer(list);
  document.getElementById("field")!.focus();
  assert.equal(press("End"), false);
  assert.equal(list.scrollTop, 0);
  release();
  (document.activeElement as HTMLElement | null)?.blur();
  pointer(list);
  assert.equal(press("PageDown"), false);
});
