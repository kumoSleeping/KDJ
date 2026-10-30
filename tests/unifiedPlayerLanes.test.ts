import assert from "node:assert/strict";
import test from "node:test";

test("desktop player lanes: volume never waits for a Load ACK, and a seek only waits for the Load", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
  type Call = { command: string; args: { commandId?: number; command?: { type: string; volume?: number; trackId?: number; position?: number } }; resolve(value: unknown): void };
  const calls: Call[] = [];
  let sequence = 0;
  const snapshot = (lastCommandId: number, trackId: number | null = null) => ({
    sequence: ++sequence, lastCommandId, phase: trackId === null ? "idle" : "loading", trackId, preparedTrackId: null,
    title: "", artist: "", album: "", artworkUrl: null, currentTime: 0, duration: 0, desiredPlaying: false,
    isPlaying: false, buffering: trackId !== null, transitioning: false, rate: 1, volume: 1, error: "",
    decks: [0, 1].map(() => ({ trackId: null, currentTime: 0, duration: 0, desiredPlaying: false, isPlaying: false, rate: 1, buffering: false })),
  });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLMediaElement: dom.window.HTMLMediaElement });
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  Object.assign(dom.window, {
    kdj: { platform: "darwin", baseUrl: "http://localhost", authToken: "test-only" },
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: (command: string, args: Call["args"]) => {
        if (command === "plugin:event|listen") return Promise.resolve(1);
        if (command === "playback_initialize") return Promise.resolve(snapshot(0));
        return new Promise((resolve) => calls.push({ command, args, resolve }));
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  });
  const { runtimePlayer } = await import("../src/lib/unifiedPlayer");
  const player = runtimePlayer();
  assert.equal(player.kind, "desktop-native");
  await player.initialize();
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const track = { id: 7, path: "/music/7.flac", title: "七", filename: "7.flac", duration: 180 } as never;

  const loaded = player.load({ src: "", track, intentId: 1, autoplay: true });
  await tick();
  assert.deepEqual(calls.map((call) => [call.command, call.args.command?.type]), [["playback_command", "load"]]);
  const load = calls[0];

  // The Load ACK is still outstanding (a slow open, a busy coordinator).
  void player.setVolume(0.5).catch(() => undefined);
  await tick();
  assert.deepEqual([calls[1]?.command, calls[1]?.args.command], ["playback_control", { type: "setVolume", volume: 0.5 }],
    "the gain goes out at once on the control lane");
  // A drag keeps one gain in flight and only the latest value behind it.
  void player.setVolume(0.4).catch(() => undefined);
  void player.setVolume(0.3).catch(() => undefined);
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve({ acceptedSequence: 1 });
  await tick();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args.command, { type: "setVolume", volume: 0.3 });
  calls[2].resolve({ acceptedSequence: 2 });
  // The EQ / FILTER knobs are the same kind of control: not queued behind the Load either.
  const strip = (filter: number) => ({ channelGain: 1, trimDb: 0, lowDb: 0, midDb: 0, highDb: 0, filter });
  void player.setDeckMixer(0, strip(0.1)).catch(() => undefined);
  await tick();
  assert.deepEqual([calls[3]?.command, calls[3]?.args.command], ["playback_control", { type: "setDeckMixer", deck: 0, ...strip(0.1) }],
    "a knob goes out at once on the control lane");
  void player.setDeckMixer(0, strip(0.2)).catch(() => undefined);
  void player.setDeckMixer(0, strip(0.3)).catch(() => undefined);
  await tick();
  assert.equal(calls.length, 4);
  calls[3].resolve({ acceptedSequence: 2 });
  await tick();
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[4].args.command, { type: "setDeckMixer", deck: 0, ...strip(0.3) }, "only the latest turn follows");
  calls[4].resolve({ acceptedSequence: 2 });
  calls.splice(3, 2);

  load.resolve({ commandId: load.args.commandId, acceptedSequence: 3, snapshot: snapshot(load.args.commandId!, 7) });
  assert.equal((await loaded).trackId, 7);

  // A seek names its song and travels on the control lane: it follows a Load that is on its
  // way, but not the queue, prewarm and beat-grid commands a track change leaves behind it.
  const other = { id: 8, path: "/music/8.flac", title: "八", filename: "8.flac", duration: 200 } as never;
  const reloaded = player.load({ src: "", track: other, intentId: 2, autoplay: true });
  void player.setQueue([]).catch(() => undefined);
  const sought = player.seek(42);
  await tick();
  const second = calls.at(-1)!;
  assert.deepEqual([calls.length, second.args.command?.type], [4, "load"], "nothing overtakes the pending Load");
  second.resolve({ commandId: second.args.commandId, acceptedSequence: 4, snapshot: snapshot(second.args.commandId!, 8) });
  assert.equal((await reloaded).trackId, 8);
  await tick();
  const seek = calls.find((call) => call.args.command?.type === "seekTrack")!;
  assert.ok(seek, "the seek went out without waiting for the queue command's acknowledgement");
  assert.equal(seek.command, "playback_control");
  // It still names the song it was aimed at; the coordinator ignores it now that song 8 is current.
  assert.deepEqual(seek.args.command, { type: "seekTrack", trackId: 7, position: 42 });
  assert.equal(seek.args.commandId, undefined, "it reserves no command id, so it cannot fence out the queue command");
  seek.resolve({ acceptedSequence: 5 });
  assert.equal((await sought).trackId, 8);
});
