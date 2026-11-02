import assert from "node:assert/strict";
import test from "node:test";
import { pinnedPopupTrack, type VisualizerPopupPin } from "../src/lib/visualizerPopup";

const song = (id: number) => ({ id, title: `song ${id}`, filename: `${id}.wav`, format: "wav" }) as VisualizerPopupPin["track"];

test("a song asked for by hand holds the window while the player stays where it was", () => {
  const pin: VisualizerPopupPin = { track: song(46), over: 42 };
  assert.equal(pinnedPopupTrack(pin, 42)?.id, 46);
  assert.equal(pinnedPopupTrack({ track: song(46), over: null }, null)?.id, 46, "asked for with nothing playing");
});

test("the window is the player's again once the player's song changes", () => {
  const pin: VisualizerPopupPin = { track: song(46), over: 42 };
  assert.equal(pinnedPopupTrack(pin, 46), null, "the asked-for song played from its window");
  assert.equal(pinnedPopupTrack(pin, 47), null, "the next song in the queue, or the bar's keys");
  assert.equal(pinnedPopupTrack(pin, null), null, "the player emptied");
  assert.equal(pinnedPopupTrack(null, 42), null);
});
