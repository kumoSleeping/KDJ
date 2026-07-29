import type { Track, Waveform } from "../types";
import { api } from "./api";
import { isStreamTrack } from "./streamTrack";

/** 当前曲、下一台 Deck 和最近查看过的歌曲足够；避免整晚演出后数组只增不减。 */
const CACHE_LIMIT = 24;
const cache = new Map<number, Waveform>();
const inflight = new Map<number, Promise<Waveform>>();

function remember(trackId: number, wave: Waveform): Waveform {
  cache.delete(trackId);
  cache.set(trackId, wave);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return wave;
}

export function cachedWaveform(trackId: number): Waveform | null {
  const hit = cache.get(trackId);
  if (!hit) return null;
  // Map 的插入顺序就是 LRU 顺序；命中一次便挪到队尾。
  return remember(trackId, hit);
}

export function loadWaveform(trackId: number): Promise<Waveform> {
  const hit = cachedWaveform(trackId);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(trackId);
  if (pending) return pending;
  const request = api
    .waveform(trackId)
    .then((data) => {
      inflight.delete(trackId);
      return remember(trackId, data);
    })
    .catch((error: unknown) => {
      inflight.delete(trackId);
      throw error;
    });
  inflight.set(trackId, request);
  return request;
}

/**
 * 播放事件和下一台 Deck 一确定就提前读盘。失败不阻断声音；组件真正挂载时仍会
 * 正常重试并展示 fallback。命中后切歌只剩一次 canvas 绘制，不再等 HTTP。
 */
export function prefetchWaveform(track: Track | null | undefined): void {
  if (!track || isStreamTrack(track)) return;
  void loadWaveform(track.id).catch(() => undefined);
}
