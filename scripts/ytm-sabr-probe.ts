/**
 * Minimal real-network YouTube Music playback proof.
 *
 * This deliberately does not use KDJ's Rust server, spool, player, or Tauri IPC. It proves the
 * smallest useful chain first: authenticated WEB_REMIX identity, warm WebPO minter/player script,
 * concurrent Player plus video-bound proof, SABR/UMP audio, complete MP4, then ffprobe.
 *
 * Usage: npm run probe:ytm-sabr -- wO3lCCoWuSc /tmp/kdj-ytm-sabr-probe.m4a
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { BotGuardClient } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import { SabrStream } from "googlevideo/sabr-stream";
import type { SabrFormat } from "googlevideo/shared-types";
import { buildSabrFormat, EnabledTrackTypes } from "googlevideo/utils";
import { JSDOM } from "jsdom";

import { LightweightYoutubePlayer } from "../src/lib/youtubePlayer/player";

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const BOTGUARD_KEY = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw";
const BOTGUARD_BASE = "https://www.youtube.com/api/jnn/v1";
const MUSIC_ORIGIN = "https://music.youtube.com";
const CLIENT_VERSION = "1.20260707.12.00";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";

const videoId = process.argv[2] || "wO3lCCoWuSc";
const outputPath = process.argv[3] || "/tmp/kdj-ytm-sabr-probe.m4a";
const sessionPath = process.env.KDJ_YTM_SESSION
  || (process.env.HOME
    + "/Library/Application Support/com.kdj.app.labs/data/sessions/youtube-music-browser.json");

if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("invalid YouTube video ID");

const startedAt = performance.now();
let clickStartedAt = startedAt;
function mark(stage: string, extra = ""): void {
  const now = performance.now();
  console.log(
    stage.padEnd(22)
      + " total=" + (now - startedAt).toFixed(1).padStart(8) + "ms"
      + " click=" + (now - clickStartedAt).toFixed(1).padStart(8) + "ms "
      + extra,
  );
}

function extractConfigString(html: string, name: string): string {
  const quote = String.fromCharCode(34);
  const marker = quote + name + quote + ":" + quote;
  const start = html.indexOf(marker);
  if (start < 0) return "";
  let end = start + marker.length;
  let escaped = false;
  while (end < html.length) {
    const char = html[end];
    if (char === quote && !escaped) break;
    escaped = char.charCodeAt(0) === 92 ? !escaped : false;
    end += 1;
  }
  return JSON.parse(quote + html.slice(start + marker.length, end) + quote) as string;
}

function cookieMap(cookie: string): Record<string, string> {
  return Object.fromEntries(cookie.split(";").map((part) => {
    const equals = part.indexOf("=");
    return [part.slice(0, equals).trim(), part.slice(equals + 1)];
  }));
}

function sapisidAuthorization(cookie: string): string {
  const values = cookieMap(cookie);
  const sapisid = values.SAPISID
    || values["__Secure-3PAPISID"]
    || values["__Secure-1PAPISID"];
  if (!sapisid) return "";
  const seconds = Math.floor(Date.now() / 1000);
  const digest = createHash("sha1")
    .update(seconds + " " + sapisid + " " + MUSIC_ORIGIN)
    .digest("hex");
  return "SAPISIDHASH " + seconds + "_" + digest;
}

function decodeWebSafeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "/").replace(/\./g, "="),
    "base64",
  ));
}

function encodeWebSafeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

interface ParsedChallenge {
  interpreterJavascript: string;
  program: string;
  globalName: string;
}

function parseChallenge(raw: unknown): ParsedChallenge {
  if (!Array.isArray(raw)) throw new Error("invalid BotGuard challenge");
  let challenge: unknown;
  if (raw.length > 1 && typeof raw[1] === "string") {
    const bytes = decodeWebSafeBase64(raw[1]);
    const descrambled = Uint8Array.from(bytes, (byte) => (byte + 97) & 0xff);
    challenge = JSON.parse(new TextDecoder().decode(descrambled));
  } else {
    challenge = raw[0];
  }
  if (!Array.isArray(challenge)) throw new Error("invalid descrambled BotGuard challenge");
  const interpreterValues = Array.isArray(challenge[1]) ? challenge[1] : [];
  const interpreterJavascript = interpreterValues.find((value) => typeof value === "string");
  const program = challenge[4];
  const globalName = challenge[5];
  if (
    typeof interpreterJavascript !== "string"
    || typeof program !== "string"
    || typeof globalName !== "string"
  ) {
    throw new Error("incomplete BotGuard challenge");
  }
  return { interpreterJavascript, program, globalName };
}

async function botguardRpc(operation: "Create" | "GenerateIT", payload: unknown[]): Promise<unknown> {
  const response = await fetch(BOTGUARD_BASE + "/" + operation, {
    method: "POST",
    headers: {
      "content-type": "application/json+protobuf",
      "x-goog-api-key": BOTGUARD_KEY,
      "x-user-agent": "grpc-web-javascript/0.1",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("BotGuard " + operation + " HTTP " + response.status);
  return response.json();
}

type MintCallback = (binding: Uint8Array) => Uint8Array | Promise<Uint8Array>;

async function createWarmMinter(): Promise<{
  mint: (binding: string) => Promise<string>;
  shutdown: () => void;
}> {
  const dom = new JSDOM();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const challenge = parseChallenge(await botguardRpc("Create", [REQUEST_KEY]));
  new Function(challenge.interpreterJavascript)();
  const client = await BotGuardClient.create({
    program: challenge.program,
    globalName: challenge.globalName,
    globalObject: globalThis,
  });
  const signals: WebPoSignalOutput = [];
  const snapshot = await client.snapshot({ webPoSignalOutput: signals });
  const integrity = await botguardRpc("GenerateIT", [REQUEST_KEY, snapshot]);
  if (!Array.isArray(integrity) || typeof integrity[0] !== "string") {
    throw new Error("invalid BotGuard integrity token");
  }
  const factory = signals[0] as unknown as
    ((token: Uint8Array) => MintCallback | Promise<MintCallback>) | undefined;
  if (typeof factory !== "function") throw new Error("BotGuard did not expose a minter");
  const mintBytes = await factory(decodeWebSafeBase64(integrity[0]));
  return {
    mint: async (binding) => encodeWebSafeBase64(
      await mintBytes(new TextEncoder().encode(binding)),
    ),
    shutdown: () => {
      client.shutdown();
      dom.window.close();
    },
  };
}

function hasCompleteFirstMediaSegment(prefix: Buffer): boolean {
  let offset = 0;
  let sawMoof = false;
  while (offset + 8 <= prefix.length) {
    let boxSize = prefix.readUInt32BE(offset);
    const boxType = prefix.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (boxSize === 1) {
      if (offset + 16 > prefix.length) return false;
      const extended = prefix.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      boxSize = Number(extended);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = prefix.length - offset;
    }
    if (boxSize < headerSize || offset + boxSize > prefix.length) return false;
    if (boxType === "moof") sawMoof = true;
    if (sawMoof && boxType === "mdat") return true;
    offset += boxSize;
  }
  return false;
}

async function main(): Promise<void> {
mark("cold-start", "video=" + videoId);
const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
  cookie: string;
  x_goog_authuser?: string;
};
const homeResponse = await fetch(MUSIC_ORIGIN + "/", {
  headers: {
    cookie: session.cookie,
    "user-agent": USER_AGENT,
    "accept-language": "zh-CN,zh;q=0.9",
  },
});
if (!homeResponse.ok) throw new Error("YouTube Music home HTTP " + homeResponse.status);
const home = await homeResponse.text();
const visitorData = extractConfigString(home, "VISITOR_DATA");
const dataSyncId = extractConfigString(home, "DATASYNC_ID");
const rawPlayerUrl = extractConfigString(home, "jsUrl");
if (!visitorData || !rawPlayerUrl) throw new Error("YouTube Music home has no identity/player");
const playerUrl = new URL(rawPlayerUrl, "https://www.youtube.com").toString();
mark("identity", "player=" + playerUrl.match(/\/s\/player\/([^/]+)/)?.[1]);

// Account/session work is prewarmed in the background; a double-click pays neither cost.
const [player, minter] = await Promise.all([
  fetch(playerUrl, { headers: { "user-agent": USER_AGENT } }).then(async (response) => {
    if (!response.ok) throw new Error("player script HTTP " + response.status);
    return LightweightYoutubePlayer.create(await response.text());
  }),
  createWarmMinter(),
]);
mark("prewarm-complete", "sts=" + player.signatureTimestamp);

clickStartedAt = performance.now();
mark("click-boundary");

const user: Record<string, unknown> = { lockedSafetyMode: false };
const delegated = dataSyncId.match(/^([^|]+)\|\|(.+)$/)?.[1];
if (delegated) user.onBehalfOfUser = delegated;
const authorization = sapisidAuthorization(session.cookie);
const playerRequest = fetch(MUSIC_ORIGIN + "/youtubei/v1/player?prettyPrint=false", {
  method: "POST",
  headers: {
    accept: "application/json",
    "content-type": "application/json",
    "accept-language": "zh-CN,zh;q=0.9",
    origin: MUSIC_ORIGIN,
    "x-origin": MUSIC_ORIGIN,
    referer: MUSIC_ORIGIN + "/",
    "user-agent": USER_AGENT,
    cookie: session.cookie,
    "x-goog-api-format-version": "1",
    "x-goog-authuser": session.x_goog_authuser || "0",
    "x-goog-visitor-id": visitorData,
    "x-youtube-client-name": "67",
    "x-youtube-client-version": CLIENT_VERSION,
    ...(authorization ? { authorization } : {}),
  },
  body: JSON.stringify({
    context: {
      client: {
        clientName: "WEB_REMIX",
        clientVersion: CLIENT_VERSION,
        hl: "zh-CN",
        gl: "US",
        visitorData,
      },
      user,
    },
    videoId,
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: "HTML5_PREF_WANTS",
        signatureTimestamp: player.signatureTimestamp,
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
    videoCheckOk: true,
  }),
});

// Track-specific proof minting and Player are independent. Never serialize them on the click path.
const [playerResponse, poToken] = await Promise.all([playerRequest, minter.mint(videoId)]);
const payload = await playerResponse.json() as Record<string, any>;
if (!playerResponse.ok) {
  throw new Error("Player HTTP " + playerResponse.status + ": " + JSON.stringify(payload).slice(0, 500));
}
if (payload.playabilityStatus?.status !== "OK") {
  throw new Error("Player status " + JSON.stringify(payload.playabilityStatus));
}
mark("player+proof", "formats=" + (payload.streamingData?.adaptiveFormats?.length || 0));

const rawSabrUrl = payload.streamingData?.serverAbrStreamingUrl as string | undefined;
const ustreamer = payload.playerConfig?.mediaCommonConfig
  ?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig as string | undefined;
if (!rawSabrUrl || !ustreamer) throw new Error("Player response has no SABR bootstrap");
const formats = (payload.streamingData.adaptiveFormats as unknown[]).map(buildSabrFormat);
const audioFormat = formats
  .filter((format: SabrFormat) => String(format.mimeType).startsWith("audio/mp4"))
  .sort((left: SabrFormat, right: SabrFormat) => (left.bitrate || 0) - (right.bitrate || 0))[0];
if (!audioFormat) throw new Error("Player response has no MP4/AAC audio format");

const sabr = new SabrStream({
  formats,
  serverAbrStreamingUrl: player.decipher(rawSabrUrl),
  videoPlaybackUstreamerConfig: ustreamer,
  poToken,
  clientInfo: { clientName: 67, clientVersion: CLIENT_VERSION },
  durationMs: Number(payload.videoDetails?.lengthSeconds || 0) * 1000,
});
const { audioStream } = await sabr.start({
  audioFormat,
  preferMP4: true,
  preferOpus: false,
  enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
  maxRetries: 2,
  stallDetectionMs: 15_000,
});
mark("sabr-start", "itag=" + audioFormat.itag + " bitrate=" + audioFormat.bitrate);

const file = await open(outputPath, "w");
const reader = audioStream.getReader();
let bytes = 0;
let chunks = 0;
let firstByteMs = 0;
let playablePrefixMs = 0;
let prefix = Buffer.alloc(0);
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstByteMs) {
      firstByteMs = performance.now() - clickStartedAt;
      mark("first-audio-byte", "chunk=" + value.byteLength);
    }
    await file.write(value);
    bytes += value.byteLength;
    chunks += 1;
    if (!playablePrefixMs && prefix.length < 2 * 1024 * 1024) {
      prefix = Buffer.concat([prefix, Buffer.from(value)]);
      if (hasCompleteFirstMediaSegment(prefix)) {
        playablePrefixMs = performance.now() - clickStartedAt;
        mark("playable-prefix", "bytes=" + prefix.length);
      }
    }
  }
} finally {
  await file.close();
  minter.shutdown();
}
mark("download-complete", "bytes=" + bytes + " chunks=" + chunks);

const probe = spawnSync("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration,size,format_name",
  "-of", "json",
  outputPath,
], { encoding: "utf8" });
if (probe.status !== 0) throw new Error("ffprobe failed: " + probe.stderr.trim());
const media = JSON.parse(probe.stdout) as { format?: { duration?: string; size?: string } };
if (Number(media.format?.size || 0) !== bytes || Number(media.format?.duration || 0) <= 0) {
  throw new Error("ffprobe did not validate the complete audio file");
}
mark("ffprobe-valid", "duration=" + media.format?.duration + "s");
console.log(JSON.stringify({
  videoId,
  prewarmMs: clickStartedAt - startedAt,
  firstByteMs,
  playablePrefixMs,
  clickToCompleteMs: performance.now() - clickStartedAt,
  bytes,
  chunks,
  outputPath,
}));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
