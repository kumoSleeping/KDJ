import assert from "node:assert/strict";
import test from "node:test";

test("shared marquee measures overflow, updates on resize and resets for new text", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  let width = 100;
  const observers = new Set<() => void>();
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get: () => width });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", {
    get() { return (this.textContent?.length ?? 0) * 10; },
  });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    ResizeObserver: class {
      constructor(private callback: () => void) {}
      observe() { observers.add(this.callback); }
      disconnect() { observers.delete(this.callback); }
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MarqueeText } = await import("../src/components/common/MarqueeText");
  const root = createRoot(document.getElementById("root")!);
  const render = async (text: string) => act(async () => {
    root.render(createElement(MarqueeText, { className: "vj-task-timing", text }));
  });
  try {
    await render("Offset +0.000 s");
    const box = document.querySelector<HTMLElement>(".kd-marquee-viewport")!;
    assert.equal(box.dataset.marquee, "true");
    assert.equal(box.style.getPropertyValue("--kd-marquee-shift"), "-50px");
    assert.equal(box.title, "Offset +0.000 s");
    await act(async () => { width = 200; observers.forEach(measure => measure()); });
    assert.equal(box.dataset.marquee, undefined, "wide panels stop scrolling");
    assert.equal(box.style.getPropertyValue("--kd-marquee-shift"), "");
    await act(async () => { width = 100; observers.forEach(measure => measure()); });
    assert.equal(box.dataset.marquee, "true");
    const oldText = box.firstElementChild;
    await render("Short");
    assert.equal(box.dataset.marquee, undefined, "short text stays still");
    assert.notEqual(box.firstElementChild, oldText, "new text restarts the animation at the beginning");
    assert.equal(observers.size, 1, "text changes replace the observer");
  } finally {
    await act(async () => root.unmount());
    assert.equal(observers.size, 0, "unmount releases the observer");
    dom.window.close();
  }
});
