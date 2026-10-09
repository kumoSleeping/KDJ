import assert from "node:assert/strict";
import test from "node:test";
import { attachWheelScroll, wheelPixels } from "../src/lib/wheelScroll";

test("wheel deltas convert line and page modes and Shift turns a vertical wheel sideways", () => {
  assert.deepEqual(wheelPixels({ deltaX: 3, deltaY: -40, deltaMode: 0, shiftKey: false }, 36, 800, 600), { x: 3, y: -40 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false }, 36, 800, 600), { x: 0, y: 108 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: -1, deltaMode: 2, shiftKey: false }, 36, 800, 600), { x: 0, y: -600 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 120, deltaMode: 0, shiftKey: true }, 36, 800, 600), { x: 120, y: 0 });
  assert.deepEqual(wheelPixels({ deltaX: 5, deltaY: 120, deltaMode: 0, shiftKey: true }, 36, 800, 600), { x: 5, y: 120 });
});

test("the page applies wheel scrolling once per frame, before the caller renders", () => {
  const frames: (() => void)[] = [];
  const globals = globalThis as unknown as { requestAnimationFrame: unknown; cancelAnimationFrame: unknown };
  const original = { raf: globals.requestAnimationFrame, cancel: globals.cancelAnimationFrame };
  globals.requestAnimationFrame = (callback: () => void) => frames.push(callback);
  globals.cancelAnimationFrame = (id: number) => { frames[id - 1] = () => {}; };
  try {
    const listeners = new Map<string, (event: unknown) => void>();
    let integerTop = 0;
    const node = {
      scrollLeft: 0, scrollHeight: 10_000, clientHeight: 600, scrollWidth: 1400, clientWidth: 800,
      style: { overflow: "" },
      // WebKit rounds overflow offsets; sub-pixel deltas must still add up.
      get scrollTop() { return integerTop; },
      set scrollTop(value: number) { integerTop = Math.round(value); },
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const seen: number[] = [];
    const detach = attachWheelScroll(node as unknown as HTMLElement, () => 36, () => seen.push(node.scrollTop));
    const wheel = (init: Record<string, unknown>) => {
      const event = { deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, defaultPrevented: false,
        prevented: false, preventDefault() { this.prevented = true; }, ...init };
      listeners.get("wheel")!(event);
      return event.prevented;
    };
    const frame = () => frames.splice(0).forEach((callback) => callback());

    assert.equal(wheel({ deltaY: 30 }), true, "the WebView's own scrolling is cancelled");
    assert.equal(wheel({ deltaY: 50 }), true);
    assert.equal(node.scrollTop, 0, "nothing moves outside an animation frame");
    assert.equal(frames.length, 1, "samples of one frame share a single update");
    frame();
    assert.equal(node.scrollTop, 80);
    assert.deepEqual(seen, [80], "the caller renders after the container moved, in the same frame");

    for (let i = 0; i < 4; i += 1) { wheel({ deltaY: 0.3 }); frame(); }
    assert.equal(node.scrollTop, 81, "sub-pixel deltas accumulate across frames");

    node.scrollTop = 5_000; // a handle drag or a restore moved it
    wheel({ deltaY: 10 }); frame();
    assert.equal(node.scrollTop, 5_010, "the next wheel continues from where the container is");

    wheel({ deltaY: 99_999 }); frame();
    assert.equal(node.scrollTop, 9_400, "clamped to the scrollable range");
    wheel({ deltaX: 40, deltaY: -9 }); frame();
    assert.deepEqual([node.scrollLeft, node.scrollTop], [40, 9_391]);

    assert.equal(wheel({ deltaY: 10, ctrlKey: true }), false, "pinch zoom is left alone");
    node.style.overflow = "hidden";
    assert.equal(wheel({ deltaY: 10 }), false, "a locked container does not move");
    node.style.overflow = "";
    assert.equal(wheel({ deltaY: 10, defaultPrevented: true }), false);
    assert.equal(frames.length, 0);

    wheel({ deltaY: 10 });
    detach();
    frame();
    assert.equal(node.scrollTop, 9_391, "a pending update is dropped on detach");
    assert.equal(listeners.size, 0);
  } finally {
    globals.requestAnimationFrame = original.raf;
    globals.cancelAnimationFrame = original.cancel;
  }
});
