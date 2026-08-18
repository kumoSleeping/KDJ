import assert from "node:assert/strict";
import test from "node:test";

import {
  LatestTempoCommandLane,
  type TempoLaneClock,
} from "../src/lib/tempoCommandLane.ts";

class FakeClock implements TempoLaneClock {
  private time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.time = timer.at;
      timer.callback();
    }
    this.time = target;
  }
}

test("tempo lane sends one immediate value and collapses a pointer burst to its latest value", () => {
  const clock = new FakeClock();
  const sent: number[] = [];
  const lane = new LatestTempoCommandLane((rate) => sent.push(rate), 33, clock);

  lane.submit(1.001);
  lane.submit(1.012);
  lane.submit(1.028);
  assert.deepEqual(sent, [1.001], "only the first fader sample enters IPC immediately");

  clock.advance(32);
  assert.deepEqual(sent, [1.001]);
  clock.advance(1);
  assert.deepEqual(sent, [1.001, 1.028], "the trailing dispatch keeps only the latest rate");
});

test("pointer-up flushes the final tempo and a deck replacement cancels stale trailing work", () => {
  const clock = new FakeClock();
  const sent: number[] = [];
  const lane = new LatestTempoCommandLane((rate) => sent.push(rate), 33, clock);

  lane.submit(0.99);
  lane.submit(0.98);
  lane.flush();
  assert.deepEqual(sent, [0.99, 0.98]);

  lane.submit(1.02);
  lane.cancel();
  clock.advance(100);
  assert.deepEqual(sent, [0.99, 0.98], "a new Deck never receives the old gesture's final rate");
});
