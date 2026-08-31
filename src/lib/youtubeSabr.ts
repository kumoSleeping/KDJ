import { SabrStream } from "googlevideo/sabr-stream";
import type { SabrFormat } from "googlevideo/shared-types";
import { buildSabrFormat, EnabledTrackTypes } from "googlevideo/utils";

import type { SongSource } from "../types";
import { finishApiActivity } from "./activityLog";
import { getBridge } from "./bridge";
import { sanitizeYoutubeSabrFailure } from "./youtubeSabrFailure";

export interface YoutubeSabrBootstrap {
  serverAbrStreamingUrl: string;
  videoPlaybackUstreamerConfig: string;
  formats: unknown[];
  audioItag: number;
  durationMs: number;
  poToken: string;
}

export interface YoutubeSabrPreview {
  url: string;
  cached?: boolean;
  waveform_token?: string;
}

/** Playback reliability is measured on the first request; failures are never hidden by retries. */
export const YOUTUBE_SABR_MAX_RETRIES = 0;
export const YOUTUBE_SABR_FIRST_PUBLISH_BYTES = 128 * 1024;
const YOUTUBE_SABR_NEXT_PUBLISH_BYTES = 256 * 1024;

async function localFetch(path: string, init: RequestInit): Promise<Response> {
  const bridge = getBridge();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${bridge.authToken}`);
  // 一个 SABR 会话会拆成 spool/proxy/segment 等多次本地请求；会话层只记一条。
  headers.set("X-KDJ-Activity-Recorded", "1");
  return fetch(bridge.baseUrl + "/api" + path, { ...init, headers });
}

async function localJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await localFetch(path, init);
  const text = await response.text();
  const value = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = value && typeof value === "object" && "detail" in value
      ? String((value as { detail: unknown }).detail)
      : response.statusText;
    throw new Error(detail || "本地 SABR 服务返回 HTTP " + response.status);
  }
  return value as T;
}

function concatenate(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(left.length + right.length);
  value.set(left, 0);
  value.set(right, left.length);
  return value;
}

async function appendSpool(token: string, bytes: Uint8Array): Promise<void> {
  const response = await localFetch(
    "/song/preview/ytm/sabr/spools/" + encodeURIComponent(token),
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as BodyInit,
    },
  );
  if (!response.ok) throw new Error((await response.text()) || "写入 SABR 媒体失败");
}

async function failSpool(token: string, reason: unknown): Promise<void> {
  await localFetch(
    "/song/preview/ytm/sabr/spools/" + encodeURIComponent(token) + "/fail",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: sanitizeYoutubeSabrFailure(reason) }),
    },
  ).catch(() => undefined);
}

async function pumpAudio(
  token: string,
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = stream.getReader();
  let pending = new Uint8Array();
  let firstSegmentPublished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending = concatenate(pending, value);
      const ready = firstSegmentPublished
        ? pending.length >= YOUTUBE_SABR_NEXT_PUBLISH_BYTES
        : pending.length >= YOUTUBE_SABR_FIRST_PUBLISH_BYTES;
      if (ready) {
        await appendSpool(token, pending);
        pending = new Uint8Array();
        firstSegmentPublished = true;
      }
    }
    if (pending.length > 0) {
      await appendSpool(token, pending);
    }
    const complete = await localFetch(
      "/song/preview/ytm/sabr/spools/" + encodeURIComponent(token) + "/complete",
      { method: "POST" },
    );
    if (!complete.ok) throw new Error((await complete.text()) || "提交 SABR 媒体失败");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await failSpool(token, error);
    throw new Error(sanitizeYoutubeSabrFailure(error));
  }
}

export async function createYoutubeSabrPreview(
  source: SongSource,
  bootstrap: YoutubeSabrBootstrap,
  bypassCache: boolean,
): Promise<YoutubeSabrPreview> {
  const formats = bootstrap.formats.map((format) => buildSabrFormat(format as never));
  const audioFormat = formats
    .find((format: SabrFormat) =>
      format.itag === bootstrap.audioItag
      && String(format.mimeType).startsWith("audio/mp4"));
  const total = Number(audioFormat?.contentLength || 0);
  if (!audioFormat || !Number.isSafeInteger(total) || total <= 0) {
    throw new Error("YouTube SABR 没有返回可解码的完整 AAC 音频");
  }
  const activityStarted = performance.now();
  let preview: YoutubeSabrPreview;
  try {
    preview = await localJson<YoutubeSabrPreview>("/song/preview/ytm/sabr/spools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        total,
        content_type: "audio/mp4",
        bypass_cache: bypassCache,
      }),
    });
    finishApiActivity(
      {
        category: "network",
        action: "在线预览 API",
        target: "YouTube Music · music.youtube.com",
      },
      { status: 200, durationMs: performance.now() - activityStarted, ok: true },
    );
  } catch (error) {
    finishApiActivity(
      {
        category: "network",
        action: "在线预览 API",
        target: "YouTube Music · music.youtube.com",
      },
      {
        status: 0,
        durationMs: performance.now() - activityStarted,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    throw error;
  }
  if (!preview.url.startsWith("/")) return preview;
  const bridge = getBridge();
  const url = new URL(bridge.baseUrl + preview.url);
  url.searchParams.set("kdj_media_token", bridge.mediaToken);
  const result = { ...preview, url: url.toString() };
  if (preview.cached) return result;
  const token = preview.waveform_token;
  if (!token) throw new Error("YouTube SABR 媒体会话缺少上传票据");

  const sabr = new SabrStream({
    formats,
    serverAbrStreamingUrl: bootstrap.serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: bootstrap.videoPlaybackUstreamerConfig,
    poToken: bootstrap.poToken,
    clientInfo: { clientName: 67, clientVersion: "1.20260707.12.00" },
    durationMs: bootstrap.durationMs,
    fetch: async (input, init) => {
      const response = await localFetch("/song/preview/ytm/sabr/proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-protobuf",
          "X-KDJ-Sabr-Url": String(input),
        },
        body: init?.body,
        signal: init?.signal,
      });
      return response;
    },
  });
  let audioStream: ReadableStream<Uint8Array>;
  try {
    ({ audioStream } = await sabr.start({
      audioFormat,
      preferMP4: true,
      preferOpus: false,
      enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
      // A failed SABR request is a failed playback session. Retrying here would hide an unstable
      // proof/network contract and make first-play success look better than it really is.
      maxRetries: YOUTUBE_SABR_MAX_RETRIES,
      stallDetectionMs: 15_000,
    }));
  } catch (error) {
    sabr.abort();
    await failSpool(token, error);
    throw new Error(sanitizeYoutubeSabrFailure(error));
  }
  void pumpAudio(token, audioStream).catch(() => {
    sabr.abort();
    console.warn("YouTube SABR 媒体会话失败");
  });
  return result;
}
