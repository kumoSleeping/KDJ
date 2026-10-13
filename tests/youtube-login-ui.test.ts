import assert from "node:assert/strict";
import test from "node:test";
import type { Account } from "../src/types";

test("all browser accounts use four explicit login choices and dispatch only the selected source", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/", pretendToBeVisual: true });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  let webviewPending = false;
  let safariDenied = false;
  let settingsUnavailable = false;
  const permissionError = "macOS 拒绝访问 Safari 登录数据；请在系统设置「隐私与安全性 → 完全磁盘访问权限」中允许当前运行的 KDJ";
  let windowEvent: ((event: { payload: { status: string; message: string } }) => void) | undefined;
  const detail = "测试账号核验失败；完整错误应留在当前登录窗口，不读取真实凭证";
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  Object.assign(dom.window, {
    kdj: { platform: "win32", baseUrl: "http://localhost", authToken: "test-only",
      openExternal: async (url: string) => {
        calls.push(`external:${url}`);
        if (settingsUnavailable) throw new Error("系统设置不可用");
      },
      openYtmWebLogin: async () => { calls.push("window:ytm"); throw new Error(detail); },
      openYoutubeWebLogin: async () => { calls.push("window:youtube"); throw new Error(detail); },
      openSoundcloudWebLogin: async () => { calls.push("window:soundcloud"); if (!webviewPending) throw new Error(detail); },
    },
    __TAURI_INTERNALS__: { transformCallback: (callback: typeof windowEvent) => { windowEvent = callback; return 1; }, unregisterCallback: () => {},
      invoke: async (command: string, args: { event?: string }) => {
        if (command === "plugin:event|listen") calls.push(args.event!);
        return 1;
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  });
  let emptyCatalog = false;
  let pendingAuthorization = false;
  let finishAuthorization: ((response: Response) => void) | undefined;
  let authorizationId = "";
  let expectedBrowser = "edge";
  let expectedConfirmedProfile: string | undefined;
  let expectedNewWindow = false;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    // Delayed diagnostics are independent of login actions, including on slow CI hosts.
    if (path === "/api/diagnostics/entries" || path === "/api/activity/logs/batch") return new Response("{}", { status: 200 });
    calls.push(`${init?.method ?? "GET"}:${path}`);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (path.endsWith("/cancel")) {
        assert.equal(body.request_id, authorizationId, "cancel only the owning attempt");
        finishAuthorization?.(new Response(JSON.stringify({ detail: "浏览器登录已取消" }), { status: 400 }));
        return new Response(JSON.stringify({ cancelled: true }));
      }
      if (path.endsWith("/authorize")) {
        assert.equal(body.browser, expectedBrowser); assert.match(body.request_id, /^[0-9a-f-]{36}$/);
        assert.equal(body.profile, expectedConfirmedProfile);
        assert.equal(body.profile_read_confirmed, !!expectedConfirmedProfile);
        assert.equal(body.new_window, expectedNewWindow);
      }
      else if (path.endsWith("/headers")) assert.deepEqual(body, { headers: "cookie: test-only" });
      else assert.deepEqual(body, { browser: "zen", profile: "default" });
      if (pendingAuthorization && path.endsWith("/authorize")) {
        authorizationId = body.request_id;
        return new Promise<Response>(resolve => { finishAuthorization = resolve; });
      }
      if (safariDenied) return new Response(JSON.stringify({ detail: permissionError }), { status: 400 });
      throw new Error(detail);
    }
    return new Response(JSON.stringify({ supported: true, platform: dom.window.kdj.platform === "darwin" ? "macos" : "windows",
      installed_browsers: [], authorization_browsers: emptyCatalog ? [] : [{ id: "edge", label: "Edge", method: "remote_debugging" }, { id: "zen", label: "Zen", method: "gecko_rdp" },
        { id: "mystery", label: "Mystery", method: "profile_confirmation", profiles: [
          { id: "ordinary", label: "个人", requires_elevation: false }, { id: "work", label: "工作", requires_elevation: false },
        ] }],
      browsers: emptyCatalog ? [] : [{ id: "zen", label: "Zen", profiles: [{ id: "default", label: "用户", requires_elevation: false }] }],
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
        assert.ok(calls.slice(beforeOpen).every(call => call.startsWith("GET:")), "opening defaults to browser discovery, never credential access");
        const methods = ["浏览器授权", "直接读取", "导入请求头", "登录窗口"];
        assert.deepEqual([...document.querySelectorAll(".kd-account-login-methods button")].map(node => node.textContent), methods);
        for (const [index, method] of methods.entries()) {
          const postsBefore = calls.filter(c => c.startsWith("POST:") || c.startsWith("window:")).length;
          if (!document.querySelector(`.kd-account-login-methods button[data-active]`)?.textContent?.includes(method)) await click(method);
          if (index === 3) {
            assert.equal(document.querySelector(".kd-account-login-panel"), null, "login window opens directly with no second panel");
            assert.equal(document.querySelector(".kd-notice-text")?.textContent, `登录失败：${detail}`);
            assert.equal(calls.filter(c => c.startsWith("POST:") || c.startsWith("window:")).length, postsBefore + 1);
            assert.ok(calls.includes(`window:${platform}`));
            assert.ok(calls.includes(`${platform}-web-login://result`));
            continue;
          }
          const panel = document.querySelector<HTMLElement>(".kd-account-login-panel")!;
          assert.ok(panel, "selecting a method opens its flow in place, under the choices");
          assert.equal(document.querySelector("dialog"), null, "a login flow is never a window over the settings");
          assert.equal(calls.filter(c => c.startsWith("POST:") || c.startsWith("window:")).length, postsBefore,
            "method selection may discover browsers but never read credentials or open a login window");
          if (index === 1) {
            const options = [...panel.querySelectorAll("option")];
            assert.deepEqual(options.map(option => option.textContent), ["Zen · 用户"]);
          }
          if (index === 2) await fillHeaders();
          await click("登录", panel);
          assert.equal(panel.querySelector(".kd-notice-text")?.textContent, `登录失败：${index === 3 ? "" : "无法连接本地服务："}${detail}`);
          const action = index === 1 ? "browser" : index === 0 ? "browser/authorize" : "headers";
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
    safariDenied = true;
    for (const os of ["darwin", "win32"]) {
      dom.window.kdj.platform = os;
      for (const platform of ["soundcloud", "ytm", "youtube"] as const) {
        const account: Account = { platform, label: platform, state: "valid", nickname: "Test", avatar: "", detail: "", supports_login: true, login_method: "browser" };
        await act(async () => root.render(createElement(AccountRow, { key: `permission-${os}-${platform}`, account, sourceEnabled: true, onToggleSource: () => {} })));
        await click("重新登录");
        await click("直接读取");
        const before = calls.filter(c => c.startsWith("external:")).length;
        await click("登录", document.querySelector(".kd-account-login-panel")!);
        assert.equal(calls.filter(c => c.startsWith("external:")).length, before);
        if (os === "darwin") {
          assert.equal(document.querySelector(".kd-account-login-status")?.textContent, "需要完全磁盘访问权限");
          await click("开启权限");
          assert.equal(calls.at(-1), "external:x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
          assert.equal(document.querySelector(".kd-notice-text"), null, "opening settings replaces the permission error wall");
          const postsBeforeReturn = calls.filter(c => c.startsWith("POST:")).length;
          await act(async () => {
            dom.window.dispatchEvent(new dom.window.Event("focus"));
            document.dispatchEvent(new dom.window.Event("visibilitychange"));
          });
          assert.equal(calls.filter(c => c.startsWith("POST:")).length, postsBeforeReturn + 1, "returning from Settings retries the selected login exactly once");
          assert.match(document.querySelector(".kd-notice-text")!.textContent!, /已允许则退出并重新打开 KDJ/);
          await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
          assert.equal(calls.filter(c => c.startsWith("POST:")).length, postsBeforeReturn + 1, "ordinary focus never retries again");
          settingsUnavailable = true;
          await click("开启权限");
          assert.match(document.querySelector(".kd-notice-text")!.textContent!, /无法打开权限设置：系统设置不可用/);
          await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
          assert.equal(calls.filter(c => c.startsWith("POST:")).length, postsBeforeReturn + 1, "failed settings launch does not arm a retry");
          settingsUnavailable = false;
        } else {
          assert.match(document.querySelector(".kd-notice-text")!.textContent!, /登录失败/);
        }
        assert.equal([...document.querySelectorAll<HTMLButtonElement>(".kd-account-login-panel button")].find(b => b.textContent === "登录")?.disabled, false);
      }
    }
    safariDenied = false;
    dom.window.kdj.platform = "win32";
    const account: Account = { platform: "soundcloud", label: "SoundCloud", state: "valid", nickname: "Test", avatar: "", detail: "", supports_login: true, login_method: "browser" };
    await act(async () => root.render(createElement(AccountRow, { key: "cancellation", account, sourceEnabled: true, onToggleSource: () => {} })));
    await click("重新登录");
    pendingAuthorization = true;
    await click("登录", document.querySelector(".kd-account-login-panel")!);
    assert.ok(document.querySelector(".kd-account-login-status")?.textContent?.includes("开启远程调试"));
    await click("取消");
    assert.equal(document.querySelector(".kd-notice-text")?.textContent, "登录失败：浏览器登录已取消");
    assert.equal([...document.querySelectorAll<HTMLButtonElement>(".kd-account-login-panel button")].find(b => b.textContent === "登录")?.disabled, false);
    const select = document.querySelector("select")!;
    await act(async () => { select.value = "zen"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    expectedBrowser = "zen";
    assert.equal(document.querySelector("details"), null, "browser authorization has no instruction wall");
    await click("登录", document.querySelector(".kd-account-login-panel")!);
    assert.equal(document.querySelector(".kd-account-login-status")?.textContent, "等待浏览器工具箱授权，完成后自动继续");
    assert.ok(document.querySelector("fieldset")?.textContent?.includes("Ctrl + Alt + Shift + I"));
    const cancellationCount = calls.filter(c => c.endsWith("/cancel")).length;
    await act(async () => root.render(createElement("div")));
    assert.equal(calls.filter(c => c.endsWith("/cancel")).length, cancellationCount + 1, "unmount cancels server work");
    pendingAuthorization = false;
    for (const platform of ["soundcloud", "ytm", "youtube"] as const) {
      await act(async () => root.render(createElement(AccountRow, { key: `consent-${platform}`, account: { ...account, platform }, sourceEnabled: true, onToggleSource: () => {} })));
      await click("重新登录");
      const browserSelect = document.querySelector("select")!;
      await act(async () => { browserSelect.value = "mystery"; browserSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      const profileSelect = document.querySelectorAll("select")[1];
      await act(async () => { profileSelect.value = "work"; profileSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      const posts = () => calls.filter(c => c.startsWith("POST:")).length;
      const beforeConsent = posts();
      assert.equal(document.querySelector(".kd-account-login-consent"), null);
      assert.equal(profileSelect.disabled, false);
      assert.equal(posts(), beforeConsent, "selecting browser and profile never reads credentials");
      expectedBrowser = "mystery";
      expectedConfirmedProfile = "work";
      await click("允许并登录");
      assert.equal(posts(), beforeConsent + 1, "one allow-and-login click sends one confirmed request");
      assert.ok(calls.includes(`POST:/api/accounts/${platform}/login/browser/authorize`));
      assert.equal(document.querySelector(".kd-account-login-consent"), null);
      assert.ok(document.querySelector(".kd-notice-text")?.textContent?.includes(detail));
    }
    expectedConfirmedProfile = undefined;
    await act(async () => root.render(createElement(AccountRow, { key: "isolated-fallback", account, sourceEnabled: true, onToggleSource: () => {} })));
    await click("重新登录");
    expectedBrowser = "edge";
    const newWindow = document.querySelector<HTMLInputElement>(".kd-account-login-panel input[type=checkbox]")!;
    const beforeWindowChoice = calls.filter(c => c.startsWith("POST:")).length;
    await act(async () => newWindow.click());
    assert.equal(calls.filter(c => c.startsWith("POST:")).length, beforeWindowChoice, "fallback choice never starts login by itself");
    expectedNewWindow = true;
    await click("登录", document.querySelector(".kd-account-login-panel")!);
    expectedNewWindow = false;

    await act(async () => root.render(createElement(AccountRow, { key: "google-handoff", account, sourceEnabled: true, onToggleSource: () => {} })));
    await click("重新登录");
    webviewPending = true;
    await click("登录窗口");
    assert.equal(document.querySelector(".kd-account-login-panel"), null);
    await act(async () => windowEvent?.({ payload: { status: "browser_required", message: "Google 登录需使用浏览器" } }));
    assert.equal(document.querySelector(".kd-account-login-panel")?.getAttribute("aria-label"), "SoundCloud · 浏览器授权");
    assert.ok(document.querySelector("select"), "Google handoff exposes the real-browser selector");
    assert.equal([...document.querySelectorAll<HTMLButtonElement>(".kd-account-login-panel button")].find(b => b.textContent === "登录")?.disabled, false);
    webviewPending = false;
    emptyCatalog = true;
    await act(async () => root.render(createElement(AccountRow, { key: "empty", account, sourceEnabled: true, onToggleSource: () => {} })));
    await click("重新登录");

    const panel = document.querySelector<HTMLElement>(".kd-account-login-panel")!;
    assert.equal([...panel.querySelectorAll("button")].find(b => b.textContent === "登录")?.disabled, true);
    assert.equal(panel.querySelector("select"), null, "empty browser choices remain empty");
  } finally {
    await act(async () => root.unmount());
    await (await import("../src/lib/diagnostics")).flushDiagnostics();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
