import assert from "node:assert/strict";
import test from "node:test";
import type { Waveform } from "../src/types";

function installBrowserStubs(): void {
  const events = new EventTarget();
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    window: Object.assign(events, {
      kdj: { baseUrl: "http://127.0.0.1:43123", platform: "darwin" },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    }),
    document: {
      baseURI: "http://127.0.0.1/",
      createElement: () => ({
        preload: "",
        crossOrigin: "",
        preservesPitch: true,
        webkitPreservesPitch: true,
      }),
      documentElement: { dataset: {} },
      querySelectorAll: () => [],
    },
  });
}

function prefix(trackId: number, duration: number, value: number): Waveform {
  const count = 32;
  return {
    track_id: trackId,
    duration,
    amp: Array(count).fill(value),
    minimum: Array(count).fill(-value),
    maximum: Array(count).fill(value),
    r: Array(count).fill(Math.round(value * 100)),
    g: Array(count).fill(Math.round(value * 120)),
    b: Array(count).fill(Math.round(value * 140)),
    transient: Array(count).fill(Math.round(value * 200)),
  };
}

test("a longer online prefix only fills new pixels and does not recolour old time", async () => {
  installBrowserStubs();
  const {
    clearStreamWaveform,
    mergeCachedStreamWaveform,
  } = await import("../src/lib/waveformCache");
  const trackId = -900_001;
  try {
    const first = mergeCachedStreamWaveform(
      trackId,
      10,
      5,
      prefix(trackId, 5, 0.25),
      1,
    );
    const oldIndex = 1_000;
    const newIndex = 2_800;
    assert.equal(first.known[oldIndex], true);
    assert.equal(first.known[newIndex], false);
    const oldPixel = {
      amp: first.waveform.amp[oldIndex],
      r: first.waveform.r[oldIndex],
      g: first.waveform.g[oldIndex],
      b: first.waveform.b[oldIndex],
      transient: first.waveform.transient?.[oldIndex],
    };

    const second = mergeCachedStreamWaveform(
      trackId,
      10,
      8,
      prefix(trackId, 8, 0.9),
      2,
    );
    assert.equal(second.known[newIndex], true);
    assert.deepEqual({
      amp: second.waveform.amp[oldIndex],
      r: second.waveform.r[oldIndex],
      g: second.waveform.g[oldIndex],
      b: second.waveform.b[oldIndex],
      transient: second.waveform.transient?.[oldIndex],
    }, oldPixel);
    assert.ok((second.waveform.amp[newIndex] ?? 0) > 0.8);
  } finally {
    clearStreamWaveform(trackId);
  }
});
