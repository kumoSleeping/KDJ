/**
 * A browser for KDJ's pi (docs/ai-dock.md), driven over the Chrome DevTools Protocol: the user's
 * own Chrome, Edge, Brave or Chromium, started headless with a profile of KDJ's own
 * (<data>/ai/browser-profile) so the user's browsing is never touched. Pages are only read.
 *
 * The probe and the searches go through the browser, not Node, so they see the network the user
 * sees, system proxy included.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = process.env.KDJ_DATA_DIR;
const LOAD_TIMEOUT = 20_000;
const PROBE_TIMEOUT = 5_000;
const TEXT_LIMIT = 6_000;

function candidates(): string[] {
  const own = process.env.KDJ_BROWSER;
  if (own) return [own];
  if (process.platform === "darwin") {
    const apps = ["Google Chrome.app/Contents/MacOS/Google Chrome", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "Brave Browser.app/Contents/MacOS/Brave Browser", "Chromium.app/Contents/MacOS/Chromium"];
    return [...apps.map(app => join("/Applications", app)), ...apps.map(app => join(homedir(), "Applications", app))];
  }
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    const exes = ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe", "Chromium\\Application\\chrome.exe"];
    return exes.flatMap(exe => roots.map(root => join(root, exe)));
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]
    .flatMap(name => ["/usr/bin", "/usr/local/bin", "/snap/bin"].map(dir => join(dir, name)));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let started: Promise<number> | null = null;
let child: ChildProcess | null = null;
process.once("exit", () => child?.kill());

/** Starts the browser once per pi and gives its DevTools port. */
function port(): Promise<number> {
  started ??= (async () => {
    const exe = candidates().find(path => existsSync(path));
    if (!exe) throw new Error("没有找到 Chrome、Edge、Brave 或 Chromium 浏览器");
    const profile = join(DATA_DIR ?? tmpdir(), "ai", "browser-profile");
    mkdirSync(profile, { recursive: true });
    const portFile = join(profile, "DevToolsActivePort");
    rmSync(portFile, { force: true });
    child = spawn(exe, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
      "--no-default-browser-check", "--disable-extensions", "--mute-audio", "about:blank"], { stdio: "ignore", windowsHide: true });
    child.once("exit", () => { started = null; child = null; });
    for (let i = 0; i < 150; i += 1) {
      if (existsSync(portFile)) {
        const value = Number(readFileSync(portFile, "utf8").split("\n")[0]);
        if (value > 0) return value;
      }
      await sleep(100);
    }
    child?.kill();
    throw new Error("浏览器没有打开调试端口");
  })().catch(error => { started = null; throw error; });
  return started;
}

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } };

/** One page target and its DevTools socket. */
class Page {
  private next = 0;
  private waiting = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  private listeners = new Set<(message: Message) => void>();
  private constructor(private socket: WebSocket, readonly id: string, private devtools: number) {
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id !== undefined) {
        const waiter = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result ?? {});
      } else for (const listener of this.listeners) listener(message);
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.waiting.values()) waiter.reject(new Error("浏览器页面已关闭"));
      this.waiting.clear();
    });
  }

  static async open(): Promise<Page> {
    const devtools = await port();
    const response = await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, { method: "PUT" });
    const target = await response.json() as { id: string; webSocketDebuggerUrl: string };
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("无法连接浏览器页面")), { once: true });
    });
    const page = new Page(socket, target.id, devtools);
    await page.send("Page.enable");
    // A headless browser says so in its user agent, and search engines answer it differently.
    const agent = await page.evaluate<string>("navigator.userAgent");
    await page.send("Emulation.setUserAgentOverride", { userAgent: agent.replace("HeadlessChrome", "Chrome") });
    return page;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private event(method: string, timeout: number): Promise<boolean> {
    return new Promise(resolve => {
      const done = (value: boolean) => { this.listeners.delete(listener); clearTimeout(timer); resolve(value); };
      const listener = (message: Message) => { if (message.method === method) done(true); };
      const timer = setTimeout(() => done(false), timeout);
      this.listeners.add(listener);
    });
  }

  /** Goes to `url`; throws the network error when the page cannot be reached. */
  async go(url: string, timeout = LOAD_TIMEOUT): Promise<void> {
    const loaded = this.event("Page.loadEventFired", timeout);
    // A blocked host may take a long while to fail; past the timeout it counts as unreachable.
    const result = await Promise.race([
      this.send("Page.navigate", { url }),
      sleep(timeout).then((): never => { throw new Error("连接超时"); }),
    ]);
    if (typeof result.errorText === "string" && result.errorText) throw new Error(result.errorText);
    await loaded;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error("页面脚本出错");
    return (result.result as { value: T }).value;
  }

  close(): void {
    this.socket.close();
    void fetch(`http://127.0.0.1:${this.devtools}/json/close/${this.id}`).catch(() => undefined);
  }
}

async function withPage<T>(signal: AbortSignal | undefined, work: (page: Page) => Promise<T>): Promise<T> {
  const page = await Page.open();
  const abort = () => page.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await work(page);
  } finally {
    signal?.removeEventListener("abort", abort);
    page.close();
  }
}

export type Engine = "google" | "bing";

let probed: { google: boolean; bing: boolean } | null = null;

/** Which search engine this network reaches: Google first, then Bing (international). */
export async function probe(signal?: AbortSignal): Promise<{ google: boolean; bing: boolean; engine: Engine }> {
  probed ??= await withPage(signal, async page => {
    const reach = (url: string) => page.go(url, PROBE_TIMEOUT).then(() => true, () => false);
    const google = await reach("https://www.google.com/robots.txt");
    const bing = google ? true : await reach("https://www.bing.com/");
    return { google, bing };
  });
  return { ...probed, engine: probed.google ? "google" : "bing" };
}

const SEARCH_URL: Record<Engine, (query: string) => string> = {
  google: query => `https://www.google.com/search?hl=zh-CN&num=10&q=${encodeURIComponent(query)}`,
  bing: query => `https://www.bing.com/search?ensearch=1&q=${encodeURIComponent(query)}`,
};

const SEARCH_RESULTS: Record<Engine, string> = {
  google: `(() => {
    if (location.pathname.startsWith("/sorry")) return null;
    return [...document.querySelectorAll("a:has(h3)")].map(a => ({
      title: a.querySelector("h3").innerText.trim(),
      url: a.href,
      snippet: (a.closest("[data-hveid]")?.querySelector("[data-sncf], .VwiC3b")?.innerText ?? "").trim(),
    })).filter(r => r.title && /^https?:/.test(r.url) && !/\\/\\/(www\\.)?google\\./.test(r.url)).slice(0, 10);
  })()`,
  bing: `[...document.querySelectorAll("li.b_algo")].map(li => {
    const a = li.querySelector("h2 a");
    return { title: (a?.innerText ?? "").trim(), url: a?.href ?? "", snippet: (li.querySelector(".b_caption p, p")?.innerText ?? "").trim() };
  }).filter(r => r.title && /^https?:/.test(r.url)).slice(0, 10)`,
};

export interface SearchResult { title: string; url: string; snippet: string }

export async function search(query: string, engine: Engine | undefined, signal?: AbortSignal) {
  const chosen = engine ?? (await probe(signal)).engine;
  return withPage(signal, async page => {
    const url = SEARCH_URL[chosen](query);
    await page.go(url);
    const results = await page.evaluate<SearchResult[] | null>(SEARCH_RESULTS[chosen]);
    if (results === null) throw new Error("Google 要求人机验证，请改用 bing");
    return { engine: chosen, url, results };
  });
}

export async function open(url: string, signal?: AbortSignal) {
  return withPage(signal, async page => {
    await page.go(url);
    return page.evaluate<{ url: string; title: string; text: string; links: { text: string; url: string }[] }>(`({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText ?? "").replace(/\\n{3,}/g, "\\n\\n").slice(0, ${TEXT_LIMIT}),
      links: [...document.querySelectorAll("a[href]")]
        .map(a => ({ text: a.innerText.trim().slice(0, 80), url: a.href }))
        .filter(l => l.text && /^https?:/.test(l.url)).slice(0, 40),
    })`);
  });
}
