import { JSDOM } from "jsdom";
import { act } from "react";

/** A DOM the two tables can be mounted in: fixed boxes, frames run by the test. */
export function setUpDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const raf = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; };
  const cancel = (id: number) => frames.delete(id);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    HTMLTableRowElement: dom.window.HTMLTableRowElement, MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: raf, cancelAnimationFrame: cancel, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  dom.window.requestAnimationFrame = raf;
  dom.window.cancelAnimationFrame = cancel;
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia;
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLCanvasElement.prototype.getContext = (() => null) as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 720; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 1000; } });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: this.tagName === "TR" ? 36 : 720,
      width: 1000, height: this.tagName === "THEAD" ? 28 : this.tagName === "TR" ? 36 : 720, toJSON() {} };
  };
  const flush = async () => {
    await act(async () => {
      const current = [...frames.values()]; frames.clear();
      for (const callback of current) callback(performance.now());
      await new Promise(resolve => setImmediate(resolve));
    });
  };
  const mouse = (type: string, init: MouseEventInit = {}) =>
    new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, detail: 1, ...init });
  const click = (target: Element, init: MouseEventInit = {}) => act(async () => { target.dispatchEvent(mouse("click", init)); });
  const key = (name: string, target: EventTarget = dom.window) => act(async () => {
    target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
  const menuItem = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".kd-context-menu button")].find(button => button.textContent?.includes(text));
  return { dom, frames, flush, mouse, click, key, menuItem };
}

/** The widths the table is laid out by: nothing of it may change when picking starts or ends. */
export const layoutOf = (table: Element) => JSON.stringify({
  cols: [...table.querySelectorAll("colgroup > col")].map(col => col.getAttribute("style")),
  head: [...table.querySelectorAll("thead th")].map(th => th.getAttribute("data-col") ?? th.className),
  cells: [...(table.querySelector("tbody tr:not([data-spacer])")?.children ?? [])].map(td => td.getAttribute("data-col") ?? td.className),
});

