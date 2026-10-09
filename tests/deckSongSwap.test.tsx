import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement, act } from "react";

interface View { key: string; cover: string; title: string }
const view = (key: string, title = key): View => ({ key, cover: "", title });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("the deck card holds the old song for the exit, then lets the latest one arrive", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  let reducedMotion = false;
  Object.assign(dom.window, { matchMedia: () => ({ get matches() { return reducedMotion; } }) });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const { deckSongKey, useDeckSongSwap } = await import("../src/components/player/deckSongSwap");
  const { SONG_SWAP_IN_MS, SONG_SWAP_OUT_MS, songSwapEntranceDelay } = await import("../src/lib/songSwapMotion");

  assert.equal(deckSongKey(null), null);
  assert.equal(deckSongKey(view("library:5")), "track:5");
  assert.equal(deckSongKey(view("local:5")), "track:5", "the same track through the video window");
  assert.equal(deckSongKey(view("stream:-7")), deckSongKey(view("library:-7")), "the same stream as one side of a transition");
  assert.notEqual(deckSongKey(view("network:BV1:1")), deckSongKey(view("network:BV1:2")));

  /** Everything the card has displayed, in order. */
  const seen: string[] = [];
  let now: { title: string | null; phase: string | null; song: string | null } = { title: null, phase: null, song: null };
  let style: unknown = {};
  function Card({ current }: { current: View | null }) {
    const swap = useDeckSongSwap(current, "test-deck");
    now = { title: swap.view?.title ?? null, phase: swap.phase, song: swap.song };
    style = swap.style;
    const frame = `${now.title}/${now.phase}`;
    if (seen[seen.length - 1] !== frame) seen.push(frame);
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  const show = (current: View | null) => act(async () => { root.render(createElement(Card, { current })); });
  const wait = (ms: number) => act(async () => { await sleep(ms); });
  const A = view("library:1", "A"), B = view("library:2", "B"), C = view("library:3", "C"), D = view("library:4", "D");
  try {
    // Nothing on screen: the first song has nothing to wait for and simply appears.
    await show(null);
    assert.equal(songSwapEntranceDelay(), 0);
    await show(A);
    assert.deepEqual(now, { title: "A", phase: null, song: "track:1" });
    assert.equal(songSwapEntranceDelay(), SONG_SWAP_OUT_MS, "a card showing a song is something to take away");

    // The same song under another view key, or with fresher metadata, is not a change.
    await show({ ...A, key: "local:1", title: "A (video)" });
    assert.deepEqual(now, { title: "A (video)", phase: null, song: "track:1" });
    await show(A);

    // A change: the old song stays for the exit, the new one arrives after it.
    await show(B);
    assert.deepEqual(now, { title: "A", phase: "out", song: "track:1" });
    await wait(SONG_SWAP_OUT_MS - 120);
    assert.deepEqual(now, { title: "A", phase: "out", song: "track:1" });
    await wait(160);
    assert.deepEqual(now, { title: "B", phase: "in", song: "track:2" });
    await wait(SONG_SWAP_IN_MS + 80);
    assert.deepEqual(now, { title: "B", phase: null, song: "track:2" });

    // Skipping on during the exit does not queue: the wait starts over and only the last arrives.
    seen.length = 0;
    await show(C);
    await wait(200);
    await show(D);
    await wait(SONG_SWAP_OUT_MS - 120);
    assert.deepEqual(now, { title: "B", phase: "out", song: "track:2" }, "the wait started over");
    await wait(160);
    assert.deepEqual(now, { title: "D", phase: "in", song: "track:4" });
    assert.ok(!seen.some(frame => frame.startsWith("C/")), `the skipped song was never displayed: ${seen.join(" ")}`);

    // A change while the new song is still arriving sends it back from where it has got to.
    await wait(60);
    await show(A);
    assert.deepEqual(now, { title: "D", phase: "back", song: "track:4" });
    const rewind = parseFloat(String((style as Record<string, string>)["--kd-swap-rewind"]));
    assert.ok(rewind <= 60 + 60 - SONG_SWAP_IN_MS + 40 && rewind >= 60 - SONG_SWAP_IN_MS,
      `the entrance runs backwards from about 60 ms in: ${rewind}`);
    await wait(SONG_SWAP_OUT_MS + 40);
    assert.deepEqual(now, { title: "A", phase: "in", song: "track:1" });
    assert.equal((style as Record<string, string>)["--kd-swap-rewind"], undefined);
    // Once it has all but settled, it is swiped away like any other.
    await wait(SONG_SWAP_OUT_MS + 30);
    assert.equal(now.phase, "in");
    await show(B);
    assert.deepEqual(now, { title: "A", phase: "out", song: "track:1" });
    // Going back to the song that is leaving brings it in again instead of popping it back.
    await wait(100);
    await show(A);
    assert.deepEqual(now, { title: "A", phase: "in", song: "track:1" });
    await wait(SONG_SWAP_IN_MS + 80);
    assert.equal(now.phase, null);

    // No song, and a song after none, change at once.
    await show(B);
    await wait(100);
    await show(null);
    assert.deepEqual(now, { title: null, phase: null, song: null });
    assert.equal(songSwapEntranceDelay(), 0, "an empty card is nothing to wait for");
    await show(C);
    assert.deepEqual(now, { title: "C", phase: null, song: "track:3" });

    // Reduced motion: a plain change, and nothing for the other surfaces to wait for.
    reducedMotion = true;
    await show(D);
    assert.deepEqual(now, { title: "D", phase: null, song: "track:4" });
    await show(null);
    await show(A);
    assert.equal(songSwapEntranceDelay(), 0);
    reducedMotion = false;
  } finally {
    await act(async () => root.unmount());
    assert.equal(songSwapEntranceDelay(), 0, "unmounting withdraws the card");
    dom.window.close();
  }
});
