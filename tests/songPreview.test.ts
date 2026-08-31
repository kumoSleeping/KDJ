import assert from "node:assert/strict";
import test from "node:test";
import type { SongSource } from "../src/types";

let stableLocalStorage: Storage | null = null;

function installBrowserStubs(): void {
  const storage = new Map<string, string>();
  const freshLocalStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  };
  // streamTrack 持有与真实 WebView 一样稳定的 Storage 对象；测试重建 window 时也应
  // 保留这个对象，只清空内容，避免把“换了整个浏览器存储实现”误当成重启场景。
  const localStorage = stableLocalStorage ?? freshLocalStorage;
  stableLocalStorage = localStorage as Storage;
  localStorage.clear();
  const events = new EventTarget();
  const audio = {
    preload: "",
    crossOrigin: "",
    preservesPitch: true,
    webkitPreservesPitch: true,
  };
  const window = Object.assign(events, {
    kdj: { baseUrl: "http://127.0.0.1:43123", platform: "darwin" },
    localStorage,
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
      streamWaveformTokenById,
      streamMediaUrl,
      streamTrackById,
      subscribeStreamMeta,
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

    let metaUpdates = 0;
    const unsubscribeMeta = subscribeStreamMeta(track.id, () => {
      metaUpdates += 1;
    });

    releasePreview?.();
    await pending;
    assert.equal(getSongPreviewState().phase, "ready");
    assert.equal(isUnresolvedStreamTrack(track), false);
    assert.equal(streamMediaUrl(track), "http://127.0.0.1:43123/api/song/preview/token");
    assert.equal(mediaUrlForTrack(track), "http://127.0.0.1:43123/api/song/preview/token");
    assert.equal(streamWaveformTokenById(track.id), "wave-1");
    assert.equal(metaUpdates, 1, "waveform polling must wake exactly when the token arrives");
    unsubscribeMeta();
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

test("unresolved stream tracks remain identifiable while the DJ lane resolves them in place", async () => {
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

test("YouTube Music playback exposes a first-attempt failure instead of refreshing proof automatically", async () => {
  installBrowserStubs();
  const { claimStreamCacheRetry, makeSongStreamTrack } = await import("../src/lib/streamTrack");
  const track = makeSongStreamTrack(
    ytmSource("Single path"),
    "http://127.0.0.1:43123/api/song/preview/token",
  );
  assert.equal(claimStreamCacheRetry(track), null);
  assert.equal(claimStreamCacheRetry(track), null);
});

test("online Deck persistence keeps a restartable source but never stores the short-lived media URL", async () => {
  installBrowserStubs();
  const {
    makeSongStreamTrack,
    publishStreamTrack,
    publishedStreamSnapshot,
  } = await import("../src/lib/streamTrack");
  const source = ytmSource("Remember me");
  const track = makeSongStreamTrack(
    source,
    "http://127.0.0.1:43123/api/song/preview/short-lived-secret",
  );

  publishStreamTrack(track);
  const stored = globalThis.localStorage.getItem("kd-active-stream-track");
  assert.ok(stored);
  assert.equal(stored.includes("short-lived-secret"), false);
  const snapshot = publishedStreamSnapshot(JSON.parse(stored));
  assert.ok(snapshot);
  assert.equal(snapshot.track.id, track.id);
  assert.deepEqual(snapshot.source.payload, { video_id: "abc123" });

  publishStreamTrack(null);
  assert.equal(globalThis.localStorage.getItem("kd-active-stream-track"), null);
});
