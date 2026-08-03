/**
 * 云歌单目录浏览态。
 *
 * 持久层只保存歌单标题、封面、来源和数量，不保存歌单歌曲、试听地址或本地 Track。
 * 每份目录缓存都绑定账号签名；未确认账号身份前不会读缓存，登出/换号会立即清空。
 */

import { create } from "zustand";
import { api } from "../lib/api";
import type { Account, Platform, StreamPlaylist } from "../types";

export const STREAM_BROWSE_PLATFORMS = ["wyy", "qqm"] as const;
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

/** 成功缓存十分钟后才由普通生命周期刷新。 */
export const STREAM_PLAYLIST_CACHE_TTL_MS = 10 * 60 * 1000;
/** 自动刷新失败时，focus/visible 等信号至少隔五分钟再试。 */
export const STREAM_PLAYLIST_AUTO_REFRESH_GAP_MS = 5 * 60 * 1000;

const STREAM_PLAYLIST_CACHE_VERSION = 1;
const STREAM_PLAYLIST_CACHE_KEY = `kd-stream-playlist-directory-v${STREAM_PLAYLIST_CACHE_VERSION}`;
const STREAM_BROWSE_LAYOUT_KEY = "kd-stream-browse-layout-v1";
const MAX_CACHED_PLAYLISTS = 500;
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
  /** 手动刷新、启动校准和登录变化使用：绕过 TTL 与五分钟自动防抖。 */
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

interface StreamBrowseStore {
  /** null = 尚无可展示目录；[] = 已成功读取但账号没有歌单。 */
  playlists: PlatformMap<StreamPlaylist[] | null>;
  loading: PlatformMap<boolean>;
  errors: PlatformMap<string>;
  expanded: PlatformMap<boolean>;
  /** 二级分组独立折叠；与平台根节点分开，宽/窄侧栏共享当前会话状态。 */
  sectionExpanded: PlatformMap<SectionMap<boolean>>;
  /** 最近点开的远程歌单，仅用于侧栏高亮，不代表本地曲库选择。 */
  active: StreamPlaylist | null;
  accountKeys: PlatformMap<string | null>;
  cacheSignatures: PlatformMap<string | null>;
  updatedAt: PlatformMap<number>;
  lastAttemptAt: PlatformMap<number>;
  /** 同一账号在本次应用加载期间只做一次强制后台校准。 */
  calibratedAccountKeys: PlatformMap<string | null>;
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
  setActive(playlist: StreamPlaylist | null): void;
  setError(platform: StreamBrowsePlatform, error: string): void;
}

function platformMap<T>(wyy: T, qqm: T): PlatformMap<T> {
  return { wyy, qqm };
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
    expanded: platformMap(false, false),
    sectionExpanded: platformMap(defaultSectionExpanded(), defaultSectionExpanded()),
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

function originRank(playlist: StreamPlaylist): number {
  if (playlist.is_favorite || playlist.origin === "favorite") return 0;
  if (playlist.origin === "created") return 1;
  if (playlist.origin === "collected") return 2;
  return 3;
}

/** 平台偶尔会回重复项；稳定键去重后再按来源和标题排，避免展开顺序跳动。 */
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
  return playlists.sort(
    (left, right) =>
      originRank(left) - originRank(right) ||
      left.title.localeCompare(right.title, "zh-CN", { numeric: true }),
  );
}

function emptyPersistedCache(): PersistedDirectoryCache {
  return { version: STREAM_PLAYLIST_CACHE_VERSION, platforms: {} };
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 展开态只含布尔偏好，不绑定账号；NetEase 与 Q Music、各二级文件夹分别记忆。 */
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

/** 读取时逐字段校验；坏 JSON/旧版本/越界内容会被删掉或重写成安全子集。 */
function readPersistedCache(): PersistedDirectoryCache {
  const storage = browserStorage();
  if (!storage) return emptyPersistedCache();
  try {
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
        candidate.updatedAt > now + STREAM_PLAYLIST_AUTO_REFRESH_GAP_MS
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

const initialBrowseLayout = readPersistedBrowseLayout();

export const useStreamBrowseStore = create<StreamBrowseStore>()((set, get) => ({
  playlists: platformMap(null, null),
  loading: platformMap(false, false),
  errors: platformMap("", ""),
  expanded: initialBrowseLayout.expanded,
  sectionExpanded: initialBrowseLayout.sectionExpanded,
  active: null,
  accountKeys: platformMap(null, null),
  cacheSignatures: platformMap(null, null),
  updatedAt: platformMap(0, 0),
  lastAttemptAt: platformMap(0, 0),
  calibratedAccountKeys: platformMap(null, null),
  revisions: platformMap(0, 0),

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
    } else if (!nextCacheSignature) {
      // 无法证明账号身份时宁可不缓存，也不能冒险展示另一账号的私人列表。
      removePersistedPlatform(platform);
    }

    if (changed) {
      const persisted = nextCacheSignature
        ? matchingPersistedPlatform(platform, nextCacheSignature)
        : null;
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
        updatedAt: {
          ...state.updatedAt,
          [platform]: persisted?.updatedAt ?? 0,
        },
        lastAttemptAt: { ...state.lastAttemptAt, [platform]: 0 },
        calibratedAccountKeys: {
          ...state.calibratedAccountKeys,
          [platform]: null,
        },
        revisions: {
          ...state.revisions,
          [platform]: state.revisions[platform] + 1,
        },
        active: state.active?.platform === platform ? null : state.active,
      }));
    }

    if (!nextKey) return;
    const current = get();
    if (
      current.accountKeys[platform] !== nextKey ||
      current.calibratedAccountKeys[platform] === nextKey
    ) {
      return;
    }
    // 先占位再发请求，避免宽/窄两个 FolderTree 同时 mount 时重复强刷。
    set((state) => ({
      calibratedAccountKeys: {
        ...state.calibratedAccountKeys,
        [platform]: nextKey,
      },
    }));
    await get().refreshIfStale(platform, { force: true });
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
    if (snapshot.loading[platform]) return cached ?? [];
    if (
      !options.force &&
      now - snapshot.lastAttemptAt[platform] < STREAM_PLAYLIST_AUTO_REFRESH_GAP_MS
    ) {
      return cached ?? [];
    }

    const revision = snapshot.revisions[platform];
    const cacheSignature = snapshot.cacheSignatures[platform];
    set((state) => ({
      loading: { ...state.loading, [platform]: true },
      errors: { ...state.errors, [platform]: "" },
      lastAttemptAt: { ...state.lastAttemptAt, [platform]: now },
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
      lastAttemptAt: { ...state.lastAttemptAt, [platform]: 0 },
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
    set({ active });
  },

  setError(platform, error) {
    set((state) => ({ errors: { ...state.errors, [platform]: error } }));
  },
}));
