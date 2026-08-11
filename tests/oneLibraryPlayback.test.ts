import assert from "node:assert/strict";
import test from "node:test";

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
  const audio = {
    preload: "",
    crossOrigin: "",
    preservesPitch: true,
    webkitPreservesPitch: true,
  };
  Object.assign(globalThis, {
    localStorage,
    document: {
      baseURI: "http://127.0.0.1/",
      createElement: () => ({ ...audio }),
      documentElement: { dataset: {} },
      querySelectorAll: () => [],
    },
    window: {
      kdj: { baseUrl: "http://127.0.0.1:43123", platform: "darwin" },
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
}

test("OneLibrary negative ids request the dedicated complete waveform instead of stream snapshots", async () => {
  installBrowserStubs();
  const requested: string[] = [];
  Object.assign(globalThis, {
    fetch: async (input: string | URL | Request) => {
      requested.push(String(input));
      const amp = Array(640).fill(0.5);
      return new Response(
        JSON.stringify({
          track_id: -1_234_567_890,
          duration: 180,
          amp,
          r: Array(640).fill(255),
          g: Array(640).fill(128),
          b: Array(640).fill(64),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const [
    { oneLibraryPlayableTrack },
    { loadWaveformForTrack, streamWaveformSnapshot },
    { mediaUrlForTrack },
    { api },
  ] = await Promise.all([
    import("../src/lib/oneLibraryTrack"),
    import("../src/lib/waveformCache"),
    import("../src/lib/streamTrack"),
    import("../src/lib/api"),
  ]);
  const track = oneLibraryPlayableTrack(
    {
      content_id: 5,
      sequence: 0,
      local_track_id: 5,
      external_modified: false,
      external_update_count: 0,
      title: "GIRAFFE BLUES",
      artist: "ワルキューレ",
      album: "",
      genre: "",
      year: "",
      bpm: null,
      music_key: "",
      camelot: "",
      open_key: "",
      duration: 314.8,
      bitrate: 320,
      samplerate: 44_100,
      size: 12_708_117,
      rating: 0,
      comment: "",
      cover_version: "embedded-1",
      cue_points: [],
      path: "/Volumes/KDJ/Contents/KDJ/GIRAFFE BLUES.mp3",
      filename: "GIRAFFE BLUES.mp3",
    },
    {
      device_path: "/Volumes/KDJ",
      device_name: "KDJ",
      is_virtual: true,
      playlist_id: 4,
      playlist_name: "喵",
    },
  );

  assert.equal(mediaUrlForTrack(track), track.path, "播放源必须是外置卷真实文件");
  const coverUrl = api.oneLibraryCoverUrl("/Volumes/KDJ", 5);
  assert.equal(new URL(coverUrl).pathname, "/api/library/onelibrary/cover");
  assert.equal(coverUrl.includes(`/api/library/cover/${track.id}`), false);
  assert.equal(streamWaveformSnapshot(track.id), null);
  const waveform = await loadWaveformForTrack(track);
  assert.equal(waveform.amp.length, 640);
  assert.equal(requested.length, 1);
  const url = new URL(requested[0]);
  assert.equal(url.pathname, "/api/library/onelibrary/waveform");
  assert.equal(url.searchParams.get("device_path"), "/Volumes/KDJ");
  assert.equal(url.searchParams.get("content_id"), "5");
  assert.equal(url.searchParams.get("playback_id"), String(track.id));
  assert.equal(
    requested.some((value) => value.includes(`/api/library/waveform/${track.id}`)),
    false,
  );
});
