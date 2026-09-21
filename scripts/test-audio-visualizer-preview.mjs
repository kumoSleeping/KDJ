// Compare real browser-decoded MP4 frames with the shared Canvas renderer.
// Usage: node scripts/test-audio-visualizer-preview.mjs /absolute/acceptance-directory
// The directory contains request.json, features.json and the exported render.mp4.
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Missing acceptance directory");
const request = JSON.parse(await fs.readFile(path.join(directory, "request.json"), "utf8"));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "kdj-visualizer-browser-"));
let browser, server, socket, timeout;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const bundle = path.join(temporary, "preview.js");
  await build({ entryPoints: [path.join(root, "tests/audioVisualizer.preview.ts")], outfile: bundle, bundle: true, platform: "browser", format: "iife", target: "es2022", logLevel: "silent" });
  const files = new Map([
    ["/preview.js", [bundle, "text/javascript"]],
    ["/request.json", [path.join(directory, "request.json"), "application/json"]],
    ["/features.json", [path.join(directory, "features.json"), "application/json"]],
    ["/render.mp4", [path.join(directory, "render.mp4"), "video/mp4"]],
    ...request.scene.images.map((image, index) => [`/image-${index}`, [image, "image/png"]]),
  ]);
  server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end('<!doctype html><script src="/preview.js" defer></script>'); return; }
      const entry = files.get(req.url);
      if (!entry) { res.writeHead(404); res.end(); return; }
      const [filename, type] = entry, { size } = await fs.stat(filename);
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) { res.writeHead(416); res.end(); return; }
      res.writeHead(range ? 206 : 200, { "content-type": type, "content-length": end - start + 1, "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
      createReadStream(filename, { start, end }).on("error", () => res.destroy()).pipe(res);
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const profile = path.join(temporary, "profile");
  const executable = process.env.KDJ_TEST_BROWSER || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  await fs.access(executable);
  browser = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`], { stdio: "ignore" });
  let launchError;
  browser.on("error", (error) => { launchError = error; });
  const work = async () => {
    let port;
    while (!port) {
      if (launchError) throw launchError;
      if (browser.exitCode !== null) throw new Error("Test browser exited before debugging was available");
      try { port = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { await delay(100); }
    }
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const target = targets.find((t) => t.type === "page");
    if (!target) throw new Error("Missing isolated test page");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    let id = 0;
    const pending = new Map();
    socket.on("message", (bytes) => {
      const value = JSON.parse(bytes.toString()), call = pending.get(value.id);
      if (call) { pending.delete(value.id); value.error ? call.reject(new Error(value.error.message)) : call.resolve(value.result); }
    });
    const evaluate = (expression, awaitPromise = false) => new Promise((resolve, reject) => {
      const key = ++id; pending.set(key, { resolve, reject });
      socket.send(JSON.stringify({ id: key, method: "Runtime.evaluate", params: { expression, awaitPromise, returnByValue: true } }));
    });
    while (!(await evaluate("!!globalThis.visualizerAcceptance")).result?.value) await delay(100);
    const value = await evaluate("globalThis.visualizerAcceptance", true);
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  const result = await Promise.race([work(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Preview acceptance timed out")), 45000); })]);
  console.log(JSON.stringify(result, null, 2));
  if (!result?.ok) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  socket?.terminate();
  if (browser && browser.exitCode === null) {
    browser.kill("SIGTERM");
    for (let n = 0; n < 30 && browser.exitCode === null; n++) await delay(100);
    if (browser.exitCode === null) browser.kill("SIGKILL");
  }
  server?.closeAllConnections(); server?.close();
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
