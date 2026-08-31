/**
 * 歌词缓存：听歌优先——播放绝不被搜词挡住；词到了再补上，并按当前进度对齐。
 * 调用方只在歌词界面需要当前曲时触发；store 负责同歌单飞和持久缓存。
 */

import { create } from "zustand";
import { api, ApiError } from "../lib/api";
import { useLyricsPrefs } from "../lib/lyricsPrefs";
import { parseLrc, parseNeteaseWordLrc, type LrcLine } from "../lib/lrc";
import { localLibraryDataTrackId } from "../lib/playbackTrackSource";
import type { LyricsResponse, Platform, Track } from "../types";

export type LyricsStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface LyricsEntry {
  status: LyricsStatus;
  lines: LrcLine[];
  translated: LrcLine[];
  romaji: LrcLine[];
  meta: LyricsResponse | null;
  error: string;
  /** 本地曲目的歌词是否已经写入 `.kdj/lyrics/`；在线试听始终为 false。 */
  persisted: boolean;
  /** 与 lyricsPrefs 搜词相关项对应；偏好变了视为未缓存。 */
  fingerprint: string;
  /** 正在飞的请求；同歌并发 ensure 共用一个 promise。 */
  inflight: Promise<void> | null;
}

/** 独立歌词窗口可接收的纯数据快照；Promise 只属于发起请求的主窗口。 */
export type PublishedLyricsEntry = Omit<LyricsEntry, "inflight"> & { trackId: number };

function prefsFingerprint(): string {
  const prefs = useLyricsPrefs.getState();
  return `${prefs.displaySource}|${prefs.engines.join(",")}|${prefs.tryOnlineWhenMissing}`;
}

function emptyEntry(status: LyricsStatus = "idle"): LyricsEntry {
  return {
    status,
    lines: [],
    translated: [],
    romaji: [],
    meta: null,
    error: "",
    persisted: false,
    fingerprint: "",
    inflight: null,
  };
}

/** HMR / 旧缓存可能缺 romaji 等字段；读的时候补齐，避免 .some 炸成白屏。 */
function normalizeEntry(entry: LyricsEntry): LyricsEntry {
  if (
    entry.lines &&
    entry.translated &&
    entry.romaji &&
    entry.meta !== undefined &&
    entry.error !== undefined &&
    entry.persisted !== undefined &&
    entry.fingerprint !== undefined &&
    entry.inflight !== undefined
  ) {
    return entry;
  }
  return {
    ...entry,
    lines: entry.lines ?? [],
    translated: entry.translated ?? [],
    romaji: entry.romaji ?? [],
    meta: entry.meta ?? null,
    error: entry.error ?? "",
    persisted: entry.persisted ?? false,
    fingerprint: entry.fingerprint ?? "",
    inflight: entry.inflight ?? null,
  };
}

// useSyncExternalStore 要求未变化时返回同一个引用；每次 new 会触发无限重渲染。
const EMPTY_ENTRY = emptyEntry();

function platformOf(track: Track): Platform | null {
  const raw = track.source_platform?.trim().toLowerCase();
  if (raw === "wyy" || raw === "qqm" || raw === "ytm") return raw;
  return null;
}

function requestOf(track: Track) {
  const prefs = useLyricsPrefs.getState();
  const engines = prefs.engines;
  const prefer = prefs.displaySource;
  let platform = platformOf(track);
  let key = track.source_key || "";

  if (prefer === "wyy" || prefer === "qqm" || prefer === "ytm") {
    // 强制来源：曲库 key 对得上才直取，否则清空 key 让后端按该引擎搜。
    if (platform === prefer && key) {
      platform = prefer;
    } else {
      platform = prefer;
      key = "";
    }
  } else if (platform === "wyy" || platform === "qqm" || platform === "ytm") {
    if (!engines.includes(platform)) {
      // 跟随，但曲库来源引擎被关掉了：改走搜索。
      platform = null;
      key = "";
    }
  } else if (platform) {
    platform = null;
    key = "";
  }

  return {
    title: track.title || track.filename,
    artist: track.artist || "",
    duration: track.duration,
    platform,
    key,
    engines: [...engines],
    prefer,
  };
}

interface LyricsStore {
  byId: Record<number, LyricsEntry>;
  ensure(track: Track | null | undefined): Promise<void>;
  get(trackId: number | null | undefined): LyricsEntry;
  /** 引擎 / 显示来源变更后清掉，避免旧偏好结果粘着。 */
  clear(): void;
}

export const useLyricsStore = create<LyricsStore>((set, get) => ({
  byId: {},

  get(trackId) {
    if (trackId == null) return EMPTY_ENTRY;
    const entry = get().byId[trackId];
    return entry ? normalizeEntry(entry) : EMPTY_ENTRY;
  },

  clear() {
    set({ byId: {} });
  },

  async ensure(track) {
    // 曲库 id > 0；在线试听用负数 id，同样要按 source_platform/key 直取歌词。
    if (!track || track.id === 0) return;
    const fingerprint = prefsFingerprint();
    const existing = get().byId[track.id];
    if (
      existing &&
      existing.fingerprint === fingerprint &&
      (
        existing.status === "empty"
        || (existing.status === "ready" && (track.id < 0 || existing.persisted === true))
      )
    ) {
      return;
    }
    if (existing?.inflight && existing.fingerprint === fingerprint) {
      await existing.inflight;
      return;
    }

    const run = (async () => {
      set((state) => ({
        byId: {
          ...state.byId,
          [track.id]: {
            ...(state.byId[track.id] ?? emptyEntry()),
            status: "loading",
            fingerprint,
            error: "",
            persisted: false,
          },
        },
      }));
      try {
        const prefs = useLyricsPrefs.getState();
        let meta: LyricsResponse | null = null;
        let persisted = false;
        let cacheDirty = false;

        // 下载时已经落盘的歌词优先。
        const localLyricsTrackId = localLibraryDataTrackId(track);
        if (localLyricsTrackId) {
          try {
            const local = await api.libraryLyrics(localLyricsTrackId);
            const localPlatform = local.platform ?? platformOf(track) ?? "local";
            // sidecar 只要文件存在不代表里面有可解析的 LRC；损坏/仅元数据时
            // 继续走在线匹配，避免一个空本地文件把正确歌词永久挡住。
            if (
              parseLrc(local.lrc, { honorOffset: localPlatform === "qqm" }).length
              || (localPlatform === "wyy" && parseNeteaseWordLrc(local.word_lrc || "").length)
            ) {
              meta = {
                lrc: local.lrc,
                word_lrc: local.word_lrc || "",
                translated_lrc: local.translated_lrc,
                romaji_lrc: local.romaji_lrc,
                platform: localPlatform,
                key: local.key || track.source_key || "",
                title: local.title || track.title || track.filename,
                artist: local.artist || track.artist || "",
                score: local.score ?? 1,
              };
              persisted = true;
            }
          } catch (error) {
            // 404 = 尚未下载本地歌词；其它本地读取异常也只降级到在线兜底，
            // 不把错误文案暴露给歌词面板。
            if (!(error instanceof ApiError && error.status === 404)) {
              console.warn("读取本地歌词失败", error);
            }
          }
        }

        // 旧版本通过 QQ 的公开 LRC 接口落盘时只能拿到主歌词，已经下载过的歌会
        // 一直命中这个本地文件，从而永远没有翻译。在线补词开启时，给这种 QQ
        // 本地缓存补取一次附加层；主歌词仍保留本地版本（包括用户手调的时间轴）。
        if (
          meta &&
          platformOf(track) === "qqm" &&
          prefs.tryOnlineWhenMissing &&
          prefs.displaySource !== "wyy" &&
          prefs.engines.includes("qqm") &&
          !parseLrc(meta.translated_lrc || "", { honorOffset: true }).length
        ) {
          try {
            const online = await api.lyrics(requestOf(track));
            if (online?.platform === "qqm") {
              meta = {
                ...meta,
                translated_lrc: online.translated_lrc,
                romaji_lrc: meta.romaji_lrc || online.romaji_lrc,
              };
              cacheDirty = true;
            }
          } catch {
            // 附加翻译失败不影响已经可用的本地主歌词，离线时照常显示原词。
          }
        }

        // 本地没有歌词时，在线匹配是显式偏好；在线试听仍按来源 key 直取。
        if (!meta && (track.id < 0 || prefs.tryOnlineWhenMissing)) {
          meta = await api.lyrics(requestOf(track));
          cacheDirty = track.id > 0;
        }
        if (!meta) {
          set((state) => ({
            byId: {
              ...state.byId,
              [track.id]: {
                status: "empty",
                lines: [],
                translated: [],
                romaji: [],
                meta: null,
                error: "",
                persisted: false,
                fingerprint,
                inflight: null,
              },
            },
          }));
          return;
        }
        if (track.id > 0 && cacheDirty) {
          try {
            await api.cacheLibraryLyrics(track.id, meta);
            persisted = true;
          } catch (error) {
            // 已经匹配到的歌词仍可用于当前播放；落盘失败单独反映在顶部缓存状态，
            // 不应该把可用歌词降级成整块不可用。
            console.warn("缓存匹配歌词失败", error);
          }
        }
        const lrcOptions = { honorOffset: meta.platform === "qqm" };
        const lineLyrics = parseLrc(meta.lrc, lrcOptions);
        const wordLyrics =
          meta.platform === "wyy" ? parseNeteaseWordLrc(meta.word_lrc || "") : [];
        const lines = wordLyrics.length ? wordLyrics : lineLyrics;
        const translated = parseLrc(meta.translated_lrc || "", lrcOptions);
        const romaji = parseLrc(meta.romaji_lrc || "", lrcOptions);
        set((state) => ({
          byId: {
            ...state.byId,
            [track.id]: {
              status: lines.length ? "ready" : "empty",
              lines,
              translated,
              romaji,
              meta,
              error: "",
              persisted,
              fingerprint,
              inflight: null,
            },
          },
        }));
      } catch (error) {
        // 404 = 没有匹配到歌词；其它错误是暂时不可用。两者都不打断播放，
        // 但要让右栏和悬浮歌词给用户一个明确状态，而不是渲染空白。
        const status: LyricsStatus =
          error instanceof ApiError && error.status === 404 ? "empty" : "error";
        set((state) => ({
          byId: {
            ...state.byId,
            [track.id]: {
              status,
              lines: [],
              translated: [],
              romaji: [],
              meta: null,
              error: "",
              persisted: false,
              fingerprint,
              inflight: null,
            },
          },
        }));
      }
    })();

    set((state) => ({
      byId: {
        ...state.byId,
        [track.id]: {
          ...(state.byId[track.id] ?? emptyEntry("loading")),
          status: "loading",
          fingerprint,
          persisted: false,
          inflight: run,
        },
      },
    }));
    await run;
  },
}));

export function ensureLyrics(track: Track | null | undefined): Promise<void> {
  return useLyricsStore.getState().ensure(track);
}

export function publishedLyricsEntry(
  trackId: number,
  entry: LyricsEntry,
): PublishedLyricsEntry {
  const normalized = normalizeEntry(entry);
  return {
    trackId,
    status: normalized.status,
    lines: normalized.lines,
    translated: normalized.translated,
    romaji: normalized.romaji,
    meta: normalized.meta,
    error: normalized.error,
    persisted: normalized.persisted,
    fingerprint: normalized.fingerprint,
  };
}

/** 主窗口拥有在线请求；独立歌词窗口只接收结果，不再自己调用歌词 API。 */
export function acceptPublishedLyricsEntry(snapshot: PublishedLyricsEntry): void {
  if (!Number.isFinite(snapshot.trackId) || snapshot.trackId === 0) return;
  useLyricsStore.setState((state) => ({
    byId: {
      ...state.byId,
      [snapshot.trackId]: normalizeEntry({
        ...snapshot,
        inflight: null,
      }),
    },
  }));
}
