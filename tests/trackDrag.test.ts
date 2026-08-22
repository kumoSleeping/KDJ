import assert from "node:assert/strict";
import test from "node:test";
import {
  lockTrackPointerDragScroll,
  trackDeckSideForPoint,
  type TrackDeckDropRegion,
} from "../src/lib/trackDrag";

const regions: TrackDeckDropRegion[] = [
  { side: "0", left: 0, right: 500, top: 600, bottom: 700 },
  { side: "1", left: 500, right: 1000, top: 700, bottom: 800 },
  { side: "bad", left: 0, right: 1000, top: 0, bottom: 1000 },
  { side: "split", left: 0, right: 1000, top: 800, bottom: 900 },
];

test("bottom performance wave rectangles resolve to the intended A/B Deck", () => {
  assert.equal(trackDeckSideForPoint(regions, 250, 650), 0);
  assert.equal(trackDeckSideForPoint(regions, 750, 750), 1);
  assert.equal(trackDeckSideForPoint(regions, 250, 550), null);
});

test("a split bottom target resolves its left and right halves to Deck A/B", () => {
  assert.equal(trackDeckSideForPoint(regions, 250, 850), 0);
  assert.equal(trackDeckSideForPoint(regions, 750, 850), 1);
});

test("pointer drag scroll lock restores the source list and releases its overflow", () => {
  const listeners = new Map<string, EventListener>();
  const target = {
    scrollTop: 120,
    scrollLeft: 18,
    style: { overflow: "auto" },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.set(type, listener as EventListener);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
  } as unknown as HTMLElement;

  const release = lockTrackPointerDragScroll(target, 120, 18);
  assert.equal(target.style.overflow, "hidden");
  target.scrollTop = 420;
  target.scrollLeft = 64;
  listeners.get("scroll")?.(new Event("scroll"));
  assert.equal(target.scrollTop, 120);
  assert.equal(target.scrollLeft, 18);

  release();
  assert.equal(target.style.overflow, "auto");
  assert.equal(listeners.has("scroll"), false);
});
