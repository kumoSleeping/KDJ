import assert from "node:assert/strict";
import test from "node:test";

function installBrowserStubs(): void {
  const events = new EventTarget();
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    window: Object.assign(events, {
      kdj: {
        baseUrl: "http://127.0.0.1:43123",
        authToken: "test-token",
        mediaToken: "test-media-token",
        platform: "darwin",
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    }),
    document: {
      baseURI: "http://127.0.0.1/",
      createElement: () => ({
        preload: "",
        crossOrigin: "",
        preservesPitch: true,
        webkitPreservesPitch: true,
      }),
      documentElement: { dataset: {} },
      querySelectorAll: () => [],
    },
  });
}

test("only live-playback waveform deferral is silently retryable", async () => {
  installBrowserStubs();
  const {
    deferredOverviewRetryDelay,
    isPlaybackDeferredWaveformError,
  } = await import("../src/lib/waveformCache");
  assert.equal(
    isPlaybackDeferredWaveformError(new Error("播放已开始，整曲波形生成已延后")),
    true,
  );
  assert.equal(
    isPlaybackDeferredWaveformError(new Error("波形二进制响应不完整")),
    false,
  );
  assert.equal(isPlaybackDeferredWaveformError(null), false);
  assert.deepEqual(
    [-1, 0, 1, 2, 3, 8].map(deferredOverviewRetryDelay),
    [500, 500, 1_000, 2_000, 4_000, 4_000],
  );
});

interface PendingFetch {
  url: string;
  signal: AbortSignal | null;
  resolve: (response: Response) => void;
}

function jsonWaveform(trackId: number): Response {
  const columns = 4_096;
  return new Response(JSON.stringify({
    track_id: trackId,
    duration: 180,
    amp: Array(columns).fill(0.5),
    r: Array(columns).fill(120),
    g: Array(columns).fill(80),
    b: Array(columns).fill(180),
  }), { headers: { "Content-Type": "application/json" } });
}

function pendingFetchHarness(): {
  requests: PendingFetch[];
  fetch: typeof fetch;
} {
  const requests: PendingFetch[] = [];
  const mocked = ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? null;
      const pending = { url: String(input), signal, resolve };
      requests.push(pending);
      signal?.addEventListener("abort", () => {
        reject(new DOMException("This operation was aborted", "AbortError"));
      }, { once: true });
    })) as typeof fetch;
  return { requests, fetch: mocked };
}

test("a newer PlayerBar track aborts stale work, including a switch to a JS-cached track", async () => {
  installBrowserStubs();
  const originalFetch = globalThis.fetch;
  const harness = pendingFetchHarness();
  globalThis.fetch = harness.fetch;
  try {
    const {
      isSupersededWaveformError,
      loadReleaseOverviewById,
    } = await import("../src/lib/waveformCache");

    const first = loadReleaseOverviewById(91_001, "player").catch((error) => error);
    const second = loadReleaseOverviewById(91_002, "player");
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.requests[0]?.signal?.aborted, true);
    assert.match(harness.requests[1]?.url ?? "", /intent=player/);
    harness.requests[1]?.resolve(jsonWaveform(91_002));
    assert.equal((await second).track_id, 91_002);
    assert.equal(isSupersededWaveformError(await first), true);

    const stale = loadReleaseOverviewById(91_003, "player").catch((error) => error);
    const cached = loadReleaseOverviewById(91_002, "player");
    assert.equal((await cached).track_id, 91_002);
    assert.equal(harness.requests[2]?.signal?.aborted, true);
    assert.match(harness.requests[3]?.url ?? "", /intent_only=true/);
    harness.requests[3]?.resolve(new Response(null, { status: 204 }));
    assert.equal(isSupersededWaveformError(await stale), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("predicted-track prefetch is latest-wins and yields to a visible request", async () => {
  installBrowserStubs();
  const originalFetch = globalThis.fetch;
  const harness = pendingFetchHarness();
  globalThis.fetch = harness.fetch;
  try {
    const { loadReleaseOverviewById } = await import("../src/lib/waveformCache");
    const oldPrefetch = loadReleaseOverviewById(92_001, "prefetch").catch(() => null);
    const nextPrefetch = loadReleaseOverviewById(92_002, "prefetch").catch(() => null);
    assert.equal(harness.requests[0]?.signal?.aborted, true);

    const visible = loadReleaseOverviewById(92_002, "visible");
    assert.equal(harness.requests[1]?.signal?.aborted, true);
    assert.match(harness.requests[2]?.url ?? "", /intent=visible/);
    harness.requests[2]?.resolve(jsonWaveform(92_002));
    assert.equal((await visible).track_id, 92_002);
    await Promise.all([oldPrefetch, nextPrefetch]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a rapid A-B-A switch starts a fresh request instead of reusing the aborted A promise", async () => {
  installBrowserStubs();
  const originalFetch = globalThis.fetch;
  const harness = pendingFetchHarness();
  globalThis.fetch = harness.fetch;
  try {
    const { loadReleaseOverviewById } = await import("../src/lib/waveformCache");
    const firstA = loadReleaseOverviewById(93_001, "player").catch(() => null);
    const trackB = loadReleaseOverviewById(93_002, "player").catch(() => null);
    const secondA = loadReleaseOverviewById(93_001, "player");
    assert.equal(harness.requests.length, 3);
    assert.equal(harness.requests[0]?.signal?.aborted, true);
    assert.equal(harness.requests[1]?.signal?.aborted, true);
    assert.equal(harness.requests[2]?.signal?.aborted, false);
    harness.requests[2]?.resolve(jsonWaveform(93_001));
    assert.equal((await secondA).track_id, 93_001);
    await Promise.all([firstA, trackB]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PlayerBar promotes a same-track secondary request without aborting its visible consumer", async () => {
  installBrowserStubs();
  const originalFetch = globalThis.fetch;
  const harness = pendingFetchHarness();
  globalThis.fetch = harness.fetch;
  try {
    const { loadReleaseOverviewById } = await import("../src/lib/waveformCache");
    const secondary = loadReleaseOverviewById(94_001, "visible");
    const player = loadReleaseOverviewById(94_001, "player");
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.requests[0]?.signal?.aborted, false);
    assert.match(harness.requests[1]?.url ?? "", /intent=player/);
    harness.requests[1]?.resolve(jsonWaveform(94_001));
    harness.requests[0]?.resolve(jsonWaveform(94_001));
    assert.equal((await player).track_id, 94_001);
    assert.equal((await secondary).track_id, 94_001);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a competing PlayerBar success notifies detail consumers after their request fails", async () => {
  installBrowserStubs();
  const originalFetch = globalThis.fetch;
  const harness = pendingFetchHarness();
  globalThis.fetch = harness.fetch;
  try {
    const {
      cachedReleaseOverviewWaveform,
      loadReleaseOverviewById,
      subscribeReleaseOverviewWaveform,
    } = await import("../src/lib/waveformCache");
    const trackId = 95_001;
    let readyNotifications = 0;
    const unsubscribe = subscribeReleaseOverviewWaveform(trackId, () => {
      if (cachedReleaseOverviewWaveform(trackId)) readyNotifications += 1;
    });

    const detail = loadReleaseOverviewById(trackId, "visible").catch(() => null);
    const player = loadReleaseOverviewById(trackId, "player");
    assert.equal(harness.requests.length, 2);

    harness.requests[0]?.resolve(new Response(JSON.stringify({ detail: "waveform superseded" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }));
    assert.equal(await detail, null);
    assert.equal(readyNotifications, 0);

    harness.requests[1]?.resolve(jsonWaveform(trackId));
    assert.equal((await player).track_id, trackId);
    assert.equal(readyNotifications, 1);
    assert.equal(cachedReleaseOverviewWaveform(trackId)?.track_id, trackId);
    unsubscribe();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
