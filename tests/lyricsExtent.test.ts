import assert from "node:assert/strict";
import test from "node:test";

const values = new Map<string, string>();
Object.assign(globalThis, { localStorage: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, String(value)); },
  removeItem: (key: string) => { values.delete(key); },
} });

import {
  lyricsExtentChoices,
  normalizeLyricsExtent,
  shownLyricsExtent,
  useLyricsExtent,
} from "../src/lib/lyricsExtent";

const wide = { tall: false };
const tall = { tall: true };

test("full screen is offered by a tall desktop window only", () => {
  assert.deepEqual(lyricsExtentChoices(tall), ["standard", "longer", "full"]);
  assert.deepEqual(lyricsExtentChoices(wide), ["standard", "longer"]);
});

test("a stored full screen is shown as the longer drawer where there is none", () => {
  assert.equal(shownLyricsExtent("full", tall), "full");
  assert.equal(shownLyricsExtent("full", wide), "longer");
  for (const shape of [wide, tall]) {
    assert.equal(shownLyricsExtent("standard", shape), "standard");
    assert.equal(shownLyricsExtent("longer", shape), "longer");
  }
});

test("the choice is remembered, and the fallback does not rewrite it", () => {
  assert.equal(normalizeLyricsExtent(null), "standard");
  assert.equal(normalizeLyricsExtent("nonsense"), "standard");
  assert.equal(normalizeLyricsExtent("full"), "full");
  assert.equal(useLyricsExtent.getState().extent, "standard");
  useLyricsExtent.getState().setExtent("full");
  assert.equal(values.get("kd-lyrics-extent"), "full");
  // The window turns wide: what is shown changes, what is stored does not.
  assert.equal(shownLyricsExtent(useLyricsExtent.getState().extent, wide), "longer");
  assert.equal(values.get("kd-lyrics-extent"), "full");
  assert.equal(shownLyricsExtent(useLyricsExtent.getState().extent, tall), "full");
  useLyricsExtent.getState().setExtent("longer");
  assert.equal(values.get("kd-lyrics-extent"), "longer");
});
