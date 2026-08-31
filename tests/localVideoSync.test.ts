import assert from "node:assert/strict";
import test from "node:test";
import {
  initialVideoSyncPolicyState,
  LocalVideoSynchronizer,
  planVideoSync,
  VideoSeekEchoGuard,
  VideoTransportEchoGuard,
} from "../src/lib/localVideoSync";

const heartbeat = (target: number, presentedTime: number, baseRate = 1) =>
  planVideoSync(
    {
      kind: "heartbeat",
      target,
      presentedTime,
      baseRate,
      paused: false,
      seeking: false,
      now: 10_000,
    },
    initialVideoSyncPolicyState(),
  );

test("heartbeat leaves small and medium drift at the natural rate", () => {
  assert.deepEqual(heartbeat(10, 9.9).decision, { type: "rate", rate: 1 });
  assert.deepEqual(heartbeat(10.5, 10).decision, { type: "rate", rate: 1 });
  assert.deepEqual(heartbeat(9.5, 10).decision, { type: "rate", rate: 1 });
});

test("heartbeat never seeks even when the observed clocks are far apart", () => {
  assert.deepEqual(heartbeat(30, 10).decision, { type: "rate", rate: 1 });
  assert.deepEqual(heartbeat(10, 30).decision, { type: "rate", rate: 1 });
});

test("heartbeat preserves the authoritative DJ playback rate without correction", () => {
  assert.deepEqual(heartbeat(30, 10, 1.1).decision, { type: "rate", rate: 1.1 });
});

test("explicit user transport seek remains immediate", () => {
  const result = planVideoSync(
    {
      kind: "explicit",
      target: 600,
      presentedTime: 10,
      baseRate: 1,
      paused: true,
      seeking: false,
      now: 10_000,
    },
    initialVideoSyncPolicyState(),
  );
  assert.deepEqual(result.decision, { type: "seek", target: 600, rate: 1 });
});

test("explicit alignment inside the tolerance does not seek", () => {
  const result = planVideoSync(
    {
      kind: "explicit",
      target: 10.03,
      presentedTime: 10,
      baseRate: 1,
      paused: false,
      seeking: false,
      now: 10_000,
    },
    initialVideoSyncPolicyState(),
  );
  assert.deepEqual(result.decision, { type: "rate", rate: 1 });
});

test("repeated 100ms heartbeats do not write playbackRate or currentTime", () => {
  let currentTime = 10;
  let playbackRate = 1;
  let timeWrites = 0;
  let rateWrites = 0;
  const video = {
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      timeWrites += 1;
      currentTime = value;
    },
    get playbackRate() {
      return playbackRate;
    },
    set playbackRate(value: number) {
      rateWrites += 1;
      playbackRate = value;
    },
    paused: false,
    seeking: false,
  } as HTMLVideoElement;
  const synchronizer = new LocalVideoSynchronizer();

  for (let index = 0; index < 100; index += 1) {
    synchronizer.sync(video, 30 + index / 10, "heartbeat", 1, undefined, index * 100);
  }

  assert.equal(timeWrites, 0);
  assert.equal(rateWrites, 0);
});

test("one explicit seek followed by heartbeats writes currentTime exactly once", () => {
  let currentTime = 10;
  let timeWrites = 0;
  const video = {
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      timeWrites += 1;
      currentTime = value;
    },
    playbackRate: 1,
    paused: false,
    seeking: false,
  } as HTMLVideoElement;
  const synchronizer = new LocalVideoSynchronizer();

  synchronizer.sync(video, 600, "explicit", 1, undefined, 10_000);
  for (let index = 1; index <= 100; index += 1) {
    synchronizer.sync(video, 600 + index / 10, "heartbeat", 1, undefined, 10_000 + index * 100);
  }

  assert.equal(timeWrites, 1);
  assert.equal(currentTime, 600);
});

test("player-driven video seek is consumed instead of being echoed back to audio", () => {
  const video = {} as HTMLVideoElement;
  const guard = new VideoSeekEchoGuard();

  guard.mark(video, 120, 1_000);

  assert.equal(guard.consume(video, 120.2, 1_100), true);
  assert.equal(guard.consume(video, 120.2, 1_101), false);
});

test("a native video-control seek remains distinguishable from a pending alignment", () => {
  const video = {} as HTMLVideoElement;
  const guard = new VideoSeekEchoGuard();

  guard.mark(video, 30, 1_000);

  assert.equal(guard.consume(video, 180, 1_100), false);
  assert.equal(guard.consume(video, 30, 1_101), true);
});

test("expired or different-element video seeks are not treated as player echoes", () => {
  const first = {} as HTMLVideoElement;
  const second = {} as HTMLVideoElement;
  const guard = new VideoSeekEchoGuard();

  guard.mark(first, 45, 1_000);

  assert.equal(guard.consume(second, 45, 1_100), false);
  assert.equal(guard.consume(first, 45, 3_001), false);
});

test("standby play/pause tails stay tagged after that video becomes active", () => {
  const standby = {} as HTMLVideoElement;
  const guard = new VideoTransportEchoGuard();

  guard.mark(standby, "play", 1_000);
  guard.mark(standby, "pause", 1_001);

  // WebKit may deliver these in either order around the ownership swap.
  assert.equal(guard.consume(standby, "pause", 1_100), true);
  assert.equal(guard.consume(standby, "play", 1_101), true);
  assert.equal(guard.consume(standby, "pause", 1_102), false);
});

test("transport echo tags are exact, cancellable, and expire", () => {
  const first = {} as HTMLVideoElement;
  const second = {} as HTMLVideoElement;
  const guard = new VideoTransportEchoGuard();

  const rejectedPlay = guard.mark(first, "play", 1_000);
  guard.cancel(rejectedPlay);
  guard.mark(first, "pause", 1_000);

  assert.equal(guard.consume(first, "play", 1_100), false);
  assert.equal(guard.consume(second, "pause", 1_100), false);
  assert.equal(guard.consume(first, "pause", 3_001), false);
});
