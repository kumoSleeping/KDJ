import assert from "node:assert/strict";
import test from "node:test";

function installBrowserStubs(): void {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  };
  const events = new EventTarget();
  const window = Object.assign(events, {
    kdj: {
      baseUrl: "http://127.0.0.1:43123",
      authToken: "test-control-token",
      mediaToken: "test-media-token",
      platform: "darwin",
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
  Object.assign(globalThis, {
    localStorage,
    window,
    document: {
      baseURI: "http://127.0.0.1/",
      createElement: () => ({ preload: "", crossOrigin: "" }),
      documentElement: { dataset: {} },
      querySelectorAll: () => [],
    },
  });
}

class FakeVideo extends EventTarget {
  src = "";
  preload = "";
  readyState = 0;
  error: MediaError | null = null;
  loadCount = 0;
  pauseCount = 0;
  actions: string[] = [];
  hlsSupport: CanPlayTypeResult = "maybe";

  get currentSrc(): string {
    return this.src;
  }

  canPlayType(mime: string): CanPlayTypeResult {
    assert.equal(mime, "application/vnd.apple.mpegurl");
    return this.hlsSupport;
  }

  load(): void {
    this.loadCount += 1;
    this.actions.push("load");
  }

  pause(): void {
    this.pauseCount += 1;
    this.actions.push("pause");
  }

  removeAttribute(name: string): void {
    if (name === "src") {
      this.src = "";
      this.actions.push("remove-src");
    }
  }
}

test("YouTube Music download mints one proof for every bounded GVS range", async () => {
  installBrowserStubs();
  const { ytmGvsProofCount } = await import("../src/lib/api");
  const stream = (length: number) =>
    `https://rr1---sn.example.googlevideo.com/videoplayback?clen=${length}`;
  const chunk = 10 * 1024 * 1024;
  assert.equal(ytmGvsProofCount(stream(1)), 1);
  assert.equal(ytmGvsProofCount(stream(chunk)), 1);
  assert.equal(ytmGvsProofCount(stream(chunk + 1)), 2);
  assert.equal(ytmGvsProofCount(stream(chunk * 64)), 64);
  assert.throws(() => ytmGvsProofCount(stream(chunk * 64 + 1)), /媒体过大/);
  assert.throws(() => ytmGvsProofCount(stream(0)), /媒体长度/);
});

test("YouTube pointer prewarm shares one native-HLS preparation", async () => {
  installBrowserStubs();
  const { api } = await import("../src/lib/api");
  const {
    clearYoutubeVideoPreviewCache,
    prewarmYoutubeVideoPreview,
  } = await import("../src/lib/youtubeVideoPreview");
  clearYoutubeVideoPreviewCache();
  const originalPrepare = api.prepareYoutubeVideoPreview;
  let resolvePreparation!: (url: string) => void;
  let preparations = 0;
  try {
    api.prepareYoutubeVideoPreview = async () => {
      preparations += 1;
      return new Promise<string>((resolve) => {
        resolvePreparation = resolve;
      });
    };
    const input = { platform: "youtube" as const, bvid: "dQw4w9WgXcQ", page: 0 };
    const first = prewarmYoutubeVideoPreview(input);
    const second = prewarmYoutubeVideoPreview(input);
    assert.equal(preparations, 1);
    resolvePreparation("http://127.0.0.1:43123/api/video/youtube/hls/ticket");
    await Promise.all([first, second]);
    await prewarmYoutubeVideoPreview(input);
    assert.equal(preparations, 1, "warm playback must reuse the exact prepared HLS capability");
  } finally {
    api.prepareYoutubeVideoPreview = originalPrepare;
    clearYoutubeVideoPreviewCache();
  }
});

test("a failed YouTube prewarm is exposed instead of retried by attach", async () => {
  installBrowserStubs();
  const { api } = await import("../src/lib/api");
  const {
    attachYoutubeVideoPreview,
    clearYoutubeVideoPreviewCache,
    prewarmYoutubeVideoPreview,
  } = await import("../src/lib/youtubeVideoPreview");
  clearYoutubeVideoPreviewCache();
  const originalPrepare = api.prepareYoutubeVideoPreview;
  let preparations = 0;
  try {
    api.prepareYoutubeVideoPreview = async () => {
      preparations += 1;
      throw new Error("first attempt failed");
    };
    const input = { platform: "youtube" as const, bvid: "dQw4w9WgXcQ", page: 0 };
    await assert.rejects(prewarmYoutubeVideoPreview(input), /first attempt failed/);
    const video = new FakeVideo();
    const controller = attachYoutubeVideoPreview(
      video as unknown as HTMLVideoElement,
      input,
    );
    await assert.rejects(controller.done, /first attempt failed/);
    assert.equal(preparations, 1, "attach must observe the failed first attempt, not retry it");
  } finally {
    api.prepareYoutubeVideoPreview = originalPrepare;
    clearYoutubeVideoPreviewCache();
  }
});

test("YouTube attach uses native HLS and resolves only when media is playable", async () => {
  installBrowserStubs();
  const { api } = await import("../src/lib/api");
  const {
    attachYoutubeVideoPreview,
    clearYoutubeVideoPreviewCache,
  } = await import("../src/lib/youtubeVideoPreview");
  clearYoutubeVideoPreviewCache();
  const originalPrepare = api.prepareYoutubeVideoPreview;
  const originalStart = api.startYoutubeVideoPlayback;
  const originalRevoke = api.revokeYoutubeVideoPlayback;
  const prepared = "http://127.0.0.1:43123/api/video/youtube/hls/prepared";
  const expected = "http://127.0.0.1:43123/api/video/youtube/hls/session?kdj_media_token=media";
  let starts = 0;
  let revokes = 0;
  const video = new FakeVideo();
  try {
    api.prepareYoutubeVideoPreview = async () => prepared;
    api.startYoutubeVideoPlayback = async (url) => {
      assert.equal(url, prepared);
      starts += 1;
      return expected;
    };
    api.revokeYoutubeVideoPlayback = async (url) => {
      assert.equal(url, expected);
      video.actions.push("revoke");
      revokes += 1;
    };
    const controller = attachYoutubeVideoPreview(video as unknown as HTMLVideoElement, {
      platform: "youtube",
      bvid: "dQw4w9WgXcQ",
      page: 0,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(video.src, expected);
    assert.equal(video.preload, "auto");
    assert.equal(video.loadCount, 1);
    video.readyState = 2;
    video.dispatchEvent(new Event("canplay"));
    await controller.done;
    assert.equal(starts, 1);

    await controller.dispose();
    assert.equal(video.src, "");
    assert.equal(video.pauseCount, 1);
    assert.equal(video.loadCount, 2);
    assert.equal(revokes, 1, "detaching must cancel the exact local playback session");
    assert.deepEqual(
      video.actions.slice(-4),
      ["pause", "remove-src", "load", "revoke"],
      "WebKit must be detached before the unique native-HLS session is revoked",
    );
  } finally {
    api.prepareYoutubeVideoPreview = originalPrepare;
    api.startYoutubeVideoPlayback = originalStart;
    api.revokeYoutubeVideoPlayback = originalRevoke;
    clearYoutubeVideoPreviewCache();
  }
});

test("YouTube attach rejects unsupported WebViews without a second playback path", async () => {
  installBrowserStubs();
  const { api } = await import("../src/lib/api");
  const {
    attachYoutubeVideoPreview,
    clearYoutubeVideoPreviewCache,
  } = await import("../src/lib/youtubeVideoPreview");
  clearYoutubeVideoPreviewCache();
  const originalPrepare = api.prepareYoutubeVideoPreview;
  let preparations = 0;
  try {
    api.prepareYoutubeVideoPreview = async () => {
      preparations += 1;
      return "unused";
    };
    const video = new FakeVideo();
    video.hlsSupport = "";
    const controller = attachYoutubeVideoPreview(video as unknown as HTMLVideoElement, {
      platform: "youtube",
      bvid: "dQw4w9WgXcQ",
      page: 0,
    });
    await assert.rejects(controller.done, /不支持 YouTube 原生 HLS/);
    assert.equal(preparations, 0);
  } finally {
    api.prepareYoutubeVideoPreview = originalPrepare;
    clearYoutubeVideoPreviewCache();
  }
});

test("YouTube E2E failure reports redact sensitive field names and values", async () => {
  installBrowserStubs();
  const { sanitizeYoutubePlaybackE2eError } = await import(
    "../src/lib/youtubePlaybackE2eFailure"
  );
  const message = sanitizeYoutubePlaybackE2eError(
    "GVS token=secret Cookie=session Authorization=Bearer auth-secret public=https://example.test/private",
  );
  assert.doesNotMatch(message, /token|cookie|authorization|https?:\/\//i);
  assert.doesNotMatch(message, /secret|session|example\.test/i);
  assert.match(message, /\[敏感字段\]/);
  assert.match(message, /\[地址已隐藏\]/);
});
