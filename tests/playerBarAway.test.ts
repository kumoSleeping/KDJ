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
  playerBarAwayWanted,
  playerBarMoving,
  playerBarRest,
  playerBarStandsDown,
  readPlayerBarAway,
  readPlayerBarCollapsed,
  usePlayerBarAway,
} from "../src/lib/playerBarAway";
import {
  advancePlayerBar,
  endPlayerBarSlide,
  nowPlayingHeld,
  nowPlayingInfoVisible,
  readNowPlayingHold,
  settlePlayerBar,
  useNowPlayingInfo,
} from "../src/lib/nowPlayingInfo";

const bar = () => usePlayerBarAway.getState();
const info = () => useNowPlayingInfo.getState();
const visible = () => nowPlayingInfoVisible(info());

/** Whether there is a song for the bubble to show. */
let song = true;
const wanted = () => playerBarAwayWanted(bar().collapsed, song);
/** The listener has a transport: the bar is on screen, or the bubble has something to show. */
const transport = () => bar().phase !== "away" || (song && visible());
/** One pass of the bar's driver (PlayerBarAway.tsx), which runs whenever anything changed. */
function pass(note = "") {
  advancePlayerBar(wanted());
  assert.ok(transport(), `neither the bar nor the bubble is on screen ${note}`);
  // At rest the bubble is held for the bar exactly while the bar is away.
  if (!playerBarMoving(bar().phase)) assert.equal(info().barAway, bar().phase === "away", note);
}
/** The slide's time runs out. */
function arrive(note = "") {
  if (!playerBarMoving(bar().phase)) return;
  endPlayerBarSlide();
  pass(note);
}
/** Both stores as a launch would find them in what is stored now, in a window of that shape. */
function relaunch({ tall = false, withSong = true } = {}) {
  song = withSong;
  usePlayerBarAway.setState({ tall, collapsed: readPlayerBarCollapsed(tall ? "tall" : "wide") });
  useNowPlayingInfo.setState(readNowPlayingHold());
  // The driver's first pass: the bar takes its place, and the bubble's hold agrees with it.
  settlePlayerBar(wanted());
  pass("at launch");
}

test("the bar's phases: a whole slide each way, never turned around halfway", () => {
  assert.equal(nextPlayerBarPhase("up", true), "leaving");
  assert.equal(nextPlayerBarPhase("up", false), null);
  assert.equal(nextPlayerBarPhase("away", false), "returning");
  assert.equal(nextPlayerBarPhase("away", true), null);
  // On its way the bar goes on, whatever is wanted; the question is asked again where it arrives.
  for (const away of [true, false]) {
    assert.equal(nextPlayerBarPhase("leaving", away), null);
    assert.equal(nextPlayerBarPhase("returning", away), null);
  }
  assert.deepEqual((["up", "leaving", "away", "returning"] as const).map(playerBarRest), ["up", "away", "away", "up"]);
  // What stands on the bar stands on the window's edge from the start of the slide down and
  // until the slide back up starts; the bar lies over the page for both slides.
  assert.deepEqual((["up", "leaving", "away", "returning"] as const).map(playerBarStandsDown), [false, true, true, false]);
  assert.deepEqual((["up", "leaving", "away", "returning"] as const).map(playerBarMoving), [false, true, false, true]);
});

test("each shape of the window keeps its own choice: a wide one the bar, a tall one the bubble", () => {
  const stored = storage();
  assert.equal(readPlayerBarCollapsed("wide"), false);
  assert.equal(readPlayerBarCollapsed("tall"), true);
  usePlayerBarAway.setState({ tall: false, collapsed: false });

  bar().setCollapsed(true);
  assert.equal(stored.getItem("kd-player-bar-collapsed"), "true");
  assert.equal(stored.getItem("kd-player-bar-collapsed-tall"), null, "the other shape's choice is untouched");
  assert.equal(readPlayerBarAway(), true);
  assert.equal(readNowPlayingHold().barAway, true, "the bubble starts kept for a bar that starts away");

  // Crossing into the tall shape applies its choice; changing it there writes its own key.
  bar().setTall(true);
  assert.equal(bar().collapsed, true);
  bar().setCollapsed(false);
  assert.equal(stored.getItem("kd-player-bar-collapsed-tall"), "false");
  assert.equal(stored.getItem("kd-player-bar-collapsed"), "true");
  assert.equal(readPlayerBarCollapsed("tall"), false);
  // And back: the wide window is as it was left.
  bar().setTall(false);
  assert.equal(bar().collapsed, true);
  bar().setCollapsed(false);
  assert.equal(stored.getItem("kd-player-bar-collapsed"), "false");
  assert.equal(readNowPlayingHold().barAway, false);
});

test("the bar is only away where the bubble can stand in for it", () => {
  assert.equal(playerBarAwayWanted(true, true, true), true);
  assert.equal(playerBarAwayWanted(false, true, true), false);
  assert.equal(playerBarAwayWanted(true, false, true), false, "no song: nothing for the bubble to show");
  assert.equal(playerBarAwayWanted(true, true, false), false, "a phone keeps its bar");
});

test("putting the bar away hands the transport to the bubble; sending the bubble away brings the bar back", () => {
  const stored = storage();
  relaunch();
  assert.equal(bar().phase, "up");
  assert.equal(visible(), false);

  // The collapse key: the bubble is kept from the moment the bar starts down, without a pin.
  bar().setCollapsed(true);
  pass();
  assert.equal(bar().phase, "leaving");
  assert.equal(nowPlayingHeld(info()), true);
  assert.deepEqual([info().pinned, info().open, info().peek], [false, false, 0]);
  assert.equal(stored.getItem("kd-now-playing-pinned"), null, "the pin is untouched");
  arrive();
  assert.equal(bar().phase, "away");
  // A new song does not turn the transport into a timed bubble.
  info().startPeek();
  assert.equal(info().peek, 0);

  // Dismissed by hand: the bubble lets go at once and the bar is asked back.
  info().close();
  assert.equal(visible(), false);
  assert.equal(bar().collapsed, false);
  assert.equal(stored.getItem("kd-player-bar-collapsed"), "false");
  pass();
  assert.equal(bar().phase, "returning");
  arrive();
  assert.equal(bar().phase, "up");
  assert.equal(visible(), false);

  // A song that was peeking when the bar went is kept, not counted down, and does not come back
  // as a countdown when the bar returns.
  info().startPeek();
  assert.ok(info().peek > 0);
  bar().setCollapsed(true);
  pass();
  assert.equal(info().peek, 0);
  arrive();
  info().close();
  pass();
  arrive();
  assert.equal(visible(), false);
});

test("the pin is both at once: it decides whether the bubble stays beside the bar", () => {
  const stored = storage();
  relaunch();

  // Pinned beside the bar, then the bar is put away: the bubble stays, still pinned.
  info().setPinned(true);
  bar().setCollapsed(true);
  pass();
  arrive();
  assert.deepEqual([bar().phase, info().pinned, visible()], ["away", true, true]);
  // Dismissing it brings the bar back and clears the pin, as dismissing does everywhere.
  info().close();
  pass();
  arrive();
  assert.deepEqual([bar().phase, info().pinned, visible()], ["up", false, false]);
  assert.equal(stored.getItem("kd-now-playing-pinned"), "false");

  // With the bar away the pin key changes the real preference, and the bubble stays either way.
  bar().setCollapsed(true);
  pass();
  arrive();
  info().setPinned(true);
  assert.equal(stored.getItem("kd-now-playing-pinned"), "true");
  info().setPinned(false);
  assert.equal(stored.getItem("kd-now-playing-pinned"), "false");
  assert.equal(info().peek, 0, "unpinned as the transport, it does not start counting down");
  assert.equal(visible(), true);
  pass();
  assert.equal(bar().phase, "away");

  // Unpinned beside the bar it goes back to leaving by itself.
  info().close();
  pass();
  arrive();
  info().setPinned(true);
  info().setPinned(false);
  assert.ok(info().peek > 0);
  info().endPeek();
  assert.equal(visible(), false);

  // The card: opens and keeps it, and sends it away again.
  info().toggle();
  assert.equal(info().open, true);
  info().toggle();
  assert.equal(visible(), false);
  pass();
  assert.equal(bar().phase, "up", "sending it away beside the bar leaves the bar alone");
});

test("crossing between the shapes is the same handover, and a slide is finished before the next", () => {
  storage();
  relaunch();

  // Into the tall shape with the bar up: the bar goes, the bubble takes over.
  bar().setTall(true);
  pass();
  assert.equal(bar().phase, "leaving");
  assert.equal(visible(), true);
  arrive();
  assert.equal(bar().phase, "away");
  // Back to the wide shape, which says up: the bar returns and an unpinned bubble leaves.
  bar().setTall(false);
  pass();
  assert.equal(bar().phase, "returning");
  assert.equal(visible(), false);
  arrive();
  assert.equal(bar().phase, "up");

  // The edge dragged across and back while the bar is still going down: the slide is not
  // turned around, the bubble stays for as long as the bar is down, and the bar comes back.
  bar().setTall(true);
  pass();
  bar().setTall(false);
  pass("the shape changed back during the slide down");
  assert.equal(bar().phase, "leaving");
  assert.equal(visible(), true);
  arrive();
  assert.equal(bar().phase, "returning");
  assert.equal(visible(), false);
  // And across again while it is coming up: it arrives, then goes.
  bar().setTall(true);
  pass("the shape changed during the slide up");
  assert.equal(bar().phase, "returning");
  arrive();
  assert.equal(bar().phase, "leaving");
  assert.equal(visible(), true);
  arrive();
  assert.equal(bar().phase, "away");

  // A pinned bubble stays through the bar coming back.
  info().setPinned(true);
  bar().setTall(false);
  pass();
  arrive();
  assert.deepEqual([bar().phase, visible()], ["up", true]);
  info().close();

  // The bubble sent away while the bar is still going down: the bar finishes, then returns.
  bar().setCollapsed(true);
  pass();
  info().close();
  pass("dismissed during the slide down");
  assert.equal(bar().phase, "leaving");
  arrive();
  assert.equal(bar().phase, "returning");
  arrive();
  // The same, but the window turns tall before the bar has arrived: the bar stays away after
  // all, so the bubble is back.
  bar().setCollapsed(true);
  pass();
  info().close();
  bar().setTall(true);
  pass();
  arrive();
  assert.deepEqual([bar().phase, visible()], ["away", true]);
});

test("without a song the bar is up whatever was chosen, and the choice is kept", () => {
  const stored = storage({ "kd-player-bar-collapsed": "true" });
  relaunch({ withSong: false });
  assert.equal(bar().phase, "up", "taken at launch without a slide");
  assert.equal(visible(), false);
  // A song arrives: the choice applies again.
  song = true;
  pass();
  assert.equal(bar().phase, "leaving");
  arrive();
  assert.equal(bar().phase, "away");
  // The deck is emptied: the bar comes back, and nothing was rewritten.
  song = false;
  pass();
  assert.equal(bar().phase, "returning");
  arrive();
  assert.equal(bar().phase, "up");
  assert.equal(stored.getItem("kd-player-bar-collapsed"), "true");
  assert.equal(bar().collapsed, true);
});

test("launch: the bar's place and the bubble are settled together, without a slide", () => {
  storage({ "kd-player-bar-collapsed": "true" });
  assert.equal(readNowPlayingHold().barAway, true, "the bubble is held from the first frame");
  relaunch();
  assert.deepEqual([bar().phase, visible()], ["away", true]);

  // A tall window that was never told otherwise starts with the bubble.
  storage();
  relaunch({ tall: true });
  assert.deepEqual([bar().phase, visible()], ["away", true]);
  // Brought back there, it starts with the bar; the wide window is a separate matter.
  info().close();
  pass();
  arrive();
  relaunch({ tall: true });
  assert.deepEqual([bar().phase, visible()], ["up", false]);
  relaunch({ tall: false });
  assert.deepEqual([bar().phase, visible()], ["up", false]);

  // A flag left by an earlier build ("dismissed while the bar was away") means nothing now.
  storage({ "kd-player-bar-collapsed": "true", "kd-now-playing-away-dismissed": "true" });
  relaunch();
  assert.deepEqual([bar().phase, visible()], ["away", true]);
});

test("whatever the listener does, in any order, the bar or the bubble is on screen", () => {
  storage();
  relaunch();
  // A fixed sequence of pseudo-random moves, so a failure names its step.
  let seed = 20261010;
  const random = (bound: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % bound;
  };
  const moves: Record<string, () => void> = {
    // The key on the bar acts only on a bar that has arrived, and is there only with a song.
    collapse: () => { if (bar().phase === "up" && song) bar().setCollapsed(true); },
    // The bubble's key and Esc, while the bubble is up.
    dismiss: () => { if (song && visible()) info().close(); },
    // The now-playing card is on the bar: out of reach while the bar is down.
    card: () => { if (!playerBarStandsDown(bar().phase) && song) info().toggle(); },
    pin: () => { if (song && visible()) info().setPinned(!info().pinned); },
    newSong: () => { if (song) info().startPeek(); },
    peekEnds: () => info().endPeek(),
    shape: () => bar().setTall(!bar().tall),
    deck: () => { song = !song; },
    arrive: () => { if (playerBarMoving(bar().phase)) endPlayerBarSlide(); },
  };
  const names = Object.keys(moves);
  for (let step = 0; step < 6000; step += 1) {
    const name = names[random(names.length)];
    moves[name]();
    pass(`after step ${step} (${name}), phase ${bar().phase}`);
  }
});
