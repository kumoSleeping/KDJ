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
    MutationObserver: dom.window.MutationObserver,
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
  const heightOf = (element: Element): number => element.classList.contains("kd-list-row") ? 36
    : element.classList.contains("kd-list-head") ? 28
    : element.classList.contains("kd-list-block") ? element.querySelectorAll(".kd-list-row").length * 36 : 720;
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 720; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 1000; } });
  // The virtualized lists measure their scroll box by its offset size.
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return this.classList.contains("kd-scroll") ? 720 : heightOf(this); } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return 1000; } });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const height = heightOf(this);
    return { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: height, width: 1000, height, toJSON() {} };
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

/** The columns a list is laid out by: nothing of it may change when picking starts or ends. */
export const layoutOf = (list: Element) => JSON.stringify({
  cols: (list as HTMLElement).style.getPropertyValue("--kd-list-cols"),
  head: [...list.querySelectorAll(".kd-list-head > *")].map(cell => cell.getAttribute("data-col") ?? cell.className),
  cells: [...(list.querySelector(".kd-list-row")?.children ?? [])].map(cell => cell.getAttribute("data-col") ?? cell.className),
});

