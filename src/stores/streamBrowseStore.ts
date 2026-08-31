/**
 * 云歌单目录浏览态。
 *
 * 持久层只保存歌单标题、封面、来源和数量，不保存歌单歌曲、试听地址或本地 Track。
 * 每份目录缓存都绑定账号签名；未确认账号身份前不会读缓存，登出/换号会立即清空。
 */

import { create } from "zustand";
import { api } from "../lib/api";
import type { StreamPlaylistRecentEntry } from "../lib/streamPlaylistOrder";
import type { Account, Platform, StreamPlaylist } from "../types";

export const STREAM_BROWSE_PLATFORMS = [
  "wyy",
  "qqm",
  "soundcloud",
  "ytm",
  "youtube",
  "bilibili",
] as const;
export type StreamBrowsePlatform = Extract<
  Platform,
  (typeof STREAM_BROWSE_PLATFORMS)[number]
>;
export const STREAM_PLAYLIST_SECTION_IDS = [
  "favorite",
  "created",
  "collected",
  "other",
] as const;
export type StreamPlaylistSectionId =
  (typeof STREAM_PLAYLIST_SECTION_IDS)[number];

/** 成功缓存十分钟；只有用户展开目录时才会按需刷新。 */
export const STREAM_PLAYLIST_CACHE_TTL_MS = 10 * 60 * 1000;
/** 持久时间戳最多容忍五分钟系统时钟偏差；与网络请求频率无关。 */
const MAX_FUTURE_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

const STREAM_PLAYLIST_CACHE_VERSION = 3;
const STREAM_PLAYLIST_CACHE_KEY = `kd-stream-playlist-directory-v${STREAM_PLAYLIST_CACHE_VERSION}`;
const STREAM_PLAYLIST_LEGACY_CACHE_KEYS = [
  "kd-stream-playlist-directory-v1",
  "kd-stream-playlist-directory-v2",
] as const;
const STREAM_PLAYLIST_RECENT_VERSION = 1;
const STREAM_PLAYLIST_RECENT_KEY = `kd-stream-playlist-recent-v${STREAM_PLAYLIST_RECENT_VERSION}`;
const STREAM_BROWSE_LAYOUT_KEY = "kd-stream-browse-layout-v1";
const MAX_CACHED_PLAYLISTS = 500;
const MAX_RECENT_PLAYLISTS = 200;
const MAX_KEY_LENGTH = 512;
const MAX_TITLE_LENGTH = 512;
const MAX_COVER_LENGTH = 4096;
const MAX_ORIGIN_LENGTH = 64;
const MAX_SIGNATURE_LENGTH = 8192;
const MAX_IDENTITY_FIELD_LENGTH = 2048;

type PlatformMap<T> = Record<StreamBrowsePlatform, T>;
type SectionMap<T> = Record<StreamPlaylistSectionId, T>;

export interface ActiveStreamPlaylist {
  platform: StreamBrowsePlatform;
  key: string;
}

/**
 * sessionKey 只在本次应用进程内辨认账号；cacheSignature 非空时才允许持久读写。
 * 老后端若不给任何身份字段，会得到 volatile sessionKey：仍可在线浏览，但绝不复用
 * 一份无法证明属于当前账号的磁盘缓存。
 */
export interface StreamAccountBinding {
  sessionKey: string;
  cacheSignature: string | null;
}

export interface StreamPlaylistRefreshOptions {
  /** 仅供用户明确点击刷新使用：绕过十分钟目录缓存。 */
  force?: boolean;
}

interface PersistedPlatformCache {
  accountSignature: string;
  updatedAt: number;
  playlists: StreamPlaylist[];
}

interface PersistedDirectoryCache {
  version: number;
  platforms: Partial<Record<StreamBrowsePlatform, PersistedPlatformCache>>;
}

interface PersistedPlatformRecents {
  accountSignature: string;
  entries: StreamPlaylistRecentEntry[];
}

interface PersistedPlaylistRecents {
  version: number;
  platforms: Partial<Record<StreamBrowsePlatform, PersistedPlatformRecents>>;
}

interface StreamBrowseStore {
  /** null = 尚无可展示目录；[] = 已成功读取但账号没有歌单。 */
  playlists: PlatformMap<StreamPlaylist[] | null>;
  loading: PlatformMap<boolean>;
  errors: PlatformMap<string>;
  expanded: PlatformMap<boolean>;
  /** 二级分组独立折叠；与平台根节点分开，宽/窄侧栏共享当前会话状态。 */
  sectionExpanded: PlatformMap<SectionMap<boolean>>;
  /** 当前账号在 KDJ 中最近打开过的歌单；只用于覆盖平台目录的展示顺序。 */
  recentlyOpened: PlatformMap<StreamPlaylistRecentEntry[]>;
  /** 最近点开的远程歌单，仅用于侧栏高亮，不代表本地曲库选择。 */
  active: ActiveStreamPlaylist | null;
  accountKeys: PlatformMap<string | null>;
  cacheSignatures: PlatformMap<string | null>;
  updatedAt: PlatformMap<number>;
  /** 登出/换号期间让在途旧请求失效。 */
  revisions: PlatformMap<number>;

  /** 绑定 null 表示已确认登出；会清内存与该平台持久缓存。 */
  bindAccount(
    platform: StreamBrowsePlatform,
    binding: StreamAccountBinding | null,
  ): Promise<void>;
  refreshIfStale(
    platform: StreamBrowsePlatform,
    options?: StreamPlaylistRefreshOptions,
  ): Promise<StreamPlaylist[]>;
  /** 兼容侧栏原有调用：force=true 等同手动强刷。 */
  loadPlaylists(platform: StreamBrowsePlatform, force?: boolean): Promise<StreamPlaylist[]>;
  /** 只清当前平台内存目录；账号绑定保持不变，下一次访问会重新读取。 */
  invalidate(platform: StreamBrowsePlatform): void;
  setExpanded(platform: StreamBrowsePlatform, expanded: boolean): void;
  setSectionExpanded(
    platform: StreamBrowsePlatform,
    section: StreamPlaylistSectionId,
    expanded: boolean,
  ): void;
  setActive(playlist: ActiveStreamPlaylist | null): void;
  setError(platform: StreamBrowsePlatform, error: string): void;
}

function platformMap<T>(create: (platform: StreamBrowsePlatform) => T): PlatformMap<T> {
  return Object.fromEntries(
    STREAM_BROWSE_PLATFORMS.map((platform) => [platform, create(platform)]),
  ) as PlatformMap<T>;
}

function defaultSectionExpanded(): SectionMap<boolean> {
  return { favorite: true, created: true, collected: true, other: true };
}

interface PersistedBrowseLayout {
  expanded: PlatformMap<boolean>;
  sectionExpanded: PlatformMap<SectionMap<boolean>>;
}

function defaultBrowseLayout(): PersistedBrowseLayout {
  return {
    expanded: platformMap(() => false),
    sectionExpanded: platformMap(() => defaultSectionExpanded()),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let volatileAccountSerial = 0;
const volatileAccountKeys = new WeakMap<object, string>();

/**
 * 为 FolderTree 生成账号绑定。身份字段完整时签名可跨启动复用；无法可靠识别身份时
 * 使用与 Account 对象绑定的进程内 key，账号对象一换就会清掉上一份内存目录。
 */
export function streamAccountBinding(account: Account | undefined): StreamAccountBinding | null {
  if (!account || (account.state !== "valid" && account.state !== "unknown")) return null;
  const accountKey = account.account_key?.trim() ?? "";
  if (accountKey && accountKey.length <= MAX_IDENTITY_FIELD_LENGTH) {
    const cacheSignature = JSON.stringify(["account-v2", account.platform, accountKey]);
    return {
      sessionKey: `persistent:${cacheSignature}`,
      cacheSignature,
    };
  }
  const nickname = account.nickname.trim();
  const avatar = account.avatar.trim();
  const identityFields = [nickname, avatar];
  if (
    identityFields.some(Boolean) &&
    identityFields.every((field) => field.length <= MAX_IDENTITY_FIELD_LENGTH)
  ) {
    // 兼容缺少 account_key 的旧后端。detail 是状态文案：同一网易云账号在
    // 正常/unknown 时可能从“普通用户”变成动态网络错误，不能参与持久身份。
    const cacheSignature = JSON.stringify([
      "account-v2-profile",
      account.platform,
      nickname,
      avatar,
    ]);
    return {
      sessionKey: `persistent:${cacheSignature}`,
      cacheSignature,
    };
  }

  let sessionKey = volatileAccountKeys.get(account);
  if (!sessionKey) {
    volatileAccountSerial += 1;
    sessionKey = `volatile:${account.platform}:${volatileAccountSerial}`;
    volatileAccountKeys.set(account, sessionKey);
  }
  return { sessionKey, cacheSignature: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedString(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= limit ? normalized : null;
}

function sanitizePlaylist(
  value: unknown,
  expectedPlatform: StreamBrowsePlatform,
): StreamPlaylist | null {
  if (!isRecord(value) || value.platform !== expectedPlatform) return null;
  const key = boundedString(value.key, MAX_KEY_LENGTH);
  const title = boundedString(value.title, MAX_TITLE_LENGTH);
  const cover = boundedString(value.cover, MAX_COVER_LENGTH);
  const origin = value.origin === undefined
    ? undefined
    : boundedString(value.origin, MAX_ORIGIN_LENGTH);
  const count = typeof value.count === "number" && Number.isFinite(value.count)
    ? Math.min(1_000_000_000, Math.max(0, Math.trunc(value.count)))
    : null;
  if (!key || title === null || cover === null || count === null) return null;
  if (origin === null) return null;
  return {
    platform: expectedPlatform,
    key,
    title: title || "未命名歌单",
    cover,
    count,
    is_favorite: value.is_favorite === true,
    ...(origin === undefined ? {} : { origin }),
  };
}

/** 平台偶尔会回重复项；稳定去重，但绝不能覆盖平台接口给出的默认顺序。 */
function normalizePlaylists(
  value: unknown,
  platform: StreamBrowsePlatform,
): StreamPlaylist[] {
  if (!Array.isArray(value)) throw new Error("平台返回的歌单目录格式无效");
  const seen = new Set<string>();
  const playlists = value.flatMap((item) => {
    const playlist = sanitizePlaylist(item, platform);
    if (!playlist || seen.has(playlist.key)) return [];
    seen.add(playlist.key);
    return [playlist];
  });
  if (value.length > 0 && playlists.length === 0) {
    throw new Error("平台返回的歌单目录无法校验");
  }
  return playlists;
}

function emptyPersistedCache(): PersistedDirectoryCache {
  return { version: STREAM_PLAYLIST_CACHE_VERSION, platforms: {} };
}

function emptyPersistedRecents(): PersistedPlaylistRecents {
  return { version: STREAM_PLAYLIST_RECENT_VERSION, platforms: {} };
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 展开态只含布尔偏好，不绑定账号；各在线来源和二级文件夹分别记忆。 */
function readPersistedBrowseLayout(): PersistedBrowseLayout {
  const fallback = defaultBrowseLayout();
  const storage = browserStorage();
  if (!storage) return fallback;
  try {
    const raw: unknown = JSON.parse(storage.getItem(STREAM_BROWSE_LAYOUT_KEY) ?? "null");
    if (!isRecord(raw)) return fallback;
    for (const platform of STREAM_BROWSE_PLATFORMS) {
      if (typeof raw.expanded === "object" && raw.expanded !== null) {
        const value = (raw.expanded as Record<string, unknown>)[platform];
        if (typeof value === "boolean") fallback.expanded[platform] = value;
      }
      if (typeof raw.sectionExpanded !== "object" || raw.sectionExpanded === null) continue;
      const sections = (raw.sectionExpanded as Record<string, unknown>)[platform];
      if (!isRecord(sections)) continue;
      for (const section of STREAM_PLAYLIST_SECTION_IDS) {
        const value = sections[section];
        if (typeof value === "boolean") fallback.sectionExpanded[platform][section] = value;
      }
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function writePersistedBrowseLayout(layout: PersistedBrowseLayout): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(STREAM_BROWSE_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // 偏好写失败只退回当前会话，不影响云歌单目录本身。
  }
}

function writePersistedCache(cache: PersistedDirectoryCache): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    if (Object.keys(cache.platforms).length === 0) {
      storage.removeItem(STREAM_PLAYLIST_CACHE_KEY);
      return;
    }
    storage.setItem(STREAM_PLAYLIST_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 隐私模式、配额或系统策略禁用 localStorage 时退回纯内存，不挡歌单浏览。
  }
}

function writePersistedRecents(recents: PersistedPlaylistRecents): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    if (Object.keys(recents.platforms).length === 0) {
      storage.removeItem(STREAM_PLAYLIST_RECENT_KEY);
      return;
    }
    storage.setItem(STREAM_PLAYLIST_RECENT_KEY, JSON.stringify(recents));
  } catch {
    // 最近打开记录写失败时只失去跨启动排序，不影响平台目录和打开歌单。
  }
}

function sanitizeRecentEntries(value: unknown): StreamPlaylistRecentEntry[] {
  if (!Array.isArray(value)) return [];
  const now = Date.now();
  const seen = new Set<string>();
  const entries = value
    .slice(0, MAX_RECENT_PLAYLISTS * 2)
    .flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      const key = boundedString(candidate.key, MAX_KEY_LENGTH);
      const openedAt = candidate.openedAt;
      if (
        !key ||
        seen.has(key) ||
        typeof openedAt !== "number" ||
        !Number.isFinite(openedAt) ||
        openedAt <= 0 ||
        openedAt > now + MAX_FUTURE_TIMESTAMP_SKEW_MS
      ) {
        return [];
      }
      seen.add(key);
      return [{ key, openedAt }];
    });
  entries.sort((left, right) => right.openedAt - left.openedAt);
  return entries.slice(0, MAX_RECENT_PLAYLISTS);
}

/** 最近打开记录和目录缓存分开保存，避免本地排序覆盖平台原始回包顺序。 */
function readPersistedRecents(): PersistedPlaylistRecents {
  const storage = browserStorage();
  if (!storage) return emptyPersistedRecents();
  try {
    const raw = storage.getItem(STREAM_PLAYLIST_RECENT_KEY);
    if (!raw) return emptyPersistedRecents();
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.version !== STREAM_PLAYLIST_RECENT_VERSION ||
      !isRecord(parsed.platforms)
    ) {
      throw new Error("recent schema mismatch");
    }
    const safe = emptyPersistedRecents();
    for (const platform of STREAM_BROWSE_PLATFORMS) {
      const candidate = parsed.platforms[platform];
      if (
        !isRecord(candidate) ||
        typeof candidate.accountSignature !== "string" ||
        candidate.accountSignature.length === 0 ||
        candidate.accountSignature.length > MAX_SIGNATURE_LENGTH
      ) {
        continue;
      }
      const entries = sanitizeRecentEntries(candidate.entries);
      safe.platforms[platform] = {
        accountSignature: candidate.accountSignature,
        entries,
      };
    }
    if (JSON.stringify(parsed) !== JSON.stringify(safe)) writePersistedRecents(safe);
    return safe;
  } catch {
    try {
      storage.removeItem(STREAM_PLAYLIST_RECENT_KEY);
    } catch {
      // 删除也受限时维持纯内存运行。
    }
    return emptyPersistedRecents();
  }
}

/** 读取时逐字段校验；坏 JSON/旧版本/越界内容会被删掉或重写成安全子集。 */
function readPersistedCache(): PersistedDirectoryCache {
  const storage = browserStorage();
  if (!storage) return emptyPersistedCache();
  try {
    // 旧缓存已经丢失平台原始顺序，不能迁移成新的默认顺序；同时避免换号/登出后
    // 留下一份再也不会被当前版本读取或清理的私人目录元数据。
    for (const key of STREAM_PLAYLIST_LEGACY_CACHE_KEYS) storage.removeItem(key);
    const raw = storage.getItem(STREAM_PLAYLIST_CACHE_KEY);
    if (!raw) return emptyPersistedCache();
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.version !== STREAM_PLAYLIST_CACHE_VERSION ||
      !isRecord(parsed.platforms)
    ) {
      throw new Error("cache schema mismatch");
    }
    const safe = emptyPersistedCache();
    const now = Date.now();
    for (const platform of STREAM_BROWSE_PLATFORMS) {
      const candidate = parsed.platforms[platform];
      if (!isRecord(candidate) || !Array.isArray(candidate.playlists)) continue;
      if (
        typeof candidate.accountSignature !== "string" ||
        candidate.accountSignature.length === 0 ||
        candidate.accountSignature.length > MAX_SIGNATURE_LENGTH ||
        typeof candidate.updatedAt !== "number" ||
        !Number.isFinite(candidate.updatedAt) ||
        candidate.updatedAt <= 0 ||
        candidate.updatedAt > now + MAX_FUTURE_TIMESTAMP_SKEW_MS
      ) {
        continue;
      }
      const playlists = candidate.playlists
        .slice(0, MAX_CACHED_PLAYLISTS)
        .flatMap((item) => {
          const playlist = sanitizePlaylist(item, platform);
          return playlist ? [playlist] : [];
        });
      if (candidate.playlists.length > 0 && playlists.length === 0) continue;
      safe.platforms[platform] = {
        accountSignature: candidate.accountSignature,
        updatedAt: Math.min(now, candidate.updatedAt),
        playlists: normalizePlaylists(playlists, platform),
      };
    }
    // 顺手移除无效条目与超量内容；下次启动不会重复解析同一份坏缓存。
    if (JSON.stringify(parsed) !== JSON.stringify(safe)) writePersistedCache(safe);
    return safe;
  } catch {
    try {
      storage.removeItem(STREAM_PLAYLIST_CACHE_KEY);
    } catch {
      // 删除也被系统拦截时维持纯内存运行。
    }
    return emptyPersistedCache();
  }
}

function removePersistedPlatform(platform: StreamBrowsePlatform): void {
  const cache = readPersistedCache();
  if (!cache.platforms[platform]) return;
  delete cache.platforms[platform];
  writePersistedCache(cache);
}

function removePersistedPlatformRecents(platform: StreamBrowsePlatform): void {
  const recents = readPersistedRecents();
  if (!recents.platforms[platform]) return;
  delete recents.platforms[platform];
  writePersistedRecents(recents);
}

function matchingPersistedPlatform(
  platform: StreamBrowsePlatform,
  accountSignature: string,
): PersistedPlatformCache | null {
  const cache = readPersistedCache();
  const candidate = cache.platforms[platform];
  if (!candidate) return null;
  if (candidate.accountSignature === accountSignature) return candidate;
  // 单平台只保留当前账号一份；换号时直接删除上一账号的私人目录元数据。
  delete cache.platforms[platform];
  writePersistedCache(cache);
  return null;
}

function matchingPersistedPlatformRecents(
  platform: StreamBrowsePlatform,
  accountSignature: string,
): StreamPlaylistRecentEntry[] {
  const recents = readPersistedRecents();
  const candidate = recents.platforms[platform];
  if (!candidate) return [];
  if (candidate.accountSignature === accountSignature) return candidate.entries;
  // 账号切换后不能让上一账号的私人使用记录影响当前目录。
  delete recents.platforms[platform];
  writePersistedRecents(recents);
  return [];
}

function persistPlatform(
  platform: StreamBrowsePlatform,
  accountSignature: string,
  updatedAt: number,
  playlists: StreamPlaylist[],
): void {
  const cache = readPersistedCache();
  cache.platforms[platform] = {
    accountSignature,
    updatedAt,
    playlists: playlists.slice(0, MAX_CACHED_PLAYLISTS),
  };
  writePersistedCache(cache);
}

function persistPlatformRecents(
  platform: StreamBrowsePlatform,
  accountSignature: string,
  entries: StreamPlaylistRecentEntry[],
): void {
  const recents = readPersistedRecents();
  recents.platforms[platform] = {
    accountSignature,
    entries: entries.slice(0, MAX_RECENT_PLAYLISTS),
  };
  writePersistedRecents(recents);
}

const initialBrowseLayout = readPersistedBrowseLayout();

export const useStreamBrowseStore = create<StreamBrowseStore>()((set, get) => ({
  playlists: platformMap(() => null),
  loading: platformMap(() => false),
  errors: platformMap(() => ""),
  expanded: initialBrowseLayout.expanded,
  sectionExpanded: initialBrowseLayout.sectionExpanded,
  recentlyOpened: platformMap(() => []),
  active: null,
  accountKeys: platformMap(() => null),
  cacheSignatures: platformMap(() => null),
  updatedAt: platformMap(() => 0),
  revisions: platformMap(() => 0),

  async bindAccount(platform, binding) {
    const before = get();
    const nextKey = binding?.sessionKey ?? null;
    const nextCacheSignature = binding?.cacheSignature ?? null;
    const changed =
      before.accountKeys[platform] !== nextKey ||
      before.cacheSignatures[platform] !== nextCacheSignature;

    if (!binding) {
      // 只有 FolderTree 已确认账号 missing/expired（或 bootstrap 明确无此账号）才走这里。
      removePersistedPlatform(platform);
      removePersistedPlatformRecents(platform);
    } else if (!nextCacheSignature) {
      // 无法证明账号身份时宁可不缓存，也不能冒险展示另一账号的私人列表。
      removePersistedPlatform(platform);
      removePersistedPlatformRecents(platform);
    }

    if (changed) {
      const persisted = nextCacheSignature
        ? matchingPersistedPlatform(platform, nextCacheSignature)
        : null;
      const persistedRecents = nextCacheSignature
        ? matchingPersistedPlatformRecents(platform, nextCacheSignature)
        : [];
      set((state) => ({
        playlists: {
          ...state.playlists,
          [platform]: persisted?.playlists ?? null,
        },
        loading: { ...state.loading, [platform]: false },
        errors: { ...state.errors, [platform]: "" },
        accountKeys: { ...state.accountKeys, [platform]: nextKey },
        cacheSignatures: {
          ...state.cacheSignatures,
          [platform]: nextCacheSignature,
        },
        recentlyOpened: {
          ...state.recentlyOpened,
          [platform]: persistedRecents,
        },
        updatedAt: {
          ...state.updatedAt,
          [platform]: persisted?.updatedAt ?? 0,
        },
        revisions: {
          ...state.revisions,
          [platform]: state.revisions[platform] + 1,
        },
        active: state.active?.platform === platform ? null : state.active,
      }));
    }

    // 账号绑定到此为止：目录只在用户展开或按刷新按钮时读取。
  },

  async refreshIfStale(platform, options = {}) {
    const snapshot = get();
    const cached = snapshot.playlists[platform];
    const accountKey = snapshot.accountKeys[platform];
    if (!accountKey) return cached ?? [];

    const now = Date.now();
    const stale =
      cached === null ||
      snapshot.updatedAt[platform] <= 0 ||
      now - snapshot.updatedAt[platform] >= STREAM_PLAYLIST_CACHE_TTL_MS;
    if (!options.force && !stale) return cached;
    // 用户主动刷新立即执行；同一时刻的重复调用只由 loading 单飞合并。
    if (snapshot.loading[platform]) return cached ?? [];

    const revision = snapshot.revisions[platform];
    const cacheSignature = snapshot.cacheSignatures[platform];
    set((state) => ({
      loading: { ...state.loading, [platform]: true },
      errors: { ...state.errors, [platform]: "" },
    }));
    try {
      const playlists = normalizePlaylists(await api.streamPlaylists(platform), platform);
      const current = get();
      // 换号/登出后，旧账号迟到的响应不能落进新账号的树或持久缓存。
      if (
        current.revisions[platform] !== revision ||
        current.accountKeys[platform] !== accountKey
      ) {
        return current.playlists[platform] ?? [];
      }
      const updatedAt = Date.now();
      set((state) => ({
        playlists: { ...state.playlists, [platform]: playlists },
        loading: { ...state.loading, [platform]: false },
        errors: { ...state.errors, [platform]: "" },
        updatedAt: { ...state.updatedAt, [platform]: updatedAt },
      }));
      if (cacheSignature && get().cacheSignatures[platform] === cacheSignature) {
        persistPlatform(platform, cacheSignature, updatedAt, playlists);
      }
      return playlists;
    } catch (error) {
      const current = get();
      if (
        current.revisions[platform] !== revision ||
        current.accountKeys[platform] !== accountKey
      ) {
        return current.playlists[platform] ?? [];
      }
      // stale-while-revalidate：错误只作为非阻断提示，已有目录继续留在树里。
      set((state) => ({
        loading: { ...state.loading, [platform]: false },
        errors: { ...state.errors, [platform]: errorText(error) },
      }));
      return current.playlists[platform] ?? [];
    }
  },

  loadPlaylists(platform, force = false) {
    return get().refreshIfStale(platform, { force });
  },

  invalidate(platform) {
    set((state) => ({
      playlists: { ...state.playlists, [platform]: null },
      loading: { ...state.loading, [platform]: false },
      errors: { ...state.errors, [platform]: "" },
      updatedAt: { ...state.updatedAt, [platform]: 0 },
      revisions: { ...state.revisions, [platform]: state.revisions[platform] + 1 },
      active: state.active?.platform === platform ? null : state.active,
    }));
  },

  setExpanded(platform, expanded) {
    set((state) => {
      const next = { ...state.expanded, [platform]: expanded };
      writePersistedBrowseLayout({ expanded: next, sectionExpanded: state.sectionExpanded });
      return { expanded: next };
    });
  },

  setSectionExpanded(platform, section, expanded) {
    set((state) => {
      const next = {
        ...state.sectionExpanded,
        [platform]: {
          ...state.sectionExpanded[platform],
          [section]: expanded,
        },
      };
      writePersistedBrowseLayout({ expanded: state.expanded, sectionExpanded: next });
      return { sectionExpanded: next };
    });
  },

  setActive(active) {
    if (!active) {
      set({ active: null });
      return;
    }
    const snapshot = get();
    const key = active.key.trim();
    if (
      !key ||
      key.length > MAX_KEY_LENGTH ||
      !snapshot.accountKeys[active.platform]
    ) {
      set({ active });
      return;
    }
    const entries = [
      { key, openedAt: Date.now() },
      ...snapshot.recentlyOpened[active.platform].filter((entry) => entry.key !== key),
    ].slice(0, MAX_RECENT_PLAYLISTS);
    set((state) => ({
      active: { ...active, key },
      recentlyOpened: {
        ...state.recentlyOpened,
        [active.platform]: entries,
      },
    }));
    const accountSignature = snapshot.cacheSignatures[active.platform];
    if (accountSignature) {
      persistPlatformRecents(active.platform, accountSignature, entries);
    }
  },

  setError(platform, error) {
    set((state) => ({ errors: { ...state.errors, [platform]: error } }));
  },
}));
