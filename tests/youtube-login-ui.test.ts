import assert from "node:assert/strict";
import test from "node:test";
import type { Account } from "../src/types";

test("desktop YouTube and SoundCloud login controls dispatch separately and show the full failure", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const detail = "测试会话验证失败：这是保留完整错误详情的回归测试，不读取真实浏览器凭证";
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(dom.window, {
    kdj: {
      platform: "win32", baseUrl: "http://localhost", authToken: "test-only",
      openYtmWebLogin: async () => { calls.push("ytm"); throw new Error(detail); },
      openYoutubeWebLogin: async () => { calls.push("youtube"); throw new Error(detail); },
      openSoundcloudWebLogin: async () => { calls.push("soundcloud"); throw new Error(detail); },
    },
    __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: { event?: string }) => {
        if (command === "plugin:event|listen") calls.push(args.event!);
        return 1;
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    supported: true, platform: "windows", browsers: [],
  }), { status: 200, headers: { "content-type": "application/json" } });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AccountRow } = await import("../src/components/settings/AccountRow");
  const root = createRoot(document.getElementById("root")!);
  const click = async (text: string) => {
    const button = [...document.querySelectorAll("button")].find(node => node.textContent === text);
    assert.ok(button, `missing ${text} control`);
    await act(async () => button.click());
  };
  try {
    const labels = { ytm: "YouTube Music", youtube: "YouTube Video", soundcloud: "SoundCloud" };
    for (const platform of ["ytm", "youtube", "soundcloud"] as const) {
      const account: Account = {
        platform, label: labels[platform],
        state: "missing", nickname: "", avatar: "", detail: "",
        supports_login: true, login_method: "browser",
      };
      await act(async () => root.render(createElement(AccountRow, {
        key: platform, account, sourceEnabled: true, onToggleSource: () => {},
      })));
      await click("连接");
      await click("打开登录窗口");
      assert.ok(calls.includes(platform));
      assert.ok(calls.includes(`${platform}-web-login://result`));
      const notice = document.querySelector(".kd-account-notice .kd-notice-text");
      assert.equal(notice?.textContent, `打开 ${account.label} 登录失败：${detail}`);
      assert.equal(notice?.getAttribute("title"), notice?.textContent);
    }
    assert.equal(calls.filter(call => call === "ytm").length, 1);
    assert.equal(calls.filter(call => call === "youtube").length, 1);
    assert.equal(calls.filter(call => call === "soundcloud").length, 1);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
