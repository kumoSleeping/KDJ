export function pairingTarget(code) {
  const match = /^KDJ-SC1:([1-9][0-9]{0,4}):([a-f0-9]{64})$/.exec(code.trim());
  if (!match || Number(match[1]) > 65535) throw new Error("配对码无效");
  return { url: `http://127.0.0.1:${match[1]}/connect`, token: match[2] };
}

export function soundcloudSession(cookies, now = Date.now() / 1000) {
  const candidates = cookies.filter(cookie =>
    cookie.name === "oauth_token" && cookie.domain.replace(/^\./, "") === "soundcloud.com" &&
    typeof cookie.value === "string" && cookie.value.trim().length > 0 && cookie.value.length <= 4096 &&
    (cookie.session === true || (Number.isFinite(cookie.expirationDate) && cookie.expirationDate > now))
  ).sort((a, b) => (b.session ? Infinity : b.expirationDate) - (a.session ? Infinity : a.expirationDate));
  if (!candidates.length) throw new Error("当前浏览器 Profile 没有有效的 SoundCloud 登录");
  const cookie = candidates[0];
  return { access_token: cookie.value.trim(), expires_at: cookie.session ? 0 : Math.floor(cookie.expirationDate) };
}

export async function connectSession(code, cookiesApi, fetchApi = fetch) {
  const target = pairingTarget(code);
  // Browser handles App-Bound Encryption. Never read another site's cookies.
  const cookies = await cookiesApi.getAll({ url: "https://soundcloud.com/", name: "oauth_token" });
  const session = soundcloudSession(cookies);
  const response = await fetchApi(target.url, {
    method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
    headers: { "Authorization": `Bearer ${target.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(session), signal: AbortSignal.timeout(35_000),
  });
  if (!response.ok) {
    if ([401, 410].includes(response.status)) throw new Error("配对码已失效，请在 KDJ 重新生成");
    throw new Error("连接失败，请检查 KDJ 来源开关、网络和 SoundCloud 登录后重新配对");
  }
}
