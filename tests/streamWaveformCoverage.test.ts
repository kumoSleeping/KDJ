import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("unfinished PCM stays a prefix; completion fills the playable timeline even at the same revision", async () => {
  const dom = new JSDOM("<body/>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage });
  const { mergeCachedStreamWaveform, updateStreamWaveform, clearAllWaveformCaches } = await import("../src/lib/waveformCache");
  const wave = { track_id: -51, duration: 30, amp: [.2, .4, .6, .8], r: [240, 200, 100, 50], g: [40, 80, 120, 160], b: [50, 100, 200, 240] };
  try {
    const prefix = mergeCachedStreamWaveform(-51, 120, 30, wave, 7);
    assert.equal(prefix.known.filter(Boolean).length, 1024);
    assert.equal(prefix.known.at(-1), false);
    const full = mergeCachedStreamWaveform(-51, 120, 30, wave, 7, undefined, true);
    assert.equal(full.known.every(Boolean), true);
    assert.equal(full.waveform.amp.at(-1), .8);
    const corrected = updateStreamWaveform(-51, 0, 118, null);
    assert.equal(corrected.known.every(Boolean), true, "later transport duration updates keep the completed shape full width");
    const stale = mergeCachedStreamWaveform(-51, 118, 15, wave, 6);
    assert.equal(stale.waveform.amp.at(-1), .8, "late prefix replies cannot replace the final shape");
  } finally { clearAllWaveformCaches(); dom.window.close(); }
});
