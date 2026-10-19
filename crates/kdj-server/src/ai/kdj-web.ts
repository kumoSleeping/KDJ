/**
 * KDJ's built-in ways of searching the web (docs/ai-dock.md), for when pi-web-access is not the
 * one chosen. `KDJ_WEB_MODE`, set by kdj-server, picks one:
 *
 * - `deepseek`: DeepSeek's Search and Fetch (api.deepseek.com/v1/tools/search, …/fetch);
 * - `deepseek-jina`: DeepSeek's Search, pages read by Jina Reader without a key, and by DeepSeek's
 *   Fetch while Jina turns requests away (HTTP 429);
 * - `jina`: Jina's Search and Reader with the listener's key.
 *
 * Pages are read by those services, never by this machine. Keys come from KDJ's own pi directory
 * (auth.json: `deepseek`, `jina`).
 *
 * Written into KDJ's own pi directory by kdj-server; edits here, not there.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolText } from "./kdj-prompts.ts";

const MODE = process.env.KDJ_WEB_MODE ?? "access";
const PAGE_LIMIT = 12_000;

/** A key from KDJ's auth.json: the key itself, or `!command` whose output is the key. */
function key(provider: string): string {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) return "";
  try {
    const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as Record<string, { key?: string }>;
    const value = auth[provider]?.key ?? "";
    return value.startsWith("!") ? execSync(value.slice(1), { encoding: "utf8", timeout: 10_000 }).trim() : value;
  } catch {
    return "";
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function call(url: string, init: RequestInit, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? text.slice(0, 200);
    throw new HttpError(response.status, `HTTP ${response.status}：${message}`);
  }
  return body;
}

function webUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("只能读取 http(s) 网页");
  return url.toString();
}

function deepseek(path: string, body: object, signal?: AbortSignal) {
  const secret = key("deepseek");
  if (!secret) throw new Error("没有 DeepSeek 的 Key：在 设置 → AI 登录 DeepSeek");
  return call(`https://api.deepseek.com/v1/tools/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, signal);
}

async function searchDeepseek(query: string, count: number, signal?: AbortSignal) {
  const body = await deepseek("search", { query: query.slice(0, 128), count }, signal);
  return (body?.results ?? []).map((item: any) => ({
    title: item.title, url: item.url, snippet: item.summary || item.snippet, date: item.date ?? undefined,
  }));
}

async function searchJina(query: string, count: number, signal?: AbortSignal) {
  const secret = key("jina");
  if (!secret) throw new Error("没有 Jina 的 Key：在 设置 → AI 填入");
  const body = await call(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${secret}`, Accept: "application/json", "X-Respond-With": "no-content" },
  }, signal);
  return (body?.data ?? []).slice(0, count).map((item: any) => ({ title: item.title, url: item.url, snippet: item.description }));
}

async function fetchDeepseek(url: string, signal?: AbortSignal) {
  const body = await deepseek("fetch", { url }, signal);
  return { url, title: body?.title ?? "", content: String(body?.content ?? "") };
}

async function fetchJina(url: string, withKey: boolean, signal?: AbortSignal) {
  const secret = withKey ? key("jina") : "";
  const headers: Record<string, string> = { Accept: "application/json", "X-Return-Format": "markdown" };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const body = await call(`https://r.jina.ai/${url}`, { headers }, signal);
  return { url: body?.data?.url ?? url, title: body?.data?.title ?? "", content: String(body?.data?.content ?? "") };
}

function result(data: { [key: string]: unknown }) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data };
}

const webSearch = defineTool({
  name: "kdj_web_search",
  label: "网页搜索",
  description: toolText("kdj_web_search").description,
  parameters: Type.Object({
    query: Type.String({ description: toolText("kdj_web_search").param("query") }),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  }),
  async execute(_id, params, signal) {
    const count = params.count ?? 8;
    const results = MODE === "jina" ? await searchJina(params.query, count, signal) : await searchDeepseek(params.query, count, signal);
    return result({ engine: MODE === "jina" ? "jina" : "deepseek", results });
  },
});

const webFetch = defineTool({
  name: "kdj_web_fetch",
  label: "读取网页",
  description: toolText("kdj_web_fetch").description,
  parameters: Type.Object({ url: Type.String() }),
  async execute(_id, params, signal) {
    const url = webUrl(params.url);
    let page;
    if (MODE === "deepseek") page = await fetchDeepseek(url, signal);
    else if (MODE === "jina") page = await fetchJina(url, true, signal);
    else {
      try {
        page = await fetchJina(url, false, signal);
      } catch (error) {
        // Jina without a key allows a few requests a minute; past that DeepSeek reads the page.
        if (!(error instanceof HttpError) || error.status !== 429) throw error;
        page = await fetchDeepseek(url, signal);
      }
    }
    const truncated = page.content.length > PAGE_LIMIT;
    return result({ ...page, content: page.content.slice(0, PAGE_LIMIT), truncated });
  },
});

/** Registered only when one of KDJ's own ways is chosen; pi-web-access brings its own tools. */
export function registerWeb(pi: ExtensionAPI) {
  if (MODE === "access") return;
  pi.registerTool(webSearch);
  pi.registerTool(webFetch);
}
