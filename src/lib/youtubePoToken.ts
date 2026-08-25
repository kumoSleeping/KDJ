import { BotGuardClient } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import Innertube, { Platform, UniversalCache } from "youtubei.js";

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const TOKEN_SAFETY_MS = 60_000;

type BotguardRequest = (operation: "Create" | "GenerateIT", payload: unknown[]) => Promise<unknown>;
type MintCallback = (identifier: Uint8Array) => Uint8Array | Promise<Uint8Array>;

interface MinterLease {
  mint: MintCallback;
  expiresAt: number;
}

let minterLease: Promise<MinterLease> | null = null;
let botguardRequest: BotguardRequest | null = null;
const contentTokens = new Map<string, { value: string; expiresAt: number }>();
const players = new Map<string, Promise<Innertube>>();

// YouTube.js extracts only the current signature transform and gives it a tiny argument object.
Platform.shim.eval = async (data, args = {}) => {
  const names = Object.keys(args);
  const values = Object.values(args);
  return new Function(
    ...names,
    `${data.output}\nreturn typeof output !== "undefined" ? output : ` +
      `(typeof result !== "undefined" ? result : undefined);`,
  )(...values);
};

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

async function mintWebPoToken(binding: string): Promise<string> {
  if (!binding || binding.length > 4096) throw new Error("YouTube WebPO 绑定值无效");
  const cached = contentTokens.get(binding);
  if (cached && cached.expiresAt - TOKEN_SAFETY_MS > Date.now()) return cached.value;
  const lease = await currentMinter();
  const bytes = await lease.mint(new TextEncoder().encode(binding));
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error("YouTube BotGuard 没有生成 WebPO token");
  }
  const value = encodeWebSafeBase64(bytes);
  contentTokens.set(binding, { value, expiresAt: lease.expiresAt });
  return value;
}

/** Metrolist order: mint the Visitor/session token once before any video-bound token. */
export async function youtubeWebPoSession(
  videoId: string,
  visitorData: string,
  requestBotguard: BotguardRequest,
): Promise<{
  playerPoToken: string;
  gvsPoToken: string;
}> {
  const binding = videoId.trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(binding)) throw new Error("YouTube Music 视频 ID 无效");
  if (!visitorData || visitorData.length > 4096) throw new Error("YouTube Visitor 会话无效");
  botguardRequest = requestBotguard;
  const playerPoToken = await mintWebPoToken(visitorData);
  const gvsPoToken = await mintWebPoToken(binding);
  return { playerPoToken, gvsPoToken };
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
): Promise<Innertube> {
  let pending = players.get(playerUrl);
  if (pending) return pending;
  pending = (async () => {
    const javascript = await loadScript(playerUrl);
    if (!javascript || javascript.length > 8 * 1024 * 1024) {
      throw new Error("YouTube 播放器脚本无效");
    }
    return Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
      retrieve_innertube_config: false,
      player_id: playerId(playerUrl),
      fetch: async () => new Response(javascript, {
        status: 200,
        headers: { "Content-Type": "application/javascript" },
      }),
    });
  })().catch((error) => {
    players.delete(playerUrl);
    throw error;
  });
  players.set(playerUrl, pending);
  return pending;
}

/** Use YouTube.js only for the current official player's signature and n transforms. */
export async function decipherYoutubeWebStream(
  signatureCipher: string,
  playerUrl: string,
  poToken: string,
  loadScript: (playerUrl: string) => Promise<string>,
): Promise<string> {
  if (!signatureCipher || signatureCipher.length > 16 * 1024) {
    throw new Error("YouTube Music signatureCipher 无效");
  }
  const innertube = await currentPlayer(playerUrl, loadScript);
  const player = innertube.session.player;
  if (!player) throw new Error("YouTube 播放器签名器未就绪");
  const rawUrl = await player.decipher(undefined, signatureCipher, undefined);
  const url = new URL(rawUrl);
  url.searchParams.set("pot", poToken);
  return url.toString();
}
