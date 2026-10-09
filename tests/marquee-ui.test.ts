import assert from "node:assert/strict";
import test from "node:test";

interface StartedAnimation {
  target: HTMLElement;
  keyframes: Array<{ offset: number; transform: string }>;
  timing: { duration: number; iterations: number; delay: number };
  state: "running" | "paused" | "cancelled";
}

test("shared marquee measures overflow, starts promptly at a constant speed and resets for new text", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  let width = 100;
  let reducedMotion = false;
  /** A surface that is still arriving around the text, as `document.getAnimations()` reports it. */
  let arriving: Array<{ playState: string; currentTime: number; effect: { target: Element; getComputedTiming(): { endTime: number } } }> = [];
  const observers = new Set<() => void>();
  const started: StartedAnimation[] = [];
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get: () => width });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", {
    get() { return (this.textContent?.length ?? 0) * 10; },
  });
  dom.window.HTMLElement.prototype.animate = function (keyframes: unknown, timing: unknown) {
    const animation: StartedAnimation = {
      target: this, keyframes: keyframes as StartedAnimation["keyframes"], timing: timing as StartedAnimation["timing"], state: "running",
    };
    started.push(animation);
    return {
      pause() { animation.state = "paused"; },
      play() { animation.state = "running"; },
      cancel() { animation.state = "cancelled"; },
    } as unknown as Animation;
  };
  Object.assign(dom.window, {
    matchMedia: () => ({ get matches() { return reducedMotion; }, addEventListener() {}, removeEventListener() {} }),
  });
  Object.assign(dom.window.document, { getAnimations: () => arriving });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    ResizeObserver: class {
      constructor(private callback: () => void) {}
      observe() { observers.add(this.callback); }
      disconnect() { observers.delete(this.callback); }
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const {
    MarqueeText, marqueeCycle, MARQUEE_END_HOLD_MS, MARQUEE_LEAD_MS, MARQUEE_REST_MS, MARQUEE_SPEED,
  } = await import("../src/components/common/MarqueeText");
  const root = createRoot(document.getElementById("root")!);
  const render = async (text: string) => act(async () => {
    root.render(createElement(MarqueeText, { className: "vj-task-timing", text }));
  });
  const live = () => started.filter(animation => animation.state !== "cancelled");
  /** Time from the start of the animation until the text first moves. */
  const firstMove = (animation: StartedAnimation) =>
    animation.timing.delay + animation.keyframes[1].offset * animation.timing.duration;
  const near = (actual: number, expected: number, slack: number, message: string) =>
    assert.ok(Math.abs(actual - expected) <= slack, `${message}: ${actual} ≈ ${expected}`);
  try {
    await render("Offset +0.000 s");
    const box = document.querySelector<HTMLElement>(".kd-marquee-viewport")!;
    assert.equal(box.dataset.marquee, "true");
    assert.equal(box.title, "Offset +0.000 s");
    assert.equal(live().length, 1, "one scroll per text");
    const first = live()[0];
    assert.equal(first.target, box.firstElementChild);
    assert.equal(first.timing.iterations, Infinity);
    assert.deepEqual(first.keyframes.map(frame => frame.transform),
      ["translateX(0px)", "translateX(0px)", "translateX(-50px)", "translateX(-50px)", "translateX(0px)"]);
    near(firstMove(first), MARQUEE_LEAD_MS, 20, "the first pass begins after the short lead");

    // The pauses are fixed; only the two travels grow with the overflow, at one speed.
    for (const overflow of [120, 200, 570]) {
      const cycle = marqueeCycle(overflow);
      const travel = (overflow / MARQUEE_SPEED) * 1000;
      near(cycle.leave * cycle.duration, MARQUEE_REST_MS, 1e-6, `rest at the start (${overflow}px)`);
      near((cycle.arrive - cycle.leave) * cycle.duration, travel, 1e-6, `travel out (${overflow}px)`);
      near((cycle.turn - cycle.arrive) * cycle.duration, MARQUEE_END_HOLD_MS, 1e-6, `pause at the far end (${overflow}px)`);
      near((1 - cycle.turn) * cycle.duration, travel, 1e-6, `travel back (${overflow}px)`);
    }
    // 曲目信息 is up for 5 s and takes 460 ms to rise: a moderate overflow is read in full.
    assert.ok(460 + MARQUEE_LEAD_MS + (190 / MARQUEE_SPEED) * 1000 <= 5000);
    assert.ok(marqueeCycle(3).arrive - marqueeCycle(3).leave > 0, "a tiny overflow still has a travel");
    assert.ok((marqueeCycle(3).arrive - marqueeCycle(3).leave) * marqueeCycle(3).duration >= 500, "and it is not a twitch");

    box.dispatchEvent(new dom.window.Event("pointerenter"));
    assert.equal(first.state, "paused", "the pointer resting on the text holds it");
    box.dispatchEvent(new dom.window.Event("pointerleave"));
    assert.equal(first.state, "running");

    await act(async () => { width = 200; observers.forEach(measure => measure()); });
    assert.equal(box.dataset.marquee, undefined, "wide panels stop scrolling");
    assert.equal(live().length, 0, "and the scroll is cancelled");
    await act(async () => { width = 100; observers.forEach(measure => measure()); });
    assert.equal(box.dataset.marquee, "true");
    assert.equal(live().length, 1);

    const oldText = box.firstElementChild;
    await render("Short");
    assert.equal(box.dataset.marquee, undefined, "short text stays still");
    assert.notEqual(box.firstElementChild, oldText, "new text restarts the animation at the beginning");
    assert.equal(observers.size, 1, "text changes replace the observer");
    assert.equal(live().length, 0);

    // Text that arrives with its surface waits for the surface to settle, then the lead.
    const surface = document.getElementById("root")!;
    arriving = [
      { playState: "running", currentTime: 60, effect: { target: surface, getComputedTiming: () => ({ endTime: 460 }) } },
      // Neither an endless animation nor one on an unrelated element is an arrival.
      { playState: "running", currentTime: 0, effect: { target: surface, getComputedTiming: () => ({ endTime: Infinity }) } },
      { playState: "running", currentTime: 0, effect: { target: document.createElement("i"), getComputedTiming: () => ({ endTime: 900 }) } },
    ];
    await render("A title that is far too long");
    assert.equal(live().length, 1);
    near(firstMove(live()[0]), 400 + MARQUEE_LEAD_MS, 20, "the first pass waits for the arrival");
    arriving = [];

    reducedMotion = true;
    await render("Another title that is too long");
    assert.equal(box.dataset.marquee, "true", "still clipped as overflowing text");
    assert.equal(live().length, 0, "reduced motion keeps the text still");
    reducedMotion = false;
  } finally {
    await act(async () => root.unmount());
    assert.equal(observers.size, 0, "unmount releases the observer");
    assert.equal(live().length, 0, "unmount cancels the scroll");
    dom.window.close();
  }
});
