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

// A check logs to the activity log, which flushes on a page timer: close the page so Node can exit.
test.after(() => (globalThis as { window?: { close(): void } }).window?.close());

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const INFO = { current: "1.0.0", latest: "1.0.1", newer: true, name: "", published_at: "",
  url: "https://github.com/kumoSleeping/KDJ/releases/latest" };

/** A desktop whose updater finds INFO and stages whatever it is asked to download. */
async function desktop() {
  const window = await page();
  window.localStorage.clear();
  let downloads = 0;
  window.kdj = {
    platform: "macos",
    checkUpdate: async () => INFO,
    applyUpdate: async () => {},
    downloadUpdate: async () => { downloads += 1; return INFO.latest; },
  };
  const { useUpdateStore } = await import("../src/stores/updateStore");
  useUpdateStore.setState({ info: null, staged: "", downloading: false, applying: false });
  return { useUpdateStore, downloads: () => downloads };
}

test("a check that finds a new version downloads it in the background, once", async () => {
  const { useUpdateStore, downloads } = await desktop();
  assert.equal(useUpdateStore.getState().autoDownload, true, "on by default");
  await useUpdateStore.getState().check({ silent: true });
  await settle();
  assert.equal(downloads(), 1);
  assert.equal(useUpdateStore.getState().staged, "1.0.1");
  assert.equal(useUpdateStore.getState().downloading, false);

  await useUpdateStore.getState().check({ silent: true });
  await settle();
  assert.equal(downloads(), 1, "a staged version is not downloaded again");
});

test("with the switch off nothing is downloaded until it is turned back on", async () => {
  const { useUpdateStore, downloads } = await desktop();
  useUpdateStore.getState().setAutoDownload(false);
  assert.equal(window.localStorage.getItem("kd-auto-update-download"), "0");
  await useUpdateStore.getState().check({ silent: true });
  await settle();
  assert.equal(downloads(), 0);
  assert.equal(useUpdateStore.getState().staged, "");

  useUpdateStore.getState().setAutoDownload(true);
  await settle();
  assert.equal(downloads(), 1, "turning it on downloads what was already found");
  assert.equal(useUpdateStore.getState().staged, "1.0.1");
});
