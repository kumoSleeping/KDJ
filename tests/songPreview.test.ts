import assert from "node:assert/strict";
import test from "node:test";
import type { SongSource } from "../src/types";

function installBrowserStubs(): void {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  };
  const events = new EventTarget();
  const audio = {
    preload: "",
    crossOrigin: "",
    preservesPitch: true,
    webkitPreservesPitch: true,
  };
  const window = Object.assign(events, {
    kdj: { baseUrl: "http://127.0.0.1:43123", platform: "darwin" },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
  Object.assign(globalThis, {
    localStorage,
    window,
    document: {
      baseURI: "http://127.0.0.1/",
      createElement: () => ({ ...audio }),
      documentElement: { dataset: {} },
      querySelectorAll: () => [],
    },
  });
}

function ytmSource(title = "Nightcall"): SongSource {
  return {
    platform: "ytm",
    key: "abc123",
    title,
    artists: ["Kavinsky"],
    album: "OutRun",
    duration: 255,
    cover: "https://img.example/cover.jpg",
    max_quality: null,
    vip: false,
    payload: { video_id: "abc123" },
  };
}

test("playSongPreview puts the track on the Deck before the provider URL resolves", async () => {
  installBrowserStubs();
  let releasePreview: (() => void) | undefined;
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  const played: Array<{ id: number; title: string; autoPlay: boolean }> = [];

  const host = globalThis.window as unknown as EventTarget;
  host.addEventListener("kd:play", (event) => {
    const detail = (event as CustomEvent<{ track: { id: number; title: string }; autoPlay?: boolean }>).detail;
    played.push({
      id: detail.track.id,
      title: detail.track.title,
      autoPlay: detail.autoPlay !== false,
    });
  });

  const { api } = await import("../src/lib/api");
  const originalPreview = api.songPreview;
  api.songPreview = async (_source, bypassCache = false) => {
    await previewGate;
    return {
      url: "http://127.0.0.1:43123/api/song/preview/token",
      waveform_token: "wave-1",
      cached: bypassCache,
    };
  };

  try {
    const { playSongPreview, getSongPreviewState } = await import("../src/lib/songPreview");
    const {
      isUnresolvedStreamTrack,
      mediaUrlForTrack,
      streamMediaUrl,
      streamTrackById,
    } = await import("../src/lib/streamTrack");

    const pending = playSongPreview({
      source: ytmSource(),
      title: "Nightcall",
      artist: "Kavinsky",
      autoPlay: true,
    });

    await Promise.resolve();
    assert.equal(played.length, 1, "唱盘必须在直链返回前就接到装盘事件");
    assert.equal(played[0].title, "Nightcall");
    assert.equal(played[0].autoPlay, true);
    assert.equal(getSongPreviewState().phase, "resolving");
    assert.equal(getSongPreviewState().trackId, played[0].id);

    const track = streamTrackById(played[0].id);
    assert.ok(track);
    assert.equal(track.artist, "Kavinsky");
    assert.equal(isUnresolvedStreamTrack(track), true);
    assert.equal(streamMediaUrl(track), null);
    assert.equal(mediaUrlForTrack(track), "");

    releasePreview?.();
    await pending;
    assert.equal(getSongPreviewState().phase, "ready");
    assert.equal(isUnresolvedStreamTrack(track), false);
    assert.equal(streamMediaUrl(track), "http://127.0.0.1:43123/api/song/preview/token");
    assert.equal(mediaUrlForTrack(track), "http://127.0.0.1:43123/api/song/preview/token");
  } finally {
    api.songPreview = originalPreview;
  }
});

test("requestSongPreview starts the first double-click without waiting for an App listener", async () => {
  installBrowserStubs();
  const played: string[] = [];
  (globalThis.window as unknown as EventTarget).addEventListener("kd:play", (event) => {
    const detail = (event as CustomEvent<{ track: { title: string } }>).detail;
    played.push(detail.track.title);
  });
  const { api } = await import("../src/lib/api");
  const originalPreview = api.songPreview;
  api.songPreview = async () => ({
    url: "http://127.0.0.1:43123/api/song/preview/direct",
    waveform_token: "wave-direct",
  });
  try {
    const { requestSongPreview } = await import("../src/lib/songPreview");
    requestSongPreview({
      source: ytmSource("LOUDER"),
      title: "LOUDER",
      artist: "Roselia",
      autoPlay: true,
    });
    await Promise.resolve();
    assert.deepEqual(played, ["LOUDER"]);
  } finally {
    api.songPreview = originalPreview;
  }
});

test("unresolved stream tracks are identified so PlayerBar can hard-cut instead of DJ-wait", async () => {
  installBrowserStubs();
  const { makePendingSongStreamTrack, makeSongStreamTrack, isUnresolvedStreamTrack } = await import(
    "../src/lib/streamTrack"
  );
  const pending = makePendingSongStreamTrack(ytmSource("Pending"));
  const ready = makeSongStreamTrack(ytmSource("Ready"), "http://127.0.0.1/stream");
  assert.equal(isUnresolvedStreamTrack(pending), true);
  assert.equal(isUnresolvedStreamTrack(ready), false);
});

test("unresolved stream tracks never fall back to the local library audio URL", async () => {
  installBrowserStubs();
  const { makePendingSongStreamTrack, mediaUrlForTrack, isUnresolvedStreamTrack } = await import(
    "../src/lib/streamTrack"
  );
  const track = makePendingSongStreamTrack(ytmSource("Unreleased"));
  assert.equal(isUnresolvedStreamTrack(track), true);
  assert.equal(mediaUrlForTrack(track), "");
  assert.equal(mediaUrlForTrack(track).includes(`/library/audio/${track.id}`), false);
});
