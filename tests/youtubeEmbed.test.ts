import assert from "node:assert/strict";
import test from "node:test";
import type { KdjBridge } from "../src/types";

interface Calls {
  open: number;
  status: number;
  controls: string[];
  close: number;
}

function installBridge(options: { failOpen?: boolean } = {}): Calls {
  const calls: Calls = { open: 0, status: 0, controls: [], close: 0 };
  const events = new EventTarget();
  const youtubeEmbed: NonNullable<KdjBridge["youtubeEmbed"]> = {
    prewarm: async () => undefined,
    open: async () => {
      calls.open += 1;
      if (options.failOpen) throw new Error("official navigation failed");
    },
    setBounds: async () => undefined,
    status: async () => {
      calls.status += 1;
      return {
        ready: true,
        playing: false,
        buffering: false,
        ended: false,
        position: 0,
        duration: 212,
        hasError: false,
      };
    },
    control: async (_videoId, action) => {
      calls.controls.push(action);
    },
    close: async () => {
      calls.close += 1;
    },
  };
  const bridge = {
    youtubeEmbed,
    baseUrl: "http://127.0.0.1:43123",
    authToken: "test-control-token",
    mediaToken: "test-media-token",
    platform: "darwin",
  } as unknown as KdjBridge;
  Object.assign(globalThis, {
    window: Object.assign(events, {
      kdj: bridge,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    }),
    document: {
      baseURI: "http://127.0.0.1/",
      createElement: () => ({ preload: "", crossOrigin: "" }),
      documentElement: { dataset: {} },
      querySelectorAll: () => [],
    },
  });
  return calls;
}

test("official YouTube controller opens one isolated path and sends one play", async () => {
  const calls = installBridge();
  const { YoutubeEmbedController } = await import("../src/lib/youtubeEmbed");
  const statuses: number[] = [];
  const controller = new YoutubeEmbedController({
    videoId: "dQw4w9WgXcQ",
    muted: false,
    bounds: { x: 10, y: 20, width: 640, height: 360 },
    onStatus: (status) => statuses.push(status.duration),
    onError: (error) => assert.fail(error.message),
  });
  await controller.done;
  await controller.play();
  controller.dispose();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.open, 1);
  assert.equal(calls.status, 1);
  assert.deepEqual(calls.controls, ["play"]);
  assert.deepEqual(statuses, [212]);
  assert.equal(calls.close, 1);
});

test("official YouTube navigation failure is visible and is not retried", async () => {
  const calls = installBridge({ failOpen: true });
  const { YoutubeEmbedController } = await import("../src/lib/youtubeEmbed");
  const controller = new YoutubeEmbedController({
    videoId: "aqz-KE-bpKQ",
    muted: true,
    bounds: { x: 10, y: 20, width: 640, height: 360 },
    onStatus: () => undefined,
    onError: () => undefined,
  });
  await assert.rejects(controller.done, /official navigation failed/);
  controller.dispose();
  assert.equal(calls.open, 1);
  assert.equal(calls.status, 0);
  assert.deepEqual(calls.controls, []);
});
