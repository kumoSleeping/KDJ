import assert from "node:assert/strict";
import test from "node:test";
import {
  platformShareLink,
  soundCloudPlayerShareLink,
  soundCloudStoredShareLink,
  soundCloudTrackApiUrl,
  soundCloudTrackId,
  trackShareLink,
} from "../src/lib/shareLink";

test("a SoundCloud download is shared by its own id, never by a title match", () => {
  const stored = { source_platform: "soundcloud", source_key: "soundcloud:tracks:12345" };
  // The record keeps the URN; the public page is a permalink it does not keep.
  assert.equal(trackShareLink(stored), null);
  assert.equal(soundCloudTrackId(stored), "12345");
  assert.equal(soundCloudTrackId({ source_platform: "SoundCloud", source_key: " 678 " }), "678");
  assert.equal(soundCloudTrackId({ source_platform: "wyy", source_key: "12345" }), null);
  assert.equal(soundCloudTrackId({ source_platform: "soundcloud", source_key: "soundcloud:playlists:12345" }), null);
  // An old record whose key already is the permalink needs nothing looked up.
  const legacy = { source_platform: "soundcloud", source_key: "http://soundcloud.com/dj/nightdrive" };
  assert.equal(soundCloudTrackId(legacy), null);
  assert.equal(trackShareLink(legacy), "https://soundcloud.com/dj/nightdrive");

  assert.equal(soundCloudTrackApiUrl("12345"), "https://api.soundcloud.com/tracks/12345");
  const source = (key: string, permalink: string, payload: Record<string, unknown> = {}) =>
    ({ platform: "soundcloud" as const, key, payload: { permalink_url: permalink, ...payload } });
  const sources = [
    source("soundcloud:tracks:999", "https://soundcloud.com/other/nightdrive-reupload"),
    { platform: "wyy" as const, key: "12345", payload: {} },
    source("soundcloud:tracks:12345", "https://soundcloud.com/dj/nightdrive"),
  ];
  assert.equal(soundCloudStoredShareLink(stored, sources), "https://soundcloud.com/dj/nightdrive");
  assert.equal(soundCloudStoredShareLink(stored, sources.slice(0, 2)), null, "a similar upload is not the track");
  assert.equal(
    soundCloudStoredShareLink(stored, [source("https://soundcloud.com/dj/nightdrive", "https://soundcloud.com/dj/nightdrive", { urn: "soundcloud:tracks:12345" })]),
    "https://soundcloud.com/dj/nightdrive",
    "a source keyed by its permalink is matched by the URN it carries",
  );
  assert.equal(
    soundCloudStoredShareLink(stored, [source("soundcloud:tracks:12345", "https://evil.example/dj/nightdrive")]),
    null,
    "only a SoundCloud address is shared",
  );
  assert.equal(
    soundCloudPlayerShareLink(stored),
    "https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F12345",
  );
  assert.equal(soundCloudPlayerShareLink(legacy), null);
  // The other platforms keep building their links from the stored key.
  assert.equal(platformShareLink("wyy", "12345"), "https://y.music.163.com/m/song?id=12345");
});
