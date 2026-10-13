import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { beginColumnPointerReorder } from "../src/lib/tableColumnPrefs";

test("grid column headers accept reorder drops, but clicks and cancellation do not", () => {
  const dom = new JSDOM('<div role="columnheader" data-col="rating"><span>评分</span></div>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    // Hit the nested label, as a browser does when the pointer is over header text.
    document.elementFromPoint = () => document.querySelector("span");
    const moves: string[][] = [];
    let dragged = 0;
    let ended = 0;
    const start = () => beginColumnPointerReorder(
      { button: 0, clientX: 10, clientY: 10 }, "file_created_at", ["file_created_at", "rating"],
      {
        onStart: () => {}, onOver: () => {},
        onMove: (from, to) => moves.push([from, to]),
        onEnd: () => { ended++; }, onDragged: () => { dragged++; },
      },
    );
    const pointer = (type: string, x: number) => window.dispatchEvent(
      new dom.window.MouseEvent(type, { clientX: x, clientY: 10, cancelable: true }),
    );
    start();
    pointer("pointermove", 40);
    pointer("pointerup", 40);
    assert.deepEqual(moves, [["file_created_at", "rating"]]);
    assert.equal(dragged, 1);
    assert.equal(document.body.hasAttribute("data-kd-col-dragging"), false);

    start();
    pointer("pointermove", 12);
    pointer("pointerup", 12);
    start();
    pointer("pointermove", 40);
    pointer("pointercancel", 40);
    pointer("pointerup", 40);
    assert.equal(moves.length, 1);
    assert.equal(dragged, 1);
    assert.equal(ended, 3);
    assert.equal(document.body.hasAttribute("data-kd-col-dragging"), false);
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
    dom.window.close();
  }
});
