import { create } from "zustand";
import { deckGain, previewGain, useCrossfade } from "./crossfade";
import { readLocalStorage, writeLocalStorageSoon } from "./storageWrite";

export const MASTER_VOLUME_STORAGE_KEY = "kd-player-volume";
const MASTER_RESTORE_STORAGE_KEY = "kd-player-volume-restore";

export function normalizeMasterVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Slider position → linear amplitude. Roughly 60 dB of travel, with true silence at zero.
 * 20/50/80% yield about -50/-30/-12 dB instead of the old -14/-6/-2 dB.
 * Apply once at the output, after clip automation and before the device/player.
 */
export function masterVolumeGain(volume: number): number {
  const position = normalizeMasterVolume(volume);
  if (position === 0 || position === 1) return position;
  return Math.expm1(Math.log(1000) * position) / 999;
}

export function getDeckOutputGain(): number {
  const { coplay, x } = useCrossfade.getState();
  return masterVolumeGain(useMasterVolume.getState().volume) * deckGain(coplay, x);
}

export function getPreviewOutputGain(): number {
  const { coplay, x } = useCrossfade.getState();
  return masterVolumeGain(useMasterVolume.getState().volume) * previewGain(coplay, x);
}

/** Bind before play/source loading; subscriptions also cover non-React mute controls. */
export function bindMediaMasterVolume(media: HTMLMediaElement, route: "master" | "preview" = "master"): () => void {
  const apply = () => {
    media.volume = route === "preview" ? getPreviewOutputGain() : masterVolumeGain(useMasterVolume.getState().volume);
  };
  const unlistenVolume = useMasterVolume.subscribe(apply);
  const unlistenCrossfade = route === "preview" ? useCrossfade.subscribe(apply) : undefined;
  apply();
  return () => { unlistenVolume(); unlistenCrossfade?.(); };
}

/** Below this a slider is on its way to silence; it is not a level worth returning to. */
const RESTORABLE_VOLUME = .05;

function savedVolume(key: string): number | null {
  const raw = readLocalStorage(key);
  if (raw === null) return null;
  const saved = Number(raw);
  return Number.isFinite(saved) ? normalizeMasterVolume(saved) : null;
}

function initialRestoreVolume(key: string, volume: number): number {
  const saved = savedVolume(key);
  return saved !== null && saved > 0 ? saved : volume > 0 ? volume : 1;
}

interface MasterVolumeState {
  /** Persisted slider position, not a linear output gain. */
  volume: number;
  /** Level an unmute returns to, shared by every control and window. */
  restoreVolume: number;
  setVolume(volume: number): void;
  toggleMute(): void;
  /** Accept another window's values without echoing them back. */
  adopt(values: Partial<Pick<MasterVolumeState, "volume" | "restoreVolume">>): void;
}

/**
 * 应用的最终 MASTER 音量。唱盘、HTML 视频和平台官方播放器都订阅同一份状态，
 * 避免底栏推子只改 Rust/CPAL、在线视频仍保持 100%。
 */
export const useMasterVolume = create<MasterVolumeState>((set, get) => {
  const volume = savedVolume(MASTER_VOLUME_STORAGE_KEY) ?? 1;
  const persist = (next: { volume: number; restoreVolume: number }) => {
    writeLocalStorageSoon(MASTER_VOLUME_STORAGE_KEY, String(next.volume), 1_000);
    writeLocalStorageSoon(MASTER_RESTORE_STORAGE_KEY, String(next.restoreVolume), 1_000);
    set(next);
  };
  return {
    volume,
    restoreVolume: initialRestoreVolume(MASTER_RESTORE_STORAGE_KEY, volume),
    setVolume: (rawVolume) => {
      const next = normalizeMasterVolume(rawVolume);
      persist({ volume: next, restoreVolume: next >= RESTORABLE_VOLUME ? next : get().restoreVolume });
    },
    toggleMute: () => {
      const state = get();
      // An explicit mute returns to exactly the level it left, however low.
      if (state.volume > 0) persist({ volume: 0, restoreVolume: state.volume });
      else persist({ volume: state.restoreVolume > 0 ? state.restoreVolume : 1, restoreVolume: state.restoreVolume });
    },
    adopt: (values) => {
      const state = get();
      const next = {
        volume: typeof values.volume === "number" ? normalizeMasterVolume(values.volume) : state.volume,
        restoreVolume: typeof values.restoreVolume === "number" && values.restoreVolume > 0
          ? normalizeMasterVolume(values.restoreVolume) : state.restoreVolume,
      };
      if (next.volume !== state.volume || next.restoreVolume !== state.restoreVolume) persist(next);
    },
  };
});
