import assert from "node:assert/strict";
import test from "node:test";
import type { Account } from "../src/types";

test("all browser accounts use four explicit login choices and dispatch only the selected source", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const detail = "测试账号核验失败；完整错误应留在当前登录窗口，不读取真实凭证";
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  Object.assign(dom.window, {
    kdj: { platform: "win32", baseUrl: "http://localhost", authToken: "test-only",
      openYtmWebLogin: async () => { calls.push("window:ytm"); throw new Error(detail); },
      openYoutubeWebLogin: async () => { calls.push("window:youtube"); throw new Error(detail); },
      openSoundcloudWebLogin: async () => { calls.push("window:soundcloud"); throw new Error(detail); },
    },
    __TAURI_INTERNALS__: { transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: { event?: string }) => {
        if (command === "plugin:event|listen") calls.push(args.event!);
        return 1;
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  });
  let emptyCatalog = false;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? "GET"}:${path}`);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (path.endsWith("/authorize")) assert.deepEqual(body, { browser: "edge" });
      else if (path.endsWith("/headers")) assert.deepEqual(body, { headers: "cookie: test-only" });
      else assert.deepEqual(body, { browser: "edge", profile: "default" });
      throw new Error(detail);
    }
    return new Response(JSON.stringify({ supported: true, platform: dom.window.kdj.platform === "darwin" ? "macos" : "windows",
      installed_browsers: [], authorization_browsers: emptyCatalog ? [] : [{ id: "edge", label: "Edge", method: "remote_debugging" }],
      browsers: emptyCatalog ? [] : [{ id: "edge", label: "Edge", profiles: [{ id: "default", label: "用户", requires_elevation: false }] }],
    }), { headers: { "content-type": "application/json" } });
  };
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AccountRow } = await import("../src/components/settings/AccountRow");
  const root = createRoot(document.getElementById("root")!);
  const click = async (label: string, within: ParentNode = document) => {
    const button = [...within.querySelectorAll("button")].find(node => node.textContent === label);
    assert.ok(button, `missing ${label}`);
    await act(async () => button.click());
  };
  const fillHeaders = async () => {
    const textarea = document.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "cookie: test-only");
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  try {
    for (const os of ["win32", "darwin"]) {
      dom.window.kdj.platform = os;
      for (const platform of ["soundcloud", "ytm", "youtube"] as const) {
        const account: Account = { platform, label: platform === "soundcloud" ? "SoundCloud" : platform === "ytm" ? "YouTube Music" : "YouTube Video",
          state: "valid", nickname: "Test", avatar: "", detail: "", supports_login: true, login_method: "browser" };
        await act(async () => root.render(createElement(AccountRow, { key: `${os}-${platform}`, account, sourceEnabled: true, onToggleSource: () => {} })));
        const beforeOpen = calls.length;
        await click("重新登录");
        assert.equal(calls.length, beforeOpen, "opening the method list must do no I/O");
        const methods = [os === "darwin" ? "钥匙串读取" : "直接读取", "浏览器授权", "导入请求头", "登录窗口"];
        assert.deepEqual([...document.querySelectorAll(".kd-account-login-methods button")].map(node => node.textContent), methods);
        for (const [index, method] of methods.entries()) {
          const postsBefore = calls.filter(c => c.startsWith("POST:") || c.startsWith("window:")).length;
          await click(method);
          const panel = document.querySelector<HTMLElement>(".kd-account-login-panel")!;
          assert.ok(panel, "selecting a method opens its flow in place, under the choices");
          assert.equal(document.querySelector("dialog"), null, "a login flow is never a window over the settings");
          assert.equal(calls.filter(c => c.startsWith("POST:") || c.startsWith("window:")).length, postsBefore,
            "method selection may discover browsers but never read credentials or open a login window");
          if (index === 2) await fillHeaders();
          await click("登录", panel);
          assert.equal(panel.querySelector(".kd-notice-text")?.textContent, `登录失败：${index === 3 ? "" : "无法连接本地服务："}${detail}`);
          const action = index === 0 ? "browser" : index === 1 ? "browser/authorize" : "headers";
          assert.ok(calls.includes(index === 3 ? `window:${platform}` : `POST:/api/accounts/${platform}/login/${action}`));
          if (index === 3) assert.ok(calls.includes(`${platform}-web-login://result`));
          await click(method);
          assert.equal(document.querySelector(".kd-account-login-panel"), null, "choosing the open way again puts it away");
        }
        await click("导入请求头");
        assert.equal(document.querySelector("textarea")?.value, "", "closing removes pasted credentials");
        await click("导入请求头");
      }
    }
    emptyCatalog = true;
    await click("浏览器授权");
    const panel = document.querySelector<HTMLElement>(".kd-account-login-panel")!;
    assert.equal([...panel.querySelectorAll("button")].find(b => b.textContent === "登录")?.disabled, true);
    assert.equal(panel.querySelector("select"), null, "empty browser choices remain empty");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
