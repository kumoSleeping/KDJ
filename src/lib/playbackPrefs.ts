import { create } from "zustand";

const STORAGE_KEY = "kd-playback-prefs";

export interface PlaybackPrefs {
  /** 播放时渐入、暂停时渐出；包络由 Rust realtime renderer 执行。 */
  transportFade: boolean;
  /** 主 CUE / Hot Cue / Loop 起点是否吸附到分析节拍；属于全局播放偏好。 */
  quantize: boolean;
}

const DEFAULTS: PlaybackPrefs = {
  transportFade: true,
  quantize: true,
};

function load(): PlaybackPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    const data = raw as Partial<PlaybackPrefs>;
    return {
      transportFade:
        typeof data.transportFade === "boolean" ? data.transportFade : DEFAULTS.transportFade,
      quantize: typeof data.quantize === "boolean" ? data.quantize : DEFAULTS.quantize,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(prefs: PlaybackPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

interface PlaybackPrefsState extends PlaybackPrefs {
  setTransportFade(value: boolean): void;
  setQuantize(value: boolean): void;
}

export const usePlaybackPrefs = create<PlaybackPrefsState>((set, get) => ({
  ...load(),
  setTransportFade(transportFade) {
    const next = { transportFade, quantize: get().quantize };
    set({ transportFade });
    save(next);
  },
  setQuantize(quantize) {
    const next = { transportFade: get().transportFade, quantize };
    set({ quantize });
    save(next);
  },
}));
