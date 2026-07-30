import { create } from "zustand";

const STORAGE_KEY = "kd-playback-prefs";

export interface PlaybackPrefs {
  /** 播放时渐入、暂停时渐出；包络由 Rust realtime renderer 执行。 */
  transportFade: boolean;
}

const DEFAULTS: PlaybackPrefs = {
  transportFade: true,
};

function load(): PlaybackPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    const data = raw as Partial<PlaybackPrefs>;
    return {
      transportFade:
        typeof data.transportFade === "boolean" ? data.transportFade : DEFAULTS.transportFade,
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
}

export const usePlaybackPrefs = create<PlaybackPrefsState>((set, get) => ({
  ...load(),
  setTransportFade(transportFade) {
    const next = { ...get(), transportFade };
    set(next);
    save(next);
  },
}));
