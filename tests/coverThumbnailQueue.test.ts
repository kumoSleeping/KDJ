import assert from "node:assert/strict";
import test from "node:test";
import { acquireCoverThumbnail, coverThumbnailQueueStats } from "../src/lib/coverThumbnailQueue";

test("cancel/reacquire, priority, bounded caches, and retry classification", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; signal: AbortSignal; resolve(value: Response): void; reject(error: Error): void }[] = [];
  globalThis.fetch = ((url, init) => new Promise((resolve, reject) => {
    const signal = init!.signal!;
    const entry = { url: String(url), signal, resolve, reject };
    calls.push(entry);
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const ok = () => new Response(new Blob(["image"]), { status: 200 });
  try {
    const old = acquireCoverThumbnail("same", "/same");
    old.release();
    const fresh = acquireCoverThumbnail("same", "/same");
    const freshResult = fresh.promise;
    await tick();
    assert.equal(calls.length, 2);
    calls[1].resolve(ok());
    assert.ok(await freshResult);
    fresh.release();
    await tick();
    assert.equal(coverThumbnailQueueStats().active, 0);

    const a = acquireCoverThumbnail("a", "/a");
    const b = acquireCoverThumbnail("b", "/b");
    const low = acquireCoverThumbnail("low", "/low", 2);
    const high = acquireCoverThumbnail("high", "/high", 0);
    calls[2].resolve(ok()); await a.promise; await tick();
    assert.equal(calls[4].url, "/high");
    calls[3].resolve(ok()); calls[4].resolve(ok());
    await Promise.all([b.promise, high.promise]); await tick();
    calls[5].resolve(ok()); await low.promise; await tick();
    for (const lease of [a,b,low,high]) lease.release();

    const noArt = acquireCoverThumbnail("none", "/none");
    const missing = assert.rejects(noArt.promise, /404/);
    calls[6].resolve(new Response(null, { status: 404 }));
    await missing; await tick(); noArt.release();
    assert.equal(calls.length, 7, "404 is not retried");

    const transient = acquireCoverThumbnail("retry", "/retry");
    calls[7].resolve(new Response(null, { status: 503 }));
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(calls.length, 9);
    calls[8].resolve(ok()); await transient.promise; await tick(); transient.release();

    for (let i = 0; i < 140; i++) {
      const lease = acquireCoverThumbnail(`cache-${i}`, `/cache-${i}`);
      calls.at(-1)!.resolve(ok());
      await lease.promise; await tick(); lease.release();
    }
    assert.ok(coverThumbnailQueueStats().cached <= 128);
    assert.equal(coverThumbnailQueueStats().active, 0);
    assert.equal(coverThumbnailQueueStats().queued, 0);
  } finally { globalThis.fetch = original; }
});
