import assert from "node:assert/strict";
import test from "node:test";
import { coordinateLocalVideoSeek } from "../src/lib/localVideoSeekTiming";
import type { PreparedLocalVideoSeek } from "../src/lib/localVideoSeekBridge";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Rust audio seek is committed before target video decoding finishes", async () => {
  const events: string[] = [];
  const preparation = deferred<PreparedLocalVideoSeek | null>();
  const completion = coordinateLocalVideoSeek(() => preparation.promise, {
    commitAudio: () => events.push("audio"),
    publishVideoSeek: () => events.push("video-sync"),
    isCurrent: () => true,
  });

  assert.deepEqual(events, ["audio"]);
  preparation.resolve({
    target: 120,
    activate: () => {
      events.push("video-swap");
      return true;
    },
    cancel() {},
  });
  assert.equal(await completion, "activated");
  assert.deepEqual(events, ["audio", "video-swap", "video-sync"]);
});

test("a stale decoded frame cannot overwrite the latest seek", async () => {
  const events: string[] = [];
  let current = true;
  const preparation = deferred<PreparedLocalVideoSeek | null>();
  const completion = coordinateLocalVideoSeek(() => preparation.promise, {
    commitAudio: () => events.push("audio"),
    publishVideoSeek: () => events.push("video-sync"),
    isCurrent: () => current,
  });
  current = false;
  preparation.resolve({
    target: 90,
    activate: () => {
      events.push("stale-swap");
      return true;
    },
    cancel: () => events.push("cancel"),
  });

  assert.equal(await completion, "stale");
  // The request became stale before video preparation began, so there is no decoded handle to
  // cancel and, importantly, no stale swap or video-sync publication.
  assert.deepEqual(events, ["audio"]);
});

test("video preparation failure falls back without issuing audio seek twice", async () => {
  const events: string[] = [];
  const result = await coordinateLocalVideoSeek(() => Promise.resolve(null), {
    commitAudio: () => events.push("audio"),
    publishVideoSeek: () => events.push("video-sync"),
    isCurrent: () => true,
  });

  assert.equal(result, "fallback");
  assert.deepEqual(events, ["audio", "video-sync"]);
});

test("direct-click video decode does not start until the audio-first gate releases", async () => {
  const events: string[] = [];
  const audio = deferred<void>();
  const completion = coordinateLocalVideoSeek(
    () => {
      events.push("video-decode");
      return Promise.resolve(null);
    },
    {
      commitAudio: () => {
        events.push("audio-command");
        return audio.promise;
      },
      publishVideoSeek: () => events.push("video-sync"),
      isCurrent: () => true,
    },
  );

  await Promise.resolve();
  assert.deepEqual(events, ["audio-command"]);
  audio.resolve();
  assert.equal(await completion, "fallback");
  assert.deepEqual(events, ["audio-command", "video-decode", "video-sync"]);
});
