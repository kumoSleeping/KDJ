/**
 * Runs only in KDJ's non-persistent native proof WebView.
 *
 * The document is local HTML committed with a YouTube base URL by WKWebView. It has no Tauri IPC,
 * no imported cookies and a restrictive CSP; only the anonymous YouTube homepage, Google's fixed
 * BotGuard interpreter path and GenerateIT are reachable.
 */
import { BotGuardClient } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import { parseLooseJSON } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";
import { LightweightYoutubePlayer } from "./youtubePlayer/player";

const YOUTUBE_ORIGIN = "https://www.youtube.com";
const PROOF_DOCUMENT_URL = `${YOUTUBE_ORIGIN}/robots.txt`;
const PROOF_CSP = "default-src 'none'; "
  + "script-src 'unsafe-eval' https://www.google.com; "
  + "connect-src https://www.youtube.com https://jnn-pa.googleapis.com; "
  + "img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; "
  + "object-src 'none'; frame-src 'none'; worker-src 'none'; "
  + "base-uri 'none'; form-action 'none'";
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const GENERATE_IT_URL =
  "https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT";
const TOKEN_SAFETY_MS = 60_000;

interface ChallengeData {
  program: string;
  globalName: string;
  interpreterUrl: {
    privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: string;
  };
}

interface MinterLease {
  minter: WebPoMinter;
  expiresAt: number;
}

let minterLease: Promise<MinterLease> | null = null;
const players = new Map<string, Promise<LightweightYoutubePlayer>>();

function hardenProofDocument(): void {
  if (location.href !== PROOF_DOCUMENT_URL) {
    throw new Error("YouTube proof 网络文档不匹配");
  }
  if (document.querySelector('meta[data-kdj-youtube-proof-csp="1"]')) return;
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = PROOF_CSP;
  meta.dataset.kdjYoutubeProofCsp = "1";
  const head = document.head;
  if (!head) throw new Error("YouTube proof 网络文档结构无效");
  head.prepend(meta);
  document.body?.replaceChildren();
  document.title = "KDJ YouTube proof runtime";
}

hardenProofDocument();

function securityBoundaryIntact(): boolean {
  const global = globalThis as typeof globalThis & {
    __TAURI_INTERNALS__?: unknown;
    ipc?: unknown;
    webkit?: { messageHandlers?: { ipc?: unknown } };
  };
  return location.href === PROOF_DOCUMENT_URL
    && global.__TAURI_INTERNALS__ === undefined
    && global.ipc === undefined
    && global.webkit?.messageHandlers?.ipc === undefined;
}

function extractBalancedObjectAfter(html: string, marker: string): string | null {
  let searchFrom = 0;
  while (searchFrom < html.length) {
    const markerOffset = html.indexOf(marker, searchFrom);
    if (markerOffset < 0) return null;
    const markerEnd = markerOffset + marker.length;
    const objectStart = html.indexOf("{", markerEnd);
    if (objectStart >= markerEnd && objectStart - markerEnd <= 64) {
      let depth = 0;
      let quote = "";
      let escaped = false;
      for (let offset = objectStart; offset < html.length; offset += 1) {
        const char = html[offset];
        if (quote) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === quote) quote = "";
          continue;
        }
        if (char === "\"" || char === "'") quote = char;
        else if (char === "{") depth += 1;
        else if (char === "}" && --depth === 0) return html.slice(objectStart, offset + 1);
      }
    }
    searchFrom = markerEnd;
  }
  return null;
}

function trustedInterpreterUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2_048 || /[\r\n]/.test(value)) {
    throw new Error("YouTube BotGuard interpreter 地址无效");
  }
  const url = new URL(value.startsWith("//") ? `https:${value}` : value);
  const file = url.pathname.startsWith("/js/th/") ? url.pathname.slice("/js/th/".length) : "";
  if (
    url.protocol !== "https:"
    || url.hostname !== "www.google.com"
    || url.port
    || !file
    || file.includes("/")
    || !file.endsWith(".js")
    || !/^[A-Za-z0-9_.-]+$/.test(file)
    || url.search
    || url.hash
    || url.username
    || url.password
  ) throw new Error("YouTube BotGuard interpreter 地址不受信任");
  return url.toString();
}

async function homepageChallenge(): Promise<ChallengeData> {
  const response = await fetch(`${YOUTUBE_ORIGIN}/`, {
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "*/*", "accept-language": "en-US,en;q=0.7" },
  });
  if (!response.ok || new URL(response.url).origin !== YOUTUBE_ORIGIN) {
    throw new Error("YouTube 首页 challenge 请求失败");
  }
  const html = await response.text();
  if (!html || html.length > 4 * 1024 * 1024) throw new Error("YouTube 首页大小异常");
  const rawConfig = extractBalancedObjectAfter(html, "ytcfg.set(");
  const rawAttestation = extractBalancedObjectAfter(html, "window.ytAtN(");
  if (!rawConfig || !rawAttestation) throw new Error("YouTube 首页 challenge 缺失");
  const config = JSON.parse(rawConfig) as Record<string, unknown>;
  const attestation = parseLooseJSON(rawAttestation) as {
    R?: { bgChallenge?: Partial<ChallengeData> };
  };
  const challenge = attestation?.R?.bgChallenge;
  if (
    typeof config.EVENT_ID !== "string"
    || !config.EVENT_ID
    || typeof challenge?.program !== "string"
    || !challenge.program
    || challenge.program.length > 4 * 1024 * 1024
    || typeof challenge.globalName !== "string"
    || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(challenge.globalName)
    || !challenge.interpreterUrl
  ) throw new Error("YouTube 首页 challenge 数据不完整");
  (globalThis as typeof globalThis & { yt?: unknown }).yt = { config_: config };
  return challenge as ChallengeData;
}

async function loadInterpreter(rawUrl: unknown): Promise<void> {
  const url = trustedInterpreterUrl(rawUrl);
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.referrerPolicy = "no-referrer";
    script.onload = () => {
      script.remove();
      resolve();
    };
    script.onerror = () => {
      script.remove();
      reject(new Error("YouTube BotGuard interpreter 加载失败"));
    };
    document.head.append(script);
  });
}

async function createMinter(): Promise<MinterLease> {
  if (!securityBoundaryIntact()) throw new Error("YouTube 原生 proof 隔离检查失败");
  const challenge = await homepageChallenge();
  await loadInterpreter(
    challenge.interpreterUrl.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue,
  );
  const signals: WebPoSignalOutput = [];
  const client = await BotGuardClient.create({
    program: challenge.program,
    globalName: challenge.globalName,
    globalObject: globalThis,
  });
  const snapshot = await client.snapshot({ webPoSignalOutput: signals });
  const response = await fetch(GENERATE_IT_URL, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    headers: {
      "content-type": "application/json+protobuf",
      "x-goog-api-key": "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw",
      "x-user-agent": "grpc-web-javascript/0.1",
    },
    body: JSON.stringify([REQUEST_KEY, snapshot]),
  });
  if (!response.ok) throw new Error("YouTube BotGuard GenerateIT 请求失败");
  const rawIntegrity = await response.text();
  if (!rawIntegrity || rawIntegrity.length > 64 * 1024) {
    throw new Error("YouTube BotGuard GenerateIT 响应异常");
  }
  const integrity = JSON.parse(rawIntegrity) as [string, number, number, string];
  if (!Array.isArray(integrity) || typeof integrity[0] !== "string" || !integrity[0]) {
    throw new Error("YouTube BotGuard 拒绝完整性快照");
  }
  const estimatedTtlSecs = Number.isFinite(integrity[1]) ? integrity[1] : 3_600;
  const minter = await WebPoMinter.create({
    integrityToken: integrity[0],
    estimatedTtlSecs,
    mintRefreshThreshold: integrity[2],
    websafeFallbackToken: integrity[3],
  }, signals);
  return {
    minter,
    expiresAt: Date.now() + Math.max(60, estimatedTtlSecs - 600) * 1_000,
  };
}

async function currentMinter(forceFresh: boolean): Promise<MinterLease> {
  if (forceFresh) {
    minterLease = null;
  }
  if (minterLease) {
    const lease = await minterLease;
    if (lease.expiresAt - TOKEN_SAFETY_MS > Date.now()) return lease;
    minterLease = null;
  }
  minterLease = createMinter().catch((error) => {
    minterLease = null;
    throw error;
  });
  return minterLease;
}

async function mint(binding: string, forceFresh = false): Promise<string> {
  if (!securityBoundaryIntact()) throw new Error("YouTube 原生 proof 隔离检查失败");
  if (!binding || binding.length > 4_096 || /[\u0000-\u001f\u007f]/.test(binding)) {
    throw new Error("YouTube GVS 绑定值无效");
  }
  const lease = await currentMinter(forceFresh);
  // Reuse only the expensive BotGuard minter, never a content-bound result. Ordinary YouTube and
  // YouTube Music can legitimately ask for the same video-id binding under different signed
  // playback contexts; returning an earlier token crosses those contexts and GVS rejects the
  // otherwise valid media URL. Minting from an existing lease is local and cheap.
  const value = await lease.minter.mintAsWebsafeString(binding);
  if (!/^[A-Za-z0-9_.=-]{20,4096}$/.test(value)) {
    throw new Error("YouTube BotGuard 没有生成合法 GVS token");
  }
  return value;
}

function trustedPlayerId(rawUrl: string): string {
  const url = new URL(rawUrl, YOUTUBE_ORIGIN);
  const host = url.hostname.toLowerCase();
  const id = url.pathname.match(/^\/s\/player\/([^/]+)\/.+\/base\.js$/)?.[1];
  if (
    url.protocol !== "https:"
    || (host !== "youtube.com" && !host.endsWith(".youtube.com"))
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !id
    || !/^[A-Za-z0-9_-]+$/.test(id)
  ) throw new Error("YouTube 播放器脚本地址不受信任");
  return id;
}

async function currentPlayer(
  playerUrl: string,
  javascript: string,
): Promise<LightweightYoutubePlayer> {
  trustedPlayerId(playerUrl);
  if (!javascript || javascript.length > 8 * 1024 * 1024 || javascript.includes("\0")) {
    throw new Error("YouTube 播放器脚本无效");
  }
  let pending = players.get(playerUrl);
  if (!pending) {
    pending = Promise.resolve().then(() => LightweightYoutubePlayer.create(javascript));
    players.set(playerUrl, pending);
    void pending.catch(() => players.delete(playerUrl));
  }
  return pending;
}

async function player(
  operation: "config" | "decipher" | "transform_n",
  playerUrl: string,
  javascript: string,
  value = "",
): Promise<string> {
  if (!securityBoundaryIntact()) throw new Error("YouTube 原生 player 隔离检查失败");
  const runtime = await currentPlayer(playerUrl, javascript);
  if (operation === "config") return String(runtime.signatureTimestamp);
  if (operation === "decipher") return runtime.decipher(value);
  if (operation === "transform_n") return runtime.transformN(value);
  throw new Error("YouTube 原生 player 操作无效");
}

Object.defineProperty(globalThis, "__KDJ_YOUTUBE_NATIVE_PO__", {
  value: Object.freeze({ mint, player }),
  configurable: false,
  enumerable: false,
  writable: false,
});
