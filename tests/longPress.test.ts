import assert from "node:assert/strict";
import test from "node:test";

test("a long press: held still it opens the menu once, held on it hands over, moved it is nothing", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id=row></div>", { url: "http://localhost/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const { startLongPress, LONG_PRESS_MS, LONG_PRESS_HOLD_MS } = await import("../src/lib/longPress");
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const row = dom.window.document.getElementById("row")!;
  const pointer = (type: string, x = 10, y = 10, pointerType = "touch") => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: pointerType } });
    return event;
  };
  const down = (pointerType = "touch") => ({ pointerId: 7, pointerType, clientX: 10, clientY: 10, isPrimary: true, button: 0 });

  // Held still: the menu, once, though the WebView's own long press follows; no drag ghost.
  let opened: number[][] = [], held = 0;
  startLongPress(down(), { open: (x, y) => opened.push([x, y]), hold: () => { held++; } });
  await wait(LONG_PRESS_MS + 30);
  assert.deepEqual(opened, [[10, 10]]);
  const native = new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  let reached = false;
  row.addEventListener("contextmenu", () => { reached = true; }, { once: true });
  row.dispatchEvent(native);
  assert.equal(native.defaultPrevented, true);
  assert.equal(reached, false, "the row's own contextmenu handler does not open a second menu");
  const drag = new dom.window.Event("dragstart", { bubbles: true, cancelable: true });
  row.dispatchEvent(drag);
  assert.equal(drag.defaultPrevented, true, "a draggable cell does not start an HTML5 drag under the finger");
  // Released before the second stage: the click the release makes is swallowed.
  row.dispatchEvent(pointer("pointerup"));
  let clicked = false;
  row.addEventListener("click", () => { clicked = true; }, { once: true });
  row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(clicked, false);
  await wait(LONG_PRESS_HOLD_MS - LONG_PRESS_MS + 30);
  assert.equal(held, 0);

  // The WebView's long press comes first: it opens the menu, and the timer does not again.
  opened = [];
  startLongPress(down(), { open: (x, y) => opened.push([x, y]) });
  row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await wait(LONG_PRESS_MS + 30);
  assert.equal(opened.length, 1);
  row.dispatchEvent(pointer("pointerup"));

  // Held on: the second stage.
  opened = []; held = 0;
  startLongPress(down(), { open: (x, y) => opened.push([x, y]), hold: () => { held++; } });
  await wait(LONG_PRESS_HOLD_MS + 40);
  assert.deepEqual([opened.length, held], [1, 1]);
  row.dispatchEvent(pointer("pointerup"));

  // Moved first: a scroll, not a press; nothing opens and the next click is the row's.
  opened = [];
  startLongPress(down(), { open: (x, y) => opened.push([x, y]) });
  row.dispatchEvent(pointer("pointermove", 10, 40));
  await wait(LONG_PRESS_MS + 30);
  assert.equal(opened.length, 0);
  row.dispatchEvent(pointer("pointerup", 10, 40));
  clicked = false;
  row.addEventListener("click", () => { clicked = true; }, { once: true });
  row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(clicked, true);

  // Moved after the menu came up: the menu stays, the second stage is given up.
  opened = []; held = 0;
  startLongPress(down(), { open: (x, y) => opened.push([x, y]), hold: () => { held++; } });
  await wait(LONG_PRESS_MS + 30);
  row.dispatchEvent(pointer("pointermove", 60, 10));
  await wait(LONG_PRESS_HOLD_MS - LONG_PRESS_MS + 40);
  assert.deepEqual([opened.length, held], [1, 0]);
  row.dispatchEvent(pointer("pointerup", 60, 10));

  // The mouse has its right button.
  opened = [];
  startLongPress(down("mouse"), { open: (x, y) => opened.push([x, y]) });
  await wait(LONG_PRESS_MS + 30);
  assert.equal(opened.length, 0);
  await wait(500);
});
