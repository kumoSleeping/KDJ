// Runs only through Arc's user-approved Apple Events interface. Never return all cookies.
(() => {
  if (location.origin !== "https://soundcloud.com") return JSON.stringify({ status: "wrong_site" });
  if (document.readyState === "loading") return JSON.stringify({ status: "loading" });
  const tokens = [...new Set(document.cookie.split(";").flatMap(part => {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== "oauth_token") return [];
    try {
      const token = decodeURIComponent(part.slice(index + 1));
      return token && token.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(token) ? [token] : [];
    } catch { return []; }
  }))];
  if (tokens.length > 1) return JSON.stringify({ status: "ambiguous" });
  return JSON.stringify(tokens.length ? { status: "ok", token: tokens[0] } : { status: "not_logged_in" });
})()
