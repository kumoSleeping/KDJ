import dashboard from "./dashboard.html";
import dashboardScript from "./dashboard.browser.js";

const MAX_BYTES = 256 * 1024;
const RETENTION_MS = 30 * 86400_000;
const HEADERS = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
const json = (body, status = 200) => Response.json(body, { status, headers: HEADERS });
class Rejected extends Error { constructor(status, message) { super(message); this.status = status; } }
function require(condition, message = "Invalid report") { if (!condition) throw new Rejected(400, message); }
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
function fields(value, keys) { require(isObject(value) && Object.keys(value).every(k => keys.includes(k))); }
function string(value, max) { require(typeof value === "string" && value.length <= max); return value; }
function integer(value, max) { require(Number.isSafeInteger(value) && value >= 0 && value <= max); return value; }
function scrub(value) {
  return value
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|access_token|refresh_token|auth_token|media_token|control_token|client_secret|api[_-]?key|secret|token|musickey|sapisid|po_token|visitor_data|refresh_key)\b["'\s]*[:=][^\r\n]*/gim, "[credential redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:https?|file|blob|data|wss?):\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\bdata:[^\s"'<>]+/gi, "[data]")
    .replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n"'<>:]*/gi, "[path]")
    .replace(/\/(?:Users|home|Volumes|private|tmp|var|storage|sdcard|data|mnt|media|opt|Applications)\/[^\r\n"'<>:]*/g, "[path]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    .replace(/\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]{1,39}\b|\b[a-f0-9]{1,4}::[a-f0-9:]{1,39}\b|(?:^|[\s\[])::1(?:$|[\s\]])/gi, "[ip]")
    .replace(/\b(?:\+?86[- ]?)?1[3-9]\d{9}\b/g, "[phone]")
    .replace(/\b\d{15,19}\b/g, "[identifier]")
    .replace(/\b[A-Za-z0-9_+/=-]{48,}\b/g, "[opaque value]");
}
function validateReport(input) {
  fields(input, ["schema", "id", "app_version", "created_at", "os", "arch", "cpu_threads", "dropped", "note", "entries", "omitted"]);
  require(input.schema === 1 && /^[a-f0-9]{32}$/.test(string(input.id, 32)));
  require(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(string(input.app_version, 64)));
  require(["macos", "windows", "linux", "android", "ios"].includes(input.os));
  require(/^[a-z0-9_]{1,32}$/.test(string(input.arch, 32)));
  require(Number.isFinite(Date.parse(string(input.created_at, 40))));
  require(Array.isArray(input.entries) && input.entries.length <= 300);
  const entries = input.entries.map(entry => {
    fields(entry, ["timestamp", "session", "level", "category", "source", "message"]);
    require(Number.isFinite(Date.parse(string(entry.timestamp, 40))));
    require(/^[a-f0-9]{32}$/.test(string(entry.session, 32)));
    require(["error", "warn", "info", "ERROR", "WARN", "INFO"].includes(entry.level));
    return { timestamp: entry.timestamp, session: entry.session, level: entry.level,
      category: scrub(string(entry.category, 80)), source: scrub(string(entry.source, 400)), message: scrub(string(entry.message, 16_000)) };
  });
  return { schema: 1, id: input.id, app_version: input.app_version, created_at: input.created_at,
    os: input.os, arch: input.arch, cpu_threads: integer(input.cpu_threads, 65536),
    dropped: integer(input.dropped, Number.MAX_SAFE_INTEGER), omitted: integer(input.omitted, 1000000),
    note: scrub(string(input.note, 4000)), entries };
}
async function boundedBody(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_BYTES) throw new Rejected(413, "Report too large");
  if (!request.body) throw new Rejected(400, "Missing report");
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Rejected(413, "Report too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Rejected(400, "Invalid JSON"); }
}
async function admin(request, env) {
  if (!env.ADMIN_TOKEN) throw new Rejected(503, "Admin unavailable");
  const supplied = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  const encoder = new TextEncoder();
  const hashes = await Promise.all([supplied, env.ADMIN_TOKEN].map(v => crypto.subtle.digest("SHA-256", encoder.encode(v))));
  if (!crypto.subtle.timingSafeEqual(...hashes)) throw new Rejected(401, "Unauthorized");
}
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === "/health" && method === "GET") return json({ service: "kdj-bug-collector", schema: 1 });
  if (path === "/" && method === "GET") return new Response(dashboard, { headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } });
  if (path === "/dashboard.js" && method === "GET") return new Response(dashboardScript, { headers: { ...HEADERS, "Content-Type": "text/javascript; charset=utf-8" } });
  if (path === "/v1/reports" && method === "POST") {
    // No permissive CORS: browsers cannot submit cross-origin JSON. Native KDJ posts directly.
    if (request.headers.has("Origin")) throw new Rejected(403, "Native client only");
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new Rejected(415, "JSON required");
    // IP is used only in ephemeral edge rate-limit counters, never stored in D1 or logs.
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!(await env.UPLOAD_LIMIT.limit({ key: ip })).success || !(await env.GLOBAL_LIMIT.limit({ key: "reports" })).success) throw new Rejected(429, "Rate limited");
    const report = validateReport(await boundedBody(request));
    const body = JSON.stringify(report);
    if (new TextEncoder().encode(body).length > MAX_BYTES) throw new Rejected(413, "Report too large");
    const old = await env.DB.prepare("SELECT id FROM reports WHERE id = ?").bind(report.id).first();
    if (old) return json({ id: report.id });
    const categories = [...new Set(report.entries.map(e => e.category))].join(",");
    // Atomic storage quota: max 1000 retained reports and 100 submissions/day, independent of edge limits.
    const result = await env.DB.prepare(`INSERT OR IGNORE INTO reports (id, received_at, app_version, os, categories, event_count, body)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM reports) < 1000
      AND (SELECT count(*) FROM reports WHERE received_at >= ?) < 100`)
      .bind(report.id, Date.now(), report.app_version, report.os, categories, report.entries.length, body, Date.now() - 86400_000).run();
    if (!result.meta.changes) {
      if (!(await env.DB.prepare("SELECT id FROM reports WHERE id = ?").bind(report.id).first())) throw new Rejected(429, "Collector storage quota reached");
    }
    return json({ id: report.id }, 201);
  }
  if (path.startsWith("/admin/")) {
    await admin(request, env);
    if (path === "/admin/reports" && method === "GET") {
      const before = url.searchParams.get("before") ?? "";
      const category = string(url.searchParams.get("category") ?? "", 80);
      const [stamp, id] = before.split(":");
      require(!before || (/^\d{1,16}$/.test(stamp) && /^[a-f0-9]{32}$/.test(id)), "Invalid cursor");
      const cutoff = before ? Number(stamp) : Date.now() + 1;
      const result = await env.DB.prepare(`SELECT id, received_at, app_version, os, categories, event_count FROM reports
        WHERE received_at >= ? AND (received_at < ? OR (received_at = ? AND id < ?))
        AND (? = '' OR instr(',' || categories || ',', ',' || ? || ',') > 0)
        ORDER BY received_at DESC, id DESC LIMIT 50`)
        .bind(Date.now() - RETENTION_MS, cutoff, cutoff, id ?? "", category, category).all();
      const last = result.results.at(-1);
      return json({ reports: result.results, next: result.results.length === 50 ? `${last.received_at}:${last.id}` : null });
    }
    const id = path.match(/^\/admin\/reports\/([a-f0-9]{32})$/)?.[1];
    if (id && method === "GET") {
      const row = await env.DB.prepare("SELECT body FROM reports WHERE id = ? AND received_at >= ?").bind(id, Date.now() - RETENTION_MS).first();
      if (!row) throw new Rejected(404, "Not found");
      return new Response(row.body, { headers: { ...HEADERS, "Content-Type": "application/json" } });
    }
    if (id && method === "DELETE") { await env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(id).run(); return json({ deleted: id }); }
  }
  throw new Rejected(404, "Not found");
}
export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof Rejected) return json({ error: error.message }, error.status);
      // Never log request bodies, tokens, IPs, SQL bound values, or exception messages.
      console.error(JSON.stringify({ event: "collector_failure" }));
      return json({ error: "Collector unavailable" }, 503);
    }
  },
  async scheduled(_controller, env) {
    await env.DB.prepare("DELETE FROM reports WHERE received_at < ?").bind(Date.now() - RETENTION_MS).run();
  },
};
