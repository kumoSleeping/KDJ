import assert from "node:assert/strict";
import test from "node:test";
import { DeferredStorageWriter, type KeyValueStorage } from "../src/lib/storageWrite";

class MemoryStorage implements KeyValueStorage {
  values = new Map<string, string>();
  writes: Array<[string, string]> = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
    this.writes.push([key, value]);
  }
}

function harness() {
  const storage = new MemoryStorage();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const writer = new DeferredStorageWriter(
    storage,
    (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    (id) => {
      timers.delete(id);
    },
  );
  return { storage, timers, writer };
}

test("continuous updates collapse to the newest value in one write window", () => {
  const { storage, timers, writer } = harness();
  writer.writeSoon("clock", "1");
  writer.writeSoon("clock", "2");
  writer.writeSoon("clock", "3");

  assert.equal(timers.size, 1);
  assert.deepEqual(storage.writes, []);
  [...timers.values()][0]?.();
  assert.deepEqual(storage.writes, [["clock", "3"]]);
});

test("unchanged values never write and exit flush keeps the latest value", () => {
  const { storage, writer } = harness();
  storage.values.set("volume", "0.8");
  writer.writeSoon("volume", "0.8");
  assert.deepEqual(storage.writes, []);

  writer.writeSoon("volume", "0.7");
  writer.writeSoon("volume", "0.6");
  writer.flushAll();
  assert.deepEqual(storage.writes, [["volume", "0.6"]]);
});
