import type { Track, Waveform } from "../types";
import { api } from "./api";
import { isStreamTrack } from "./streamTrack";
import {
  isOneLibraryPlaybackTrack,
  oneLibraryPlaybackSource,
} from "./playbackTrackSource";
import { overviewWaveformFromDetail } from "./waveformViewport";

/** 当前曲、下一台 Deck 和最近查看过的歌曲足够；避免整晚演出后数组只增不减。 */
const CACHE_LIMIT = 24;
const DEFAULT_WAVEFORM_BUCKETS = 640;
const cache = new Map<string, Waveform>();
const inflight = new Map<string, Promise<Waveform>>();
/** v0.2.41 整曲预览和当前高密度波形不能互相派生或覆盖。 */
const releaseOverviewCache = new Map<number, Waveform>();
const releaseOverviewInflight = new Map<number, Promise<Waveform>>();

function normalizedBuckets(buckets: number): number {
  return Math.min(24_000, Math.max(64, Math.round(Number.isFinite(buckets) ? buckets : DEFAULT_WAVEFORM_BUCKETS)));
}

function waveformCacheKey(trackId: number, buckets: number): string {
  return `${trackId}:${normalizedBuckets(buckets)}`;
}

function waveformKeyParts(key: string): [number, number] | null {
  const separator = key.lastIndexOf(":");
  if (separator <= 0) return null;
  const trackId = Number(key.slice(0, separator));
  const buckets = Number(key.slice(separator + 1));
  return Number.isFinite(trackId) && Number.isFinite(buckets) ? [trackId, buckets] : null;
}

/**
 * 在线波形不能另起一次 fetch：媒体元素已经在下载同一首歌，再拉整轨会浪费双倍流量，
 * FLAC 还会额外占一整份 encoded + PCM 内存。这里保留固定桶的渐进快照：
 * - analyser 喂进来的当前采样是真实彩色波形；
 * - HTMLMediaElement.buffered 只标记“媒体已缓存”，不冒充已经分析过的幅度；
 * - 未缓存区由组件画低透明占位。
 */
const STREAM_BUCKETS = 640;
const STREAM_CACHE_LIMIT = 24;

export interface StreamWaveformSample {
  /** analyser 归一化后的真实响度，范围 0..1。 */
  amp: number;
  /** 与本地波形相同交叉点得到的低/中/高频幅度。 */
  low: number;
  middle: number;
  high: number;
}

export interface StreamBufferedRange {
  start: number;
  end: number;
}

export interface StreamWaveformSnapshot {
  waveform: Waveform;
  /** 与 waveform.amp 等长；false 表示该桶还没有真实 analyser 或缓存 PCM 分析。 */
  known: readonly boolean[];
  /** 媒体元素当前实际缓存的秒区间，用来画“缓存到哪里”的低透明占位。 */
  bufferedRanges: readonly StreamBufferedRange[];
  revision: number;
}

interface StreamWaveformEntry {
  snapshot: StreamWaveformSnapshot;
  /** 同一时间桶会收到多帧 analyser 采样；频段做稳定均值，幅度保留峰值。 */
  counts: number[];
  rawAmp: number[];
  low: number[];
  middle: number[];
  high: number[];
  /** analyser 只会看见已经播放到的 PCM；缓存前缀则由 server 波形单独覆盖。 */
  analyserKnown: boolean[];
  /** 后端已从顺序缓存文件解出的真实前缀，按整曲时长投影时才标记 known。 */
  cachedPrefix: {
    waveform: Waveform;
    coveredSeconds: number;
    revision: number;
  } | null;
}

const streamCache = new Map<number, StreamWaveformEntry>();
const streamListeners = new Map<number, Set<() => void>>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function emptyStreamEntry(trackId: number, duration: number): StreamWaveformEntry {
  return {
    snapshot: {
      waveform: {
        track_id: trackId,
        duration: Math.max(0, Number.isFinite(duration) ? duration : 0),
        amp: Array(STREAM_BUCKETS).fill(0),
        r: Array(STREAM_BUCKETS).fill(0),
        g: Array(STREAM_BUCKETS).fill(0),
        b: Array(STREAM_BUCKETS).fill(0),
      },
      known: Array(STREAM_BUCKETS).fill(false),
      bufferedRanges: [],
      revision: 0,
    },
    counts: Array(STREAM_BUCKETS).fill(0),
    rawAmp: Array(STREAM_BUCKETS).fill(0),
    low: Array(STREAM_BUCKETS).fill(0),
    middle: Array(STREAM_BUCKETS).fill(0),
    high: Array(STREAM_BUCKETS).fill(0),
    analyserKnown: Array(STREAM_BUCKETS).fill(false),
    cachedPrefix: null,
  };
}

const STREAM_AMP_GAMMA = 0.9;
const STREAM_COLOR_GAMMA = 2.4;
const STREAM_COLOR_FLOOR = 0.06;

function percentile(sorted: readonly number[], percent: number): number {
  if (sorted.length === 0) return 0;
  const position = clamp(percent, 0, 100) / 100 * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return (sorted[lower] ?? 0) * (1 - fraction) + (sorted[upper] ?? 0) * fraction;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((left, right) => left - right);
  return percentile(sorted, 50) || 1;
}

/**
 * 复用本地 Rust 波形的核心归一逻辑，但参考范围只使用已经播放采样到的桶：
 * 高度按 P5/P99 拉伸；颜色按低/中/高占比相对本曲中位常态的偏离着色。
 * 随着缓存播放推进，参考值会渐进稳定，不需要另拉整首音频。
 */
function normalizeKnownStreamBuckets(
  entry: StreamWaveformEntry,
  known: readonly boolean[],
  amp: number[],
  r: number[],
  g: number[],
  b: number[],
): void {
  const indices = known.flatMap((value, index) => (value ? [index] : []));
  if (indices.length === 0) return;

  const amplitudes = indices.map((index) => entry.rawAmp[index] ?? 0).sort((a, z) => a - z);
  const lo = indices.length >= 8 ? percentile(amplitudes, 5) : 0;
  const highPercentile = percentile(amplitudes, 99);
  const hi = highPercentile > 0 ? highPercentile : 1;
  for (const index of indices) {
    amp[index] = Math.pow(clamp(((entry.rawAmp[index] ?? 0) - lo) / Math.max(1e-6, hi - lo), 0, 1), STREAM_AMP_GAMMA);
  }

  // 本地实现会先做约 5 桶的时间平滑；这里只平均相邻的已知桶，跳播产生的
  // 未知空洞不会被编造出颜色。
  const shares = new Map<number, [number, number, number]>();
  for (const index of indices) {
    let low = 0;
    let middle = 0;
    let high = 0;
    let count = 0;
    for (let neighbor = Math.max(0, index - 2); neighbor <= Math.min(STREAM_BUCKETS - 1, index + 2); neighbor += 1) {
      if (!known[neighbor]) continue;
      low += entry.low[neighbor] ?? 0;
      middle += entry.middle[neighbor] ?? 0;
      high += entry.high[neighbor] ?? 0;
      count += 1;
    }
    const total = Math.max(1e-12, (low + middle + high) / Math.max(1, count));
    shares.set(index, [low / Math.max(1, count) / total, middle / Math.max(1, count) / total, high / Math.max(1, count) / total]);
  }
  const reference: [number, number, number] = [0, 1, 2].map((band) =>
    median(indices.map((index) => shares.get(index)?.[band] ?? 0)),
  ) as [number, number, number];

  for (const index of indices) {
    const share = shares.get(index) ?? [1, 1, 1];
    const dev = share.map((value, band) => Math.pow(value / Math.max(1e-9, reference[band]), STREAM_COLOR_GAMMA));
    const peak = Math.max(1e-9, ...dev);
    const channels = dev.map((value) => {
      const lifted = STREAM_COLOR_FLOOR + (1 - STREAM_COLOR_FLOOR) * clamp(value / peak, 0, 1);
      return Math.round(lifted * 255);
    });
    r[index] = channels[0] ?? 0;
    g[index] = channels[1] ?? 0;
    b[index] = channels[2] ?? 0;
  }
}

/**
 * 把后端的“从 0 开始、已解码 N 秒”的波形投影到整曲固定 640 桶。
 *
 * 不能直接把 prefix 的 640 列拉满画布：那会把前 20 秒错误拉伸成整首歌。每个
 * 目标桶按自己的整曲时间窗口反查 prefix 中相交的列，只有真正覆盖到的桶才置 true。
 */
function overlayCachedPrefix(
  entry: StreamWaveformEntry,
  total: number,
  amp: number[],
  r: number[],
  g: number[],
  b: number[],
  cacheKnown: boolean[],
): void {
  const prefix = entry.cachedPrefix;
  if (!prefix || total <= 0) return;
  const source = prefix.waveform;
  const n = source.amp.length;
  if (
    n === 0 ||
    source.r.length !== n ||
    source.g.length !== n ||
    source.b.length !== n
  ) {
    return;
  }
  const covered = clamp(prefix.coveredSeconds, 0, total);
  if (covered <= 0) return;
  const endBucket = Math.min(STREAM_BUCKETS, Math.ceil((covered / total) * STREAM_BUCKETS));
  for (let bucket = 0; bucket < endBucket; bucket += 1) {
    const start = (bucket / STREAM_BUCKETS) * total;
    if (start >= covered) break;
    const end = Math.min(covered, ((bucket + 1) / STREAM_BUCKETS) * total);
    const from = Math.min(n - 1, Math.max(0, Math.floor((start / covered) * n)));
    const to = Math.min(n, Math.max(from + 1, Math.ceil((end / covered) * n)));
    let peak = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    let weight = 0;
    for (let index = from; index < to; index += 1) {
      const value = clamp(source.amp[index] ?? 0, 0, 1);
      peak = Math.max(peak, value);
      const colorWeight = value + 0.001;
      red += (source.r[index] ?? 0) * colorWeight;
      green += (source.g[index] ?? 0) * colorWeight;
      blue += (source.b[index] ?? 0) * colorWeight;
      weight += colorWeight;
    }
    if (weight <= 0) continue;
    amp[bucket] = peak;
    r[bucket] = Math.round(red / weight);
    g[bucket] = Math.round(green / weight);
    b[bucket] = Math.round(blue / weight);
    cacheKnown[bucket] = true;
  }
}

function buildStreamSnapshot(
  entry: StreamWaveformEntry,
  trackId: number,
  total: number,
  bufferedRanges: readonly StreamBufferedRange[],
  revision: number,
): StreamWaveformSnapshot {
  const amp = Array(STREAM_BUCKETS).fill(0) as number[];
  const r = Array(STREAM_BUCKETS).fill(0) as number[];
  const g = Array(STREAM_BUCKETS).fill(0) as number[];
  const b = Array(STREAM_BUCKETS).fill(0) as number[];
  // analyser 值和服务端波形的归一策略不同；先画已播 analyser，再由缓存前缀
  // 覆盖同一区间，避免缓存更新时把播放头之后的真实 analyser 样本清空。
  normalizeKnownStreamBuckets(entry, entry.analyserKnown, amp, r, g, b);
  const cacheKnown = Array(STREAM_BUCKETS).fill(false) as boolean[];
  overlayCachedPrefix(entry, total, amp, r, g, b, cacheKnown);
  const known = entry.analyserKnown.map((value, index) => value || cacheKnown[index]);
  return {
    waveform: { track_id: trackId, duration: total, amp, r, g, b },
    known,
    bufferedRanges,
    revision,
  };
}

function touchStreamEntry(trackId: number, entry: StreamWaveformEntry): void {
  streamCache.delete(trackId);
  streamCache.set(trackId, entry);
}

function trimStreamCache(): void {
  if (streamCache.size <= STREAM_CACHE_LIMIT) return;
  for (const trackId of [...streamCache.keys()]) {
    if (streamCache.size <= STREAM_CACHE_LIMIT) break;
    // 正挂在底部波形上的曲目不能在一帧中途消失。
    if ((streamListeners.get(trackId)?.size ?? 0) > 0) continue;
    streamCache.delete(trackId);
  }
}

function notifyStreamWaveform(trackId: number): void {
  for (const listener of streamListeners.get(trackId) ?? []) listener();
}

function normalizeBufferedRanges(
  ranges: readonly StreamBufferedRange[],
  duration: number,
): StreamBufferedRange[] {
  const normalized = ranges
    .map(({ start, end }) => ({
      start: clamp(start, 0, duration > 0 ? duration : Number.MAX_SAFE_INTEGER),
      end: clamp(end, 0, duration > 0 ? duration : Number.MAX_SAFE_INTEGER),
    }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start);
  const merged: StreamBufferedRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 0.05) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function sameBufferedRanges(
  left: readonly StreamBufferedRange[],
  right: readonly StreamBufferedRange[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (range, index) =>
        Math.abs(range.start - (right[index]?.start ?? -1)) < 0.01 &&
        Math.abs(range.end - (right[index]?.end ?? -1)) < 0.01,
    )
  );
}

/** 把 TimeRanges 转成可序列化区间；读取异常时返回空，不影响声音。 */
export function mediaBufferedRanges(
  media: HTMLMediaElement,
  duration = media.duration,
): StreamBufferedRange[] {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const ranges: StreamBufferedRange[] = [];
  try {
    for (let index = 0; index < media.buffered.length; index += 1) {
      ranges.push({ start: media.buffered.start(index), end: media.buffered.end(index) });
    }
  } catch {
    return [];
  }
  return normalizeBufferedRanges(ranges, total);
}

/**
 * PlayerBar 在 progress/timeupdate 时调用。sample 可为 null：只更新 buffered 占位；
 * 有 sample 时按当前播放秒落到固定桶，逐步长成真实波形。
 */
export function updateStreamWaveform(
  trackId: number,
  position: number,
  duration: number,
  sample: StreamWaveformSample | null,
  bufferedRanges?: readonly StreamBufferedRange[],
): StreamWaveformSnapshot {
  if (trackId >= 0) throw new Error("渐进在线波形只接受负 track id");
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const entry = streamCache.get(trackId) ?? emptyStreamEntry(trackId, safeDuration);
  const previous = entry.snapshot;
  const total = safeDuration || previous.waveform.duration;
  const nextRanges =
    bufferedRanges === undefined
      ? previous.bufferedRanges
      : normalizeBufferedRanges(bufferedRanges, total);
  const durationChanged = total !== previous.waveform.duration;
  const rangesChanged = !sameBufferedRanges(previous.bufferedRanges, nextRanges);

  let bucket = -1;
  if (sample && total > 0 && Number.isFinite(position)) {
    bucket = Math.min(STREAM_BUCKETS - 1, Math.max(0, Math.floor((position / total) * STREAM_BUCKETS)));
  }
  if (bucket < 0 && !durationChanged && !rangesChanged) {
    touchStreamEntry(trackId, entry);
    return previous;
  }

  if (bucket >= 0 && sample) {
    const count = entry.counts[bucket] ?? 0;
    const nextCount = Math.min(65535, count + 1);
    const colorWeight = count / nextCount;
    entry.rawAmp[bucket] = Math.max(entry.rawAmp[bucket] ?? 0, clamp(sample.amp, 0, 1));
    entry.low[bucket] = (entry.low[bucket] ?? 0) * colorWeight + clamp(sample.low, 0, 1) / nextCount;
    entry.middle[bucket] = (entry.middle[bucket] ?? 0) * colorWeight + clamp(sample.middle, 0, 1) / nextCount;
    entry.high[bucket] = (entry.high[bucket] ?? 0) * colorWeight + clamp(sample.high, 0, 1) / nextCount;
    entry.analyserKnown[bucket] = true;
    entry.counts[bucket] = nextCount;
  }
  entry.snapshot = buildStreamSnapshot(
    entry,
    trackId,
    total,
    nextRanges,
    previous.revision + 1,
  );
  touchStreamEntry(trackId, entry);
  trimStreamCache();
  notifyStreamWaveform(trackId);
  return entry.snapshot;
}

/**
 * 合并服务端从 stream-cache 临时文件解出的真实前缀。
 *
 * `coveredSeconds` 是已经得到 PCM 的时长，而 `duration` 是整曲长度。两者不可混用：
 * 这里的 `buildStreamSnapshot` 会只覆盖前者对应的固定桶，保留其他区域已有的 analyser
 * 样本和 `buffered` 占位。
 */
export function mergeCachedStreamWaveform(
  trackId: number,
  duration: number,
  coveredSeconds: number,
  waveform: Waveform,
  sourceRevision: number,
  bufferedRanges?: readonly StreamBufferedRange[],
): StreamWaveformSnapshot {
  if (trackId >= 0) throw new Error("渐进在线波形只接受负 track id");
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const entry = streamCache.get(trackId) ?? emptyStreamEntry(trackId, safeDuration);
  const previous = entry.snapshot;
  const total = safeDuration || previous.waveform.duration;
  const nextRanges =
    bufferedRanges === undefined
      ? previous.bufferedRanges
      : normalizeBufferedRanges(bufferedRanges, total);
  const previousPrefix = entry.cachedPrefix;
  // HTTP 轮询可能乱序返回；旧快照不能把已缓存得更远的波形缩回去。
  if (previousPrefix && sourceRevision < previousPrefix.revision) {
    touchStreamEntry(trackId, entry);
    return previous;
  }
  const validWaveform =
    waveform.amp.length > 0 &&
    waveform.r.length === waveform.amp.length &&
    waveform.g.length === waveform.amp.length &&
    waveform.b.length === waveform.amp.length &&
    Number.isFinite(coveredSeconds) &&
    coveredSeconds > 0;
  if (!validWaveform) {
    touchStreamEntry(trackId, entry);
    return previous;
  }
  entry.cachedPrefix = {
    waveform,
    coveredSeconds,
    revision: sourceRevision,
  };
  entry.snapshot = buildStreamSnapshot(
    entry,
    trackId,
    total,
    nextRanges,
    previous.revision + 1,
  );
  touchStreamEntry(trackId, entry);
  trimStreamCache();
  notifyStreamWaveform(trackId);
  return entry.snapshot;
}

export function streamWaveformSnapshot(trackId: number): StreamWaveformSnapshot | null {
  const entry = streamCache.get(trackId);
  if (!entry) return null;
  touchStreamEntry(trackId, entry);
  return entry.snapshot;
}

export function subscribeStreamWaveform(trackId: number, listener: () => void): () => void {
  let listeners = streamListeners.get(trackId);
  if (!listeners) {
    listeners = new Set();
    streamListeners.set(trackId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (!listeners?.size) streamListeners.delete(trackId);
    trimStreamCache();
  };
}

export function clearStreamWaveform(trackId: number): void {
  if (!streamCache.delete(trackId)) return;
  notifyStreamWaveform(trackId);
}

function remember(trackId: number, buckets: number, wave: Waveform): Waveform {
  const key = waveformCacheKey(trackId, buckets);
  cache.delete(key);
  cache.set(key, wave);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return wave;
}

function rememberReleaseOverview(trackId: number, wave: Waveform): Waveform {
  releaseOverviewCache.delete(trackId);
  releaseOverviewCache.set(trackId, wave);
  while (releaseOverviewCache.size > CACHE_LIMIT) {
    const oldest = releaseOverviewCache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    releaseOverviewCache.delete(oldest);
  }
  return wave;
}

export function cachedReleaseOverviewWaveform(trackId: number): Waveform | null {
  const hit = releaseOverviewCache.get(trackId);
  return hit ? rememberReleaseOverview(trackId, hit) : null;
}

export function cachedWaveform(trackId: number, buckets = DEFAULT_WAVEFORM_BUCKETS): Waveform | null {
  const key = waveformCacheKey(trackId, buckets);
  const hit = cache.get(key);
  if (hit) {
    // Map 的插入顺序就是 LRU 顺序；命中一次便挪到队尾。
    return remember(trackId, buckets, hit);
  }
  const requested = normalizedBuckets(buckets);
  // 高密度响应可以直接画在较窄 canvas 上，不能因为 key 不同又解一次整轨。
  // 从最新项向前找，优先复用已经在 Deck 上的 master。
  for (const [candidateKey, candidate] of [...cache.entries()].reverse()) {
    const parts = waveformKeyParts(candidateKey);
    if (!parts || parts[0] !== trackId || parts[1] < requested) continue;
    cache.delete(candidateKey);
    cache.set(candidateKey, candidate);
    return remember(trackId, requested, overviewWaveformFromDetail(candidate, requested));
  }
  return null;
}

function denserInflight(trackId: number, buckets: number): Promise<Waveform> | null {
  const requested = normalizedBuckets(buckets);
  for (const [candidateKey, pending] of inflight) {
    const parts = waveformKeyParts(candidateKey);
    if (parts && parts[0] === trackId && parts[1] >= requested) {
      return pending.then((wave) =>
        remember(trackId, requested, overviewWaveformFromDetail(wave, requested))
      );
    }
  }
  return null;
}

function sparserInflight(trackId: number, buckets: number): Promise<Waveform> | null {
  const requested = normalizedBuckets(buckets);
  for (const [candidateKey, pending] of inflight) {
    const parts = waveformKeyParts(candidateKey);
    if (parts && parts[0] === trackId && parts[1] < requested) return pending;
  }
  return null;
}

export function loadWaveform(trackId: number, buckets = DEFAULT_WAVEFORM_BUCKETS): Promise<Waveform> {
  const normalized = normalizedBuckets(buckets);
  const key = waveformCacheKey(trackId, normalized);
  const hit = cachedWaveform(trackId, normalized);
  if (hit) return Promise.resolve(hit);
  const denser = denserInflight(trackId, normalized);
  if (denser) return denser;
  const pending = inflight.get(key);
  if (pending) return pending;
  const preview = sparserInflight(trackId, normalized);
  if (preview) return preview.then(() => loadWaveform(trackId, normalized));
  const request = api
    .waveform(trackId, normalized)
    .then((data) => {
      inflight.delete(key);
      return remember(trackId, normalized, data);
    })
    .catch((error: unknown) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, request);
  return request;
}

function loadOneLibraryWaveform(track: Track, buckets = DEFAULT_WAVEFORM_BUCKETS): Promise<Waveform> {
  const normalized = normalizedBuckets(buckets);
  const key = waveformCacheKey(track.id, normalized);
  const hit = cachedWaveform(track.id, normalized);
  if (hit) return Promise.resolve(hit);
  const denser = denserInflight(track.id, normalized);
  if (denser) return denser;
  const pending = inflight.get(key);
  if (pending) return pending;
  const preview = sparserInflight(track.id, normalized);
  if (preview) return preview.then(() => loadOneLibraryWaveform(track, normalized));
  const source = oneLibraryPlaybackSource(track);
  if (!source) return Promise.reject(new Error("OneLibrary 播放来源无效"));
  const request = api
    .oneLibraryWaveform(source.devicePath, source.contentId, track.id, normalized)
    .then((data) => {
      inflight.delete(key);
      return remember(track.id, normalized, data);
    })
    .catch((error: unknown) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, request);
  return request;
}

/** 曲库波形走服务端缓存；负 id 只能读取媒体播放过程中形成的渐进快照。 */
export function loadWaveformById(trackId: number, buckets = DEFAULT_WAVEFORM_BUCKETS): Promise<Waveform> {
  if (trackId >= 0) return loadWaveform(trackId, buckets);
  const snapshot = streamWaveformSnapshot(trackId);
  return snapshot
    ? Promise.resolve(snapshot.waveform)
    : Promise.reject(new Error("在线试听波形正在随媒体缓存生成"));
}

export function loadWaveformForTrack(track: Track, buckets = DEFAULT_WAVEFORM_BUCKETS): Promise<Waveform> {
  if (isOneLibraryPlaybackTrack(track)) return loadOneLibraryWaveform(track, buckets);
  return isStreamTrack(track) ? loadWaveformById(track.id, buckets) : loadWaveform(track.id, buckets);
}

/**
 * 普通底栏和 DJ A/B overview 的专用资产。它不复用 detail cache，避免当前高密度
 * Mixxx 波形再次覆盖用户要求恢复的 v0.2.41 整曲结构。
 */
export function loadReleaseOverviewForTrack(track: Track): Promise<Waveform> {
  if (isStreamTrack(track) && !isOneLibraryPlaybackTrack(track)) {
    const snapshot = streamWaveformSnapshot(track.id);
    return snapshot
      ? Promise.resolve(snapshot.waveform)
      : Promise.reject(new Error("在线试听波形正在随媒体缓存生成"));
  }
  if (!isOneLibraryPlaybackTrack(track)) {
    return loadReleaseOverviewById(track.id);
  }
  const hit = cachedReleaseOverviewWaveform(track.id);
  if (hit) return Promise.resolve(hit);
  const pending = releaseOverviewInflight.get(track.id);
  if (pending) return pending;
  const source = oneLibraryPlaybackSource(track);
  if (!source) return Promise.reject(new Error("OneLibrary 播放来源无效"));
  const request = api.oneLibraryWaveform(
    source.devicePath,
    source.contentId,
    track.id,
    DEFAULT_WAVEFORM_BUCKETS,
    "release-overview",
  );
  const tracked = request
    .then((wave) => {
      releaseOverviewInflight.delete(track.id);
      return rememberReleaseOverview(track.id, wave);
    })
    .catch((error: unknown) => {
      releaseOverviewInflight.delete(track.id);
      throw error;
    });
  releaseOverviewInflight.set(track.id, tracked);
  return tracked;
}

export function loadReleaseOverviewById(trackId: number): Promise<Waveform> {
  const hit = cachedReleaseOverviewWaveform(trackId);
  if (hit) return Promise.resolve(hit);
  const pending = releaseOverviewInflight.get(trackId);
  if (pending) return pending;
  const tracked = api
    .waveform(trackId, DEFAULT_WAVEFORM_BUCKETS, "release-overview")
    .then((wave) => {
      releaseOverviewInflight.delete(trackId);
      return rememberReleaseOverview(trackId, wave);
    })
    .catch((error: unknown) => {
      releaseOverviewInflight.delete(trackId);
      throw error;
    });
  releaseOverviewInflight.set(trackId, tracked);
  return tracked;
}

/**
 * Current and predicted tracks only prefetch the canonical first-paint waveform. A detailed
 * master is requested by a mounted rail after it has stayed visible; eagerly decoding every
 * current/predicted Deck made one load compete with the other Deck's live transport.
 */
export function prefetchWaveform(track: Track | null | undefined): void {
  if (!track || isStreamTrack(track)) return;
  void loadReleaseOverviewForTrack(track)
    .catch(() => undefined);
}
