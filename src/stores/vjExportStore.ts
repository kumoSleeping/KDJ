/**
 * 「按顺序导出 VJ」旁路面板的草稿状态。
 * 曲目顺序只影响本次导出，不回写曲库手排。
 */

import { create } from "zustand";
import { api } from "../lib/api";
import type { Track } from "../types";

export type VjExportQuality = "1080p" | "720p" | "480p";
export type VjFadeMode = "seconds" | "bars";

// VJ 只能拼视频容器；同一文件夹里的音乐仍会留在曲库，不能跟着入导出清单。
const VJ_VIDEO_FORMATS = new Set(["mp4", "m4v", "mov", "webm", "mkv"]);

function isVjVideo(track: Track): boolean {
  const format = (track.format || track.filename.split(".").pop() || "")
    .trim()
    .replace(/^\./, "")
    .toLowerCase();
  return VJ_VIDEO_FORMATS.has(format);
}

interface VjExportStore {
  folder: string;
  tracks: Track[];
  orderedIds: number[];
  loading: boolean;
  error: string;
  useInOutPoints: boolean;
  snapNearestBeat: boolean;
  snapWholeBar: boolean;
  fadeMode: VjFadeMode;
  fadeSeconds: number;
  fadeBars: number;
  quality: VjExportQuality;
  keepAudio: boolean;
  unifyGain: boolean;

  open(folder: string): Promise<void>;
  close(): void;
  setOrderedIds(ids: number[]): void;
  moveTrack(id: number, direction: -1 | 1): void;
  setUseInOutPoints(value: boolean): void;
  setSnapNearestBeat(value: boolean): void;
  setSnapWholeBar(value: boolean): void;
  setFadeMode(value: VjFadeMode): void;
  setFadeSeconds(value: number): void;
  setFadeBars(value: number): void;
  setQuality(value: VjExportQuality): void;
  setKeepAudio(value: boolean): void;
  setUnifyGain(value: boolean): void;
}

async function loadFolderTracks(folder: string): Promise<Track[]> {
  const items: Track[] = [];
  let offset = 0;
  while (true) {
    const page = await api.tracks({
      folder,
      sort: "custom",
      order: "asc",
      limit: 1000,
      offset,
    });
    items.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) break;
  }
  return items;
}

export const useVjExportStore = create<VjExportStore>()((set, get) => ({
  folder: "",
  tracks: [],
  orderedIds: [],
  loading: false,
  error: "",
  useInOutPoints: true,
  snapNearestBeat: false,
  snapWholeBar: false,
  fadeMode: "bars",
  fadeSeconds: 4,
  fadeBars: 4,
  quality: "1080p",
  keepAudio: true,
  unifyGain: true,

  async open(folder) {
    set({
      folder,
      loading: true,
      error: "",
      tracks: [],
      orderedIds: [],
    });
    try {
      const tracks = (await loadFolderTracks(folder)).filter(isVjVideo);
      set({
        tracks,
        orderedIds: tracks.map((track) => track.id),
        loading: false,
      });
    } catch (reason: unknown) {
      set({
        loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  },

  close() {
    set({ folder: "", tracks: [], orderedIds: [], error: "", loading: false });
  },

  setOrderedIds(ids) {
    set({ orderedIds: ids });
  },

  moveTrack(id, direction) {
    const { orderedIds } = get();
    const index = orderedIds.indexOf(id);
    if (index < 0) return;
    const next = index + direction;
    if (next < 0 || next >= orderedIds.length) return;
    const copy = [...orderedIds];
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    set({ orderedIds: copy });
  },

  setUseInOutPoints(value) {
    set({ useInOutPoints: value });
  },

  setSnapNearestBeat(value) {
    set({ snapNearestBeat: value });
  },

  setSnapWholeBar(value) {
    // 整节开时隐含拍对齐
    if (value) set({ snapWholeBar: true, snapNearestBeat: true });
    else set({ snapWholeBar: false });
  },

  setFadeMode(value) {
    set({ fadeMode: value });
  },

  setFadeSeconds(value) {
    set({ fadeSeconds: Number.isFinite(value) ? Math.max(0, Math.min(120, value)) : 0 });
  },

  setFadeBars(value) {
    set({ fadeBars: Number.isFinite(value) ? Math.max(0, Math.min(32, Math.round(value))) : 0 });
  },

  setQuality(value) {
    set({ quality: value });
  },

  setKeepAudio(value) {
    set({ keepAudio: value });
  },

  setUnifyGain(value) {
    set({ unifyGain: value });
  },
}));
