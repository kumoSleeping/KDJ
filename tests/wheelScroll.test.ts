import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { wheelPixels } from "../src/lib/wheelScroll";
import { listScrollsItself, ownWheel } from "../src/components/common/rowList";

test("wheel deltas convert line and page modes and Shift turns a vertical wheel sideways", () => {
  assert.deepEqual(wheelPixels({ deltaX: 3, deltaY: -40, deltaMode: 0, shiftKey: false }, 36, 800, 600), { x: 3, y: -40 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false }, 36, 800, 600), { x: 0, y: 108 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: -1, deltaMode: 2, shiftKey: false }, 36, 800, 600), { x: 0, y: -600 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 120, deltaMode: 0, shiftKey: true }, 36, 800, 600), { x: 120, y: 0 });
  assert.deepEqual(wheelPixels({ deltaX: 5, deltaY: 120, deltaMode: 0, shiftKey: true }, 36, 800, 600), { x: 5, y: 120 });
});

test("the list scrolls itself in WebKit alone", () => {
  // The macOS WebView, Safari, the Linux WebView.
  assert.equal(listScrollsItself("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"), true);
  assert.equal(listScrollsItself("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"), true);
  assert.equal(listScrollsItself("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"), true);
  // WebView2, Chrome, the Android WebView: the WebView scrolls.
  assert.equal(listScrollsItself("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"), false);
  assert.equal(listScrollsItself("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36"), false);
  assert.equal(listScrollsItself("Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36"), false);
  assert.equal(listScrollsItself(""), false);
});

test("a list that scrolls itself: the wheel moves it, a gesture keeps its axis, a pinch and an inner scroller are left alone", () => {
  const dom = new JSDOM("<!doctype html><div id='list'><div id='row'></div><div id='inner'><p id='deep'></p></div></div>", { url: "http://localhost" });
  Object.assign(globalThis, { Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) });
  const list = dom.window.document.getElementById("list")!;
  const row = dom.window.document.getElementById("row")!;
  const inner = dom.window.document.getElementById("inner")!;
  const deep = dom.window.document.getElementById("deep")!;
  inner.style.overflowY = "auto";
  Object.defineProperty(inner, "scrollHeight", { value: 900 });
  Object.defineProperty(inner, "clientHeight", { value: 300 });
  Object.defineProperty(list, "clientHeight", { value: 600 });
  Object.defineProperty(list, "clientWidth", { value: 800 });
  const wheel = (target: Element, at: number, init: WheelEventInit) => {
    const event = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "timeStamp", { value: at });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const release = ownWheel(list);
  try {
    // A swipe down: the list moves by what the wheel reports, and the WebView is told not to.
    assert.equal(wheel(row, 1000, { deltaY: 30, deltaX: 1 }), true);
    assert.equal(list.scrollTop, 30);
    assert.equal(list.scrollLeft, 0);
    // The same gesture drifting sideways stays vertical: nothing moves across.
    assert.equal(wheel(row, 1016, { deltaY: 0, deltaX: 40 }), true);
    assert.equal(wheel(row, 1032, { deltaY: 50, deltaX: 12 }), true);
    assert.deepEqual([list.scrollTop, list.scrollLeft], [80, 0]);
    // Its momentum is the same gesture however long it runs.
    for (let frame = 1; frame <= 30; frame += 1) wheel(row, 1032 + frame * 16, { deltaY: 10, deltaX: 3 });
    assert.deepEqual([list.scrollTop, list.scrollLeft], [380, 0]);
    // Another gesture, sideways this time.
    assert.equal(wheel(row, 3000, { deltaY: 2, deltaX: 25 }), true);
    assert.equal(wheel(row, 3016, { deltaY: 30, deltaX: 25 }), true);
    assert.deepEqual([list.scrollTop, list.scrollLeft], [380, 50]);
    // A wheel that reports lines or pages; Shift turns a vertical wheel sideways.
    assert.equal(wheel(row, 5000, { deltaY: 3, deltaMode: 1 }), true);
    assert.equal(list.scrollTop, 380 + 3 * 16);
    assert.equal(wheel(row, 6000, { deltaY: -1, deltaMode: 2 }), true);
    assert.equal(list.scrollTop, 428 - 600);
    list.scrollTop = 0;
    assert.equal(wheel(row, 7000, { deltaY: 120, shiftKey: true }), true);
    assert.deepEqual([list.scrollTop, list.scrollLeft], [0, 170]);
    // A pinch (the WebView's zoom) and a wheel another handler took are not the list's.
    assert.equal(wheel(row, 8000, { deltaY: 30, ctrlKey: true }), false);
    assert.equal(list.scrollTop, 0);
    // Over something that scrolls inside the list, the wheel is that thing's.
    assert.equal(wheel(deep, 9000, { deltaY: 30 }), false);
    assert.equal(list.scrollTop, 0);
    // ...along the axis it scrolls on only.
    assert.equal(wheel(deep, 10000, { deltaX: 30 }), true);
    assert.equal(list.scrollLeft, 200);
  } finally {
    release();
  }
  assert.equal(wheel(row, 11000, { deltaY: 30 }), false, "released: the WebView scrolls again");
  dom.window.close();
});
