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

const wide = { tall: false, mobile: false };
const tall = { tall: true, mobile: false };
const phoneUpright = { tall: true, mobile: true };
const phoneOnItsSide = { tall: false, mobile: true };

test("full screen is offered by a tall desktop window only", () => {
  assert.deepEqual(lyricsExtentChoices(tall), ["standard", "longer", "full"]);
  assert.deepEqual(lyricsExtentChoices(wide), ["standard", "longer"]);
  assert.deepEqual(lyricsExtentChoices(phoneOnItsSide), ["standard", "longer"], "a drawer, but no spanning bubble");
  assert.deepEqual(lyricsExtentChoices(phoneUpright), [], "the sheet is as long as it can be");
});

test("a stored full screen is shown as the longer drawer where there is none", () => {
  assert.equal(shownLyricsExtent("full", tall), "full");
  assert.equal(shownLyricsExtent("full", wide), "longer");
  assert.equal(shownLyricsExtent("full", phoneOnItsSide), "longer");
  assert.equal(shownLyricsExtent("full", phoneUpright), "longer");
  for (const shape of [wide, tall, phoneOnItsSide, phoneUpright]) {
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
