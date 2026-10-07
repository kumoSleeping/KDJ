import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const CHUNK = 16 * 1024;
const TOTAL = 4 * 1024 * 1024;

test("the SABR upload sends every byte in order without re-copying what it has buffered", async () => {
  const uploaded: Uint8Array[] = [];
  let ended = "";
  let copiedBytes = 0;
  class CountingUint8Array extends Uint8Array {
    constructor(...args: any[]) {
      super(...(args as []));
      if (typeof args[0] === "number") copiedBytes += args[0];
    }
  }
  class SabrStream {
    async start() {
      let sent = 0;
      const audioStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= TOTAL) { controller.close(); return; }
          // 每块填自己的序号，上传顺序错了就对不上
          controller.enqueue(new Uint8Array(CHUNK).fill(sent / CHUNK));
          sent += CHUNK;
        },
      }, { highWaterMark: 0 });
      return { audioStream };
    }
    abort() {}
  }
  const fetch = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/api/, "");
    if (path === "/song/preview/ytm/sabr/spools") {
      return new Response(JSON.stringify({ url: "/song/preview/stream/t", waveform_token: "t" }));
    }
    const action = path.match(/^\/song\/preview\/ytm\/sabr\/spools\/t(?:\/(complete|fail))?$/);
    assert.ok(action, path);
    if (action[1]) ended = action[1];
    else uploaded.push(new Uint8Array(await new Response(init.body).arrayBuffer()));
    return new Response(null, { status: action[1] ? 204 : 200 });
  };
  const exports: Record<string, any> = {};
  const modules: Record<string, unknown> = {
    "googlevideo/sabr-stream": { SabrStream },
    "googlevideo/utils": { buildSabrFormat: (format: unknown) => format, EnabledTrackTypes: { AUDIO_ONLY: 1 } },
    "./activityLog": { finishApiActivity() {} },
    "./bridge": { getBridge: () => ({ baseUrl: "http://127.0.0.1:9", authToken: "a", mediaToken: "m" }) },
    "./youtubeSabrFailure": { sanitizeYoutubeSabrFailure: (reason: unknown) => String(reason) },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync("src/lib/youtubeSabr.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, require(name: string) { assert.ok(name in modules, name); return modules[name]; },
    fetch, Headers, Response, URL, Blob, performance, console, Uint8Array: CountingUint8Array,
  });

  await exports.createYoutubeSabrPreview({
    platform: "ytm", key: "a", title: "a", artists: [], album: "", duration: 240, cover: "",
    max_quality: null, vip: false, payload: { video_id: "a" },
  }, {
    serverAbrStreamingUrl: "https://example.invalid/sabr", videoPlaybackUstreamerConfig: "", poToken: "",
    audioItag: 140, durationMs: 240_000,
    formats: [{ itag: 140, mimeType: "audio/mp4", contentLength: String(TOTAL) }],
  }, false);
  for (let spins = 0; spins < 5_000 && !ended; spins++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(ended, "complete");
  const bytes = Buffer.concat(uploaded);
  assert.equal(bytes.length, TOTAL);
  for (let chunk = 0; chunk < TOTAL / CHUNK; chunk++) {
    assert.equal(bytes[chunk * CHUNK], chunk % 256, `chunk ${chunk}`);
    assert.equal(bytes[chunk * CHUNK + CHUNK - 1], chunk % 256, `chunk ${chunk}`);
  }
  // 逐块拼接时，每个 256 KiB 窗口要把已缓冲的前缀重拷十几遍：4 MiB 约 33 MB
  assert.equal(copiedBytes, 0);
});

test("a released SABR session stops downloading without failing or completing the spool", async () => {
  const appended: number[] = [];
  const ended: string[] = [];
  const warnings: unknown[] = [];
  let pulled = 0;
  let aborted = false;
  class SabrStream {
    async start() {
      const audioStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= TOTAL) { controller.close(); return; }
          controller.enqueue(new Uint8Array(CHUNK));
          pulled += CHUNK;
        },
      }, { highWaterMark: 0 });
      return { audioStream };
    }
    abort() { aborted = true; }
  }
  const fetch = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/api/, "");
    if (path === "/song/preview/ytm/sabr/spools") {
      return new Response(JSON.stringify({ url: "/song/preview/stream/t", waveform_token: "t" }));
    }
    const action = path.match(/^\/song\/preview\/ytm\/sabr\/spools\/t(?:\/(complete|fail))?$/);
    assert.ok(action, path);
    if (action[1]) { ended.push(action[1]); return new Response(null, { status: 204 }); }
    appended.push((await new Response(init.body).arrayBuffer()).byteLength);
    // 后端确认装过这条 spool 的 Deck 都已卸载
    if (appended.length >= 3) {
      return new Response(JSON.stringify({ detail: "released", code: "MEDIA_SESSION_RELEASED" }), { status: 410 });
    }
    return new Response(null, { status: 200 });
  };
  const exports: Record<string, any> = {};
  const modules: Record<string, unknown> = {
    "googlevideo/sabr-stream": { SabrStream },
    "googlevideo/utils": { buildSabrFormat: (format: unknown) => format, EnabledTrackTypes: { AUDIO_ONLY: 1 } },
    "./activityLog": { finishApiActivity() {} },
    "./bridge": { getBridge: () => ({ baseUrl: "http://127.0.0.1:9", authToken: "a", mediaToken: "m" }) },
    "./youtubeSabrFailure": { sanitizeYoutubeSabrFailure: (reason: unknown) => String(reason) },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync("src/lib/youtubeSabr.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, require(name: string) { assert.ok(name in modules, name); return modules[name]; },
    fetch, Headers, Response, URL, Blob, performance, Uint8Array,
    console: { warn: (...args: unknown[]) => warnings.push(args) },
  });

  const preview = await exports.createYoutubeSabrPreview({
    platform: "ytm", key: "a", title: "a", artists: [], album: "", duration: 240, cover: "",
    max_quality: null, vip: false, payload: { video_id: "a" },
  }, {
    serverAbrStreamingUrl: "https://example.invalid/sabr", videoPlaybackUstreamerConfig: "", poToken: "",
    audioItag: 140, durationMs: 240_000,
    formats: [{ itag: 140, mimeType: "audio/mp4", contentLength: String(TOTAL) }],
  }, false);
  let released = false;
  void preview.released.then(() => { released = true; });
  for (let spins = 0; spins < 5_000 && !released; spins++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  // 给错误的后续上传或 complete 留出机会暴露
  for (let spins = 0; spins < 50; spins++) await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(released, true);
  assert.equal(aborted, true);
  assert.equal(appended.length, 3, "no upload after the backend released the spool");
  assert.deepEqual(ended, [], "a released spool is neither completed nor failed");
  assert.deepEqual(warnings, []);
  assert.ok(pulled < TOTAL, "the SABR stream is no longer drained to the end");
});
