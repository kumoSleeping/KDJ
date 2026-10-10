import assert from "node:assert/strict";
import test from "node:test";

/** A storage the modules read at import, as the WebView's would be at launch. */
function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
  };
  Object.assign(globalThis, { localStorage: store });
  return store;
}

import {
  nextPlayerBarPhase,
  playerBarMoving,
  playerBarStandsDown,
  readPlayerBarCollapsed,
  usePlayerBarAway,
} from "../src/lib/playerBarAway";
import {
  nowPlayingHeld,
  nowPlayingInfoVisible,
  nowPlayingKeptAway,
  readNowPlayingHold,
  useNowPlayingInfo,
} from "../src/lib/nowPlayingInfo";

const info = () => useNowPlayingInfo.getState();
const visible = () => nowPlayingInfoVisible(info());
/** The bubble's store as a launch would find it in what is stored now. */
const relaunch = () => useNowPlayingInfo.setState(readNowPlayingHold());

test("the bar's phases: a whole slide each way, nothing to do when it is already there", () => {
  assert.equal(nextPlayerBarPhase("up", true), "leaving");
  assert.equal(nextPlayerBarPhase("leaving", true), null);
  assert.equal(nextPlayerBarPhase("away", true), null);
  assert.equal(nextPlayerBarPhase("returning", true), "leaving");
  assert.equal(nextPlayerBarPhase("away", false), "returning");
  assert.equal(nextPlayerBarPhase("leaving", false), "returning");
  assert.equal(nextPlayerBarPhase("returning", false), null);
  assert.equal(nextPlayerBarPhase("up", false), null);
  // What stands on the bar stands on the window's edge from the start of the slide down and
  // until the slide back up starts; the bar lies over the page for both slides.
  assert.deepEqual((["up", "leaving", "away", "returning"] as const).map(playerBarStandsDown), [false, true, true, false]);
  assert.deepEqual((["up", "leaving", "away", "returning"] as const).map(playerBarMoving), [false, true, false, true]);
});

test("the collapse is a stored preference", () => {
  const stored = storage();
  assert.equal(readPlayerBarCollapsed(), false);
  usePlayerBarAway.getState().setCollapsed(true);
  assert.equal(stored.getItem("kd-player-bar-collapsed"), "true");
  assert.equal(readPlayerBarCollapsed(), true);
  assert.equal(readNowPlayingHold().barAway, true, "the bubble starts kept for a bar that starts away");
  usePlayerBarAway.getState().setCollapsed(false);
  assert.equal(stored.getItem("kd-player-bar-collapsed"), "false");
  assert.equal(readNowPlayingHold().barAway, false);
});

test("kept because the bar is away: up by default, never written into the pin", () => {
  const stored = storage();
  relaunch();
  assert.equal(visible(), false);
  // The bar goes away: the bubble is held without being pinned or opened.
  info().setBarAway(true);
  assert.equal(nowPlayingKeptAway(info()), true);
  assert.equal(nowPlayingHeld(info()), true);
  assert.deepEqual([info().pinned, info().open, info().peek], [false, false, 0]);
  assert.equal(stored.getItem("kd-now-playing-pinned"), null, "the preference is untouched");
  // A new song does not turn a kept bubble into a timed one.
  info().startPeek();
  assert.equal(info().peek, 0);
  // The bar returns: an unpinned bubble leaves.
  info().setBarAway(false);
  assert.equal(visible(), false);

  // A song that was peeking when the bar went away is kept, not counted down, and does not
  // come back as a countdown when the bar returns.
  info().startPeek();
  assert.ok(info().peek > 0);
  info().setBarAway(true);
  assert.equal(info().peek, 0);
  info().setBarAway(false);
  assert.equal(visible(), false);

  // Pinned before: it stays through the bar going and coming, and is still pinned.
  info().setPinned(true);
  info().setBarAway(true);
  assert.equal(visible(), true);
  info().setBarAway(false);
  assert.equal(info().pinned, true);
  assert.equal(stored.getItem("kd-now-playing-pinned"), "true");
  assert.equal(visible(), true);
  info().setPinned(false);
  info().endPeek();
  assert.equal(visible(), false);
});

test("sent away while the bar is away, the bubble stays away until the bar is put away again", () => {
  const stored = storage();
  relaunch();

  // Dismissed by hand.
  info().setBarAway(true);
  info().close();
  assert.equal(nowPlayingKeptAway(info()), false);
  assert.equal(visible(), false);
  assert.equal(stored.getItem("kd-now-playing-away-dismissed"), "true");
  // New songs still peek for their stay, and leave.
  info().startPeek();
  assert.ok(info().peek > 0);
  assert.equal(visible(), true);
  info().endPeek();
  assert.equal(visible(), false);
  // The listener's own open or pin brings it back, as with the bar up.
  info().toggle();
  assert.equal(info().open, true);
  info().toggle();
  assert.equal(visible(), false);
  info().setPinned(true);
  assert.equal(visible(), true);
  // Unpinning with the bar away lets it go: a last countdown, then nothing holds it.
  info().setPinned(false);
  assert.ok(info().peek > 0, "it leaves by itself");
  info().endPeek();
  assert.equal(visible(), false);

  // The bar comes back and is put away again: kept again.
  info().setBarAway(false);
  assert.equal(visible(), false);
  info().setBarAway(true);
  assert.equal(nowPlayingKeptAway(info()), true);
  assert.equal(stored.getItem("kd-now-playing-away-dismissed"), "false");

  // Unpinning a bubble that is only kept for the bar is the same as letting it go.
  info().setPinned(false);
  assert.equal(nowPlayingKeptAway(info()), false);
  assert.ok(info().peek > 0);
  assert.equal(stored.getItem("kd-now-playing-pinned"), "false");

  // Telling the store again what it knows changes nothing (the bar reports on every launch).
  info().endPeek();
  info().setBarAway(true);
  assert.equal(nowPlayingKeptAway(info()), false);
  assert.equal(visible(), false);
});

test("the next launch starts with what was decided while the bar was away", () => {
  storage({ "kd-player-bar-collapsed": "true", "kd-now-playing-away-dismissed": "true" });
  relaunch();
  assert.equal(info().barAway, true);
  assert.equal(visible(), false);
  // The bar reporting that it is still away does not bring the bubble back.
  info().setBarAway(true);
  assert.equal(visible(), false);

  storage({ "kd-player-bar-collapsed": "true" });
  relaunch();
  assert.equal(visible(), true);

  // A stale flag from an earlier collapse means nothing while the bar is up.
  storage({ "kd-now-playing-away-dismissed": "true" });
  relaunch();
  assert.equal(visible(), false);
  info().setBarAway(true);
  assert.equal(nowPlayingKeptAway(info()), true);
});
