// The page the studio is drawn into. Imported first: app modules touch the DOM when they load.
import { JSDOM } from "jsdom";

export const dom = new JSDOM('<div id="root"></div><div id="dock"></div>', { url: "http://localhost" });
dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any;
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement, HTMLCanvasElement: dom.window.HTMLCanvasElement,
  Node: dom.window.Node, Element: dom.window.Element, HTMLMediaElement: dom.window.HTMLMediaElement, HTMLIFrameElement: dom.window.HTMLIFrameElement, IS_REACT_ACT_ENVIRONMENT: true });
let next = 0;
export const frames = new Map<number, FrameRequestCallback>();
Object.assign(globalThis, {
  requestAnimationFrame: (f: FrameRequestCallback) => { frames.set(++next, f); return next; },
  cancelAnimationFrame: (id: number) => frames.delete(id),
  ResizeObserver: class { observe() {} disconnect() {} },
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
});
Object.defineProperty(document, "hidden", { configurable: true, value: false });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => ({ save(){},restore(){},drawImage(){},globalAlpha:1 }) });
