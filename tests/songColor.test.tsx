import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { Track } from "../src/types";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("song colour: the choice is kept, and nothing is drawn, fetched or listened to while it is off", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  });
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
  // Every cover request and every listener on the window is counted.
  const fetched: string[] = [];
  globalThis.fetch = (async (input: unknown) => { fetched.push(String(input)); return new Response(null, { status: 404 }); }) as typeof fetch;
  const heard: string[] = [];
  const listen = dom.window.addEventListener.bind(dom.window);
  dom.window.addEventListener = ((type: string, ...rest: unknown[]) => { heard.push(type); return (listen as (...args: unknown[]) => void)(type, ...rest); }) as typeof dom.window.addEventListener;

  const { createRoot } = await import("react-dom/client");
  const { readSongColorOn, songColorSessionRunning, useSongColor } = await import("../src/lib/songColor");
  const { DEFAULT_SONG_COLOR } = await import("../src/lib/songColorPalette");
  const { MEDIA_SYNC_EVENT } = await import("../src/lib/mediaSync");
  const { setPlayingTrack } = await import("../src/lib/playingTrack");
  const { useThemePack } = await import("../src/lib/themePack");
  const { SongColorBackdrop } = await import("../src/components/player/SongColorBackdrop");
  const { NowPlayingTask, NOW_PLAYING_TASK } = await import("../src/components/player/NowPlayingTask");
  const { TaskBubbleHost } = await import("../src/components/tasks/TaskBubbleHost");
  const { useTaskBubbles } = await import("../src/components/tasks/taskBubbleStore");
  const { useNowPlayingInfo } = await import("../src/lib/nowPlayingInfo");
  const { usePlayerBarAway } = await import("../src/lib/playerBarAway");

  // Off unless it was switched on, and remembered either way.
  assert.equal(useSongColor.getState().on, false);
  assert.equal(readSongColorOn(), false);
  useSongColor.getState().toggle();
  assert.equal(useSongColor.getState().on, true);
  assert.equal(dom.window.localStorage.getItem("kd-song-color"), "on");
  assert.equal(readSongColorOn(), true, "what the next launch reads");
  useSongColor.getState().toggle();
  assert.equal(dom.window.localStorage.getItem("kd-song-color"), "off");
  assert.equal(readSongColorOn(), false);
  // The press remembers where its key was: the colour spreads from there.
  const key = dom.window.document.createElement("button");
  key.getBoundingClientRect = () => ({ left: 100, top: 40, width: 24, height: 24, right: 124, bottom: 64, x: 100, y: 40, toJSON() {} });
  useSongColor.getState().toggle(key);
  assert.deepEqual([useSongColor.getState().wash?.on, useSongColor.getState().wash?.x, useSongColor.getState().wash?.y], [true, 112, 52]);
  useSongColor.getState().toggle(key);
  assert.equal(useSongColor.getState().wash?.on, false);

  setPlayingTrack({ id: 7, path: "/library/7.mp3", filename: "7.mp3", title: "Song", artist: "Artist", album: "",
    format: "mp3", size: 1, duration: 200, bpm: 128, first_beat: 0.1, modified_at: "a", source_platform: "local", music_key: "",
    camelot: "8A", open_key: "", tags: [], cue_points: [] } as unknown as Track);
  usePlayerBarAway.setState({ tall: false, collapsed: false, phase: "up" });
  useNowPlayingInfo.setState({ open: true, peek: 0, barAway: false });
  useTaskBubbles.setState({ entries: [] });
  const root = createRoot(dom.window.document.getElementById("root")!);
  heard.length = 0;
  fetched.length = 0;
  await act(async () => root.render(createElement("div", { className: "kd-app" },
    createElement(NowPlayingTask, { trackId: 7, playing: true }),
    createElement(TaskBubbleHost, null),
    createElement("div", { id: "lyrics" }, createElement(SongColorBackdrop, { surface: "lyrics" })))));
  const bubble = () => dom.window.document.querySelector<HTMLElement>(".kd-task");
  const layersOn = () => dom.window.document.querySelectorAll(".kd-songcolor").length;
  const actions = () => useTaskBubbles.getState().entries.find(entry => entry.spec.id === NOW_PLAYING_TASK && !entry.leaving)?.spec.actions ?? [];

  // Off: the bubble has its slot and its key, and that is all there is.
  assert.ok(bubble(), "the opened bubble is up");
  assert.equal(layersOn(), 0, "no layer");
  assert.equal(dom.window.document.querySelectorAll("canvas").length, 0, "no bitmap");
  assert.equal(songColorSessionRunning(), false, "nothing reads covers");
  assert.deepEqual(fetched, [], "no cover is asked for");
  assert.ok(!heard.includes(MEDIA_SYNC_EVENT), "nothing listens to the player's clock");
  assert.equal(bubble()!.hasAttribute("data-backdrop-ink"), false);
  assert.equal(bubble()!.firstElementChild?.className, "kd-backdrop", "the slot is the bubble's first child, under its content");
  assert.equal(bubble()!.firstElementChild?.childElementCount, 0);
  assert.equal(actions().find(action => action.id === "color")?.pressed, false);
  assert.equal(actions().find(action => action.id === "color")?.label, "打开歌曲色彩");

  // On, from the bubble's key: both surfaces get a layer, the cover is asked for once, and the
  // bubble takes the field's ink.
  await act(async () => actions().find(action => action.id === "color")!.onSelect(bubble()!));
  assert.equal(useSongColor.getState().on, true);
  assert.equal(actions().find(action => action.id === "color")?.pressed, true);
  assert.equal(actions().find(action => action.id === "color")?.label, "关闭歌曲色彩");
  assert.equal(layersOn(), 2);
  assert.equal(songColorSessionRunning(), true);
  // (React holds what happens inside an act until it ends: once for the colours to arrive,
  // once more for the layers to answer them.)
  await act(async () => { await sleep(120); });
  await act(async () => { await sleep(40); });
  assert.equal(fetched.length, 1, "one request for the two layers");
  assert.match(fetched[0], /\/api\/library\/cover\/7\?.*size=64/);
  // This song has no cover (404): the calm default.
  assert.equal(dom.window.document.querySelector(".kd-songcolor")?.getAttribute("data-source"), "default");
  assert.equal(bubble()!.getAttribute("data-backdrop-ink"), "true");
  assert.equal(bubble()!.style.getPropertyValue("--kd-backdrop-text"), DEFAULT_SONG_COLOR.ink.text);
  assert.equal(bubble()!.style.getPropertyValue("--kd-backdrop-muted"), DEFAULT_SONG_COLOR.ink.muted);
  assert.doesNotMatch(dom.window.document.documentElement.style.cssText, /backdrop|songcolor|--kd-text|--kd-muted/, "nothing of it is written on the document");
  assert.ok(dom.window.document.querySelector(".kd-task .kd-songcolor")?.parentElement?.parentElement === bubble(), "inside the bubble, in its slot");
  assert.equal(dom.window.document.querySelectorAll(".kd-task .kd-songcolor-drift").length, 4, "four masses");

  // Off again: the layers drain and go, the ink is the bubble's own, the session stops.
  await act(async () => actions().find(action => action.id === "color")!.onSelect(bubble()!));
  assert.equal(useSongColor.getState().on, false);
  await act(async () => { await sleep(260); });
  assert.equal(layersOn(), 0);
  assert.equal(songColorSessionRunning(), false);
  assert.equal(bubble()!.hasAttribute("data-backdrop-ink"), false);
  assert.equal(bubble()!.style.getPropertyValue("--kd-backdrop-text"), "");

  // A theme pack draws the two surfaces its own way: the look is not offered under one.
  await act(async () => useSongColor.getState().toggle());
  assert.equal(layersOn(), 2);
  await act(async () => useThemePack.setState({ active: { id: "sakulaptop98" } as never }));
  await act(async () => { await sleep(260); });
  assert.equal(actions().some(action => action.id === "color"), false, "no key under a pack");
  assert.equal(layersOn(), 0);
  assert.equal(bubble()!.querySelector(".kd-backdrop"), null, "and no slot");
  assert.equal(useSongColor.getState().on, true, "the choice is kept for when the pack is taken off");
  await act(async () => useThemePack.setState({ active: null }));
  assert.equal(layersOn(), 2);

  await act(async () => root.unmount());
  assert.equal(songColorSessionRunning(), false);
  setPlayingTrack(null);
  useSongColor.setState({ on: false, wash: null });
});
