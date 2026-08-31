/**
 * 在线试听的临时曲目：不入库，只把设置中选定音质的代理地址挂进主播放条。
 * 完整媒体到达后的临时分析走独立快照，不写 Track/曲库；id 用负数，和曲库主键
 * 错开，媒体 URL / 封面也记在旁路表里，不污染持久 Track 契约。
 */

import { api } from "./api";
import { thumbUrl } from "./format";
import {
  usesRemotePlaybackSource,
} from "./playbackTrackSource";
import {
  discardLocalStorageWrite,
  readLocalStorage,
  removeLocalStorage,
  writeLocalStorageNow,
  writeLocalStorageSoon,
} from "./storageWrite";
import type { SongSource, Track } from "../types";

export type StreamKind = "song" | "video";

interface StreamMeta {
  url: string;
  /** 与试听代理 URL 同一份随机 ticket，用于读取已解码缓存前缀的波形。 */
  waveformToken: string;
  cover: string;
  kind: StreamKind;
  sourceKey: string;
  source: SongSource | null;
  nextTrack: Track | null;
  /** 媒体元素失败时只允许一次强制回源，防止坏网络形成自动重试环。 */
  cacheRetryUsed: boolean;
  /** 同一首占位曲目被播放、预热和切歌同时命中时，共享一次 provider 解析。 */
  preload: Promise<void> | null;
}

/**
 * 搜索/歌单展开最多会一次建几百个临时 Track。留两轮完整结果的余量，同时防止
 * 长时间浏览后负 id 的旁路表永久增长。正在播放的后继链和解析中的条目不会被淘汰。
 */
const STREAM_TRACK_CACHE_LIMIT = 1024;
const metaById = new Map<number, StreamMeta>();
const trackById = new Map<number, Track>();
const metaListeners = new Map<number, Set<() => void>>();
let nextId = -1;
let publishedStreamTrackId: number | null = null;

/**
 * 纯浏览器 preview 没有 Rust coordinator 时钟。旧 Android 在线链路曾把这条浏览器
 * 时钟限频镜像给原生浮层；正式桌面/Android 在线音频现已由 coordinator 持有，下面
 * 的兼容通道只允许真正没有共享原生 owner 的运行时使用，避免两套时钟互相覆盖。
 */
let nativeStreamLyricsClockEnabled = false;
let latestStreamPlayback: PublishedStreamPlayback | null = null;
let lastNativeStreamLyricsClock: (PublishedStreamPlayback & { sentAt: number }) | null = null;
const NATIVE_LYRICS_CLOCK_MIN_INTERVAL_MS = 250;
const NATIVE_LYRICS_CLOCK_SEEK_EPSILON_SEC = 0.75;

/** 给独立歌词 WebView 读：主窗写入当前试听曲目快照。 */
const PUBLISHED_STREAM_KEY = "kd-active-stream-track";
const PUBLISHED_STREAM_PLAYBACK_KEY = "kd-active-stream-playback";
const PUBLISHED_STREAM_VERSION = 1;
const MAX_PUBLISHED_STREAM_BYTES = 512 * 1024;

interface PublishedStreamSnapshot {
  version: 1;
  track: Track;
  /** 只保存搜索结果元数据，不保存已签名/短效媒体 URL；重启后必须重新向 provider 解析。 */
  source: SongSource;
}

export interface PublishedStreamPlayback {
  trackId: number;
  position: number;
  duration: number;
  playing: boolean;
  rate: number;
}

export interface PublishedStreamPlaybackEvent {
  track: Track;
  playback: PublishedStreamPlayback;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown, max = 16_384): value is string {
  return typeof value === "string" && value.length <= max;
}

function validRestoredTrack(value: unknown): value is Track {
  const track = object(value);
  return Boolean(
    track &&
      typeof track.id === "number" &&
      Number.isSafeInteger(track.id) &&
      track.id < 0 &&
      track.id >= -1_000_000_000 &&
      boundedText(track.path) &&
      boundedText(track.filename) &&
      boundedText(track.title) &&
      boundedText(track.artist) &&
      boundedText(track.album) &&
      boundedText(track.format, 64) &&
      boundedText(track.source_platform, 64) &&
      boundedText(track.source_key),
  );
}

function validRestoredSource(value: unknown): value is SongSource {
  const source = object(value);
  const platform = source?.platform;
  return Boolean(
    source &&
      (platform === "wyy" ||
        platform === "qqm" ||
        platform === "soundcloud" ||
        platform === "ytm" ||
        platform === "youtube" ||
        platform === "bilibili") &&
      boundedText(source.key) &&
      source.key.length > 0 &&
      boundedText(source.title) &&
      Array.isArray(source.artists) &&
      source.artists.length <= 64 &&
      source.artists.every((artist) => boundedText(artist, 4_096)) &&
      boundedText(source.album) &&
      (source.duration === null ||
        (typeof source.duration === "number" &&
          Number.isFinite(source.duration) &&
          source.duration >= 0)) &&
      boundedText(source.cover, 32_768) &&
      (source.max_quality === null ||
        source.max_quality === "flac" ||
        source.max_quality === "320" ||
        source.max_quality === "128") &&
      typeof source.vip === "boolean" &&
      Boolean(object(source.payload)),
  );
}

/** 兼容升级前只存 Track 的快照；能从稳定平台键重建的来源仍可重新解析。 */
function legacySource(track: Track): SongSource | null {
  if (
    !["wyy", "qqm", "soundcloud", "ytm", "youtube", "bilibili"].includes(
      track.source_platform,
    ) ||
    !track.source_key
  ) return null;
  return {
    platform: track.source_platform as SongSource["platform"],
    key: track.source_key,
    title: track.title || track.filename,
    artists: track.artist ? track.artist.split(/\s*[,，/]\s*/).filter(Boolean) : [],
    album: track.album || "",
    duration: track.duration,
    cover: "",
    max_quality: null,
    vip: false,
    payload: track.source_platform === "ytm" ? { video_id: track.source_key } : {},
  };
}

export function publishedStreamSnapshot(value: unknown): PublishedStreamSnapshot | null {
  const record = object(value);
  if (record?.version === PUBLISHED_STREAM_VERSION) {
    if (!validRestoredTrack(record.track) || !validRestoredSource(record.source)) return null;
    if (
      record.track.source_platform !== record.source.platform ||
      record.track.source_key !== record.source.key
    ) return null;
    return {
      version: PUBLISHED_STREAM_VERSION,
      track: record.track,
      source: record.source,
    };
  }
  if (!validRestoredTrack(value)) return null;
  const source = legacySource(value);
  return source ? { version: PUBLISHED_STREAM_VERSION, track: value, source } : null;
}

function registerRestoredStreamTrack(track: Track, source: SongSource): void {
  const existing = metaById.get(track.id);
  if (!existing) {
    metaById.set(track.id, {
      url: "",
      waveformToken: "",
      cover: source.cover || "",
      kind: "song",
      sourceKey: `${source.platform}:${source.key}`,
      source,
      nextTrack: null,
      cacheRetryUsed: false,
      preload: null,
    });
  }
  trackById.set(track.id, track);
  nextId = Math.min(nextId, track.id - 1);
  publishedStreamTrackId = track.id;
  pruneStreamTracks();
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** 清除 Android 原生侧持有的浏览器流时钟，避免换回本地曲目后串词。 */
function clearNativeStreamLyricsClock(): void {
  lastNativeStreamLyricsClock = null;
  const push = window.kdj?.lyricsPlaybackClock;
  if (!push) return;
  void push({
    trackId: null,
    position: 0,
    duration: 0,
    playing: false,
    rate: 1,
  }).catch(() => {});
}

/**
 * 仅给 Android 原生浮层同步浏览器试听时钟。
 *
 * 不限速会把部分 Android WebView 的高频 timeupdate 变成大量 IPC；250ms 一次
 * 足以校准，而 seek、播放/暂停、换曲、倍速变化都会绕过限速立即送达。
 */
function publishNativeStreamLyricsClock(
  state: PublishedStreamPlayback,
  force = false,
): void {
  if (!nativeStreamLyricsClockEnabled) return;
  // Android Tauri 的在线音频与本地音频共用 Rust coordinator；MediaSession 快照已经
  // 带权威时钟，再推浏览器外部时钟会造成暂停/seek 后歌词被旧时间线拉回。
  if (window.__TAURI_INTERNALS__ && window.kdj?.platform === "android") return;
  const push = window.kdj?.lyricsPlaybackClock;
  if (!push) return;

  const now = monotonicNow();
  const previous = lastNativeStreamLyricsClock;
  const predicted = previous
    ? previous.position +
      (previous.playing ? ((now - previous.sentAt) / 1000) * previous.rate : 0)
    : 0;
  const significantSeek = Boolean(
    previous && Math.abs(state.position - predicted) >= NATIVE_LYRICS_CLOCK_SEEK_EPSILON_SEC,
  );
  const shouldSend =
    force ||
    !previous ||
    previous.trackId !== state.trackId ||
    previous.playing !== state.playing ||
    previous.rate !== state.rate ||
    previous.duration !== state.duration ||
    significantSeek ||
    now - previous.sentAt >= NATIVE_LYRICS_CLOCK_MIN_INTERVAL_MS;
  if (!shouldSend) return;

  const sent = { ...state, sentAt: now };
  lastNativeStreamLyricsClock = sent;
  void push(state).catch(() => {
    // IPC 短暂失败时不要把限频窗口锁死；下一次 timeupdate 会重试。
    if (lastNativeStreamLyricsClock === sent) lastNativeStreamLyricsClock = null;
  });
}

/**
 * Android 悬浮歌词显隐时调用。关闭即清空原生缓存；重新打开时用最近一次已有的
 * PlayerBar 状态立即补一拍，不另起定时器或第二条高频 effect。
 */
export function setNativeStreamLyricsClockEnabled(enabled: boolean): void {
  nativeStreamLyricsClockEnabled = enabled;
  if (!enabled) {
    clearNativeStreamLyricsClock();
    return;
  }
  if (latestStreamPlayback) publishNativeStreamLyricsClock(latestStreamPlayback, true);
}

function notifyStreamTrackChanged(track: Track | null): void {
  void import("@tauri-apps/api/event")
    .then(({ emitTo }) => emitTo("lyrics-overlay", "stream-track-changed", track))
    .catch(() => {});
}

/** 主窗播放 / 切换在线试听时调用，供桌面歌词窗直取平台歌词。 */
export function publishStreamTrack(track: Track | null): void {
  const nextStreamTrackId = track && track.id < 0 ? track.id : null;
  const changed = publishedStreamTrackId !== nextStreamTrackId;
  publishedStreamTrackId = nextStreamTrackId;
  if (changed) {
    // 换流 / 切回本地曲目时先清掉旧时钟。新曲的下一次既有状态发布会立即补入。
    latestStreamPlayback = null;
    clearNativeStreamLyricsClock();
  }
  if (publishedStreamTrackId !== null) touchStreamTrack(publishedStreamTrackId);
  pruneStreamTracks();
  if (track && track.id < 0) {
    const source = streamMeta(track)?.source;
    if (source) {
      writeLocalStorageNow(
        PUBLISHED_STREAM_KEY,
        JSON.stringify({
          version: PUBLISHED_STREAM_VERSION,
          track,
          source,
        } satisfies PublishedStreamSnapshot),
      );
    }
  } else {
    discardLocalStorageWrite(PUBLISHED_STREAM_PLAYBACK_KEY);
    removeLocalStorage(PUBLISHED_STREAM_KEY);
    removeLocalStorage(PUBLISHED_STREAM_PLAYBACK_KEY);
  }
  notifyStreamTrackChanged(track && track.id < 0 ? track : null);
}

/** 主窗的浏览器试听不经过 Rust 播放器；把它的时钟推给独立歌词 WebView。 */
export function publishStreamTrackState(
  track: Track | null,
  position: number,
  playing: boolean,
  rate = 1,
): void {
  if (!track || track.id >= 0) return;
  const state: PublishedStreamPlayback = {
    trackId: track.id,
    position: Number.isFinite(position) ? Math.max(0, position) : 0,
    duration: Number.isFinite(track.duration) && track.duration ? Math.max(0, track.duration) : 0,
    playing,
    rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
  };
  latestStreamPlayback = state;
  publishNativeStreamLyricsClock(state);
  // timeupdate / 原生快照可达 4~10Hz。跨窗实时同步走下面的 Tauri event，
  // localStorage 只是歌词窗重启时的兜底，十秒保留一次最新快照已经足够。
  writeLocalStorageSoon(PUBLISHED_STREAM_PLAYBACK_KEY, JSON.stringify(state), 10_000);
  void import("@tauri-apps/api/event")
    .then(({ emitTo }) =>
      emitTo(
        "lyrics-overlay",
        "stream-playback-state",
        {
          track,
          playback: state,
        } satisfies PublishedStreamPlaybackEvent,
      ),
    )
    .catch(() => {});
}

export function readPublishedStreamTrack(trackId?: number): Track | null {
  if (trackId !== undefined && trackId >= 0) return null;
  try {
    const stored = readLocalStorage(PUBLISHED_STREAM_KEY);
    if (!stored || stored.length > MAX_PUBLISHED_STREAM_BYTES) {
      if (stored) removeLocalStorage(PUBLISHED_STREAM_KEY);
      return null;
    }
    const raw: unknown = JSON.parse(stored);
    const snapshot = publishedStreamSnapshot(raw);
    if (!snapshot) {
      removeLocalStorage(PUBLISHED_STREAM_KEY);
      removeLocalStorage(PUBLISHED_STREAM_PLAYBACK_KEY);
      return null;
    }
    const { track, source } = snapshot;
    if (trackId !== undefined && track.id !== trackId) return null;
    registerRestoredStreamTrack(track, source);
    return track;
  } catch {
    return null;
  }
}

export function readPublishedStreamPlayback(): PublishedStreamPlayback | null {
  try {
    const raw: unknown = JSON.parse(readLocalStorage(PUBLISHED_STREAM_PLAYBACK_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<PublishedStreamPlayback>;
    const track = readPublishedStreamTrack();
    if (
      !track ||
      typeof value.trackId !== "number" ||
      value.trackId !== track.id ||
      value.trackId >= 0 ||
      typeof value.position !== "number" ||
      typeof value.duration !== "number" ||
      typeof value.playing !== "boolean" ||
      typeof value.rate !== "number"
    ) {
      return null;
    }
    return {
      trackId: value.trackId,
      position: Number.isFinite(value.position) ? Math.max(0, value.position) : 0,
      duration: Number.isFinite(value.duration) ? Math.max(0, value.duration) : 0,
      playing: value.playing,
      rate: Number.isFinite(value.rate) && value.rate > 0 ? value.rate : 1,
    };
  } catch {
    return null;
  }
}

export function isStreamTrack(track: Track | null | undefined): boolean {
  return usesRemotePlaybackSource(track);
}

export function streamMeta(track: Track | null | undefined): StreamMeta | null {
  if (!track || track.id >= 0) return null;
  return touchStreamTrack(track.id)?.meta ?? null;
}

export function streamMediaUrl(track: Track): string | null {
  return streamMeta(track)?.url || null;
}

export function streamWaveformToken(track: Track | null | undefined): string {
  return streamMeta(track)?.waveformToken || "";
}

/**
 * Provider resolution mutates the short-lived side table rather than the Track object. Expose a
 * tiny external-store edge so React does not have to rely on an unrelated playback clock render
 * before it notices that the waveform token has arrived.
 */
export function subscribeStreamMeta(trackId: number, listener: () => void): () => void {
  if (trackId >= 0) return () => {};
  let current = metaListeners.get(trackId);
  if (!current) {
    current = new Set();
    metaListeners.set(trackId, current);
  }
  current.add(listener);
  return () => {
    current?.delete(listener);
    if (!current?.size) metaListeners.delete(trackId);
  };
}

export function streamWaveformTokenById(trackId: number): string {
  return trackId < 0 ? metaById.get(trackId)?.waveformToken || "" : "";
}

function notifyStreamMeta(trackId: number): void {
  for (const listener of metaListeners.get(trackId) ?? []) listener();
}

export function streamCoverUrl(track: Track): string {
  const cover = streamMeta(track)?.cover ?? "";
  return cover ? thumbUrl(cover, 96) : "";
}

/** 主播放条装 src 时用：在线流优先，否则走曲库音频接口。 */
export function mediaUrlForTrack(track: Track): string {
  // 未解析完的在线占位曲目同样没有曲库音频；不能退回 /library/audio/:负id。
  if (isStreamTrack(track)) return streamMediaUrl(track) ?? "";
  return api.audioUrl(track.id);
}

/** 唱盘已有展示元数据，但 provider 直链还没回来，不能拿空 src 去 load。 */
export function isUnresolvedStreamTrack(track: Track | null | undefined): boolean {
  return Boolean(track && isStreamTrack(track) && !streamMediaUrl(track));
}

export function makeSongStreamTrack(
  source: SongSource,
  url: string,
  cacheRetryUsed = false,
  waveformToken = "",
): Track {
  const id = nextId--;
  const title = source.title || "在线试听";
  const artist = source.artists.join(", ");
  metaById.set(id, {
    url,
    waveformToken,
    cover: source.cover || "",
    kind: "song",
    sourceKey: `${source.platform}:${source.key}`,
    source,
    nextTrack: null,
    cacheRetryUsed,
    preload: null,
  });
  const now = new Date().toISOString();
  const track: Track = {
    id,
    path: `stream:${source.platform}:${source.key}`,
    filename: title,
    title,
    artist,
    album: source.album || "",
    genre: "",
    year: "",
    duration: source.duration,
    bitrate: null,
    samplerate: null,
    channels: null,
    format: "stream",
    size: 0,
    bpm: null,
    bpm_confidence: null,
    first_beat: null,
    music_key: "",
    camelot: "",
    open_key: "",
    key_confidence: null,
    energy: null,
    rms_db: null,
    peak_db: null,
    rating: 0,
    color: "",
    comment: "在线试听（未下载）",
    cue_ms: null,
    end_ms: null,
    source_platform: source.platform,
    source_key: source.key,
    analyzed_at: null,
    added_at: now,
    modified_at: now,
    analysis_error: "",
    tags: [],
    folder: "",
  };
  trackById.set(id, track);
  pruneStreamTracks();
  return track;
}

/** 波形等后台任务只拿到负 id 时，取回仍存活的在线试听快照。 */
export function streamTrackById(id: number): Track | null {
  return id < 0 ? touchStreamTrack(id)?.track ?? null : null;
}

/** 搜索结果的后继项先只建展示元数据；真正轮到它播放时才解析直链。 */
export function makePendingSongStreamTrack(source: SongSource): Track {
  return makeSongStreamTrack(source, "");
}

export function setStreamNextTrack(track: Track, next: Track | null): void {
  const meta = streamMeta(track);
  if (meta) meta.nextTrack = next;
}

export function streamNextTrack(track: Track | null | undefined): Track | null {
  return streamMeta(track)?.nextTrack ?? null;
}

/**
 * 媒体 decode/读取失败时领取一次强制回源资格；返回 null 表示不允许自动重试。
 * YouTube Music 的 proof、Player、SABR 和音频代理是一条原子链路。失败时必须暴露
 * 原因，不能靠重新签发 proof 掩盖首轮失败；用户仍可从错误界面显式重新播放。
 */
export function claimStreamCacheRetry(track: Track): SongSource | null {
  const meta = streamMeta(track);
  if (!meta || meta.kind !== "song" || !meta.source || meta.cacheRetryUsed) return null;
  if (meta.source.platform === "ytm") return null;
  meta.cacheRetryUsed = true;
  return meta.source;
}

/** 将搜索结果占位曲目解析成可播放流，保留 id 和已经串好的后继链。 */
export function preloadStreamTrack(track: Track): Promise<void> {
  const meta = streamMeta(track);
  if (!meta) return Promise.reject(new Error("在线试听上下文已经失效"));
  if (meta.url) return Promise.resolve();
  if (!meta.source) return Promise.reject(new Error("在线试听来源缺失"));
  if (meta.preload) return meta.preload;

  const source = meta.source;
  let request: Promise<void>;
  request = api
    .songPreview(source, meta.cacheRetryUsed)
    .then(({ url, waveform_token: waveformToken }) => {
      // 解析期间条目受 prune 保护；这里仍核对身份，避免将迟到结果写进复用上下文。
      if (metaById.get(track.id) !== meta) {
        throw new Error("在线试听上下文已经失效");
      }
      if (!url) throw new Error("平台没有返回可播放地址");
      meta.url = url;
      meta.waveformToken = waveformToken || "";
      notifyStreamMeta(track.id);
    })
    .finally(() => {
      if (meta.preload === request) meta.preload = null;
      pruneStreamTracks();
    });
  meta.preload = request;
  return request;
}

export async function resolvePendingStreamTrack(track: Track): Promise<Track> {
  const meta = streamMeta(track);
  if (!meta) throw new Error("在线试听上下文已经失效");
  await preloadStreamTrack(track);
  return track;
}

interface TouchedStreamTrack {
  meta: StreamMeta;
  track: Track;
}

/** Map 的插入顺序兼作 LRU；读取一次就挪到队尾。 */
function touchStreamTrack(id: number): TouchedStreamTrack | null {
  const meta = metaById.get(id);
  const track = trackById.get(id);
  if (!meta || !track) return null;
  metaById.delete(id);
  metaById.set(id, meta);
  trackById.delete(id);
  trackById.set(id, track);
  return { meta, track };
}

/** 当前曲和已经串好的后继曲都属于播放会话，不能因用户继续搜索而失效。 */
function protectedStreamTrackIds(): Set<number> {
  const protectedIds = new Set<number>();
  for (const [id, meta] of metaById) {
    if (meta.preload) protectedIds.add(id);
  }
  let id = publishedStreamTrackId;
  const visited = new Set<number>();
  while (id !== null && id < 0 && !visited.has(id)) {
    visited.add(id);
    protectedIds.add(id);
    const next = metaById.get(id)?.nextTrack;
    id = next && next.id < 0 ? next.id : null;
  }
  return protectedIds;
}

function pruneStreamTracks(): void {
  if (metaById.size <= STREAM_TRACK_CACHE_LIMIT) return;
  const protectedIds = protectedStreamTrackIds();
  for (const id of [...metaById.keys()]) {
    if (metaById.size <= STREAM_TRACK_CACHE_LIMIT) break;
    if (protectedIds.has(id)) continue;
    metaById.delete(id);
    trackById.delete(id);
    notifyStreamMeta(id);
  }
}
