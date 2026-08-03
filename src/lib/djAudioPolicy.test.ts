import assert from "node:assert/strict";
import test from "node:test";
import {
  audioContextOptionsForPlatform,
  effectOutputRoute,
  setEffectOutputActive,
  syncOptionalEffectOutputs,
} from "./djAudioPolicy";

test("Android streaming requests a playback-sized AudioContext buffer", () => {
  assert.deepEqual(audioContextOptionsForPlatform("android"), { latencyHint: "playback" });
  assert.equal(audioContextOptionsForPlatform("darwin"), undefined);
  assert.equal(audioContextOptionsForPlatform("win32"), undefined);
});

test("optional effect output is connected only while active and toggles idempotently", () => {
  const calls: string[] = [];
  const output = {
    connect(destination: string) {
      calls.push(`connect:${destination}`);
    },
    disconnect(destination: string) {
      calls.push(`disconnect:${destination}`);
    },
  };
  const route = effectOutputRoute(output, "limiter");

  setEffectOutputActive(route, false);
  setEffectOutputActive(route, true);
  setEffectOutputActive(route, true);
  setEffectOutputActive(route, false);
  setEffectOutputActive(route, false);
  setEffectOutputActive(route, true);

  assert.deepEqual(calls, ["connect:limiter", "disconnect:limiter", "connect:limiter"]);
  assert.equal(route.connected, true);
});

test("effect selection disconnects stale branches instead of merely muting them", () => {
  const calls: string[] = [];
  const port = (name: string) => ({
    connect() {
      calls.push(`connect:${name}`);
    },
    disconnect() {
      calls.push(`disconnect:${name}`);
    },
  });
  const routes = {
    echo: effectOutputRoute(port("echo"), "limiter"),
    hydrant: effectOutputRoute(port("hydrant"), "limiter"),
  };

  syncOptionalEffectOutputs(routes, []);
  syncOptionalEffectOutputs(routes, ["echo"]);
  syncOptionalEffectOutputs(routes, ["hydrant"]);
  syncOptionalEffectOutputs(routes, []);

  assert.deepEqual(calls, [
    "connect:echo",
    "disconnect:echo",
    "connect:hydrant",
    "disconnect:hydrant",
  ]);
  assert.equal(routes.echo.connected, false);
  assert.equal(routes.hydrant.connected, false);
});
