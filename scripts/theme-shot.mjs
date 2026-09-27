// 主题包截图：起一套隔离的后端 + 浏览器预览，对每个主题 × 模式截主界面、设置、歌词窗。
// 不碰正式数据目录；主题直接读仓库的 themes/，改完 CSS 重跑即可。
//
//   cargo build -p kdj-server --bin kdj-server
//   KDJ_TEST_BROWSER=/path/to/chrome node scripts/theme-shot.mjs <输出目录> [主题 id ...]
//
// 不给主题 id 时截「默认」和 themes/ 下的全部主题。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) throw new Error("用法：node scripts/theme-shot.mjs <输出目录> [主题 id ...]");
const out = path.resolve(process.argv[2]);
await fs.mkdir(out, { recursive: true });
const browser = process.env.KDJ_TEST_BROWSER
  || path.join(os.homedir(), ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kdj-theme-shot-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
const run = (command, args, { cwd, ...env } = {}) => {
  const child = spawn(command, args, { cwd: cwd || root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.log = "";
  child.stdout.on("data", (chunk) => { child.log += chunk; });
  child.stderr.on("data", (chunk) => { child.log += chunk; });
  children.push(child);
  return child;
};
const freePort = () => new Promise((resolve) => {
  const server = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
async function until(what, check, tries = 300) {
  for (let i = 0; i < tries; i += 1) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`等待超时：${what}\n${children.map((c) => c.log.slice(-2000)).join("\n---\n")}`);
}

/** 几首带鼓点的合成音，让列表、详情和波形有东西可画。 */
async function demoTracks(dir) {
  await fs.mkdir(dir);
  const rate = 22050, seconds = 24;
  const tracks = [["Kumo", "Night Drive", 128, 55], ["Kumo", "Paper Moon", 124, 62], ["Deck", "Pixel Rain", 140, 49],
    ["Deck", "First Gig", 120, 58], ["Bear", "Lamp Light", 132, 65], ["Bear", "Dawn", 126, 52]];
  for (const [artist, title, bpm, note] of tracks) {
    const pcm = Buffer.alloc(rate * seconds * 2);
    const beat = 60 / bpm, tone = 440 * 2 ** ((note - 69) / 12);
    let seed = note;
    for (let i = 0; i < rate * seconds; i += 1) {
      const t = i / rate, phase = t % beat, section = Math.floor(t / (beat * 16)) % 3;
      const kick = Math.exp(-phase * 18) * Math.sin(2 * Math.PI * 55 * phase);
      const lead = section > 0 ? 0.3 * Math.sin(2 * Math.PI * tone * 2 * t) * (0.5 + 0.5 * Math.sin(t * 3)) : 0;
      seed = (seed * 1664525 + 1013904223) >>> 0; // 固定种子：两次运行的波形必须一致，才能逐像素对比
      const hat = section > 1 && phase > beat / 2 ? 0.2 * (seed / 2 ** 31 - 1) * Math.exp(-(phase - beat / 2) * 40) : 0;
      pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, 0.7 * kick + lead + hat)) * 32000), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
    await fs.writeFile(path.join(dir, `${artist} - ${title}.wav`), Buffer.concat([header, pcm]));
  }
}

try {
  const dataDir = path.join(tmp, "data"), music = path.join(tmp, "music");
  await fs.mkdir(dataDir);
  await fs.mkdir(path.join(root, "themes"), { recursive: true });
  await fs.symlink(path.join(root, "themes"), path.join(dataDir, "themes"));
  await demoTracks(music);

  const port = await freePort();
  const server = run(path.join(root, "target/debug/kdj-server"), [], {
    KDJ_DATA_DIR: dataDir, KDJ_DOWNLOAD_DIR: path.join(tmp, "downloads"), KDJ_PORT: String(port), KDJ_PRINT_TOKENS: "1",
  });
  const [, auth, media] = await until("kdj-server", async () => /KDJ_TOKENS (\S+) (\S+)/.exec(server.log));
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
      method,
      headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${route} → ${response.status} ${await response.text()}`);
    return response.json();
  };
  await api("PUT", "/settings", { ...(await api("GET", "/settings")), library_dirs: [music] });
  await api("POST", "/library/scan", { paths: [music], recursive: true, analyze: true });

  // 后端的开发 CORS 白名单只认 5274，端口换不了；别人正在截图就排队等它结束
  await until("端口 5274 空闲", () => new Promise((resolve) => {
    const probe = net.createServer().once("error", () => resolve(false))
      .listen(5274, "localhost", () => probe.close(() => resolve(true)));
  }), 6000);
  // KDJ_SHOT_WEB：换一份前端源码目录（例如 main 的 worktree）来截对照图
  run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "--config", "vite.rust.config.ts"], {
    cwd: process.env.KDJ_SHOT_WEB,
    VITE_KDJ_PORT: String(port), VITE_KDJ_AUTH_TOKEN: auth, VITE_KDJ_MEDIA_TOKEN: media,
  });
  await until("vite", async () => (await fetch("http://localhost:5274/")).ok);

  const profile = path.join(tmp, "profile");
  run(browser, ["--headless=new", "--no-sandbox", "--no-first-run", "--disable-extensions", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"]);
  const debugPort = await until("浏览器", async () =>
    (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
  const tab = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let id = 0;
  const pending = new Map(), problems = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (message.method === "Runtime.exceptionThrown") problems.push(message.params.exceptionDetails.exception?.description ?? "exception");
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") problems.push(message.params.entry.text);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
  const shot = async (name) => {
    const { data } = await call("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(out, `${name}.png`), Buffer.from(data, "base64"));
  };
  await call("Page.enable"); await call("Runtime.enable"); await call("Log.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const available = (await api("GET", "/themes")).themes;
  const wanted = process.argv.length > 3 ? process.argv.slice(3) : ["default", ...available.map((t) => t.dir)];
  let boot = null;
  for (const pack of wanted) {
    const manifest = available.find((t) => t.dir === pack)?.manifest;
    if (pack !== "default" && !manifest) throw new Error(`themes/${pack} 不存在或 theme.json 无效`);
    for (const mode of manifest?.modes ?? ["light", "dark"]) {
      await api("PUT", "/settings", { ...(await api("GET", "/settings")), theme: mode });
      const stored = JSON.stringify({ id: pack === "default" ? null : pack, options: {} });
      if (boot) await call("Page.removeScriptToEvaluateOnNewDocument", { identifier: boot });
      boot = (await call("Page.addScriptToEvaluateOnNewDocument", {
        // Math.random 固定住：顶栏提示语等随机内容不该让两次截图出现差异
        source: `Math.random = () => 0.5; localStorage.setItem("kd-theme-pack", ${JSON.stringify(stored)}); localStorage.setItem("kd-theme", "${mode}");`,
      })).identifier;
      const name = `${pack}-${mode}`;
      problems.length = 0;

      await call("Page.navigate", { url: "http://localhost:5274/" });
      await until(`${name} 曲目列表`, () => evaluate(`document.querySelectorAll(".kd-app tbody tr").length > 0`), 900);
      await sleep(1500);
      await shot(`${name}-main`);
      // 选中第一首：详情栏、波形、播放条都出来
      await evaluate(`document.querySelector(".kd-app tbody tr")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
      await sleep(2500);
      await shot(`${name}-track`);
      await evaluate(`document.querySelector('[aria-label="设置"]')?.click()`);
      await sleep(1200);
      await shot(`${name}-settings`);
      await call("Page.navigate", { url: "http://localhost:5274/?window=lyrics" });
      await sleep(1500);
      await shot(`${name}-lyrics`);
      console.log(`${name}: ${problems.length ? `${problems.length} 个页面错误\n  ${[...new Set(problems.map((text) => text.split("\n")[0]))].join("\n  ")}` : "ok"}`);
    }
  }
  ws.terminate();
} finally {
  for (const child of children.reverse()) child.kill("SIGTERM");
  await sleep(500);
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(process.exitCode ?? 0);
