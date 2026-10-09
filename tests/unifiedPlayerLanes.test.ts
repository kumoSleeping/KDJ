import assert from "node:assert/strict";
import test from "node:test";

test("desktop player lanes: volume never waits for a Load ACK, and a superseded seek is reported", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
  type Call = { command: string; args: { commandId?: number; command?: { type: string; volume?: number } }; resolve(value: unknown): void };
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

  // Ordered transport still waits for the Load, so it cannot overtake it.
  const sought = player.seek(42);
  await tick();
  assert.equal(calls.length, 3, "a seek stays behind the pending Load");
  load.resolve({ commandId: load.args.commandId, acceptedSequence: 3, snapshot: snapshot(load.args.commandId!, 7) });
  assert.equal((await loaded).trackId, 7);
  await tick();
  const seek = calls[3];
  assert.equal(seek.args.command?.type, "seek");
  assert.ok(seek.args.commandId! > load.args.commandId!);
  // Rust acknowledged it without applying it: a newer command had already been accepted.
  seek.resolve({ commandId: seek.args.commandId, acceptedSequence: 4, snapshot: snapshot(seek.args.commandId! + 1, 7) });
  await assert.rejects(sought, /取代/);

  const applied = player.seek(43);
  await tick();
  const second = calls[4];
  second.resolve({ commandId: second.args.commandId, acceptedSequence: 5, snapshot: snapshot(second.args.commandId!, 7) });
  assert.equal((await applied).trackId, 7);
});
