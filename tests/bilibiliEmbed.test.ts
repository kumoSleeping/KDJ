import assert from "node:assert/strict";
import test from "node:test";
import type { KdjBridge } from "../src/types";

interface Calls {
  open: Array<{ bvid: string; page: number }>;
  controls: string[];
  close: number;
}

function installBridge(): Calls {
  const calls: Calls = { open: [], controls: [], close: 0 };
  const events = new EventTarget();
  const bilibiliEmbed: NonNullable<KdjBridge["bilibiliEmbed"]> = {
    open: async ({ bvid, page }) => {
      calls.open.push({ bvid, page });
    },
    setBounds: async () => undefined,
    status: async () => ({
      ready: true,
      playing: false,
      buffering: false,
      ended: false,
      position: 0,
      duration: 212,
      hasError: false,
    }),
    control: async (_bvid, _page, action) => {
      calls.controls.push(action);
    },
    close: async () => {
      calls.close += 1;
    },
  };
  const bridge = {
    bilibiliEmbed,
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

test("official Bilibili controller preserves bvid and zero-based page", async () => {
  const calls = installBridge();
  const { BilibiliEmbedController } = await import("../src/lib/bilibiliEmbed");
  const controller = new BilibiliEmbedController({
    bvid: "BV1xx411c7mD",
    page: 2,
    muted: false,
    bounds: { x: 10, y: 20, width: 640, height: 360 },
    onStatus: () => undefined,
    onError: (error) => assert.fail(error.message),
  });
  await controller.done;
  await controller.play();
  await controller.seek(42);
  controller.dispose();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls.open, [{ bvid: "BV1xx411c7mD", page: 2 }]);
  assert.deepEqual(calls.controls, ["play", "seek"]);
  assert.equal(calls.close, 1);
});
