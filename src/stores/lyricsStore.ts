/**
 * 歌词缓存：听歌优先——播放绝不被搜词挡住；词到了再补上，并按当前进度对齐。
 * 同时给右侧唱盘预告的「下一首」预取，切歌时尽量已经就绪。
 */

import { create } from "zustand";
import { api, ApiError } from "../lib/api";
import { useLyricsPrefs } from "../lib/lyricsPrefs";
import { parseLrc, type LrcLine } from "../lib/lrc";
import type { LyricsResponse, Platform, Track } from "../types";

export type LyricsStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface LyricsEntry {
  status: LyricsStatus;
  lines: LrcLine[];
  translated: LrcLine[];
  romaji: LrcLine[];
  meta: LyricsResponse | null;
  error: string;
  /** 与 lyricsPrefs 搜词相关项对应；偏好变了视为未缓存。 */
  fingerprint: string;
  /** 正在飞的请求；同歌并发 ensure 共用一个 promise。 */
  inflight: Promise<void> | null;
}

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
    fingerprint: entry.fingerprint ?? "",
    inflight: entry.inflight ?? null,
  };
}

// useSyncExternalStore 要求未变化时返回同一个引用；每次 new 会触发无限重渲染。
const EMPTY_ENTRY = emptyEntry();

function platformOf(track: Track): Platform | null {
  const raw = track.source_platform?.trim().toLowerCase();
  if (raw === "wyy" || raw === "qqm") return raw;
  return null;
}

function requestOf(track: Track) {
  const prefs = useLyricsPrefs.getState();
  const engines = prefs.engines;
  const prefer = prefs.displaySource;
  let platform = platformOf(track);
  let key = track.source_key || "";

  if (prefer === "wyy" || prefer === "qqm") {
    // 强制来源：曲库 key 对得上才直取，否则清空 key 让后端按该引擎搜。
    if (platform === prefer && key) {
      platform = prefer;
    } else {
      platform = prefer;
      key = "";
    }
  } else if (platform === "wyy" || platform === "qqm") {
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
      (existing.status === "ready" || existing.status === "empty")
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
          },
        },
      }));
      try {
        const prefs = useLyricsPrefs.getState();
        let meta: LyricsResponse | null = null;

        // 下载时已经落盘的歌词优先；在线试听是负数临时曲目，没有本地文件。
        if (track.id > 0) {
          try {
            const local = await api.libraryLyrics(track.id);
            meta = {
              lrc: local.lrc,
              translated_lrc: local.translated_lrc,
              romaji_lrc: local.romaji_lrc,
              platform: platformOf(track) ?? "local",
              key: track.source_key || "",
              title: track.title || track.filename,
              artist: track.artist || "",
              score: 1,
            };
          } catch (error) {
            // 404 = 尚未下载本地歌词；其它本地读取异常也只降级到在线兜底，
            // 不把错误文案暴露给歌词面板。
            if (!(error instanceof ApiError && error.status === 404)) {
              console.warn("读取本地歌词失败", error);
            }
          }
        }

        // 本地没有歌词时，在线匹配是显式偏好；在线试听仍按来源 key 直取。
        if (!meta && (track.id < 0 || prefs.tryOnlineWhenMissing)) {
          meta = await api.lyrics(requestOf(track));
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
                fingerprint,
                inflight: null,
              },
            },
          }));
          return;
        }
        const lines = parseLrc(meta.lrc);
        const translated = parseLrc(meta.translated_lrc || "");
        const romaji = parseLrc(meta.romaji_lrc || "");
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
              fingerprint,
              inflight: null,
            },
          },
        }));
      } catch (error) {
        // 歌词匹配失败不打断播放，也不在歌词面板显示网络/匹配错误。
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
