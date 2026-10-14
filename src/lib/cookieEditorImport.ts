import type { Platform } from "../types";

export const MAX_EXPORT_BYTES = 256 * 1024;

/** The site whose login each platform takes; the same sites the backend opens in a browser. */
export const LOGIN_SITES: Partial<Record<Platform, string>> = {
  wyy: "music.163.com",
  qqm: "y.qq.com",
  bilibili: "www.bilibili.com",
  soundcloud: "soundcloud.com",
  ytm: "music.youtube.com",
  youtube: "www.youtube.com",
};

/** One of these is in every login of the platform; an export without any is not a login. */
const LOGIN_COOKIES: Partial<Record<Platform, string[]>> = {
  wyy: ["MUSIC_U"],
  qqm: ["qm_keyst", "qqmusic_key"],
  bilibili: ["SESSDATA"],
  soundcloud: ["oauth_token"],
  ytm: ["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"],
  youtube: ["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"],
};

const NOT_AN_EXPORT = "这不是 Cookie-Editor 导出的内容；请在浏览器里重新导出";

/**
 * What the Cookie-Editor extension exports (JSON, Netscape or Header String), as the one
 * `Cookie:` line the login API takes: only the cookies the platform's site would be sent.
 * The input is a login: it is never logged, and no error quotes it.
 */
export function exportedLoginHeaders(raw: string, platform: Platform): string {
  const host = LOGIN_SITES[platform];
  if (!host) throw new Error("这个平台不能这样登录");
  if (new TextEncoder().encode(raw).length > MAX_EXPORT_BYTES) {
    throw new Error("导出的内容过大，请只导出当前站点");
  }
  const text = raw.trim();
  if (!text) throw new Error("剪贴板里没有导出的内容；请先在浏览器里用 Cookie-Editor 导出");
  const cookies = new Map<string, string>();
  const add = (name: unknown, value: unknown) => {
    if (typeof name !== "string" || typeof value !== "string"
      || !/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/.test(name)
      || /[\x00-\x20\x7f;]/.test(value)) {
      throw new Error(NOT_AN_EXPORT);
    }
    if (!value) return;
    if (cookies.has(name) && cookies.get(name) !== value) {
      throw new Error("导出的内容里有两份不同的登录，请只导出当前站点的一个账号");
    }
    cookies.set(name, value);
  };
  const relevant = (domain: unknown, path: unknown, expiry: unknown): boolean => {
    if (typeof domain !== "string" || typeof path !== "string") throw new Error(NOT_AN_EXPORT);
    const normalized = domain.toLowerCase().replace(/^\./, "");
    // A host-only cookie from another subdomain must never be sent to the selected site.
    if (!normalized.includes(".") || !(host === normalized || (domain.startsWith(".") && host.endsWith("." + normalized)))) return false;
    if (path !== "/") return false;
    if (expiry !== undefined && (typeof expiry !== "number" || !Number.isFinite(expiry))) throw new Error(NOT_AN_EXPORT);
    return !(typeof expiry === "number" && expiry > 0 && expiry <= Date.now() / 1000);
  };

  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("导出的内容不完整，请重新导出"); }
    const entries = Array.isArray(parsed) ? parsed
      : parsed && typeof parsed === "object" && "cookies" in parsed ? parsed.cookies : null;
    if (!Array.isArray(entries)) throw new Error(NOT_AN_EXPORT);
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") throw new Error(NOT_AN_EXPORT);
      if (relevant(entry.domain, entry.path, entry.expirationDate ?? entry.expires)) add(entry.name, entry.value);
    }
  } else if (text.includes("\t") || text.startsWith("#")) {
    for (const original of text.split(/\r?\n/)) {
      if (!original.trim() || (original.startsWith("#") && !original.startsWith("#HttpOnly_"))) continue;
      const line = original.replace(/^#HttpOnly_/, "");
      const fields = line.split("\t");
      if (fields.length !== 7 || !/^(TRUE|FALSE)$/i.test(fields[1])
        || !/^(TRUE|FALSE)$/i.test(fields[3]) || !/^-?\d+(\.\d+)?$/.test(fields[4])) {
        throw new Error(NOT_AN_EXPORT);
      }
      const [domain, , path, , expires, name, value] = fields;
      if (relevant(domain, path, Number(expires))) add(name, value);
    }
  } else {
    // The Header String export carries no domains: it is taken as the site's own.
    const header = text.replace(/^cookie:\s*/i, "");
    if (/[\r\n]/.test(header)) throw new Error(NOT_AN_EXPORT);
    for (const pair of header.split(";")) {
      if (!pair.trim()) continue;
      const index = pair.indexOf("=");
      if (index < 1) throw new Error(NOT_AN_EXPORT);
      add(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
  if (!LOGIN_COOKIES[platform]?.some(name => cookies.has(name))) {
    throw new Error(`导出的内容里没有 ${host} 的登录；请在已登录的那个页面上重新导出`);
  }
  return "Cookie: " + [...cookies].map(([name, value]) => name + "=" + value).join("; ");
}
