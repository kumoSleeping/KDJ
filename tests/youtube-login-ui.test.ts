import assert from "node:assert/strict";
import test from "node:test";
import type { Account } from "../src/types";

test("an account logs in from its own row: one key, the ways in place, one request per press", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/", pretendToBeVisual: true });
  const calls: string[] = [];
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  let webviewPending = false;
  let clipboard = "";
  let clipboardReads = 0;
  let settingsUnavailable = false;
  const permissionError = "macOS 拒绝访问 Safari 登录数据；请在系统设置「隐私与安全性 → 完全磁盘访问权限」中允许当前运行的 KDJ";
  let windowEvent: ((event: { payload: { status: string; message: string } }) => void) | undefined;
  const detail = "测试账号核验失败；不读取真实凭证";
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(dom.window, {
    kdj: { platform: "win32", baseUrl: "http://localhost", authToken: "test-only",
      readClipboardText: async () => { clipboardReads++; return clipboard; },
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
  const signedIn = (platform: string): Account => ({ platform: platform as Account["platform"], label: platform, state: "valid",
    nickname: "Test", avatar: "", detail: "", supports_login: true, login_method: "browser" });
  let emptyCatalog = false;
  /** How the next browser logins answer: a thrown error by default. */
  let answer: (body: Record<string, unknown>, path: string) => Response | Promise<Response> | undefined = () => undefined;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    // Delayed diagnostics are independent of login actions, including on slow CI hosts.
    if (path === "/api/diagnostics/entries" || path === "/api/activity/logs/batch") return new Response("{}", { status: 200 });
    calls.push(`${init?.method ?? "GET"}:${path}`);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      posts.push({ path, body });
      if (path.endsWith("/login/qr")) return json({ platform: "wyy", session_id: "qr-1", image: "data:image/png;base64,AA==", url: "", expires_in: 120,
        variants: path.includes("/qqm/") ? [{ id: "music", label: "QQ 音乐", image: "data:image/png;base64,AA==" }, { id: "qq", label: "QQ", image: "data:image/png;base64,AA==" }] : undefined });
      if (path.endsWith("/cancel")) return json({ cancelled: true });
      if (path.endsWith("/browser/open")) return json({ opened: true });
      if (path.endsWith("/headers")) assert.deepEqual(body, { headers: "cookie: test-only" });
      const answered = await answer(body, path);
      if (answered) return answered;
      throw new Error(detail);
    }
    if (path.includes("/login/qr/")) return json({ session_id: "qr-1", state: "waiting", message: "" });
    return json({ supported: true, platform: dom.window.kdj.platform === "darwin" ? "macos" : "windows", browsers: emptyCatalog ? [] : [
      { id: "edge", label: "Edge", profiles: [{ id: "personal", label: "个人" }, { id: "work", label: "工作" }], reuse: true, window: true, open: true },
      { id: "safari", label: "Safari", profiles: [{ id: "default", label: "默认" }], reuse: true, window: false, open: true },
      { id: "fork", label: "Fork", profiles: [{ id: "locked", label: "读不了" }], reuse: false, window: true, open: true },
    ] });
  };
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AccountRow } = await import("../src/components/settings/AccountRow");
  const root = createRoot(document.getElementById("root")!);
  const buttons = (within: ParentNode = document) => [...within.querySelectorAll("button")];
  const click = async (label: string, within: ParentNode = document) => {
    const button = buttons(within).find(node => node.textContent === label);
    assert.ok(button, `missing ${label}`);
    await act(async () => button.click());
  };
  const choose = async (select: HTMLSelectElement, value: string) => {
    await act(async () => { select.value = value; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  };
  const fillHeaders = async () => {
    const textarea = document.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "cookie: test-only");
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const render = async (key: string, account: Account) => {
    await act(async () => root.render(createElement(AccountRow, { key, account, sourceEnabled: true, onToggleSource: () => {} })));
  };
  const panel = () => document.querySelector<HTMLElement>(".kd-account-login-panel")!;
  const methods = () => [...document.querySelectorAll(".kd-account-login-methods button")].map(node => node.textContent);
  const notice = () => document.querySelector(".kd-notice-text")?.textContent;
  const loginPosts = () => posts.filter(post => post.path.endsWith("/login/browser"));
  const stepKeys = () => [...panel().querySelectorAll(".kd-account-login-steps button")].map(node => node.textContent);
  const comeBack = () => act(async () => {
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
  });
  const browserAccount = (platform: "soundcloud" | "ytm" | "youtube", state: Account["state"] = "missing"): Account => ({
    platform, label: platform === "soundcloud" ? "SoundCloud" : platform === "ytm" ? "YouTube Music" : "YouTube Video",
    state, nickname: "", avatar: "", detail: "", supports_login: true, login_method: "browser" });
  const qrAccount = (platform: "wyy" | "qqm" | "bilibili"): Account => ({ platform, label: platform, state: "missing",
    nickname: "", avatar: "", detail: "", supports_login: true, login_method: "qr" });
  try {
    // A row has its switch and one key: 登录, or 退出 once there is a login. Nothing else.
    await render("signed-in", browserAccount("soundcloud", "valid"));
    assert.deepEqual(buttons().map(node => node.textContent), ["开", "退出"]);
    await render("signed-in-qr", { ...qrAccount("wyy"), state: "valid" });
    assert.deepEqual(buttons().map(node => node.textContent), ["开", "退出"]);

    for (const os of ["win32", "darwin"]) {
      dom.window.kdj.platform = os;
      for (const platform of ["soundcloud", "ytm", "youtube"] as const) {
        await render(`${os}-${platform}`, browserAccount(platform));
        assert.deepEqual(buttons().map(node => node.textContent), ["开", "登录"]);
        const beforeOpen = calls.length;
        await click("登录");
        assert.deepEqual(methods(), ["复用浏览器", "登录窗口", "请求头"]);
        assert.equal(calls.length, beforeOpen, "opening shows the ways and asks for nothing");
        assert.equal(document.querySelector(".kd-account-login-panel"), null, "no way is open until one is chosen");
        assert.equal(document.querySelector(".kd-account-login-methods button[data-active]"), null);
        await click("复用浏览器");
        assert.ok(calls.slice(beforeOpen).every(call => call.startsWith("GET:")), "choosing it looks for browsers and reads no login");
        assert.ok(calls.includes(`GET:/api/accounts/${platform}/login/browsers`));
        assert.equal(panel().getAttribute("aria-label"), `${browserAccount(platform).label} · 复用浏览器`);
        assert.equal(document.querySelector("dialog, [role=dialog]"), null, "a login is never a window over the settings");
        assert.deepEqual([...panel().querySelectorAll("select")[0].querySelectorAll("option")].map(option => option.textContent), ["Edge", "Safari", "Fork"]);

        // A press reads the chosen browser once, on every platform; no window of it follows.
        let before = loginPosts().length;
        const profile = panel().querySelectorAll("select")[1];
        await choose(profile, "work");
        assert.equal(loginPosts().length, before, "choosing a browser or a profile reads nothing");
        assert.deepEqual(stepKeys(), [], "a browser that can be read shows no steps");
        await click("登录", panel());
        const attempts = loginPosts().slice(before);
        assert.deepEqual(attempts.map(post => [post.path, post.body.browser, post.body.profile, post.body.window]),
          [[`/api/accounts/${platform}/login/browser`, "edge", "work", undefined]]);
        assert.match(String(attempts[0].body.request_id), /^[0-9a-f-]{36}$/);
        assert.equal(notice(), `登录失败：无法连接本地服务：${detail}`);

        // After a read that failed the same browser can hand its login over by the extension.
        await click("用 Cookie-Editor 导入", panel());
        assert.deepEqual(stepKeys(), ["在 Edge 打开", "安装", "粘贴"]);
        assert.equal(notice(), undefined);
        assert.equal(buttons(panel()).some(button => button.textContent === "登录"), false);

        before = loginPosts().length;
        await choose(panel().querySelectorAll("select")[0], "safari");
        assert.deepEqual(stepKeys(), [], "another browser starts from its own reading");
        assert.equal(panel().querySelectorAll("select").length, 1, "one profile is not a choice");
        await click("登录", panel());
        assert.deepEqual(loginPosts().slice(before).map(post => [post.body.browser, post.body.profile]), [["safari", "default"]]);
        // A browser whose login cannot be read is not asked for it: its steps stand there at once.
        before = loginPosts().length;
        await choose(panel().querySelectorAll("select")[0], "fork");
        assert.deepEqual(stepKeys(), ["在 Fork 打开", "安装", "粘贴"]);
        assert.equal(panel().querySelectorAll("select").length, 1, "its profiles are no choice either");
        assert.equal(buttons(panel()).some(button => button.textContent === "登录"), false);
        assert.equal(loginPosts().length, before);

        await click("请求头");
        assert.equal(panel().getAttribute("aria-label"), `${browserAccount(platform).label} · 请求头`);
        await fillHeaders();
        await click("登录", panel());
        assert.ok(calls.includes(`POST:/api/accounts/${platform}/login/headers`));
        await click("请求头");
        assert.equal(document.querySelector(".kd-account-login-panel"), null, "choosing the open way again puts it away");
        await click("请求头");
        assert.equal(document.querySelector("textarea")?.value, "", "what was pasted does not come back");

        const windowsBefore = calls.filter(call => call.startsWith("window:")).length;
        await click("登录窗口");
        assert.equal(document.querySelector(".kd-account-login-panel"), null, "the login window opens at once, with no second panel");
        assert.equal(calls.filter(call => call.startsWith("window:")).length, windowsBefore + 1);
        assert.ok(calls.includes(`window:${platform}`) && calls.includes(`${platform}-web-login://result`));
        assert.equal(notice(), `登录失败：${detail}`);
      }
    }

    // A login that is read succeeds, and the row puts its ways away.
    dom.window.kdj.platform = "win32";
    await render("success", browserAccount("soundcloud"));
    await click("登录");
    await click("复用浏览器");
    answer = () => new Response(JSON.stringify(signedIn("soundcloud")), { headers: { "content-type": "application/json" } });
    let before = loginPosts().length;
    await click("登录", panel());
    assert.equal(loginPosts().length, before + 1);
    assert.equal(document.querySelector(".kd-account-login-panel"), null);
    assert.equal(dom.window.localStorage.getItem("kdj.login.browser.soundcloud"), "edge");
    answer = () => undefined;

    // 取消 stops the request it belongs to; nothing is reported.
    await render("cancel", browserAccount("soundcloud"));
    await click("登录");
    await click("复用浏览器");
    let finish: ((response: Response) => void) | undefined;
    answer = () => new Promise<Response>(resolve => { finish = resolve; });
    before = loginPosts().length;
    await click("登录", panel());
    assert.equal(document.querySelector(".kd-account-login-status")?.textContent, "正在读取浏览器登录");
    assert.ok(buttons(document.querySelector(".kd-account-login-methods")!).every(button => button.disabled), "the other ways stay still meanwhile");
    await click("取消");
    assert.deepEqual(posts.at(-1), { path: "/api/accounts/browser/login/cancel", body: { request_id: loginPosts().at(-1)!.body.request_id } });
    await act(async () => finish!(new Response(JSON.stringify({ detail: "浏览器登录已取消" }), { status: 400 })));
    assert.equal(loginPosts().length, before + 1, "a stopped login is not retried");
    assert.equal(notice(), undefined);
    assert.equal(buttons(panel()).find(button => button.textContent === "登录")?.disabled, false);
    // Leaving the page stops the work.
    answer = () => new Promise<Response>(resolve => { finish = resolve; });
    await click("登录", panel());
    const cancels = calls.filter(call => call.endsWith("/cancel")).length;
    await act(async () => root.render(createElement("div")));
    assert.equal(calls.filter(call => call.endsWith("/cancel")).length, cancels + 1, "unmount cancels the server's work");
    answer = () => undefined;

    // A browser whose login cannot be read goes on in that browser: its site is opened there, not
    // in the default one, and the export is taken from the clipboard when the window is returned to.
    await render("export", browserAccount("youtube"));
    await click("登录");
    await click("复用浏览器");
    await choose(panel().querySelectorAll("select")[0], "fork");
    clipboard = JSON.stringify([
      { domain: ".youtube.com", path: "/", name: "SAPISID", value: "test-only", expirationDate: 4102444800 },
      { domain: ".example.com", path: "/", name: "other", value: "test-only" },
    ]);
    clipboardReads = 0;
    await comeBack();
    assert.equal(clipboardReads, 0, "the clipboard is not looked at before the user has gone to the browser");
    await click("安装", panel());
    assert.deepEqual(posts.at(-1), { path: "/api/accounts/youtube/login/browser/open", body: { browser: "fork", page: "extension" } });
    const exported = clipboard;
    clipboard = "https://example.com/?a=b";
    const exports = () => posts.filter(post => post.path.endsWith("/login/cookies"));
    await comeBack();
    assert.equal(clipboardReads, 1, "one return looks once");
    assert.equal(exports().length, 0, "what is not an export is left alone");
    assert.equal(notice(), undefined, "and nothing is said about it");
    await click("粘贴", panel());
    assert.match(notice()!, /不是 Cookie-Editor 导出的内容/);
    await click("在 Fork 打开", panel());
    assert.deepEqual(posts.at(-1), { path: "/api/accounts/youtube/login/browser/open", body: { browser: "fork", page: "site" } });
    clipboard = exported;
    answer = (_body, path) => path.endsWith("/login/cookies")
      ? new Response(JSON.stringify(signedIn("youtube")), { headers: { "content-type": "application/json" } }) : undefined;
    await comeBack();
    assert.deepEqual(exports().map(post => post.body), [{ headers: "Cookie: SAPISID=test-only" }], "only the site's own cookies are handed over");
    assert.equal(document.querySelector(".kd-account-login-panel"), null);
    answer = () => undefined;

    // Safari's refusal on macOS leads to the one system setting, and coming back retries once.
    dom.window.kdj.platform = "darwin";
    await render("permission", browserAccount("ytm"));
    await click("登录");
    await click("复用浏览器");
    await choose(panel().querySelectorAll("select")[0], "safari");
    answer = () => new Response(JSON.stringify({ detail: permissionError }), { status: 400 });
    await click("登录", panel());
    assert.equal(document.querySelector(".kd-account-login-status")?.textContent, "需要完全磁盘访问权限");
    assert.equal(notice(), undefined);
    await click("开启权限");
    assert.equal(calls.at(-1), "external:x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
    before = loginPosts().length;
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      document.dispatchEvent(new dom.window.Event("visibilitychange"));
    });
    assert.equal(loginPosts().length, before + 1, "returning from Settings retries the selected login exactly once");
    assert.match(notice()!, /已允许则退出并重新打开 KDJ/);
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.equal(loginPosts().length, before + 1, "ordinary focus never retries again");
    settingsUnavailable = true;
    await click("开启权限");
    assert.match(notice()!, /无法打开权限设置：系统设置不可用/);
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.equal(loginPosts().length, before + 1, "a settings page that did not open arms no retry");
    settingsUnavailable = false;
    answer = () => undefined;

    // SoundCloud's own window hands a Google sign-in over to the browser the user already has.
    dom.window.kdj.platform = "win32";
    await render("google-handoff", browserAccount("soundcloud"));
    await click("登录");
    webviewPending = true;
    await click("登录窗口");
    assert.equal(document.querySelector(".kd-account-login-panel"), null);
    await act(async () => windowEvent?.({ payload: { status: "browser_required", message: "Google 登录需使用浏览器" } }));
    assert.equal(panel().getAttribute("aria-label"), "SoundCloud · 复用浏览器");
    assert.equal(notice(), "Google 登录需使用浏览器");
    webviewPending = false;

    // A code to scan comes up in the row, and the same browsers can be reused beside it.
    for (const platform of ["wyy", "qqm", "bilibili"] as const) {
      await render(`qr-${platform}`, qrAccount(platform));
      assert.deepEqual(buttons().map(node => node.textContent), ["开", "登录"]);
      const beforeQr = calls.length;
      await click("登录");
      assert.deepEqual(methods(), ["扫码", "复用浏览器"]);
      assert.equal(calls.length, beforeQr, "no code is asked for before 扫码 is chosen");
      assert.equal(document.querySelector(".kd-account-login-qr, .kd-account-login-panel"), null);
      await click("扫码");
      assert.ok(calls.includes(`POST:/api/accounts/${platform}/login/qr`));
      const codes = document.querySelectorAll(".kd-account-login-qr img");
      assert.equal(codes.length, platform === "qqm" ? 2 : 1);
      assert.ok(panel().contains(codes[0]), "the code stands in the account's own row");
      assert.equal(document.querySelector(".kd-login-qr-backdrop, dialog, [role=dialog]"), null, "no mask over the page");
      assert.equal(document.querySelector(".kd-account-login-qr")?.getAttribute("data-kd-motion"), "pop");
      await click("复用浏览器");
      assert.equal(document.querySelector(".kd-account-login-qr"), null);
      assert.ok(calls.includes(`GET:/api/accounts/${platform}/login/browsers`));
      before = loginPosts().length;
      await click("登录", panel());
      assert.deepEqual(loginPosts().slice(before).map(post => [post.path, post.body.browser, post.body.window]),
        [[`/api/accounts/${platform}/login/browser`, "edge", undefined]], "a platform with a code to scan opens no login window");
      assert.equal(notice(), `登录失败：无法连接本地服务：${detail}`);
    }

    emptyCatalog = true;
    await render("empty", browserAccount("soundcloud"));
    await click("登录");
    await click("复用浏览器");
    assert.equal(buttons(panel()).find(button => button.textContent === "登录")?.disabled, true);
    assert.equal(panel().querySelector("select"), null, "no browsers is an empty choice, not a message");
  } finally {
    await act(async () => root.unmount());
    await (await import("../src/lib/diagnostics")).flushDiagnostics();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
