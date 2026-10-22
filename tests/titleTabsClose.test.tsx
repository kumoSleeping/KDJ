import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";

test("pages that close each have their own ×, and Delete on a page closes it", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { TitleTabs } = await import("../src/components/drawer/TitleTabs");
  const root = createRoot(document.getElementById("root")!);
  const closed: string[] = [];
  const tabs = [{ id: "/a.kdjv", label: "第一个工程" }, { id: "/b.kdjv", label: "第二个工程，名字很长很长很长" }];
  try {
    await act(async () => root.render(createElement(TitleTabs<string>, {
      label: "剪辑", tabs, value: "/a.kdjv", onChange: () => undefined, onClose: id => { closed.push(id); },
    })));
    assert.ok(document.querySelector('.kd-title-tabs-list[data-closable]'));
    const keys = [...document.querySelectorAll<HTMLButtonElement>(".kd-title-tab-close")];
    assert.deepEqual(keys.map(key => key.getAttribute("aria-label")), ["关闭 第一个工程", "关闭 第二个工程，名字很长很长很长"]);
    assert.ok(keys[0].hasAttribute("data-selected"), "the page in view shows its × always");
    await act(async () => { keys[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.deepEqual(closed, ["/b.kdjv"]);
    const first = document.querySelector<HTMLElement>('[role="tab"][data-tab="/a.kdjv"]')!;
    await act(async () => { first.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
    assert.deepEqual(closed, ["/b.kdjv", "/a.kdjv"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
