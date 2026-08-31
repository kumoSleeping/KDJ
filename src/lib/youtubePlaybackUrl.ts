const CPN_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

function clientPlaybackNonce(): string {
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  return Array.from(random, (value) => CPN_ALPHABET[value % CPN_ALPHABET.length]).join("");
}

/** Attach the one stable playback nonce expected by WEB_REMIX direct GVS URLs. */
export function appendClientPlaybackNonce(
  rawUrl: string,
  nonce = clientPlaybackNonce(),
): string {
  if (!/^[A-Za-z0-9_-]{16}$/.test(nonce)) {
    throw new Error("YouTube client playback nonce 无效");
  }
  const url = new URL(rawUrl);
  if (!url.searchParams.has("cpn")) url.searchParams.set("cpn", nonce);
  return url.toString();
}
