import type { SongSource } from "../types";

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

export const YOUTUBE_SABR_MAX_RETRIES = 0;
export const YOUTUBE_SABR_FIRST_PUBLISH_BYTES = 128 * 1024;

export async function createYoutubeSabrPreview(
  _source: SongSource,
  _bootstrap: YoutubeSabrBootstrap,
  _bypassCache = false,
): Promise<YoutubeSabrPreview> {
  throw new Error("当前系统没有可用的 YouTube 原生 SABR 播放器");
}
