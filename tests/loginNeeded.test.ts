import assert from "node:assert/strict";
import test from "node:test";

test("a playback stopped for a login says so once, and its key opens that source's login", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  });
  const { ApiError } = await import("../src/lib/api");
  const { loginNeededCode, reportLoginNeeded } = await import("../src/lib/loginNeeded");
  const { useTaskBubbles } = await import("../src/components/tasks/taskBubbleStore");
  const { useLoginRequest, useSettingsPage } = await import("../src/lib/settingsPages");
  const { useAppStore } = await import("../src/stores/appStore");
  const up = () => useTaskBubbles.getState().entries.filter((entry) => !entry.leaving);

  const expired = new ApiError("YouTube 登录已失效", 401, { detail: "YouTube 登录已失效", code: "AUTH_EXPIRED" });
  const unplayable = new ApiError("YouTube 视频不可播放：Video unavailable", 400, { detail: "x", code: null });
  assert.equal(loginNeededCode(expired), "AUTH_EXPIRED");
  assert.equal(loginNeededCode(unplayable), null);
  assert.equal(reportLoginNeeded("youtube", unplayable), false);
  assert.equal(reportLoginNeeded("youtube", new Error("网络中断")), false);
  assert.equal(up().length, 0);

  assert.equal(reportLoginNeeded("youtube", expired), true);
  reportLoginNeeded("youtube", expired);
  assert.equal(up().length, 1);
  const [bubble] = up();
  assert.equal(bubble.spec.title, "YouTube 登录已失效");
  assert.equal(bubble.spec.tone, "error");
  const login = bubble.spec.actions?.find((action) => action.id === "login");
  assert.ok(login);

  login.onSelect(dom.window.document.body);
  assert.equal(useLoginRequest.getState().platform, "youtube");
  assert.equal(useSettingsPage.getState().page, "sources");
  assert.equal(useAppStore.getState().showSettings, true);
  assert.equal(up().length, 0);
});
