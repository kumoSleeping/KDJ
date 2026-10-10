import assert from "node:assert/strict";
import test from "node:test";
import {
  LYRICS_READY_CAP_MS,
  advanceLyricsTurn,
  lyricsLeaving,
  lyricsTurnAt,
  lyricsTurnDeadline,
  turnLyricsTo,
} from "../src/lib/lyricsTurn";
import { lyricsSettled } from "../src/lib/lyricsVisibility";
import { SONG_SWAP_OUT_MS } from "../src/lib/songSwapMotion";

const OUT = SONG_SWAP_OUT_MS;

test("the old lyrics leave, then the next song's come out once they are ready", () => {
  let turn = lyricsTurnAt<number>(1);
  assert.deepEqual([turn.shown, turn.phase, turn.turns], [1, "rest", 0]);
  assert.equal(lyricsTurnDeadline(turn), null);
  // The first lyrics come into view: the panel's own, not a turn.
  turn = advanceLyricsTurn(turn, 50, true, true);
  assert.equal(turn.revealedAt, 50);

  turn = turnLyricsTo(turn, 2, 10_000, true);
  assert.deepEqual([turn.shown, turn.wanted, turn.phase], [1, 2, "out"]);
  assert.ok(lyricsLeaving(turn.phase));
  assert.equal(lyricsTurnDeadline(turn), 10_000 + OUT);
  // Ready or not, nothing arrives before the exit is over: the surfaces move together.
  assert.equal(advanceLyricsTurn(turn, 10_000 + OUT - 1, true, true), turn);
  turn = advanceLyricsTurn(turn, 10_000 + OUT, true, true);
  assert.deepEqual([turn.shown, turn.phase, turn.turns], [2, "rest", 1]);
  assert.equal(turn.since, 10_000, "when the song changed, for the view that comes out");
  assert.equal(turn.revealedAt, null);
  turn = advanceLyricsTurn(turn, 10_000 + OUT + 16, true, true);
  assert.equal(turn.revealedAt, 10_000 + OUT + 16);
});

test("lyrics that are not ready are waited for, up to a cap", () => {
  let turn = turnLyricsTo(advanceLyricsTurn(lyricsTurnAt<number>(1), 0, true, true), 2, 1_000, true);
  turn = advanceLyricsTurn(turn, 1_000 + OUT, false, true);
  assert.deepEqual([turn.shown, turn.wanted, turn.phase], [null, 2, "wait"], "the panel holds nothing meanwhile");
  assert.equal(lyricsTurnDeadline(turn), 1_000 + OUT + LYRICS_READY_CAP_MS);
  assert.equal(advanceLyricsTurn(turn, 1_000 + OUT + 300, false, false), turn);
  // They arrive within the cap: out they come.
  const arrived = advanceLyricsTurn(turn, 1_000 + OUT + 300, true, false);
  assert.deepEqual([arrived.shown, arrived.phase, arrived.turns], [2, "rest", 1]);
  // A slow provider: at the cap the panel goes on with whatever state the view has.
  const capped = advanceLyricsTurn(turn, 1_000 + OUT + LYRICS_READY_CAP_MS, false, false);
  assert.deepEqual([capped.shown, capped.phase, capped.turns], [2, "rest", 1]);
  assert.equal(capped.revealedAt, null);
  // When they do arrive, that is when they came into view.
  assert.equal(advanceLyricsTurn(capped, 9_000, true, true).revealedAt, 9_000);
});

test("quick skips do not queue: the newest song is the one that arrives", () => {
  let turn = turnLyricsTo(advanceLyricsTurn(lyricsTurnAt<number>(1), 0, true, true), 2, 1_000, true);
  turn = turnLyricsTo(turn, 3, 1_150, true);
  assert.deepEqual([turn.shown, turn.wanted, turn.phase], [1, 3, "out"], "the same exit goes on");
  turn = turnLyricsTo(turn, 4, 1_300, true);
  assert.equal(advanceLyricsTurn(turn, 1_000 + OUT, true, true), turn, "the wait starts over with each skip");
  turn = advanceLyricsTurn(turn, 1_300 + OUT, false, true);
  assert.deepEqual([turn.shown, turn.wanted, turn.phase], [null, 4, "wait"]);
  // Another skip while waiting: the cap counts from it.
  turn = turnLyricsTo(turn, 5, 1_900, true);
  assert.equal(turn.phase, "wait");
  assert.equal(advanceLyricsTurn(turn, 1_300 + OUT + LYRICS_READY_CAP_MS, false, false), turn);
  turn = advanceLyricsTurn(turn, 1_900 + OUT, true, false);
  assert.deepEqual([turn.shown, turn.phase, turn.turns], [5, "rest", 1], "one turn, whatever was skipped");

  // Back to the song that is leaving: it arrives again instead of popping back.
  turn = advanceLyricsTurn(turn, 3_000, true, true);
  turn = turnLyricsTo(turn, 6, 5_000, true);
  turn = turnLyricsTo(turn, 5, 5_100, true);
  assert.deepEqual([turn.shown, turn.wanted, turn.phase], [5, 5, "out"]);
  turn = advanceLyricsTurn(turn, 5_100 + OUT, true, true);
  assert.deepEqual([turn.shown, turn.phase, turn.turns], [5, "rest", 2]);
});

test("lyrics that are still coming out go back the way they came", () => {
  let turn = turnLyricsTo(advanceLyricsTurn(lyricsTurnAt<number>(1), 0, true, true), 2, 1_000, true);
  turn = advanceLyricsTurn(turn, 1_000 + OUT, true, true);
  turn = advanceLyricsTurn(turn, 1_000 + OUT + 10, true, true);
  // 120 ms into their entrance the song changes again.
  const back = turnLyricsTo(turn, 3, 1_000 + OUT + 130, true);
  assert.deepEqual([back.shown, back.phase, back.turnedAt], [2, "back", 120]);
  assert.ok(lyricsLeaving(back.phase));
  // Once they have settled it is an ordinary exit.
  const out = turnLyricsTo(turn, 3, 1_000 + OUT + 10 + OUT, true);
  assert.deepEqual([out.phase, out.turnedAt], ["out", null]);
  // A panel's first lyrics did not come by a turn: they leave the ordinary way too.
  const first = turnLyricsTo(advanceLyricsTurn(lyricsTurnAt<number>(1), 0, true, true), 2, 100, true);
  assert.equal(first.phase, "out");
});

test("nothing to take away, nothing to bring, or no motion: the content changes at once", () => {
  // No song before: the first one simply appears.
  let turn = turnLyricsTo(lyricsTurnAt<number>(null), 1, 500, true);
  assert.deepEqual([turn.shown, turn.phase, turn.turns], [1, "rest", 0]);
  // No song after.
  turn = turnLyricsTo(turn, null, 900, true);
  assert.deepEqual([turn.shown, turn.phase], [null, "rest"]);
  // Reduced motion.
  turn = turnLyricsTo(lyricsTurnAt<number>(1), 2, 500, false);
  assert.deepEqual([turn.shown, turn.phase, turn.since], [2, "rest", 500]);
  // The deck is emptied while the old lyrics leave: they finish leaving, and nothing comes.
  turn = turnLyricsTo(turnLyricsTo(lyricsTurnAt<number>(1), 2, 0, true), null, 100, true);
  turn = advanceLyricsTurn(turn, 100 + OUT, false, false);
  assert.deepEqual([turn.shown, turn.wanted, turn.phase], [null, null, "rest"]);
});

test("lyrics are settled once they are in or known to be missing", () => {
  assert.equal(lyricsSettled({ status: "idle", inflight: null }), false);
  assert.equal(lyricsSettled({ status: "loading", inflight: Promise.resolve() }), false);
  assert.equal(lyricsSettled({ status: "ready", inflight: Promise.resolve() }), false, "a rematch is under way");
  assert.equal(lyricsSettled({ status: "ready", inflight: null }), true);
  assert.equal(lyricsSettled({ status: "empty", inflight: null }), true);
  assert.equal(lyricsSettled({ status: "error", inflight: null }), true);
});
