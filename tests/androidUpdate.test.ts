import assert from "node:assert/strict";
import test from "node:test";

/** The app's modules want a page around them: one JSDOM for the file, as the WebView would be. */
async function page() {
  if ((globalThis as { document?: unknown }).document) return (globalThis as unknown as { window: Window & { kdj: unknown } }).window;
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html>", { url: "http://localhost/", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage });
  return dom.window as unknown as Window & { kdj: unknown };
}

/** A phone on `network` whose installer records what it was asked and answers `result`. */
async function phone(network: string, result: "installing" | "permission" = "installing") {
  const window = await page();
  window.localStorage.clear();
  const asked: { url: string; version: string; askPermission: boolean }[] = [];
  // Node has a navigator of its own, with a getter only.
  Object.defineProperty(globalThis, "navigator", { value: { connection: { type: network } }, configurable: true });
  window.kdj = {
    platform: "android",
    installAndroidUpdate: async (options: { url: string; version: string; askPermission: boolean; onProgress?: (p: unknown) => void }) => {
      asked.push({ url: options.url, version: options.version, askPermission: options.askPermission });
      options.onProgress?.({ stage: "downloading", downloaded: 1, total: 2, message: "" });
      return result;
    },
  };
  return { asked, stored: (key: string) => window.localStorage.getItem(key) };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const INFO = { current: "1.0.0", latest: "1.0.1", newer: true, name: "", published_at: "",
  url: "https://github.com/kumoSleeping/KDJ/releases/download/v1.0.1/app-arm64-release.apk" };

/** What a background check that found INFO does next (updateStore's check, silent). */
async function backgroundCheckFound() {
  const { offerAndroidUpdate, useUpdateStore } = await import("../src/stores/updateStore");
  useUpdateStore.setState({ info: INFO });
  offerAndroidUpdate(INFO);
  await settle();
  return useUpdateStore;
}

test("on Wi-Fi a background check downloads the new version and opens the installer, once per version", async () => {
  const { asked, stored } = await phone("wifi");
  const useUpdateStore = await backgroundCheckFound();
  assert.deepEqual(asked, [{ url: "https://github.com/kumoSleeping/KDJ/releases/download/v1.0.1/app-arm64-release.apk", version: "1.0.1", askPermission: false }]);
  assert.equal(stored("kd-android-update-offered"), "1.0.1");
  assert.equal(useUpdateStore.getState().applying, false);

  await backgroundCheckFound();
  assert.equal(asked.length, 1, "the installer is not opened again for the same version");

  // The key in the settings always downloads, and may open the permission page.
  await useUpdateStore.getState().apply();
  assert.equal(asked.length, 2);
  assert.equal(asked[1].askPermission, true);
  assert.equal(useUpdateStore.getState().manualError, "");
});

test("on a metered network nothing is downloaded until the key is pressed; a missing permission is said", async () => {
  const { asked } = await phone("cellular", "permission");
  const useUpdateStore = await backgroundCheckFound();
  assert.equal(asked.length, 0);
  await useUpdateStore.getState().apply();
  assert.equal(asked.length, 1);
  assert.match(useUpdateStore.getState().manualError, /允许 KDJ 安装应用/);
});
