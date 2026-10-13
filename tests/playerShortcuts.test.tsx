import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";

test("transport Space releases clicked buttons but preserves keyboard and editor focus", async () => {
  const dom = new JSDOM(`<!doctype html><div id="root"></div>
    <button id="color"><svg><path /></svg></button><button id="other"></button>
    <input id="search"><input id="volume" type="range">
    <div role="menu"><button id="menu"></button></div>`, { url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { usePlayerShortcuts } = await import("../src/lib/usePlayerShortcuts");
  let plays = 0;
  function Player() {
    usePlayerShortcuts({
      togglePlay: () => { plays++; }, seekBy() {}, nudgeVolume() {},
      moveListSelection() {}, goNext() {}, goPrevious() {},
    });
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  const button = document.getElementById("color")!;
  const other = document.getElementById("other")!;
  const clickFocus = (element: HTMLElement) => {
    (element.querySelector("path") ?? element).dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    // JSDOM does not perform the Windows WebView's default pointer focus action.
    element.focus();
  };
  const key = (element: HTMLElement, value = " ", options: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", {
      key: value, code: value === " " ? "Space" : value, bubbles: true, cancelable: true, ...options,
    });
    element.dispatchEvent(event);
    return event;
  };
  try {
    await act(async () => root.render(createElement(Player)));
    clickFocus(button);
    assert.equal(key(button).defaultPrevented, true);
    assert.equal(plays, 1);
    assert.equal(document.activeElement, document.body, "Space clears the old pointer focus");
    key(document.body, " ", { repeat: true });
    assert.equal(plays, 1, "holding Space does not repeatedly toggle playback");

    clickFocus(button);
    key(button, "Tab");
    other.focus();
    key(other, "Tab", { shiftKey: true });
    button.focus();
    key(button);
    assert.equal(document.activeElement, button, "Tab returning to a clicked button retains keyboard focus");
    assert.equal(plays, 2);

    clickFocus(button);
    other.focus();
    button.focus();
    key(button);
    assert.equal(document.activeElement, button, "programmatically restored focus is preserved");
    assert.equal(plays, 3);

    clickFocus(button);
    assert.equal(key(button, " ", { ctrlKey: true }).defaultPrevented, false);
    assert.equal(document.activeElement, button);
    const prevent = (event: KeyboardEvent) => event.preventDefault();
    button.addEventListener("keydown", prevent);
    key(button);
    button.removeEventListener("keydown", prevent);
    assert.equal(document.activeElement, button, "a locally handled key keeps its focus");
    assert.equal(plays, 3);

    for (const id of ["search", "menu"]) {
      const element = document.getElementById(id)!;
      clickFocus(element);
      assert.equal(key(element).defaultPrevented, false);
      assert.equal(document.activeElement, element);
    }
    assert.equal(plays, 3, "text fields and menus keep Space");
    const volume = document.getElementById("volume")!;
    clickFocus(volume);
    assert.equal(key(volume).defaultPrevented, true);
    assert.equal(document.activeElement, volume, "range controls retain focus");
    assert.equal(plays, 4);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
