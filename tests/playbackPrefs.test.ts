import assert from "node:assert/strict";
import test from "node:test";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, String(value)); },
    removeItem(key: string) { values.delete(key); },
  },
});

test("global beat quantize preference defaults on and persists independently", async () => {
  values.set("kd-playback-prefs", JSON.stringify({ transportFade: false }));
  const { usePlaybackPrefs } = await import("../src/lib/playbackPrefs");

  assert.equal(usePlaybackPrefs.getState().transportFade, false);
  assert.equal(usePlaybackPrefs.getState().quantize, true);

  usePlaybackPrefs.getState().setQuantize(false);
  assert.equal(usePlaybackPrefs.getState().quantize, false);
  assert.deepEqual(JSON.parse(values.get("kd-playback-prefs") ?? "{}"), {
    transportFade: false,
    quantize: false,
  });
});
