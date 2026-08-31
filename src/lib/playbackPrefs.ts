import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const STORAGE_KEY = "kd-playback-prefs";
const STORAGE_VERSION = 1;

export const TEMPO_RANGE_OPTIONS = [8, 10, 16, 25, 50, 75] as const;
export type TempoRange = (typeof TEMPO_RANGE_OPTIONS)[number];
export type LocalExternalDragMode = "file" | "share_link";
export type TimeDisplayMode = "elapsed" | "remaining";

function normalizeTempoRange(value: unknown): TempoRange {
  return TEMPO_RANGE_OPTIONS.includes(value as TempoRange) ? value as TempoRange : 25;
}

function normalizeLocalExternalDragMode(value: unknown): LocalExternalDragMode {
  return value === "share_link" ? "share_link" : "file";
}

function normalizeTimeDisplayMode(value: unknown): TimeDisplayMode {
  return value === "remaining" ? "remaining" : "elapsed";
}

export interface PlaybackPrefs {
  /** 播放时渐入、暂停时渐出；包络由 Rust realtime renderer 执行。 */
  transportFade: boolean;
  /** 管理模式 Tempo 控件相对原速可调整的最大百分比。 */
  tempoRange: TempoRange;
  /** 详情栏是否始终读取当前播放曲目；切歌时跟随，跨重启保留。 */
  playingDetailPinned: boolean;
  /** 详情页 Control 与 Analysis 是否展示波形。 */
  detailWaveformVisible: boolean;
  /** 详情页是否展示正在播放曲目的 Control 板块。 */
  detailControlVisible: boolean;
  /** 本地曲目拖出应用时，交给外部的是实际文件还是公开分享链接。 */
  localExternalDragMode: LocalExternalDragMode;
  /** 播放条显示已播放正计时，或剩余时间倒计时。 */
  timeDisplayMode: TimeDisplayMode;
}

const DEFAULTS: PlaybackPrefs = {
  transportFade: true,
  tempoRange: 25,
  playingDetailPinned: false,
  detailWaveformVisible: false,
  detailControlVisible: true,
  localExternalDragMode: "file",
  timeDisplayMode: "elapsed",
};

type StoredPlaybackPrefs = Partial<PlaybackPrefs> & { version?: unknown };

function load(): PlaybackPrefs {
  try {
    const raw: unknown = JSON.parse(readLocalStorage(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    const data = raw as StoredPlaybackPrefs;
    // 这组 Control/细节波形默认值随新版 VDJ 首次启用一次：旧存储可能因为保存
    // 其他播放偏好而顺带留下旧默认 true，单改 DEFAULTS 无法让升级用户得到新默认。
    // 写入版本后，用户此后主动开关的选择完全按存储值恢复，不再重复重置。
    const applyVdjDefaults =
      typeof data.version !== "number" || data.version < STORAGE_VERSION;
    const prefs: PlaybackPrefs = {
      transportFade:
        typeof data.transportFade === "boolean" ? data.transportFade : DEFAULTS.transportFade,
      tempoRange: normalizeTempoRange(data.tempoRange),
      playingDetailPinned:
        typeof data.playingDetailPinned === "boolean"
          ? data.playingDetailPinned
          : DEFAULTS.playingDetailPinned,
      detailWaveformVisible:
        !applyVdjDefaults && typeof data.detailWaveformVisible === "boolean"
          ? data.detailWaveformVisible
          : DEFAULTS.detailWaveformVisible,
      detailControlVisible:
        !applyVdjDefaults && typeof data.detailControlVisible === "boolean"
          ? data.detailControlVisible
          : DEFAULTS.detailControlVisible,
      localExternalDragMode: normalizeLocalExternalDragMode(data.localExternalDragMode),
      timeDisplayMode: normalizeTimeDisplayMode(data.timeDisplayMode),
    };
    if (applyVdjDefaults) save(prefs);
    return prefs;
  } catch {
    return { ...DEFAULTS };
  }
}

function save(prefs: PlaybackPrefs): void {
  writeLocalStorageNow(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, ...prefs }));
}

interface PlaybackPrefsState extends PlaybackPrefs {
  setTransportFade(value: boolean): void;
  setTempoRange(value: TempoRange): void;
  setPlayingDetailPinned(value: boolean): void;
  setDetailWaveformVisible(value: boolean): void;
  setDetailControlVisible(value: boolean): void;
  setLocalExternalDragMode(value: LocalExternalDragMode): void;
  setTimeDisplayMode(value: TimeDisplayMode): void;
}

export const usePlaybackPrefs = create<PlaybackPrefsState>((set, get) => ({
  ...load(),
  setTransportFade(transportFade) {
    const next = {
      transportFade,
      tempoRange: get().tempoRange,
      playingDetailPinned: get().playingDetailPinned,
      detailWaveformVisible: get().detailWaveformVisible,
      detailControlVisible: get().detailControlVisible,
      localExternalDragMode: get().localExternalDragMode,
      timeDisplayMode: get().timeDisplayMode,
    };
    set({ transportFade });
    save(next);
  },
  setTempoRange(tempoRange) {
    const next = {
      transportFade: get().transportFade,
      tempoRange: normalizeTempoRange(tempoRange),
      playingDetailPinned: get().playingDetailPinned,
      detailWaveformVisible: get().detailWaveformVisible,
      detailControlVisible: get().detailControlVisible,
      localExternalDragMode: get().localExternalDragMode,
      timeDisplayMode: get().timeDisplayMode,
    };
    set({ tempoRange: next.tempoRange });
    save(next);
  },
  setPlayingDetailPinned(playingDetailPinned) {
    const next = {
      transportFade: get().transportFade,
      tempoRange: get().tempoRange,
      playingDetailPinned,
      detailWaveformVisible: get().detailWaveformVisible,
      detailControlVisible: get().detailControlVisible,
      localExternalDragMode: get().localExternalDragMode,
      timeDisplayMode: get().timeDisplayMode,
    };
    set({ playingDetailPinned });
    save(next);
  },
  setDetailWaveformVisible(detailWaveformVisible) {
    const next = {
      transportFade: get().transportFade,
      tempoRange: get().tempoRange,
      playingDetailPinned: get().playingDetailPinned,
      detailWaveformVisible,
      detailControlVisible: get().detailControlVisible,
      localExternalDragMode: get().localExternalDragMode,
      timeDisplayMode: get().timeDisplayMode,
    };
    set({ detailWaveformVisible });
    save(next);
  },
  setDetailControlVisible(detailControlVisible) {
    const next = {
      transportFade: get().transportFade,
      tempoRange: get().tempoRange,
      playingDetailPinned: get().playingDetailPinned,
      detailWaveformVisible: get().detailWaveformVisible,
      detailControlVisible,
      localExternalDragMode: get().localExternalDragMode,
      timeDisplayMode: get().timeDisplayMode,
    };
    set({ detailControlVisible });
    save(next);
  },
  setLocalExternalDragMode(localExternalDragMode) {
    const next = {
      transportFade: get().transportFade,
      tempoRange: get().tempoRange,
      playingDetailPinned: get().playingDetailPinned,
      detailWaveformVisible: get().detailWaveformVisible,
      detailControlVisible: get().detailControlVisible,
      localExternalDragMode: normalizeLocalExternalDragMode(localExternalDragMode),
      timeDisplayMode: get().timeDisplayMode,
    };
    set({ localExternalDragMode: next.localExternalDragMode });
    save(next);
  },
  setTimeDisplayMode(timeDisplayMode) {
    const next = {
      transportFade: get().transportFade,
      tempoRange: get().tempoRange,
      playingDetailPinned: get().playingDetailPinned,
      detailWaveformVisible: get().detailWaveformVisible,
      detailControlVisible: get().detailControlVisible,
      localExternalDragMode: get().localExternalDragMode,
      timeDisplayMode: normalizeTimeDisplayMode(timeDisplayMode),
    };
    set({ timeDisplayMode: next.timeDisplayMode });
    save(next);
  },
}));
