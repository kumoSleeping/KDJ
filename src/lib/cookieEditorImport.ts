import type { Platform } from "../types";

export const MAX_COOKIE_IMPORT_BYTES = 256 * 1024;

/** Convert an explicit Cookie-Editor export to the existing login API's Cookie header.
 * Never log the input or include cookie contents in parsing errors.
 */
export function cookieEditorHeaders(raw: string, platform: Platform): string {
  const host = platform === "soundcloud" ? "soundcloud.com"
    : platform === "ytm" ? "music.youtube.com"
      : platform === "youtube" ? "www.youtube.com"
        : platform === "bilibili" ? "www.bilibili.com"
          : platform === "wyy" ? "music.163.com"
            : platform === "qqm" ? "y.qq.com" : null;
  if (!host) throw new Error("此平台暂不支持 Cookie-Editor 导入");
  if (new TextEncoder().encode(raw).length > MAX_COOKIE_IMPORT_BYTES) {
    throw new Error("Cookie 文件过大，请只导出当前站点");
  }
  const text = raw.trim();
  if (!text) throw new Error("请粘贴 Cookie-Editor 导出内容或选择文件");
  const cookies = new Map<string, string>();
  const add = (name: unknown, value: unknown) => {
    if (typeof name !== "string" || typeof value !== "string"
      || !/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/.test(name)
      || /[\x00-\x20\x7f;]/.test(value)) {
      throw new Error("Cookie 格式无效，请重新导出");
    }
    if (!value) return;
    if (cookies.has(name) && cookies.get(name) !== value) {
      throw new Error("导出内容含有冲突的登录状态，请只导出当前站点的一个账号");
    }
    cookies.set(name, value);
  };
  const relevant = (domain: unknown, path: unknown, expiry: unknown): boolean => {
    if (typeof domain !== "string" || typeof path !== "string") {
      throw new Error("Cookie 缺少有效的域名或路径");
    }
    const normalized = domain.toLowerCase().replace(/^\./, "");
    // A host-only cookie from another subdomain must never be sent to the selected site.
    if (!normalized.includes(".") || !(host === normalized || (domain.startsWith(".") && host.endsWith("." + normalized)))) return false;
    if (path !== "/") return false;
    if (expiry !== undefined && (typeof expiry !== "number" || !Number.isFinite(expiry))) {
      throw new Error("Cookie 有效期格式无效");
    }
    return !(typeof expiry === "number" && expiry > 0 && expiry <= Date.now() / 1000);
  };

  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("JSON 格式无效，请复制完整的 Cookie-Editor 导出内容"); }
    const entries = Array.isArray(parsed) ? parsed
      : parsed && typeof parsed === "object" && "cookies" in parsed ? parsed.cookies : null;
    if (!Array.isArray(entries)) throw new Error("需要 Cookie-Editor 导出的 Cookie 数组");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") throw new Error("Cookie JSON 格式无效");
      if (relevant(entry.domain, entry.path, entry.expirationDate ?? entry.expires)) add(entry.name, entry.value);
    }
  } else if (text.includes("\t") || text.startsWith("#")) {
    for (const original of text.split(/\r?\n/)) {
      if (!original.trim() || (original.startsWith("#") && !original.startsWith("#HttpOnly_"))) continue;
      const line = original.replace(/^#HttpOnly_/, "");
      const fields = line.split("\t");
      if (fields.length !== 7 || !/^(TRUE|FALSE)$/i.test(fields[1])
        || !/^(TRUE|FALSE)$/i.test(fields[3]) || !/^-?\d+(\.\d+)?$/.test(fields[4])) {
        throw new Error("cookies.txt 格式无效，需要 Netscape 格式");
      }
      const [domain, , path, , expires, name, value] = fields;
      if (relevant(domain, path, Number(expires))) add(name, value);
    }
  } else {
    // Cookie-Editor's Header String export has no domain metadata.
    const header = text.replace(/^cookie:\s*/i, "");
    if (/[\r\n]/.test(header)) throw new Error("请使用 Cookie-Editor 的 JSON、Netscape 或 Header String 导出");
    for (const pair of header.split(";")) {
      if (!pair.trim()) continue;
      const index = pair.indexOf("=");
      if (index < 1) throw new Error("Cookie 格式无效，请重新导出");
      add(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
  const required = platform === "soundcloud" ? ["oauth_token"]
    : platform === "bilibili" ? ["SESSDATA"]
      : platform === "wyy" ? ["MUSIC_U"]
        : platform === "qqm" ? ["qm_keyst", "qqmusic_key"]
          : ["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"];
  if (!required.some(name => cookies.has(name))) {
    throw new Error("未找到当前平台有效的登录 Cookie，请从已登录的站点重新导出");
  }
  return "Cookie: " + [...cookies].map(([name, value]) => name + "=" + value).join("; ");
}
