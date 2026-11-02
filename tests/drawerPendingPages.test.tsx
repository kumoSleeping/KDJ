import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, type ReactNode } from "react";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A page in the DOM the drawer runs in, with frames that are stepped by hand. */
function page() {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  const animated: string[] = [];
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 320 });
  Object.assign(dom.window.HTMLElement.prototype, {
    animate(this: HTMLElement) {
      animated.push(this.classList.contains("kd-slide-ghost") ? "old" : "new");
      return { finished: new Promise(() => undefined), cancel() {} };
    },
    getAnimations: () => [],
  });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class { observe() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const step = () => { const due = [...frames.values()]; frames.clear(); due.forEach(callback => callback(performance.now())); };
  return { dom, animated, step };
}

test("a page that arrives still pending slides in once it has its content, under the old picture until then", async () => {
  const { dom, animated } = page();
  const { createRoot } = await import("react-dom/client");
  const { SlidePages } = await import("../src/components/drawer/SlidePages");
  const root = createRoot(document.getElementById("root")!);
  const show = (id: string, pending: boolean) => act(async () => root.render(createElement(SlidePages, { page: id, order: ["a", "b", "c"] },
    createElement("div", { key: id, "data-drawer-pending": pending ? "" : undefined }, pending ? null : `page ${id}`))));
  const live = () => document.querySelector<HTMLElement>(".kd-slide-page:not(.kd-slide-ghost)")!;
  const ghosts = () => [...document.querySelectorAll<HTMLElement>(".kd-slide-ghost")];
  try {
    await show("a", false);
    await show("b", true);
    assert.ok(live().hasAttribute("data-slide-waiting"), "the new page is not shown while it is pending");
    assert.deepEqual(ghosts().map(node => node.textContent), ["page a"], "the old picture stays in its place");
    assert.deepEqual(animated, [], "nothing moves yet");

    // Asked for another page meanwhile: what is on screen is still the first page's picture.
    await show("c", true);
    assert.deepEqual(ghosts().map(node => node.textContent), ["page a"]);
    assert.deepEqual(animated, []);

    await show("c", false);
    assert.equal(live().hasAttribute("data-slide-waiting"), false);
    assert.deepEqual(animated.sort(), ["new", "old"], "the slide starts when the content is there");

    // A page that never finishes does not hold the switch for long.
    animated.length = 0;
    await show("a", true);
    assert.deepEqual(animated, []);
    await act(async () => { await sleep(650); });
    assert.equal(live().hasAttribute("data-slide-waiting"), false);
    assert.deepEqual(animated.sort(), ["new", "old"]);

    // A page that is ready at once slides at once.
    animated.length = 0;
    await show("b", false);
    assert.deepEqual(animated.sort(), ["new", "old"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("an app that keeps room waits out of sight for a first picture that is still pending", async () => {
  const { dom, step } = page();
  const { createRoot } = await import("react-dom/client");
  const { DrawerHost } = await import("../src/components/drawer/Drawer");
  const root = createRoot(document.getElementById("root")!);
  const show = (id: string, body: ReactNode) => act(async () => root.render(createElement(DrawerHost, {
    spec: { id, title: id, extent: "at-least-half", body, close() {} },
  })));
  const sheet = (id: string) => document.querySelector<HTMLElement>(`.kd-drawer[data-app="${id}"]`);
  try {
    await show("tasks", createElement("div", { "data-drawer-pending": "" }));
    assert.equal(sheet("tasks")?.dataset.held, "true", "it does not come in at half and grow");
    await show("tasks", createElement("div", { className: "kd-scroll" }));
    await act(async () => { step(); await sleep(0); });
    assert.equal(sheet("tasks")?.dataset.held, undefined, "it comes in once the page is built");
    await act(async () => root.unmount());

    const other = createRoot(document.getElementById("root")!);
    await act(async () => other.render(createElement(DrawerHost, {
      spec: { id: "ready", title: "ready", extent: "at-least-half", body: createElement("div", { className: "kd-scroll" }), close() {} },
    })));
    assert.equal(sheet("ready")?.dataset.held, undefined, "a body that is there from the start comes in at once");
    await act(async () => other.unmount());
  } finally {
    dom.window.close();
  }
});
