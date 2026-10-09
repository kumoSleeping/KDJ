import assert from "node:assert/strict";
import test from "node:test";
import { acquireCoverThumbnail, coverThumbnailQueueStats, peekCoverThumbnail } from "../src/lib/coverThumbnailQueue";

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

    const base = calls.length;
    const running = ["a", "b", "c", "d"].map((key) => acquireCoverThumbnail(key, `/${key}`));
    const low = acquireCoverThumbnail("low", "/low", 2);
    const high = acquireCoverThumbnail("high", "/high", 0);
    assert.equal(calls.length, base + 4, "four covers load at once; the rest queue");
    calls[base].resolve(ok()); await running[0].promise; await tick();
    assert.equal(calls[base + 4].url, "/high");
    for (const call of calls.slice(base + 1, base + 5)) call.resolve(ok());
    await Promise.all([...running.map((lease) => lease.promise), high.promise]); await tick();
    calls[base + 5].resolve(ok()); await low.promise; await tick();
    for (const lease of [...running, low, high]) lease.release();

    const noArt = acquireCoverThumbnail("none", "/none");
    const missing = assert.rejects(noArt.promise, /404/);
    calls.at(-1)!.resolve(new Response(null, { status: 404 }));
    await missing; await tick(); noArt.release();
    assert.equal(calls.length, base + 7, "404 is not retried");
    assert.deepEqual(peekCoverThumbnail("none"), { src: "", missing: true }, "a remount can paint the placeholder at once");
    assert.deepEqual(peekCoverThumbnail("never-asked"), { src: "", missing: false });
    const added = acquireCoverThumbnail("none", "/none");
    assert.equal(calls.length, base + 8, "a known absence is still asked again");
    calls.at(-1)!.resolve(ok());
    const addedUrl = await added.promise; await tick();
    assert.deepEqual(peekCoverThumbnail("none"), { src: addedUrl, missing: false }, "a remount paints the cached cover in its first frame");
    added.release();

    const transient = acquireCoverThumbnail("retry", "/retry");
    calls.at(-1)!.resolve(new Response(null, { status: 503 }));
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(calls.length, base + 10);
    assert.equal(peekCoverThumbnail("retry").missing, false, "a server error says nothing about the cover");
    calls.at(-1)!.resolve(ok()); await transient.promise; await tick(); transient.release();

    for (let i = 0; i < 530; i++) {
      const lease = acquireCoverThumbnail(`cache-${i}`, `/cache-${i}`);
      calls.at(-1)!.resolve(ok());
      await lease.promise; await tick(); lease.release();
    }
    assert.ok(coverThumbnailQueueStats().cached <= 512);
    assert.equal(coverThumbnailQueueStats().active, 0);
    assert.equal(coverThumbnailQueueStats().queued, 0);
  } finally { globalThis.fetch = original; }
});
