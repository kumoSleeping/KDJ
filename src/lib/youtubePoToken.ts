import { BotGuardClient } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import { LightweightYoutubePlayer } from "./youtubePlayer/player";

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const TOKEN_SAFETY_MS = 60_000;
const CPN_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

type BotguardRequest = (operation: "Create" | "GenerateIT", payload: unknown[]) => Promise<unknown>;
type MintCallback = (identifier: Uint8Array) => Uint8Array | Promise<Uint8Array>;

interface MinterLease {
  mint: MintCallback;
  expiresAt: number;
}

let minterLease: Promise<MinterLease> | null = null;
let botguardRequest: BotguardRequest | null = null;
const contentTokens = new Map<string, { value: string; expiresAt: number }>();
const players = new Map<string, Promise<LightweightYoutubePlayer>>();

export type YoutubeWebPoBinding = "video_id" | "data_sync_id" | "visitor_data";

export function invalidateYoutubeWebPoSession(): void {
  // A GVS 401/403 invalidates the whole attestation episode. Keeping the old minter or content
  // token makes a UI retry deterministically submit the same rejected proof.
  contentTokens.clear();
  minterLease = null;
  botguardRequest = null;
}

function decodeWebSafeBase64(value: string): Uint8Array {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\./g, "=");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeWebSafeBase64(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

function clientPlaybackNonce(): string {
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  return Array.from(random, (value) => CPN_ALPHABET[value % CPN_ALPHABET.length]).join("");
}

export function appendClientPlaybackNonce(rawUrl: string, nonce = clientPlaybackNonce()): string {
  if (!/^[A-Za-z0-9_-]{16}$/.test(nonce)) throw new Error("YouTube client playback nonce 无效");
  const url = new URL(rawUrl);
  if (!url.searchParams.has("cpn")) url.searchParams.set("cpn", nonce);
  return url.toString();
}

interface ParsedChallenge {
  program: string;
  globalName: string;
  interpreterJavascript: string;
}

/** Port of Metrolist's JavaScriptUtil.parseChallengeData. */
function parseChallengeData(raw: unknown): ParsedChallenge {
  if (!Array.isArray(raw)) throw new Error("YouTube BotGuard challenge 无效");
  let challenge: unknown;
  if (raw.length > 1 && typeof raw[1] === "string") {
    const bytes = decodeWebSafeBase64(raw[1]);
    const descrambled = Uint8Array.from(bytes, (byte) => (byte + 97) & 0xff);
    challenge = JSON.parse(new TextDecoder().decode(descrambled));
  } else {
    challenge = raw[0];
  }
  if (!Array.isArray(challenge)) throw new Error("YouTube BotGuard challenge 格式无效");
  const interpreterValues = Array.isArray(challenge[1]) ? challenge[1] : [];
  const interpreterJavascript = interpreterValues.find((value) => typeof value === "string");
  const program = challenge[4];
  const globalName = challenge[5];
  if (typeof interpreterJavascript !== "string" || typeof program !== "string" || typeof globalName !== "string") {
    throw new Error("YouTube BotGuard challenge 数据不完整");
  }
  return { interpreterJavascript, program, globalName };
}

/** Port of Metrolist's PoTokenWebView initialization and minter lifecycle. */
async function createMinter(): Promise<MinterLease> {
  if (!botguardRequest) throw new Error("YouTube BotGuard 代理未初始化");
  const challenge = parseChallengeData(await botguardRequest("Create", [REQUEST_KEY]));
  new Function(challenge.interpreterJavascript)();

  const client = await BotGuardClient.create({
    program: challenge.program,
    globalName: challenge.globalName,
    globalObject: globalThis,
  });
  const signals: WebPoSignalOutput = [];
  const snapshot = await client.snapshot({ webPoSignalOutput: signals });
  const integrityResponse = await botguardRequest("GenerateIT", [REQUEST_KEY, snapshot]);
  if (!Array.isArray(integrityResponse) || typeof integrityResponse[0] !== "string") {
    throw new Error("YouTube BotGuard integrity token 无效");
  }
  const factory = signals[0] as unknown as
    ((integrityToken: Uint8Array) => MintCallback | Promise<MintCallback>) | undefined;
  if (typeof factory !== "function") throw new Error("YouTube BotGuard minter 不可用");
  const mint = await factory(decodeWebSafeBase64(integrityResponse[0]));
  if (typeof mint !== "function") throw new Error("YouTube BotGuard mint callback 无效");
  const ttlSeconds = typeof integrityResponse[1] === "number" ? integrityResponse[1] : 3600;
  return {
    mint,
    expiresAt: Date.now() + Math.max(60, ttlSeconds - 600) * 1000,
  };
}

async function currentMinter(): Promise<MinterLease> {
  if (minterLease) {
    const lease = await minterLease;
    if (lease.expiresAt - TOKEN_SAFETY_MS > Date.now()) return lease;
    minterLease = null;
    contentTokens.clear();
  }
  minterLease = createMinter().catch((error) => {
    minterLease = null;
    throw error;
  });
  return minterLease;
}

/** Warm the account-independent attestation episode before the first playback gesture. */
export async function prewarmYoutubeWebPoMinter(requestBotguard: BotguardRequest): Promise<void> {
  botguardRequest = requestBotguard;
  await currentMinter();
}

async function mintWebPoToken(binding: string, cacheKey = binding): Promise<string> {
  if (!binding || binding.length > 4096) throw new Error("YouTube WebPO 绑定值无效");
  const cached = contentTokens.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_SAFETY_MS > Date.now()) return cached.value;
  const lease = await currentMinter();
  const bytes = await lease.mint(new TextEncoder().encode(binding));
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error("YouTube BotGuard 没有生成 WebPO token");
  }
  const value = encodeWebSafeBase64(bytes);
  contentTokens.set(cacheKey, { value, expiresAt: lease.expiresAt });
  return value;
}

/** Mint the one GVS proof selected by the page's current content-binding policy. */
export async function youtubeWebPoSession(
  videoId: string,
  visitorData: string,
  dataSyncId: string,
  gvsBinding: YoutubeWebPoBinding,
  requestBotguard: BotguardRequest,
  forceFresh = false,
): Promise<{
  playerPoToken: string;
  playerPoTokens: string[];
  gvsPoToken: string;
  gvsPoTokens: string[];
}> {
  const normalizedVideoId = videoId.trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(normalizedVideoId)) throw new Error("YouTube Music 视频 ID 无效");
  if (!visitorData || visitorData.length > 4096) throw new Error("YouTube Visitor 会话无效");
  if (forceFresh) invalidateYoutubeWebPoSession();
  botguardRequest = requestBotguard;
  const binding = gvsBinding === "video_id"
    ? normalizedVideoId
    : gvsBinding === "data_sync_id"
      ? dataSyncId
      : visitorData;
  if (!binding || binding.length > 4096) {
    throw new Error("YouTube GVS " + gvsBinding + " 绑定值不可用");
  }
  const playerKey = "visitor_data:" + visitorData;
  const gvsKey = gvsBinding + ":" + binding;
  // SABR accepts the long-lived minter episode produced in KDJ's already-running WebView. Keep
  // that episode warm instead of creating and closing a second WebView for every double-click.
  const cachedPlayer = contentTokens.get(playerKey);
  const cachedGvs = contentTokens.get(gvsKey);
  if (
    cachedPlayer && cachedGvs
    && cachedPlayer.expiresAt - TOKEN_SAFETY_MS > Date.now()
    && cachedGvs.expiresAt - TOKEN_SAFETY_MS > Date.now()
  ) {
    return {
      playerPoToken: cachedPlayer.value,
      playerPoTokens: [cachedPlayer.value],
      gvsPoToken: cachedGvs.value,
      gvsPoTokens: [cachedGvs.value],
    };
  }
  const playerPoToken = await mintWebPoToken(visitorData, playerKey);
  const gvsPoToken = await mintWebPoToken(binding, gvsKey);
  return { playerPoToken, playerPoTokens: [playerPoToken], gvsPoToken, gvsPoTokens: [gvsPoToken] };
}

function playerId(playerUrl: string): string {
  const id = new URL(playerUrl, "https://www.youtube.com")
    .pathname.match(/^\/s\/player\/([^/]+)\//)?.[1];
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("YouTube 播放器脚本地址无效");
  }
  return id;
}

async function currentPlayer(
  playerUrl: string,
  loadScript: (playerUrl: string) => Promise<string>,
): Promise<LightweightYoutubePlayer> {
  let pending = players.get(playerUrl);
  if (pending) return pending;
  pending = (async () => {
    const javascript = await loadScript(playerUrl);
    if (!javascript || javascript.length > 8 * 1024 * 1024) {
      throw new Error("YouTube 播放器脚本无效");
    }
    playerId(playerUrl); // Reject non-player script URLs before evaluating extracted code.
    return LightweightYoutubePlayer.create(javascript);
  })().catch((error) => {
    players.delete(playerUrl);
    throw error;
  });
  players.set(playerUrl, pending);
  return pending;
}

/** STS 必须和执行 sig/n 变换的是同一份 player.js；硬编码值在播放器轮换后会 403。 */
export async function youtubeWebPlayerConfig(
  playerUrl: string,
  loadScript: (playerUrl: string) => Promise<string>,
): Promise<{ signatureTimestamp: number }> {
  const innertube = await currentPlayer(playerUrl, loadScript);
  const signatureTimestamp = innertube.signatureTimestamp;
  if (!Number.isSafeInteger(signatureTimestamp) || signatureTimestamp <= 0) {
    throw new Error("YouTube 播放器签名时间戳无效");
  }
  return { signatureTimestamp };
}

/** Use KDJ's narrow extractor only for the current official player's sig/n transforms. */
export async function decipherYoutubeWebStream(
  signatureCipher: string,
  playerUrl: string,
  poToken: string,
  loadScript: (playerUrl: string) => Promise<string>,
): Promise<string> {
  if (!signatureCipher || signatureCipher.length > 16 * 1024) {
    throw new Error("YouTube Music signatureCipher 无效");
  }
  const rawUrl = await decipherYoutubeWebUrl(signatureCipher, playerUrl, loadScript);
  const url = new URL(rawUrl);
  url.searchParams.set("pot", poToken);
  // Current WEB_REMIX attaches one 16-char client playback nonce to every selected direct URL.
  // The PO token proves the content binding; cpn identifies this playback session to GVS.
  return appendClientPlaybackNonce(url.toString());
}

/** SABR carries the GVS proof inside its protobuf body, never as a pot query parameter. */
export async function decipherYoutubeWebUrl(
  cipherOrUrl: string,
  playerUrl: string,
  loadScript: (playerUrl: string) => Promise<string>,
): Promise<string> {
  if (!cipherOrUrl || cipherOrUrl.length > 16 * 1024) {
    throw new Error("YouTube Music 媒体 URL 无效");
  }
  const innertube = await currentPlayer(playerUrl, loadScript);
  return innertube.decipher(cipherOrUrl);
}
