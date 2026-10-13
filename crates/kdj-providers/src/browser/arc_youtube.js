// The site and names are fixed by Rust, never supplied by a page or the renderer.
(() => {
  if (location.origin !== __SITE_ORIGIN__) return JSON.stringify({ status: "wrong_site" });
  if (document.readyState === "loading") return JSON.stringify({ status: "loading" });
  const allowed = new Set(__COOKIE_NAMES__);
  const cookies = new Map();
  for (const part of document.cookie.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim(), value = part.slice(index + 1).trim();
    if (!allowed.has(name) || !value || value.length > 16384 || /[\x00-\x1f\x7f;]/.test(value)) continue;
    if (cookies.has(name) && cookies.get(name) !== value) return JSON.stringify({ status: "ambiguous" });
    cookies.set(name, value);
  }
  if (!["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"].some(name => cookies.has(name))) {
    return JSON.stringify({ status: "not_logged_in" });
  }
  const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  if (cookie.length > 128 * 1024) return JSON.stringify({ status: "invalid_session" });
  return JSON.stringify({ status: "ok", cookie, metadata: {
    authUser: String(globalThis.ytcfg?.get?.("SESSION_INDEX") ?? "0"), userAgent: navigator.userAgent,
  } });
})()
