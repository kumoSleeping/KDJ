import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement, act } from "react";
import type { Track } from "../src/types";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("a lyrics panel holds the old song's lyrics for the exit and brings the next song's when they are ready", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  let reducedMotion = false;
  Object.assign(dom.window, { matchMedia: () => ({ get matches() { return reducedMotion; } }) });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { useLyricsTurn } = await import("../src/components/player/useLyricsTurn");
  const { useLyricsStore } = await import("../src/stores/lyricsStore");
  const { useLyricsPrefs } = await import("../src/lib/lyricsPrefs");
  const { LYRICS_READY_CAP_MS } = await import("../src/lib/lyricsTurn");
  const { SONG_SWAP_OUT_MS, songSwapEntranceDelay } = await import("../src/lib/songSwapMotion");

  const song = (id: number, format = "mp3") => ({ id, title: `Song ${id}`, filename: `${id}.${format}`, format, artist: "" }) as unknown as Track;
  // What the store holds for a song, under the preferences in force, so the hook's own lookup
  // on the disk finds the answer already there.
  const prefs = useLyricsPrefs.getState();
  const fingerprint = `${prefs.displaySource}|${prefs.engines.join(",")}|${prefs.tryOnlineWhenMissing}`;
  const never = new Promise<void>(() => {});
  const lyrics = (id: number, state: "ready" | "empty" | "loading") => act(async () => {
    useLyricsStore.setState(store => ({ byId: { ...store.byId, [id]: {
      status: state, lines: state === "ready" ? [{ time: 1, text: `words of ${id}` }] : [], translated: [], romaji: [],
      meta: null, error: "", persisted: true, fingerprint, inflight: state === "loading" ? never : null,
    } } }));
  });

  let now: { shown: number | null; phase: string; leaving: boolean; arriving: boolean; key: string } = { shown: null, phase: "", leaving: false, arriving: false, key: "" };
  const seen: (number | null)[] = [];
  let style: Record<string, unknown> = {};
  function Panel({ track }: { track: Track | null }) {
    const turn = useLyricsTurn(track, "test-lyrics");
    now = { shown: turn.track?.id ?? null, phase: turn.phase, leaving: turn.leaving, arriving: turn.arriving, key: turn.key };
    style = turn.style as Record<string, unknown>;
    if (seen[seen.length - 1] !== now.shown) seen.push(now.shown);
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  const play = (track: Track | null) => act(async () => { root.render(createElement(Panel, { track })); });
  const wait = (ms: number) => act(async () => { await sleep(ms); });
  try {
    await lyrics(1, "ready"); await lyrics(2, "ready"); await lyrics(3, "loading"); await lyrics(4, "loading"); await lyrics(5, "empty");
    await play(song(1));
    assert.deepEqual([now.shown, now.phase, now.arriving], [1, "rest", false], "a panel's first lyrics simply appear");
    await wait(20);
    assert.equal(songSwapEntranceDelay(), SONG_SWAP_OUT_MS, "lyrics on screen are something to take away");

    // Ready lyrics: the old ones leave as a picture, the new ones come when the exit is over.
    await play(song(2));
    assert.deepEqual([now.shown, now.phase, now.leaving], [1, "out", true]);
    const first = now.key;
    await wait(SONG_SWAP_OUT_MS - 120);
    assert.deepEqual([now.shown, now.phase], [1, "out"]);
    await wait(170);
    assert.deepEqual([now.shown, now.phase, now.leaving, now.arriving], [2, "rest", false, true]);
    assert.notEqual(now.key, first, "the lyrics that come out are a view of their own");

    // A change while they are still coming out sends them back from where they have got to.
    await play(song(1));
    assert.deepEqual([now.shown, now.phase, now.leaving], [2, "back", true]);
    assert.ok(parseFloat(String(style["--kd-swap-rewind"])) < 0, "the entrance runs backwards from part of the way in");
    await wait(SONG_SWAP_OUT_MS + 60);
    assert.deepEqual([now.shown, now.phase], [1, "rest"]);
    assert.equal(style["--kd-swap-rewind"], undefined);
    await wait(SONG_SWAP_OUT_MS);

    // Lyrics that are still being fetched: the panel holds nothing until they are in.
    seen.length = 0;
    await play(song(3));
    await wait(SONG_SWAP_OUT_MS + 60);
    assert.deepEqual([now.shown, now.phase], [null, "wait"]);
    await wait(200);
    assert.deepEqual([now.shown, now.phase], [null, "wait"]);
    await lyrics(3, "ready");
    await wait(30);
    assert.deepEqual([now.shown, now.phase, now.arriving], [3, "rest", true]);
    await wait(SONG_SWAP_OUT_MS);

    // A slow provider is not waited for beyond the cap: the view comes with its loading state.
    await play(song(4));
    await wait(SONG_SWAP_OUT_MS + LYRICS_READY_CAP_MS - 150);
    assert.deepEqual([now.shown, now.phase], [null, "wait"]);
    await wait(220);
    assert.deepEqual([now.shown, now.phase], [4, "rest"]);
    assert.equal(songSwapEntranceDelay(), 0, "a panel without lyrics on screen is nothing to wait for");

    // No lyrics, and a video: known at once, so the turn takes no longer than the exit.
    await lyrics(4, "ready");
    await wait(30);
    await play(song(5));
    await wait(SONG_SWAP_OUT_MS + 60);
    assert.deepEqual([now.shown, now.phase], [5, "rest"], "known to be missing is ready");
    // A panel with nothing in it still waits out the exit of the song's other surfaces
    // instead of arriving alone.
    await play(song(1));
    await wait(40);
    assert.deepEqual([now.shown, now.phase], [5, "out"]);
    await wait(SONG_SWAP_OUT_MS + 40);
    assert.deepEqual([now.shown, now.phase], [1, "rest"]);

    // Three quick skips: one exit, and only the last song arrives.
    await wait(SONG_SWAP_OUT_MS);
    seen.length = 0;
    await play(song(2)); await wait(120);
    await play(song(5)); await wait(120);
    await play(song(1));
    assert.deepEqual([now.shown, now.phase], [1, "out"], "back to the song that is leaving: it still leaves, and arrives again");
    await wait(SONG_SWAP_OUT_MS + 60);
    assert.deepEqual([now.shown, now.phase, now.arriving], [1, "rest", true]);
    assert.deepEqual(seen.filter(id => id !== 1), [], `the skipped songs were never in the panel: ${seen.join(" ")}`);

    // A video has no lyrics: nothing to fetch, the old lyrics leave and the panel is empty.
    await play(song(9, "mp4"));
    await wait(SONG_SWAP_OUT_MS + 60);
    assert.deepEqual([now.shown, now.phase], [9, "rest"]);

    // No song at all: the panel has nothing to hold.
    await play(null);
    assert.deepEqual([now.shown, now.phase], [null, "rest"]);

    // Reduced motion: the content changes at once.
    await play(song(1));
    await wait(20);
    reducedMotion = true;
    await play(song(2));
    assert.deepEqual([now.shown, now.phase, now.leaving], [2, "rest", false]);
    reducedMotion = false;
  } finally {
    await act(async () => root.unmount());
    assert.equal(songSwapEntranceDelay(), 0, "unmounting withdraws the panel");
    dom.window.close();
  }
});
