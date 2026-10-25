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

test("a page that is renamed is written in place: Enter keeps the new name, Esc the old one", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { TitleTabs } = await import("../src/components/drawer/TitleTabs");
  const root = createRoot(document.getElementById("root")!);
  const renamed: Array<[string, string]> = [];
  const tabs = [{ id: "/a.kdjv", label: "ed8409a611430571 剪辑" }];
  const write = (input: HTMLInputElement, text: string) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const field = () => document.querySelector<HTMLInputElement>(".kd-title-tab-name");
  const word = () => document.querySelector<HTMLElement>('[role="tab"][data-tab="/a.kdjv"]')!;
  try {
    await act(async () => root.render(createElement(TitleTabs<string>, {
      label: "剪辑", tabs, value: "/a.kdjv", onChange: () => undefined, onRename: (id, name) => { renamed.push([id, name]); },
    })));
    await act(async () => { word().dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
    assert.equal(field()?.value, "ed8409a611430571 剪辑", "the word becomes a field holding its name");
    await act(async () => { write(field()!, "  命运石之门 OP  "); });
    await act(async () => { field()!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.deepEqual(renamed, [["/a.kdjv", "命运石之门 OP"]]);
    assert.equal(field(), null, "and is a word again");
    await act(async () => { word().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "F2", bubbles: true })); });
    await act(async () => { write(field()!, "不要了"); });
    await act(async () => { field()!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.deepEqual(renamed, [["/a.kdjv", "命运石之门 OP"]], "Esc keeps the old name");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
