import { SabrStream } from "googlevideo/sabr-stream";
import type { SabrFormat } from "googlevideo/shared-types";
import { buildSabrFormat, EnabledTrackTypes } from "googlevideo/utils";

import type { SongSource } from "../types";
import { getBridge } from "./bridge";
import { hasCompleteFmp4MediaSegment } from "./fmp4Prefix";

export interface YoutubeSabrBootstrap {
  serverAbrStreamingUrl: string;
  videoPlaybackUstreamerConfig: string;
  formats: unknown[];
  durationMs: number;
  poToken: string;
}

export interface YoutubeSabrPreview {
  url: string;
  cached?: boolean;
  waveform_token?: string;
}

async function localFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(getBridge().baseUrl + "/api" + path, init);
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

function joinChunks(
  chunks: Uint8Array<ArrayBufferLike>[],
  length: number,
): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.length;
  }
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
      body: JSON.stringify({ error: reason instanceof Error ? reason.message : String(reason) }),
    },
  ).catch(() => undefined);
}

async function pumpAudio(
  token: string,
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = stream.getReader();
  let pendingChunks: Uint8Array<ArrayBufferLike>[] = [];
  let pendingLength = 0;
  let firstSegmentPublished = false;
  let nextPrefixInspection = 64 * 1024;
  const takePending = (): Uint8Array<ArrayBuffer> => {
    const bytes = joinChunks(pendingChunks, pendingLength);
    pendingChunks = [];
    pendingLength = 0;
    return bytes;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pendingChunks.push(value);
      pendingLength += value.length;
      let ready = firstSegmentPublished && pendingLength >= 256 * 1024;
      if (!firstSegmentPublished && pendingLength >= nextPrefixInspection) {
        const prefix = takePending();
        pendingChunks = [prefix];
        pendingLength = prefix.length;
        ready = hasCompleteFmp4MediaSegment(prefix) || pendingLength >= 1024 * 1024;
        nextPrefixInspection = (Math.floor(pendingLength / (64 * 1024)) + 1) * 64 * 1024;
      }
      if (ready) {
        await appendSpool(token, takePending());
        firstSegmentPublished = true;
      }
    }
    if (pendingLength > 0) {
      await appendSpool(token, takePending());
    }
    const complete = await localFetch(
      "/song/preview/ytm/sabr/spools/" + encodeURIComponent(token) + "/complete",
      { method: "POST" },
    );
    if (!complete.ok) throw new Error((await complete.text()) || "提交 SABR 媒体失败");
  } catch (error) {
    await failSpool(token, error);
    throw error;
  }
}

export async function createYoutubeSabrPreview(
  source: SongSource,
  bootstrap: YoutubeSabrBootstrap,
  bypassCache: boolean,
): Promise<YoutubeSabrPreview> {
  const formats = bootstrap.formats.map((format) => buildSabrFormat(format as never));
  const audioFormat = formats
    .filter((format: SabrFormat) => String(format.mimeType).startsWith("audio/mp4"))
    .sort((left: SabrFormat, right: SabrFormat) => (left.bitrate || 0) - (right.bitrate || 0))[0];
  const total = Number(audioFormat?.contentLength || 0);
  if (!audioFormat || !Number.isSafeInteger(total) || total <= 0) {
    throw new Error("YouTube SABR 没有返回可解码的完整 AAC 音频");
  }
  const preview = await localJson<YoutubeSabrPreview>("/song/preview/ytm/sabr/spools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source,
      total,
      content_type: "audio/mp4",
      bypass_cache: bypassCache,
    }),
  });
  if (!preview.url.startsWith("/")) return preview;
  const result = { ...preview, url: getBridge().baseUrl + preview.url };
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
  const { audioStream } = await sabr.start({
    audioFormat,
    preferMP4: true,
    preferOpus: false,
    enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
    maxRetries: 2,
    stallDetectionMs: 15_000,
  });
  void pumpAudio(token, audioStream).catch((error) => {
    console.warn("YouTube SABR 媒体会话失败", error);
  });
  return result;
}
