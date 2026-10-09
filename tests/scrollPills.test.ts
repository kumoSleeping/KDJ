import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, PointerEvent: dom.window.MouseEvent, getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: dom.window.requestAnimationFrame, cancelAnimationFrame: dom.window.cancelAnimationFrame,
});

/** A scroll container with a layout, which JSDOM does not compute. */
function pane(height: number, content: number, style = "overflow-y: auto"): HTMLElement {
  const node = document.createElement("div");
  node.setAttribute("style", style);
  node.append(document.createElement("p"));
  Object.defineProperties(node, {
    clientHeight: { value: height }, clientWidth: { value: 300 }, scrollHeight: { value: content }, scrollWidth: { value: 300 },
    getBoundingClientRect: { value: () => ({ left: 100, top: 50, right: 400, bottom: 50 + height, width: 300, height, x: 100, y: 50 }) },
  });
  document.body.append(node);
  return node;
}
const frame = () => new Promise<void>(resolve => dom.window.requestAnimationFrame(() => resolve()));
const event = (type: string, init: object = {}) => new dom.window.Event(type, { bubbles: true, ...init });

test("the shared handles follow the user's scrolling and nothing else", async () => {
  const { installScrollPills } = await import("../src/lib/scrollPills");
  const remove = installScrollPills();
  const layer = document.querySelector<HTMLElement>(".kd-scroll-float")!;
  const vertical = layer.querySelector<HTMLElement>('.kd-scroll-handle[data-axis="vertical"]')!;
  const list = pane(400, 2000);

  // A list that scrolls itself (lyrics following the song) shows no handle.
  list.scrollTop = 300;
  list.dispatchEvent(event("scroll"));
  assert.equal(layer.dataset.visible, undefined);

  // The user's wheel in it does, with a short pill at the matching place on its edge.
  list.firstElementChild!.dispatchEvent(event("wheel"));
  list.dispatchEvent(event("scroll"));
  assert.equal(layer.dataset.visible, "true");
  assert.equal(vertical.style.display, "");
  assert.equal(vertical.style.height, "72px");
  // rail = 400 - 3 - 3, travel = rail - 72, at 300 / 1600 of the way; the strip hugs the right edge.
  assert.equal(vertical.style.transform, `translate3d(${400 - 14}px, ${50 + 3 + (300 / 1600) * (394 - 72)}px, 0)`);

  // Scrolling on moves the same handle.
  list.scrollTop = 1600;
  list.firstElementChild!.dispatchEvent(event("wheel"));
  list.dispatchEvent(event("scroll"));
  await frame();
  assert.equal(vertical.style.transform, `translate3d(386px, ${50 + 3 + 322}px, 0)`);
  assert.equal(vertical.dataset.bump, "end", "arriving at the end squashes the pill against it");

  // Input in one container does not bring out a handle for another that moved by itself.
  const other = pane(400, 900);
  list.firstElementChild!.dispatchEvent(event("wheel"));
  other.dispatchEvent(event("scroll"));
  assert.equal(vertical.style.height, "72px");
  assert.ok(vertical.style.transform.includes(`${50 + 3 + 322}px`), "still on the first list");

  // Containers that cannot be scrolled by the user, or that draw their own handles, are left alone.
  remove();
  assert.equal(document.querySelector(".kd-scroll-float"), null);
  const again = installScrollPills();
  const fresh = document.querySelector<HTMLElement>(".kd-scroll-float")!;
  const hidden = pane(400, 2000, "overflow: hidden");
  hidden.firstElementChild!.dispatchEvent(event("wheel"));
  hidden.dispatchEvent(event("scroll"));
  assert.equal(fresh.dataset.visible, undefined);
  const host = document.createElement("div");
  host.className = "kd-overlay-scroll-host";
  const table = pane(400, 2000);
  host.append(table);
  document.body.append(host);
  table.firstElementChild!.dispatchEvent(event("wheel"));
  table.dispatchEvent(event("scroll"));
  assert.equal(fresh.dataset.visible, undefined);
  const strip = pane(40, 400);
  strip.firstElementChild!.dispatchEvent(event("wheel"));
  strip.dispatchEvent(event("scroll"));
  assert.equal(fresh.dataset.visible, undefined, "a strip too short for a handle gets none");
  again();
});
