import assert from "node:assert/strict";
import test from "node:test";

function installBrowserStorage(): Storage {
  const values = new Map<string, string>();
  const localStorage: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  const events = new EventTarget();
  const window = Object.assign(events, {
    localStorage,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
  Object.assign(globalThis, { localStorage, window });
  return localStorage;
}

test("lyrics visibility, local-video mode, and local-video open state persist independently", async () => {
  const storage = installBrowserStorage();
  const { flushLocalStorageWrites } = await import("../src/lib/storageWrite");
  const { rememberedLocalVideoTrackId, useVideoPip } = await import("../src/lib/videoPip");
  const { useLyricsPrefs } = await import("../src/lib/lyricsPrefs");

  useVideoPip.getState().setMode("panel");
  useVideoPip.getState().setSession({
    source: "local",
    trackId: 42,
    title: "Video",
    author: "Artist",
    autoPlay: false,
  });
  useLyricsPrefs.getState().setDesktopEnabled(true);
  flushLocalStorageWrites();

  assert.equal(storage.getItem("kdj.videoPreviewMode"), "panel");
  assert.equal(rememberedLocalVideoTrackId(), 42);
  assert.equal(JSON.parse(storage.getItem("kd-lyrics-prefs") ?? "{}").desktopEnabled, true);

  useVideoPip.getState().cycleMode();
  assert.equal(storage.getItem("kdj.videoPreviewMode"), "float");
  assert.equal(rememberedLocalVideoTrackId(), 42);
  assert.equal(JSON.parse(storage.getItem("kd-lyrics-prefs") ?? "{}").desktopEnabled, true);

  useVideoPip.getState().clear();
  assert.equal(rememberedLocalVideoTrackId(), null);
  assert.equal(storage.getItem("kdj.videoPreviewMode"), "float");
  assert.equal(JSON.parse(storage.getItem("kd-lyrics-prefs") ?? "{}").desktopEnabled, true);
});

test("local detail mode suspends the exact floating source instead of destroying it", async () => {
  installBrowserStorage();
  const { videoPipHostLifecycle } = await import("../src/lib/videoPip");
  const local = {
    source: "local" as const,
    trackId: 42,
    title: "Video",
    author: "Artist",
    autoPlay: true,
  };
  const network = {
    source: "network" as const,
    platform: "bilibili" as const,
    bvid: "BV1test",
    page: 1,
    title: "Preview",
    author: "Uploader",
  };

  assert.equal(videoPipHostLifecycle(local, true, "float"), "present");
  assert.equal(videoPipHostLifecycle(local, true, "panel"), "suspend-local");
  assert.equal(videoPipHostLifecycle(network, true, "panel"), "present");
  assert.equal(videoPipHostLifecycle(local, false, "float"), "stop");
  assert.equal(videoPipHostLifecycle(null, true, "float"), "stop");
});
