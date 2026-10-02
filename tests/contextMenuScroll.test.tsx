import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ContextMenu } from "../src/components/common/ContextMenu";

test("an anchored menu ignores lyrics scrolling but closes when its own anchor moves", async () => {
  const dom = new JSDOM('<div id="root"></div><div id="header"><button id="anchor">Panels</button></div><div id="lyrics"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} disconnect() {} } });
  const root = createRoot(document.getElementById("root")!);
  let closes = 0;
  try {
    const anchor = document.getElementById("anchor")!;
    await act(async () => root.render(<ContextMenu x={10} y={30} anchorTop={10} anchorElement={anchor} onClose={() => closes++}>
      <button>波形</button><button>歌词</button>
    </ContextMenu>));
    await act(async () => document.getElementById("lyrics")!.dispatchEvent(new dom.window.Event("scroll")));
    assert.equal(closes, 0, "programmatic lyrics scroll must keep the menu open");
    await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new dom.window.Event("scroll")));
    assert.equal(closes, 0, "scrolling within the menu must keep it open");
    await act(async () => document.getElementById("header")!.dispatchEvent(new dom.window.Event("scroll")));
    assert.equal(closes, 1, "scrolling the anchor container closes the old-position menu");
    await act(async () => document.body.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })));
    assert.equal(closes, 2, "outside click still closes the menu");
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
